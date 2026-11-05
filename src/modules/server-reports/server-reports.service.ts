import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import { INVENTORY, SYSTEM_PROCESS, envOf, type Env, type InventoryApp } from './server-inventory';

/**
 * The dashboard's Server tab (All apps → Server).
 *
 * Nexus runs as sanskarpandit and cannot see other accounts' processes or the
 * other databases, so a root cron job (scripts/server-collector) writes what it
 * sees to SERVER_STATS_DIR (default /var/lib/nexus-server). This service reads
 * those files, assigns everything to an app using server-inventory.ts, checks
 * each prod site's health and certificate itself, and explains anything unusual.
 */

const DIR = () => process.env.SERVER_STATS_DIR ?? '/var/lib/nexus-server';
const STALE_AFTER_MS = 5 * 60_000;
const HEALTH_TTL_MS = 60_000;
const CERT_TTL_MS = 6 * 3600_000;
const IST_OFFSET_MS = 330 * 60_000;
const LAT_EDGES = [10, 25, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000];
const MB = 1024 * 1024;

// ------------------------------------------------------------------ collector file shapes

interface Snapshot {
    collectedAt: string;
    system: {
        hostname: string; os: string; cpus: number; uptimeSec: number; load: number[]; cpuPercent: number;
        memTotal: number; memAvailable: number; swapTotal: number; swapFree: number; diskTotal: number; diskFree: number;
    };
    pm2: Array<{ account: string; name: string; pid: number; status: string; restarts: number; unstableRestarts: number; startedAt: number; memory: number; cpu: number; port: string; interpreter?: string; nodeVersion?: string }>;
    docker: Array<{ id?: string; name: string; image: string; state: string; status: string; ports: string; cpu: number; memory: number; memLimit: number }>;
    dockerImagesBytes: number;
    processes: Array<{ pid: number; ppid: number; user: string; rss: number; cpu: number; ageSec: number; cmd: string; container?: string | null }>;
    diskUsage: Record<string, number>;
    diskUsageAt: string;
    databases: Array<{ engine: string; name: string; bytes: number }>;
    trafficLog: boolean;
}

interface HostDay {
    requests: number; status: Record<'2xx' | '3xx' | '4xx' | '5xx' | 'other', number>;
    bytes: number; latencySumMs: number; latency: number[]; hours: number[]; ips: string[];
}
interface TrafficDay { day: string; hosts: Record<string, HostDay> }
interface HistorySample { t: string; load: number; cpu: number; memUsed: number; diskUsed: number; pm2: Record<string, number>; docker: Record<string, number>; restarts?: Record<string, number> }

// ------------------------------------------------------------------ what the dashboard gets

export type Level = 'critical' | 'warning' | 'info';
export interface Flag { level: Level; title: string; why: string; appId?: string }

export interface TrafficCounts {
    requests: number; visitors: number; errors4xx: number; errors5xx: number;
    avgMs: number | null; p95Ms: number | null; bytes: number;
}

const ZERO_TRAFFIC: TrafficCounts = { requests: 0, visitors: 0, errors4xx: 0, errors5xx: 0, avgMs: null, p95Ms: null, bytes: 0 };

/** The IST day `offset` days from today, as YYYY-MM-DD. */
const istDay = (offset = 0) => new Date(Date.now() + IST_OFFSET_MS + offset * 86_400_000).toISOString().slice(0, 10);

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
};

export const fmtBytes = (b: number) =>
    b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= MB ? `${Math.round(b / MB)} MB` : `${Math.round(b / 1024)} KB`;

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

@Injectable()
export class ServerReportsService {
    private readonly logger = new Logger(ServerReportsService.name);
    private health = new Map<string, { at: number; code: number | null; ms: number | null; error?: string }>();
    private certs = new Map<string, { at: number; expiresAt: string | null }>();

    // ================================================================= overview

