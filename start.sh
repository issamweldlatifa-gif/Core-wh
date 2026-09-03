#!/usr/bin/env bash
# =============================================================================
# AYROVI Warehouse Core — production start command (Render).
#
# WHY migrations run HERE and not in build.sh
# -------------------------------------------
# Render's build step runs on a build machine and can be retried, cancelled or
# run concurrently with the live service. Applying schema changes there caused
# a real outage: a build aborted midway through
# `20260901175952_warehouse_os_stations_corrections`, leaving the enums created
# but the migration recorded as FAILED. Every later deploy then died with
#
#     P3018 / 42710  type "StationStatus" already exists
#
# and no deploy could ever succeed again. Migrations belong to the release
# phase: once, at boot, against the real database.
#
# Recovery is automatic. If a previous deploy left a failed migration behind,
# we mark it rolled-back and retry ONCE. That is safe because every migration
# in this repo is written to be idempotent (CREATE ... IF NOT EXISTS, ADD VALUE
# IF NOT EXISTS, and DO $$ ... EXCEPTION WHEN duplicate_object $$ guards), so
# re-applying a half-applied migration completes it instead of failing.
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR/backend"

PRISMA="npx --no-install prisma"

echo ">>> Applying database migrations..."
DEPLOY_LOG="$(mktemp)"
trap 'rm -f "$DEPLOY_LOG"' EXIT

if $PRISMA migrate deploy 2>&1 | tee "$DEPLOY_LOG"; then
  echo ">>> Migrations applied."
else
  echo ">>> !!! migrate deploy failed — attempting automatic recovery."

  # On P3009 Prisma names the broken migration explicitly:
  #   The `20260901175952_warehouse_os_stations_corrections` migration ... failed
  # Parse THAT line specifically. Scraping `migrate status` instead would also
  # match merely-pending migrations and roll back the wrong one.
  FAILED="$(grep -oE 'The `[0-9]{14}_[a-zA-Z0-9_]+` migration' "$DEPLOY_LOG" \
            | head -1 | grep -oE '[0-9]{14}_[a-zA-Z0-9_]+' || true)"

  if [ -z "$FAILED" ]; then
    echo ">>> No failed migration named in the output — this is a different"
    echo ">>> error (connectivity, credentials, drift). Not guessing. Aborting."
    exit 1
  fi

  echo ">>> Marking '$FAILED' as rolled back so it can be re-applied."
  echo ">>> (Safe: every migration in this repo is idempotent.)"
  $PRISMA migrate resolve --rolled-back "$FAILED"

  echo ">>> Retrying migrate deploy (once)..."
  $PRISMA migrate deploy
  echo ">>> Recovery successful."
fi

# ---------------------------------------------------------------------------
# SCHEMA-DRIFT SELF-HEAL.
# A half-applied migration that was later marked "applied" leaves the
# _prisma_migrations ledger clean while real tables/columns are MISSING.
# `migrate deploy` then reports "No pending migrations" forever and every
# request touching the missing tables 500s (this happened in production:
# terminal/context, receiving and putaway all failed while health was "ok").
#
# Detect drift by diffing the live database against the Prisma schema; if
# they differ, `prisma db push` creates the missing tables/columns/enums.
# This is additive-safe for our case (missing objects get created); it is
# guarded so it only runs when drift actually exists.
# ---------------------------------------------------------------------------
echo ">>> Verifying database schema matches the Prisma schema..."
set +e
# Output is PRINTED (not discarded) so the boot log shows exactly WHAT drifted
# — or why the check itself failed (a silent /dev/null here hid a failure once).
$PRISMA migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code
DIFF_CODE=$?
set -e

if [ "$DIFF_CODE" = "2" ]; then
  echo ">>> !!! SCHEMA DRIFT DETECTED: live DB does not match schema.prisma."
  echo ">>> Repairing with 'prisma db push' (creates missing tables/columns)..."
  # NO --accept-data-loss: if the repair would destroy data, push aborts and
  # we boot anyway (drifted but alive) so an operator can intervene manually.
  if $PRISMA db push --skip-generate; then
    echo ">>> Schema repaired."
  else
    echo ">>> WARNING: automatic repair refused (would lose data)."
    echo ">>> Manual action required: npx prisma db push --accept-data-loss"
  fi
elif [ "$DIFF_CODE" = "0" ]; then
  echo ">>> Schema OK."
