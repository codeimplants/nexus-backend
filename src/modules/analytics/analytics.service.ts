import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppAdminService } from '../app-admin/app-admin.service';

export interface AccessContext {
    userId: string;
    role: string;
}

export type UsageGranularity = 'day' | 'week' | 'month' | 'year';

@Injectable()
export class AnalyticsService {
    constructor(
        private prisma: PrismaService,
        private appAdmin: AppAdminService,
    ) { }

    private async getAccessibleAppIds(ctx: AccessContext): Promise<string[] | null> {
        if (ctx.role === 'ADMIN') return null;
        const rows = await this.prisma.appCollaborator.findMany({
            where: { adminId: ctx.userId },
            select: { appId: true },
        });
        return rows.map((r) => r.appId);
    }

    async getOverview(ctx: AccessContext) {
        const appIds = await this.getAccessibleAppIds(ctx);
        const appWhere = appIds === null ? {} : { id: { in: appIds } };
        const deviceWhere = appIds === null ? {} : { appId: { in: appIds } };
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const [totalProjects, totalApps, totalRules, totalDevices, activeDevices, versionChecks, forceUpdates] = await Promise.all([
            this.prisma.app.count({ where: appWhere }),
            this.prisma.app.count({ where: appWhere }),
            this.prisma.versionRule.count({ where: { app: appWhere } }),
            this.prisma.device.count({ where: deviceWhere }),
            this.prisma.device.count({
                where: {
                    ...deviceWhere,
                    lastCheckIn: { gte: since },
                },
            }),
            this.prisma.appAnalytics.count({
                where: {
                    ...(appIds === null ? {} : { appId: { in: appIds } }),
                    eventType: 'version_check',
                },
            }),
            this.prisma.appAnalytics.count({
                where: {
                    ...(appIds === null ? {} : { appId: { in: appIds } }),
                    eventType: 'update_force',
                },
            }),
        ]);

        return {
            totalProjects,
            totalApps,
            totalRules,
            totalDevices,
            activeDevices,
            totalChecks: versionChecks,
            forceUpdates,
        };
    }

    async getByApp(appId: string) {
        return this.prisma.appAnalytics.findMany({
            where: { appId },
            orderBy: { date: 'desc' },
            take: 50,
        });
    }

    async getVersionChecks(ctx: AccessContext) {
        const appIds = await this.getAccessibleAppIds(ctx);
        const where: any = { eventType: 'version_check' };
        if (appIds !== null) where.appId = { in: appIds };
        return this.prisma.appAnalytics.findMany({
            where,
            orderBy: { date: 'desc' },
            take: 100,
        });
    }

    async getPlatformDistribution(ctx: AccessContext) {
        const appIds = await this.getAccessibleAppIds(ctx);
        const where = appIds === null ? {} : { appId: { in: appIds } };
        const distribution = await this.prisma.device.groupBy({
            by: ['platform'],
            where,
            _count: { id: true },
        });
        return distribution.map((d) => ({
            platform: d.platform,
            count: d._count.id,
        }));
    }

    // ---------------------------------------------------------------------
    // Per-app engagement (access already enforced by AppAccessGuard on the route)
    // ---------------------------------------------------------------------

