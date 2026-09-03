# AYROVI RECEIVING SCANNER — FINAL EXECUTION ORDER (v1.0 — single reference)

**P0 — FINAL RECEIVING SCANNER · REAL-TIME SOFTWARE + HARDWARE SCANNER · Industrial-Speed Architecture**
**Revision:** v1.1 (2026-09-03) — §5–§7 Prefetch/ScanContext, §11 local expected matching, §18–§20 warm engine + session cleanup, §27 latency distribution now implemented; v1.0 text preserved below.
**Status:** ⭐ THE reference for the Receiving Scanner. Supersedes all earlier scanner orders/reports:
`SCANNER-OCR-P0-DELIVERY-REPORT.md` · `SCANNER-OCR-UNIFIED-P0-FINAL-REPORT.md` · `DUAL-SCANNER-RECEIVING-FINAL-REPORT.md`.
**Change control:** No further scanner orders will be layered on top of this file. Future change = a new revision of **this** document (v1.1, …). The developer executes THIS order and returns with the measured numbers below; we only then decide whether further optimisation is needed.
**Date:** 2026-09-03 · **Authoritative flow (unchanged):** Arrival → Receiving → Container/Tote → Customer Sorting → Customer Bin → Packing → Shipping → Archive/Trace.

---

## 0. MISSION

A Receiving Scanner that feels like a professional scan device:

**«Point → Detect → Read → Compare → Result → Next»** — no long waits, no camera re-open between scans.

Priority order: **1 Speed · 2 Correctness · 3 Reliability · 4 Worker UX · 5 Extensibility.**

Scope: **Receiving only.** Do NOT create scanner targets / worker screens for Customer Sorting, Customer Bin, Packing, Shipping, Archive. The Scanner Core must stay reusable for those stations later (§34).

---

## 1–2. TWO SCANNER MODES & DEVICE UX

| Device | Software Scan | Hardware Scan | Default |
|---|---|---|---|
| Mobile | ✅ (natural) | optional | **Software** |
| Tablet | ✅ | ✅ | Software first |
| Desktop / PC | explicit only | ✅ primary | **Hardware** (never the PC camera as the receiving method) |

- **A — Software:** camera → AYROVI software scanner → QR/Barcode/OCR → validation → receiving logic.
- **B — Hardware:** USB/Bluetooth/Industrial scanner → Scanner Input Provider → **same ScanResult pipeline** → validation → receiving logic.

Both modes flow into the **identical** receiving pipeline. No second receiving logic exists for hardware (§21–§24, §30).

---

## 3–4. CAMERA LIFECYCLE — OPEN ONCE, STAY LIVE · RED LINE IS NOT BLOCKING

- Camera opens **once** when the Software session starts and stays **LIVE for the whole session**. Prohibited: open → scan → close → open…
- The red line is **visual guidance only**. The worker must be able to **point approximately**: automatic target detection → automatic/dynamic ROI → read. Do not force exact placement inside the line, fixed phone position, or manual waiting for the target inside the ROI.
- Error and success paths (§14–§15) must keep the camera LIVE and the next target ready — **no camera restart, no manual retry button, no reload** in the normal loop.

---

## 5–7. RECEIVING PREFETCH · IN-MEMORY SCAN CONTEXT · NORMALIZED EXPECTED VALUES (CRITICAL — NEW)

**Prefetch** the moment the Receiving card opens (do not wait for the first scan). Build a session-specific, in-memory `ScanContext`:

```
Receiving Card Open → Prefetch → Normalize → Build ScanContext → Scanner ready before the worker presses Scan
```

`ScanContext`:
- `expectedSKU`, `expectedReference`, `expectedQR`, `expectedBarcode(s)`
- `normalizedValues` (comparison-ready — SKU/Reference/QR/Barcode normalized **once** up-front, §7)
- `targetType`, `expectedFormat`, `validationRules`
- any other receiving data the current business logic needs.

Matching must be **local, first** — the comparison kernel never queries the full database per frame or per OCR attempt. The backend is used to **record/confirm the operation** under the existing receiving architecture, not to answer each recognition.

