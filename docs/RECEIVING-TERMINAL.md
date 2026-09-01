# Receiving Terminal — Implementation

The Receiving module is the **physical receiving operation** owned by the
Receiving Worker. It is a **dedicated full-page operational workspace**, not a
dashboard card, drawer or modal.

> Terminal = Worker operational workspace.
> Dashboard = Navigation / management workspace.

---

## Architecture

```
WAREHOUSE LOGIN
     ↓
WAREHOUSE DASHBOARD      (navigation + overview)
     ↓   "Receiving"
/warehouse/receiving     (full-screen route)
     ↓
FULL-SCREEN RECEIVING TERMINAL
     ↓
PHYSICAL RECEIVING OPERATION
     ↓
RECONCILIATION
     ↓
RECEIVED / RECEIVED_WITH_DISCREPANCY
```

The full-screen route lives **outside** the dashboard shell so the terminal
owns the viewport and the dashboard does not compete visually.

The arrival/shipment data comes from AYROVI / Arrival CRM through the existing
server-to-server integration (Customer Arrival Card + Shipment Card). The
Warehouse is the owner of all physical receiving operations.

```
AYROVI  ──(server-to-server API)──▶  WAREHOUSE BACKEND  ──▶  WAREHOUSE DATABASE  ──▶  RECEIVING TERMINAL  ──▶  WORKER
```

---

## What was built

### Backend (NestJS + Prisma + PostgreSQL)

- Device & scan-source support added to the receiving data model via a new
  migration (`20260901140000_receiving_device_scan_source`):
  - `ScanSource` enum → `CAMERA | EXTERNAL_SCANNER | MANUAL`
  - `ReceivingCarton.source` — records the input device of each carton scan
  - `ReceivingSession.deviceType / deviceName / scanSource` — device context
- `ReceivingController` / `ReceivingService` now accept:
  - `start(...)` device context (`deviceType`, `deviceName`, `scanSource`)
  - `scan-carton`, `receive-carton`, `receive-product` accept `source`
  - scan source is persisted and returned in the session detail; it is also
    written into the immutable audit trail for every operation.
- The receiving workflow was already present and is reused unchanged — the
  **same operational events** are received regardless of the input device.

REST endpoints (`/api/v1/receiving`): arrivals, active, start, session,
scan-carton, receive-carton, receive-product, pause, resume, flag, resolve,
complete.

### Frontend (React + TypeScript + Vite)

New module `frontend/src/modules/receiving-terminal/`:

- `ReceivingTerminal.tsx` — the full-screen terminal with all operational
  areas: session/worker header, shipment, customer arrival, carton scanner,
  current carton, progress, expected products, product scanner, warnings
  (persistent), carton queue, activity log, reconciliation + completion.
- `terminal.css` — industrial operational styling; responsive for
  smartphone / tablet / desktop (mobile reorders panels around the scanner).
- `scan-source.ts` — device capability detection + scan-source abstraction
  (`CAMERA | EXTERNAL_SCANNER | MANUAL`), including keyboard-wedge
  classification (fast burst ≈ external scanner, slow ≈ manual).
- `ScanField.tsx` — reusable scanner input: auto-focus (scanner-first), QR /
  barcode / keyboard-wedge / manual, and a camera button.
- `CameraScanner.tsx` — in-browser camera scanning using the native
  `BarcodeDetector` API + `getUserMedia`; requests permission only when the
  camera is opened and degrades gracefully when unsupported
  (→ external scanner or manual entry).
- `frontend/src/modules/receiving/api.ts` — extended to send `source` and
  device context.

### Session recovery & resilience

- Starting an arrival with an existing active (RECEIVING / PAUSED) session
  **resumes** it — the system never silently creates a second session.
- Network interruption is detected and surfaced; the session is preserved and
  scans are **idempotent** via client `operationId`, so reconnects never
  duplicate receiving events.
- Pause / Resume / Exit keep the session persisted server-side.

### RBAC

Terminal actions are enforced by the backend through permissions
(`receiving.view`, `receiving.execute`, `receiving.resolve_discrepancy`).
The worker cannot edit expected data; supervisors get discrepancy resolution.

---

## Acceptance scenarios (all supported)

| # | Device | Input | Result |
|---|--------|-------|--------|
| A | Smartphone | Camera | Carton + product receiving |
| B | Smartphone | Bluetooth scanner | Carton + product receiving |
| C | Smartphone | Manual entry | Carton + product receiving |
| D | Desktop | USB scanner | Receiving |
| E | Desktop | Scanner + thermal printer | Receiving + carton labeling (printer is a support layer; workflow never blocks on it) |
| F | Desktop | Scanner + scale | Receiving (scale is a support layer; manual/device weight tolerated) |

All scenarios share one Receiving backend, one database and one workflow; only
the interaction layer differs.

---

## Run

```bash
# database (PostgreSQL) + backend + frontend
cd docker && docker compose up --build          # option A
# or local dev (option B) — see README
```

Verified end-to-end against the Warehouse backend with a real
Customer Arrival Card + Shipment Card push:
- full workflow → `RECEIVED` (2/2 cartons, 9/9 units, 0 discrepancies)
- `UNKNOWN_CARTON` guard on a stray scan
- `COMPLETED_WITH_DISCREPANCY` when units are short
- idempotent resume of an active session
