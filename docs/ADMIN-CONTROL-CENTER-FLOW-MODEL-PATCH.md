# PATCH REPORT — Admin Control Center FLOW MODEL (no Category gate)

Commit: `314338d` (on top of Admin Control Center V1 `6a552ec`)
Scope: Admin Control Center only — **no** worker-terminal screen or backend
workflow was rebuilt. Admin Shell / Header / Sidebar / Workers / Stations /
Exceptions / Live Activity / Audit-Trace / RBAC / theme / responsive /
performance are untouched.

---

## 1. What changed in the Admin UI

Only the **Operation Pipeline** model (and the honest labelling around it)
changed:

- The pipeline no longer contains a **CATEGORY SORTING** stage and no longer
  presents **STORAGE** as a required step — Storage stays a real worker
  module but is marked **OPTIONAL PATH** and is *not* part of the flow the
  admin watches.
- The pipeline caption now reads
  `arrival → … → archive / trace · real counts only · no category gate`.
- Operations panels relabeled: `SORTING · OPTIONAL PATH`, `STORAGE · OPTIONAL
  PATH`, `CUSTOMER ORDER SORTING`; `SORTING`’s OPEN target now points at the
  real tote board (`/admin/containers`), STORAGE has no fabricated screen.
- Containers board (RECEIVING totes + CUSTOMER bins) adds **Created** and
  keeps **Updated**, article counts are live; it states plainly that
  capacity / FULL is **not modelled yet** (never fabricated).

## 2. The new pipeline (exact order, real counts)

```
ARRIVAL → RECEIVING → RECEIVING CONTAINER / TOTE → CUSTOMER SORTING
       → CUSTOMER BIN → PACKING → SHIPPING → ARCHIVE / TRACE
```

| # | Stage | Real metrics shown |
|---|-------|--------------------|
| 01 | ARRIVAL | waiting arrivals (not started) · in-progress arrivals · arrivals received |
| 02 | RECEIVING | active sessions · sessions completed today · open exceptions |
| 03 | RECEIVING CONTAINER / TOTE | active totes · articles in totes |
| 04 | CUSTOMER SORTING | open orders · articles awaiting assignment · articles in bins |
| 05 | CUSTOMER BIN | active bins · bins ready for packing · bins done today |
| 06 | PACKING | waiting bins (ready) · shipments packed today |
| 07 | SHIPPING | awaiting-dispatch shipments · shipped today |
| 08 | ARCHIVE / TRACE | total shipments (traceable) · closed bins |

Category and storage-location routing are deliberately **absent** — an
article moves `tote → customer bin` through CUSTOMER SORTING with no
category prerequisite.

## 3. Container / Tote data displayed

The `Containers` board reads the real fulfillment containers projection
(`GET /api/v1/fulfillment/containers`, type/status filters):

| Field | Source |
|---|---|
| Code (`RCN-…` / `BIN-…`) | `operational_containers.code` |
| Type · Status | `type` (RECEIVING/CUSTOMER) · `status` (ACTIVE / READY_FOR_PACKING / PACKED / CLOSED) |
| Label / Order / Customer | `label`, `order.externalOrderReference`, `order.externalCustomerReference` |
| Articles inside | live `_count.articles` |
| Created / Updated | `createdAt` / `updatedAt` |

Per-container **contents / full traceability**: article-level history is
already queryable through the existing trace endpoint
(`GET /api/v1/fulfillment/articles/:code/trace`) from the Audit / Trace
board. A per-tote drill-down UI is **not part of this patch** (see
limitations) — counts are real, nothing is invented.

## 4. APIs / data sources used

All numbers come from the existing overview aggregate — **one request**,
polled at the shell level (30 s):

- `GET /api/v1/operations/overview` → `pipeline[]`, `operations[]`,
  `containers`-independent tote counters (`toteContainersActive`,
  `articlesAwaitingSorting` = articles in totes), arrival counters, order /
  bin / shipment counters.
- `GET /api/v1/fulfillment/containers?type=&status=` → the containers table.
- No schema migration, no new table, no change to Receiving / Sorting /
  Packing / Shipping workflow services. The worker screens and `terminal`
  routes are byte-identical to V1.

## 5. Visual preview

Live app (sandbox preview on :3000, sign in `ADMIN001` / `ChangeMe!2024` →
`/admin`). Screenshots captured this session (workspace, not committed):

- `artifacts/flow-admin-overview.png` — pipeline with live TOTE/BIN data
- `artifacts/flow-admin-containers.png` — RCN tote + BIN with article counts
- `artifacts/flow-admin-operations.png` — full pipeline + operations panels
- `artifacts/flow-admin-workers.png` — workers board (unchanged)

Live proof recorded: arrival `WAR-001001` → open session `RCV-000201` →
tote `RCN-000001` (2 articles) → customer order `ORD-…-A / SAMI` → bin
`BIN-000001 READY_FOR_PACKING` (2 articles) — executed through the **real
backend workflow** with the product category left **UNCLASSIFIED**, i.e.
`NEEDS_REVIEW`, and the article still flowed to the customer bin.

## 6. Tests / build / e2e

- Backend build clean · frontend `tsc --noEmit` + `vite build` clean.
- Unit: **38/38**.
- E2e: **88/88** (added case 16c: asserts the exact 8-stage pipeline
  contract, that no stage is a category gate, and that tote + customer
  stages expose live waiting/article metrics).
- Browser pass (headless Chromium): `/admin`, `/admin/operations`,
  `/admin/containers`, `/admin/workers` — no console errors; pipeline,
  operations panels and the containers table render the live rows above.

## 7. Limitations (explicit, not in scope of this patch)

- **Capacity / FULL is not modelled** (no capacity engine on containers in
  this repo — deferred in the schema). The board therefore shows real
  statuses (ACTIVE / READY_FOR_PACKING / PACKED / CLOSED) and live article
  counts, and says so instead of inventing a FULL state.
- Container **worker/station at scan time and closed-at** are not captured
  on the container row itself; article-level traceability covers the
  chain. A per-tote drill-down (contents, lifecycle) is future work.
- No pipeline change to worker screens: the optional category-storage
  modules (`sorting`, `putaway`) still exist on the floor as-is.