Rule of thumb (§7): normalization of expected values happens once during prefetch; the frame loop must not redo heavy normalisation.

---

## 8–12. CONTINUOUS REAL-TIME FRAME PIPELINE · FAST PATH · TARGETED OCR · EXPECTED-VALUE MATCHING · NO GUESSING

Multi-stage pipeline (lightweight first):

```
LIVE CAMERA
  ↓ Lightweight detection (adaptive frame sampling · ROI tracking · temporal tracking)
  ↓ Candidate ROI
  ↓ Fast recognition:
      QR/Barcode → dedicated decoder FIRST — valid decode wins, OCR is skipped,
                    processing stops immediately on success (§9)
      SKU/Reference (text target) → targeted OCR on the detected text region only:
                    text candidate → ROI → perspective correction → deskew →
                    minimal preprocessing → OCR (§10) — never full-frame OCR without cause
  ↓ Local comparison against ScanContext expected values (§11): OCR → normalize →
    compare with expected SKU/Reference → Match / Wrong. Acceptable values are
    preloaded; no “search whole DB for possible SKU”.
  ↓ Decision (§12): Recognition + Confidence + Format Validation + Expected Match
      HIGH + valid match  → SUCCESS → NEXT
      MEDIUM              → worker confirmation OR fast re-try per existing business rules
      LOW                 → NO ACCEPT — camera stays LIVE, ready for next attempt
```

Use, wherever useful: background workers, hardware acceleration, efficient image conversion, cached config. Heavy processing must not run on the UI thread.

---

## 13–17. LATENCY TARGET · INSTANT ERROR · AUTOMATIC SUCCESS · MICRO-FEEDBACK · EARLY-EXIT CONSENSUS

- **End-to-end scan decision ≤ 1 s** max under normal conditions — and the real goal is close to a professional scanner (“tick tick tick tick”). Never claim a speed without a real benchmark (§28).
- **Wrong → ✕ short feedback → camera LIVE & ready immediately** (no close/open/retry/reload).
- **Correct → ✓ → auto-advance to next target** when business logic allows (no confirm modal, no Next button); camera stays LIVE.
- Feedback is micro: ✓ / ✕ / (◌ only if genuinely processing). Animations must never mask real slowness.
- Multi-frame consensus is allowed but must **exit early** on a reliable match — no fixed frame quota after a high-confidence match (Frame 1 candidate → Frame 2 high-confidence match → ACCEPT).

---

## 18–20. WARM SCANNER ENGINE · SESSION CLEANUP (CLEAN, DON’T SHUT DOWN) · NEW SESSION

- **Warm:** after the software scanner starts, keep reusable components warm — OCR runtime, decoder, processing workers, reusable buffers, camera pipeline. Never reload them per scan.
- **Session cleanup:** when a Receiving completes, **clean the session, do not shut the engine**:
  clear ScanContext, expected SKU/Reference/QR/Barcodes, OCR results, previous scan results, temporary image buffers, candidate data, current scan state — while **keeping OCR runtime, decoder and reusable components warm** when the next session uses the same scanner.
- **New session:** prefetch → normalize → ScanContext → **scanner already warm** → camera LIVE → READY. The worker never pays for initialisation after pressing Scan.

---

## 21–24. HARDWARE SCANNER ARCHITECTURE & PC WORKFLOW

- Receiving is not bound to any concrete device. `ScannerInputProvider` abstraction with implementations: `SoftwareScannerProvider`, `HardwareScannerProvider`, `USBScannerProvider`, `BluetoothScannerProvider`, `IndustrialScannerProvider` (future, incl. IR/network). Every provider returns the same **`ScanResult`** shape → Normalization → Validation → Receiving Logic.
- Hardware panel: **● Connected / ○ Disconnected / Connect Scanner**; supports USB, Bluetooth, HID/keyboard-style scanners; if a scanner types as a HID keyboard, Receiving must accept the input directly (window wedge capture).
- **Disconnect:** “Scanner disconnected” → **Reconnect**; on Mobile/Tablet also **Switch to Software Scan** where allowed. Never break the Receiving session.
- **PC workflow:** Receiving → Hardware Scanner → Scan → same ScanResult → validation → next. No camera in front of the PC as the primary solution.

