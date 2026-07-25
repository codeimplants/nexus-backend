import {
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { decryptServiceToken } from '../../common/crypto/service-token-cipher';

/** Contact details resolved from an app's own backend (never stored here). */
export interface FederatedProfile {
    phone: string | null;
    name: string | null;
    registrationDate: string | null;
}

/**
 * Federation layer for app-specific admin activities.
 *
 * Each registered app can declare its own backend (`App.backendBaseUrl` +
 * `backendServiceToken`). The console drives that app's bespoke admin screens
 * through this proxy, so per-app logic stays in the app's own backend and is
 * never duplicated into the platform. Access is already enforced upstream by
 * JwtGuard + AppAccessGuard, so a COLLABORATOR can only reach assigned apps.
 */
@Injectable()
export class AppAdminService {
    private readonly logger = new Logger(AppAdminService.name);
    private static readonly TIMEOUT_MS = 15_000;

    constructor(private prisma: PrismaService) { }

    private decryptToken(stored: string | null): string | null {
        return stored ? decryptServiceToken(stored) : null;
    }

    async proxy(
        appId: string,
        method: string,
        subPath: string,
        query: Record<string, any>,
        body: unknown,
    ): Promise<unknown> {
        const app = await this.prisma.app.findUnique({
            where: { id: appId },
            select: { backendBaseUrl: true, backendServiceToken: true },
        });
        if (!app) throw new NotFoundException('App not found');
        if (!app.backendBaseUrl) {
            throw new BadRequestException('No backend is configured for this app');
        }

        return this.call(
            { baseUrl: app.backendBaseUrl, token: this.decryptToken(app.backendServiceToken) },
            method,
            subPath,
            query,
            body,
        );
    }

    /**
     * Purge users (single or bulk), typically ones inactive for a long time, to
     * reduce storage. Each deletion is delegated to the app's OWN backend so its
     * deletion process runs (cascade + retention of basic details for future
     * business use); only after that succeeds does the platform drop its own
     * telemetry for the user (EndUser cascade -> sessions + daily usage; devices
     * are unlinked). Best-effort per user: one failure doesn't abort the batch.
     */
    async purgeUsers(
        appId: string,
        opts: { externalUserIds?: string[]; inactiveDays?: number; dryRun?: boolean },
        admin: { id: string; email?: string },
    ) {
        const app = await this.prisma.app.findUnique({
            where: { id: appId },
            select: { backendBaseUrl: true, backendServiceToken: true, backendDeleteUserPath: true },
        });
        if (!app) throw new NotFoundException('App not found');

        // Resolve the target users: explicit ids win, else everyone inactive
        // for at least `inactiveDays`.
        let targets: { id: string; externalUserId: string }[];
        if (opts.externalUserIds?.length) {
            targets = await this.prisma.endUser.findMany({
                where: { appId, externalUserId: { in: opts.externalUserIds } },
                select: { id: true, externalUserId: true },
            });
        } else if (opts.inactiveDays && opts.inactiveDays > 0) {
            const cutoff = new Date(Date.now() - opts.inactiveDays * 24 * 60 * 60 * 1000);
            targets = await this.prisma.endUser.findMany({
                where: { appId, lastActiveAt: { lt: cutoff } },
                select: { id: true, externalUserId: true },
            });
        } else {
            throw new BadRequestException('Provide externalUserIds or inactiveDays');
        }

        if (opts.dryRun) {
            return { dryRun: true, matched: targets.length, targets: targets.map((t) => t.externalUserId) };
        }

        // The app's own deletion process is what retains basics — refuse to purge
        // if it isn't configured, rather than silently dropping telemetry only.
        if (!app.backendBaseUrl || !app.backendDeleteUserPath) {
            throw new BadRequestException(
                'This app has no deletion endpoint configured (backendBaseUrl + backendDeleteUserPath)',
            );
        }

        let deleted = 0;
        const failures: { externalUserId: string; reason: string }[] = [];

        for (const target of targets) {
            try {
                await this.call(
                    { baseUrl: app.backendBaseUrl, token: this.decryptToken(app.backendServiceToken) },
                    'DELETE',
                    `${app.backendDeleteUserPath}/${encodeURIComponent(target.externalUserId)}`,
                    {},
                    undefined,
                );
                // App-side deletion succeeded (and retained basics) -> drop our telemetry.
                await this.prisma.endUser.delete({ where: { id: target.id } });
                deleted += 1;
            } catch (error) {
                failures.push({ externalUserId: target.externalUserId, reason: String(error) });
            }
        }

        // Audit trail (the app backend keeps the retention record; this records
        // who triggered the purge from the platform).
        await this.prisma.auditLog
            .create({
                data: {
                    adminId: admin.id,
                    adminEmail: admin.email,
                    action: 'DELETE',
                    entity: 'EndUser',
                    payload: {
                        appId,
                        requested: targets.length,
                        deleted,
                        failed: failures.length,
                        inactiveDays: opts.inactiveDays ?? null,
                    },
                },
            })
            .catch((err) => this.logger.warn(`Audit log for purge failed: ${String(err)}`));

        return { matched: targets.length, deleted, failed: failures.length, failures };
    }

    /**
     * Resolve pseudonymous engagement ids to real contact details by asking the
     * app's own backend. Returns an empty map when the app has no backend
     * configured or the call fails — enrichment must never break a stats page.
     */
    async fetchUserProfiles(appId: string): Promise<Map<string, FederatedProfile>> {
        const app = await this.prisma.app.findUnique({
            where: { id: appId },
            select: { backendBaseUrl: true, backendServiceToken: true, backendUsersPath: true },
        });
        if (!app?.backendBaseUrl || !app.backendUsersPath) return new Map();

        try {
            const payload = await this.call(
                { baseUrl: app.backendBaseUrl, token: this.decryptToken(app.backendServiceToken) },
                'GET',
                app.backendUsersPath,
                {},
                undefined,
            );
            return this.toProfileMap(payload);
        } catch (error) {
            this.logger.warn(
                `Profile enrichment failed for app ${appId}: ${String(error)}`,
            );
            return new Map();
        }
    }

    /**
     * Map an app backend's user list into {externalUserId -> profile}.
     * Field names vary per app, so a few common spellings are accepted.
     */
    private toProfileMap(payload: unknown): Map<string, FederatedProfile> {
        const map = new Map<string, FederatedProfile>();
        const rows = Array.isArray(payload)
            ? payload
            : Array.isArray((payload as any)?.data)
                ? (payload as any).data
                : Array.isArray((payload as any)?.users)
                    ? (payload as any).users
                    : [];

        for (const row of rows as Record<string, any>[]) {
            const id = row?._id ?? row?.id ?? row?.userId;
            if (!id) continue;
            const phone = row.phone ?? row.mobile ?? row.phoneNumber;
            map.set(String(id), {
                phone: phone === undefined || phone === null ? null : String(phone),
                name: row.name ?? row.shopName ?? row.fullName ?? null,
                registrationDate: row.registrationDate ?? row.createdAt ?? null,
            });
        }
        return map;
    }

    /** Single outbound path to an app backend, shared by the proxy and enrichment. */
    private async call(
        config: { baseUrl: string; token: string | null },
        method: string,
        subPath: string,
        query: Record<string, any>,
        body: unknown,
    ): Promise<unknown> {
        const url = this.buildUrl(config.baseUrl, subPath, query);
        const app = { backendServiceToken: config.token };

        const headers: Record<string, string> = { Accept: 'application/json' };
        if (app.backendServiceToken) {
            headers.Authorization = `Bearer ${app.backendServiceToken}`;
        }

        const hasBody = !['GET', 'HEAD'].includes(method.toUpperCase());
        if (hasBody) headers['Content-Type'] = 'application/json';

        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: hasBody && body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(AppAdminService.TIMEOUT_MS),
            });
        } catch (error) {
            // Never leak the target URL/token into the client-facing error.
            this.logger.error(`Federated call to ${url.origin} failed: ${String(error)}`);
            throw new ServiceUnavailableException("The app's backend is unreachable");
        }

        const payload = await this.parseBody(response);

        if (!response.ok) {
            throw new HttpException(
                typeof payload === 'string' ? { message: payload } : (payload as object),
                response.status,
            );
        }
        return payload;
    }

    /**
     * Join the configured base URL with the caller-supplied sub-path, rejecting
     * anything that tries to escape the base (traversal or an absolute URL).
     */
    private buildUrl(baseUrl: string, subPath: string, query: Record<string, any>): URL {
        const clean = (subPath ?? '').replace(/^\/+/, '');
        if (!clean) throw new BadRequestException('Missing backend path');
        if (clean.includes('..') || /^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) {
            throw new BadRequestException('Invalid backend path');
        }

        const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
        const url = new URL(clean, base);

        // Defence in depth: the resolved URL must stay under the configured origin+path.
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
            throw new BadRequestException('Invalid backend path');
        }

        for (const [key, value] of Object.entries(query ?? {})) {
            if (value === undefined || value === null) continue;
            if (Array.isArray(value)) {
                value.forEach((v) => url.searchParams.append(key, String(v)));
            } else {
                url.searchParams.append(key, String(value));
            }
        }
        return url;
    }

    private async parseBody(response: Response): Promise<unknown> {
        const text = await response.text();
        if (!text) return null;
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
            try {
                return JSON.parse(text);
            } catch {
                return text;
            }
        }
        return text;
    }
}