    async overview() {
        const snap = await this.snapshot();
        const ageMs = Date.now() - Date.parse(snap.collectedAt);
        const [today, yesterday, week, history] = await Promise.all([
            this.trafficDay(istDay(0)),
            this.trafficDay(istDay(-1)),
            Promise.all([-2, -3, -4, -5, -6, -7, -8].map((d) => this.trafficDay(istDay(d)))),
            this.history(26),
        ]);
        const sys = snap.system;
        const memUsed = sys.memTotal - sys.memAvailable;

        // Process tree, so a PM2 app's memory includes its workers (Gunicorn forks, Node children).
        const children = new Map<number, number[]>();
        for (const p of snap.processes) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
        const byPid = new Map(snap.processes.map((p) => [p.pid, p]));
        const claimed = new Set<number>();
        const treeRss = (pid: number) => {
            let total = 0;
            const stack = [pid];
            while (stack.length) {
                const id = stack.pop()!;
                if (claimed.has(id)) continue;
                claimed.add(id);
                total += byPid.get(id)?.rss ?? 0;
                stack.push(...(children.get(id) ?? []));
            }
            return total;
        };
        // Everything under a container runtime belongs to Docker, which reports it per container.
        // Docker reports container memory itself, so processes inside a container are already counted.
        for (const p of snap.processes) if (p.container || /containerd-shim/.test(p.cmd)) treeRss(p.pid);

        const hostOwner = new Map<string, { app: InventoryApp; env: Env }>();
        for (const app of INVENTORY)
            for (const [env, hosts] of Object.entries(app.hosts) as [Env, string[]][])
                for (const h of hosts) hostOwner.set(h, { app, env });

        const health = await this.checkAll();

        const apps = INVENTORY.map((app) => {
            const envs = [
                ...snap.pm2
                    .filter((p) => p.account === app.account && app.pm2?.test(p.name))
                    .map((p) => {
                        const tree = p.pid ? treeRss(p.pid) : 0;
                        return {
                            name: p.name, kind: 'pm2' as const, env: envOf(p.name), port: p.port || null, status: p.status,
                            restarts24h: restartsSince(history, `${p.account}/${p.name}`, p.restarts, Date.now() - 24 * 3600_000),
                            memory: Math.max(tree, p.memory), memLimit: null as number | null, cpu: p.cpu, restarts: p.restarts,
                            uptimeSec: p.startedAt && p.status === 'online' ? Math.round((Date.now() - p.startedAt) / 1000) : 0,
                            runtime: p.nodeVersion ? `Node ${p.nodeVersion}` : p.interpreter ?? null,
                        };
                    }),
                ...snap.docker
                    .filter((c) => app.docker?.test(c.name))
                    .map((c) => ({
                        name: c.name, kind: 'docker' as const, env: envOf(c.name), port: c.ports.match(/:(\d+)->/)?.[1] ?? null,
                        status: c.state === 'running' ? 'online' : c.state, memory: c.memory, memLimit: c.memLimit || null, cpu: c.cpu,
                        restarts: 0, restarts24h: null as number | null, uptimeSec: null as number | null, runtime: c.image,
                    })),
            ].sort((a, b) => b.memory - a.memory);

            const folders = Object.entries(snap.diskUsage)
                .filter(([p]) => {
                    const prefix = `/home/${app.account}/`;
                    if (!p.startsWith(prefix)) return false;
                    const name = p.slice(prefix.length);
                    return app.folders.some((f) => (f.endsWith('*') ? name.startsWith(f.slice(0, -1)) : name === f));
                })
                .map(([p, bytes]) => ({ path: p, bytes }))
                .sort((a, b) => b.bytes - a.bytes);
            const dbs = snap.databases.filter((d) => app.databases?.test(d.name));
            const disk = folders.reduce((n, f) => n + f.bytes, 0) + dbs.reduce((n, d) => n + d.bytes, 0);
            const memory = envs.reduce((n, e) => n + e.memory, 0);

            const prodHosts = app.hosts.prod ?? [];
            const allHosts = Object.values(app.hosts).flat();
            const domain = prodHosts[0];
            const h = domain ? health.get(domain) : undefined;
            const cert = domain ? this.certs.get(domain) : undefined;

            return {
                id: app.id, name: app.name, stack: app.stack, account: app.account, database: app.database, domain,
                runner: [...new Set(envs.map((e) => (e.kind === 'pm2' ? 'PM2' : 'Docker')))].join(' + ') || '—',
                runtimes: [...new Set(envs.map((e) => e.runtime).filter(Boolean))],
                envs, memory, memoryShare: pct(memory, sys.memTotal), disk, folders, databases: dbs,
                health: describeHealth(h),
                cert: cert?.expiresAt ? { expiresAt: cert.expiresAt, days: Math.floor((Date.parse(cert.expiresAt) - Date.now()) / 86_400_000) } : null,
                traffic: {
                    today: sumHosts(today, prodHosts),
                    yesterday: sumHosts(yesterday, prodHosts),
                    yesterdayAllEnvs: sumHosts(yesterday, allHosts),
                    /** Prod requests per day over the 7 days before yesterday, for the spike/drop check. */
                    weekAvg: Math.round(week.reduce((n, d) => n + sumHosts(d, prodHosts).requests, 0) / Math.max(week.filter(Boolean).length, 1)),
                    weekDays: week.filter(Boolean).length,
                    hoursToday: hoursOf(today, prodHosts),
                },
                memoryTrend: memoryTrend(history, app, Date.now() - 24 * 3600_000),
                flags: [] as Flag[],
                critical: !!app.critical,
            };
        });

        // ---- unclaimed and shared
        for (const p of snap.pm2) if (p.pid) treeRss(p.pid); // other accounts' PM2 apps not in the inventory still count as claimed
        const unknownPm2 = snap.pm2.filter((p) => !INVENTORY.some((a) => a.account === p.account && a.pm2?.test(p.name)));
        const unknownDocker = snap.docker.filter((c) => c.state === 'running' && !INVENTORY.some((a) => a.docker?.test(c.name)));
        const stoppedContainers = snap.docker.filter((c) => c.state !== 'running').map((c) => c.name);
        const shared: Array<{ name: string; memory: number }> = [];
        const unclaimed: Array<{ user: string; pid: number; cmd: string; memory: number; ageSec: number }> = [];
        for (const p of snap.processes) {
            if (claimed.has(p.pid)) continue;
            if (SYSTEM_PROCESS.test(p.cmd)) {
                const name = /mongod/.test(p.cmd) ? 'MongoDB' : /postgres/.test(p.cmd) ? 'PostgreSQL' : /PM2|pm2/.test(p.cmd) ? 'PM2 daemons' : /docker|containerd/.test(p.cmd) ? 'Docker engine' : 'System';
                const s = shared.find((x) => x.name === name);
                if (s) s.memory += p.rss; else shared.push({ name, memory: p.rss });
            } else if (p.rss >= 50 * MB) {
                unclaimed.push({ user: p.user, pid: p.pid, cmd: p.cmd.slice(0, 120), memory: p.rss, ageSec: p.ageSec });
            }
        }
        shared.sort((a, b) => b.memory - a.memory);

        // ---- traffic, whole server and per app (prod)
        const totals = { today: sumHosts(today), yesterday: sumHosts(yesterday) };
        const otherHosts = (day: TrafficDay | null) =>
            Object.entries(day?.hosts ?? {})
                .filter(([h]) => !hostOwner.has(h))
                .map(([host, d]) => ({ host, requests: d.requests }))
                .sort((a, b) => b.requests - a.requests)
                .slice(0, 10);

        // ---- flags
        const flags = this.flags({ snap, apps, unclaimed, unknownPm2, unknownDocker, stoppedContainers, ageMs, memUsed, totals });

        return {
            collectedAt: snap.collectedAt,
            stale: ageMs > STALE_AFTER_MS,
            diskUsageAt: snap.diskUsageAt,
            trafficLog: snap.trafficLog,
            system: { ...sys, memUsed, diskUsed: sys.diskTotal - sys.diskFree },
            apps: apps.sort((a, b) => b.memory - a.memory),
            shared,
            dockerImagesBytes: snap.dockerImagesBytes,
            unclaimed: unclaimed.sort((a, b) => b.memory - a.memory),
            unknown: { pm2: unknownPm2.map((p) => `${p.account}/${p.name}`), docker: unknownDocker.map((c) => c.name), stopped: stoppedContainers },
            idleAccounts: await this.idleAccounts(snap),
            traffic: { ...totals, otherToday: otherHosts(today), otherYesterday: otherHosts(yesterday) },
            flags,
        };
    }