---

## 25–29. CAPABILITIES · ACCELERATION · PROFILING · REAL-DEVICE BENCHMARK · BOTTLENECK ANALYSIS

- Detect (never assume): camera, autofocus, torch, resolution, FPS, camera-API capability, USB, Bluetooth, external-scanner capability, hardware-acceleration capability → choose the processing strategy per device.
- Use real acceleration only when it helps (CPU/GPU/optimised OCR+decoder/browser-native). No tech for the sake of the name. `Profile → Identify bottleneck → Optimize → Benchmark`.
- **Instrument with timestamps:** `cameraFrame · candidateDetected · capture · recognitionStart · recognitionEnd · validationStart · validationEnd · decision · nextReady`. Report **Recognition latency** (valid frame → decision) and **End-to-end** (valid frame → next target ready) as **p50 / p90 / p95 / p99 / max**.
- **Benchmark real devices — not just a dev PC:** (1) average Android phone, (2) a weaker device if in the target set, (3) a modern device as comparison. Per device: camera FPS, resolution, CPU/RAM, QR / Barcode / SKU-OCR / Reference-OCR latency, p50/p95/p99, success & retry rate.
- If slow, name the **real** bottleneck with evidence (camera init? autofocus? frame conversion? ROI detection? preprocessing? OCR? decoder? React rendering? state updates? network? DB? serialization? GC? camera restart?) — never a blanket “OCR is slow”.

---

## 30–33. NETWORK RULE · DUPLICATE PROTECTION · TELEMETRY · SECURITY

- The recognition loop must not depend on network latency: no per-frame backend/database round trip. Expected context is prefetched; the core scan decision is local; backend only records/confirms.
- Duplicate protection (camera stays LIVE): keep `targetId · acceptedValue · acceptedAt · dedup state` so the same physical scan is never recorded twice.
- Telemetry per scan: `scan_method · device_type · scanner_provider · target_type · decode_type · attempt_number · processing_time_ms · confidence · validation_result · match_result · success/failure · failure_reason`. Never store raw camera frames persistently without explicit cause + security design sign-off.
- Permissions: camera permission only for Software Scan; Hardware Scan needs no camera permission; BT/USB permissions per platform/device.

---

## 34–36. DO NOT OVERBUILD · REGRESSION SAFETY · TEST MATRIX

- No Sorting/Packing/Shipping/Customer-Bin targets or worker-specific screens now; keep the Core reusable.
- Do not break: existing Receiving workflow, QR, barcode, existing validation, APIs, business logic, DB contracts. Backward-compatible.
- Test matrix:
  - Software: QR · Barcode · SKU · Reference · correct value · wrong value · low confidence · blur · motion · low light · partial target · target **outside** the red line.
  - Hardware: USB · HID · Bluetooth (when supported) · disconnect · reconnect · multiple rapid scans · duplicates.
  - Workflow: Open Receiving → prefetch → scanner ready → scan → success → next → (repeat) → wrong → **immediate retry** → success → next — camera LIVE throughout the software session.

---

## 37–39. DEFINITION OF DONE · REQUIRED DELIVERY · FINAL ACCEPTANCE TEST

**DoD** (evidence, never “scanner added”):
- Architecture: Software Provider · Hardware Provider · unified ScanResult · shared validation pipeline · reusable Core.
- UX: camera opens once · stays LIVE · red line non-blocking · automatic target detection · success auto-next · error → camera ready instantly · no manual retry in the normal loop · no camera restart.
- Performance: data preloaded · ScanContext ready before first scan · expected values normalized up-front · local recognition · **warm engine** · session cleanup without shutdown · **p50/p95/p99 measured** · **real Android device benchmark** · no network round trip inside the frame recognition loop.
- Accuracy: correct SKU/Reference accepted · wrong SKU/Reference rejected · QR/Barcode via decoder · OCR via confidence+validation · duplicates protected.

