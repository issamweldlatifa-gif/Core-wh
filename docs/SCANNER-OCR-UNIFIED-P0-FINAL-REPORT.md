# Unified P0 — Receiving Smart Industrial-Grade Scanner + OCR + Direct Target Recognition — Final Delivery Report

**Execution order:** «P0 — RECEIVING SMART INDUSTRIAL-GRADE SCANNER Unified Execution Order — Scanner + OCR + Direct Target Recognition».
**Flow preserved (unchanged):** Arrival → Receiving → Container/Tote → Customer Sorting → Customer Bin → Packing → Shipping → Archive/Trace.
**Scope of this order:** the Receiving scanner’s recognition engine only. No backend auth-code change, no workflow change.
**Working model implemented:** `Point → Detect → Read → Validate → Match → Continue`.
**Recognition policy kept:** barcode/QR **first** — a valid decoded code wins and OCR is skipped; OCR is only a fallback behind a confidence gate; candidates/possible-matches from the corpus may **never** auto-submit (worker confirm only); NO MATCH → retry/manual — never an auto-entered wrong article.
**Date:** 2026-09-03 · **Delivery commit:** `851f780` (this report: follow-up record commit)

---

## 1. What this order added on top of the delivered P0 scanner

The prior P0 delivery report (`SCANNER-OCR-P0-DELIVERY-REPORT.md`) describes the reworked continuous scanner. The unified order adds the **industrial single-target reading mode** and the **hardware input seam**, implemented as small pure modules plus a rewritten host component:

| Layer | File (frontend `src/modules/receiving-terminal/`) | Role |
|---|---|---|
| Config | `scan-config.ts` | Central `ScanConfig`; new `targeting` block (`enabled`, `productOnly`, `minScore`, `stableFrames`, `margin`, `analysisMaxWidth`, `alignCheckCadence`); scanner profiles `FAST / BALANCED / HIGH_ACCURACY / LOW_LIGHT / SMALL_TEXT` via `applyScannerProfile` (§27). |
| Line targeting | `textlines.ts` | DOM-free text-line detector `findTextLines`, strongest line `findDominantLine`, crop grower `lineCropBox`, deskew routing `profileForLineSkew` (§5/§6/§8/§9). |
| Duplicate guard | `dedupe.ts` | `isDuplicate` / `noteSubmission` — one continuous hold of one code emits exactly one event (§26). |
| Telemetry | `telemetry.ts` | `ScanAttempt.stages` with per-stage ms + manual/retry/false-positive rates (§28). |
| Hardware seam | `providers.ts` | `ScannerInput` contract; `openPhoneScannerInput` (real camera, capability inference), `openDemoScannerInput` (demo seam for CI/dev), `summarizeTrackCapabilities`, `planAdvancedConstraints` (never pushes an unsupported capability), `buildVideoConstraints` (device-class resolution) (§22–§25). |
| Host component | `ContinuousScanner.tsx` | Full rewrite wiring: mode `CARTON` (band) vs `PRODUCT` (dynamic target line), barcode-first loop with native-detector guard, line-aware OCR, quality-gate ordering, FSM `SCANNING → TARGET_FOUND → READING → VALIDATING → MATCHED / CONFIRM_NEEDED → SUBMITTING → SUCCESS/ERROR`, worker coaching only in the UI (never autopilot changes). |
| Styling | `scanner.css` | Red scan line + ROI, phase indicator colours, target alignment feedback. |
| Tests | `scan-targeting.test.ts` (+1 regression in `image-quality.test.ts`) | 13 tests for the new pure logic (§4). |

Direct-target flow for SKU / Reference labels (`PRODUCT` mode):

```
ROI (luma)
 ├─ barcode/QR decode first (ZXing / native) — valid code → matched → done (§4)
 └─ OCR fallback when decode keeps failing:
      quality gate (§12) → [PRODUCT] dominant text line found?
        ├─ no legible line → coach “align target label”, no OCR burned
        └─ line found → dynamic crop (lineCropBox) → skew estimate
             → deskew profile when tilted → single-line PSM 7 OCR
      → fields → weighted consensus → corpus validation
      → HIGH auto / MEDIUM confirm / LOW rescan
```