    // ================================================================= the "out of the ordinary" rules

    private flags(input: {
        snap: Snapshot; apps: any[]; unclaimed: any[]; unknownPm2: any[]; unknownDocker: any[]; stoppedContainers: string[];
        ageMs: number; memUsed: number; totals: { today: TrafficCounts; yesterday: TrafficCounts };
    }): Flag[] {
        const { snap, apps, unclaimed, unknownPm2, unknownDocker, stoppedContainers, ageMs, memUsed, totals } = input;
        const sys = snap.system;
        const out: Flag[] = [];
        const add = (f: Flag) => out.push(f);
        const up = (l: Level, critical: boolean): Level => (critical && l === 'warning' ? 'critical' : l);

        // ---- server
        if (ageMs > STALE_AFTER_MS)
            add({ level: 'critical', title: 'Server numbers are out of date.', why: `The collector last ran ${Math.round(ageMs / 60_000)} minutes ago. Check /var/log/nexus-collect.log and the cron job.` });
        if (!snap.trafficLog)
            add({ level: 'warning', title: 'Traffic per app is not being recorded.', why: '/var/log/nginx/traffic.log is missing. Re-run scripts/server-collector/install.sh.' });
        const memPct = pct(memUsed, sys.memTotal);
        if (memPct >= 85) add({ level: 'critical', title: `Memory is ${memPct}% used.`, why: 'Close to the point where Linux starts killing processes. See which apps below use the most.' });
        else if (memPct >= 70) add({ level: 'warning', title: `Memory is ${memPct}% used.`, why: 'Leaves little room for a traffic spike or a new app.' });
        if (sys.swapTotal === 0)
            add({ level: memPct >= 60 ? 'warning' : 'info', title: 'No swap.', why: 'If memory runs out, Linux kills a process without warning. 2–4 GB of swap is cheap insurance.' });
        const diskPct = pct(sys.diskTotal - sys.diskFree, sys.diskTotal);
        if (diskPct >= 80) add({ level: diskPct >= 90 ? 'critical' : 'warning', title: `Disk is ${diskPct}% full.`, why: 'Apps and databases fail to write when it fills. See the largest folders below.' });
        if (sys.load[2] > sys.cpus) add({ level: 'warning', title: 'CPU is overloaded.', why: `15-minute load ${sys.load[2].toFixed(2)} is above the ${sys.cpus} cores.` });
        const unclaimedMem = unclaimed.reduce((n, p) => n + p.memory, 0);
        if (unclaimed.length)
            add({ level: 'warning', title: `${unclaimed.length} processes belong to no app (${fmtBytes(unclaimedMem)}).`, why: unclaimed.slice(0, 3).map((p) => `${p.user}: ${p.cmd.slice(0, 50)}`).join(' · ') + '. Old services left running, or an app missing from the inventory.' });
        if (unknownPm2.length || unknownDocker.length)
            add({ level: 'info', title: 'Processes not in the inventory.', why: [...unknownPm2.map((p) => `${p.account}/${p.name}`), ...unknownDocker.map((c) => c.name)].join(', ') + '. Add them to server-inventory.ts.' });
        if (stoppedContainers.length)
            add({ level: 'info', title: `${stoppedContainers.length} stopped Docker containers are lying around.`, why: `${stoppedContainers.join(', ')}. They hold disk but do nothing; remove them with docker rm if nobody needs them.` });
        const t = totals.yesterday;
        if (t.requests > 100 && t.errors5xx / t.requests > 0.01)
            add({ level: 'warning', title: `${pct(t.errors5xx, t.requests)}% of yesterday's requests failed with a server error.`, why: 'Look at the apps below with the most 5xx.' });

        // ---- apps, compared to each other
        const running = apps.filter((a) => a.memory > 0);
        const medMem = median(running.map((a) => a.memory));
        const medDisk = median(apps.map((a) => a.disk).filter((d) => d > 0));
        const medHealth = median(apps.map((a) => a.health.ms).filter((m): m is number => m !== null));
        const heaviest = [...running].sort((a, b) => b.memory - a.memory)[0];

        for (const a of apps) {
            const f = (x: Omit<Flag, 'appId'>) => a.flags.push({ ...x, appId: a.id });
            const top = a.envs[0];

            if (!a.envs.length) {
                f({ level: up('warning', a.critical), title: 'Nothing running.', why: `No PM2 process or container matches ${a.name}. Stopped, renamed, or moved account.` });
            }
            for (const e of a.envs) {
                if (e.status !== 'online')
                    f({ level: up(e.env === 'prod' ? 'critical' : 'warning', false), title: `${e.name} is ${e.status}.`, why: e.env === 'prod' ? 'The live app is not running.' : 'A test environment is not running.' });
            }

            // Heavy on memory: explain what makes it heavy.
            if (a.memory > 0 && (a.memoryShare >= 15 || (medMem > 0 && a.memory >= 2.5 * medMem))) {
                const share = pct(top.memory, a.memory);
                f({
                    level: a.memoryShare >= 25 ? 'critical' : 'warning',
                    title: `${a === heaviest ? 'Heaviest app' : 'Heavy'}: ${fmtBytes(a.memory)}, ${a.memoryShare}% of the server's memory.`,
                    why: `${(a.memory / Math.max(medMem, 1)).toFixed(1)}× a typical app here (${fmtBytes(medMem)}). ` +
                        (share >= 60 ? `Most of it is one process: ${top.name} holds ${fmtBytes(top.memory)} (${share}%).` : `Spread over ${a.envs.length} processes; the largest is ${top.name} at ${fmtBytes(top.memory)}.`),
                });
            }
            // Memory creeping up.
            const tr = a.memoryTrend;
            if (tr && tr.now - tr.then > 100 * MB && tr.now > tr.then * 1.3)
                f({ level: 'warning', title: `Memory up ${pct(tr.now - tr.then, tr.then)}% in 24 hours.`, why: `${fmtBytes(tr.then)} → ${fmtBytes(tr.now)}. Steady growth without a matching rise in traffic usually means a memory leak.` });
            // Containers close to their cap get killed at it.
            for (const e of a.envs)
                if (e.memLimit && e.memory / e.memLimit >= 0.85)
                    f({ level: 'warning', title: `${e.name} is at ${pct(e.memory, e.memLimit)}% of its memory cap.`, why: `Docker kills it at ${fmtBytes(e.memLimit)}.` });
            // Test environments heavier than prod.
            const prodMem = a.envs.filter((e: any) => e.env === 'prod').reduce((n: number, e: any) => n + e.memory, 0);
            const heavyTest = a.envs.filter((e: any) => (e.env === 'dev' || e.env === 'preprod') && e.memory > prodMem * 1.2 && e.memory > 150 * MB);
            if (prodMem > 0 && heavyTest.length)
                f({ level: 'info', title: `${heavyTest.map((e: any) => e.name).join(' and ')} uses more memory than prod.`, why: `${heavyTest.map((e: any) => fmtBytes(e.memory)).join(', ')} against ${fmtBytes(prodMem)} for prod, which takes the real traffic. Often a leak or debug mode left on.` });

            // Restart loops.
            for (const e of a.envs) {
                // PM2's restart count never resets and includes deploys, so only recent restarts mean anything.
                if (e.restarts24h !== null && e.restarts24h >= 5)
                    f({ level: up(e.env === 'prod' ? 'warning' : 'info', a.critical && e.env === 'prod'), title: `${e.name} restarted ${e.restarts24h} times in 24 hours.`, why: 'More than deploys explain. Usually a crash that PM2 keeps bringing back; its error log will say why.' });
                else if (e.uptimeSec !== null && e.uptimeSec < 600 && e.restarts > 3)
                    f({ level: 'warning', title: `${e.name} restarted in the last 10 minutes.`, why: `${e.restarts} restarts so far. Watch whether it settles.` });
            }

            // Disk.
            if (a.disk > 5 * 1024 ** 3 || (medDisk > 0 && a.disk >= 4 * medDisk && a.disk > 1024 ** 3)) {
                const big = a.folders[0];
                f({ level: 'warning', title: `Large on disk: ${fmtBytes(a.disk)}.`, why: `${(a.disk / Math.max(medDisk, 1)).toFixed(1)}× a typical app.` + (big ? ` The biggest folder is ${big.path} (${fmtBytes(big.bytes)}).` : '') });
            }

            // Health and certificates.
            const h = a.health;
            if (h.state === 'down') f({ level: up('critical', a.critical), title: 'Prod is not responding.', why: `Its health check: ${h.detail}.` });
            else if (h.state === 'unchecked') f({ level: 'info', title: 'No working health check.', why: `Its health check answers ${h.code}, so the dashboard can only tell that the site is reachable. Add a public /health.` });
            else if (h.ms !== null && h.ms > 300 && h.ms > 3 * medHealth) f({ level: 'info', title: `Slow health check: ${h.ms} ms.`, why: `${(h.ms / Math.max(medHealth, 1)).toFixed(0)}× slower than a typical app here (${medHealth} ms). It may be doing real work on every check.` });
            if (a.cert && a.cert.days <= 14)
                f({ level: a.cert.days <= 7 ? 'critical' : 'warning', title: `SSL certificate expires in ${a.cert.days} days.`, why: 'Certbot normally renews at 30 days left, so it has failed. Run certbot renew.' });

            // Traffic: errors, spikes and drops (prod).
            const y = a.traffic.yesterday;
            if (y.requests >= 50 && y.errors5xx / y.requests > 0.02)
                f({ level: up('warning', a.critical), title: `${pct(y.errors5xx, y.requests)}% server errors yesterday.`, why: `${y.errors5xx} of ${y.requests} prod requests failed with 5xx.` });
            if (a.traffic.weekDays >= 3 && a.traffic.weekAvg >= 100) {
                const ratio = y.requests / a.traffic.weekAvg;
                if (ratio >= 3) f({ level: 'info', title: `Traffic spike: ${ratio.toFixed(1)}× normal.`, why: `${y.requests} requests yesterday against a ${a.traffic.weekAvg}/day average. A launch, a campaign, or a bot.` });
                if (ratio <= 0.3) f({ level: 'warning', title: `Traffic dropped to ${Math.round(ratio * 100)}% of normal.`, why: `${y.requests} requests yesterday against a ${a.traffic.weekAvg}/day average. Apps may be failing to reach it.` });
            }
            if (y.p95Ms !== null && y.requests >= 50 && y.p95Ms >= 1000)
                f({ level: 'info', title: `Slow for some users: 95% of requests under ${y.p95Ms} ms.`, why: 'One request in twenty took longer than that yesterday.' });
        }

        for (const a of apps) out.push(...a.flags);
        const order: Record<Level, number> = { critical: 0, warning: 1, info: 2 };
        return out.sort((x, y) => order[x.level] - order[y.level]);
    }

