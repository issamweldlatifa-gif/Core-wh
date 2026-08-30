# AYROVI Warehouse Core

**«AYROVI Warehouse Core»** — a modular-monolith core that all future
warehouse operational phases will build on.

> **Phase 0 (delivered):** Authentication, RBAC, granular Permissions, Audit
> system, REST v1 API, internal module boundary, external integration
> boundary, PostgreSQL schema, Docker, tests, docs.
>
> **Phase 1 (delivered):** *Warehouse Foundation & Physical Structure* — the
> digital representation of the physical warehouse topology:
> **Warehouse → Zone → Aisle → Rack → Level → Location**, multi-warehouse from
> day one, granular structure permissions & RBAC, location identifiers
> (barcode-ready), search/filter, structure explorer, migrations, tests.
>
> **Explicitly NOT in Phase 0/1:** Receiving / Stowing / Picking / Packing /
> Shipping, OCR, inventory quantities, container/barcode-scanning workflow,
> CRM or carrier integration, offline mobile, bulk structure generation.
> These are later phases. The permission keys and audit event names for them
> are *reserved* now, but the workflows are NOT implemented.

---

## Repository layout

```
AYROVI-WAREHOUSE-CORE/
├── frontend/          # React + TypeScript + Vite (internal web app)
├── backend/           # NestJS (REST /api/v1) + Prisma + PostgreSQL
├── database/          # (migrations live in backend/prisma/migrations)
├── docs/              # OPEN-DECISIONS.md and design notes
├── docker/            # Dockerfiles + docker-compose + nginx
├── tests/             # (test sources live alongside the apps)
├── .env.example       # root env template
└── README.md
```

---

## Quick start — Clone → Configure → Migrate → Run

### Prerequisites
- Node.js 20+
- PostgreSQL 14+ (or use Docker via `docker compose`)
- (Optional) Docker & Docker Compose

### Option A — Run everything with Docker (easiest)

```bash
cd docker
docker compose up --build
# Frontend:  http://localhost:8080
# Backend:   http://localhost:3000/api/v1/system/health
# Swagger:   http://localhost:3000/api/docs
```

Then seed the initial admin (see “Create the first admin” below) — or set
`INITIAL_ADMIN_*` in `docker-compose.yml` and re-run the backend.

### Option B — Local development (backend + frontend separately)

#### 1. Configure the backend

```bash
cd backend
cp .env.example .env
# edit .env: DATABASE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, INITIAL_ADMIN_*
npm install
```

#### 2. Set up PostgreSQL

Create a database (or use an existing one):

```sql
CREATE USER ayrovi WITH PASSWORD 'change_me';
CREATE DATABASE ayrovi_warehouse OWNER ayrovi;
GRANT ALL PRIVILEGES ON DATABASE ayrovi_warehouse TO ayrovi;
```

> Prisma Migrate needs the DB user to be able to create a shadow database.
> Grant it once (dev only): `ALTER USER ayrovi CREATEDB;`

#### 3. Migrate + seed

```bash
cd backend
npx prisma generate
npx prisma migrate deploy      # applies schema migrations
npm run db:seed                # seeds permissions, roles, and the first admin
```

#### 4. Run the backend

```bash
cd backend
npm run start:dev              # http://localhost:3000  (Swagger at /api/docs)
```

#### 5. Run the frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev                    # http://localhost:5173
```

The Vite dev server proxies `/api` → `http://localhost:3000`, so the frontend
reaches the backend from the same origin. Log in with the seeded admin
(`ADMIN001` / the password you set in `.env`).

---

## Create the first admin

Set these in the backend `.env` (or as environment variables) and run the seed:

```bash
INITIAL_ADMIN_CODE=ADMIN001
INITIAL_ADMIN_PASSWORD=YourStrongPassword!2024
npm run db:seed
```

This creates a `SUPER_ADMIN` user bound to the `SUPER_ADMIN` role (which holds
every permission).

---

## What is implemented (Phase 0 + Phase 1)

| Area | Status |
|------|--------|
| Area | Status |
|------|--------|
| Web app (React + TS + Vite) | ✅ Login, permission-aware shell, dashboard, users, roles, audit, system, warehouse module |
| Warehouse structure UI | ✅ Warehouses / Zones / Aisles / Racks / Levels / Locations + Structure Explorer, permission-aware |
| REST API `/api/v1` | ✅ Auth, users, roles, permissions, audit, system, warehouse, zones, aisles, racks, levels, locations |
| Authentication (employee code + password/PIN) | ✅ JWT access + refresh, sessions, rate limiting |
| RBAC — Users / Roles / Permissions / joins | ✅ |
| Granular permission model | ✅ `resource.action` keys (structure = 6 resources × 5 actions) |
| Backend-enforced authorization | ✅ Global guards → 401 / 403 |
| Audit system | ✅ `audit_logs` + `AuditService`; Phase-1 structure events emitted |
| PostgreSQL core schema | ✅ 10 core tables + multi-warehouse physical structure |
| Physical structure (6 entities) | ✅ CRUD + activate/deactivate, location integrity verified |
| Multi-warehouse isolation | ✅ (zone codes unique per warehouse; location ancestry validated) |
| Internal module boundary | ✅ Modular monolith + internal event bus |
| External integration boundary | ✅ Contract-only `integrations/` (no live calls) |
| Validation + uniform errors | ✅ DTO validation + global `AllExceptionsFilter` |
| Security | ✅ Hashed credentials, env secrets, CORS, helmet, rate limiting |
| Docker + portable deployment | ✅ Dockerfiles + compose + nginx |
| Tests | ✅ Jest + Supertest — unit + E2E (see below) |
| API docs (Swagger/OpenAPI) | ✅ `/api/docs` |

