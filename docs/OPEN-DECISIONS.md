# AYROVI Warehouse Core — Phase 0 — Open Decisions Log

> Per the Phase 0 charter: *"إذا وجدت قرارًا معماريًا غير محسوم، توقف وسجّله كـ
> Open Decision بدل افتراضه."* (If you find an unresolved architectural
> decision, STOP and record it as an Open Decision instead of assuming.)

Every item below is either **RESOLVED** (agreed in this handoff) or **OPEN**
(needs a decision before the next phase). All decisions are recorded rather
than silently assumed, so nothing is baked in accidentally.

---

## A. Resolved decisions (already agreed)

| ID | Decision | Resolution |
|----|----------|------------|
| D-01 | Backend stack | **Node.js + TypeScript + NestJS** (Modular Monolith). |
| D-02 | Frontend stack | **React + TypeScript + Vite**. |
| D-03 | ORM / DB access | **Prisma** on **PostgreSQL**. |
| D-04 | Auth mechanism | Self-hosted **JWT Access + Refresh tokens**, Password/PIN hashing, session/revocation support. No third-party OAuth at this stage. |
| D-05 | RBAC | Dynamic DB-driven **Roles + granular Permissions**. Roles are NOT hard-coded into business logic. |
| D-06 | API style & versioning | **REST**, routes under **`/api/v1`**. |
| D-07 | Validation | **DTO + class-validator / class-transformer**, global ValidationPipe. |
| D-08 | Docs | **OpenAPI / Swagger** at `/api/docs`. |
| D-09 | Tests | **Jest + Supertest**. |
| D-10 | Deployment | Render-friendly but **portable**; **Docker-ready**. |
| D-11 | Architecture | **Modular Monolith** — modules communicate via services / internal event bus, never by reaching into another module's tables. |

## B. Assumed (low-risk defaults chosen in Phase 0 — call out if you disagree)

| ID | Assumption | Notes |
|----|-----------|-------|
| A-01 | `credentialMode` supports PASSWORD / PIN / BOTH | The User schema supports numeric PIN for floor workers (PDA), separately from password. |
| A-02 | `permission` shape is `resource.action` (e.g. `locations.manage`) | Matches the permission catalog in the spec. |
| A-03 | `AuditAction` enum includes operational placeholders (ITEM_RECEIVED, ORDER_PACKED, …) | Defined now for forward-compat but **never emitted** in Phase 0. |
| A-04 | A minimal `warehouses` table exists in Phase 0 | Only identification/config of the managed warehouse — **not** an operational workflow. |

## C. OPEN DECISIONS (must be resolved before/as the next phase begins)

| ID | Question | Why it matters | Suggested options |
|----|----------|----------------|-------------------|
| D-20 | **Multi-warehouse support?** | Does the system manage a single physical warehouse or several (e.g. main + satellite)? Affects whether `warehouse_id` becomes a mandatory FK on every operational row in Phase 1+. | (a) Single-warehouse now, add `warehouse_id` when needed; (b) Multi-warehouse from day one. |
| D-21 | **Rate limiting store** | Phase 0 uses an in-memory limiter (per-instance). In multi-instance production, how is brute-force protection shared? | (a) Introduce Redis; (b) use a DB-backed counter; (c) accept per-instance for single-process Render. |
| D-22 | **Database configuration migrations** | Where are non-Postgres config values (tax, units, currencies) stored? Phase 0 seeds nothing; `system_settings` is available. | (a) DB `system_settings`; (b) env-only; (c) hybrid. |
| D-23 | **Refresh token rotation & reuse detection** | Phase 0 rotates on refresh but does not detect reuse of an old (already-rotated) token. Define the anti-reuse policy. | (a) Detect reuse → revoke whole session; (b) ignore. |
| D-24 | **Production domain / subdomain** | Spec says *not final*. Confirm `warehouse.ayrovi.com` (or alternative) before wiring CORS, HTTPS and env. | TBD. |
| D-25 | **Machine-to-machine / API Clients auth** | `api_clients` schema exists; no auth flow is wired. Decide the grant type (client-credentials) and when to enable it. | (a) Client-credentials JWT under `/api/v1/auth/client`; (b) defer. |
| D-26 | **Audit log retention / partitioning** | `audit_logs` grows over time. Decide retention, archival, and whether to partition by time. | (a) Partition by month; (b) simple index + retention job. |
| D-27 | **User deletion semantics** | Phase 0 soft-disables users (prevents data loss). Decide whether hard-delete is ever allowed. | (a) Soft-disable only (current); (b) hard-delete for non-system users with audit. |
| D-28 | **Email / password reset** | Is password recovery via email in scope for the internal staff app, and via what provider? | TBD — no email provider wired in Phase 0. |
| D-29 | **Employee code format** | Phase 0 seeds `ADMIN001`; the format is loosely validated (`[A-Za-z0-9._-]+`). Confirm the canonical format / whether it's auto-generated. | TBD. |

---

### How to use this log

- Before starting **Phase 1 — Warehouse Foundation & Physical Structure**, review
  section **C**. Anything still **OPEN** that affects Phase 1 data model must be
  answered first.
- Any new decision encountered during building should be added here rather than
  silently decided in code.