    /**
     * Audience overview for one app: installs (devices), logged-in users, active
     * users, device split by platform and make/model, and a registration timeline.
     */
    async getAudience(appId: string, days = 30) {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const [installedDevices, loggedInUsers, activeUsers, platformRows, modelRows, registrations] =
            await Promise.all([
                this.prisma.device.count({ where: { appId } }),
                this.prisma.endUser.count({ where: { appId } }),
                this.prisma.endUser.count({ where: { appId, lastActiveAt: { gte: since } } }),
                this.prisma.device.groupBy({
                    by: ['platform'],
                    where: { appId },
                    _count: { id: true },
                }),
                this.prisma.device.groupBy({
                    by: ['platform', 'make', 'model'],
                    where: { appId },
                    _count: { id: true },
                }),
                this.prisma.$queryRaw<{ day: Date; count: bigint }[]>(Prisma.sql`
                    SELECT date_trunc('day', "registeredAt")::date AS day, COUNT(*)::int AS count
                    FROM "EndUser"
                    WHERE "appId" = ${appId} AND "registeredAt" >= ${since}
                    GROUP BY 1 ORDER BY 1
                `),
            ]);

        return {
            installedDevices,
            loggedInUsers,
            activeUsers,
            platformSplit: platformRows.map((r) => ({ platform: r.platform, count: r._count.id })),
            deviceModelSplit: modelRows
                .map((r) => ({
                    platform: r.platform,
                    make: r.make,
                    model: r.model,
                    count: r._count.id,
                }))
                .sort((a, b) => b.count - a.count),
            registrationTimeline: registrations.map((r) => ({
                day: r.day,
                count: Number(r.count),
            })),
        };
    }

    /**
     * Paged list of an app's end users with a lifetime-ish usage summary
     * (aggregated over the last `days` window). registeredAt here is the
     * platform's first-seen; the app backend's true registration date is added
     * by the federation layer (see app-admin proxy).
     */
    async getUsers(
        appId: string,
        opts: { limit?: number; offset?: number; days?: number; inactiveDays?: number } = {},
    ) {
        const limit = Math.min(opts.limit ?? 50, 200);
        const offset = opts.offset ?? 0;
        const since = new Date(Date.now() - (opts.days ?? 30) * 24 * 60 * 60 * 1000);
        const sinceDay = this.utcDay(since);

        // Optional inactivity filter for cleanup: only users last active before
        // the cutoff, most-stale first so purge candidates surface at the top.
        const where: Prisma.EndUserWhereInput = { appId };
        if (opts.inactiveDays && opts.inactiveDays > 0) {
            where.lastActiveAt = {
                lt: new Date(Date.now() - opts.inactiveDays * 24 * 60 * 60 * 1000),
            };
        }
        const orderBy: Prisma.EndUserOrderByWithRelationInput = opts.inactiveDays
            ? { lastActiveAt: 'asc' }
            : { lastActiveAt: 'desc' };

        const [total, users] = await Promise.all([
            this.prisma.endUser.count({ where }),
            this.prisma.endUser.findMany({
                where,
                orderBy,
                skip: offset,
                take: limit,
            }),
        ]);

        if (users.length === 0) {
            // No one to enrich, so the app's backend isn't called at all. Report
            // `enriched: false` for a stable response shape — never as evidence
            // that federation is unconfigured, which is what the UI would imply
            // if it flagged an empty list.
            return { total, limit, offset, enriched: false, users: [] };
        }

        const [rollups, profiles] = await Promise.all([
            this.prisma.dailyUsage.groupBy({
                by: ['endUserId'],
                where: { appId, endUserId: { in: users.map((u) => u.id) }, date: { gte: sinceDay } },
                _sum: { totalDurationSec: true, openCount: true, sessionCount: true },
                _count: { date: true },
            }),
            this.appAdmin.fetchUserProfiles(appId),
        ]);
        const byUser = new Map(rollups.map((r) => [r.endUserId, r]));

        return {
            total,
            limit,
            offset,
            // True when the app's backend answered — the UI can then show real
            // contact details instead of only the pseudonymous id.
            enriched: profiles.size > 0,
            users: users.map((u) => {
                const r = byUser.get(u.id);
                const p = profiles.get(u.externalUserId);
                return {
                    id: u.id,
                    externalUserId: u.externalUserId,
                    platform: u.platform,
                    authMethod: u.authMethod,
                    // Platform first-seen; the app backend's real signup date wins when known.
                    registeredAt: p?.registrationDate ?? u.registeredAt,
                    lastActiveAt: u.lastActiveAt,
                    phone: p?.phone ?? null,
                    name: p?.name ?? null,
                    totalDurationSec: r?._sum.totalDurationSec ?? 0,
                    totalOpens: r?._sum.openCount ?? 0,
                    activeDays: r?._count.date ?? 0,
                };
            }),
        };
    }

