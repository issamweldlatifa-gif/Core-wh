# AYROVI — OPERATIONAL UX + WORKFLOW AUDIT (Worker Flow)

**Date:** 2026-09-03 · **Scope:** RECEIVING → TOTE → SORTING → STORAGE → ORDER SORTING → PACKING → SHIPPING
**Method:** line-by-line review of all 6 worker terminals + the backend decision endpoints, then a LIVE end-to-end
human simulation (Scenarios A–H) executed over HTTP against the running server (real DB, real state machine).
**Mandate:** audit only — no features added, no DB changes, no code modified. Two real defects found are
documented below with exact repro; neither prevents operation today, so per the mandate they are reported, not patched.

---

## 1. Workflow UX Score (per stage, /10)

| # | Stage | Score | One-line verdict |
|---|-------|:-:|------------------|
| 1 | RECEIVING | **7.0** | Solid carton/product loop, live tally, loud exceptions — but the tote is opt-in and the fallback is silent (see P0-1) |
| 2 | RECEIVING TOTE | **6.0** | Guard against customer bins is server-hard ✓ — but no always-on CURRENT TOTE banner, no tote-contents view |
| 3 | SORTING + STORAGE | **8.5** | Best screen in the system: one decision, concrete free locations, every edge case answered |
| 4 | CUSTOMER ORDER SORTING | **7.0** | Wrong bin/customer/extra all blocked server-side ✓ — but REQUIRED vs IN-BIN counts are missing at scan time |
| 5 | PACKING | **8.5** | Hard completeness gate, honest INTERNAL carrier, per-line n/m chips — near production grade |
| 6 | SHIPPING | **8.0** | Big deliberate confirm, duplicate dispatch blocked, already-shipped is loud — no station binding though |
| 7 | SCAN EXPERIENCE | **7.5** | Auto-focus + refocus after every submit, Enter handling, beeps, camera dupe-suppression — wedge classifier only on Receiving |
| 8 | ERROR SAFETY | **8.0** | Every dangerous transition is BLOCK→EXPLAIN; two gaps: silent legacy mode, raw 403 text |
| 9 | ADMIN OBSERVABILITY | **7.0** | Exceptions/Traceability/Orders/Shipments boards cover most events — SHORTAGE rows never reach the Exceptions board |

---

## 2. End-to-end human simulation — actual transcript

All calls executed live (worker token `WORKER001` where permitted, supervisor token where required).
Fixture: CRM card `card:SIM94871` (2× SNK sneakers CONFIRMED, 1× MYS with nonexistent category), order `ORD-SIM94871` (AHMED, 2× SNK), decoy order (FATMA).

### Scenario A — Happy path ✅
| Worker action | System response | Next action shown |
|---|---|---|
| Start receiving WAR-001002 | session RCV-000201 RECEIVING | scan carton / product |
| Create tote | `RCN-000002` + printable QR label | scan articles into it |
| Scan SNK ×2 into tote | `ARTICLE_RECEIVED` → ART-…02, ART-…03, category SHOES/SNEAKERS CONFIRMED, container echoed | next article |
| Sorting scan ART-…02 | `DESTINATION` → **ZONE SHOES** + free locations `TUN-MAIN-SHOES-A01-R01-L01/L02` | scan location |
| Scan location L01 | `STORED ✓` (audited) | next article |
| Order-sorting scan ART-…02 | **SKU SNK → CUSTOMER AHMED → BIN BIN-000001** | scan the bin |
| Scan BIN-000001 | `ARTICLE_ASSIGNED` + progress `{missing: SNK 1/2}` | next article |
| Assign ART-…03 | `BIN_READY_FOR_PACKING` (special beep) | bin → packing bench |
| Packing scan BIN-000001 | CUSTOMER/ORDER/lines `2/2` COMPLETE | CONFIRM PACKED |
| PACK | `OUT-000002` READY_TO_SHIP, carrier NULL→INTERNAL, printable label | carton → shipping area |
| Shipping scan OUT-000002 | customer, order, 2 articles listed | CONFIRM DISPATCH |
| DISPATCH | `SHIPPED` — articles SHIPPED, bin CLOSED (row kept) | scan next shipment |
| Trace ART-…02 | full chain card→arrival→session→order→customer→OUT→shippedAt | — |

### Scenario B — Wrong/unexpected article ✅
Scan `XXX-NOPE-…` at receiving → `UNEXPECTED_ARTICLE`, ArticleUnit still created **in the tote** (physically somewhere = traceable), discrepancy `UNEXPECTED_PRODUCT` OPEN, immediately on admin Exceptions board with worker name + session. Screen shows red “NOT ON EXPECTED LIST → EXCEPTION (in RCN-…)”.

