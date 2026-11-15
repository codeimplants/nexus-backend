/**
 * The Platform Hardening register's reference rows, from the 2026-11-15
 * infrastructure audit of the shared VPS (31.97.61.191) and all ~20 repos.
 *
 * WHY THIS IS CODE AND NOT A MIGRATION
 * Seeding happens in `HardeningSeedService` with
 * `upsert({ where: { key }, update: {}, create: ... })`. `update: {}` is the
 * load-bearing part: an item already in the database is left exactly as it is,
 * so a status, owner or note the team changed in the UI is never overwritten by
 * the next deploy. Adding an item means appending to this array. Changing the
 * *wording* of an item already shipped will NOT take effect — edit it in the UI,
 * or the register would fight the team for ownership of its own contents.
 *
 * WHY `aiBrief` MATTERS MOST
 * Each row carries a brief written to be pasted straight into a teammate's own
 * AI coding session. It has to stand alone: name the hosts, repos, scripts and
 * commands, state what done looks like, and say what must not break. A brief
 * that assumes the reader sat through the audit is useless, which is the whole
 * failure mode this register exists to avoid.
 *
 * Severity is about what it costs us with paying customers, not how hard it is
 * to fix.
 */

/** Shape of a seed row. Mirrors the writable fields of HardeningItem. */
export interface HardeningSeedRow {
    key: string;
    title: string;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    status: 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE';
    category:
    | 'INFRA'
    | 'SECURITY'
    | 'DATA'
    | 'CI_CD'
    | 'OBSERVABILITY'
    | 'COMPLIANCE'
    | 'PROCESS';
    gap: string;
    risk: string;
    aiBrief: string;
    scope?: string;
    evidence?: string;
    sortOrder: number;
    owner?: string;
    notes?: string;
    completedAt?: Date;
    completedBy?: string;
}

const AUDIT_DATE = new Date('2026-11-15T07:00:00.000Z');

