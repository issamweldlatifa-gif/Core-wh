#!/usr/bin/env bash
# Controlled production boot. Never repair/resolve migrations or print credentials automatically.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR/backend"
: "${DATABASE_URL:?DATABASE_URL must be configured by the deployment environment}"
: "${JWT_ACCESS_SECRET:?JWT_ACCESS_SECRET must be configured}"
: "${JWT_REFRESH_SECRET:?JWT_REFRESH_SECRET must be configured}"

echo ">>> Applying reviewed database migrations..."
npx --no-install prisma migrate deploy

echo ">>> Checking schema compatibility..."
set +e
npx --no-install prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
schema_status=$?
set -e
if [ "$schema_status" -ne 0 ]; then
  echo ">>> Schema verification failed. Boot is stopped; use the reviewed backup/recovery procedure."
  exit 1
fi

# Initial credentials/seed execution is an explicit operator action. No generated password in logs.
if [ "${AYROVI_RUN_SEED:-false}" = "true" ]; then
  : "${INITIAL_ADMIN_CODE:?Explicit bootstrap requires INITIAL_ADMIN_CODE}"
  : "${INITIAL_ADMIN_PASSWORD:?Explicit bootstrap requires INITIAL_ADMIN_PASSWORD in the secret store}"
  echo ">>> Running approved idempotent seed..."
  npm run db:seed
fi

echo ">>> Starting API..."
exec node dist/main.js
