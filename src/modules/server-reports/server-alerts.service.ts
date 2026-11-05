import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as nodemailer from 'nodemailer';
import { ServerReportsService, type Flag } from './server-reports.service';
import { INVENTORY } from './server-inventory';
import { PushService } from '../push/push.service';
import { AppAlerts, type AppFlag } from './app-alerts';

/**
 * Emails the Server tab's critical and warning flags, so nobody has to keep the tab open.
 * Payment and OTP problems (see AppAlerts) go through the same checks and channels.
 *
 * Runs in prod only (NODE_ENV=prod), with no override, and the test button is
 * refused elsewhere too: all three Nexus environments read the same server, and
 * three copies of every alert would teach people to ignore them. A flag must show on two checks in a row (5 minutes apart) before
 * it is sent, so a deploy's restart does not page anyone. While it lasts it is
 * repeated every 6 hours (critical) or 24 hours (warning), and an "all clear"
 * goes out when it ends. Info flags stay on the dashboard.
 *
 * Settings (.env of the prod checkout):
 *   SMTP_URL          e.g. smtps://you%40gmail.com:<app password>@smtp.gmail.com:465
 *   ALERT_EMAIL_TO    comma-separated recipients
 *   ALERT_EMAIL_FROM  optional, defaults to the SMTP user
 *
 * Push to the Nexus admin app is always on beside email: it reaches every active
 * ADMIN who has signed in on the app (see PushService). Email needs the settings above.
 */

export interface AlertChannel {
    readonly name: string;
    send(subject: string, text: string, html: string): Promise<void>;
}

class EmailChannel implements AlertChannel {
    readonly name = 'email';
    private transport = nodemailer.createTransport(process.env.SMTP_URL!);
    constructor(private to: string, private from: string) { }
    async send(subject: string, text: string, html: string) {
        await this.transport.sendMail({ from: this.from, to: this.to, subject, text, html });
    }
}

/** Push to every ADMIN's phone. The title is the email subject; the body is the first issue's reason. */
class PushChannel implements AlertChannel {
    readonly name = 'push';
    constructor(private push: PushService) { }
    async send(subject: string, text: string) {
        const body = text.split(/\r?\n/).filter((l) => l.trim() && !l.endsWith(':') && !l.startsWith('Details:')).slice(0, 3).join('\n');
        const r = await this.push.sendToAdmins({ title: subject, body: body || subject, data: { screen: 'server' } });
        if (r.errors.length) throw new Error(r.errors.join('; '));
    }
}

type AnyFlag = Flag | AppFlag;
interface OpenAlert { flag: AnyFlag; firstSeen: string; seen: number; sentAt: string | null }

const INTERVAL_MS = 5 * 60_000;
const IS_PROD = () => process.env.NODE_ENV === 'prod';
const REPEAT_MS = { critical: 6 * 3600_000, warning: 24 * 3600_000, info: Infinity };
const STATE = () => process.env.SERVER_ALERT_STATE ?? path.join(os.homedir(), '.nexus', 'server-alerts.json');

/** A flag's identity across checks: the numbers in its title change every minute, the problem does not. */
const keyOf = (f: AnyFlag) => `${'label' in f ? f.label : (f.appId ?? 'server')}|${f.title.replace(/[\d.,]+/g, '#')}`;
const nameOf = (f: AnyFlag) => ('label' in f ? f.label : INVENTORY.find((a) => a.id === f.appId)?.name) ?? 'Server';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