    // ================================================================= series

    /** Requests per IST day, whole server and per app (prod only). */
    async traffic(daysParam?: string) {
        const days = Math.min(Math.max(Number(daysParam) || 14, 1), 90);
        const list = await Promise.all(Array.from({ length: days }, (_, i) => istDay(i - days + 1)).map(async (day) => ({ day, data: await this.trafficDay(day) })));
        return {
            days: list.map(({ day, data }) => ({
                day,
                total: sumHosts(data).requests,
                byApp: Object.fromEntries(INVENTORY.map((a) => [a.id, sumHosts(data, a.hosts.prod ?? []).requests])),
            })),
            apps: INVENTORY.map((a) => ({ id: a.id, name: a.name })),
        };
    }

    /** One app's memory every 10 minutes. */
    async appHistory(id: string, hoursParam?: string) {
        const app = INVENTORY.find((a) => a.id === id);
        if (!app) throw new NotFoundException('Unknown app');
        const hours = Math.min(Math.max(Number(hoursParam) || 168, 1), 24 * 90);
        const since = Date.now() - hours * 3600_000;
        const samples = (await this.history(hours)).filter((s) => Date.parse(s.t) >= since);
        return { app: id, points: samples.map((s) => ({ t: s.t, memory: appMemoryIn(s, app) })) };
    }

