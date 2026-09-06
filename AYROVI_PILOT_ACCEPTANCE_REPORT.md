# AYROVI warehouse pilot acceptance

Date: 2026-09-06 · **PILOT STATUS: BLOCKED — NOT EXECUTED**.

The prerequisites (complete automatic chain, end-to-end acceptance and production hardening) are not all passed. CI's synthetic roles/stations90-unit fixture is not real production configuration or a warehouse pilot.

## Configuration and execution

- Real workers/roles/stations/zones/devices/routing: **BLOCKED** — see `AYROVI_PILOT_CONFIGURATION_REQUIRED.md`.
- Assignment model: **BLOCKED** — upstream operational assignments integrated; full automatic next-worker policy still absent.
- CT40: **BLOCKED** — no physical imager/trigger/firmware/50+ scan session.
- Phone: **BLOCKED** — emulator evidence exists; actual approved handset/warehouse workflow not executed.
- Full workflow: **BLOCKED** — existing stock APIs are exercised separately from missing automatic handoff/Placement/native downstream/shipping verification.
- Supervisor intervention: **BLOCKED** for full pilot; automated scope checks do not certify live shift takeover/reopen.
- Admin final verification: **BLOCKED** for live warehouse; isolated API trace/search assertions only.

## Acceptance checklist

| Check | Pilot result |
|---|---|
| Worker login / real role permissions | BLOCKED |
| Station/device/zone assignment | BLOCKED |
| Receiving / carton / product scans | BLOCKED |
| Product Placement / auto-container creation | BLOCKED |
| Container capacity / early close | BLOCKED |
| Sorting / customer matching / lock | BLOCKED |
| Packing / shipping-out destination | BLOCKED |
| Shipping verification / completion / bordereau | BLOCKED |
| Issue escalation / supervisor correction | BLOCKED |
| Admin visibility / traceability | BLOCKED |
| CT40 / hardware trigger / audio | BLOCKED |
| Phone / camera / manual | BLOCKED |
| Network interruption / duplicate / wrong scans | BLOCKED |
| Worker shift / reassignment / unavailable station | BLOCKED |

Automated results are recorded in the validation report and are deliberately not relabeled PASS in this physical pilot checklist. No production records were fabricated, no database state was manually advanced in a pilot, and no pilot sign-off exists.

## Remaining blockers

Close every critical/high readiness finding, supply approved real configuration, validate signatures/update path, execute the physical matrix with warehouse/QA owners, reconcile stock/audit/task history, and record explicit approval. Do not enable Production or claim a successful pilot from screens, a debug APK or unit tests.
