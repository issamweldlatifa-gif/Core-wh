# P0 — Dual Scanner Architecture — Final Delivery Report
### Software Scanner + Hardware Scanner (Receiving Station only · Extensible Scanner Core)

**Execution order:** «AYROVI WAREHOUSE CORE — P0 — DUAL SCANNER ARCHITECTURE — SOFTWARE SCANNER + HARDWARE SCANNER — Receiving Station Only — Extensible Architecture».
**Date:** 2026-09-03
**Delivery commit:** `f22c5dd` (this report: follow-up record commit).
**Flow preserved:** Arrival → Receiving → Container/Tote → Customer Sorting → Customer Bin → Packing → Shipping → Archive/Trace — unchanged.
**Scope discipline (§19 / FINAL RULE):** the dual mode is applied **only** inside Receiving. Sorting / Packing / Shipping / Customer-Bin terminals keep using the software `ContinuousScanner` untouched — no new station scanners, no worker-specific targets were added.

---

## 1. What was built (summary)

| Requirement | Delivered |
|---|---|
| §1 Device-mode detection | `chooseScanMethods(caps)` — Desktop → **Hardware primary (no webcam default)**; Smartphone → Software primary; Tablet → both, software first. Pure & unit-tested. |
| §2 Software Scanner | Existing Receiving scanner engine (dedicated in-app UI, QR/Barcode fast path first, target-guided OCR fallback, ROI/quality/confidence). |
| §3 OCR policy | Already line-targeted (dominant line → crop → deskew → OCR), not full-label. Confidence policy §4 in place: HIGH auto / MEDIUM worker-confirm / LOW re-aim. |
| §5/§6 Hardware Scanner + connection layer | New `hardware-wedge.ts`: **keyboard-wedge (USB/BT HID) capture** + Web Bluetooth serial-over-BLE scaffold + WebUSB hook for future industrial profiles — under provider naming (`SoftwareScannerProvider`, `USBScannerProvider (HID wedge)`, `BluetoothScannerProvider`, future `IndustrialScannerProvider`). |
| §7 Unified pipeline | Hardware reads → `prepareHardwareRead` (sanitise → **same dedupe module as camera**) → `onDetected(value, 'EXTERNAL_SCANNER')` → the **single** Receiving submit pipeline in `ReceivingTask`. No separate receiving logic. |
| §8 Scanner UI | Receiving modal now shows **SOFTWARE | HARDWARE** method tabs in the header of both panels (device-aware default). |
| §9 Capability layer | `detectCapabilities()` (camera/autofocus-class/resolution/torch etc. — existing) + new `detectHardwareCapabilities()` (HID wedge universal / Web Bluetooth / WebUSB) and camera `planAdvancedConstraints`. |
| §10 Profiles | FAST / BALANCED / HIGH_ACCURACY / LOW_LIGHT / SMALL_TEXT exist in `scan-config.ts` (`applyScannerProfile`); Receiving uses BALANCED; UI kept simple (no profile picker). |
| §11 IR readiness | Provider seam only — no fake IR. Future illumination/IR enters through the same provider abstraction. |
| §12 Telemetry | `ScanAttempt` now carries `scanMethod`, `provider`, `attemptNumber`; detection type `SCANNER`; `summary().byMethod` splits software/hardware; CSV export extended. No sensitive data, no raw frames stored. |
| §13 Benchmark | Software benchmark (45 labels/16 categories, deterministic) + **new hardware pipeline benchmark** (`run-hw-benchmark.mjs`) — see §4. |
| §14 Failure handling | Software: quality guidance + retry (existing). Hardware: Reconnect button; non-desktop gets “Switch to Software Scan”; scanner failure never breaks the Receiving workflow. |
| §16 Permissions | Camera (`getUserMedia`) is only ever requested when the Software panel is mounted. Hardware path requests **no permission**. |
| §17 Backward compat | `ContinuousScanner` default export + props unchanged for other stations; Receiving internal wiring only. |

---

## 2. Files changed / added

Changed:
- `frontend/src/modules/receiving-terminal/ContinuousScanner.tsx` — optional `headerExtra` (method tabs); telemetry gains `scanMethod`/`provider`.
- `frontend/src/modules/receiving-terminal/scan-config.ts` — new `hardware` config block + `HardwareConfig` type.
- `frontend/src/modules/receiving-terminal/telemetry.ts` — `scanMethod`, `provider`, `attemptNumber`, `DetectionType 'SCANNER'`, `byMethod` summary, extended CSV, named debug handle.
- `frontend/src/modules/receiving-terminal/scanner.css` — hardware panel + loading styles.
- `frontend/src/terminal/ReceivingTask.tsx` — mounts the new dual host (Receiving only).
- `frontend/benchmark/pipeline.ts` — exports the hardware path for benchmarking.
- `frontend/src/modules/receiving-terminal/scan-logic.test.ts` — CSV/method assertions.