    // ================================================================= reading files

    private async snapshot(): Promise<Snapshot> {
        try {
            return JSON.parse(await fs.readFile(path.join(DIR(), 'snapshot.json'), 'utf8'));
        } catch (e) {
            this.logger.warn(`Server snapshot unreadable: ${(e as Error).message}`);
            throw new ServiceUnavailableException('The server collector has not run yet. Install it with scripts/server-collector/install.sh.');
        }
    }

    private async trafficDay(day: string): Promise<TrafficDay | null> {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BadRequestException('Bad day');
        try {
            return JSON.parse(await fs.readFile(path.join(DIR(), 'traffic', `${day}.json`), 'utf8'));
        } catch {
            return null;
        }
    }

    private async history(hours: number): Promise<HistorySample[]> {
        const days = Math.ceil(hours / 24) + 1;
        const out: HistorySample[] = [];
        for (let i = -days + 1; i <= 0; i++) {
            try {
                const text = await fs.readFile(path.join(DIR(), 'history', `${istDay(i)}.jsonl`), 'utf8');
                for (const line of text.split('\n')) if (line) out.push(JSON.parse(line));
            } catch { /* no samples that day */ }
        }
        return out;
    }

    private async idleAccounts(snap: Snapshot) {
        try {
            const users = await fs.readdir('/home');
            const busy = new Set([...snap.pm2.map((p) => p.account), ...snap.processes.map((p) => p.user)]);
            return users.filter((u) => !busy.has(u));
        } catch {
            return [];
        }
    }

