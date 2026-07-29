# Analytics — nexus-backend

Nexus is the internal multi-app admin/telemetry platform. This doc explains
its analytics architecture and, critically, **what it deliberately does not
track** — read the "Firebase does this, not us" section before adding any
new metric here.

## The core principle

Nexus only builds what Firebase Analytics (GA4) categorically cannot do:
federated admin actions, business-data federation, and cross-app dashboards.
Anything that's "what are users doing in the app" (screen views, session
engagement, retention curves, device/OS breakdown) is Firebase's job, done
once per client app via `@codeimplants/analytics`, and pulled into Nexus's
dashboards server-side via the GA4 Data API — not re-derived from raw events
here. See `sonebill-mobile/ANALYTICS.md` for the client-side half of this.

## Data model (`prisma/schema.prisma`)

- **`App`** — one row per registered app (SoneBill, Sonetaran, ...).
  Federation config: `backendBaseUrl` / `backendServiceToken` (encrypted,
  `common/crypto/service-token-cipher.ts`) / `backendUsersPath` /
  `backendDeleteUserPath` — how Nexus reaches that app's own backend.
  `ga4PropertyId` — that app's GA4 property, for the Firebase pull below (not
  a secret, not encrypted).
- **`Device`** / **`EndUser`** / **`UsageSession`** / **`DailyUsage`** —
  populated by each app's mobile client calling `/sdk/device`,
  `/sdk/user/identify`, and `/sdk/events` (`app_open`/`app_background` only —
  see `modules/sdk/sdk.service.ts`'s `handleEvent`). This is intentionally
  thin: enough to drive admin actions (who's inactive, who's a lead), not a
  usage-analytics pipeline. Other event names (`screen_view`,
  `login_success`, `logout`) are accepted but only touch
  `EndUser.lastActiveAt` — **do not** add a table to persist them; that's
  exactly the duplication this architecture avoids.
- **`AppAnalytics`** — one row per version check (`/sdk/version/check`),
  `eventType` ∈ `version_check | update_soft | update_force | kill_switch |
  blocked | maintenance`. Unrelated to Firebase — this is telemetry about
  Nexus's own version-control/kill-switch feature, which no other system
  tracks. `logAnalytics` in `sdk.service.ts` maps `VersionEngine`'s uppercase
  status to this lowercase taxonomy — if you add a new `VersionEngine`
  status, add it to `SdkService.EVENT_TYPE_BY_STATUS` too, or it'll leak
  through unmapped.

## Federation (`modules/app-admin/app-admin.service.ts`)

`AppAdminService` is the proxy layer to each app's own backend:
`proxy()` (generic passthrough, `ALL admin/apps/:id/backend/*`),
`purgeUsers()` (Bulk Cleanup — deletes via the app's own
`backendDeleteUserPath`, one call per user, *then* drops Nexus's own
`EndUser` row; writes one `AuditLog` entry per batch), `fetchUserProfiles()`
(resolves pseudonymous `externalUserId`s to real phone/name for Leads/
Engagement, tolerant of a few field-name spellings). This is the layer that
does what Firebase can't: take action on a specific app's real user records.

## Firebase (GA4) federation (`modules/firebase-analytics/`)

`FirebaseAnalyticsService` pulls real numbers from each app's own Firebase
project via `@google-analytics/data`'s `BetaAnalyticsDataClient`:
`getOverview` (active users, engaged sessions, avg engagement time),
`getTopScreens` (screen popularity), `getRetention` (D-N cohort retention via
GA4's native `cohortSpec`). Exposed at
`admin/analytics/apps/:appId/firebase/{overview,top-screens,retention}`.

**Auth model — read before touching this**: one shared, Nexus-wide GA4
reporting service account (its key lives outside the DB, at
`GA4_SERVICE_ACCOUNT_KEY_PATH`), not a credential per app. To light up an
app's widgets: (1) set `App.ga4PropertyId` via Applications → Backend
Integration, (2) grant that shared service account's email "Viewer" access
on the app's GA4 property in Firebase Console → Property Access Management.
Every endpoint reports `connected: false` (never throws) when either step
isn't done — the frontend renders an empty state, not an error.

## Growth / churn (`modules/analytics/analytics.service.ts::getGrowth`)

The one piece of "reporting" Nexus keeps for itself:
`totalUsers/newThisWeek/newThisMonth/neverActive/churned/active`, at
`admin/analytics/apps/:appId/growth`. This is deliberately not a Firebase
duplicate — it's the exact targeting logic Bulk Cleanup uses
(`lastActiveAt` vs. `churnDays`), made visible as labeled numbers instead of
a raw list. `neverActive` is computed as zero `DailyUsage` rows ever, not a
`lastActiveAt === registeredAt` proxy (which breaks the moment any non-session
event touches `lastActiveAt`).

## What NOT to add here

- A table for raw/custom SDK events (screen views, feature usage). Firebase
  already has this, per-app, for free.
- A retention or DAU/MAU computation from `DailyUsage`. Use the GA4 pull
  instead once the app's `ga4PropertyId` is set.
- Business/financial data (bills, sales, invoices) as Nexus schema. That
  stays in each app's own backend, pulled live via `AppAdminService.proxy` by
  that app's bespoke dashboard page — see `nexus-frontend/ANALYTICS.md`.