---

## 2. Fixes that fell out of building this order

**Real defect found & fixed — `applyProfile` input convention.** `preprocess.applyProfile(src)` consumes **RGBA Pixels** (it runs `toGray` internally), but the rewritten component and the benchmark were feeding it a raw **luma** buffer; the buffer was then re-read with RGBA stride, scrambling the image and destroying OCR (observed: Tesseract returned 4× duplicated text at confidence 0 on clean labels). Fixed at both call sites by widening through `grayToPixels` and locked with a regression test (`image-quality.test.ts` → “regression: applyProfile consumes RGBA Pixels”). Tesseract confidence on the same crop went 0 → 90 and the read went `"SKU-250125789SKU-250125789…"` → `"SKU-250125789"`.

Other integration fixes during the pass: `providers.ts` `MediaStreamConstraints` typing, capability-derived advanced constraints actually applied to the track, torch/flip wired through the `ScannerInput` seam, and scan-line / phase styling.

---

## 3. Benchmarks — before vs after (same run, same images, same engines)

Methodology (honest, deterministic): `frontend/benchmark/gen_labels.py` renders **45 synthetic labels, 16 categories**, deterministically (fixed seed); ids 1–27 are the previously frozen set (verified byte-identical outputs), ids 28–45 are the new unified-order categories. `run-benchmark.mjs` then runs, per label, in one process, with the same Tesseract.js engine **and** the same ZXing decode path used by the browser:

- **BEFORE (current/legacy recipe):** legacy global-threshold preprocessing → whole-ROI PSM6 OCR → first raw token **auto-submitted**, no gate, no validation — i.e. exactly what the old scanner did.
- **AFTER (this order):** quality gate → profile → (PRODUCT: dominant line → crop → deskew) → OCR → fields → corpus validation → composite confidence → HIGH auto / MEDIUM worker-confirm / LOW drop.

All pure pipeline code is bundled by esbuild from `pipeline.ts`, i.e. the *shipped* TS. Run: `cd frontend && npm run benchmark`. Output: `frontend/benchmark/tmp/results.json` (frozen).

### 3.1 Overall numbers (text slow path: 39 labels; fast path: 6 QR/barcode)

In-corpus text = 34 (ground truth **is** on the order). Out-of-corpus text = 5 (`no_match` 3, `confusable` 2 — codes printed but **not** on the order).

| Metric | BEFORE (legacy) | AFTER (unified P0) |
|---|---|---|
| Auto-correct on in-corpus codes | 22/34 — 64.7% | auto 22/34 — 64.7% · auto+one-tap-confirm **32/34 — 94.1%** |
| Would auto-submit a WRONG/UNKNOWN code | **17/39** (incl. 5/5 out-of-corpus exact reads → guaranteed wrong article) | **0** (unsafe auto-wrong = 0) |
| Out-of-corpus labels (must not auto-enter) | 5/5 auto-entered (wrong article) | **0 auto-entered**, 5/5 blocked → worker verify/manual |
| No-read | 0 | 0 |
| Drop → rescan/manual (worker re-aims) | n/a (silently auto-submitted) | 4/39 (2 LOW drops + 2 blocked confusables) |

Per-category table (all 16):

| category | n | old auto ✔ | old auto ✗ submit | new auto ✔ | new confirm | new rescan |
|---|---|---|---|---|---|---|
| clear | 3 | 67% | 33% | 67% | 33% | 0% |
| small_text | 3 | 33% | 67% | 67% | 33% | 0% |
| low_light | 3 | 67% | 33% | 67% | 33% | 0% |
| glare | 3 | 67% | 33% | 67% | 0% | 33% |
| tilted | 3 | 33% | 67% | 33% | 33% | 33% |
| damaged | 3 | 67% | 33% | 33% | 67% | 0% |
| font_sans-bold | 1 | 100% | 0% | 100% | 0% | 0% |
| font_mono | 1 | 0% | 100% | 0% | 100% | 0% |
| font_serif | 1 | 100% | 0% | 100% | 0% | 0% |
| printer_lowdpi | 3 | 100% | 0% | 100% | 0% | 0% |
| label_size | 3 | 100% | 0% | 100% | 0% | 0% |
| sku_direct (new direct target) | 2 | 100% | 0% | 100% | 0% | 0% |
| ref_direct (new direct target) | 2 | 50% | 50% | 50% | 50% | 0% |
| motion (new) | 3 | 33% | 67% | 33% | 67% | 0% |
| no_match (new safety) | 3 | 0% | 100% | 0% | 100% | 0% |
| confusable (new safety) | 2 | 0% | 100% | 0% | 0% | 100% |

