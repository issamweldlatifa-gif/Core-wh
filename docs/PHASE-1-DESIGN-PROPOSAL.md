# Phase 1 — Design Proposal (Pre-Implementation Review)

> **Status: AWAITING APPROVAL — no code is written yet.**
> This document presents the proposed Data Model, ERD, Prisma models, API map,
> permission map, audit-event map, location-code convention, and open decisions.
> Per the execution order, implementation starts only after acceptance.

---

## 0. Preamble

Phase 0 (Core foundation) is accepted. Phase 1 builds the **digital representation
of the physical warehouse structure** — *Physical Warehouse Topology* — with **NO**
inventory, receiving, picking, packing, shipping, OCR, or CRM logic.

This proposal was grounded in the existing codebase so it stays consistent:

| Existing Phase 0 reality | Phase 1 impact |
|---|---|
| `Warehouse` model is minimal (`code, name, address, status="OPERATIONAL"`) | Extend to full spec (add `description`, status enum, timestamps). |
| Permissions are coarse (`warehouse.view`, `warehouse.manage` only) | Replace with granular per-stage permissions. |
| Audit enum has only `WAREHOUSE_UPDATED` | Add the full physical-structure event set. |
| Single `WarehouseModule` (upsert/list/get) | Expand into a `warehouse` module with per-entity submodules. |

---

## 1. Entity / Hierarchy (ERD)

```
Company (out of Phase 1 scope — see Open Decision D-38)
   |
   v
Warehouse  ──1────N── Zone  ──1────N── Aisle  ──1────N── Rack  ──1────N── Level
              |               |               |               |              |
              |               |               |               |              `────1────N── Location
              |               |               |               `────FK──────────┘ (location → level)
              |               |               `────FK──────────┘
              |               `────FK──────────┘
              `────FK──────────┘   (Location also carries warehouseId for isolation)
```

Every physical node **belongs to exactly one parent**, and a `Location` is the
leaf: the final physical place future operations will reference.

```
Warehouse
   └── Zone
        └── Aisle
             └── Rack
                  └── Level
                       └── Location
```

---

## 2. Prisma Model Proposal

Convention: primary key is `id String @id @default(uuid())` (matches the whole
existing codebase). `code` fields are user-facing, unique within their scope.

### 2.1 Warehouse
```prisma
enum WarehouseStatus { ACTIVE  INACTIVE }

model Warehouse {
  id          String          @id @default(uuid())
  code        String          @unique          // e.g. TUN-MAIN (stable, immutable)
  name        String
  description String?
  status      WarehouseStatus @default(ACTIVE)
  createdAt   DateTime        @default(now())
  updatedAt   DateTime        @updatedAt

  zones      Zone[]
  locations  Location[]

  @@map("warehouses")
}
```

### 2.2 Zone
```prisma
enum ZoneStatus { ACTIVE  INACTIVE }

model Zone {
  id          String      @id @default(uuid())
  warehouseId String
  warehouse   Warehouse   @relation(fields: [warehouseId], references: [id], onDelete: Restrict)
  code        String                                   // e.g. SHOES
  name        String
  description String?
  status      ZoneStatus  @default(ACTIVE)
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  aisles     Aisle[]
  locations  Location[]

  @@unique([warehouseId, code])   // zone code unique WITHIN a warehouse
  @@index([warehouseId])
  @@map("zones")
}
```

### 2.3 Aisle
```prisma
enum AisleStatus { ACTIVE  INACTIVE }

model Aisle {
  id          String      @id @default(uuid())
  zoneId      String
  zone        Zone        @relation(fields: [zoneId], references: [id], onDelete: Restrict)
  code        String                                   // e.g. A01
  name        String
  description String?
  status      AisleStatus @default(ACTIVE)
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  racks      Rack[]
  locations  Location[]

  @@unique([zoneId, code])
  @@index([zoneId])
  @@map("aisles")
}
```

### 2.4 Rack
```prisma
enum RackStatus { ACTIVE  INACTIVE }