### Scenario C — Missing article (shortage) ⚠️
Card expects 3, worker scans 1, presses COMPLETE → **403 “Receiving has discrepancies; a supervisor must close it.”** (correct gate). Supervisor completes → `COMPLETED_WITH_DISCREPANCY`, lines marked `SHORT`.
**Defect D-2:** no `SHORTAGE` row is ever written to `receiving_discrepancies` — the admin **Exceptions board never shows shortages** (verified: board listed only OVERAGE + UNEXPECTED after close). Shortage is only discoverable via session detail. This contradicts the approved spec (“any shortage … → Exception visible to Admin”).

### Scenario D — Wrong storage location ✅
Store SHOES article into CLOTHING location → **409 “Wrong zone: SHOES is configured for zone SHOES, scanned CLOTHING.”** Nonexistent location → 404 “Location not found.” Blocked location would 409 with its status. All BLOCK→EXPLAIN.

### Scenario E — Wrong customer bin ✅
Assign AHMED’s sneaker into FATMA’s bin → **409 “WRONG BIN: order ORD-…-B (FATMA) does not need SKU SNK-…”.** Wrong customer = same rejection; non-customer container = “not a customer bin”; bin without order = blocked.

### Scenario F — Incomplete order ✅
Packing scan at 1/2 → banner INCOMPLETE, line chip `1/2` yellow, button reads **“BIN INCOMPLETE — CANNOT PACK”** and is disabled; forced API call → 409 “Order incomplete: SNK-… 1/2.” Double protection (UI + server).

### Scenario G — Duplicate shipment ✅
Second dispatch → **409 “Shipment OUT-000002 is already SHIPPED.”** Re-scan of a shipped label shows status SHIPPED with red banner and NO dispatch button. Also verified: duplicate PACK → 409, duplicate STORE → 409 “Article is STORED — cannot store”, duplicate BIN assign → 409 “already IN_CUSTOMER_BIN”, re-scan of stored article at sorting step-1 → clean `REJECTED` decision (not an exception).

### Scenario H — NEEDS_REVIEW category ✅
Article with unknown category (`qqqq-nonexistent`) is received fine (receiving never blocks on category), then at sorting: `NEEDS_REVIEW / MANUAL REVIEW REQUIRED` with explicit instruction “Hand this article to a supervisor.” Forced store attempt → 409. Nothing guessed, exactly per blueprint §8/§9.

**Extra probes:** article scanned after order already complete → `NO_ORDER: “No open order needs SKU …”` + “Set the article aside — a supervisor decides” (and the article can still be STORED via sorting — no dead end). Permissions: WORKER001 (INBOUND_WORKER) calling order-sorting/packing/shipping → 403 with the raw permission key (see P1-6); terminal home correctly never offers those tasks.

---

## 3. Defects found (none patched — mandate)

| ID | Sev | What | Repro | Suggested fix (for approval) |
|----|-----|------|-------|------------------------------|
| **D-1** | **HIGH (operational safety)** | **Silent “legacy mode” at receiving:** if the worker scans products with **no tote selected**, units are only tallied — **no ArticleUnit is created**, so those pieces are invisible to Sorting/Order-sorting/Packing forever. The only hint is a small grey note “no tote: units are only tallied (legacy mode)”. A rushed worker WILL hit this. | Receiving screen → skip tote → scan product → tally moves, no ART- code exists | Make the tote mandatory for product scans (block + “SELECT OR CREATE A TOTE FIRST”), or demand an explicit opt-in toggle per session |
| **D-2** | **HIGH (admin visibility)** | **Shortages never reach the Exceptions board:** `complete()` marks lines `SHORT` and the session `COMPLETED_WITH_DISCREPANCY`, but writes no `SHORTAGE` discrepancy row. Admin Exceptions (which reads `receiving_discrepancies`) shows nothing. | Scenario C above | On supervisor close, create one `SHORTAGE` row per short line (type exists in the enum already; append-only, no schema change) |
| **D-3** | MEDIUM | `GET /fulfillment/articles?status=<invalid>` → **500** (unvalidated enum cast passed to Prisma). Same pattern in `outbound-shipments` and `containers` filters. UI never sends invalid values, but a crafted URL 500s and pollutes logs. | `curl …/fulfillment/articles?status=BOGUS` → 500 | Whitelist-validate the query enum → 400 or ignore |
| **D-4** | MEDIUM | **Order-sorting scan omits REQUIRED / IN-BIN counts.** Spec for this screen: `REQUIRED: 2 / IN BIN: 1`. The server computes exactly this in `findOrderNeeding` but doesn’t return it; the worker only sees progress AFTER committing the assign. | Scan article at order-sorting → response has sku/customer/bin only | Add `progress {have, need}` to the `ASSIGNMENT` response + one line in the decision panel (no DB change) |
| **D-5** | LOW | Raw 403 text `Missing required permission(s): picking.execute` if a worker ever hits a task URL outside their role (normally unreachable — home hides them). | direct URL | Map 403 in terminal screens to “NOT YOUR TASK — ASK A SUPERVISOR” |

**No conflicts / no regressions found** in receiving/putaway/card integration; every legacy suite behavior intact.

---

## 4. Screens needing improvement (worker-speed lens)

