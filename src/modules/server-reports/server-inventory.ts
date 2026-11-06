/**
 * What runs on the VPS, app by app: the part of the Server tab that cannot be
 * detected. The collector reports raw processes, containers, folders, databases
 * and per-site traffic; these rules say which app each one belongs to.
 *
 * Adding an app to the server? Add it here, or the Server tab lists its
 * processes as unclaimed and its traffic under "Other sites".
 */

export type Env = 'prod' | 'preprod' | 'dev';

export interface InventoryApp {
    id: string;
    name: string;
    stack: string;
    /** Linux account its files and processes live under. */
    account: string;
    /** PM2 process names (in `account`'s PM2) that belong to the app. */
    pm2?: RegExp;
    /** Docker container names. */
    docker?: RegExp;
    /**
     * Command lines of processes run by neither PM2 nor Docker, e.g. a systemd service.
     * Matched only for processes whose command starts with /home/<account>/.
     */
    process?: RegExp;
    /** Folders under /home/<account>/ (names, or name prefixes ending in *). */
    folders: string[];
    /** Database names (Postgres or MongoDB). */
    databases?: RegExp;
    database: string;
    /** Site names nginx serves for it, per environment. The first prod one is its main domain. */
    hosts: Partial<Record<Env, string[]>>;
    /** Checked once a minute; anything other than 2xx means "no working health check" or down. */
    healthPath?: string;
    /** A full URL to check instead, e.g. over loopback when the app keeps its health endpoint off nginx. */
    healthUrl?: string;
    /** Money or logins depend on it: problems are raised a level higher. */
    critical?: boolean;
}

