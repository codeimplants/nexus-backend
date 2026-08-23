/**
 * PM2 process definitions for the Nexus backend on the VPS.
 *
 * Each environment runs from its OWN checkout. This matters: if all three ran
 * from a single directory and a single dist/, differing only by NODE_ENV and
 * PORT, then `npm run build` for any environment would replace the code all
 * three execute — and prod would pick it up on its next restart for any reason.
 * Separate checkouts mean deploying to dev/preprod is a genuine rehearsal for
 * prod, with code isolation and not just database separation.
 *
 * Each checkout holds its own .env (DATABASE_URL, JWT_SECRET, OTP keys), which
 * is why the env block below only needs NODE_ENV and PORT — dotenv.config()
 * does NOT override already-set vars, so these win.
 *
 * Deploy with scripts/deploy.sh, which targets one environment at a time.
 * Reload after editing this file:  pm2 startOrReload ecosystem.config.js
 */
// Shares the VPS (31.97.61.191) with sonebill-backend, under the same account so
// a single `pm2 list` shows every service. sonebill holds ports 7000-7002; nexus
// uses 6000-6002.
const BASE = '/home/sanskarpandit';

/**
 * Node 24 (Krypton LTS), stated explicitly rather than inherited.
 *
 * These apps used to declare no interpreter, so they ran on whatever `node` PM2
 * resolved first — the system Node 18, end-of-life since April 2025. Inheriting
 * like that is not merely outdated, it is invisible: nothing here recorded which
 * runtime production used, and a change to the system node would have moved all
 * three onto a new major version at their next restart with no diff to show it.
 *
 * Located rather than hardcoded so this works on any account, and it throws
 * rather than silently falling back — a loud failure at start beats finding out
 * months later that prod runs on a runtime nobody chose. Verified on 23 Aug 2026
 * against the existing node_modules: Nest boots and Prisma executes real queries
 * under 24, so no rebuild is needed (the query engine is a standalone binary,
 * not a native addon, so the Node ABI change does not apply to it).
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const NODE_24_CANDIDATES = [
  path.join(os.homedir(), '.local/node24/bin/node'),
  path.join(os.homedir(), 'node24/bin/node'),
];
const NODE_24 = NODE_24_CANDIDATES.find((p) => fs.existsSync(p));

if (!NODE_24) {
  throw new Error(
    `Node 24 not found. Looked in:\n  ${NODE_24_CANDIDATES.join('\n  ')}`
  );
}

const app = (env, port) => ({
  name: `nexus-backend-${env}`,
  cwd: `${BASE}/nexus-backend-${env}`,
  script: 'dist/main.js',
  interpreter: NODE_24,
  exec_mode: 'fork',
  instances: 1,
  env: {
    NODE_ENV: env,
    PORT: port,
  },
});

// Port map on this VPS (31.97.61.191), so nothing collides:
//   3000/3001, 5000/5001, 9000 — other services
//   4000-4002 — sonetaran        7000-7002 — sonebill
//   6000      — gold-rate/prod   <-- taken, which is why nexus-prod is NOT 6000
//   6001-6003 — nexus
module.exports = {
  apps: [
    app('prod', 6003),
    app('dev', 6001),
    app('preprod', 6002),
  ],
};