1. **ReceivingTask** — the CURRENT TOTE indicator is a small tag inside the product box, below the fold on handhelds. Needs: sticky top-bar chip `TOTE RCN-000002 · 5 ARTICLES` visible during every scan + a tap-to-view contents list (data already exists via `GET /fulfillment/containers/:code`). “ARTICLES REMAINING” exists as the UNITS n/m metric — adequate.
2. **OrderSortingTask** — add REQUIRED/IN-BIN chips at scan time (D-4); when several bins sit side by side the big printed customer label carries the load — on-screen the bin code should render in the `fl-biglabel` size during step 2, not body size.
3. **SortingTask** — nothing blocking. Nice-to-have: after `STORED ✓`, echo the location it went to in the persistent step header for 2–3 s (currently only in the outcome flash + log).
4. **ShippingTask / PackingTask** — good as-is for bench use.

## 5. Status transitions needing change
**None require change.** Verified server-enforced and correct:
`RECEIVED→IN_CONTAINER→STORED→IN_CUSTOMER_BIN→PACKED→SHIPPED` (no skips, no backwards), bins `ACTIVE→READY_FOR_PACKING→PACKED→CLOSED`, shipment `READY_TO_SHIP→SHIPPED` once. The only *addition* worth approving: D-2’s SHORTAGE discrepancy row (an audit artifact, not a new state).

## 6. Scan interactions needing improvement
- **Auto-focus:** present on all 6 screens, incl. refocus after every submit ✓
- **Enter handling:** all inputs ✓ · **Camera dupe suppression:** 2.5 s window ✓ · **Audio:** success/error/info/done beeps ✓
- Gaps: (a) wedge-burst classifier (gun vs human typing) only on Receiving — the 4 flow terminals log everything as MANUAL (metadata-only issue, P2); (b) no global hotkey to reopen the camera scanner (button only); (c) `printLabel` no-ops silently when popups are blocked — worker may wait for a dialog that never comes (add a “popup blocked” toast, P2).
- **Where the Continuous Camera Scanner belongs (do not implement changes now):** it is already wired on all 6 screens. Recommended *primary* use: Sorting location scans and Shipping OUT labels (large codes at distance). Keep wedge/manual primary at the Packing bench and Order-sorting (hands full, codes at arm’s length).

## 7. Missing admin visibility
1. **SHORTAGE** exceptions (D-2) — the one real hole.
2. No `NEEDS_REVIEW` filter on the Traceability board (status filters only cover lifecycle; a supervisor can’t list all articles stuck on category review). Data exists (`categoryStatus`).
3. `UNMAPPED / AMBIGUOUS` destination events are shown to the worker but leave no admin trace — an audit row or counter would let admins fix the mapping before workers pile up.
4. Everything else verified visible: unexpected/overage (with worker + session), NEEDS_REVIEW per-article via trace, wrong-bin/pack/ship blocks (4xx, by design not exceptions), packing/shipping pipeline counters on Control Center.

## 8. Blocks real operation (must fix before go-live)
- **D-1** (silent legacy mode) — pieces can vanish from the flow with zero warning. This is the single finding I would not go live with.
- **D-2** (invisible shortages) — admins fly blind on the most common real-world discrepancy.

## 9. Safe to defer
D-3 (500→400), D-4 (counts at scan), D-5 (403 wording), tote banner/contents view, NEEDS_REVIEW filter, UNMAPPED audit, wedge classifier on flow terminals, popup-blocked toast, station-task binding (shipping currently permission-gated only — acceptable while stations are advisory).

## 10. Execution list (P0 → P2) — all pending approval, none executed
| P | Item | Effort | Touches |
|---|------|--------|---------|
| **P0-1** | Receiving: block product scans without a tote (or explicit per-session opt-out) | S | ReceivingTask.tsx only |
| **P0-2** | Write SHORTAGE discrepancy rows on supervisor close | S | receiving.service.ts `complete()` + e2e |
| **P1-3** | `ASSIGNMENT` response + UI: REQUIRED/IN-BIN counts | S | fulfillment.service/controller + OrderSortingTask |
| **P1-4** | Validate status/type query enums → 400 | S | fulfillment.controller |
| **P1-5** | Sticky CURRENT TOTE chip + tote contents drawer | M | ReceivingTask.tsx |
| **P1-6** | Worker-language 403 mapping in terminals | S | shared error helper |
| **P2-7** | NEEDS_REVIEW filter on Traceability board | S | Traceability.tsx (+query param) |
| **P2-8** | Audit row on UNMAPPED/AMBIGUOUS sorting decisions | S | fulfillment.service |
| **P2-9** | Wedge-burst classifier on the 4 flow terminals | S | shared hook |
| **P2-10** | Popup-blocked toast in printLabel | S | print-label.ts |

---
*Audit artifacts: simulation ran against commit `e391237`; test data tagged `SIM94871` retained in dev DB for reinspection (`ART-00000002…06`, `BIN-000001/2`, `OUT-000002`, sessions `RCV-000201+`).* 
