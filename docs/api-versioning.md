# API versioning and migration plan

## Why this exists

Apps installed from the App Store and Play Store call this backend on a fixed
contract, and **those binaries cannot be updated on demand**. A user who never
updates keeps calling today's endpoints, with today's request and response
shapes, indefinitely.

Concretely: `@codeimplants/version-control` in every shipped build posts to
`https://api.version.control.codeimplants.com/sdk/version/check`. That call
drives version gating, **force-update and the kill switch** — the very levers
you would need to fix a bad release. If it breaks, it breaks in the one
situation where you most need it, and you cannot push a fix to the affected
installs.

This document is the set of rules that lets the API keep evolving without
stranding those users.

## The core split

Not every endpoint needs the same rigour. The single most useful decision is to
classify each route:

| Class | Routes | Callers | Rule |
|---|---|---|---|
| **Public / SDK** | `/sdk/*` | Shipped app binaries | **Frozen contract.** Additive changes only, versioned when a breaking change is genuinely needed |
| **Internal / admin** | `/admin/*`, `/auth/*` | The Nexus admin panel only | Free to change — panel and backend deploy together |

Applying SDK-grade rigour to `/admin/*` would slow you down for no benefit: the
only client is the panel you control and ship at the same time. Applying
admin-grade freedom to `/sdk/*` breaks phones in the field.

## Current inventory

| Endpoint | Class | In shipped apps? | Status |
|---|---|---|---|
| `POST /sdk/version/check` | Public | **Yes** | **Frozen.** Never change the response shape |
| `GET /sdk/stats` | Public | No (server-to-server) | Low risk |
| `POST /sdk/device` | Public | **Not yet** | Shapeable **now** |
| `POST /sdk/events` | Public | **Not yet** | Shapeable **now** |
| `POST /sdk/user/identify` | Public | **Not yet** | Shapeable **now** |
| `/admin/**`, `/auth/**` | Internal | No | Change freely |

The three new endpoints are the important row. They are not in any released
build yet, so **this is the last moment they can be reshaped for free**. The
first app release that calls them freezes them on the same terms as
`/sdk/version/check`.

## What counts as a breaking change

Safe on a frozen endpoint:

- Adding a new **optional** request field (server must keep working without it)
- Adding a new field to a response (old clients ignore unknown keys)
- Adding a new endpoint
- Relaxing validation, widening an accepted enum
- Performance and internal refactors

Breaking — requires a new version:

- Removing or renaming any request or response field
- Changing a field's type, or its meaning for the same value
- Making an optional request field required, or tightening validation
- Changing status codes or error shapes clients branch on
- Changing defaults (an omitted field must keep behaving as it always did)

The subtle one is **changing meaning without changing shape**. If `durationSec`
silently became `durationMs`, every old client keeps parsing it and every number
becomes wrong. That is a breaking change even though the schema is identical.

## Versioning scheme

Use a **URI path prefix** for the SDK surface: `/sdk/v1/...`.

Chosen over header-based negotiation because it is visible in logs and nginx,
trivially routable, easy to curl, and simple for a small team to reason about.
Header negotiation is more elegant and strictly worse to operate here.

Rules:

- **Today's unversioned `/sdk/*` routes are "v0" and are permanent.** Do not
  retro-fit a prefix onto them — that is itself the breaking change you are
  trying to avoid.
- New SDK work lands under `/sdk/v1/*`.
- A version is retired only on evidence (below), never on a schedule.
- The client SDK package major version tracks the endpoint version it targets,
  so `@codeimplants/version-control@2.x` → `/sdk/v1/*`.

## Migration phases

### Phase 1 — Freeze and document (now)

- Treat `/sdk/version/check` as immutable. Add a comment in `sdk.controller.ts`
  saying so, because the next person will not know.
- Keep `api.version.control.codeimplants.com` resolving **forever**. It is
  already served alongside `api.nexus.codeimplants.com` in the same nginx
  server block, at zero cost.
- No code change. This phase is a decision, not a deployment.

### Phase 2 — Settle the new endpoints before they ship

While `/sdk/device`, `/sdk/events` and `/sdk/user/identify` are unreleased,
review them once with the knowledge that this is the last free change:

- `events[].ts` is client-supplied. Clock skew is real on phones — decide now
  whether the server clamps implausible timestamps rather than discovering it
  after millions of rows.
- `authMethod` is a free-form string. If it should be an enum, constrain it now;
  widening later is safe, narrowing is not.
- Batch size is capped at 200 by `ArrayMaxSize`. Lowering that cap later is
  breaking for a client that batches aggressively.

### Phase 3 — Ship the client, measure adoption

Release the app with the platform SDK wired up. Then let the data accumulate:
`Device.appVersion` and `AppAnalytics.version` already record which build each
call came from, so adoption is measurable rather than guessed.

### Phase 4 — Introduce `/sdk/v1` only when actually needed

Do not create `v1` pre-emptively. Create it the first time a genuinely breaking
change is required. Then:

1. Add the `v1` route alongside the existing one, sharing the service layer.
2. Ship a client major version targeting `v1`.
3. Leave the old route serving old installs, unchanged.

### Phase 5 — Retire on evidence

A version may be retired when telemetry shows negligible traffic from builds
that use it. Query the data you already collect:

```sql
-- installs still calling the old surface, by app version
SELECT "appVersion", COUNT(*) AS devices, MAX("lastCheckIn") AS last_seen
FROM "Device"
WHERE "appId" = $1 AND "lastCheckIn" > now() - interval '90 days'
GROUP BY "appVersion" ORDER BY devices DESC;
```

Retire only when the affected cohort is negligible **and** those users can still
be forced to update — which requires the version-check endpoint they call to
still work. Never retire the endpoint that delivers the upgrade prompt.

## Production cutover (separate but related)

The same compatibility thinking applies to moving prod onto the new codebase.
Port 6000 currently serves live apps; the new build will run on 6003.

1. Provision `nexus-backend-prod`, its `.env` (prod Neon branch), then
   **baseline** — prod has all the tables but no `_prisma_migrations`, so
   `migrate deploy` would otherwise try `CREATE TABLE "Admin"` and abort:
   ```bash
   npx prisma migrate resolve --applied 20260128070727_create_admin
   npx prisma migrate resolve --applied 20260217125934_add_rbac_and_collaborators
   ```
2. Deploy to 6003 with `./scripts/deploy.sh --env prod --migrate` and verify it
   directly on `127.0.0.1:6003` while **no traffic** points at it.
3. Flip nginx `proxy_pass` for both `api.nexus...` and the legacy
   `api.version.control...` from 6000 to 6003, then `nginx -t` and reload.
4. **Leave the old process on 6000 running.** Rollback is a one-line nginx edit
   plus a reload, not a redeploy.
5. Retire 6000 only after a quiet period.

The migrations are additive (new tables, new nullable columns), so step 1 does
not rewrite existing rows. That is what makes this cutover reversible at the
routing layer — but note that **rolling back code does not roll back a
migration**, which is why prod migrations are gated behind an explicit flag.

## The rule to remember

> Anything a shipped binary can call is permanent. Choose its shape carefully
> the first time, add to it freely, and never take away.