    // ================================================================= health and certificates

    private async checkAll() {
        const domains = INVENTORY.map((a) => ({ host: a.hosts.prod?.[0], url: a.healthUrl ?? `https://${a.hosts.prod?.[0]}${a.healthPath ?? '/health'}` })).filter((d) => d.host) as { host: string; url: string }[];
        // Health one at a time, so the timings are not inflated by a dozen handshakes at once; certificates in parallel after.
        for (const d of domains) await this.check(d.host, d.url);
        await Promise.all(domains.map((d) => this.cert(d.host)));
        return this.health;
    }

    private async check(host: string, url: string) {
        const cached = this.health.get(host);
        if (cached && Date.now() - cached.at < HEALTH_TTL_MS) return;
        const start = Date.now();
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
            await res.arrayBuffer();
            this.health.set(host, { at: Date.now(), code: res.status, ms: Date.now() - start });
        } catch (e) {
            this.health.set(host, { at: Date.now(), code: null, ms: null, error: (e as Error).name === 'TimeoutError' ? 'no answer in 8 s' : (e as Error).message });
        }
    }

    private cert(host: string): Promise<void> {
        const cached = this.certs.get(host);
        if (cached && Date.now() - cached.at < CERT_TTL_MS) return Promise.resolve();
        return new Promise((resolve) => {
            const done = (expiresAt: string | null) => { this.certs.set(host, { at: Date.now(), expiresAt }); resolve(); };
            const socket = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
                const c = socket.getPeerCertificate();
                socket.end();
                done(c?.valid_to ? new Date(c.valid_to).toISOString() : null);
            });
            socket.on('error', () => done(null));
            socket.on('timeout', () => { socket.destroy(); done(null); });
        });
    }
}

