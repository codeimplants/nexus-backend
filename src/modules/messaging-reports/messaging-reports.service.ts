import {
    BadGatewayException,
    BadRequestException,
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Reads Code Implants Messaging's admin API for the dashboard's Messages tab.
 *
 * Messaging runs on this same server and its admin API is reached over
 * loopback (MESSAGING_ADMIN_URL, e.g. http://127.0.0.1:7130) with a read-only
 * ops key (MESSAGING_OPS_KEY, scopes usage:read and apps:read, accepted only
 * from 127.0.0.1). Both are written by messaging-backend/scripts/connect-ops.sh.
 * The key never reaches the browser: the dashboard calls this backend, which
 * calls messaging. Each call names the Nexus admin in X-Actor, so messaging's
 * audit log shows who looked.
 *
 * dev and preprod read messaging dev; prod reads messaging prod.
 */

interface UsageCounts {
    /** Every send that got past the limits, whatever the provider then did. */
    messages: number;
    segments: number;
    delivered: number;
    /** Refused by the provider, or undelivered. */
    failed: number;
    /** Refused by a per-number limit before reaching the provider. */
    suppressed: number;
    /** Taken by the provider: what it bills. */
    accepted: number;
    acceptedSegments: number;
}

interface UsageRow extends UsageCounts {
    bucket: string | null;
    groups: Record<string, string>;
    billedToUs?: boolean;
}

interface UsageResponse {
    range: { from: string; to: string; timezone: string };
    totals: UsageCounts;
    rows: UsageRow[];
}

interface MessagingApp {
    slug: string;
    name: string;
    active: boolean;
    createdAt: string;
    limits: {
        codesPerNumberPerDay: number | null;
        cooldownSeconds: number;
        segmentsPerDay: number | null;
        segmentsPerMonth: number | null;
    };
}

interface MessagingAppUsers {
    app: string;
    range: { from: string; to: string; timezone: string };
    users: Array<{
        endUserId: string;
        appUserId: string | null;
        phoneLast4: string;
        messages: number;
        segments: number;
        suppressed: number;
        lastAt: string;
    }>;
}

/** The summary's own vocabulary, chosen for the people reading it rather than for the SQL. */
export interface OtpCounts {
    /** Every code an app asked for in the range: sent, failed and blocked together. */
    requested: number;
    /** Taken by 2Factor and on its way to the phone. */
    sent: number;
    /** 2Factor refused it, or messaging could not reach 2Factor. */
    failed: number;
    /** Stopped by a per-number limit (cooldown or daily cap) before any SMS. */
    blocked: number;
    /** SMS segments 2Factor took: the billable unit. */
    smsSegments: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Up to this many days the chart has a bar per day; beyond it, a bar per month. */
const MAX_DAILY_BARS = 120;
const MAX_RANGE_DAYS = 3 * 366;

const toCounts = (r?: UsageCounts): OtpCounts => ({
    requested: (r?.messages ?? 0) + (r?.suppressed ?? 0),
    sent: r?.accepted ?? 0,
    failed: r?.failed ?? 0,
    blocked: r?.suppressed ?? 0,
    smsSegments: r?.acceptedSegments ?? 0,
});

const addCounts = (a: OtpCounts, b: OtpCounts): OtpCounts => ({
    requested: a.requested + b.requested,
    sent: a.sent + b.sent,
    failed: a.failed + b.failed,
    blocked: a.blocked + b.blocked,
    smsSegments: a.smsSegments + b.smsSegments,
});

const ZERO: OtpCounts = { requested: 0, sent: 0, failed: 0, blocked: 0, smsSegments: 0 };

@Injectable()
export class MessagingReportsService {
    private readonly logger = new Logger(MessagingReportsService.name);

    /**
     * The OTP picture across every app for one IST date range: totals, one row
     * per app (including apps that sent nothing), and a time series per app.
     */
    async otpSummary(input: { from?: string; to?: string }, actorId: string) {
        const range = this.range(input);
        const granularity = range.days <= MAX_DAILY_BARS ? 'day' : 'month';
        const qs = `from=${range.from}&to=${range.to}&kind=otp`;

        const [apps, byApp, byBucket, byUser] = await Promise.all([
            this.get<{ apps: MessagingApp[] }>('/apps', actorId),
            this.get<UsageResponse>(`/usage?${qs}&granularity=total&groupBy=app`, actorId),
            this.get<UsageResponse>(`/usage?${qs}&granularity=${granularity}&groupBy=app`, actorId),
            // One row per (app, phone): counting them gives the people per app.
            this.get<UsageResponse>(`/usage?${qs}&granularity=total&groupBy=app,user`, actorId),
        ]);

        const statsBySlug = new Map(byApp.rows.map((r) => [r.groups.app, r]));
        const usersBySlug = new Map<string, number>();
        for (const r of byUser.rows) usersBySlug.set(r.groups.app, (usersBySlug.get(r.groups.app) ?? 0) + 1);

        const appRows = apps.apps
            // An app switched off still shows if it sent something in the range.
            .filter((a) => a.active || statsBySlug.has(a.slug))
            .map((a) => {
                const stats = statsBySlug.get(a.slug);
                return {
                    slug: a.slug,
                    name: a.name,
                    active: a.active,
                    ...toCounts(stats),
                    users: usersBySlug.get(a.slug) ?? 0,
                    // false only for an account a client pays for (Barne Farms, when it joins).
                    billedToUs: stats?.billedToUs ?? true,
                    limits: a.limits,
                };
            })
            .sort((x, y) => y.smsSegments - x.smsSegments || y.requested - x.requested || x.name.localeCompare(y.name));

        const buckets = this.buckets(range, granularity);
        const series = new Map(buckets.map((b) => [b, { bucket: b, total: { ...ZERO }, bySlug: {} as Record<string, OtpCounts> }]));
        for (const r of byBucket.rows) {
            const point = r.bucket ? series.get(r.bucket) : undefined;
            if (!point) continue;
            const counts = toCounts(r);
            point.bySlug[r.groups.app] = counts;
            point.total = addCounts(point.total, counts);
        }

        return {
            range: { from: range.from, to: range.to, days: range.days, timezone: 'Asia/Kolkata', granularity },
            totals: {
                ...appRows.reduce<OtpCounts>((acc, a) => addCounts(acc, a), { ...ZERO }),
                users: byUser.rows.length,
                appsWithActivity: appRows.filter((a) => a.requested > 0).length,
            },
            apps: appRows,
            series: [...series.values()],
        };
    }

    /** One app's people, most codes first. Phones are only ever the last four digits. */
    async appUsers(slug: string, input: { from?: string; to?: string; limit?: string }, actorId: string) {
        if (!SLUG.test(slug)) throw new BadRequestException('Unknown app');
        const range = this.range(input);
        const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
        const res = await this.get<MessagingAppUsers>(
            `/apps/${slug}/users?from=${range.from}&to=${range.to}&limit=${limit}`,
            actorId,
        );
        return {
            app: slug,
            range: { from: range.from, to: range.to, timezone: 'Asia/Kolkata' },
            users: res.users.map((u) => ({
                phoneLast4: u.phoneLast4,
                appUserId: u.appUserId,
                codes: u.messages,
                smsSegments: u.segments,
                blocked: u.suppressed,
                lastAt: u.lastAt,
            })),
        };
    }

    // ---------------------------------------------------------------------

    /** Validated IST days, inclusive; the last 30 days when none are given. */
    private range(input: { from?: string; to?: string }) {
        const today = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
        const to = input.to?.trim() || today;
        const from = input.from?.trim() || new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10);
        for (const [name, value] of [['from', from], ['to', to]] as const) {
            const parsed = Date.parse(`${value}T00:00:00Z`);
            if (!DAY.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
                throw new BadRequestException(`${name} must be a date as YYYY-MM-DD`);
            }
        }
        const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
        if (days < 1) throw new BadRequestException('from must not be after to');
        if (days > MAX_RANGE_DAYS) throw new BadRequestException('Pick a range of at most three years');
        return { from, to, days };
    }

    /** Every bucket in the range, so days with nothing still appear as zero. */
    private buckets(range: { from: string; to: string }, granularity: 'day' | 'month'): string[] {
        const out: string[] = [];
        const end = Date.parse(`${range.to}T00:00:00Z`);
        if (granularity === 'day') {
            for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
            return out;
        }
        // Messaging labels a month by its first day.
        const d = new Date(`${range.from.slice(0, 7)}-01T00:00:00Z`);
        while (d.getTime() <= end) {
            out.push(d.toISOString().slice(0, 10));
            d.setUTCMonth(d.getUTCMonth() + 1);
        }
        return out;
    }

    private async get<T>(path: string, actorId: string): Promise<T> {
        const base = process.env.MESSAGING_ADMIN_URL?.trim().replace(/\/+$/, '');
        const key = process.env.MESSAGING_OPS_KEY?.trim();
        if (!base || !key) {
            throw new ServiceUnavailableException(
                'Messaging reports are not set up on this server (MESSAGING_ADMIN_URL / MESSAGING_OPS_KEY)',
            );
        }

        let res: Response;
        try {
            res = await fetch(`${base}/admin/v1${path}`, {
                headers: {
                    Authorization: `Bearer ${key}`,
                    'X-Actor': `nexus-admin:${actorId}`,
                    Accept: 'application/json',
                },
                signal: AbortSignal.timeout(15_000),
            });
        } catch (error) {
            this.logger.error(`Messaging admin API unreachable for ${path.split('?')[0]}: ${String(error)}`);
            throw new BadGatewayException('Messaging is not reachable right now');
        }

        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
            // Messaging's errors are { error: { type, code, message, requestId } }.
            const error = (body as { error?: { message?: unknown } } | null)?.error;
            const message = typeof error?.message === 'string' ? error.message : `HTTP ${res.status}`;
            this.logger.error(`Messaging admin API ${path.split('?')[0]} answered ${res.status}: ${message}`);
            if (res.status === 400) throw new BadRequestException(message);
            throw new BadGatewayException('Messaging could not produce the report');
        }
        return body as T;
    }
}