Added:
- `frontend/src/modules/receiving-terminal/scan-method.ts` + `scan-method.test.ts` — device-mode policy (pure).
- `frontend/src/modules/receiving-terminal/hardware-wedge.ts` + `hardware-wedge.test.ts` — wedge parser, HID capture, BLE/USB scaffolds, capability probe.
- `frontend/src/modules/receiving-terminal/hardware-scan.ts` — shared hardware-read decision.
- `frontend/src/modules/receiving-terminal/HardwareScannerPanel.tsx` — the no-camera hardware UI.
- `frontend/src/modules/receiving-terminal/ReceivingScanner.tsx` — the dual-mode host.
- `frontend/benchmark/run-hw-benchmark.mjs` + `frontend/benchmark/tmp/hardware-results.json`.
- `docs/DUAL-SCANNER-UI-PREVIEW.html` (layout preview — see §8).
- This report.

**Other stations:** OrderSortingTask / PackingTask / PutawayTask import `ContinuousScanner` directly — zero changes.

---

## 3. Architecture

```
                      RECEIVING STATION (ReceivingScanner host)
        device-mode policy (chooseScanMethods) → SOFTWARE | HARDWARE tabs
                         │                                │
        ┌────────────────▼──────────────┐   ┌─────────────▼──────────────────┐
        │ SOFTWARE ScannerPanel         │   │ HARDWARE ScannerPanel           │
        │ ContinuousScanner             │   │ no camera · no permission       │
        │  camera → ROI → QR/Barcode    │   │ attachHidScanner (wedge)        │
        │  decode FIRST → OCR fallback  │   │ connectBleScanner (opt-in)      │
        │  (target-line guided)         │   │ connectUsbScanner (future)      │
        └───────────────┬───────────────┘   └──────────────┬──────────────────┘
                        │                                  │
                        │ ScanResult(value)                │ ScanResult(value)
                        └──────────────────┬───────────────┘
                                           ▼
                       prepareHardwareRead? no — software path already
                       sanitised + dedupe (SAME dedupe module)  →  ONE submit
                                           ▼
                        ReceivingTask.onScannerDetected(value, source)
                        (submitCarton / submitProduct — SINGLE pipeline)
                                           ▼
                        Backend receiving service = validation & business truth
```

**Providers (§6 naming):**

| Provider | Kind | Input | Implemented |
|---|---|---|---|
| `SoftwareScannerProvider` | camera (phone/tablet) | frames → QR/Barcode/OCR | yes (existing phone path) |
| `DemoScannerProvider` | synthetic camera | same code path, dev demo | yes (`demoMode`) |
| `USBScannerProvider (HID wedge)` | USB keyboard-wedge | window key burst | yes — no permission |
| `BluetoothScannerProvider` | Web Bluetooth | serial-over-BLE barcode service | scaffold + capability gate |
| `IndustrialScannerProvider` | future (IR / network) | profile hooks | stub (`usb-vendor-profile-required`) |

---

## 4. Benchmarks

### 4.1 Software Scanner (previous unified-P0 order, deterministic 45-label/16-cat corpus, same run)
- Fast path — QR 3/3 = 100 % (≈33 ms decode) · Code128 3/3 = 100 % (≈6.5 ms).
- OCR/text in-corpus (34): auto 64.7 %, auto+one-tap-confirm 94.1 %.
- **False-acceptance (wrong-article auto-entry): 0** (old recipe: 17/39 risky auto-submits, incl. 5/5 out-of-order).
- Retry/worker effort: 4/39 (2 LOW drops + 2 blocked confusables) → ≈10 % need a re-aim/manual decision; low-confidence drop rate ≈5 % of text attempts; out-of-order text blocked 5/5.
- End-to-end per text attempt ≈43 ms; OCR avg 34.9 ms.

### 4.2 Hardware Scanner (this order — `run-hw-benchmark.mjs`, real pure code path)
All 45 ground-truth codes fed through the wedge receiving decision (`prepareHardwareRead`, same function the panel runs):

| Metric | Result |
|---|---|
| Accepted into receiving pipeline | 45/45 |
| Sanitised out (junk/spam) | 0 |
| On the order → submitted | 40 |
| Off-order codes → flagged for business validation (never auto-“correct”) | 5 |
| Duplicate stress — same code held 2 s | **1 event** |
| Per-read validation overhead | avg 5.1 µs · p95 10.5 µs |
| Physical decode accuracy | device-side (manual acceptance step) |

### 4.3 Software vs Hardware headline comparison

| | Software (camera) | Hardware (wedge) |
|---|---|---|
| Wrong-article auto-entry | 0 (corpus-gated OCR; barcode fast path trusted → backend) | 0 (off-order flagged to business) |
| Extra validation needed per read | full quality/OCR stack (≈43 ms) | device already decoded → ≈5 µs |
| Retry rate | ≈10 % (re-aim/human) | 0 (device returns a code) |
| Failures handled | guidance + retry | Reconnect / (mobile·tablet) switch to software |

---

## 5. Test matrix (order §18)