    /**
     * Time-spent + open-count series for one user, bucketed by day/week/month/year.
     */
    async getUserUsage(
        appId: string,
        endUserId: string,
        granularity: UsageGranularity = 'day',
        from?: Date,
        to?: Date,
    ) {
        const toDate = this.utcDay(to ?? new Date());
        const fromDate = this.utcDay(from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

        const rows = await this.prisma.$queryRaw<
            { period: Date; totalDurationSec: number; openCount: number; sessionCount: number; activeDays: number }[]
        >(Prisma.sql`
            SELECT date_trunc(${granularity}, "date")::date AS period,
                   SUM("totalDurationSec")::int AS "totalDurationSec",
                   SUM("openCount")::int AS "openCount",
                   SUM("sessionCount")::int AS "sessionCount",
                   COUNT(*)::int AS "activeDays"
            FROM "DailyUsage"
            WHERE "appId" = ${appId} AND "endUserId" = ${endUserId}
              AND "date" >= ${fromDate} AND "date" <= ${toDate}
            GROUP BY 1 ORDER BY 1
        `);

        return { granularity, from: fromDate, to: toDate, series: rows };
    }

    /**
     * High-engagement cohort for subscription outreach: users whose usage over the
     * last `days` window clears the given thresholds, most-engaged first.
     */
    async getLeads(
        appId: string,
        opts: { minMinutes?: number; minSessions?: number; minActiveDays?: number; days?: number } = {},
    ) {
        const days = opts.days ?? 30;
        const minDurationSec = (opts.minMinutes ?? 30) * 60;
        const minSessions = opts.minSessions ?? 5;
        const minActiveDays = opts.minActiveDays ?? 3;
        const sinceDay = this.utcDay(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

        const rollups = await this.prisma.dailyUsage.groupBy({
            by: ['endUserId'],
            where: { appId, date: { gte: sinceDay } },
            _sum: { totalDurationSec: true, sessionCount: true },
            _count: { date: true },
        });

        const qualifying = rollups
            .filter(
                (r) =>
                    (r._sum.totalDurationSec ?? 0) >= minDurationSec &&
                    (r._sum.sessionCount ?? 0) >= minSessions &&
                    r._count.date >= minActiveDays,
            )
            .sort((a, b) => (b._sum.totalDurationSec ?? 0) - (a._sum.totalDurationSec ?? 0));

        if (qualifying.length === 0) {
            return { windowDays: days, thresholds: { minMinutes: opts.minMinutes ?? 30, minSessions, minActiveDays }, enriched: false, leads: [] };
        }

        const [users, profiles] = await Promise.all([
            this.prisma.endUser.findMany({
                where: { id: { in: qualifying.map((r) => r.endUserId) } },
            }),
            // Leads are the one place contact details actually matter — without
            // them you know someone is worth calling but not how to reach them.
            this.appAdmin.fetchUserProfiles(appId),
        ]);
        const byId = new Map(users.map((u) => [u.id, u]));

        return {
            windowDays: days,
            thresholds: { minMinutes: opts.minMinutes ?? 30, minSessions, minActiveDays },
            enriched: profiles.size > 0,
            leads: qualifying.map((r) => {
                const u = byId.get(r.endUserId);
                const p = u ? profiles.get(u.externalUserId) : undefined;
                return {
                    endUserId: r.endUserId,
                    externalUserId: u?.externalUserId,
                    platform: u?.platform,
                    lastActiveAt: u?.lastActiveAt,
                    phone: p?.phone ?? null,
                    name: p?.name ?? null,
                    registrationDate: p?.registrationDate ?? u?.registeredAt ?? null,
                    totalDurationSec: r._sum.totalDurationSec ?? 0,
                    totalSessions: r._sum.sessionCount ?? 0,
                    activeDays: r._count.date,
                };
            }),
        };
    }

    private utcDay(d: Date): Date {
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
}
