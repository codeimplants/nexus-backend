import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as nodemailer from 'nodemailer';
import { PushService } from '../push/push.service';
import { LedgerService, type LedgerOverview } from './ledger.service';
import { type Day, formatRupees, overdueRemindsToday, renewalRemindsToday, todayIst } from './ledger-math';

/**
 * The Ledger's reminders: renewals coming up, clients who are late, and on the
 * 1st of each month a statement with who pays whom.
 *
 * Billing (plans becoming charges) runs every half hour in every environment;
 * the page also bills on every read, so this only matters for reminders being
 * right when nobody has opened the page.
 *
 * Reminders go out from prod only, like server alerts: dev and preprod hold
 * test data, and a phone buzzing about a made-up renewal teaches people to
 * ignore the real ones. One digest a day, at or after 09:00 IST; the day it
 * last went out is kept in a small state file so a restart does not resend it.
 *
 * When something reminds:
 *   - a renewal 30, 7, 1 and 0 days ahead, then daily once it is overdue;
 *   - a client's oldest unpaid charge on its first day late, then weekly;
 *   - on the 1st: the month's statement (settle up, dues, renewals, gaps).
 * A day with none of these sends nothing.
 *
 * Push goes to every active partner with a linked Nexus account, each with a
 * line about their own settle-up. Email is optional: set LEDGER_EMAIL_TO
 * (comma-separated) beside SMTP_URL in prod's .env.
 */

const IS_PROD = () => process.env.NODE_ENV === 'prod';
const TICK_MS = 30 * 60_000;
const SEND_FROM_HOUR_IST = 9;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const STATE = () => process.env.LEDGER_REMINDER_STATE ?? path.join(os.homedir(), '.nexus', 'ledger-reminders.json');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 24 Nov */
const short = (d: Day) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface LedgerDigest {
    today: Day;
    isMonthly: boolean;
    title: string;
    /** Shared lines, most urgent first. Empty = nothing to send today. */
    lines: string[];
    /** One settle-up line per partner id, for the monthly statement. */
    personal: Record<string, string>;
}

