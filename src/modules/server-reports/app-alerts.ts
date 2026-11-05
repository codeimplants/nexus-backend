import { Injectable } from '@nestjs/common';
import { PaymentsReportsService } from '../payments-reports/payments-reports.service';
import { MessagingReportsService } from '../messaging-reports/messaging-reports.service';
import type { Flag } from './server-reports.service';

/**
 * Payment and OTP problems, raised through the same alerts as the Server tab (email + push).
 *
 * Payments and messaging only report totals per IST day. A day total stays high
 * long after a problem is fixed, so each check is compared with the totals from
 * about an hour earlier and only that hour counts. Until an hour of history
 * exists (after a restart), only "cannot reach payments/messaging" is checked.
 *
 * Rules, per app, over the last hour:
 *   payments  ≥ 5 failed and at least half of all attempts failed → warning;
 *             ≥ 5 failed and none succeeded → critical
 *   OTP       ≥ 5 failed and at least 30% of sends failed → warning;
 *             ≥ 5 failed and none sent → critical (people cannot sign in)
 *             ≥ 50 blocked and more blocked than sent → warning (likely abuse)
 *   messaging unreachable → critical (console and app logins depend on it)
 *   payments unreachable → warning
 */

export type AppFlag = Flag & { label: string };

interface Counts { ok: number; failed: number; blocked: number }
interface Sample { at: number; day: string; payments: Record<string, Counts>; otp: Record<string, Counts> }

const WINDOW_MS = 60 * 60_000;
const ACTOR = 'server-alerts';
const MIN_FAILED = 5;

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/** Counts since `old`, or since midnight if the day rolled over in between. */
const since = (now: Counts, old: Counts | undefined, sameDay: boolean): Counts =>
    !old || !sameDay
        ? now
        : { ok: now.ok - old.ok, failed: now.failed - old.failed, blocked: now.blocked - old.blocked };

@Injectable()
export class AppAlerts {
    private samples: Sample[] = [];
    private names = new Map<string, string>();

    constructor(
        private readonly payments: PaymentsReportsService,
        private readonly messaging: MessagingReportsService,
    ) { }

    async flags(): Promise<AppFlag[]> {
        const flags: AppFlag[] = [];
        const day = istToday();
        const range = { from: day, to: day };

        const [pay, otp] = await Promise.allSettled([
            this.payments.summary(range, ACTOR),
            this.messaging.otpSummary(range, ACTOR),
        ]);

        const sample: Sample = { at: Date.now(), day, payments: {}, otp: {} };
        if (pay.status === 'fulfilled') {
            for (const a of pay.value.apps) {
                this.names.set(`pay:${a.slug}`, a.name);
                sample.payments[a.slug] = { ok: a.payments, failed: a.failed, blocked: 0 };
            }
        } else {
            flags.push({ level: 'warning', label: 'Payments', title: 'Payments numbers are unavailable.', why: (pay.reason as Error).message });
        }
        if (otp.status === 'fulfilled') {
            for (const a of otp.value.apps) {
                this.names.set(`otp:${a.slug}`, a.name);
                sample.otp[a.slug] = { ok: a.sent, failed: a.failed, blocked: a.blocked };
            }
        } else {
            flags.push({ level: 'critical', label: 'Messaging', title: 'OTP numbers are unavailable.', why: `${(otp.reason as Error).message}. Console and app logins send codes through messaging.` });
        }

        // The baseline: the newest sample at least an hour old.
        const base = [...this.samples].reverse().find((s) => sample.at - s.at >= WINDOW_MS);
        // Keep a little over an hour, so there is always a baseline once one exists.
        this.samples = [...this.samples.filter((s) => sample.at - s.at <= WINDOW_MS + 15 * 60_000), sample];
        if (!base) return flags;
        const sameDay = base.day === day;

        if (pay.status === 'fulfilled') {
            for (const [slug, now] of Object.entries(sample.payments)) {
                const d = since(now, base.payments[slug], sameDay);
                if (d.failed < MIN_FAILED) continue;
                const label = this.names.get(`pay:${slug}`) ?? slug;
                if (d.ok === 0) {
                    flags.push({ level: 'critical', label, title: `Every payment failed in the last hour (${d.failed}).`, why: 'No payment succeeded. Check PhonePe and the payments service.' });
                } else if (d.failed >= d.ok) {
                    flags.push({ level: 'warning', label, title: `${d.failed} of ${d.failed + d.ok} payments failed in the last hour.`, why: 'More payments are failing than usual: declines, or PhonePe rejecting them.' });
                }
            }
        }

        if (otp.status === 'fulfilled') {
            for (const [slug, now] of Object.entries(sample.otp)) {
                const d = since(now, base.otp[slug], sameDay);
                const label = this.names.get(`otp:${slug}`) ?? slug;
                if (d.failed >= MIN_FAILED && d.ok === 0) {
                    flags.push({ level: 'critical', label, title: `Every OTP SMS failed in the last hour (${d.failed}).`, why: 'People cannot sign in. Check the 2Factor account balance and the messaging service.' });
                } else if (d.failed >= MIN_FAILED && d.failed / (d.failed + d.ok) >= 0.3) {
                    flags.push({ level: 'warning', label, title: `${d.failed} of ${d.failed + d.ok} OTP SMS failed in the last hour.`, why: '2Factor is refusing or not delivering a large share of codes.' });
                }
                if (d.blocked >= 50 && d.blocked > d.ok) {
                    flags.push({ level: 'warning', label, title: `${d.blocked} OTP requests were blocked in the last hour.`, why: 'More codes were blocked by per-number limits than sent: likely someone hammering the login.' });
                }
            }
        }
        return flags;
    }
}
