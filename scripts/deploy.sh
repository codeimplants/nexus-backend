#!/usr/bin/env bash
#
# Deploys nexus-backend to the VPS.
#
# Usage:
#   ./scripts/deploy.sh --inspect                  # report server state, change nothing
#   ./scripts/deploy.sh --env preprod              # build + migrate + restart preprod
#   ./scripts/deploy.sh --env prod --yes           # prod without the confirm prompt
#   ./scripts/deploy.sh --env prod --migrate       # prod INCLUDING schema migration
#   ./scripts/deploy.sh --env prod --dry-run       # print remote commands, run none
#   ./scripts/deploy.sh --env dev --restart-only   # restart, no pull/build/migrate
#
# Flags:
#   --env <dev|preprod|prod>  Target environment. Required (except --inspect).
#   --yes                     Skip the production confirmation. ALWAYS pass this for
#                             automated/AI runs — otherwise prod waits on stdin and hangs.
#   --migrate                 Run `prisma migrate deploy` on PROD. Ignored elsewhere
#                             (dev/preprod always migrate). Requires typed confirmation.
#   --dry-run                 Show the remote script; make no changes.
#   --restart-only            Skip git pull / npm ci / build / migrate; just restart.
#   --inspect                 Read-only survey of the server.
#   --check-migrations        With --env: list migrations this deploy would apply
#                             and exit. Changes nothing. Exit 0 = none pending,
#                             10 = some pending (so a wrapper can branch on it).
#
# Each environment runs from its own checkout, so a build for one cannot affect
# another. Deploying to dev or preprod is a genuine rehearsal for prod.
#
#   nexus-backend-prod     NODE_ENV=prod     PORT=6003
#   nexus-backend-preprod  NODE_ENV=preprod  PORT=6002
#   nexus-backend-dev      NODE_ENV=dev      PORT=6001
#
# Prod is 6003, NOT 6000. This comment said 6000 until 2026-08-17, while
# deploy.config.sh had 6003 all along — the config is what runs, so the script
# always deployed correctly and only the documentation lied. That still mattered:
# 6000 is a different, older version-control service that shipped binaries depend
# on (see CLAUDE.md), so anyone reading this during an incident would have gone
# looking at the wrong process, or worse, restarted it. The ports are defined once
# in deploy.config.sh and must stay in sync with ecosystem.config.js.
#
# DATABASE MIGRATIONS
#   dev/preprod : `prisma migrate deploy` runs automatically — rehearse there first.
#   prod        : only with --migrate, and only after typing 'migrate'. A migration
#                 alters a live database and is not covered by the code rollback
#                 path (redeploying an older commit does NOT undo a migration).
#
# Secrets: each checkout holds its own .env on the server and is never
# read or transported by this script.

set -euo pipefail

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; CYA=$'\033[0;36m'; NC=$'\033[0m'
info() { printf '%s%s%s\n' "$CYA" "$*" "$NC"; }
ok()   { printf '%s%s%s\n' "$GRN" "$*" "$NC"; }
warn() { printf '%s%s%s\n' "$YEL" "$*" "$NC"; }
die()  { printf '%s%s%s\n' "$RED" "ERROR: $*" "$NC" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/scripts/deploy.config.sh"

ENV_NAME=""; ASSUME_YES=0; DRY_RUN=0; RESTART_ONLY=0; INSPECT=0; MIGRATE_PROD=0; CHECK_MIGRATIONS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)          ENV_NAME="${2:-}"; shift 2 ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
    --migrate)      MIGRATE_PROD=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --restart-only) RESTART_ONLY=1; shift ;;
    --inspect)      INSPECT=1; shift ;;
    --check-migrations) CHECK_MIGRATIONS=1; shift ;;
    -h|--help)      sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "Unknown argument: $1  (try --help)" ;;
  esac
done

[[ -f "$CONFIG" ]] || die "Missing $CONFIG
  cp scripts/deploy.config.example.sh scripts/deploy.config.sh"
# shellcheck source=/dev/null
source "$CONFIG"
[[ -n "${DEPLOY_SSH_HOST:-}" ]] || die "DEPLOY_SSH_HOST not set in $CONFIG"
[[ -n "${APP_USER:-}" ]] || die "APP_USER not set in $CONFIG"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$DEPLOY_SSH_HOST" true 2>/dev/null \
  || die "Cannot SSH to '$DEPLOY_SSH_HOST'. Check ~/.ssh/config and that your key is authorised."

