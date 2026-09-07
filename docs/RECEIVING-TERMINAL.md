# Receiving Terminal — Card-Based Rebuild

The Receiving module is the **physical receiving operation** owned by the
Receiving Worker. It is a **dedicated full-page operational workspace** on the
Worker Terminal (phone app, CT40 and web), not a dashboard card, drawer or
modal.

> Terminal = Worker operational workspace.
> Dashboard / Admin = navigation, management and oversight.

---

## 1. The card contract (CRM → Warehouse → Worker device)

The CRM pushes **two INDEPENDENT card types** — they are never merged,
altered or mixed:

| Card | Source | Carries |
|------|--------|---------|
| **PRODUCT CARD** | Customer Arrival Card | SKU / reference / QR / barcode identifiers, product name, category (+ status vs Category Master), expected quantity |
| **CARTON CARD** | Shipment Card | carton reference, tracking / track number, QR, barcode, sender, shipping date, weight, dimensions, metadata, carton `n/total` |

The worker device downloads the expected card data with the session and keeps
it for **device-side matching**. The backend remains the single source of
truth: synchronization, persistence, final validation, state update,
duplicate/conflict protection and the worker activity log.

---

## 2. The two real workflow entries — PRODUIT and CARTON

The receiving screen offers two explicit, visually-dominant entries:

- **PRODUIT** → Product Verification / Matching (product cards only)
- **CARTON** → Carton Verification / Matching (carton cards only)

Each entry is a genuine workflow switch (mode state on the device, lane
buttons on the web terminal), not a label. The CT40 uses the physical
trigger → same QR/barcode scan pipeline; the phone uses the shared scan
pipeline (camera / wedge / manual / OCR); the web terminal uses the same
dual-scanner host (hardware-first on desktop, software on mobile, OCR when
the station supports it). **No second scanner system exists — CT40 and OCR
are reused, not rebuilt.**

### PRODUCT lane

```
scan / OCR identifier → normalize → match vs PRODUCT CARDS (device-side)
  ├─ MATCH (open card)          → verification screen → CONFIRM (worker action)
  │                               → POST confirm-product → backend re-validates,
  │                               persists, logs → flash MATCH → back to lane
  ├─ MATCH (completed card)     → "CARD ALREADY COMPLETE" — local reject,
  │                               NO write (duplicate completion protection)
  └─ no match                   → MISMATCH: nothing is confirmed/completed,
                                  the failure is LOGGED (report-mismatch)
```

### CARTON lane

```
scan identifier → normalize → match vs CARTON CARDS (device-side)
  ├─ carton identity (external id / reference / QR / barcode)
  │    ├─ open carton       → verification screen → CONFIRM → confirm-carton
  │    └─ received carton   → "CARTON ALREADY RECEIVED" — local reject, NO write
  ├─ shipment TRACKING number
  │    ├─ 0 open cartons    → "all received" banner — NO write
  │    ├─ 1 open carton     → verify (matched on TRACKING NUMBER) → CONFIRM
  │    └─ 2+ open cartons   → AMBIGUOUS banner + codes — NO write (scan the
  │                           specific carton)
  └─ no match               → MISMATCH → logged (report-mismatch)
```

**Explicit confirmation:** a match only *opens* the confirm step; the receipt
is written only when the worker presses CONFIRM. MISMATCH never confirms and
never completes a card or session.

---

## 3. Backend (NestJS + Prisma + PostgreSQL)

Module: `backend/src/modules/receiving/` (service + controller rewritten).
Legacy `scan-carton` / `receive-carton` / `receive-product` routes are
**removed** — they no longer exist anywhere in the API surface.

REST endpoints (`/api/v1/receiving`, JWT `WORKER_NATIVE`):

| Route | Purpose |
|-------|---------|
| `GET /arrivals` | Arrivals that can be received (EXPECTED / RECEIVING / PAUSED) |
| `GET /arrivals/:idOrCode/active` | Active session for an arrival (resume) or `null` |
| `POST /arrivals/:idOrCode/start` | Start (or resume) with device context `{deviceType, deviceName, scanSource}` |
| `GET /sessions/:id` | Session detail **with the expected card data** (`productCards`, `cartonCards`), tally, flash |
| `POST /sessions/:id/confirm-product` | PRODUCT lane confirm `{identifier, identifierType, quantity, source, operationId, startedAt}` |
| `POST /sessions/:id/confirm-carton` | CARTON lane confirm `{identifier, identifierType, source, operationId, startedAt}` |
| `POST /sessions/:id/mismatch` | Device-side matching found no card — failure log only |
| `POST /sessions/:id/pause` · `resume` · `complete` · `flag` | Session lifecycle (complete → dispatches the container/placement tasks for the next stage) |
| `POST /discrepancies/:id/resolve` | Supervisor-only discrepancy resolution |

Guards, exactly as before: one active session per arrival, `operationId`
idempotency (C-4), station/assignment gating, `receiving.view` /
`receiving.execute` / `receiving.resolve_discrepancy` permissions.

### Worker activity log

Every physical operation writes a `ReceivingWorkerLog` row **atomically with
the state change** — Who / What / When / Card / Card Type / Operation /
Identifier Type / Identifier Value / Source / Result / Duration / Device:

