import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../database/prisma.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ACTION: Record<string, string> = { POST: 'CREATE', PUT: 'UPDATE', PATCH: 'UPDATE', DELETE: 'DELETE' };
const SECRET_KEY = /pass(word)?|secret|token|otp|code|fullhash|api[-_]?key|authorization/i;
const MAX_PAYLOAD_CHARS = 20_000;

/**
 * Money and subscription changes, flagged so the audit view can filter them.
 * Matched against the request path, which for app-admin includes the path
 * proxied to the app's own backend (e.g. /admin/apps/:id/proxy/users/:uid/plan).
 */
const SENSITIVE_PATH = /subscri|plan|price|pricing|payment|gateway|refund|wallet|credit|limit|pro\b|premium|billing/i;

function redact(value: unknown, depth = 0): unknown {
    if (depth > 6 || value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) =>
            [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]),
    );
}

/** `/admin/apps/123/feature-flags/9` -> `apps/feature-flags` */
function entityOf(path: string): string {
    return path
        .replace(/^\/+/, '')
        .split('/')
        .filter((seg) => seg && seg !== 'admin' && !/^[0-9a-f-]{8,}$|^\d+$/i.test(seg))
        .slice(0, 3)
        .join('/') || 'unknown';
}

/**
 * Records every write a signed-in account attempts — who, role, what, the
 * (redacted) request body, success or the refusal — into AuditLog. Global, so
 * a new endpoint is audited without anyone remembering to call AuditService.
 * Rows are append-only; nothing in the API edits or deletes them.
 *
 * Failures to write the log are logged loudly but never break the request:
 * the change already happened, and losing the response would hide that.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
    private readonly logger = new Logger(AuditInterceptor.name);

    constructor(private prisma: PrismaService) { }

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        if (context.getType() !== 'http') return next.handle();
        const req = context.switchToHttp().getRequest();
        const method = String(req.method).toUpperCase();
        if (READ_METHODS.has(method) || !req.user?.id) return next.handle();

        const started = Date.now();
        const record = (outcome: 'SUCCESS' | 'FAILED', status: number, error?: string) => {
            const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
            let body = redact(req.body ?? null);
            const bodyText = JSON.stringify(body ?? null);
            if (bodyText.length > MAX_PAYLOAD_CHARS) body = { truncated: bodyText.slice(0, MAX_PAYLOAD_CHARS) };
            const params = req.params ?? {};
            this.prisma.auditLog
                .create({
                    data: {
                        adminId: req.user.id,
                        adminEmail: req.user.email ?? null,
                        action: ACTION[method] ?? method,
                        entity: entityOf(path),
                        entityId: params.id ?? params.flagId ?? params.itemId ?? params.ruleId ?? null,
                        payload: {
                            method,
                            path,
                            params,
                            query: redact(req.query ?? {}),
                            body,
                            actorName: req.user.name ?? null,
                            actorRole: req.user.role,
                            mfaVerified: req.user.mfaVerified === true,
                            sensitive: SENSITIVE_PATH.test(path) || SENSITIVE_PATH.test(bodyText),
                            outcome,
                            status,
                            ...(error ? { error: error.slice(0, 500) } : {}),
                            durationMs: Date.now() - started,
                        } as any,
                        ipAddress: (req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.ip ?? null),
                        userAgent: req.headers['user-agent']?.slice(0, 255) ?? null,
                    },
                })
                .catch((e) => this.logger.error(`AUDIT WRITE FAILED for ${method} ${path} by ${req.user.id}: ${e.message}`));
        };

        return next.handle().pipe(
            tap({
                next: () => record('SUCCESS', context.switchToHttp().getResponse()?.statusCode ?? 200),
                error: (err) => record('FAILED', err?.status ?? 500, err?.message),
            }),
        );
    }
}