Legend: ✅ unit-tested (this run) · 🧪 dev-sim (browser demo paths provided) · ⚠️ manual/device step (not executable in this environment — no camera/Bluetooth/USB hardware).

| Case | Software | Hardware |
|---|---|---|
| Mobile opens Software scanner | ✅ policy + engine tests · 🧪 demoMode | n/a |
| Mobile/Tablet can pick Hardware | ✅ `chooseScanMethods` tests | ✅ method available |
| Desktop defaults to Hardware (no camera) | ✅ policy test (default=hardware) | ✅ default mount has no `getUserMedia` |
| USB/HID wedge reads | n/a | ✅ parser/capture unit tests · ⚠️ physical device |
| Bluetooth architecture | n/a | 🧪 capability gate + connect scaffold · ⚠️ device |
| Same ScanResult pipeline for both | ✅ shared `onDetected` submit | ✅ identical |
| QR/Barcode decoder first | ✅ benchmark QR/Code128 100 % | ✅ device decodes |
| SKU/Reference OCR targeted | ✅ line-target tests/benchmark | n/a |
| OCR low-confidence never accepted | ✅ confidence tests + benchmark (0 auto-wrong) | n/a |
| Shared validation & business logic | ✅ single ReceivingTask submit | ✅ same |
| Disconnect / reconnect | n/a | ✅ reconnect handler (🧪 UI) · ⚠️ physical |
| Duplicate protection | ✅ dedupe tests (1 event) | ✅ same module + stress (1 event) |
| Failure: blur / low light / glare / wrong target / partial / invalid | ✅ quality-gate + OCR tests/benchmark | sanitise rejects junk |
| Permission denied | ✅ error copy path · ⚠️ browser | never asks |
| Other stations unaffected | ✅ only ReceivingTask changed | ✅ |

**Build/test evidence this run:** `tsc --noEmit` clean (app + node configs) · `vitest run` **71/71** · `vite build` clean. Lint script exists in `package.json` but the repo ships no `eslint` dependency/config (pre-existing) — noted honestly, not silently claimed as passed.

---

## 6. Screenshots / GIF

No browser/device exists in this environment, so runtime captures cannot be produced here without faking them. Delivered instead:
- `docs/DUAL-SCANNER-UI-PREVIEW.html` — a **clearly-labelled static layout preview** of both panels (Software camera stage with ROI/scan-line/method tabs; Hardware panel with Connected status, capability chips, LAST SCAN list).
- For real footage on a device: open Receiving → SCAN. The Software panel supports `demoMode`/`demoCodes`, and the Hardware panel includes **“DEV: SIMULATE WEDGE”**, so both modes can be exercised and screen-recorded in a normal browser without any physical hardware.

---

## 7. Telemetry example fields (order §12)

`ts · attemptNumber · scanMethod(software|hardware) · provider(software-camera|demo-camera|hid|bluetooth|…) · scannerType(native|zxing|tesseract|external) · detectionType(QR|BARCODE|OCR|SCANNER) · processingMs · ocrConfidence · imageQuality · validationResult · finalResult · failureReason · deviceType`
Debug dump: `window.__ayroviScanTelemetry` (software) and `window.__ayroviHardwareTelemetry` (hardware) → `.summary()` / `.csv()`. No raw frames or sensitive data stored.

---

## 8. Definition of Done — status

1 Mobile opens Software Scanner — ✅ policy + demoMode path (device run for final). 2 Mobile/Tablet can pick Hardware — ✅. 3 Desktop runs Hardware without camera — ✅ (default; no getUserMedia call). 4 USB/HID scanner works — 🧪 code path complete + tested; physical wedge run pending. 5 Bluetooth architecture present/usable per device — ✅ scaffold + gate; physical BLE run pending. 6 Software & Hardware enter the same ScanResult pipeline — ✅ (one submit path). 7 QR/Barcode use a dedicated decoder — ✅. 8 SKU/Reference use guided OCR — ✅. 9 OCR never accepts low confidence — ✅ (0 auto-wrong). 10 Validation & business logic shared — ✅. 11 Disconnect/reconnect works — ✅ handler; physical confirmation pending. 12 Telemetry exists — ✅. 13 Benchmarks before/after & real results exist — ✅ (software corpus + hardware pipeline; numbers above). 14 No unrelated station changes — ✅ (only ReceivingTask). 15 No Receiving regressions — ✅ 71/71 tests + build. 16 No persistent raw camera images — ✅ (none stored). 17 Build + tests + typecheck pass — ✅ (lint n/a — no eslint dep in repo).

## 9. Limitations (honest)

- Physical USB/BT scanner, real webcam and native BarcodeDetector behaviours are **not testable in this sandbox**; the wedge parser, capability gates, pipeline parity and UI flows are covered by unit tests + demo seams, but one on-device acceptance pass is required before declaring production-ready.
- Hardware wedge capture requires window focus and non-input targets while scanning (scanners ending with Enter are auto-consumed so they never trigger buttons).