export const HARDENING_SEED: HardeningSeedRow[] = [
    // ---------------------------------------------------------------- CRITICAL
    {
        key: 'external-uptime-monitoring',
        title: 'Nothing outside the VPS notices when the VPS dies',
        severity: 'CRITICAL',
        status: 'IN_PROGRESS',
        category: 'OBSERVABILITY',
        scope: 'whole VPS, all apps',
        gap:
            'The only alerting is the Nexus server collector, which runs as a root cron job ON the VPS and ' +
            'emails through msmtp FROM the same VPS. If the box, its network or nginx dies, no alert is ' +
            'produced at all. There is no outbound heartbeat and no external HTTP monitor.',
        risk:
            'A paying customer is the monitoring. The first real outage is discovered by the person paying ' +
            'for uptime, which forfeits any credibility on an SLA conversation and is the single cheapest ' +
            'gap on this list to close.',
        evidence:
            'crontab has no curl/healthcheck entry; /etc/cron.d/nexus-server runs the collector locally; ' +
            'ALERT_EMAIL_TO is delivered by /etc/msmtprc on the same host.',
        aiBrief:
            'Finish the external monitoring for the Code Implants VPS (ssh alias hostinger-vps, user ' +
            'sanskarpandit).\n\n' +
            'Already done, do not redo: ~/bin/heartbeat.sh is installed and a cron entry runs it every 5 ' +
            'minutes. It reads HEARTBEAT_URL from ~/.config/heartbeat.env, pings the URL when healthy, and ' +
            'pings <URL>/fail when nginx is down, a PM2 process is not online, a container has crashed, ' +
            'either Postgres (5432/5433) is unreachable, disk is over 90% or free memory is under 500 MB. ' +
            'Without that config file it exits 0 quietly.\n\n' +
            'To do:\n' +
            '1. A Healthchecks.io check named vps-heartbeat, period 5m, grace 15m. Write its ping URL into ' +
            '~/.config/heartbeat.env as HEARTBEAT_URL=... and chmod 600 that file.\n' +
            '2. Prove it: run ~/bin/heartbeat.sh by hand, confirm the ping lands, then deliberately trip a ' +
            'failure and confirm the alert email actually arrives. An untested alert is not an alert.\n' +
            '3. Have each nightly backup script ping its own Healthchecks URL on success, so a backup that ' +
            'silently stops running is noticed. Backup scripts are in ~/bin/*-backup.sh plus ' +
            '~/payments/prod/scripts/backup-db.sh and ~/messaging/prod/scripts/backup-db.sh.\n' +
            '4. UptimeRobot (free, 50 monitors) on the prod hostnames listed in ~/bin/ci-health-check.sh, ' +
            'keyword monitors where an app returns 200 on its own error page.\n\n' +
            'Done looks like: killing nginx on purpose produces an alert in under 20 minutes without anyone ' +
            'watching. Do not route alerts through anything running on the VPS.',
        sortOrder: 10,
    },
    {
        key: 'sonetaran-barnefarms-no-backups',
        title: 'sonetaran and barnefarms prod data has no backup of ours',
        severity: 'CRITICAL',
        status: 'OPEN',
        category: 'DATA',
        scope: 'sonetaran, barnefarms',
        gap:
            'Both run prod on MongoDB Atlas (sone-taran.4zieyy1, cluster0.hblx6) and neither has a backup ' +
            'job. Every other app is dumped nightly and pushed to Cloudflare R2 with --immutable and ~40-day ' +
            'retention; these two are not in that flow at all. Whatever Atlas is or is not doing on its tier ' +
            'is the only copy, and nobody has checked which.',
        risk:
            'A dropped collection or a bad migration is permanent, unrecoverable data loss for customers who ' +
            'have paid. That is refunds, reputation, and plausibly a legal problem — not an incident you ' +
            'write a postmortem for and move on from.',
        evidence:
            '~/backups has no sonetaran or barnefarms directory; R2 bucket nexus-db-backups has prefixes ' +
            'apps/goldrate/messaging/mongo/payments/postgres/restobill/sonebill-mongo/truepayroll and no ' +
            'others.',
        aiBrief:
            'Get sonetaran and barnefarms prod data under backup. The plan agreed on 2026-11-15 is to move ' +
            'both off MongoDB Atlas onto the VPS\'s own databases, which puts them inside the existing ' +
            'nightly flow.\n\n' +
            'Context: self-hosted MongoDB on the VPS is bound to 127.0.0.1 with authorization enabled and ' +
            'already backs up sonebill via ~/bin/sonebill-mongo-backup.sh (run from /etc/cron.d, dumps, ' +
            'verifies, pushes to r2:nexus-db-backups/sonebill-mongo). Copy that pattern; do not invent a new one.\n\n' +
            'Hard requirement: the backup job ships in the SAME change as the migration, not as a follow-up. ' +
            'Moving off Atlas without adding the job leaves these apps worse off than today, because Atlas ' +
            'at least might have had snapshots.\n\n' +
            'Steps: confirm what Atlas tier each is on and whether snapshots exist today; plan the cutover ' +
            '(connection strings live in ~/barnefarms/backend/prod/.env and ~/sonetaran/prod/.env, both now ' +
            'chmod 600); mongodump from Atlas, mongorestore into local Mongo, verify counts per collection; ' +
            'switch the .env and restart (barnefarms prod is the Docker container barnefarms-backend-prod, ' +
            'sonetaran is PM2 sonetaran-api-prod); add both to a backup script with offsite copy and a ' +
            'verify step; then actually restore one dump into a scratch database to prove it works.\n\n' +
            'Until cutover these two are unprotected, so if the migration is more than a few days out, add a ' +
            'throwaway mongodump cron against Atlas first to cover the gap.\n\n' +
            'Done looks like: both appear in ~/bin/ci-health-check.sh\'s backup freshness section, both have ' +
            'an R2 prefix, and one restore has been performed and verified.',
        sortOrder: 20,
    },
    {
        key: 'single-host-no-redundancy',
        title: 'One VPS runs every product, with no failover',
        severity: 'CRITICAL',
        status: 'OPEN',
        category: 'INFRA',
        scope: 'whole platform',
        gap:
            'A single 4-vCPU / 16 GB box runs 14 prod apps, 14 dev apps, both Postgres clusters, MongoDB, ' +
            'Redis and all 33 nginx sites. No failover, no load balancer, no separate non-prod host. Preprod ' +
            'was retired on 2026-11-08, so changes go dev to prod with no staging gate.',
        risk:
            'One OOM, one bad deploy or one kernel reboot takes down every paying customer of every product ' +
            'simultaneously. A 102/100 Postgres connection outage has already happened. Memory sat at 8.8 of ' +
            '15 GB during the audit with Java (restobill, pride), Laravel (feenix) and a 2 GB ' +
            'shared_buffers on the same kernel, so the headroom is thin.',
        evidence: 'pm2 list: 27 processes; docker ps: 9 containers; 33 sites in /etc/nginx/sites-enabled.',
        aiBrief:
            'Plan and cost splitting the Code Implants platform off a single host. Today one Hostinger VPS ' +
            '(31.97.61.191, 4 vCPU / 16 GB / 193 GB, Ubuntu 24.04) runs everything: 27 PM2 processes, 9 ' +
            'Docker containers, Postgres 16 main (5432, prod) and dev (5433), MongoDB, Redis, 33 nginx sites.\n\n' +
            'Deliver a written proposal, not code, covering: (1) the cheapest split that removes the shared ' +
            'blast radius — most likely a second VPS taking all dev/non-prod so prod stops sharing a kernel ' +
            'with it; (2) what moving prod Postgres to a managed instance would cost versus the operational ' +
            'burden it removes; (3) which apps are the real resource risk, measured not guessed — use the ' +
            'Nexus Server tab history in /var/lib/nexus-server/history/ and per-process memory from pm2; ' +
            '(4) a migration order that never has two writers on one database; (5) what it costs per month.\n\n' +
            'Constraints that are already decided: dev and prod only, no preprod. Postgres dev DBs go on ' +
            '5433 with connection_limit=5 per app. Read ~/bin/pg-tune.sh and the nexus-backend CLAUDE.md ' +
            'section on the Neon migration before proposing managed Postgres — that was tried and abandoned ' +
            'on cost.\n\n' +
            'Done looks like: a recommendation with a monthly figure the founder can say yes or no to.',
        sortOrder: 30,
    },
    {
        key: 'no-error-tracking',
        title: 'No error tracking in any backend',
        severity: 'CRITICAL',
        status: 'OPEN',
        category: 'OBSERVABILITY',
        scope: 'all repos',
        gap:
            'No Sentry, Datadog, OpenTelemetry or equivalent in any of ~20 repos. No APM, no tracing, no ' +
            'metrics store, no log aggregation. Logs are per-PM2-process files plus nginx files on the box, ' +
            'with journald capped at 500 MB.',
        risk:
            'A customer-affecting exception is invisible unless someone SSHes in and greps the right log. ' +
            'The nexus-backend CLAUDE.md records that this platform watched two registered apps send nothing ' +
            'for twelve days without surfacing it — the same blindness now applies to paid users hitting ' +
            'errors nobody sees.',
        evidence:
            'grep for sentry|datadog|opentelemetry across nexus, payments-backend, messaging-backend, ' +
            'TruePayroll, sonetaran, barnefarms returned no dependency in any package.json.',
        aiBrief:
            'Add error tracking to the Code Implants backends. Start with Sentry\'s free tier unless there is ' +
            'a reason not to.\n\n' +
            'Priority order, by blast radius if an error is missed: payments-backend, messaging-backend, ' +
            'nexus-backend, barnefarms-backend, then the rest.\n\n' +
            'The NestJS apps (nexus, payments, messaging) share a shape: Nest 11 + Prisma 6, an ' +
            'HttpExceptionFilter in src/common/filters, env-driven config, one checkout per environment on ' +
            'the VPS with its own .env. Wire the SDK once in a way that can be copied: initialise from a ' +
            'DSN env var, tag events with the environment and release, and leave it inert when the DSN is ' +
            'unset so dev and local runs stay quiet.\n\n' +
            'Requirements: never send request bodies, OTP codes, phone numbers, API keys or payment ' +
            'identifiers to a third party — scrub before send and state in the PR what is scrubbed. ' +
            'Verify by throwing a deliberate error on dev and showing the event arriving. Do not add an ' +
            'agent or sidecar that needs root on the VPS.\n\n' +
            'Done looks like: an unhandled exception in payments-backend dev produces an alert without ' +
            'anyone reading a log file.',
        sortOrder: 40,
    },
    {
        key: 'untested-restores',
        title: 'No backup has ever been restored',
        severity: 'CRITICAL',
        status: 'OPEN',
        category: 'DATA',
        scope: 'all databases',
        gap:
            'Backups are good — nightly, verified after dump, offsite to R2 with --immutable and ~40-day ' +
            'retention. But no restore has been performed. The only restore test that exists is ' +
            '~/truepayroll/bin/restore-check.sh, cron\'d monthly for truepayroll prod only, whose first run ' +
            'is due 2026-12-01. There is no documented RTO or RPO and no DR runbook.',
        risk:
            'An untested backup is a hypothesis. The moment it matters is the moment nobody can afford to ' +
            'find out that the dump was unreadable, the role grants were missing, or nobody knows the ' +
            'restore order.',
        evidence: '~/truepayroll/prod/backups/restore-check.log does not exist; no other restore log anywhere.',
        aiBrief:
            'Prove the Code Implants backups actually restore, and write down how long it takes.\n\n' +
            'Pick two apps with different engines — one Postgres (payments or nexus) and one MongoDB ' +
            '(sonebill) — and restore last night\'s dump into a scratch database on the VPS, not over ' +
            'anything live. Backups are in ~/backups/<app>/ locally and r2:nexus-db-backups/<prefix>/ ' +
            'offsite; pull from R2 for at least one of them, so the offsite copy is what gets proven.\n\n' +
            'Postgres dumps are custom-format (pg_restore). truepayroll\'s are encrypted (.dump.enc) and its ' +
            'prod restore needs sudo -u postgres because RLS is forced even for the owner role. Dev DBs ' +
            'belong on cluster 5433, never 5432.\n\n' +
            'Record for each: wall-clock time to restore, the exact commands, what had to be done by hand ' +
            '(roles, extensions, grants), and the data loss window implied by a 02:30 nightly dump. Write it ' +
            'up as a DR runbook in the nexus-backend repo under docs/, and add an RTO/RPO line per app.\n\n' +
            'Do not touch a production database. Drop the scratch databases afterwards and say so.\n\n' +
            'Done looks like: a runbook someone who did not do this work could follow at 3am.',
        sortOrder: 50,
    },

    // -------------------------------------------------------------------- HIGH
    {
        key: 'nginx-edge-hardening',
        title: 'No HSTS and no edge rate limiting on 33 sites',
        severity: 'HIGH',
        status: 'IN_PROGRESS',
        category: 'SECURITY',
        scope: 'nginx, all sites',
        gap:
            'Zero of 33 nginx sites set HSTS, and only payments and messaging have any rate limiting (their ' +
            'own per-location zones). Nothing else has a request cap of any kind.',
        risk:
            'Scrapers and volumetric abuse hit app processes directly, and every first visit is one ' +
            'downgrade away from plaintext. With money flowing, the API surface becomes worth attacking.',
        evidence:
            'grep -rl for Strict-Transport-Security and limit_req across /etc/nginx/sites-enabled returned 0 ' +
            'of 33; conf.d held only payments-ratelimit.conf, messaging-ratelimit.conf and nexus-traffic.conf.',
        aiBrief:
            'Apply the staged nginx hardening on the Code Implants VPS. The script is written, uploaded and ' +
            'syntax-checked but NOT yet run, because it needs sudo:\n\n' +
            '  ssh hostinger-vps "sudo bash ~/bin/harden-nginx-20261115.sh"\n\n' +
            'It writes one http-level file, /etc/nginx/conf.d/00-hardening.conf, so no site file is edited, ' +
            'and it is self-reverting: it measures status and median TTFB for 15 prod endpoints first, runs ' +
            'nginx -t, reloads, re-measures, and automatically restores the previous config if any endpoint ' +
            'broke or got more than 25% AND more than 40ms slower.\n\n' +
            'Things not to change without understanding them: rate=100r/s burst=200 is deliberately generous ' +
            'because a React page load fires 30-60 requests and a whole office or restaurant sits behind one ' +
            'NAT IP — lowering it to 10-30r/s starts 429-ing real customers. `nodelay` must stay, or nginx ' +
            'delays requests to smooth them to the rate and adds real latency. A geo+map pair yields an ' +
            'empty rate-limit key for loopback, the server\'s own IP and the office IP, which makes nginx ' +
            'skip the check entirely for internal traffic. X-Frame-Options is commented out on purpose until ' +
            'someone has clicked through the PhonePe checkout and confirmed nothing iframes our pages.\n\n' +
            'After applying, watch for a day: ssh hostinger-vps "grep \'limiting requests\' ' +
            '/var/log/nginx/error.log | tail -20". If real users are being limited, raise the rate rather ' +
            'than removing the limit.\n\n' +
            'Then raise HSTS from max-age=15552000 to 31536000 with includeSubDomains, but only after ' +
            'confirming every subdomain is HTTPS-only — HSTS cannot be undone in a browser that already saw ' +
            'it. Note sonebill.codeimplants.com is on Firebase Hosting, not nginx, so it is outside this.',
        sortOrder: 60,
    },
    {
        key: 'fail2ban-and-root-ssh',
        title: 'fail2ban inactive and direct root SSH still allowed',
        severity: 'HIGH',
        status: 'IN_PROGRESS',
        category: 'SECURITY',
        scope: 'VPS host',
        gap:
            'fail2ban is installed-but-inactive and sshd still has PermitRootLogin yes. Password ' +
            'authentication is already off, so key-only root login is the current exposure.',
        risk:
            'Unlimited credential-stuffing attempts against SSH, and root reachable directly rather than ' +
            'through an accountable sudo path. Cheap to close and embarrassing to explain in a security ' +
            'questionnaire.',
        evidence: 'systemctl is-active fail2ban returned inactive; /etc/ssh/sshd_config has PermitRootLogin yes.',
        aiBrief:
            'Apply the staged SSH hardening on the Code Implants VPS. Written, uploaded, not yet run:\n\n' +
            '  ssh hostinger-vps "sudo bash ~/bin/harden-ssh-fail2ban-20261115.sh"\n\n' +
            'It installs fail2ban with sshd (normal mode) and recidive jails, bantime 1h, ignoreip covering ' +
            'loopback, the server itself and the office IP; then sets PermitRootLogin no via ' +
            '/etc/ssh/sshd_config.d/70-ci-hardening.conf. Root stays reachable with sudo -i.\n\n' +
            'Safety gates already in it: it refuses to run if it finds ANY successful root SSH login in the ' +
            'logs (something automated may depend on it), and it rolls back if sshd -t fails.\n\n' +
            'Run it with your current SSH session held open, then confirm from a SECOND terminal that ' +
            'ssh hostinger-vps "echo still-in" works before closing anything. Lockout fallback is ' +
            'Hostinger\'s browser console in the VPS panel.\n\n' +
            'fail2ban sits outside the HTTP request path, so it cannot add latency to app traffic.\n\n' +
            'Done looks like: fail2ban-client status sshd shows the jail active, and sshd -T reports ' +
            'permitrootlogin no.',
        sortOrder: 70,
    },
    {
        key: 'kernel-patch-reboot',
        title: 'Kernel and libc patches pending, never rebooted',
        severity: 'HIGH',
        status: 'OPEN',
        category: 'SECURITY',
        scope: 'VPS host',
        gap:
            'unattended-upgrades installs patches but never reboots, so /var/run/reboot-required has been ' +
            'set for the whole 29-day uptime: linux-image-6.8.0-149-generic, linux-base and libc6 are ' +
            'pending while 6.8.0-147 is still running. There is no patch window.',
        risk:
            'Running a kernel and libc with known fixes available, indefinitely. The reboot that fixes it ' +
            'takes down every product at once, so it keeps getting deferred — which is exactly how patch ' +
            'lag becomes permanent.',
        evidence: 'uptime 29 days; uname -r 6.8.0-147; /var/run/reboot-required.pkgs lists the three packages.',
        aiBrief:
            'Establish a patch window for the Code Implants VPS and take the pending reboot.\n\n' +
            'This reboots every product simultaneously, so the founder picks the time — do not reboot ' +
            'without an explicit go-ahead naming the window.\n\n' +
            'Procedure:\n' +
            '  ssh hostinger-vps "bash ~/bin/ci-health-check.sh" > health-before.txt\n' +
            '  ssh hostinger-vps "sudo systemctl reboot"\n' +
            '  # wait 60-90s\n' +
            '  ssh hostinger-vps "uptime; uname -r; bash ~/bin/ci-health-check.sh" > health-after.txt\n' +
            '  diff health-before.txt health-after.txt\n\n' +
            'The point of the diff is that nothing proves these come back by themselves until you try: ' +
            'pm2-sanskarpandit and pm2-aniketpotdar resurrecting their saved dumps, all 9 Docker containers ' +
            'having a restart policy that survives a boot, both Postgres clusters starting, and ' +
            'truepayroll-ingestion-dev/prod coming up. Anything that needs a hand is a finding worth fixing ' +
            'BEFORE there are paying users, and worth adding to this register.\n\n' +
            'Then set up a recurring monthly window so patch lag never reaches 29 days again.',
        sortOrder: 80,
    },
    {
        key: 'rotate-exposed-barnefarms-credentials',
        title: 'Rotate the credentials that sat in a world-readable .env',
        severity: 'HIGH',
        status: 'OPEN',
        category: 'SECURITY',
        scope: 'barnefarms',
        gap:
            'The file permissions are fixed, but ~/barnefarms/backend/prod/.env was mode 0664 under a 0755 ' +
            'home on a six-account box for an unknown period. It holds the MongoDB Atlas prod URI, PhonePe ' +
            'keys and 11 secrets in total. Anything already copied is still valid.',
        risk:
            'Direct access to live customer and order data and to a payment integration. A permission fix ' +
            'does not un-leak a secret; only rotation does.',
        evidence:
            'ls -l showed -rw-rw-r-- on 2026-11-15 before the fix; /home/sanskarpandit was drwxr-xr-x; five ' +
            'other Linux accounts exist on the host.',
        aiBrief:
            'Rotate the secrets that were exposed in ~/barnefarms/backend/prod/.env on the Code Implants VPS.\n\n' +
            'The founder runs anything that mints or prints a credential — prepare the exact steps and hand ' +
            'them over rather than executing.\n\n' +
            'In scope: the MongoDB Atlas password for cluster0.hblx6 (prod, and dev/preprod if they share a ' +
            'user), the PhonePe keys, and any other secret in that file. Produce a list of every secret in ' +
            'it first (names only, never values, and never paste a value into chat or a commit).\n\n' +
            'For each: where it is issued, what else consumes it (barnefarms prod runs as the Docker ' +
            'container barnefarms-backend-prod; barnefarms-mobile and barnefarms-frontend may carry their ' +
            'own copies), the rotation order that avoids downtime, and how to verify afterwards.\n\n' +
            'Note the same file also contains MONGO_URI_DEV and MONGO_URI_PREPROD, so one file holds every ' +
            'environment\'s credentials — worth splitting as part of this.\n\n' +
            'Done looks like: every secret that was in that file is invalid, barnefarms prod still serves ' +
            '200 on api.barnefarms.com, and a checkout still completes.',
        sortOrder: 90,
    },
    {
        key: 'ci-pipelines-missing',
        title: 'CI exists in only 3 of ~20 repos',
        severity: 'HIGH',
        status: 'OPEN',
        category: 'CI_CD',
        scope: 'all repos',
        gap:
            'Real pipelines exist in restobill-backend, restobill-frontend and truepayroll-backend, plus ' +
            'Android release checks in sonebill-frontend and gold-khata-book-frontend. nexus, payments, ' +
            'messaging, sonetaran, barnefarms, vajankata, feenix, panchal-sonar and pride have none. Deploys ' +
            'are shell scripts run from one laptop over SSH, with no build artifacts, no immutable releases, ' +
            'no rollback and no record of who shipped what.',
        risk:
            'Nothing stops a regression reaching paying customers, and nothing proves a tenancy filter was ' +
            'not dropped in a refactor. A bad prod deploy has no rollback button and no audit trail.',
        evidence: 'find for .github/workflows across D:\\CI Projects returned 15 files, all but 5 inside vendor/ directories.',
        aiBrief:
            'Add a minimal CI pipeline to the Code Implants repos that have none, starting with ' +
            'nexus-backend, payments-backend and messaging-backend.\n\n' +
            'Copy the shape that already works rather than inventing one: read ' +
            'restobill-backend/.github/workflows/ci.yml and truepayroll-backend/.github/workflows/ci.yml ' +
            'first.\n\n' +
            'For each Nest + Prisma repo the pipeline should, on pull request and on push to master: ' +
            'install with npm ci, typecheck, lint, run jest, and verify the Prisma migration chain still ' +
            'reproduces the schema (nexus-backend\'s CLAUDE.md documents the migrate diff command and why it ' +
            'matters — four tables were once lost to prisma db push). Add dependency and secret scanning ' +
            '(Dependabot plus a secret scanner) in the same change.\n\n' +
            'Highest-value test to add while you are there: one that proves tenant isolation, because only ' +
            'truepayroll has a database-level backstop and everything else enforces it in application code.\n\n' +
            'Do not wire automatic deployment yet — deploys stay manual through each repo\'s scripts/deploy.sh ' +
            'until there is a rollback story. Keep pipelines under free-tier GitHub Actions minutes.\n\n' +
            'Done looks like: a red pipeline on a deliberately broken PR in each of the three repos.',
        sortOrder: 100,
    },
    {
        key: 'secrets-vault',
        title: 'Secrets are plaintext .env files with no vault or rotation',
        severity: 'HIGH',
        status: 'OPEN',
        category: 'SECURITY',
        scope: 'whole platform',
        gap:
            'Every secret lives in a plaintext .env per checkout. ENV_ONBOARDING.md itself says "secrets ' +
            'vault (TBD)". One Gmail app password serves both backup-failure mail and Nexus alerts. There is ' +
            'no rotation schedule and no inventory of which secret is where.',
        risk:
            'One leaked file hands over prod database, payment and SMS credentials at once. Nothing forces ' +
            'rotation, so a secret exposed today stays valid indefinitely — which is exactly the situation ' +
            'the barnefarms item describes.',
        evidence:
            '19 .env files were mode 0664 until 2026-11-15; ~/secrets holds three loose files; no vault or ' +
            'secret manager is in use anywhere.',
        aiBrief:
            'Propose and then implement secret management for Code Implants. Today every secret is a ' +
            'plaintext .env in each VPS checkout, documented name-only in D:\\CI Projects\\ENV_ONBOARDING.md, ' +
            'which openly marks the vault as TBD.\n\n' +
            'Start with the proposal, not the migration. Compare options against the real constraints: one ' +
            'shared VPS with per-app Linux users, apps in Node/Nest, .NET, Laravel, Django and Java, deploys ' +
            'via per-repo shell scripts, a one-person team, and a strong preference for not adding anything ' +
            'that needs root or a monthly bill. Candidates worth weighing: SOPS with age (files stay in git, ' +
            'encrypted), systemd credentials, or a hosted manager.\n\n' +
            'Whatever is chosen must produce: a single inventory of every secret and what consumes it, a ' +
            'rotation procedure per secret, and no plaintext secret readable by any account other than the ' +
            'one that needs it. Split the shared Gmail app password so backup mail and Nexus alerts do not ' +
            'share one credential.\n\n' +
            'Never print a secret value into chat, a log or a commit. Do not change a running app\'s ' +
            'configuration without a verified rollback.\n\n' +
            'Done looks like: a written recommendation with effort and cost, then one app fully migrated as a ' +
            'proof.',
        sortOrder: 110,
    },
    {
        key: 'mobile-signing-keys-single-copy',
        title: 'Android signing keystores exist in exactly one place',
        severity: 'HIGH',
        status: 'OPEN',
        category: 'DATA',
        scope: 'feenix, pride, sonebill and other mobile apps',
        gap:
            'upload.jks, feenix-upload.jks and pride-upload.jks live only in D:\\CI Projects\\keys on one ' +
            'Windows laptop. They are not on the VPS, not in R2 and not in any repo. Also in that folder: ' +
            'FCM service-account JSON and a Play upload certificate.',
        risk:
            'Laptop loss or disk failure means days of Google key-reset before any update can ship to Play ' +
            'for the affected apps — while paying users wait for a fix that cannot be released.',
        evidence: 'find for *.jks across the VPS home returned nothing; the files exist only locally, mode 0644.',
        aiBrief:
            'Get the Code Implants Android signing material backed up safely. Today upload.jks, ' +
            'feenix-upload.jks, pride-upload.jks, FCM service-account JSON and a Play upload certificate ' +
            'exist only in D:\\CI Projects\\keys on one laptop.\n\n' +
            'Requirements: encrypted at rest with a passphrase that is NOT stored next to the archive; at ' +
            'least two independent locations (Cloudflare R2 is already configured on the VPS as remote r2: ' +
            'with --immutable uploads, bucket nexus-db-backups — a separate prefix or bucket is fine); and a ' +
            'documented recovery procedure that states where the passphrase lives.\n\n' +
            'Also record, per app, the keystore alias and which Play app it signs, because a keystore whose ' +
            'alias nobody remembers is only marginally better than a lost one. And confirm whether Play App ' +
            'Signing is enabled for each app, since that determines whether a lost upload key is a reset ' +
            'request or a dead end.\n\n' +
            'Never commit a keystore to git. Never paste a passphrase into chat. The founder handles ' +
            'anything that needs a Play Console credential.\n\n' +
            'Done looks like: the laptop could be destroyed today and an update could still ship this week.',
        sortOrder: 120,
    },
    {
        key: 'tenant-isolation-backstop',
        title: 'Tenant isolation has no database-level backstop',
        severity: 'HIGH',
        status: 'OPEN',
        category: 'SECURITY',
        scope: 'all multi-tenant apps except truepayroll',
        gap:
            'Only TruePayroll has forced row-level security. Every other multi-tenant app enforces tenancy ' +
            'in application code — a where clause per query — with no database backstop and, in most repos, ' +
            'no CI at all to prove a filter was not dropped.',
        risk:
            'One tenant seeing another tenant\'s data is the single bug a paying B2B customer never forgives. ' +
            'It is also the kind of regression a refactor introduces silently, because the query still ' +
            'returns rows.',
        evidence: 'TruePayroll backup notes record forced RLS even for the owner role; no RLS elsewhere.',
        aiBrief:
            'Add a database-level backstop for tenant isolation across the Code Implants multi-tenant apps. ' +
            'Today only TruePayroll has forced row-level security; the Nest + Prisma apps rely entirely on ' +
            'application-code where clauses.\n\n' +
            'Phase 1, do this first and separately: write tests that prove isolation as it stands. For each ' +
            'multi-tenant app, create two tenants with data, authenticate as each, and assert that every ' +
            'list and detail endpoint returns only the caller\'s rows. These tests have standalone value ' +
            'even if RLS never lands, and they will tell you whether there is already a live leak. If they ' +
            'find one, raise it as a CRITICAL item in this register immediately.\n\n' +
            'Phase 2: propose how to add Postgres RLS under Prisma. This is genuinely awkward — Prisma does ' +
            'not set session variables per request on its own — so investigate the options (a per-request ' +
            'transaction that SET LOCALs the tenant, a Prisma client extension, or a separate connection ' +
            'role) and cost them against the shared-VPS connection budget. Note the connection-pool history ' +
            'in nexus-backend\'s DatabaseModule: 17 PrismaService instances once exhausted Postgres, so any ' +
            'design that multiplies pools is wrong here.\n\n' +
            'Start with payments-backend, since it holds money movement.\n\n' +
            'Done looks like: a failing test when a where clause is deliberately removed.',
        sortOrder: 130,
    },
    {
        key: 'cloudflare-waf',
        title: 'No CDN or WAF in front of anything',
        severity: 'HIGH',
        status: 'OPEN',
        category: 'SECURITY',
        scope: 'all public hostnames',
        gap:
            'No Cloudflare or equivalent. The origin IP is directly exposed on every hostname, with no WAF, ' +
            'no DDoS absorption and no edge caching. DNS is on Hostinger with no proxy.',
        risk:
            'The origin takes every request, legitimate or not, and a single box absorbs any attack directly. ' +
            'Also no caching, so static assets burn origin CPU that paying customers are waiting on.',
        evidence: 'Audit confirmed no Cloudflare in front of apps; pay and msg are plain A records to 31.97.61.191.',
        aiBrief:
            'Put Cloudflare in front of the Code Implants apps. DNS for codeimplants.com is on Hostinger ' +
            '(ns1/ns2.dns-parking.com) with no proxy today; 33 nginx sites resolve straight to 31.97.61.191.\n\n' +
            'The founder owns the DNS account and this is an outward-facing change, so plan it and hand over ' +
            'the steps rather than executing.\n\n' +
            'Deliver: which hostnames to proxy and in what order (start with a low-risk one, not a payment ' +
            'host); what breaks when traffic arrives through a proxy — above all that $binary_remote_addr ' +
            'becomes Cloudflare\'s IP, which silently breaks the existing per-IP rate limits in ' +
            'payments-ratelimit.conf and messaging-ratelimit.conf and the new 00-hardening.conf, plus the ' +
            'Nexus traffic collector\'s visitor counting and own-IP split, and TruePayroll\'s device address ' +
            'lock; how to restore the real client IP (set_real_ip_from with Cloudflare ranges, ' +
            'CF-Connecting-IP); and what to do about api.barnefarms.com, where PhonePe webhooks arrive.\n\n' +
            'Note sonebill.codeimplants.com is already on Firebase Hosting, so it is out of scope. After ' +
            'cutover, re-lock the origin so it only accepts traffic from Cloudflare ranges — otherwise the ' +
            'WAF is trivially bypassed by hitting the IP.\n\n' +
            'Done looks like: one hostname proxied, real client IPs still correct in ' +
            '/var/log/nginx/traffic.log, and rate limiting still keyed on the actual visitor.',
        sortOrder: 140,
    },

    // ------------------------------------------------------------------ MEDIUM
    {
        key: 'prod-nonprod-separation',
        title: 'dev and prod share one kernel, one nginx, one Mongo and one Redis',
        severity: 'MEDIUM',
        status: 'OPEN',
        category: 'INFRA',
        scope: 'whole VPS',
        gap:
            'Postgres was split into prod (5432) and dev (5433) clusters on 2026-11-06, which was the right ' +
            'move, but dev and prod still share the kernel, nginx, MongoDB and Redis. Preprod was retired, ' +
            'so there is no staging gate between a dev test and a paying customer.',
        risk: 'A runaway dev job degrades prod for paying users, and nothing catches a bad change between dev and prod.',
        evidence: 'One nginx with 33 sites covering both envs; single mongod and redis-server for all environments.',
        aiBrief:
            'Separate dev from prod on the Code Implants VPS without buying a second box yet. Postgres is ' +
            'already split (prod 5432, dev 5433 via ~/bin/pg-split-dev.sh); MongoDB, Redis, nginx and the ' +
            'kernel are still shared.\n\n' +
            'Deliver, in order of value for effort: separate Redis databases or instances per environment; ' +
            'separate Mongo databases with separate roles so a dev credential cannot read prod; cgroup or ' +
            'systemd resource limits on dev PM2 processes and dev containers so they cannot starve prod; and ' +
            'a check that no dev .env points at a prod database.\n\n' +
            'That last one is worth doing first and is nearly free — grep every dev checkout\'s .env for ' +
            'prod hostnames and database names and report anything crossed over. Note ' +
            '~/barnefarms/backend/prod/.env holds MONGO_URI_DEV, MONGO_URI_PREPROD and MONGO_URI_PROD in ' +
            'one file, which is exactly the shape that causes this.\n\n' +
            'Do not restart a prod process to achieve a dev improvement. Preprod is retired — do not ' +
            'reintroduce it.\n\n' +
            'Done looks like: no dev process can reach a prod datastore, proven not assumed.',
        sortOrder: 150,
    },
    {
        key: 'pride-offsite-backup',
        title: 'pride backups never leave the box; retired preprod is still dumped nightly',
        severity: 'MEDIUM',
        status: 'OPEN',
        category: 'DATA',
        scope: 'pride-universal, nexus, sonebill',
        gap:
            '~/bin/pride-db-backup.sh writes to ~/backups/pride and has no offsite step, so R2 has no pride ' +
            'prefix — those backups cover human error but not host loss. Separately, preprod was retired on ' +
            '2026-11-08 but nexus_preprod and sonebill_preprod are still dumped every night and pushed ' +
            'offsite.',
        risk:
            'Losing the host loses pride\'s data outright. The preprod dumps are harmless but waste R2 ' +
            'storage and retention, and they make the backup listing lie about what is actually protected.',
        evidence:
            'grep for offsite|rclone|r2: in pride-db-backup.sh returned nothing; rclone lsd r2:nexus-db-backups ' +
            'has no pride prefix; ~/backups/postgres still contains nexus_preprod dumps dated 2026-11-15.',
        aiBrief:
            'Two small backup corrections on the Code Implants VPS (ssh hostinger-vps).\n\n' +
            '1. pride has no offsite copy. Add an offsite step to ~/bin/pride-db-backup.sh following the ' +
            'pattern the other scripts use: they call ~/bin/offsite-copy.sh <dir> <prefix> <glob> after ' +
            'dumping, which pushes to r2:nexus-db-backups/<prefix> with --immutable. Retention is managed ' +
            'centrally by the hourly ~/bin/r2-guard.sh (~40 days), so do not add your own deletion. Note ' +
            'pride also backs up an uploads tarball (uploads-prod-<date>.tgz), which should go offsite too.\n\n' +
            '2. Preprod was retired on 2026-11-08 but is still being dumped. Stop taking nexus_preprod and ' +
            'sonebill_preprod dumps in ~/bin/nexus-db-backup.sh and ~/bin/sonebill-mongo-backup.sh (the ' +
            'latter runs from /etc/cron.d as root, so it needs sudo). Keep the existing preprod dumps until ' +
            'R2 retention ages them out; do not mass-delete history.\n\n' +
            'Both scripts verify their dumps and mail on failure through msmtp — keep that behaviour. After ' +
            'changing either, run it by hand once and confirm ~/bin/ci-health-check.sh still reports the ' +
            'backup section healthy.\n\n' +
            'Done looks like: r2:nexus-db-backups/pride exists with both the dump and the uploads tarball, ' +
            'and no new preprod dumps appear tomorrow.',
        sortOrder: 160,
    },
    {
        key: 'paid-user-operations',
        title: 'No billing operations, support intake, SLOs or status page',
        severity: 'MEDIUM',
        status: 'OPEN',
        category: 'PROCESS',
        scope: 'commercial readiness',
        gap:
            'The payments gateway handles checkout, refunds and subscriptions, but there is no dunning for ' +
            'failed renewals, no GST-compliant invoicing, no refund SLA, no support ticketing, no defined ' +
            'SLOs and no status page. Bus factor is one, with no on-call rota or incident process.',
        risk:
            'Every paying customer adds support load with nowhere to put it, and a failed renewal is silent ' +
            'revenue loss. B2B India customers will ask for GST invoices and an uptime commitment, and ' +
            'neither exists as an artifact.',
        evidence: 'No dunning, invoicing or ticketing code found; no SLO or status page anywhere.',
        aiBrief:
            'Work out what Code Implants needs operationally before taking money from multiple customers. ' +
            'This is a plan, not code.\n\n' +
            'Cover: failed-renewal dunning for UPI Autopay subscriptions (what payments-backend already ' +
            'records versus what a recovery flow needs); GST-compliant invoicing for Indian B2B customers; a ' +
            'stated refund SLA; where support requests land and who answers; the two or three SLOs worth ' +
            'committing to and what currently makes them unmeasurable; and a public status page.\n\n' +
            'Read the payments-backend HANDOFF.md first. Respect the scope guardrail recorded there: the ' +
            'gateway takes money only where Code Implants is the seller, never tenant-to-customer ' +
            'collections, because that would make us an RBI payment aggregator.\n\n' +
            'Note the SLO work depends on the external-uptime-monitoring item — you cannot commit to a ' +
            'number you do not measure, so sequence it after that.\n\n' +
            'Done looks like: a prioritised list the founder can turn into tickets, with the legal and tax ' +
            'items flagged for professional advice rather than guessed at.',
        sortOrder: 170,
    },
    {
        key: 'compliance-artifacts-dpdp',
        title: 'No DPAs, no retention policy, DPDP Act obligations unaddressed',
        severity: 'MEDIUM',
        status: 'OPEN',
        category: 'COMPLIANCE',
        scope: 'all customer-facing apps',
        gap:
            'Privacy policies exist for restobill, panchalsonar, gold-khata-book and the website; most apps ' +
            'have none. There are no per-product terms or DPAs, no implemented retention policy beyond ' +
            'backup retention, and nothing addressing India\'s DPDP Act 2023 — consent records, breach ' +
            'notification, grievance officer, data-principal rights.',
        risk:
            'A single enterprise security questionnaire fails today. Deals get blocked, and handling ' +
            'biometric-adjacent attendance data and payment data without these artifacts is a regulatory ' +
            'exposure rather than just a paperwork gap.',
        evidence:
            'find for privacy/terms/dpa returned policy pages for 4 surfaces only; no DPA or retention policy ' +
            'in any repo.',
        aiBrief:
            'Assemble the compliance artifacts Code Implants needs for paying B2B customers in India. Not ' +
            'legal advice — produce drafts and a gap list, and flag clearly what needs a lawyer.\n\n' +
            'Inventory first: for each app, what personal data is collected, where it is stored, how long it ' +
            'is kept, who it is shared with (2Factor for SMS, PhonePe for payments, Expo and Firebase for ' +
            'push, PostHog in barnefarms-mobile). Note TruePayroll\'s standing rule that biometric templates ' +
            'are never stored on the server — that is a genuine strength and should be stated explicitly in ' +
            'its policy.\n\n' +
            'Then draft: a privacy policy per app that lacks one, per-product terms, a customer-facing DPA ' +
            'template, a data-retention policy that matches what the systems actually do, and a documented ' +
            'data-deletion-on-request procedure. ~/backups/deletion-exports suggests something like this ' +
            'already happens ad hoc — find out what and write it down.\n\n' +
            'Separately, map DPDP Act 2023 obligations to what exists: consent records, breach notification ' +
            'timelines, grievance officer, data-principal rights. For payments, state the PCI position ' +
            'explicitly — PhonePe hosted checkout keeps card data out of our systems, and saying so in ' +
            'writing is worth more than it sounds when a questionnaire arrives.\n\n' +
            'Done looks like: a questionnaire-ready pack, with the items needing legal review listed separately.',
        sortOrder: 180,
    },
    {
        key: 'log-aggregation',
        title: 'No log aggregation; journald capped at 500 MB',
        severity: 'MEDIUM',
        status: 'OPEN',
        category: 'OBSERVABILITY',
        scope: 'whole VPS',
        gap:
            'Logs are per-PM2-process files (pm2-logrotate, 10 MB x 90), nginx files, and journald capped at ' +
            '500 MB. Nothing is searchable across apps, and diagnosing anything means SSHing in and grepping ' +
            'the right file on the right host.',
        risk:
            'Incident diagnosis is slow precisely when speed matters, and evidence may already have rotated ' +
            'away by the time anyone looks.',
        evidence: 'journald SystemMaxUse=500M; pm2-logrotate retain 90 / max_size 10M; no shipper installed.',
        aiBrief:
            'Make the Code Implants logs searchable in one place. Today: per-PM2-process files, nginx files, ' +
            'and journald capped at 500 MB on one VPS.\n\n' +
            'Weigh options against the constraints — one shared box with ~4 GB of real headroom, a ' +
            'one-person team, strong preference for free tiers and for nothing that needs root. A hosted ' +
            'free tier with a light shipper (Grafana Loki free, Better Stack) is more likely right here than ' +
            'self-hosting an Elastic stack, which would compete for the memory the apps need.\n\n' +
            'Whatever is chosen: ship nginx traffic.log, PM2 logs and the truepayroll-ingestion journals; ' +
            'never ship secrets, OTP codes or payment identifiers; cap local disk use; and make sure the ' +
            'shipper cannot itself become the thing that fills the disk.\n\n' +
            'Do not break /var/log/nginx/traffic.log or its format — the Nexus Server tab collector parses ' +
            'it, and install.sh owns that config.\n\n' +
            'Done looks like: one query across all apps answers "what errored at 14:05 yesterday".',
        sortOrder: 190,
    },

    // -------------------------------------------------------------------- DONE
    {
        key: 'env-file-permissions',
        title: 'World-readable .env files locked down',
        severity: 'HIGH',
        status: 'DONE',
        category: 'SECURITY',
        scope: 'VPS, 19 files',
        owner: 'Claude (2026-11-15 session)',
        gap:
            '19 .env and .env.bak files were mode 0664 under a 0755 home on a host with six Linux accounts. ' +
            'The worst was ~/barnefarms/backend/prod/.env: MongoDB Atlas prod URI, PhonePe keys, 11 secrets, ' +
            'readable by every other account on the box.',
        risk:
            'Any other account on the VPS could read live payment and database credentials. Now closed as a ' +
            'permissions matter, but see rotate-exposed-barnefarms-credentials — a chmod does not un-leak a ' +
            'secret.',
        evidence:
            'All 19 files now mode 0600, verified; after the change all 23 endpoints, 27 PM2 processes, 9 ' +
            'containers, both Postgres clusters, Mongo, Redis and every backup reported healthy ' +
            '(ci-health-check.sh exit 0).',
        aiBrief:
            'Already done on 2026-11-15 — recorded for audit, no action needed.\n\n' +
            'What was done: every .env and .env.bak under /home/sanskarpandit that was not 0600 was chmod ' +
            '600 (19 files). Verified afterwards with ~/bin/ci-health-check.sh, which passed clean.\n\n' +
            'Worth knowing if you work near this: the home directory itself is 0755 and must stay that way. ' +
            'It was briefly set to 0750 during this work and that breaks nginx, which serves static sites ' +
            'from under it as www-data and needs the traverse bit. It was reverted within about 20 seconds ' +
            'and all sites verified 200, but do not "tidy" the home directory permission.\n\n' +
            'The follow-up that is NOT done is credential rotation — see the ' +
            'rotate-exposed-barnefarms-credentials item.',
        completedAt: AUDIT_DATE,
        completedBy: 'Claude (2026-11-15 session)',
        sortOrder: 300,
    },
    {
        key: 'vps-health-check-script',
        title: 'One-command health check for the whole VPS',
        severity: 'MEDIUM',
        status: 'DONE',
        category: 'OBSERVABILITY',
        scope: 'VPS, all apps',
        owner: 'Claude (2026-11-15 session)',
        gap:
            'There was no single way to answer "is everything up?" before and after a change. Verifying a ' +
            'deploy or a reboot meant checking PM2, Docker, systemd, the databases and the endpoints by hand, ' +
            'so in practice it was not done.',
        risk:
            'Changes were applied without a baseline, so a regression could not be distinguished from a ' +
            'pre-existing fault. This is what made the rest of the hardening safe to attempt.',
        evidence:
            'Installed at ~/bin/ci-health-check.sh, needs no sudo, exits non-zero on any failure so it also ' +
            'works as a cron canary. Current state: ALL CHECKS PASSED.',
        aiBrief:
            'Already done on 2026-11-15 — use it, do not rewrite it.\n\n' +
            '  ssh hostinger-vps "bash ~/bin/ci-health-check.sh"\n\n' +
            'It checks 23 HTTP endpoints, every PM2 process, every Docker container, 9 systemd units, both ' +
            'Postgres clusters, MongoDB, Redis, nginx config, disk, memory and backup freshness. Exits 0 ' +
            'when clean and non-zero with FAIL lines otherwise, so it is usable as a canary.\n\n' +
            'Run it BEFORE and AFTER any infrastructure change and diff the two:\n' +
            '  ssh hostinger-vps "bash ~/bin/ci-health-check.sh" > before.txt\n' +
            '  # change something\n' +
            '  ssh hostinger-vps "bash ~/bin/ci-health-check.sh" > after.txt\n' +
            '  diff before.txt after.txt\n\n' +
            'Two deliberate exceptions so it does not cry wolf: barnefarms-backend-preprod is listed as ' +
            'retired-on-purpose (preprod was removed 2026-11-08), and the endpoint list uses ' +
            'api.sonebill.codeimplants.com, not the hyphenated api-sonebill form, which is only an nginx ' +
            'filename and serves a mismatched certificate.\n\n' +
            'If you add an app to the VPS, add its endpoint and processes here too.',
        completedAt: AUDIT_DATE,
        completedBy: 'Claude (2026-11-15 session)',
        sortOrder: 310,
    },
];