@Injectable()
export class ServerAlertsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ServerAlertsService.name);
    private timer: ReturnType<typeof setInterval> | null = null;
    private channels: AlertChannel[] = [];

    constructor(
        private readonly reports: ServerReportsService,
        private readonly push: PushService,
        private readonly apps: AppAlerts,
    ) { }

    onModuleInit() {
        if (!IS_PROD()) return;
        this.channels = this.buildChannels();
        if (!this.channels.some((c) => c.name === 'email')) {
            // One loud line at start, not a silent gap: the dashboard still works, but nobody is told.
            this.logger.error('Server alert emails are off: set SMTP_URL and ALERT_EMAIL_TO. Push still goes to the admin app.');
        }
        this.timer = setInterval(() => void this.run().catch((e) => this.logger.error(`Alert check failed: ${e}`)), INTERVAL_MS);
        this.timer.unref?.();
        this.logger.log(`Server alerts on: ${this.channels.map((c) => c.name).join(', ')}`);
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
    }

    private buildChannels(): AlertChannel[] {
        const out: AlertChannel[] = [];
        const to = process.env.ALERT_EMAIL_TO;
        if (process.env.SMTP_URL && to) {
            const user = decodeURIComponent(new URL(process.env.SMTP_URL).username);
            out.push(new EmailChannel(to, process.env.ALERT_EMAIL_FROM ?? `Nexus Server <${user}>`));
        }
        // Always added: with nobody signed in on the app it sends to no one, which is not an error.
        out.push(new PushChannel(this.push));
        return out;
    }

    /** Sends one email through every channel; the dashboard's "Send test alert" button. */
    async test() {
        if (!IS_PROD()) return { sent: false, reason: 'Server alerts are sent from prod only. Use the test button on the prod dashboard.' };
        const channels = this.channels.length ? this.channels : this.buildChannels();
        if (!channels.length) return { sent: false, reason: 'Set SMTP_URL and ALERT_EMAIL_TO in this environment\'s .env' };
        const errors = await this.deliver(channels, 'Nexus server alerts are working', 'This is a test. Real alerts arrive when something on the VPS needs attention.', '<p>This is a test. Real alerts arrive when something on the VPS needs attention.</p>');
        // Report the provider's refusal, not "sent": a test that hides a bad password is worse than none.
        if (errors.length) return { sent: false, reason: errors.join('; ') };
        return { sent: true, to: process.env.ALERT_EMAIL_TO ?? null, channels: channels.map((c) => c.name) };
    }

    async run() {
        let flags: AnyFlag[];
        try {
            flags = (await this.reports.overview()).flags;
        } catch (e) {
            // The collector itself failing is the alert.
            flags = [{ level: 'critical', title: 'Server numbers are unavailable.', why: `${(e as Error).message}` }];
        }
        flags = [...flags, ...(await this.apps.flags())];
        const actionable = flags.filter((f) => f.level !== 'info');
        const state = await this.load();
        const now = Date.now();
        const current = new Map(actionable.map((f) => [keyOf(f), f]));
        const toSend: AnyFlag[] = [];
        const resolved: AnyFlag[] = [];

        for (const [key, flag] of current) {
            const open = state[key] ?? { flag, firstSeen: new Date(now).toISOString(), seen: 0, sentAt: null };
            open.flag = flag;
            open.seen += 1;
            const due = open.sentAt === null ? open.seen >= 2 : now - Date.parse(open.sentAt) >= REPEAT_MS[flag.level];
            if (due) {
                toSend.push(flag);
                open.sentAt = new Date(now).toISOString();
            }
            state[key] = open;
        }
        for (const [key, open] of Object.entries(state)) {
            if (current.has(key)) continue;
            if (open.sentAt) resolved.push(open.flag);
            delete state[key];
        }

        if (toSend.length || resolved.length) {
            const crit = toSend.filter((f) => f.level === 'critical').length;
            const subject = toSend.length
                ? `${crit ? '🔴' : '🟠'} Nexus: ${toSend.length} issue${toSend.length > 1 ? 's' : ''} — ${nameOf(toSend[0])}: ${toSend[0].title}`
                : `✅ Nexus: ${resolved.length} issue${resolved.length > 1 ? 's' : ''} resolved`;
            const line = (f: AnyFlag) => `[${f.level.toUpperCase()}] ${nameOf(f)} — ${f.title}\n   ${f.why}`;
            const text = [
                ...(toSend.length ? ['Needs attention:', ...toSend.map(line), ''] : []),
                ...(resolved.length ? ['Resolved:', ...resolved.map((f) => `${nameOf(f)} — ${f.title}`), ''] : []),
                'Details: Nexus → Dashboard → All apps → Server, Payments or Messages',
            ].join('\n');
            const row = (f: AnyFlag) =>
                `<tr><td style="padding:6px 10px;color:${f.level === 'critical' ? '#991B1B' : '#92400E'};font-weight:600">${f.level}</td><td style="padding:6px 10px"><b>${esc(nameOf(f))}</b> — ${esc(f.title)}<br><span style="color:#475569">${esc(f.why)}</span></td></tr>`;
            const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#0F172A">` +
                (toSend.length ? `<h3 style="margin:0 0 8px">Needs attention</h3><table style="border-collapse:collapse">${toSend.map(row).join('')}</table>` : '') +
                (resolved.length ? `<h3 style="margin:16px 0 8px">Resolved</h3><ul>${resolved.map((f) => `<li>${esc(nameOf(f))} — ${esc(f.title)}</li>`).join('')}</ul>` : '') +
                `<p style="color:#475569">Details: Nexus → Dashboard → All apps → Server, Payments or Messages</p></div>`;
            await this.deliver(this.channels, subject, text, html);
        }
        await this.save(state);
    }

    /** Sends through every channel; returns the failures, one line each. */
    private async deliver(channels: AlertChannel[], subject: string, text: string, html: string) {
        const errors: string[] = [];
        for (const c of channels) {
            try {
                await c.send(subject, text, html);
            } catch (e) {
                const msg = (e as Error).message.split(/\r?\n/)[0];
                this.logger.error(`Alert via ${c.name} failed: ${msg}`);
                errors.push(`${c.name}: ${msg}`);
            }
        }
        return errors;
    }

    private async load(): Promise<Record<string, OpenAlert>> {
        try {
            return JSON.parse(await fs.readFile(STATE(), 'utf8'));
        } catch {
            return {};
        }
    }

    private async save(state: Record<string, OpenAlert>) {
        await fs.mkdir(path.dirname(STATE()), { recursive: true });
        await fs.writeFile(STATE(), JSON.stringify(state, null, 1), { mode: 0o600 });
    }
}
