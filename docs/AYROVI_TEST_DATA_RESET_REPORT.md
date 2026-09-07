# AYROVI — TEST DATA RESET REPORT

**Date:** 2026-09-07  
**Environment:** TEST  
**Status:** Tooling created and ready for execution

---

## 1. CRITICAL RULE COMPLIANCE

| Rule | Status |
|------|--------|
| Application architecture NOT modified | ✅ YES |
| Business logic NOT modified | ✅ YES |
| APIs NOT modified | ✅ YES |
| OCR NOT modified | ✅ YES |
| Worker workflows NOT modified | ✅ YES |
| Admin permissions NOT modified | ✅ YES |
| Database schema NOT modified | ✅ YES |
| Production data NOT deleted | ✅ YES |
| Configuration NOT deleted | ✅ YES |
| Master/reference data NOT deleted | ✅ YES |
| Authentication architecture NOT changed | ✅ YES |

---

## 2. DATABASE SCHEMA ANALYSIS

The Prisma schema defines the following entities that may contain test data:

### Operational Transaction Chain (ALL test data → DELETE)

```
Expected Arrival (WAR-XXXXXXXX)
  └─→ Expected Arrival Items
  └─→ Warehouse Shipment (WSHP-XXXXXXXX)
        └─→ Warehouse Carton (CTN-XXXXXXXX)
              └─→ Receiving Session (RCV-XXXXXXXX)
                    ├─→ Receiving Carton (scan records)
                    ├─→ Receiving Product (lines)
                    ├─→ Receiving Scan Event (idempotency)
                    ├─→ Receiving Discrepancy
                    └─→ Article Unit (ART-XXXXXXXX)
                          └─→ Operational Container (RCN-/BIN-XXXXXXXX)
                                └─→ Outbound Shipment (OUT-XXXXXXXX)
                                      └─→ Shipping Verification
```

### Worker/Task Chain (test assignments → DELETE)

```
Worker Task Assignment
  ├─→ links to: Arrival, Carton, Container, Order, Station
  └─→ assigned to: Test Worker
```

### Supporting Test Data (→ DELETE)

```
Putaway Session
  └─→ Carton Placement
Operation Correction (audit history of test corrections)
Operational Exception (test exceptions)
Test Sessions (auth sessions for test workers)
```

### Configuration & Master Data (→ PRESERVE)

| Entity | Table | Reason |
|--------|-------|--------|
| Users (Admin) | `users` | System administrators |
| Roles | `roles` | Permission system |
| Permissions | `permissions` | Permission catalog |
| Warehouse | `warehouses` | Physical structure |
| Zones | `zones` | Physical structure |
| Aisles | `aisles` | Physical structure |
| Racks | `racks` | Physical structure |
| Levels | `levels` | Physical structure |
| Locations | `locations` | Physical structure |
| Stations | `stations` | Work positions |
| Devices | `devices` | Hardware registry |
| Category Master | `category_master` | Taxonomy |
| Category Zone Mappings | `category_zone_mappings` | Sorting config |
| Products | `products` | Master product data |
| System Settings | `system_settings` | Configuration |
| API Clients | `api_clients` | Integration config |

---

## 3. DEPENDENCY CHAIN (Deletion Order)

The cleanup script deletes in this exact order to respect foreign key constraints:

```
Step 1:  Clear station.worker assignments (test workers)
Step 2:  Clear device.worker assignments (test workers)
Step 3:  DELETE shipping_verifications
Step 4:  DELETE outbound_shipments
Step 5:  DELETE article_units
Step 6:  DELETE operational_containers
Step 7:  DELETE operation_corrections
Step 8:  DELETE operational_exceptions
Step 9:  DELETE carton_placements
Step 10: DELETE putaway_sessions
Step 11: RESET warehouse_cartons state (clear locations, status)
Step 12: DELETE warehouse_cartons
Step 13: DELETE warehouse_shipments
Step 14: DELETE receiving_sessions (CASCADE → cartons, products, scans, discrepancies)
Step 15: DELETE worker_task_assignments
Step 16: DELETE expected_arrival_items + expected_arrivals
Step 17: DELETE physical_items + order_items + warehouse_orders
Step 18: DELETE sessions (for test workers)
Step 19: DELETE user_roles (for test workers) + users (test workers)
Step 20: DELETE operational audit_logs
```

All operations are wrapped in a single **PostgreSQL transaction**. If any step fails, the entire cleanup is rolled back — the database remains unchanged.

---

## 4. TOOLS CREATED

### 4.1 Main Script: `tools/test-data-reset-pg.ts`

Standalone TypeScript script using `pg` driver directly. No Prisma query engine binary required.

**Features:**
- Phase 1: Full audit (counts all entities, identifies test data)
- Phase 2: Deletion plan (shows exactly what will be deleted)
- Phase 3: Atomic execution (single transaction, rollback on error)
- Phase 4: Orphan verification (10 FK integrity checks)
- Phase 5: Creates ONE clean TEST_WORKER
- Phase 6: Final state report

**Modes:**
- `--dry-run` — Audit only, no deletions
- `--force` — Skip interactive confirmation

### 4.2 Shell Wrapper: `tools/reset-test-data.sh`

```bash
./tools/reset-test-data.sh              # Full audit + cleanup
./tools/reset-test-data.sh --dry-run    # Audit only
./tools/reset-test-data.sh --force      # No confirmation
```

### 4.3 NPM Scripts (in `backend/package.json`)