**Required delivery (§38):** root cause of latency · architecture · software + hardware implementation · device detection · **prefetch implementation · ScanContext implementation · session-cleanup implementation · warm-scanner implementation · camera lifecycle** · QR/Barcode/SKU-OCR/Reference-OCR benchmarks · p50/p90/p95/p99/max · avg FPS · CPU · RAM · network requests per scan · frames per successful scan · success & retry rates · before/after benchmark · **real device model(s)** · screen recording of continuous scan · screenshots (software + hardware modes) · build/test/lint-typecheck results · commit hash · files changed.

**Final acceptance test (§39):** on a real Android phone: open card → prefetch → camera LIVE → point approximately → correct → ✓ → NEXT (camera still LIVE) → correct → ✓ → NEXT → then a wrong value → ✕ → camera still LIVE → point correct → ✓ → NEXT — all without opening/closing the camera, without Retry, without unnecessary waits.

---

# APPENDIX A — Implementation status vs this order (repo snapshot 2026-09-03)

Legend: ✅ shipped & measured (commit) · 🔶 specified — to be built in this execution run · ⚠️ requires a physical device.

| § | Item | Status | Where / evidence |
|---|---|---|---|
| 1–2 / 21–24 | Dual modes, device policy, provider layer, HID wedge, hardware panel, unified pipeline | ✅ `f22c5dd` | `ReceivingScanner.tsx`, `scan-method.ts`, `hardware-wedge.ts`, `hardware-scan.ts`, `HardwareScannerPanel.tsx`, `providers.ts` |
| 3 | Camera open-once / stays live (software) | ✅ | `ContinuousScanner.tsx` — single `start()`, loop continues across SUCCESS/ERROR |
| 4 | Red line non-blocking, dynamic ROI / target line | ✅ | `textlines.ts`, `targeting` config, `ContinuousScanner` PRODUCT/CARTON |
| 5–7 | **Prefetch → ScanContext → normalized expected values** | ✅ v1.1 | `scan-context.ts` (typed expected buckets, one-time normalisation, local O(1) lookup) built in `ReceivingTask` the moment session data loads |
| 8–10 | Staged frame pipeline, barcode-first, targeted OCR | ✅ | `ContinuousScanner`, `preprocess.ts`, `fields.ts` |
| 11 | Expected-value local matching | ✅ v1.1 | `scan-context.localExpectedMatch` + scanner validates against the context's expected set (overrides raw corpus); never queries backend per frame |
| 12/14–17 | No-guess, instant error, auto success, early-exit consensus | ✅ | confidence gate, state machine, `multiframe.ts` |
| 13 | Latency ≤1 s + measured p50/99 | ⚠️ device | telemetry now emits p50/p90/p95/p99/max per session (`summary().latency`); device numbers pending |
| 18 | Warm scanner engine | ✅ v1.1 | `engine.ts` ref-counted manager + `ocr-client.warmOcr`; scanner acquires (warms) on mount, `terminateOcr` removed from session teardown |
| 19 | Session cleanup without shutdown | ✅ v1.1 | `engine.release()` keeps engine warm under idle grace (5 min default); session state/buffers dropped by React on session change |
| 20 | New session reuse | ✅ v1.1 | re-acquire before grace reuses the warm worker (tested: single warm load across sessions) |
| 25 | Capability layer | ✅ | `detectCapabilities` + `detectHardwareCapabilities` + `planAdvancedConstraints` |
| 26–29 | Acceleration policy + profiling + device benchmark | ⚠️ device · ✅ profiling | `TelemetrySummary.latency` (p50–max) + `stages` timestamps; real-device benchmark still the deliverable |
| 30 | Local decision, no per-frame network | ✅ v1.1 | recognition compares against the in-memory expected context (`scan-context.ts`); backend only records/confirms after the local decision |
| 31 | Duplicate protection | ✅ | `dedupe.ts` (camera + hardware, 1 event stress-tested) |
| 32–33 | Telemetry fields + permissions | ✅ | `telemetry.ts`: scan_method/provider/attempt/targetType + latency p50–max; camera permission only in software |
| 36–39 | Test matrix / acceptance on device | ⚠️ | unit 87/87 + synthetic corpus; real-device acceptance pending |