// ------------------------------------------------------------------ helpers

function describeHealth(h?: { code: number | null; ms: number | null; error?: string }) {
    if (!h) return { state: 'unknown' as const, code: null, ms: null, detail: 'not checked' };
    if (h.code === null) return { state: 'down' as const, code: null, ms: null, detail: h.error ?? 'no answer' };
    if (h.code >= 500) return { state: 'down' as const, code: h.code, ms: h.ms, detail: `answered ${h.code}` };
    if (h.code >= 200 && h.code < 300) return { state: 'healthy' as const, code: h.code, ms: h.ms, detail: 'healthy' };
    return { state: 'unchecked' as const, code: h.code, ms: h.ms, detail: `answered ${h.code}` };
}

function sumHosts(day: TrafficDay | null, hosts?: string[]): TrafficCounts {
    if (!day) return { ...ZERO_TRAFFIC };
    const entries = Object.entries(day.hosts).filter(([h]) => !hosts || hosts.includes(h)).map(([, d]) => d);
    if (!entries.length) return { ...ZERO_TRAFFIC };
    const requests = entries.reduce((n, d) => n + d.requests, 0);
    const lat = LAT_EDGES.map((_, i) => entries.reduce((n, d) => n + (d.latency[i] ?? 0), 0));
    lat.push(entries.reduce((n, d) => n + (d.latency[LAT_EDGES.length] ?? 0), 0));
    let seen = 0;
    let p95: number | null = null;
    for (let i = 0; i < lat.length; i++) {
        seen += lat[i];
        if (seen >= requests * 0.95) { p95 = LAT_EDGES[i] ?? LAT_EDGES[LAT_EDGES.length - 1] * 2; break; }
    }
    const ips = new Set<string>();
    for (const d of entries) for (const ip of d.ips) ips.add(ip);
    return {
        requests,
        visitors: ips.size,
        errors4xx: entries.reduce((n, d) => n + d.status['4xx'], 0),
        errors5xx: entries.reduce((n, d) => n + d.status['5xx'], 0),
        avgMs: requests ? Math.round(entries.reduce((n, d) => n + d.latencySumMs, 0) / requests) : null,
        p95Ms: requests ? p95 : null,
        bytes: entries.reduce((n, d) => n + d.bytes, 0),
    };
}

