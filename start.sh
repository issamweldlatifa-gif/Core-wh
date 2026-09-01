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
