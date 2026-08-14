import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { v4 as uuid } from 'uuid';
import { encryptServiceToken } from '../../common/crypto/service-token-cipher';

export interface AccessContext {
    userId: string;
    role: string;
}

/**
 * Scalar fields safe to return to the dashboard. Deliberately excludes
 * backendServiceToken (the app's federation credential) — see AppAdminService,
 * which is the only place that reads it back off the database.
 */
const APP_SAFE_SELECT = {
    id: true,
    name: true,
    appId: true,
    minVersionIos: true,
    minVersionAndroid: true,
    apiKey: true,
    description: true,
    platforms: true,
    icon: true,
    isActive: true,
    backendBaseUrl: true,
    backendUsersPath: true,
    backendDeleteUserPath: true,
    ga4PropertyId: true,
    createdAt: true,
    updatedAt: true,
} as const;

@Injectable()
export class AppsService {
    constructor(private prisma: PrismaService) { }

    /**
     * Encrypts backendServiceToken in place when the caller is setting/rotating it.
     *
     * A blank string is dropped rather than saved: the dashboard leaves the token
     * input empty to mean "keep what's already stored", and persisting '' would
     * both wipe a working credential and still look configured to callers that
     * only test for null. Clearing a token is done by sending an explicit null.
     */
    private prepareAppData<T extends { backendServiceToken?: unknown }>(data: T): T {
        if (typeof data.backendServiceToken !== 'string') return data;

        const token = data.backendServiceToken.trim();
        if (!token) {
            const { backendServiceToken: _blank, ...rest } = data;
            return rest as T;
        }
        return { ...data, backendServiceToken: encryptServiceToken(token) };
    }

    /**
     * Which of these apps have a federation token configured.
     *
     * Deliberately a separate query filtering on the column rather than
     * selecting it: the dashboard needs to know a token EXISTS (to show
     * "configured" and offer rotation) and must never receive its value, so
     * the ciphertext is not loaded into this code path at all.
     */
    private async withServiceToken(appIds: string[]): Promise<Set<string>> {
        if (appIds.length === 0) return new Set();
        const rows = await this.prisma.app.findMany({
            where: { id: { in: appIds }, NOT: { backendServiceToken: null } },
            select: { id: true },
        });
        return new Set(rows.map((r) => r.id));
    }

    /** Returns app IDs the user is allowed to access (all for Admin, else from AppCollaborator). */
    private async getAccessibleAppIds(ctx: AccessContext): Promise<string[] | null> {
        if (ctx.role === 'ADMIN') return null; // null = no filter
        const rows = await this.prisma.appCollaborator.findMany({
            where: { adminId: ctx.userId },
            select: { appId: true },
        });
        return rows.map((r) => r.appId);
    }

    async create(data: { collaboratorIds?: string[];[k: string]: any }, ctx: AccessContext) {
        if (ctx.role !== 'ADMIN') throw new ForbiddenException('Only admins can create projects');
        const { collaboratorIds = [], ...appData } = data;
        const { collaboratorIds: _c, ...rest } = appData as { collaboratorIds?: string[];[k: string]: any };
        const app = await this.prisma.app.create({
            data: {
                ...this.prepareAppData(rest),
                apiKey: uuid(),
            } as any,
        });
        if (collaboratorIds.length > 0) {
            await this.prisma.appCollaborator.createMany({
                data: collaboratorIds.map((adminId: string) => ({ appId: app.id, adminId })),
                skipDuplicates: true,
            });
        }
        return this.findOne(app.id, ctx);
    }

    async findAll(ctx: AccessContext) {
        const appIds = await this.getAccessibleAppIds(ctx);
        const where = appIds === null ? {} : { id: { in: appIds } };
        const apps = await this.prisma.app.findMany({
            where,
            select: {
                ...APP_SAFE_SELECT,
                storeUrls: true,
                _count: {
                    select: {
                        rules: true,
                        devices: true,
                    },
                },
                collaborators: {
                    select: {
                        adminId: true,
                        admin: { select: { id: true, email: true, name: true } },
                    },
                },
            },
        });
        const configured = await this.withServiceToken(apps.map((a) => a.id));
        const liveness = await this.lastSeen(apps.map((a) => a.id));
        return apps.map((a) => ({
            ...a,
            hasBackendServiceToken: configured.has(a.id),
            ...this.livenessOf(liveness.get(a.id) ?? null, a.createdAt, a.isActive),
        }));
    }

    /**
     * An app is "dark" when nexus has heard nothing from it recently.
     *
     * This exists because sonebill shipped 1.0.15 with an empty API key and went
     * completely silent for twelve days without anyone noticing: the client
     * disables telemetry when the key is blank, and version-check failures are
     * swallowed so a dead backend cannot crash the app. Both are correct
     * individually, and together they made a fully disconnected release look
     * healthy. Nexus holds the only evidence, so it is the thing that must notice.
     */
    private static readonly DARK_AFTER_HOURS = 48;

