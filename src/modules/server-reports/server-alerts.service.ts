import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as nodemailer from 'nodemailer';
import { ServerReportsService, type Flag } from './server-reports.service';
import { INVENTORY } from './server-inventory';

/**
 * Emails the Server tab's critical and warning flags, so nobody has to keep the tab open.
 *
 * Runs in prod only (or with SERVER_ALERTS=on): all three Nexus environments
 * read the same server, and three copies of every alert would teach people to
 * ignore them. A flag must show on two checks in a row (5 minutes apart) before
 * it is sent, so a deploy's restart does not page anyone. While it lasts it is
 * repeated every 6 hours (critical) or 24 hours (warning), and an "all clear"
 * goes out when it ends. Info flags stay on the dashboard.
 *
 * Settings (.env of the prod checkout):
 *   SMTP_URL          e.g. smtps://you%40gmail.com:<app password>@smtp.gmail.com:465
 *   ALERT_EMAIL_TO    comma-separated recipients
 *   ALERT_EMAIL_FROM  optional, defaults to the SMTP user
 *
 * Delivery goes through AlertChannel so mobile push can be added beside email.
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

interface OpenAlert { flag: Flag; firstSeen: string; seen: number; sentAt: string | null }

const INTERVAL_MS = 5 * 60_000;
const REPEAT_MS = { critical: 6 * 3600_000, warning: 24 * 3600_000, info: Infinity };
const STATE = () => process.env.SERVER_ALERT_STATE ?? path.join(os.homedir(), '.nexus', 'server-alerts.json');

/** A flag's identity across checks: the numbers in its title change every minute, the problem does not. */
const keyOf = (f: Flag) => `${f.appId ?? 'server'}|${f.title.replace(/[\d.,]+/g, '#')}`;
const appName = (id?: string) => INVENTORY.find((a) => a.id === id)?.name ?? 'Server';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

@Injectable()
export class ServerAlertsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ServerAlertsService.name);
    private timer: ReturnType<typeof setInterval> | null = null;
    private channels: AlertChannel[] = [];

    constructor(private readonly reports: ServerReportsService) { }

    onModuleInit() {
        const on = process.env.SERVER_ALERTS ? process.env.SERVER_ALERTS === 'on' : process.env.NODE_ENV === 'prod';
        if (!on) return;
        this.channels = this.buildChannels();
        if (!this.channels.length) {
            // One loud line at start, not a silent gap: the dashboard still works, but nobody is told.
            this.logger.error('Server alerts are on but no channel is configured: set SMTP_URL and ALERT_EMAIL_TO.');
            return;
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
        return out;
    }

    /** Sends one email through every channel; the dashboard's "Send test alert" button. */
    async test() {
        const channels = this.channels.length ? this.channels : this.buildChannels();
        if (!channels.length) return { sent: false, reason: 'Set SMTP_URL and ALERT_EMAIL_TO in this environment\'s .env' };
        await this.deliver(channels, 'Nexus server alerts are working', 'This is a test. Real alerts arrive when something on the VPS needs attention.', '<p>This is a test. Real alerts arrive when something on the VPS needs attention.</p>');
        return { sent: true, to: process.env.ALERT_EMAIL_TO };
    }

    async run() {
        let flags: Flag[];
        try {
            flags = (await this.reports.overview()).flags;
        } catch (e) {
            // The collector itself failing is the alert.
            flags = [{ level: 'critical', title: 'Server numbers are unavailable.', why: `${(e as Error).message}` }];
        }
        const actionable = flags.filter((f) => f.level !== 'info');
        const state = await this.load();
        const now = Date.now();
        const current = new Map(actionable.map((f) => [keyOf(f), f]));
        const toSend: Flag[] = [];
        const resolved: Flag[] = [];

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
                ? `${crit ? '🔴' : '🟠'} VPS: ${toSend.length} issue${toSend.length > 1 ? 's' : ''} — ${toSend[0].appId ? appName(toSend[0].appId) + ': ' : ''}${toSend[0].title}`
                : `✅ VPS: ${resolved.length} issue${resolved.length > 1 ? 's' : ''} resolved`;
            const line = (f: Flag) => `[${f.level.toUpperCase()}] ${appName(f.appId)} — ${f.title}\n   ${f.why}`;
            const text = [
                ...(toSend.length ? ['Needs attention:', ...toSend.map(line), ''] : []),
                ...(resolved.length ? ['Resolved:', ...resolved.map((f) => `${appName(f.appId)} — ${f.title}`), ''] : []),
                'Details: Nexus → Dashboard → All apps → Server',
            ].join('\n');
            const row = (f: Flag) =>
                `<tr><td style="padding:6px 10px;color:${f.level === 'critical' ? '#991B1B' : '#92400E'};font-weight:600">${f.level}</td><td style="padding:6px 10px"><b>${esc(appName(f.appId))}</b> — ${esc(f.title)}<br><span style="color:#475569">${esc(f.why)}</span></td></tr>`;
            const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#0F172A">` +
                (toSend.length ? `<h3 style="margin:0 0 8px">Needs attention</h3><table style="border-collapse:collapse">${toSend.map(row).join('')}</table>` : '') +
                (resolved.length ? `<h3 style="margin:16px 0 8px">Resolved</h3><ul>${resolved.map((f) => `<li>${esc(appName(f.appId))} — ${esc(f.title)}</li>`).join('')}</ul>` : '') +
                `<p style="color:#475569">Details: Nexus → Dashboard → All apps → Server</p></div>`;
            await this.deliver(this.channels, subject, text, html);
        }
        await this.save(state);
    }

    private async deliver(channels: AlertChannel[], subject: string, text: string, html: string) {
        for (const c of channels) {
            try {
                await c.send(subject, text, html);
            } catch (e) {
                this.logger.error(`Alert via ${c.name} failed: ${(e as Error).message}`);
            }
        }
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