export const INVENTORY: InventoryApp[] = [
    {
        id: 'sonebill', name: 'Sonebill', stack: 'Node · Express', account: 'sanskarpandit',
        pm2: /^sonebill-backend-/, folders: ['sonebill-backend-*'], databases: /sonebill/i, database: 'MongoDB',
        hosts: {
            prod: ['api.sonebill.codeimplants.com', 'api-sonebill.codeimplants.com'],
            preprod: ['preprod.api.sonebill.codeimplants.com'],
            dev: ['dev.api.sonebill.codeimplants.com'],
        },
    },
    {
        id: 'sonetaran', name: 'Sonetaran', stack: 'Node · Express', account: 'sanskarpandit',
        pm2: /^sonetaran-/, folders: ['sonetaran'], databases: /sonetaran/i, database: 'MongoDB',
        hosts: {
            prod: ['api.sonetaran.codeimplants.com'],
            preprod: ['preprod-api.sonetaran.codeimplants.com'],
            dev: ['dev-api.sonetaran.codeimplants.com'],
        },
    },
    {
        id: 'nexus', name: 'Nexus', stack: 'NestJS · Prisma', account: 'sanskarpandit',
        pm2: /^nexus-backend-/, folders: ['nexus-backend-*'], databases: /^nexus_/, database: 'PostgreSQL 16 (shared)',
        critical: true,
        hosts: {
            prod: ['api.nexus.codeimplants.com', 'api-version-control.codeimplants.com', 'api.version.control.codeimplants.com', 'nexus.codeimplants.com'],
            preprod: ['preprod.api.nexus.codeimplants.com'],
            dev: ['dev.api.nexus.codeimplants.com'],
        },
    },
    {
        id: 'payments', name: 'Code Implants Pay', stack: 'NestJS · API + worker', account: 'sanskarpandit',
        pm2: /^payments-/, folders: ['payments'], databases: /^payments_/, database: 'PostgreSQL 16 (shared)',
        critical: true,
        hosts: { prod: ['pay.codeimplants.com'], dev: ['dev.pay.codeimplants.com'] },
    },
    {
        id: 'messaging', name: 'Code Implants Messaging', stack: 'NestJS · API + worker', account: 'sanskarpandit',
        pm2: /^messaging-/, folders: ['messaging'], databases: /^messaging_/, database: 'PostgreSQL 16 (shared)',
        critical: true,
        hosts: { prod: ['msg.codeimplants.com'], dev: ['dev.msg.codeimplants.com'] },
    },
    {
        id: 'goldrate', name: 'Gold Rate', stack: 'Node · Express', account: 'sanskarpandit',
        pm2: /^goldrate-/, folders: ['goldrate'], databases: /gold-?rate/i, database: 'MongoDB',
        hosts: {
            prod: ['api.goldrate.codeimplants.com', 'api-broadcast-info.codeimplants.com'],
            dev: ['dev.api.goldrate.codeimplants.com'],
        },
    },
    {
        id: 'gold-khata-book', name: 'Gold Khata Book', stack: 'Node · Express', account: 'sanskarpandit',
        pm2: /^gold-khata-book-/, folders: ['gold-khata-book'], databases: /khata/i, database: 'MongoDB',
        hosts: { prod: ['api.goldkhatabook.codeimplants.com'], dev: ['dev.api.goldkhatabook.codeimplants.com'] },
    },
    {
        id: 'vajankata', name: 'Vajan Kata', stack: 'Python · Django (Gunicorn)', account: 'sanskarpandit',
        pm2: /^vajankata-/, folders: ['vajankata'], databases: /^vajankata_/, database: 'PostgreSQL 16 (shared)',
        hosts: {
            prod: ['api.vajankata.codeimplants.com', 'vajankata.codeimplants.com'],
            dev: ['dev.api.vajankata.codeimplants.com'],
        },
    },
    {
        // Laravel on FrankenPHP's static binary (no system PHP): API, queue worker, scheduler, Reverb.
        // /health touches the database and the worker heartbeat, so a pass here means sign-in works.
        id: 'feenix', name: 'Feenix', stack: 'PHP · Laravel (FrankenPHP) · API + worker + Reverb', account: 'sanskarpandit',
        pm2: /^feenix-/, folders: ['feenix'], databases: /^feenix_/, database: 'PostgreSQL 16 (shared)',
        critical: true,
        hosts: {
            prod: ['api.feenix.codeimplants.com', 'feenix.codeimplants.com'],
            dev: ['dev.api.feenix.codeimplants.com', 'dev.feenix.codeimplants.com'],
        },
    },
    {
        // .NET 9, self-contained, under systemd (truepayroll-ingestion-{dev,prod}), not PM2.
        // One process serves both the API and the plain-HTTP device port (7300 prod / 7301 dev).
        id: 'truepayroll', name: 'TruePayroll', stack: '.NET 9 · ASP.NET Core (systemd)', account: 'sanskarpandit',
        process: /\/truepayroll\/(dev|prod)\/publish\/TruePayroll\.Ingestion/, folders: ['truepayroll', 'truepayroll-scripts'],
        databases: /^truepayroll_/, database: 'PostgreSQL 16 (shared; dev on the 5433 cluster)',
        critical: true,
        hosts: {
            prod: ['api.truepayroll.codeimplants.com', 'truepayroll.codeimplants.com'],
            dev: ['dev.api.truepayroll.codeimplants.com', 'dev.truepayroll.codeimplants.com'],
        },
    },
    {
        id: 'restobill', name: 'RestoBill', stack: 'Java 21 (Spring) · Docker', account: 'sanskarpandit',
        docker: /^restobill-/, folders: ['restobill'], databases: /^restobill/, database: 'Postgres 16 + Redis (own containers)',
        // Spring's /actuator/health is deliberately not proxied by nginx (restobill-backend deploy/README.md).
        healthUrl: 'http://127.0.0.1:8100/actuator/health',
        hosts: { prod: ['api.restobill.codeimplants.com'], dev: ['dev.api.restobill.codeimplants.com'] },
    },
    {
        id: 'barnefarms', name: 'Barne Farms', stack: 'Node · Docker', account: 'sanskarpandit',
        docker: /^barnefarms-/, folders: ['barnefarms'], databases: /barne/i, database: 'MongoDB',
        hosts: {
            prod: ['api.barnefarms.com', 'barnefarms.com', 'www.barnefarms.com'],
            preprod: ['api-preprod.barnefarms.com', 'preprod.barnefarms.com', 'www.preprod.barnefarms.com'],
            dev: ['api.dev.barnefarms.com', 'dev.barnefarms.com'],
        },
    },
    {
        id: 'panchal-sonar', name: 'Panchal Sonar', stack: 'Node + Python (Uvicorn) transliteration', account: 'aniketpotdar',
        pm2: /^panchalsonar-/, folders: ['panchalsonar-*', 'backups'], databases: /panchal/i, database: 'MongoDB',
        hosts: { prod: ['api.panchalsonar.in'], dev: ['dev.api.panchalsonar.in'] },
    },
];

/** The environment in a process or container name. "preprod" is tested before "prod", which it contains. */
export function envOf(name: string): Env | 'shared' {
    if (/preprod/.test(name)) return 'preprod';
    if (/prod/.test(name)) return 'prod';
    if (/dev/.test(name)) return 'dev';
    return 'shared';
}

/** Processes that are the server's own, not an app's and not unclaimed. */
export const SYSTEM_PROCESS = /^(\/usr\/bin\/)?(mongod|postgres|dockerd|containerd|nginx|systemd|snapd|PM2 v|node .*pm2-logrotate|\/usr\/lib\/|\/usr\/sbin\/|\/sbin\/|sshd|redis)/;