function hoursOf(day: TrafficDay | null, hosts: string[]) {
    const out = new Array(24).fill(0);
    for (const h of hosts) day?.hosts[h]?.hours.forEach((n, i) => (out[i] += n));
    return out;
}

function appMemoryIn(s: HistorySample, app: InventoryApp) {
    let total = 0;
    for (const [key, mem] of Object.entries(s.pm2 ?? {})) {
        const [account, name] = key.split('/');
        if (account === app.account && app.pm2?.test(name)) total += mem;
    }
    for (const [name, mem] of Object.entries(s.docker ?? {})) if (app.docker?.test(name)) total += mem;
    return total;
}

/** Restarts since `at`: today's count minus the count in the oldest sample after it, or null without that history. */
function restartsSince(history: HistorySample[], key: string, now: number, at: number) {
    const then = history.find((s) => Date.parse(s.t) >= at && s.restarts?.[key] !== undefined);
    if (!then || Date.parse(then.t) > at + 3 * 3600_000) return null;
    return Math.max(now - then.restarts![key], 0);
}

/** The app's memory in the sample nearest to `at` and in the latest sample, measured the same way, or null without a day of history. */
function memoryTrend(history: HistorySample[], app: InventoryApp, at: number) {
    if (!history.length || Date.parse(history[0].t) > at + 3600_000) return null;
    let best = history[0];
    for (const s of history) if (Math.abs(Date.parse(s.t) - at) < Math.abs(Date.parse(best.t) - at)) best = s;
    const then = appMemoryIn(best, app);
    const now = appMemoryIn(history[history.length - 1], app);
    return then > 0 && now > 0 ? { then, now } : null;
}
