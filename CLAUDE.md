# Nexus Backend — Claude Context

Centralised admin platform for Code Implants' apps: version control (soft/force update, kill
switch, maintenance mode), engagement analytics, and per-app federation. NestJS + Prisma +
PostgreSQL. Client apps talk to `/sdk/*`; the dashboard talks to `/admin/*`.

Three environments, each its own checkout, PM2 process, and database on one VPS:

| env | port | database | domain |
|---|---|---|---|
| prod | 6003 | `nexus_prod` | `api.nexus.codeimplants.com` |
| preprod | 6002 | `nexus_preprod` | `preprod.api.nexus.codeimplants.com` |
| dev | 6001 | `nexus_dev` | `dev.api.nexus.codeimplants.com` |

Port 6000 is a *different, older* version-control service (`api-version-control.codeimplants.com`)
that older app builds still call. It is not this codebase's concern, but **do not assume 6000 is
free and do not switch it off** — shipped binaries depend on it.

---

## `/sdk/version/check` is a frozen, load-bearing contract

Every published app calls it through `@codeimplants/version-control`, and those binaries cannot be
updated on demand. It also delivers force-update and the kill switch, so **breaking it removes the
only remedy for a bad release**. Additive changes (new *optional* request fields, new response
fields) are safe. Anything else needs a new version at `/sdk/v1/*`. See `docs/api-versioning.md`.

### Identification is deliberately two-way — do not "tidy" this

`SdkService.resolveAppForVersionCheck()` accepts **either** the `x-api-key` header **or** the
package name in `VersionCheckDto.appId`. This looks like a security hole and is not:

- Sonebill 1.0.15 shipped with an empty API key and was unreachable for twelve days. The mechanism
  that fixes broken releases must not itself depend on a value a build can ship blank.
- The package name is written into the binary by the platform, is auto-detected natively by the SDK
  (`VCAppInfo`, `react-native-device-info`) with no configuration, and cannot be misconfigured.
- `version/check` is a read. It reveals only whether a newer version exists.

**The fallback is confined to `version/check`.** `/sdk/device`, `/sdk/events` and
`/sdk/user/identify` are writes and still require the key via `requireApp()`. Do not extend the
fallback to them, and do not let an *invalid* key fall through to the package name — an invalid key
must be rejected, or a revoked key could be bypassed. Both behaviours have tests-by-inspection in
the commit message of `8fc8118`.

`App.appId` has no unique constraint, so the lookup takes the oldest active match and warns on
duplicates.

---

## Never run `prisma db push`

Use `prisma migrate dev`. `db push` writes schema changes to the database and records nothing, so
the migration history silently stops reproducing reality.

This already happened: four tables (`Device`, `AppAnalytics`, `StoreUrl`, `MaintenanceMode`) and a
dozen columns existed only in the Neon databases. A fresh `migrate deploy` died at
`42P01 relation "Device" does not exist`, and it went unnoticed for months because the only
databases in existence were ones `db push` had already modified. Migrations `20260723000000` and
`20260814000000` reconstruct them by hand.

Verify the chain still reproduces the schema — empty output means correct:

```bash
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
                        --to-schema-datamodel  prisma/schema.prisma --script
```

---

## Database

Self-hosted PostgreSQL 16 on the VPS, `listen_addresses = localhost`, one database per environment,
role `nexus`. Migrated off Neon on 2026-08-14 after three always-on branches burned ~540 CU-hours
against a 100 CU-hour free allowance and compute was suspended.

- `DATABASE_URL` and `DIRECT_URL` are identical — there is no pooler. `DIRECT_URL` is still
  **required**; `schema.prisma` has no fallback and fails with P1012 without it.
- No `sslmode` — connections never leave the box.
- Backups: `~/bin/nexus-db-backup.sh` nightly at 02:30, 14-day retention, verified with
  `pg_restore --list`. **They live on the same disk as the database**, so they cover human error,
  not host loss.

---

## Silent failure is the recurring bug here

Nexus is the observability platform, and it watched two registered apps send nothing for twelve days
without surfacing it. When adding client-facing behaviour, assume the client swallows errors —
because it does, deliberately, so a dead backend cannot crash an app.

- `AppsService.findAll()` returns `lastSeenAt` / `isDark` per app (`DARK_AFTER_HOURS = 48`). An
  active app registered longer ago than that window and not heard from within it is almost certainly
  broken. Surface it; do not let it be something only a database query would reveal.
- `SdkService` counts version checks matching neither identifier and logs a running total at
  intervals. 880 unread single-line errors is what let the last outage go unnoticed — prefer one
  loud periodic line over per-request noise.
- `/health` **does not touch the database**. It returned 200 throughout a total database outage, and
  `scripts/deploy.sh` gates on it, so it would happily green-light a completely broken deploy. If
  you touch the health endpoint, fix this.

---

## Deploying

`./scripts/deploy.sh --env <dev|preprod|prod>`; always pass `--yes` for non-interactive runs or prod
waits on stdin. It deploys `origin/master`, so commit and push first — uncommitted work does not
ship. dev and preprod migrate automatically; prod migrates only with `--migrate` and a typed
confirmation, because a migration is not undone by redeploying older code.