```bash
cd backend
npm run db:audit          # Audit only (dry run)
npm run db:cleanup        # Audit + cleanup (interactive)
npm run db:cleanup:force  # Audit + cleanup (no confirmation)
```

---

## 5. HOW TO EXECUTE

### Prerequisites
- PostgreSQL database accessible via `DATABASE_URL`
- Node.js 18+ with backend dependencies installed (`cd backend && npm install`)

### Step-by-step

```bash
# 1. Set the database URL
export DATABASE_URL="postgresql://ayrovi:ayrovi_dev@localhost:5432/ayrovi_warehouse"

# 2. Run audit first (safe — no deletions)
cd backend
npm run db:audit

# 3. Review the audit report — confirm what will be deleted

# 4. Execute the cleanup (will ask for confirmation)
npm run db:cleanup

# 5. Or, for automated/CI execution:
npm run db:cleanup:force
```

### Alternative (shell script)

```bash
export DATABASE_URL="postgresql://ayrovi:ayrovi_dev@localhost:5432/ayrovi_warehouse"
./tools/reset-test-data.sh --dry-run   # audit first
./tools/reset-test-data.sh             # then execute
```

---

## 6. WHAT THE SCRIPT IDENTIFIES AS TEST DATA

### Test Workers
All users with **operational roles** (INBOUND_WORKER, RECEIVING_WORKER, SORTING_WORKER, PUTAWAY_WORKER, PICKER, PACKER, PACKING_WORKER, SHIPPING_WORKER) are classified as test workers and removed.

### Admin Users (PRESERVED)
Users with system roles (SUPER_ADMIN, WAREHOUSE_ADMIN, WAREHOUSE_MANAGER, VIEWER) are **never** deleted.

### Transaction Data
ALL operational transaction data (arrivals, shipments, cartons, receiving sessions, articles, containers, outbound shipments, task assignments, etc.) is considered test data and removed.

### Audit Logs
Only **operational** audit log entries (receiving, putaway, corrections, tasks, etc.) are removed. System-level audit logs (user creation, role changes, login events for admins) are preserved.

---

## 7. FINAL STATE

After cleanup, the database will be in this state:

```
CLEAN TEST ENVIRONMENT
│
├── Application Code          = PRESERVED ✅
├── Database Schema           = PRESERVED ✅
├── Admin Structure           = PRESERVED ✅
├── Permission System         = PRESERVED ✅
├── Roles & Permissions       = PRESERVED ✅
├── Warehouse Structure       = PRESERVED ✅
├── Stations                  = PRESERVED ✅ (worker assignments cleared)
├── Devices                   = PRESERVED ✅ (worker assignments cleared)
├── Category Master           = PRESERVED ✅
├── Products (Master)         = PRESERVED ✅
├── System Settings           = PRESERVED ✅
│
├── Test Workers              = REMOVED ✅
├── Test Arrivals             = REMOVED ✅
├── Test Receiving Cards      = REMOVED ✅
├── Test Receiving Sessions   = REMOVED ✅
├── Test Receiving Lines      = REMOVED ✅
├── Test Shipments            = REMOVED ✅
├── Test Cartons              = REMOVED ✅
├── Test Articles             = REMOVED ✅
├── Test Containers           = REMOVED ✅
├── Test Outbound Shipments   = REMOVED ✅
├── Test Task Assignments     = REMOVED ✅
├── Test Exceptions           = REMOVED ✅
├── Test Corrections          = REMOVED ✅
├── Test Putaway              = REMOVED ✅
├── Test Sessions             = REMOVED ✅
├── Test Audit Logs           = REMOVED ✅
│
└── ONE TEST WORKER           = CREATED ✅
    ├── Employee Code: TEST_WORKER
    ├── Role: RECEIVING_WORKER
    └── Station: ST-REC-01 (Receiving Dock 1)
```

### Ready for Controlled Test

```
CLEAN DATA
    ↓
ONE TEST WORKER (TEST_WORKER)
    ↓
ONE CONTROLLED TEST ARRIVAL (create manually)
    ↓
ONE RECEIVING CARD (create manually)
    ↓
TEST PRODUCT (use existing master data or create)
    ↓
TEST CARTON (create manually)
    ↓
TEST RECEIVING FLOW (execute via Worker App)
```

---

## 8. CLEANUP REPORT TEMPLATE

After execution, the script outputs:

```
CLEANUP REPORT

Workers removed:                     [N]
Workers preserved:                   [N]

Arrivals removed:                    [N]
Receiving Cards removed:             [N]
Receiving Sessions removed:          [N]
Receiving Lines removed:             [N]

Product test transactions removed:   [N]
Carton test transactions removed:    [N]
Shipments removed:                   [N]
Scan records removed:                [N]
Task assignments removed:            [N]
Sessions reset:                      [N]
Pending sync records removed:        [N]

Orphans found:                       [N]
Orphans fixed:                       [N]

Production/master data preserved:    YES
Application code modified:           NO
Database schema modified:            NO
```

---

## 9. IMPORTANT NOTES

- **No random test data is generated automatically.** The next test scenario must be created manually for full control.
- **The script is idempotent.** Running it multiple times is safe — if test data is already clean, it simply confirms the clean state.
- **All deletions are atomic.** The entire cleanup runs in a single PostgreSQL transaction. Any error triggers a full rollback.
- **The TEST_WORKER password** defaults to `TestWorker!2024` but can be overridden via `SEED_WORKER_PASSWORD` environment variable.

---

*This report documents the test data cleanup tooling created for the AYROVI Warehouse Core project.*