model Rack {
  id          String      @id @default(uuid())
  aisleId     String
  aisle       Aisle       @relation(fields: [aisleId], references: [id], onDelete: Restrict)
  code        String                                   // e.g. R01
  name        String
  description String?
  status      RackStatus  @default(ACTIVE)
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  levels     Level[]
  locations  Location[]

  @@unique([aisleId, code])
  @@index([aisleId])
  @@map("racks")
}
```

### 2.5 Level
```prisma
enum LevelStatus { ACTIVE  INACTIVE }

model Level {
  id          String      @id @default(uuid())
  rackId      String
  rack        Rack        @relation(fields: [rackId], references: [id], onDelete: Restrict)
  code        String                                   // e.g. L03 (display)
  levelNumber Int                                      // numeric order 1,2,3,4
  status      LevelStatus @default(ACTIVE)
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  locations  Location[]

  @@unique([rackId, code])
  @@index([rackId])
  @@map("levels")
}
```

### 2.6 Location (core entity of Phase 1)
```prisma
enum LocationType   { STORAGE  RECEIVING  SORTING  PACKING  RETURNS  QC  STAGING }
enum LocationStatus { ACTIVE  INACTIVE  BLOCKED }

model Location {
  id          String         @id @default(uuid())
  // Denormalized warehouseId for multi-warehouse isolation & fast filtering.
  warehouseId String
  warehouse   Warehouse      @relation(fields: [warehouseId], references: [id], onDelete: Restrict)
  zoneId      String
  zone        Zone           @relation(fields: [zoneId], references: [id], onDelete: Restrict)
  aisleId     String
  aisle       Aisle          @relation(fields: [aisleId], references: [id], onDelete: Restrict)
  rackId      String
  rack        Rack           @relation(fields: [rackId], references: [id], onDelete: Restrict)
  levelId     String
  level       Level          @relation(fields: [levelId], references: [id], onDelete: Restrict)

  locationCode String        @unique     // TUN-MAIN-SHOES-A01-R02-L03
  barcodeValue String        @unique     // value that will be printed (see D-33)
  qrValue      String?       @unique

  locationType LocationType
  status       LocationStatus @default(ACTIVE)

  // Capacity metadata (stored as transportable columns; NO capacity engine now).
  maxWeight Float?
  maxVolume Float?
  maxUnits  Int?

  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  @@index([warehouseId])
  @@index([zoneId])   @@index([aisleId])   @@index([rackId])   @@index([levelId])
  @@index([status])
  @@map("locations")
}
```

### 2.7 Database Integrity
- **FKs:** `zone.warehouseId → warehouse.id`, `aisle.zoneId → zone.id`,
  `rack.aisleId → aisle.id`, `level.rackId → rack.id`,
  `location.{zone,aisle,rack,level}Id` + `location.warehouseId`.
- **`onDelete: Restrict`** on all parent FKs → prevents hard deletion of a parent
  that still has children (the "deactivate, don't delete" rule is enforced at the
  data layer too).
- **Composite uniques:** `(warehouseId, code)` for Zone; `(zoneId, code)` for
  Aisle; `(aisleId, code)` for Rack; `(rackId, code)` for Level; `locationCode`
  and `barcodeValue` globally unique.
- **Indexes** on every FK + `status` for fast search/filter.
- **Parent/child integrity:** enforced in the service layer on every create/update
  of Location (and on child creation) by walking the parent chain and asserting
  that `level.rack.aisle.zone.warehouse` all match the supplied IDs and the
  denormalized `warehouseId`. (Prisma does not support multi-column FK checks, so
  this is validated in code + protected by the composite unique constraints.)

---

## 3. API Resource Map (`/api/v1`)
All endpoints enforce Authentication + Authorization + Validation + Audit.

| Resource | Path | Methods |
|---|---|---|
| Warehouses | `/api/v1/warehouses` | `GET` (list), `POST` (create) |
| | `/api/v1/warehouses/:id` | `GET`, `PATCH` |
| | `/api/v1/warehouses/:id/activate` · `/deactivate` | `POST` |
| | `/api/v1/warehouses/:id/structure` | `GET` (nested explorer tree) |
| Zones | `/api/v1/zones?warehouseId=` | `GET`, `POST` |
| | `/api/v1/zones/:id` | `GET`, `PATCH` |
| | `/api/v1/zones/:id/activate` · `/deactivate` | `POST` |
| Aisles | `/api/v1/aisles?zoneId=` | `GET`, `POST` |
| | `/api/v1/aisles/:id` | `GET`, `PATCH`, activate/deactivate |
| Racks | `/api/v1/racks?aisleId=` | `GET`, `POST` |
| | `/api/v1/racks/:id` | `GET`, `PATCH`, activate/deactivate |
| Levels | `/api/v1/levels?rackId=` | `GET`, `POST` |
| | `/api/v1/levels/:id` | `GET`, `PATCH`, activate/deactivate |
| Locations | `/api/v1/locations` | `GET` (filter: `warehouseId, zoneId, status, locationType`), `POST` |
| | `/api/v1/locations/:id` | `GET`, `PATCH` |
| | `/api/v1/locations/:id/activate` · `/deactivate` · `/block` · `/unblock` | `POST` |
| | `/api/v1/locations/search?q=` | `GET` (fast search across codes/names with indexes) |

**Search/filter:** indexed `q` over `code`/`name`, plus dedicated filters for
`warehouse`, `zone`, `status`, `locationType`.

---

## 4. Permission Map (granular, DB-driven)
Replace the coarse Phase-0 `warehouse.view` / `warehouse.manage` with the full
granular set (6 resources × 5 stages = 30):

| Resource \ Stage | view | create | update | activate | deactivate |
|---|---|---|---|---|---|
| `warehouses` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `zones` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `aisles` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `racks` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `levels` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `locations` | ✓ | ✓ | ✓ | ✓ | ✓ |

> **Legacy note (see D-32):** the existing `warehouse.view`, `warehouse.manage`,
> `locations.view`, `locations.manage` keys will be **migrated/renamed** into the
> granular set. All roles are re-mapped.

### Role → Permission mapping (DB-driven, adjustable)
| Role | Permissions |
|---|---|
| `SUPER_ADMIN` | All 30 (full structure management) |
| `WAREHOUSE_ADMIN` | All 30 (full warehouse structure management) |
| `WAREHOUSE_MANAGER` | View (all) + update + activate/deactivate (all) **without create** — operational configuration |
| `INBOUND_WORKER` | `locations.view` only (Phase 1) |
| `PICKER` | `locations.view` only (Phase 1) |
| `PACKER` | `locations.view` only (Phase 1) |
| `VIEWER` | View on all 6 (read-only) |

(D-34: exact create-access for WAREHOUSE_MANAGER is an open decision.)

---

## 5. Audit Event Map (extend `AuditAction` enum)
Each event logs actor, action, entityType, entityId, timestamp, metadata.

| Resource | Events |
|---|---|
| Warehouse | `WAREHOUSE_CREATED`, `WAREHOUSE_UPDATED`, `WAREHOUSE_ACTIVATED`, `WAREHOUSE_DEACTIVATED` |
| Zone | `ZONE_CREATED`, `ZONE_UPDATED`, `ZONE_ACTIVATED`, `ZONE_DEACTIVATED` |
| Aisle | `AISLE_CREATED`, `AISLE_UPDATED`, `AISLE_ACTIVATED`, `AISLE_DEACTIVATED` |
| Rack | `RACK_CREATED`, `RACK_UPDATED`, `RACK_ACTIVATED`, `RACK_DEACTIVATED` |
| Level | `LEVEL_CREATED`, `LEVEL_UPDATED`, `LEVEL_ACTIVATED`, `LEVEL_DEACTIVATED` |
| Location | `LOCATION_CREATED`, `LOCATION_UPDATED`, `LOCATION_ACTIVATED`, `LOCATION_DEACTIVATED`, `LOCATION_BLOCKED`, `LOCATION_UNBLOCKED` |

---

## 6. Location Code Convention (proposal — to be locked)
```
{WAREHOUSE}-{ZONE}-{AISLE}-{RACK}-{LEVEL}
```
Example: `TUN-MAIN-SHOES-A01-R02-L03`

- Uppercase, no spaces, hyphen-separated.
- Derived automatically from the parent chain; **read-only** once created.
- `barcode_value` = the location_code by default (see D-33).
- Will not change later once operations begin (per spec).

---

## 7. Module Structure (backend)
```
backend/src/modules/warehouse/
├── warehouses/   (controller, service, dto)
├── zones/
├── aisles/
├── racks/
├── levels/
└── locations/
```
Module boundaries respected: no submodule reads another's tables directly;
communication is via Services / domain interfaces. Existing `WarehouseModule`
is expanded in place.

## 8. Frontend Structure
```
frontend/src/modules/warehouse/
├── warehouses/
├── zones/
├── aisles/
├── racks/
├── levels/
└── locations/
```
Plus a **Structure Explorer** screen (interactive hierarchy tree) and shared
components/services. The current single `Warehouse` page is reorganized under
this module.

---

## 9. Scope Boundaries — NOT in Phase 1
No OCR, invoice processing, customer cards, product import, inventory quantities,
receiving/stowing/picking/sorting/packing/shipping workflows, carrier APIs, CRM,
external API calls, offline sync, mobile APK, or scanner workflows.
Barcode/QR = **location identifiers only**, not a scanner workflow.
Bulk structure generation and inventory capacity engine are **deferred**.

---

## 10. Open Decisions (to be resolved before/at implementation)

| ID | Question | Why it matters | Recommendation | Status |
|---|---|---|---|---|
| D-30 | Is the final Location code format `{WH}-{ZONE}-{AISLE}-{RACK}-{LEVEL}` with uppercase + hyphens acceptable? | Must not change after operations begin; affects barcode/QR/scanning & worker usability. | **Yes — lock it.** | Open |
| D-31 | Primary key: keep codebase-wide `id` (UUID) vs spec's `warehouse_id` naming? | Consistency across the whole system. | **Keep `id` (UUID)**; use `code` as the business key. | Open |
| D-32 | How to migrate the existing Phase-0 `Warehouse` status (`OPERATIONAL`) and `warehouse.view/manage` permissions? | Backward compatibility of existing data & roles. | Migrate status→`ACTIVE`; rename permissions to granular set; re-map roles idempotently in seed. | Open |
| D-33 | `barcode_value`: equal to `location_code`, or a separately generated (hashed) value? | Data printed on labels; must be unique & stable. | **Default = location_code** (simplest, human-readable). Generated value as a future opt-in. | Open |
| D-34 | Should `WAREHOUSE_MANAGER` get `create` on any physical node, or only view+update+activate? | Least-privilege; who may create structure. | View + update + activate/deactivate only (no create). | Open |
| D-35 | Allow hard delete of truly-unused nodes? | Spec says default deactivate; delete only when safe. | **No hard delete in Phase 1** (enforced via `Restrict` FKs). | Open |
| D-36 | Level `code` auto-derived from `levelNumber`, or manually entered? | Display consistency. | Auto-derive code `L##` from `levelNumber`. | Open |
| D-37 | Bulk structure creation (warehouse→zones→aisles→racks→levels→locations)? | Spec defers it. | **Defer**; domain designed to support it later. | Open |
| D-38 | Introduce a `Company` entity above `Warehouse`? | Spec hierarchy lists Company, but entity list starts at Warehouse. | **Defer to a later phase** — warehouse stands alone in Phase 1. | Open |

---

## 11. Testing Plan (to be implemented after approval)
- Warehouse: create; duplicate code → reject; zone duplicate in same warehouse →
  reject; same zone code in another warehouse → allowed; aisle/rack/level
  creation; location creation; duplicate location code → reject; invalid parent
  hierarchy → reject; deactivate location; unauthorized → 401; forbidden → 403.
- Multi-warehouse isolation: Warehouse A location never leaks into Warehouse B.
- Audit: every create/update/activate/deactivate/block emits the matching event.

## 12. Delivery
Prisma migration (schema → migration → review → deploy), updated README, updated
`OPEN-DECISIONS.md` with the new D-3x entries, Unit + E2E tests, Render redeploy,
and a final Phase 1 report. **Phase 2 is NOT started automatically.**

---

**_Waiting for acceptance of this design before any code is written._**