- `operation`: `CONFIRM` | `SCAN_REJECT` | `DUPLICATE_REJECT`
- `result`: `MATCH` | `MISMATCH` | `DUPLICATE` | `AMBIGUOUS`
- `cardType`: `PRODUCT` | `CARTON` (the two independent card types)
- `durationMs`: device scan-start → server verdict (the device sends
  `startedAt`)

### Flash contract (backend → device)

| Kind | Lane(s) | Meaning |
|------|---------|---------|
| `MATCH` | both | Confirmed (product: `sku/expected/received`; carton: `carton{...}`) |
| `CARD_ALREADY_COMPLETE` | both | Duplicate completion rejected (no double write) |
| `MISMATCH` | both | Identifier matched no card — logged as failure |
| `TRACKING_AMBIGUOUS` | carton | Tracking matches several open cartons (+ `cartons[]`) |
| `WRONG_SHIPMENT` | carton | Identifier belongs to another arrival/shipment (+ `shipment{...}`) |

---

## 4. Worker app (Android — `mobile/`)

`mobile/worker-core/src/main/kotlin/com/ayrovi/worker/` (new contract, old
steps removed — no legacy steps, intents or flows remain):

- **`domain/CardMatcher.kt`** — device-side matching (normalize → uppercase
  compare; product = identifiers/SKU/reference; carton = identifiers then
  tracking resolution → Card / AllReceived / Ambiguous).
- **`domain/ReceivingWorkflow.kt`** — one state machine for both lanes:
  steps `ARRIVAL → PRODUCT/CARTON → REVIEW_PRODUCT/REVIEW_CARTON →
  (CONFIRM) → REVIEW_COMPLETE → COMPLETE`, plus `PAUSED` and `RECONCILE`
  (unconfirmed-write recovery). Single-flight mutations; the pending journal
  reconciles on reconnect; ambiguous/already-complete verdicts never write.
- **`domain/ReceivingFeedback.kt`** — beeps/banners per verdict (success /
  warning / error / info), device-only for local rejects (no network traffic
  for an already-complete card).
- **`data/`** — `ReceivingGateway` (confirmProduct / confirmCarton /
  reportMismatch + session lifecycle), `Dtos` (card DTOs with `identifiers`),
  `MutationJournal` (idempotent, per-kind outcome inference on reconnect).
- **App layer** — `ReceivingScreen` / `ReceivingViewModel` / `ReceivingParts`
  (Industrial Terminal Design System: the PRODUIT/CARTON mode selector is the
  entry; `StepIndicator` total = 5; CT40 footer buttons, phone toolbar).
  **Theme unchanged** — colors, typography, buttons, icons, cards, spacing,
  navigation all from the existing design system.

Tests (`mobile/worker-core/src/test/…`): workflow (match/mismatch/duplicate/
ambiguous/multi-card/offline-reconcile), lane behaviour (cross-lane
mismatches logged with the correct card type, unsubmitted reviews discarded,
rapid-tap protection, gating not bypassable), full HTTP journey (real
repository + transport vs MockWebServer: exact routes, payloads, key sets),
feedback matrix. Android `androidTest`: journey + secure session store.

---

## 5. Web Worker Terminal (`frontend/src/terminal/`)

`ReceivingTask.tsx` rebuilt on the same contract (the single canonical
route `/terminal/receiving`; legacy paths still redirect to it):

- **PRODUIT / CARTON** entry buttons (the two real workflow entries).
- Device-side matching via the pure module
  `frontend/src/modules/receiving/match.ts` (same rules as the backend
  normalizer; unit-tested against the full E2E matrix).
- Explicit CONFIRM step; local rejects (already complete, ambiguous,
  all-received) never hit the network for a write; mismatches log via
  `report-mismatch`.
- Reuses the existing dual-scanner host + OCR + wedge classification +
  feedback beeps; same terminal CSS tokens (`os-theme.css`) — no new visual
  language, responsive as before.

---

## 6. Admin Control Center — "Receiving Workers"

New section **`/admin/receiving-workers`** (nav: WAREHOUSE → *Receiving
Workers*, `operations.view`) backed by
`GET /api/v1/operations/receiving-workers` (filters: worker, cardType,
result):

**Columns — Who / What / When / Card / Identifier / Result / Device /
Duration:**
Worker · Worker ID · Task · Card · Card Type · Operation · Identifier Type ·
Identifier Value · Result · Date · Time · Duration · Device.

Read-only oversight in the existing Admin theme (same shell, same table/
tag tokens). The data is the `ReceivingWorkerLog` written by the backend —
the admin sees every logged scan/confirm/reject, including mismatches and
duplicate rejects, with the device and the operation duration.

---

## 7. Deployment

- Render auto-deploys the `arena/01a07a6d-core-wh` branch (single web
  service: API + SPA). `start.sh` runs the reviewed Prisma migration
  (`20260907000000_receiving_card_rebuild`) and hard-fails on schema drift.
- Worker app: `android-build.yml` (push-triggered) builds + tests and
  publishes the debug APK artifact `ayrovi-worker-receiving-pilot-<sha>`;
  `android-release.yml` remains manual.

## 8. Run (local)

```bash
# database (PostgreSQL) + backend + frontend
cd docker && docker compose up --build
# or local dev — see README
```
