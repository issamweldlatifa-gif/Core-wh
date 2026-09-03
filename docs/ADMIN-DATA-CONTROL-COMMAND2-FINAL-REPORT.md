# Data Control (Soft-Void) — COMMAND #2 FINAL REPORT

**Status:** DELIVERED + LIVE on Render
**Live commit:** `134338ae9b01c9592010350655565d3c97877c63` (`134338a`)
**Render service:** Core-wh — https://core-wh.onrender.com — `/admin/data-control`
**Local + production databases:** verified clean of operational/test rows (master data preserved)

---

## 1. What the operator asked (COMMAND #2)

> “We have accumulated test data being displayed; clean it all so it is clean,
> and give us control so we can void records ourselves — sometimes the same
> card/carton is entered twice by mistake, or a barcode/carton arrives wrong —
> instead of letting things pile up. Void/delete must be possible only from
> the admin side.”

Confirmed scope decisions with the operator:
- Wipe current operational/test rows on **local and Render**, keep master data
  (warehouses, zones, stations, categories) and user accounts/roles.
- Void by **any code type** (WAR / CTN / RCN / BIN / ART / ORD — unified search).
- **Soft void only**: terminal state + written `reason` + `DATA_VOIDED` audit
  naming the admin actor. **Never irreversible delete**.
- Show **all matches when the same code was scanned twice** so the wrong record
  can be voided precisely (do not error out).
- Expose it as a new **“Data Control” admin page under MONITORING**, admin-only.

## 2. Deliverable summary

### 2.1 Data cleanup (performed before the feature shipped)
Operational/training rows were removed from **both** databases in single
transactions. Final state after deploy (re-verified on production 2026-09-03):

| Table (production)   | Count | Note |
|----------------------|-------|------|
| expected_arrivals    | 0     | cards wiped |
| receiving_sessions   | 0     | wiped |
| receiving_cartons    | 0     | wiped |
| warehouse_cartons    | 0     | wiped |
| operational_containers | 0   | wiped |
| article_units        | 0     | wiped |
| warehouse_orders     | 0     | wiped |
| audit DATA_VOIDED    | 0     | clean at ship |
| **stations**         | **8** | **master data preserved** |
| **category_master**  | **4** | **master data preserved** |
| **users**            | **7** | **accounts preserved** |

Local dev DB mirrors this: operational = 0, stations 5, categories 4,
users ADMIN001 + WORKER001. `start.sh` seeding is **additive/idempotent**
(roles, master structure, users only) — it never recreates operational rows,
so the databases stay clean across every future deploy.

### 2.2 Soft-void Data Control (admin-only)
New backend routes under `/api/v1/operations` (module `operations`):
- `GET  data-control/search?q=…`  — one input, five entity kinds: arrival
  cards, cartons, containers/totes/bins, articles, orders. Matches codes,
  barcodes, QR, references and customer info (case-insensitive). Every hit
  returns a stable `id` so identical scanned codes stay individually voidable.
- `GET  data-control/voided`      — recent voids derived from the audit trail
  (actor, reason, previous status, timestamp).
- `POST data-control/void`        — **admin only** (`operations.correct`).
  Body `{ kind, id?, code, reason }`. Enforces a written reason (≥ 2 chars)
  and refuses: already-voided rows (409), non-voidable terminal states
  (packed/shipped/closed), arrivals that already have receiving sessions,
  cartons that already produced articles.

Semantics per kind (never deletes):
- **arrival** → `VOIDED` (blocked if sessions exist — finish/cancel first).
- **carton** → `VOIDED` (EXPECTED/FLAGGED/WRONG_SHIPMENT only; if received and
  already produced articles, void the articles instead).
- **container / tote / bin** → `VOIDED` **+ cascades its articles** to `VOIDED`,
  clears `containerId/orderId/orderItemId` so live expected-vs-count boards stay
  honest.