@Injectable()
export class LedgerRemindersService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(LedgerRemindersService.name);
    private timer: ReturnType<typeof setInterval> | null = null;
    private boot: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly ledger: LedgerService,
        private readonly push: PushService,
    ) { }

    onModuleInit() {
        const run = () => void this.tick().catch((e) => this.logger.error(`Ledger reminder check failed: ${e instanceof Error ? e.message : e}`));
        this.timer = setInterval(run, TICK_MS);
        this.timer.unref?.();
        // Shortly after boot rather than during it, so a slow database never delays startup.
        this.boot = setTimeout(run, 60_000);
        this.boot.unref?.();
        if (IS_PROD() && !(process.env.SMTP_URL && process.env.LEDGER_EMAIL_TO)) {
            this.logger.log('Ledger reminders: push only (set LEDGER_EMAIL_TO beside SMTP_URL for email too).');
        }
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
        if (this.boot) clearTimeout(this.boot);
    }

    async tick(now = Date.now()) {
        await this.ledger.billDuePlans(todayIst(now));
        if (!IS_PROD()) return;
        const today = todayIst(now);
        if (new Date(now + IST_OFFSET_MS).getUTCHours() < SEND_FROM_HOUR_IST) return;
        const state = await this.load();
        if (state.lastDay === today) return;

        const digest = await this.build(today);
        if (digest.lines.length) await this.deliver(digest);
        // Saved even if a channel failed: a retry every half hour would turn one
        // bad SMTP password into forty pushes a day. The failure is logged.
        await this.save({ lastDay: today });
    }

    /** What today's reminder says and who it would reach, without sending it. For the page. */
    async preview() {
        const today = todayIst();
        const digest = await this.build(today);
        const overview = await this.ledger.overview(null, undefined, today);
        return {
            ...digest,
            sendsFromThisEnvironment: IS_PROD(),
            pushTo: overview.partners.filter((p) => p.isActive && p.adminId).map((p) => p.name),
            emailTo: process.env.SMTP_URL && process.env.LEDGER_EMAIL_TO ? process.env.LEDGER_EMAIL_TO.split(',').map((s) => s.trim()) : [],
        };
    }

    async build(today: Day): Promise<LedgerDigest> {
        const o: LedgerOverview = await this.ledger.overview(null, undefined, today);
        const isMonthly = today.endsWith('-01');
        const lines: string[] = [];

        const due = o.renewals.filter((r) => r.daysLeft !== null && renewalRemindsToday(r.daysLeft));
        for (const r of due) {
            const amount = r.amountPaise ? `${r.isEstimate ? 'about ' : ''}${formatRupees(r.amountPaise)}` : 'amount not set';
            const when = r.daysLeft! < 0 ? `was due ${-r.daysLeft!} day${r.daysLeft === -1 ? '' : 's'} ago (${short(r.nextRenewal!)})`
                : r.daysLeft === 0 ? 'is due today'
                    : `renews in ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} (${short(r.nextRenewal!)})`;
            const how = r.autoRenew ? `auto-renews${r.paymentMethod ? ` on ${r.paymentMethod}` : ''}: check the card` : `pay by hand${r.defaultPayer ? `, usually ${r.defaultPayer.name}` : ''}`;
            const rebill = r.client ? `, then bill ${r.client.name}` : '';
            lines.push(`${r.name} ${when}: ${amount}, ${how}${rebill}.`);
        }

        const late = o.clients.filter((c) => c.status.outstanding > 0 && (isMonthly || overdueRemindsToday(c.status.daysOverdue)));
        for (const c of late) {
            lines.push(`${c.name} owes ${formatRupees(c.status.outstanding)}${c.status.oldestUnpaid ? `, unpaid since ${short(c.status.oldestUnpaid)}` : ''}.`);
        }

        const personal: Record<string, string> = {};
        if (isMonthly) {
            const monthKey = today.slice(0, 7);
            const thisMonthDues = o.upcomingDues.filter((u) => u.dueDate.startsWith(monthKey));
            const collect = thisMonthDues.reduce((s, u) => s + u.amountPaise, 0);
            const renewing = o.renewals.filter((r) => r.nextRenewal?.startsWith(monthKey));
            lines.push(`This month: ${formatRupees(collect)} to bill across ${new Set(thisMonthDues.map((u) => u.clientId)).size} client(s); ${renewing.length} renewal(s)${renewing.length ? ` (${renewing.map((r) => r.name).join(', ')})` : ''}.`);
            if (o.settleUp.length) {
                lines.push(`Settle up: ${o.settleUp.map((t) => `${t.fromName} pays ${t.toName} ${formatRupees(t.amountPaise)}`).join('; ')}.`);
            } else {
                lines.push('Settle up: everyone is square.');
            }
            for (const p of o.partners.filter((x) => x.isActive)) {
                const pays = o.settleUp.filter((t) => t.fromId === p.id).map((t) => `pay ${t.toName} ${formatRupees(t.amountPaise)}`);
                const gets = o.settleUp.filter((t) => t.toId === p.id).map((t) => `${t.fromName} pays you ${formatRupees(t.amountPaise)}`);
                personal[p.id] = [...pays.map((s) => `You: ${s}`), ...gets].join('; ') || 'You are square with everyone.';
            }
            lines.push(...o.warnings);
        }

        const overdueRenewal = due.find((r) => r.daysLeft! < 0);
        const title = isMonthly ? `Ledger: ${MONTH_NAMES[Number(today.slice(5, 7)) - 1]} statement`
            : overdueRenewal ? `Overdue renewal: ${overdueRenewal.name}`
                : due.length ? `Renewal ${due[0].daysLeft === 0 ? 'due today' : `in ${due[0].daysLeft} day${due[0].daysLeft === 1 ? '' : 's'}`}: ${due[0].name}${due.length > 1 ? ` and ${due.length - 1} more` : ''}`
                    : late.length ? `Payment overdue: ${late.map((c) => c.name).join(', ')}`
                        : 'Ledger';

        return { today, isMonthly, title, lines, personal };
    }

    private async deliver(d: LedgerDigest) {
        const o = await this.ledger.overview(null, undefined, d.today);
        let pushed = 0;
        for (const p of o.partners.filter((x) => x.isActive && x.adminId)) {
            const body = [d.personal[p.id], ...d.lines].filter(Boolean).slice(0, 4).join('\n');
            try {
                const r = await this.push.sendToAdmin(p.adminId!, { title: d.title, body, data: { screen: 'ledger' } });
                pushed += r.sent;
                if (r.errors.length) this.logger.error(`Ledger push to ${p.name} failed: ${r.errors.join('; ')}`);
            } catch (e) {
                this.logger.error(`Ledger push to ${p.name} failed: ${e instanceof Error ? e.message : e}`);
            }
        }

        let emailed = false;
        if (process.env.SMTP_URL && process.env.LEDGER_EMAIL_TO) {
            try {
                const user = decodeURIComponent(new URL(process.env.SMTP_URL).username);
                const from = process.env.ALERT_EMAIL_FROM ?? `Nexus Ledger <${user}>`;
                const text = [d.title, '', ...d.lines.map((l) => `- ${l}`), '', 'Open Nexus > Ledger to record payments.'].join('\n');
                const html = `<h3>${esc(d.title)}</h3><ul>${d.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p>Open Nexus &gt; Ledger to record payments.</p>`;
                await nodemailer.createTransport(process.env.SMTP_URL).sendMail({ from, to: process.env.LEDGER_EMAIL_TO, subject: d.title, text, html });
                emailed = true;
            } catch (e) {
                this.logger.error(`Ledger reminder email failed: ${e instanceof Error ? e.message : e}`);
            }
        }
        this.logger.log(`Ledger reminder "${d.title}": ${pushed} push(es)${emailed ? ', email sent' : ''}.`);
    }

    private async load(): Promise<{ lastDay?: string }> {
        try {
            return JSON.parse(await fs.readFile(STATE(), 'utf8')) as { lastDay?: string };
        } catch {
            return {};
        }
    }

    private async save(state: { lastDay: string }) {
        await fs.mkdir(path.dirname(STATE()), { recursive: true });
        await fs.writeFile(STATE(), JSON.stringify(state));
    }
}
