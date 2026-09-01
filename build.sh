#!/usr/bin/env bash
# =============================================================================
# AYROVI Warehouse Core — single-bundle production build (for Render).
#
# Why a dedicated script instead of a one-liner in render.yaml?
#   Render sets NODE_ENV=production during the build. With that value a plain
#   `npm install` SKIPS devDependencies (vite, typescript, @types/*, ts-node),
#   which is what caused the recurring "TS2308", "TS7026" and "vite: not found"
#   build failures. This script installs devDependencies EXPLICITLY so the
#   build is deterministic and independent of NODE_ENV.
#
# Pipeline:
#   1. Build the React SPA (frontend -> frontend/dist)
#   2. Install + generate Prisma client + build the NestJS backend
#   3. Copy the freshly built SPA into backend/public (single-bundle model)
#
# The build NO LONGER touches the database. Migrations and seeding moved to
# ./start.sh (the release phase). A build that half-applied a migration and
# then aborted left the production database permanently wedged with
# P3018 / 42710 "type StationStatus already exists"; the build machine is the
# wrong place to mutate a live schema.
# =============================================================================
set -euo pipefail

# Work relative to this script's directory (the repo root).
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo ">>> [1/4] Installing frontend dependencies (dev + prod)..."
cd "$ROOT_DIR/frontend"
npm install --include=dev

echo ">>> [2/4] Building the React SPA..."
npm run build

echo ">>> [3/4] Installing backend dependencies (dev + prod)..."
cd "$ROOT_DIR/backend"
npm install --include=dev

echo ">>> [4/4] Generating Prisma client + building backend..."
npx prisma generate
npm run build

echo ">>> Copying SPA into backend/public (single-bundle)..."
rm -rf public
mkdir -p public
cp -r "$ROOT_DIR/frontend/dist/." public/

echo ">>> BUILD COMPLETE."
echo ">>> Database migrations + seeding run at boot, via ./start.sh"