# Run a command on the server as the account that owns the checkout. Running as
# root breaks git ("dubious ownership") and leaves root-owned files behind.
as_app_user() { printf 'sudo -u %s -H bash -lc %q' "$APP_USER" "$1"; }

# --- inspect ------------------------------------------------------------------
if [[ $INSPECT -eq 1 ]]; then
  info "Inspecting $DEPLOY_SSH_HOST (read-only)..."
  ssh "$DEPLOY_SSH_HOST" "$(as_app_user "
    echo '=== pm2 ==='; pm2 list
    for d in '$DEV_APP_DIR' '$PREPROD_APP_DIR' '$PROD_APP_DIR'; do
      echo; echo \"=== \$d ===\"
      if [ ! -d \"\$d\" ]; then echo 'MISSING'; continue; fi
      cd \"\$d\"
      echo 'branch:     '\$(git rev-parse --abbrev-ref HEAD)
      echo 'commit:     '\$(git log -1 --oneline)
      echo '.env:       '\$([ -f .env ] && echo present || echo MISSING)
      echo 'dist:       '\$([ -f dist/main.js ] && date -r dist/main.js '+%Y-%m-%d %H:%M' || echo MISSING)
      echo 'migrations: '\$(ls prisma/migrations 2>/dev/null | grep -c '^2' || echo 0)' on disk'
    done
    echo; echo '=== node ==='; node -v
  ")"
  ok "Inspection complete — nothing changed."
  exit 0
fi

# Migrations this deploy would apply: those present in origin/$BRANCH but not
# recorded as finished in the target database.
#
# Exists because the alternative is asking a human "does this deploy contain a
# schema change?" and trusting the answer. Answering "no" when it does leaves
# the app running against the old schema, and it errors. The facts are on the
# server, so read them instead of asking.
#
# Deliberately compares the fetched branch against the database rather than
# running `prisma migrate status`: that reads the checkout's *current* files,
# which are still the old commit at this point in the deploy and so cannot see
# anything incoming. Nothing here writes — no reset, no checkout.
pending_migrations() {
  ssh "$DEPLOY_SSH_HOST" "$(as_app_user "
    set -euo pipefail
    cd '$APP_DIR'
    git fetch --quiet origin '$BRANCH' 2>/dev/null

    incoming=\$(git ls-tree -d --name-only 'origin/$BRANCH' prisma/migrations/ 2>/dev/null \
      | sed 's|prisma/migrations/||' | grep -E '^[0-9]' | sort || true)

    url=\$(grep -E '^DIRECT_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\"' || true)
    if [ -z \"\$url\" ]; then echo '__NO_DIRECT_URL__'; exit 0; fi

    applied=\$(psql \"\$url\" -tAc \\
      'SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL' \
      2>/dev/null | sed '/^\$/d' | sort || true)
    if [ -z \"\$applied\" ]; then echo '__NO_DB__'; exit 0; fi

    comm -23 <(echo \"\$incoming\") <(echo \"\$applied\")
  ")" 2>/dev/null || true
}

# --- check-migrations ---------------------------------------------------------
if [[ $CHECK_MIGRATIONS -eq 1 ]]; then
  [[ -n "$ENV_NAME" ]] || die "--check-migrations needs --env <dev|preprod|prod>"
  case "$ENV_NAME" in
    dev)     APP_DIR="$DEV_APP_DIR" ;;
    preprod) APP_DIR="$PREPROD_APP_DIR" ;;
    prod)    APP_DIR="$PROD_APP_DIR" ;;
    *)       die "Invalid --env '$ENV_NAME'" ;;
  esac
  PENDING="$(pending_migrations)"
  if [[ "$PENDING" == *__NO_DIRECT_URL__* ]]; then
    warn "Could not read DIRECT_URL from $APP_DIR/.env — cannot tell what is pending."
    exit 1
  fi
  if [[ "$PENDING" == *__NO_DB__* ]]; then
    warn "Could not reach the $ENV_NAME database — cannot tell what is pending."
    exit 1
  fi
  if [[ -z "${PENDING//[[:space:]]/}" ]]; then
    ok "No pending migrations for '$ENV_NAME' — this deploy contains no schema change."
    exit 0
  fi
  warn "Pending migration(s) for '$ENV_NAME':"
  printf '%s\n' "$PENDING" | sed 's/^/    /'
  exit 10