else
  # The diff check itself failed (e.g. the Prisma CLI could not run the
  # datamodel comparison in this environment). Do NOT trust the ledger in that
  # case: fall back to a direct probe of the objects production actually 500s
  # on. If any is missing, repair with db push exactly as above.
  echo ">>> WARNING: schema diff check errored (code $DIFF_CODE)."
  echo ">>> Falling back to a direct probe of known drift-prone objects..."
  PROBE_SQL="SELECT 1 FROM information_schema.tables WHERE table_name='putaway_sessions'; SELECT 1 FROM information_schema.tables WHERE table_name='carton_placements'; SELECT 1 FROM information_schema.tables WHERE table_name='stations'; SELECT 1 FROM information_schema.columns WHERE table_name='warehouse_cartons' AND column_name='currentLocationId'; SELECT 1 FROM information_schema.columns WHERE table_name='receiving_sessions' AND column_name='stationId';"
  PROBE_OUT="$(echo "$PROBE_SQL" | $PRISMA db execute --stdin --url "$DATABASE_URL" 2>&1)" || PROBE_OUT="PROBE_FAILED"
  # `db execute` returns no row data; use a Node probe via the generated client
  # instead, which we know exists because the app is about to boot with it.
  MISSING="$(node -e '
    const { PrismaClient } = require("@prisma/client");
    const p = new PrismaClient();
    (async () => {
      const rows = await p.$queryRawUnsafe(`
        SELECT
          (SELECT COUNT(*) FROM information_schema.tables  WHERE table_name = $$putaway_sessions$$)  AS t1,
          (SELECT COUNT(*) FROM information_schema.tables  WHERE table_name = $$carton_placements$$) AS t2,
          (SELECT COUNT(*) FROM information_schema.tables  WHERE table_name = $$stations$$)          AS t3,
          (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = $$warehouse_cartons$$  AND column_name = $$currentLocationId$$) AS c1,
          (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = $$receiving_sessions$$ AND column_name = $$stationId$$)         AS c2
      `);
      const r = rows[0];
      const missing = Object.values(r).some((v) => Number(v) === 0);
      console.log(missing ? "MISSING" : "OK");
      await p.$disconnect();
    })().catch((e) => { console.log("PROBE_ERROR"); process.exit(0); });
  ' 2>/dev/null || echo PROBE_ERROR)"
  echo ">>> Probe result: $MISSING"
  if [ "$MISSING" = "MISSING" ]; then
    echo ">>> !!! SCHEMA DRIFT CONFIRMED BY PROBE — repairing with db push..."
    if $PRISMA db push --skip-generate; then
      echo ">>> Schema repaired."
    else
      echo ">>> WARNING: automatic repair refused (would lose data)."
      echo ">>> Manual action required: npx prisma db push --accept-data-loss"
    fi
  else
    echo ">>> Probe found no missing objects (or could not run); continuing."
  fi
fi

# The seed is idempotent (upserts) and only creates the initial SUPER_ADMIN
# when INITIAL_ADMIN_CODE + INITIAL_ADMIN_PASSWORD are present. A seed failure
# must never stop the service from booting.
#
# If the operator never configured a password we generate a random one so a
# fresh deploy still has a working login, and print it once in the boot log.
# (Carried over from build.sh, where this used to live.)
export INITIAL_ADMIN_CODE="${INITIAL_ADMIN_CODE:-ADMIN001}"
GENERATED_PASSWORD=""
if [ -z "${INITIAL_ADMIN_PASSWORD:-}" ]; then
  GENERATED_PASSWORD="$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-18)"
  export INITIAL_ADMIN_PASSWORD="$GENERATED_PASSWORD"
  echo ">>> NOTE: INITIAL_ADMIN_PASSWORD not set; generated a random one."
fi

echo ">>> Seeding (idempotent)..."
npm run db:seed || echo ">>> WARNING: seed failed (non-fatal)."

if [ -n "$GENERATED_PASSWORD" ]; then
  echo ">>> >>> INITIAL ADMIN LOGIN <<<"
  echo ">>> >>>   code:     ${INITIAL_ADMIN_CODE}"
  echo ">>> >>>   password: ${GENERATED_PASSWORD}"
  echo ">>> >>> Set INITIAL_ADMIN_PASSWORD in Render to pin this value."
fi

echo ">>> Starting API..."
exec node dist/main.js