    /** Most recent contact per app: version checks and device check-ins. */
    private async lastSeen(ids: string[]): Promise<Map<string, Date>> {
        if (ids.length === 0) return new Map();
        const [checks, devices] = await Promise.all([
            this.prisma.appAnalytics.groupBy({
                by: ['appId'],
                where: { appId: { in: ids } },
                _max: { date: true },
            }),
            this.prisma.device.groupBy({
                by: ['appId'],
                where: { appId: { in: ids } },
                _max: { lastCheckIn: true },
            }),
        ]);

        const out = new Map<string, Date>();
        const record = (appId: string, at: Date | null) => {
            if (!at) return;
            const prev = out.get(appId);
            if (!prev || at > prev) out.set(appId, at);
        };
        checks.forEach((r) => record(r.appId, r._max.date));
        devices.forEach((r) => record(r.appId, r._max.lastCheckIn));
        return out;
    }

    private livenessOf(lastSeenAt: Date | null, createdAt: Date, isActive: boolean) {
        const cutoff = new Date(Date.now() - AppsService.DARK_AFTER_HOURS * 3600_000);
        // A freshly registered app has not had time to be heard from, so it is
        // never reported dark before the window has elapsed since creation.
        const isDark =
            isActive && createdAt < cutoff && (lastSeenAt === null || lastSeenAt < cutoff);
        return { lastSeenAt, isDark, darkAfterHours: AppsService.DARK_AFTER_HOURS };
    }

    async findOne(id: string, ctx?: AccessContext) {
        const app = await this.prisma.app.findUnique({
            where: { id },
            select: {
                ...APP_SAFE_SELECT,
                rules: true,
                storeUrls: true,
                maintenanceMode: true,
                _count: {
                    select: {
                        rules: true,
                        devices: true,
                    },
                },
                collaborators: {
                    select: {
                        adminId: true,
                        admin: { select: { id: true, email: true, name: true } },
                    },
                },
            },
        });
        if (!app) throw new NotFoundException('App not found');
        const configured = await this.withServiceToken([app.id]);
        return { ...app, hasBackendServiceToken: configured.has(app.id) };
    }

    async update(id: string, data: { collaboratorIds?: string[];[k: string]: any }, ctx: AccessContext) {
        if (ctx.role !== 'ADMIN') {
            // Collaborator can only update app details, not collaborators
            const { collaboratorIds: _, ...rest } = data;
            return this.prisma.app.update({
                where: { id },
                data: this.prepareAppData(rest),
                select: APP_SAFE_SELECT,
            });
        }
        const { collaboratorIds, ...appData } = data;
        const app = await this.prisma.app.update({
            where: { id },
            data: this.prepareAppData(appData),
        });
        if (collaboratorIds !== undefined) {
            await this.prisma.appCollaborator.deleteMany({ where: { appId: id } });
            if (collaboratorIds.length > 0) {
                await this.prisma.appCollaborator.createMany({
                    data: collaboratorIds.map((adminId: string) => ({ appId: id, adminId })),
                    skipDuplicates: true,
                });
            }
        }
        return this.findOne(id, ctx);
    }

    async remove(id: string, ctx: AccessContext) {
        if (ctx.role !== 'ADMIN') throw new ForbiddenException('Only admins can delete projects');
        return this.prisma.app.delete({
            where: { id },
        });
    }

    async getStats(id: string) {
        const [app, rulesCount, devicesCount, activeDevicesCount] = await Promise.all([
            this.prisma.app.findUnique({ where: { id } }),
            this.prisma.versionRule.count({ where: { appId: id } }),
            this.prisma.device.count({ where: { appId: id } }),
            this.prisma.device.count({
                where: {
                    appId: id,
                    lastCheckIn: {
                        gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Active in last 30 days
                    },
                },
            }),
        ]);

        if (!app) throw new NotFoundException('App not found');

        return {
            appId: (app as any).appId,
            name: app.name,
            totalRules: rulesCount,
            totalDevices: devicesCount,
            activeDevices: activeDevicesCount,
        };
    }

    async getRules(appId: string) {
        return this.prisma.versionRule.findMany({
            where: { appId },
            orderBy: { priority: 'desc' },
        });
    }

    async createRule(appId: string, data: any) {
        return this.prisma.versionRule.create({
            data: {
                ...data,
                appId,
            },
        });
    }

    async getStoreUrls(appId: string) {
        return this.prisma.storeUrl.findMany({ where: { appId } });
    }

    async upsertStoreUrl(appId: string, data: { platform: string, storeUrl: string }) {
        return this.prisma.storeUrl.upsert({
            where: {
                appId_platform: {
                    appId,
                    platform: data.platform,
                },
            },
            create: { ...data, appId },
            update: { storeUrl: data.storeUrl },
        });
    }

    async deleteStoreUrl(appId: string, platform: string) {
        return this.prisma.storeUrl.delete({
            where: {
                appId_platform: {
                    appId,
                    platform,
                },
            },
        });
    }

    async getMaintenance(appId: string) {
        return this.prisma.maintenanceMode.findUnique({ where: { appId } });
    }

    async updateMaintenance(appId: string, data: any) {
        return this.prisma.maintenanceMode.upsert({
            where: { appId },
            create: { ...data, appId },
            update: data,
        });
    }

    async toggleMaintenance(appId: string) {
        const mode = await this.getMaintenance(appId);
        if (!mode) {
            return this.prisma.maintenanceMode.create({
                data: { appId, isEnabled: true },
            });
        }
        return this.prisma.maintenanceMode.update({
            where: { appId },
            data: { isEnabled: !mode.isEnabled },
        });
    }
}