- **article** → `VOIDED`, pointers cleared (blocks PACKED/SHIPPED).
- **order** → `CANCELLED` **+ cascades its customer bins and articles**, cancels
  its OPEN order items. If an order reference cannot be cancelled, the API
  explains exactly why instead of failing silently.

Every successful void writes one `DATA_VOIDED` audit row:
`actor (admin) + ip + entityType/entityId + previousStatus + reason + cascaded list`.

### 2.3 UI — “Data Control” page
New admin page `/admin/data-control`, added to the **MONITORING** navigation group.
- Viewing requires `operations.view`; the **Void action additionally requires
  `operations.correct`** and the page tells non-admin viewers they cannot void.
- Big monospace search box (debounced). Typing a code lists **every** matching
  record across all kinds with status chips; duplicate scans show as separate
  rows.
- “void” on a row opens a confirmation dialog: current state, cascading
  warning, **mandatory reason (≥ 8 chars)**, explicit “soft void, never
  deleted” messaging.
- “Recent voids (audit)” table shows actor (name + code), reason, previous
  status and timestamp for every admin void.
- Honest empty states throughout (clean start → “No voids recorded yet”).

### 2.4 Schema (additive) + durability
- New values added to Postgres enums (idempotent migration
  `20260903140000_admin_data_void_control`):
  `ExpectedArrivalStatus.VOIDED`, `CartonStatus.VOIDED`,
  `ContainerStatus.VOIDED`, `ArticleUnitStatus.VOIDED`,
  `AuditAction.DATA_VOIDED`.
- The same statements are mirrored in the boot **schema self-heal**
  (`bootstrap-schema-repair.ts`) and registered in its applied-migration list,
  so a drift on Render repairs itself at boot exactly like every earlier
  operational migration.

## 3. Verification evidence
- Backend `npm run build` clean; frontend `tsc --noEmit` clean.
- **Automated smoke suite** (local, real API + real DB; fixtures cleaned after):
  duplicate arrival reference listed as 2 rows → void by id flips exactly one;
  duplicate barcode cartons listed as 2 rows → void by id flips one; re-void →
  409; empty reason → 400; container void cascades its 2 articles; order void
  cascades bin + article + cancels order; **worker (non-admin) void → 403**;
  unauthenticated → 401; voided log shows `ADMIN001` + reason; survivor stays
  searchable and voidable. All PASS.
- **UI walkthrough (local Vite + Playwright)**: landed on Data Control; search
  `6291041500213` → two duplicate carton rows; dialog opened; void applied;
  arrival-duplicate search + void; “Recent voids” shows ADMIN001 entries.
  No console/page errors. Screenshots in `/home/user/artifacts/`:
  `datacontrol-1-landing.png`, `-2-duplicate-cartons.png`, `-3-void-dialog.png`,
  `-4-after-void.png`, `-5-recent-voids.png`.
- **Production (Render, acceptance surface)**: commit `134338a` live;
  `/admin/data-control` loads with the new MONITORING nav item, empty honest
  states, **no console errors** — screenshot
  `/home/user/artifacts/datacontrol-render-live.png`. Production API returns
  `[]` for search and voided-log (clean). DB enums confirmed to include
  `VOIDED`; master data intact.

## 4. Rules the operator should know
- Voiding is **permanent state** (soft). Nothing is ever deleted; every void is
  on the audit trail with the admin’s identity and reason.
- Duplicate/wrong entries that are still **EXPECTED/OPEN/ACTIVE** void cleanly.
  Records already packed, shipped or closed, and arrivals that already have
  receiving sessions, cannot be voided from this page — finish/cancel those
  through the existing Corrections flow first, then void.
- Only admin (permission `operations.correct`) can void. Workers and terminal
  screens have no void surface.

## 5. Outstanding security follow-ups (operator action still pending)
- Rotate `INITIAL_ADMIN_PASSWORD` in the Render dashboard.
- Revoke the Render API key and the GitHub one-shot PAT used during this work.