### 3.2 Fast path — QR / Code128 (barcode-first, §4)

Same ZXing `MultiFormatReader` code path as the browser: QR 3/3 = 100% (avg 33.3 ms), Code128 3/3 = 100% (avg 6.5 ms). Valid decode stops OCR — zero OCR spend on fast path.

### 3.3 Duplicate prevention (§26)

One continuous hold of the same code across 20 re-frames inside the 2500 ms window → **1 event** (asserted in the runner and unit tests).

### 3.4 Latency (per text attempt, same Tesseract.js worker)

| stage | avg |
|---|---|
| quality gate | 4.3 ms |
| profile preprocess | 2.9 ms |
| target-line detect (PRODUCT only) | 3.5 ms |
| **new OCR** | 34.9 ms |
| **new end-to-end** | **42.7 ms** |
| old OCR (whole ROI, legacy) | 40.9 ms |

Single-attempt end-to-end stays ≈40 ms; the gains are not speed on easy labels but **safety and worker effort**: identical auto rate on in-corpus, +30 pp when the one-tap confirm path is included, and wrong-article auto-entry eliminated entirely (17 risky auto-submits before → 0). Retry/manual effort is bounded: 4/39 need a re-aim or a human verify.

---

## 4. Tests & verification status

- `cd frontend && npx vitest run src/modules/receiving-terminal` → **3 files, 52 tests, all green** (was 51; +1 polarity/caller regression).
  - `scan-targeting.test.ts` (13): scanner profiles/config merge, duplicate suppression stream, text-line detection & ranking, crop box, deskew routing, track-capability inference, advanced-constraint planning, video-constraint building.
  - `scan-logic.test.ts` (26): confidence levels incl. “candidate never auto-HIGH”, no-corpus behaviour, corpus validation.
  - `image-quality.test.ts` (13): gate + preprocessing profiles + new applyProfile RGBA regression.
- `npx tsc --noEmit` → clean.
- `npx vite build` → clean (scanner chunk compiles).

**Not verified on a physical device** (no hardware camera in this environment): phone/industrial-camera capture, torch and face-flip behaviour, native `BarcodeDetector` paths are covered by unit tests of the pure logic and by the seam contract, and the **demo input** (`openDemoScannerInput`) exists for a same-code-path smoke check in a browser. These remain on-device acceptance steps for the user.

---

## 5. Files changed / added by this order

Changed: `frontend/src/modules/receiving-terminal/ContinuousScanner.tsx` (rewritten host), `scan-config.ts`, `telemetry.ts`, `scanner.css`, `frontend/benchmark/gen_labels.py`, `run-benchmark.mjs`, `pipeline.ts`, benchmark fixture data (`benchmark/tmp/labels/28…45`, `manifest.json`, `results.json`).
Added: `dedupe.ts`, `textlines.ts`, `providers.ts`, `scan-targeting.test.ts` (+ `image-quality.test.ts` regression).
This report: `docs/SCANNER-OCR-UNIFIED-P0-FINAL-REPORT.md`.

## 6. Limitations (no fake numbers — stated plainly)

- Synthetic labels are clean, aligned, high-DPI renders of the printed-code model; real-world covers, print bleed, extreme angles, and glare beyond these categories are not measured here.
- Numbers are from one deterministic synthetic corpus run; treat them as **relative before/after deltas on identical inputs**, not absolute field accuracy.
- The demo/camera path needs one manual device run before the receiving deployment is declared production-ready.