fi

[[ -n "$ENV_NAME" ]] || die "--env is required (dev|preprod|prod). Try --inspect first."
case "$ENV_NAME" in
  dev)     APP_DIR="$DEV_APP_DIR";     PM2_NAME="$DEV_PM2_NAME";     PORT="$DEV_PORT" ;;
  preprod) APP_DIR="$PREPROD_APP_DIR"; PM2_NAME="$PREPROD_PM2_NAME"; PORT="$PREPROD_PORT" ;;
  prod)    APP_DIR="$PROD_APP_DIR";    PM2_NAME="$PROD_PM2_NAME";    PORT="$PROD_PORT" ;;
  *)       die "Invalid --env '$ENV_NAME'" ;;
esac
[[ -n "$APP_DIR" ]] || die "APP_DIR for '$ENV_NAME' not set in $CONFIG"

# --- local guards -------------------------------------------------------------
if [[ $RESTART_ONLY -eq 0 ]]; then
  if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
    die "Uncommitted local changes. The server deploys origin/$BRANCH, so your
uncommitted work would NOT ship — deployed code would silently differ from what
you tested. Commit or stash first."
  fi
  git -C "$ROOT" fetch --quiet origin "$BRANCH"
  if [[ "$(git -C "$ROOT" rev-parse HEAD)" != "$(git -C "$ROOT" rev-parse "origin/$BRANCH")" ]]; then
    warn "Local HEAD differs from origin/$BRANCH — the server deploys origin/$BRANCH."
    warn "Push first if you meant to ship your local commits."
    # --dry-run must never block on input: it exists to be safe to run anywhere,
    # including non-interactively, where a read would hang until timeout.
    [[ $ASSUME_YES -eq 1 || $DRY_RUN -eq 1 ]] \
      || { read -r -p "Continue anyway? [y/N] " a; [[ "$a" =~ ^[Yy]$ ]] || exit 1; }
  fi
fi

# --- migration policy ---------------------------------------------------------
# dev/preprod migrate automatically (that is where a migration gets rehearsed).
# prod migrates only when explicitly asked, because `migrate deploy` alters a
# live database and redeploying an older commit does NOT roll it back.
RUN_MIGRATE=0
if [[ $RESTART_ONLY -eq 0 ]]; then
  if [[ "$ENV_NAME" == "prod" ]]; then
    if [[ $MIGRATE_PROD -eq 1 ]]; then
      RUN_MIGRATE=1
      if [[ $ASSUME_YES -eq 0 && $DRY_RUN -eq 0 ]]; then
        warn "This will run 'prisma migrate deploy' against the PRODUCTION database."
        warn "Pending migrations are applied and CANNOT be undone by redeploying older code."
        read -r -p "Type 'migrate' to continue: " a
        [[ "$a" == "migrate" ]] || { info "Aborted."; exit 1; }
      fi
    else
      # "If this commit needs a schema change" used to be left to the operator to
      # know. It is knowable, so check rather than warn vaguely.
      PENDING="$(pending_migrations)"
      if [[ "$PENDING" == *__NO_* ]]; then
        warn "Prod deploy WITHOUT migrations, and it was not possible to check whether any"
        warn "are pending (database unreachable, or DIRECT_URL missing from .env)."
      elif [[ -z "${PENDING//[[:space:]]/}" ]]; then
        info "No pending migrations — this commit contains no schema change."
      else
        warn "Prod deploy WITHOUT migrations, but these ARE pending:"
        printf '%s\n' "$PENDING" | sed 's/^/    /'
        warn "Deploying now leaves the app on the old schema and it will error."
        warn "Re-run with --migrate to include them."
        [[ $ASSUME_YES -eq 1 || $DRY_RUN -eq 1 ]] \
          || { read -r -p "Continue anyway? [y/N] " a; [[ "$a" =~ ^[Yy]$ ]] || { info "Aborted."; exit 1; }; }
      fi
    fi
  else
    RUN_MIGRATE=1
  fi
