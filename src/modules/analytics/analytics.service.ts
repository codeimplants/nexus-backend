import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppAdminService } from '../app-admin/app-admin.service';

export interface AccessContext {
    userId: string;
    role: string;
}

/**
 * Last 10 digits of a phone, or null if there aren't 10.
 *
 * Comparing raw strings does not work here: the app backend may send 9850929690
 * while the exclusion list holds +91 9850929690, and both are the same handset.
 * Ten digits is the significant part for Indian numbers, which is what every
 * app on this platform currently serves.
 */
function phoneKey(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const digits = String(value).replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : null;
}

export type UsageGranularity = 'day' | 'week' | 'month' | 'year';

/** Column the engagement table can be ordered by. */
export type EndUserSort =
    | 'lastActive'
    | 'registered'
    | 'name'
    | 'phone'
    | 'appVersion'
    | 'timeSpent'
    | 'avgSession'
    | 'opens'
    | 'activeDays';

export type SortOrder = 'asc' | 'desc';

/**
 * One row of the engagement table: an EndUser after the app backend's profile
 * and the DailyUsage rollups have been merged onto it. Only name, phone and
 * registeredAt can come from federation, which is why they are the nullable /
 * dual-typed fields here.
 */
export interface EnrichedEndUser {
    id: string;
    externalUserId: string;
    platform: string | null;
    authMethod: string | null;
    registeredAt: Date | string;
    lastActiveAt: Date;
    phone: string | null;
    name: string | null;
    /** Build on the user's most recently seen device, null if none reported one. */
    appVersion: string | null;
    totalDurationSec: number;
    totalOpens: number;
    activeDays: number;
    /** Mean length of a completed session over the window; null when there were none. */
    avgSessionSec: number | null;
    /** Whether the app's backend actually returned a profile for this id. */
    resolved: boolean;
}

/**
 * Orders version strings newest-first, comparing each dotted segment numerically
 * so 1.0.9 sorts below 1.0.10 rather than above it as a string compare would.
 * Unknown (null) versions sort last — they are the least actionable rows.
 */