---

## Tests

```bash
# Backend unit tests
cd backend
npm test

# Backend end-to-end tests (needs a migrated + seeded PostgreSQL)
DATABASE_URL="postgresql://..." \
INITIAL_ADMIN_CODE=ADMIN001 INITIAL_ADMIN_PASSWORD="..." \
JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=... \
npm run test:e2e
```

Covered:
- Login succeeds / wrong credentials rejected (401) / unknown user rejected
- `/auth/me` returns roles + permissions
- Worker **cannot** call admin endpoints (403), unauthenticated → 401
- Validation → 400 with uniform error envelope
- Permission revocation effective immediately
- Session revocation (logout) invalidates token immediately
- `USER_LOGIN` audit event recorded
- API versioning under `/api/v1`
- **Phase 1:** full 6-entity CRUD (`warehouse`/`zone`/`aisle`/`rack`/`level`/`location`),
  duplicate-code rejection per parent, invalid parent hierarchy → 400, cross-warehouse
  isolation, RBAC (401/403 incl. WAREHOUSE_MANAGER **no-create**), deactivation audit,
  search/filter (`locations/search?q=`), auto-derived level/location codes, barcode = location code.

---

## Security notes

- Passwords and PINs are hashed (**bcrypt**), never stored as plain text.
- Secrets live in environment variables / `.env` (see `.env.example`), never in Git.
- Backend authorization is enforced on **every** request via global guards; the front-end only hides controls.
- CORS is explicitly configured (no wildcard in production).
- Helmet security headers are enabled; HTTPS is terminated at the domain/proxy layer in production.
- Authentication endpoints are rate-limited.
- Credentials never reach the front-end build.

---

## Production deployment (portable — Render available)

The app is **not** tied to any provider:

1. **Database** — provision PostgreSQL and set `DATABASE_URL`.
2. **Backend** — build with `docker/backend.Dockerfile`, run migrations
   (`prisma migrate deploy`) then start. Set the JWT secrets, `CORS_ORIGINS`,
   and `INITIAL_ADMIN_*`.
3. **Frontend** — build with `docker/frontend.Dockerfile` with
   `VITE_API_BASE=<api url or /api>`; serve the static bundle behind nginx / a CDN.
4. **Domain** — point your operations subdomain (e.g. `warehouse.ayrovi.com`, TBD — see `docs/OPEN-DECISIONS.md`) at the frontend; API at its own host/subdomain. Terminate HTTPS at the proxy.

> **Important:** Do **not** use the `docker-compose.yml` secrets in production.
> Provide them through the hosting platform’s environment/secret manager.

---

## Pre-conditions to accept Phase 0 (Acceptance Review)

Before closing Phase 0, verify:
- Frontend runs, Login/Logout work, sessions work.
- RBAC + permissions work, backend 403/401 enforcement works.
- Audit log works (login + role/permission changes recorded).
- API versioning (/api/v1) ready; internal module boundary ready.
- External integration boundary ready (contracts only).
- Environment config organized; production deployment executable.
- Tests pass.
- **No** CRM integration, **no** warehouse workflow, **no** production data mixed with test data.

---

## Phase 1 details

Decisions D-30…D-38 (all **resolved** in Phase 1) and the Location-integrity
constraint are recorded in [`docs/OPEN-DECISIONS.md`](docs/OPEN-DECISIONS.md).
The approved design package (ERD, models, API/permission/audit maps, testing
plan) is [`docs/PHASE-1-DESIGN-PROPOSAL.md`](docs/PHASE-1-DESIGN-PROPOSAL.md).

Location code format (locked): `{WAREHOUSE}-{ZONE}-{AISLE}-{RACK}-{LEVEL}`,
auto-derived from the parent chain; `barcodeValue = locationCode`.
WAREHOUSE_MANAGER has **no** create on the structure — only view/update/activate/deactivate.

## Next phase

**Phase 2 — Inventory & Backend Operations.** Blocking Phase 1 (per design) is
now closed with the Acceptance Review. Phase 2 introduces inventory,
receiving/stowing/picking/packing/shipping workflows. **Phase 2 must NOT start
automatically** — it begins only after the Phase 1 Acceptance Review signs off.