fi

# --- confirmation -------------------------------------------------------------
# Only prod needs typed confirmation: each environment has its own checkout, so
# deploying dev or preprod cannot affect what prod is running.
if [[ "$ENV_NAME" == "prod" && $ASSUME_YES -eq 0 && $DRY_RUN -eq 0 ]]; then
  warn "About to deploy to PRODUCTION ($DEPLOY_SSH_HOST:$APP_DIR, pm2 '$PM2_NAME')."
  warn "Commit: $(git -C "$ROOT" log -1 --oneline "origin/$BRANCH" 2>/dev/null || echo unknown)"
  read -r -p "Type 'deploy' to continue: " a
  [[ "$a" == "deploy" ]] || { info "Aborted."; exit 1; }
fi

if [[ $RESTART_ONLY -eq 1 ]]; then
  BUILD_STEPS="echo '--- restart only: skipping pull/install/build/migrate ---'"
else
  MIGRATE_STEP="echo '--- skipping migrations ---'"
  [[ $RUN_MIGRATE -eq 1 ]] && MIGRATE_STEP="echo '--- prisma migrate deploy ---'
npx prisma migrate deploy"

  BUILD_STEPS="echo '--- fetching $BRANCH ---'
git fetch --quiet origin '$BRANCH'
git reset --hard 'origin/$BRANCH'
echo 'now at: '\$(git log -1 --oneline)
npm ci
npx prisma generate
$MIGRATE_STEP
npm run build"
fi

REMOTE="set -euo pipefail
cd '$APP_DIR'
echo 'was at: '\$(git log -1 --oneline)
test -f .env || { echo 'ERROR: .env missing in $APP_DIR — refusing to restart'; exit 1; }
$BUILD_STEPS
pm2 restart '$PM2_NAME' --update-env
pm2 describe '$PM2_NAME' | grep -E 'status|restarts' || true"

if [[ $DRY_RUN -eq 1 ]]; then
  warn "DRY RUN — would run on $DEPLOY_SSH_HOST as $APP_USER:"
  printf '%s\n' "$REMOTE"
  exit 0
fi

info "Deploying '$ENV_NAME' → $DEPLOY_SSH_HOST:$APP_DIR (pm2: $PM2_NAME) ..."
[[ $RUN_MIGRATE -eq 1 ]] && info "Migrations: WILL RUN" || info "Migrations: skipped"
ssh "$DEPLOY_SSH_HOST" "$(as_app_user "$REMOTE")"

if [[ -n "${HEALTH_PATH:-}" ]]; then
  # Poll rather than sleep-once: a cold Neon connection plus Nest bootstrap can
  # take ~20s, so a single early probe reports a false failure on a deploy that
  # actually succeeded. Capture only the last line and never append a fallback
  # to curl's own output, or a connection refusal reads as "000000".
  HEALTH_RETRIES="${HEALTH_RETRIES:-12}"
  HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"
  info "Health check on 127.0.0.1:$PORT$HEALTH_PATH (up to $((HEALTH_RETRIES * HEALTH_INTERVAL))s) ..."
  CODE="000"
  for attempt in $(seq 1 "$HEALTH_RETRIES"); do
    sleep "$HEALTH_INTERVAL"
    CODE="$(ssh "$DEPLOY_SSH_HOST" \
      "curl -s -o /dev/null -w '%{http_code}' --max-time 10 'http://127.0.0.1:$PORT$HEALTH_PATH' 2>/dev/null || true" \
      | tail -n1 | tr -dc '0-9')"
    [[ -z "$CODE" ]] && CODE="000"
    [[ "$CODE" =~ ^[23] ]] && break
    info "  attempt $attempt/$HEALTH_RETRIES: HTTP $CODE — still starting ..."
  done

  if [[ "$CODE" =~ ^[23] ]]; then
    ok "Health check passed (HTTP $CODE)."
  else
    die "Health check FAILED (HTTP $CODE) — process restarted but is not serving.
  ssh $DEPLOY_SSH_HOST \"sudo -u $APP_USER -H pm2 logs $PM2_NAME --lines 50\""
  fi
fi

ok "Deployed '$ENV_NAME'."