function compareVersionsDesc(a: string | null, b: string | null): number {
    if (a === b) return 0;
    if (!a) return 1;
    if (!b) return -1;

    const left = a.split('.');
    const right = b.split('.');
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const l = Number(left[i] ?? 0);
        const r = Number(right[i] ?? 0);
        // A non-numeric segment (e.g. "1.0.16-rc1") falls back to a string
        // compare for that segment rather than NaN-ing the whole comparison.
        if (Number.isNaN(l) || Number.isNaN(r)) {
            const cmp = (right[i] ?? '').localeCompare(left[i] ?? '');
            if (cmp !== 0) return cmp;
            continue;
        }
        if (l !== r) return r - l;
    }
    return 0;
}

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
            // Every AppAnalytics row is written by a version check by construction
            // (see sdk.service.ts's logAnalytics) — count all of them, not just the
            // 'version_check' (no-op) outcome, which would undercount total checks.
            this.prisma.appAnalytics.count({
                where: appIds === null ? {} : { appId: { in: appIds } },
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

    async getVersionChecks(ctx: AccessContext, eventType?: string) {
        const appIds = await this.getAccessibleAppIds(ctx);
        // "Version checks" and AppAnalytics rows are synonymous here (every row
        // is written by a version check) — default to all outcomes, optionally
        // narrowed to one (e.g. eventType=update_force).
        const where: any = eventType ? { eventType } : {};
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

        const [
            installedDevices,
            loggedInUsers,
            activeUsers,
            platformRows,
            modelRows,
            appVersionRows,
            registrations,
        ] =
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
                // Which build each install is actually running — the basis for
                // "who is still on the version with the bug" and for deciding
                // whether a force-update rule is worth setting.
                this.prisma.device.groupBy({
                    by: ['platform', 'appVersion'],
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
            // Newest build first, so the tail of old installs reads down the list.
            // appVersion is nullable: devices seen before the column existed, and
            // any install whose first /sdk/device call predates a resolved key.
            appVersionSplit: appVersionRows
                .map((r) => ({
                    platform: r.platform,
                    appVersion: r.appVersion,
                    count: r._count.id,
                }))
                .sort(
                    (a, b) =>
                        a.platform.localeCompare(b.platform) ||
                        compareVersionsDesc(a.appVersion, b.appVersion),
                ),
            registrationTimeline: registrations.map((r) => ({
                day: r.day,
                count: Number(r.count),
            })),
        };
    }

    /**
     * Growth + churn labels for one app: new/active/churned/never-active user
     * counts, surfacing the same "inactive" cutoff getUsers'/purgeUsers'
     * inactiveDays already uses as labeled numbers instead of a raw list — this
     * is the Bulk Cleanup targeting logic made visible, not a duplicate of a
     * Firebase report.
     */
    async getGrowth(appId: string, churnDays = 30) {
        const now = Date.now();
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
        const churnCutoff = new Date(now - churnDays * 24 * 60 * 60 * 1000);

        const [totalUsers, newThisWeek, newThisMonth, neverActive, churned, active] = await Promise.all([
            this.prisma.endUser.count({ where: { appId } }),
            this.prisma.endUser.count({ where: { appId, registeredAt: { gte: weekAgo } } }),
            this.prisma.endUser.count({ where: { appId, registeredAt: { gte: monthAgo } } }),
            // Zero DailyUsage rows ever — not a lastActiveAt===registeredAt proxy,
            // since lastActiveAt updates on any touched event (login_success,
            // screen_view, ...), not just a completed session.
            this.prisma.endUser.count({ where: { appId, dailyUsage: { none: {} } } }),
            this.prisma.endUser.count({ where: { appId, lastActiveAt: { lt: churnCutoff } } }),
            this.prisma.endUser.count({ where: { appId, lastActiveAt: { gte: churnCutoff } } }),
        ]);

        return { totalUsers, newThisWeek, newThisMonth, neverActive, churned, active, churnDays };
    }

    /**
     * Paged list of an app's end users with a usage summary over the last `days`
     * window. registeredAt here is the platform's first-seen; the app backend's
     * true registration date is added by the federation layer (see app-admin).
     *
     * Search and sort run in memory over the whole population rather than in
     * SQL, because half the columns do not exist in this database: name and
     * phone come from the app's own backend, and time/opens/days are DailyUsage
     * rollups. "Order by name" is simply not expressible as a Postgres ORDER BY
     * here, so pushing part of it down and doing the rest in memory would only
     * produce two orderings that disagree at the page boundary.
     *
     * The cost is bounded by something already being paid: fetchUserProfiles
     * pulls the app's ENTIRE user list from its backend on every call to this
     * method, so materialising the same population here adds no new order of
     * magnitude. If an app outgrows that, the profile fetch is what has to
     * change first — this merge follows it.
     */
    async getUsers(
        appId: string,
        opts: {
            limit?: number;
            offset?: number;
            days?: number;
            inactiveDays?: number;
            search?: string;
            sort?: EndUserSort;
            order?: SortOrder;
        } = {},
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

        const [users, app] = await Promise.all([
            this.prisma.endUser.findMany({ where }),
            this.prisma.app.findUnique({ where: { id: appId }, select: { excludedPhones: true } }),
        ]);

        if (users.length === 0) {
            // No one to enrich, so the app's backend isn't called at all. Report
            // `enriched: false` for a stable response shape — never as evidence
            // that federation is unconfigured, which is what the UI would imply
            // if it flagged an empty list.
            return { total: 0, limit, offset, enriched: false, users: [] };
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

        // Which build each user is actually on. Version lives on Device, not on
        // EndUser, and someone can have several (a phone and the web app), so
        // this takes the most recently seen device that reported a version —
        // "what they were last running", which is what an upgrade chase needs.
        // Devices with no version at all are skipped rather than treated as the
        // answer, or a single unreported web session would hide a known build.
        const devices = await this.prisma.device.findMany({
            where: { appId, endUserId: { in: users.map((u) => u.id) } },
            select: { endUserId: true, appVersion: true },
            orderBy: { lastCheckIn: 'desc' },
        });
        const versionByUser = new Map<string, string>();
        for (const device of devices) {
            if (!device.endUserId || !device.appVersion) continue;
            if (!versionByUser.has(device.endUserId)) {
                versionByUser.set(device.endUserId, device.appVersion);
            }
        }

        let rows: EnrichedEndUser[] = users.map((u) => {
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
                appVersion: versionByUser.get(u.id) ?? null,
                totalDurationSec: r?._sum.totalDurationSec ?? 0,
                totalOpens: r?._sum.openCount ?? 0,
                activeDays: r?._count.date ?? 0,
                // null rather than 0 when nothing completed: "no sessions" is not
                // "sessions averaging zero seconds", and the table sorts them apart.
                avgSessionSec:
                    (r?._sum.openCount ?? 0) > 0
                        ? Math.round((r?._sum.totalDurationSec ?? 0) / (r?._sum.openCount ?? 1))
                        : null,
                // Distinguishes "the shop never set a name" from "this id is not
                // a shop at all". Both show no name, but only the second means
                // the row can never resolve, so the UI must not label them alike.
                resolved: !!p,
            };
        });

        // Internal handsets are dropped after enrichment, not before: the phone
        // that identifies them only exists on the app backend's profile, so
        // there is nothing to match against until the profiles are in hand.
        const excluded = new Set(
            (app?.excludedPhones ?? []).map((p) => phoneKey(p)).filter((p): p is string => !!p),
        );
        if (excluded.size > 0) {
            rows = rows.filter((row) => {
                const key = phoneKey(row.phone);
                return !key || !excluded.has(key);
            });
        }

        const term = opts.search?.trim().toLowerCase();
        if (term) {
            // externalUserId is searchable too, not just name and phone: a row
            // the app backend could not resolve shows that id instead of a name,
            // so it is the only handle an operator has on exactly those users.
            rows = rows.filter((row) =>
                [row.name, row.phone, row.externalUserId].some(
                    (field) => field != null && String(field).toLowerCase().includes(term),
                ),
            );
        }

        // Stale-first when targeting a cleanup, newest-first otherwise. Kept as
        // the default so callers that pass no sort see what they always saw.
        const sort = opts.sort ?? 'lastActive';
        const order = opts.order ?? (!opts.sort && opts.inactiveDays ? 'asc' : 'desc');
        rows.sort(this.compareEndUsers(sort, order));

        return {
            total: rows.length,
            limit,
            offset,
            // True when the app's backend answered — the UI can then show real
            // contact details instead of only the pseudonymous id.
            enriched: profiles.size > 0,
            users: rows.slice(offset, offset + limit),
        };
    }

    /**
     * Comparator for the engagement table.
     *
     * Rows with no value for the sorted column sink to the bottom in BOTH
     * directions rather than flipping to the top on ascending. A user whose
     * name never resolved is not "alphabetically first", and someone sorting by
     * name is looking for a name — burying the named rows under a block of
     * unresolved ids would defeat the click.
     */
    private compareEndUsers(sort: EndUserSort, order: SortOrder) {
        const dir = order === 'asc' ? 1 : -1;

        return (a: EnrichedEndUser, b: EnrichedEndUser): number => {
            switch (sort) {
                case 'name':
                case 'phone': {
                    const left = (sort === 'name' ? a.name : a.phone) ?? '';
                    const right = (sort === 'name' ? b.name : b.phone) ?? '';
                    if (!left && !right) return 0;
                    if (!left) return 1;
                    if (!right) return -1;
                    // Numeric collation so phone 9 sorts before 10, and so shop
                    // names leading with a number order the way a human reads.
                    return left.localeCompare(right, undefined, { numeric: true }) * dir;
                }
                case 'appVersion': {
                    const left = a.appVersion;
                    const right = b.appVersion;
                    if (!left && !right) return 0;
                    if (!left) return 1;
                    if (!right) return -1;
                    // Segment-wise numeric compare, so 1.0.9 sorts below 1.0.10
                    // rather than above it as a string compare would. The helper
                    // is newest-first, hence the inversion for ascending.
                    return compareVersionsDesc(left, right) * (order === 'desc' ? 1 : -1);
                }
                case 'registered':
                    return (this.epoch(a.registeredAt) - this.epoch(b.registeredAt)) * dir;
                case 'timeSpent':
                    return (a.totalDurationSec - b.totalDurationSec) * dir;
                case 'opens':
                    return (a.totalOpens - b.totalOpens) * dir;
                case 'activeDays':
                    return (a.activeDays - b.activeDays) * dir;
                case 'avgSession': {
                    // Users with no completed session sink in both directions, as
                    // name and version already do — no average is not a short one.
                    const left = a.avgSessionSec;
                    const right = b.avgSessionSec;
                    if (left === null && right === null) return 0;
                    if (left === null) return 1;
                    if (right === null) return -1;
                    return (left - right) * dir;
                }
                case 'lastActive':
                default:
                    return (this.epoch(a.lastActiveAt) - this.epoch(b.lastActiveAt)) * dir;
            }
        };
    }

    /**
     * Epoch ms for a Date or an ISO string. registeredAt is either, depending on
     * whether the app backend supplied a signup date, so both must compare.
     */
    private epoch(value: Date | string | null): number {
        if (!value) return 0;
        const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
        return Number.isNaN(t) ? 0 : t;
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
     * Distinct users active per day — the DAU series that the audience card's
     * rolling "Active (30d)" single number cannot show.
     *
     * Counting DailyUsage rows is a distinct-user count here, not a row count:
     * @@unique([appId, endUserId, date]) means one row per user per day, so a
     * plain _count is already COUNT(DISTINCT endUserId). This is the only reason
     * groupBy suffices instead of raw SQL — if that constraint ever goes, this
     * silently starts double-counting and must move to COUNT(DISTINCT).
     *
     * Days with no usage are emitted as zeros rather than skipped: a gap in a
     * chart reads as missing data, whereas "nobody opened it on Sunday" is
     * exactly the signal worth seeing.
     */
    async getActiveSeries(appId: string, days = 30) {
        // Clamped because the response carries one element per day — an
        // unbounded ?days= would build an arbitrarily large array server-side.
        const windowDays = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
        const toDay = this.utcDay(new Date());
        const fromDay = this.utcDay(new Date(Date.now() - (windowDays - 1) * 24 * 60 * 60 * 1000));

        const rows = await this.prisma.dailyUsage.groupBy({
            by: ['date'],
            where: { appId, date: { gte: fromDay, lte: toDay } },
            _count: { endUserId: true },
            _sum: { openCount: true, sessionCount: true },
        });

        const byDay = new Map(rows.map((r) => [this.dayKey(r.date), r]));

        const series: {
            day: string;
            activeUsers: number;
            opens: number;
            sessions: number;
        }[] = [];

        for (let t = fromDay.getTime(); t <= toDay.getTime(); t += 24 * 60 * 60 * 1000) {
            const day = this.dayKey(new Date(t));
            const r = byDay.get(day);
            series.push({
                day,
                activeUsers: r?._count.endUserId ?? 0,
                opens: r?._sum.openCount ?? 0,
                sessions: r?._sum.sessionCount ?? 0,
            });
        }

        const active = series.map((s) => s.activeUsers);
        return {
            days: windowDays,
            from: fromDay,
            to: toDay,
            peakActiveUsers: Math.max(...active, 0),
            // Mean over the whole window including zero days, so a quiet week
            // pulls the number down instead of being averaged away.
            averageActiveUsers: Math.round((active.reduce((a, b) => a + b, 0) / series.length) * 10) / 10,
            series,
        };
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

        const [users, profiles, app] = await Promise.all([
            this.prisma.endUser.findMany({
                where: { id: { in: qualifying.map((r) => r.endUserId) } },
            }),
            // Leads are the one place contact details actually matter — without
            // them you know someone is worth calling but not how to reach them.
            this.appAdmin.fetchUserProfiles(appId),
            this.prisma.app.findUnique({ where: { id: appId }, select: { excludedPhones: true } }),
        ]);
        const byId = new Map(users.map((u) => [u.id, u]));

        // An internal handset clears every engagement threshold by construction,
        // so without this the outreach list is topped by numbers nobody should
        // be calling.
        const excluded = new Set(
            (app?.excludedPhones ?? []).map((p) => phoneKey(p)).filter((p): p is string => !!p),
        );

        return {
            windowDays: days,
            thresholds: { minMinutes: opts.minMinutes ?? 30, minSessions, minActiveDays },
            enriched: profiles.size > 0,
            leads: qualifying
                .filter((r) => {
                    if (excluded.size === 0) return true;
                    const u = byId.get(r.endUserId);
                    const key = phoneKey(u ? profiles.get(u.externalUserId)?.phone : null);
                    return !key || !excluded.has(key);
                })
                .map((r) => {
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

    /** Stable YYYY-MM-DD key for a UTC day bucket, so the zero-filled series
     * joins to grouped rows without any timezone arithmetic. */
    private dayKey(d: Date): string {
        return d.toISOString().slice(0, 10);
    }
}
