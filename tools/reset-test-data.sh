#!/bin/bash
# ============================================================================
# AYROVI — TEST DATA RESET
# 
# Shell wrapper for the cleanup script.
#
# Usage:
#   ./tools/reset-test-data.sh              # Full audit + cleanup (interactive)
#   ./tools/reset-test-data.sh --dry-run    # Audit only, no deletions
#   ./tools/reset-test-data.sh --force      # Skip confirmation prompt
#   ./tools/reset-test-data.sh --dry-run --force
#
# Environment:
#   DATABASE_URL — PostgreSQL connection string (required)
#   INITIAL_ADMIN_CODE — Admin code to preserve (default: ADMIN001)
#   SEED_WORKER_PASSWORD — Password for the TEST_WORKER (default: TestWorker!2024)
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env if it exists
if [ -f "$PROJECT_ROOT/backend/.env" ]; then
  export $(grep -v '^#' "$PROJECT_ROOT/backend/.env" | xargs 2>/dev/null || true)
elif [ -f "$PROJECT_ROOT/.env" ]; then
  export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs 2>/dev/null || true)
fi

if [ -z "$DATABASE_URL" ]; then
  echo ""
  echo "❌ ERROR: DATABASE_URL is not set."
  echo ""
  echo "Please set it before running:"
  echo "  export DATABASE_URL=\"postgresql://user:pass@host:5432/ayrovi_warehouse\""
  echo ""
  echo "Or create a .env file at backend/.env with:"
  echo "  DATABASE_URL=postgresql://ayrovi:ayrovi_dev@localhost:5432/ayrovi_warehouse"
  echo ""
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  AYROVI — TEST DATA RESET"
echo "  Database: $(echo $DATABASE_URL | sed 's/:[^@]*@/:***@/')"
echo "  Args:     $@"
echo "═══════════════════════════════════════════════════════════════"
echo ""

cd "$PROJECT_ROOT/backend"

# Check if tsx is available, otherwise fall back to ts-node
if npx tsx --version >/dev/null 2>&1; then
  npx tsx "$SCRIPT_DIR/test-data-reset-pg.ts" "$@"
elif npx ts-node --version >/dev/null 2>&1; then
  npx ts-node --compiler-options '{"module":"commonjs"}' "$SCRIPT_DIR/test-data-reset-pg.ts" "$@"
else
  echo "❌ ERROR: Neither tsx nor ts-node is available."
  echo "   Install tsx: npm install -D tsx"
  exit 1
fi
