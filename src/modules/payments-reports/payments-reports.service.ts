import {
    BadGatewayException,
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { istBuckets, istRange, shiftDay, type IstRange } from '../../common/ist-days';

/**
 * Reads Code Implants Pay's reporting API for the dashboard's Payments tab.
 *
 * Payments runs on this same server and its admin API is reached over
 * loopback (PAYMENTS_ADMIN_URL, e.g. http://127.0.0.1:7120) with a read-only
 * ops key (PAYMENTS_OPS_KEY, scope admin:read, accepted only from 127.0.0.1).
 * Both are written by payments-backend/scripts/connect-nexus.sh. The key never
 * reaches the browser: the dashboard calls this backend, which calls payments.
 * Each call names the Nexus admin in X-Actor.
 *
 * dev and preprod read payments dev (the PhonePe sandbox); prod reads payments prod.
 */

/** Money in payments' own words: paise, captures and refunds counted on the IST day they happened. */
interface PayMoney {
    captured: number;
    refunded: number;
    net: number;
    captureCount: number;
    refundCount: number;
    /** Distinct customerRefs that paid, within an app. */
    payers: number;
}

interface PaySummaryRow extends PayMoney {
    key: string;
    groups: Record<string, string>;
    intentsCreated: number;
    intentsSucceeded: number;
    intentsFailed: number;
}

interface PaySummary {
    totals: PayMoney;
    rows: PaySummaryRow[];
}

interface PayApp {
    slug: string;
    name: string;
    status: 'active' | 'suspended';
    createdAt: string;
}

interface PayCustomers {
    data: Array<{
        app: string;
        customerRef: string | null;
        captured: number;
        refunded: number;
        net: number;
        captureCount: number;
        refundCount: number;
        firstPaidAt: string | null;
        lastPaidAt: string | null;
    }>;
    hasMore: boolean;
}

/** The summary's own vocabulary. Amounts are paise, so nothing is lost to rounding on the way. */
export interface PaymentCounts {
    /** Money that came in: every successful payment, before refunds. */
    received: number;
    /** Money sent back, on the day the refund went through. */
    refunded: number;
    /** received − refunded. Negative on a day with more refunds than payments. */
    net: number;
    /** Successful payments. */
    payments: number;
    refunds: number;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Up to this many days the chart has a bar per day; beyond it, a bar per month. */
const MAX_DAILY_BARS = 120;
/** The most payments' summary takes in one call. */
const RANGE_LIMIT = { days: 400, message: 'Pick a range of at most 400 days' };

const toCounts = (r?: PayMoney): PaymentCounts => ({
    received: r?.captured ?? 0,
    refunded: r?.refunded ?? 0,
    net: r?.net ?? 0,
    payments: r?.captureCount ?? 0,
    refunds: r?.refundCount ?? 0,
});

const addCounts = (a: PaymentCounts, b: PaymentCounts): PaymentCounts => ({
    received: a.received + b.received,
    refunded: a.refunded + b.refunded,
    net: a.net + b.net,
    payments: a.payments + b.payments,
    refunds: a.refunds + b.refunds,
});

const ZERO: PaymentCounts = { received: 0, refunded: 0, net: 0, payments: 0, refunds: 0 };

/** The instants payments takes for a range of IST days: midnight IST on the first day, to midnight after the last. */
const instants = (range: IstRange) =>
    `from=${encodeURIComponent(`${range.from}T00:00:00+05:30`)}&to=${encodeURIComponent(`${shiftDay(range.to, 1)}T00:00:00+05:30`)}`;

@Injectable()
export class PaymentsReportsService {
    private readonly logger = new Logger(PaymentsReportsService.name);

    /**
     * The money every app took through Code Implants Pay in one IST date range:
     * totals, one row per app (including apps that took nothing), and a time
     * series per app.
     */
    async summary(input: { from?: string; to?: string }, actorId: string) {
        const range = istRange(input, RANGE_LIMIT);
        const granularity = range.days <= MAX_DAILY_BARS ? 'day' : 'month';
        const qs = instants(range);

        const [apps, byApp, byBucket] = await Promise.all([
            this.get<{ data: PayApp[] }>('/apps', actorId),
            this.get<PaySummary>(`/summary?${qs}&groupBy=app`, actorId),
            this.get<PaySummary>(`/summary?${qs}&groupBy=app,${granularity}`, actorId),
        ]);

        const statsBySlug = new Map(byApp.rows.map((r) => [r.groups.app, r]));
        const appRows = apps.data
            // A suspended app still shows if it took or refunded money in the range.
            .filter((a) => a.status === 'active' || statsBySlug.has(a.slug))
            .map((a) => {
                const stats = statsBySlug.get(a.slug);
                return {
                    slug: a.slug,
                    name: a.name,
                    active: a.status === 'active',
                    // The order apps joined in: the dashboard colours an app by it, so a colour stays with its app.
                    createdAt: a.createdAt,
                    ...toCounts(stats),
                    payers: stats?.payers ?? 0,
                    // Payments started in the range that failed: declined, or rejected by PhonePe.
                    failed: stats?.intentsFailed ?? 0,
                };
            })
            .sort((x, y) => y.received - x.received || y.net - x.net || x.name.localeCompare(y.name));

        const buckets = istBuckets(range, granularity);
        const series = new Map(buckets.map((b) => [b, { bucket: b, total: { ...ZERO }, bySlug: {} as Record<string, PaymentCounts> }]));
        for (const r of byBucket.rows) {
            const point = series.get(r.groups[granularity]);
            if (!point) continue;
            const counts = toCounts(r);
            point.bySlug[r.groups.app] = counts;
            point.total = addCounts(point.total, counts);
        }

        return {
            range: { from: range.from, to: range.to, days: range.days, timezone: 'Asia/Kolkata', granularity },
            // dev and preprod read the PhonePe sandbox, where no real money moves;
            // the dashboard says so rather than passing test payments off as real.
            environment: process.env.NODE_ENV ?? 'unknown',
            currency: 'INR',
            unit: 'paise',
            totals: {
                ...toCounts(byApp.totals),
                // Each app has its own user ids, so someone who paid in two apps counts once in each.
                payers: byApp.totals.payers,
                failed: appRows.reduce((n, a) => n + a.failed, 0),
                appsWithPayments: appRows.filter((a) => a.payments > 0).length,
            },
            apps: appRows,
            series: [...series.values()],
        };
    }

    /**
     * One app's paying customers, most money first. A customer is the app's own
     * user id (customerRef); payments never holds names, phones or emails.
     */
    async appCustomers(slug: string, input: { from?: string; to?: string; limit?: string }, actorId: string) {
        if (!SLUG.test(slug)) throw new BadRequestException('Unknown app');
        const range = istRange(input, RANGE_LIMIT);
        const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
        const res = await this.get<PayCustomers>(
            `/customers?${instants(range)}&app=${encodeURIComponent(slug)}&limit=${limit}`,
            actorId,
        );
        return {
            app: slug,
            range: { from: range.from, to: range.to, timezone: 'Asia/Kolkata' },
            currency: 'INR',
            unit: 'paise',
            customers: res.data.map((c) => ({
                // The app's id for the person; null groups the payments the app sent without one.
                customerRef: c.customerRef,
                received: c.captured,
                refunded: c.refunded,
                net: c.net,
                payments: c.captureCount,
                refunds: c.refundCount,
                firstPaidAt: c.firstPaidAt,
                lastPaidAt: c.lastPaidAt,
            })),
            hasMore: res.hasMore,
        };
    }

    // ---------------------------------------------------------------------

    private async get<T>(path: string, actorId: string): Promise<T> {
        const base = process.env.PAYMENTS_ADMIN_URL?.trim().replace(/\/+$/, '');
        const key = process.env.PAYMENTS_OPS_KEY?.trim();
        if (!base || !key) {
            throw new ServiceUnavailableException(
                'Payment reports are not set up on this server (PAYMENTS_ADMIN_URL / PAYMENTS_OPS_KEY)',
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
            this.logger.error(`Payments admin API unreachable for ${path.split('?')[0]}: ${String(error)}`);
            throw new BadGatewayException('Payments is not reachable right now');
        }

        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
            // Payments' errors are { error: { type, code, message, requestId } }.
            const error = (body as { error?: { message?: unknown } } | null)?.error;
            const message = typeof error?.message === 'string' ? error.message : `HTTP ${res.status}`;
            this.logger.error(`Payments admin API ${path.split('?')[0]} answered ${res.status}: ${message}`);
            if (res.status === 400) throw new BadRequestException(message);
            if (res.status === 404) throw new NotFoundException(message);
            throw new BadGatewayException('Payments could not produce the report');
        }
        return body as T;
    }
}