**Baseline numbers already measured (synthetic corpus — NOT device numbers; the developer must replace with real-device results):** QR 100% (≈33 ms), Code128 100% (≈6.5 ms), in-corpus text auto+confirm 94.1 %, wrong-article auto-entries 0, OCR end-to-end ≈43 ms, hardware wedge per-read overhead ≈5 µs, duplicate stress = 1 event. (`SCANNER-OCR-UNIFIED-P0-FINAL-REPORT.md`, `DUAL-SCANNER-RECEIVING-FINAL-REPORT.md`, `frontend/benchmark/tmp/*.json`.)

# APPENDIX B — v1.1 implementation delta (2026-09-03)

Executed the 🔶 build items of v1.0 in this repo. Real-device numbers remain the
developer deliverable — nothing here claims device speed.

**What was implemented**
1. **Prefetch ScanContext (§5–§7):** new `frontend/src/modules/receiving-terminal/scan-context.ts`.
   `ReceivingTask` builds the context (carton/product expected buckets) the moment
   session data loads — before the worker presses Scan. Expected values are
   normalised **once** with the same `normaliseToken` the OCR path uses.
2. **Local expected matching (§11/§30):** `buildScanContext().byValue` + `localExpectedMatch`
   give an O(1) local compare; the scanner validates against the context's expected
   set (overrides raw `corpus` when provided). No per-frame/per-OCR backend or DB work.
3. **Warm scanner engine (§18–§20):** new `engine.ts` ref-counted manager +
   `ocr-client.warmOcr()` (pre-loads the tesseract worker). `ContinuousScanner`
   `acquire({warm})` on open and `release()` on close — the engine is NOT torn down
   per session; it idles warm (default 5 min grace) and a re-open reuses it
   (tested: exactly one worker load across back-to-back sessions).
4. **Session cleanup without shutdown (§19):** session state/results/buffers drop
   with the session (React), the engine release keeps the runtime warm; the old
   per-teardown `terminateOcr()` call was removed from the scanner.
5. **Latency distribution (§27):** `TelemetrySummary.latency = { p50, p90, p95, p99, max }`
   over attempts (plus existing `stages` per-attempt timestamps). Per-attempt CSV
   now also carries `targetType` (CARTON | SKU | REFERENCE).

**Verification this delta:** `vitest run` → **87/87** (added 9 `scan-context` tests +
7 `engine` tests; telemetry test asserts percentile ordering); `tsc --noEmit` clean
(app + node configs); `vite build` clean.

**Files changed by the delta:** `scan-context.ts`(+test) · `engine.ts`(+test) ·
`ocr-client.ts` (warmOcr) · `telemetry.ts` (targetType + latency p50–max) ·
`ContinuousScanner.tsx` (scanContext + engine acquire/release + targetType, no
per-teardown OCR kill) · `ReceivingScanner.tsx` (pass-through) · `ReceivingTask.tsx`
(prefetch build) · `scan-logic.test.ts` (latency assertion).
**Delivery commit:** `fddd9a3` (this reference: follow-up record commit).

**Still on the developer (unchanged):** real Android-device runs, filling the
ANNEX table, p50/p95/p99 + CPU/RAM/FPS on those devices, screen recording,
screenshots, and the §39 acceptance pass.

**Return of results:** developer delivers §38 items + fills the Annex device table below; numbers are added to a new revision of this file (v1.1) only after review.

## ANNEX — Real-device benchmark table (to be filled on device)

> 🛠️ Developer tooling for this table: `docs/RECEIVING-SCANNER-DEVELOPER-RUNBOOK.md` —
> step-by-step device execution + `copy(window.__ayroviScanTelemetry.snapshotCsv())`
> produces each ANNEX row automatically (p50/90/95/99/max + per-decode success &
> latency), so the numbers below are filled from real runs, not guesses.

| Device | Camera FPS | Resolution | QR ms | Barcode ms | SKU OCR ms | Ref OCR ms | p50 | p95 | p99 | max | Success % | Retry % | CPU % | RAM MB | Net req/scan | Frames/successful scan |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| (model 1 — average Android) | | | | | | | | | | | | | | | | |
| (model 2 — weaker target) | | | | | | | | | | | | | | | | |
| (model 3 — modern) | | | | | | | | | | | | | | | | |
