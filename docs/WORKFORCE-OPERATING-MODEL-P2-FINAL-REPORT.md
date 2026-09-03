# PARTIE 2 — WORKFORCE OPERATING MODEL — Final Delivery Report

**Date:** 2026-09-03 · **Commit hash:** `c8e3f59` (single delivery commit: reference doc + verification suite)
**Branch:** `master` · **Live:** deployed to Render after push (documentation/test-only release — no runtime behaviour change).

---

## 0. Purpose & method

This delivery **installs the operating model** (ROLE → WORKER → STATION → TASK → PERMISSION →
OPERATION) as an audited, documented, tested contract. It does **not** redesign UIs, add screens or
re-architect workflows. Where the architecture already matches, it is pinned by documentation and
tests; where it conflicts with the AYROVI source-of-truth flow, the conflict is **recorded**
(§12–§13) and **not** silently worked around.

## 1. Commit hash

`c8e3f59` — *“PARTIE 2 — Workforce Operating Model: reference doc + model verification suite”*
(also contains the prior delivered state: Worker Control COMMAND #3 `7fee9eb`, Data Control `83ceed8`).

## 2. Roles — before / after

**Before (unchanged DB registry — 7 roles, 265 grants, 74 permissions):**
`SUPER_ADMIN`, `WAREHOUSE_ADMIN`, `WAREHOUSE_MANAGER`, `INBOUND_WORKER`, `PICKER`, `PACKER`, `VIEWER`.

**After: identical set — no role deleted, none added, none renamed.** A technical→conceptual mapping
was documented instead:

| Conceptual (command) | Technical role today | Coverage |
|---|---|---|
| SUPER ADMIN | `SUPER_ADMIN` | ✅ |
| ADMIN | `WAREHOUSE_ADMIN` | ✅ |
| MANAGER | `WAREHOUSE_MANAGER` | ✅ |
| INBOUND WORKER | `INBOUND_WORKER` | ✅ |
| SORTING WORKER (Customer Sorting) | `PICKER` (drives **Order Sorting** = the customer-sorting step) | ⚠️ name mapping — see §12 C3 |
| PACKER | `PACKER` | ✅ |
| SHIPPING WORKER | — | ❌ gap — see §12 C2 |
| VIEWER | `VIEWER` | ✅ |

## 3. Worker mapping

- `WORKER001` (Ahmed Ben Salah) — INBOUND_WORKER — station ST-REC-01 — ACTIVE.
- `ADMIN001` — SUPER_ADMIN — no worker surface.
- Production profile (audited earlier same day): `Isco` SUPER_ADMIN, `23282716` WAREHOUSE_ADMIN,
  `123456` PICKER, `1234567`/`WORKER001` INBOUND_WORKER, plus role-less ACTIVE `1234`/`12345`.
- Command #3 acceptance fixtures (`TSTC3…`, DISABLED) remain as proof of soft-removal; flagged as
  QA artifacts, never hard-deleted.

## 4. Task mapping (single registry)

Six terminal tasks, IDs untouched: `receiving` → RECEIVING (+tote) · `order-sorting` → **Customer
Sorting** (customer/order → bin) · `packing` → PACKING · `shipping` → SHIPPING ·
`sorting` & `putaway` → legacy stowing tasks **not in the AYROVI flow** (kept; see §12 C1/C6/C7).
`RECEIVING_CONTAINER` is an operational buffer **inside** the Receiving workflow, not a standalone
worker task — matches the command requirement. No second Task system created; Command #3
worker-task assignments are a documented manager-instruction layer on top.

## 5. Station mapping

Existing stations match the requested layout 1:1 — **none added**: ST-REC-01/02 (RECEIVING),
ST-SRT-01 (SORTING), ST-PCK-01 (PACKING), ST-SHP-01 (DISPATCH). Station “current task / container /
activity” are **derived** at read time from sessions & containers (no duplicated columns). Station
capabilities are input affordances only (workflow never branches on them). WORKER001 is assigned to
ST-REC-01.

## 6. Permission mapping

Full catalogue (74 keys) grouped in the reference doc §6. API→permission map verified from
controllers (containers/scan-article `receiving.*`, sorting `stowing.execute`, order-sorting
`picking.execute`, packing `packing.execute`, shipping `shipping.execute`, boards `operations.view`,
worker control `users.manage`). Worker roles carry **zero** `.manage`/`operations.correct`/
`users.*`/`roles.*`/`system.*` grants.

## 7. Container model

`OperationalContainer{ code, type (RECEIVING|CUSTOMER), status, capacity int default 50, label,
orderId }`. Capacity is a **column** (configurable 1..100000, validated); FULL is **derived**
(count ≥ capacity). Status lifecycle: `ACTIVE → (bins) READY_FOR_PACKING → PACKED → CLOSED`;
`VOIDED` kept for audit. SMALL/STANDARD/LARGE sized types = future extension, not added.

## 8. Database / schema changes

**None.** This phase is read-only at the schema level.

## 9. API changes

**None.** (RBAC/terminals verified as-is; no endpoint added, removed or moved.)

## 10. Documentation files

- `docs/WORKFORCE-OPERATING-MODEL-P2.md` — durable Partie 2 reference (roles/workers/stations/tasks/
  permissions/container & lifecycle model/matrices/business rules/conflicts & decisions).
- This report.

## 11. Tests

- **New:** `backend/test/operating-model.e2e-spec.ts` — 7 checks (role→permission integrity incl.
  “workers carry no admin grants”; terminal task visibility by role incl. pinned INBOUND
  receiving+stowing superset; workers blocked from admin surfaces 403; station assignment
  served/cleared in terminal context; assigned-task lifecycle self-scoped OPEN→DONE; container
  capacity configuration honoured + default 50 + invalid rejected; **missing category never blocks
  an article reaching the receiving tote** — NEEDS_REVIEW/IN_CONTAINER).
- **Backend e2e: 8 suites / 95 tests green** (new suite + auth, category, category-master,
  receiving, operational-flow, schema-constraints, warehouse-structure).
- **Backend unit: 6 suites / 38 tests green.**
- **Frontend build:** green (no UI change — regression only).

## 12. Conflicts discovered (recorded, not worked around)

1. **C1** Terminal `sorting` uses `stowing.execute` **and** `INBOUND_WORKER` holds `stowing.execute`
   → an inbound worker sees Receiving + Sorting + Putaway (superset of the desired
   INBOUND→RECEIVING matrix).
2. **C2** No floor role can ship (`shipping.execute` only on SUPER_ADMIN / WAREHOUSE_ADMIN /
   WAREHOUSE_MANAGER); no SHIPPING_WORKER role exists.
3. **C3** Conceptual “SORTING WORKER” ≠ terminal “Sorting”: customer sorting is implemented by the
   **Order Sorting** task under `PICKER`/`picking.execute`.
4. **C4** Role-less ACTIVE accounts exist in prod (`1234`, `12345`) and are treated as workers.
5. **C5** Station assignment is a soft link; station department does **not** gate task execution
   server-side (permission-gated only).
6. **C6/C7** A category→zone **storage** branch (`sorting/store`, putaway, `STORED` article status,
   `NEEDS_REVIEW` blocked from storage) exists and is **not** in the AYROVI flow; terminal tasks
   `sorting`/`putaway` have no home in that flow.
7. **C8** Container sizing is per-row capacity, not sized container types.
8. **C9** No stored worker IDLE/ACTIVE/PAUSED/OFFLINE state machine (presence is derived).

## 13. Decisions taken

- **D1** Keep all technical role/task/permission names; express the domain model through the
  documented mapping.
- **D2** Do **not** change roles/permissions/workflows/UI/schema in this phase; pin current behaviour
  with tests so any future change is deliberate.
- **D3** Treat “Customer Sorting” = today’s Order Sorting (`picking.execute`), “Receiving Tote” =
  part of Receiving, `sorting`/`putaway`/category-storage = legacy (out of the AYROVI flow).
- **D4** Capacity = per-container configuration (default 50); no sized-type table now.
- **D5** Full container/tote and lifecycle concepts already implemented → documented as-is, no DDL.

## 14. Items intentionally NOT changed

UI redesign · worker screens · dashboards · CRM/Card rebuild · carrier/printer/camera integration ·
WebSocket · warehouse workflow · roles/permissions grants · task registry keys/routes/permissions ·
station model · container sizing model · worker-state machine · category-zone storage behaviour.

## 15. E2E

95/95 e2e tests green on a real Postgres via the repo harness (`cd backend && … npm run test:e2e`),
including the new operating-model suite and all pre-existing workflow suites (auth RBAC, receiving,
category/category-master, operational-flow receiving→tote→sorting→bin→pack→ship→trace,
schema-constraints, warehouse-structure).

## 16. Build

- Backend `nest build`: green.
- Frontend `vite build`: green.
- Unit `npm test`: 38/38 green.

## 17. Screenshot

None needed — read-only model phase; verification is code/DOM-free service + HTTP e2e output above.
(The next phase — Partie 3 STATIONS + WORKER TERMINAL ARCHITECTURE — is where visual verification
becomes relevant.)

---

## Final gate

Partie 3 (Stations + Worker Terminal Architecture / screen design) is **not** started. Awaiting the
formal review of ROLE → WORKER → STATION → TASK → PERMISSION → WORKFLOW and the go-ahead.

**Standing security follow-ups (unchanged):** rotate `INITIAL_ADMIN_PASSWORD` on Render; revoke the
Render API key and the one-shot GitHub PAT used during this engagement.
