# P0 — Scanner + OCR (Receiving) — Engineering plan & audit

Scope reference: AYROVI Warehouse Core — «أمر تقني P0» (Scanner + OCR for the
Receiving Terminal). This file is the working plan; the final delivery report
lives in `docs/SCANNER-OCR-P0-DELIVERY-REPORT.md` (repo root `docs/`).

## Non-negotiables (order §1/§11/§12/§19)

1. Workflow untouched: Arrival → Receiving → Container/Tote → Customer
   Sorting → Customer Bin → Packing → Shipping → Archive/Trace.
2. Identification order stays QR/Barcode → OCR → Manual confirmation. A
   **valid** barcode/QR always wins and **stops** OCR.
3. OCR is never trusted as ground truth: every OCR result is validated against
   the known AYROVI corpus before anything is submitted, and only a HIGH
   composite confidence auto-submits. MEDIUM requires worker confirmation.
   LOW only retries (with guidance).
4. No permanent storage of label frames; no cloud OCR; frames stay on device.
5. Receiving **backend business logic is NOT modified**. Validation is done
   client-side against the corpus the Receiving session already exposes
   (expected cartons + expected products). The backend remains the single
   source of truth and the arbiter of what is actually RECEIVED.
6. Configurable constants (confidence thresholds, weights, cadence, windows)
   live in one configuration module — never hard-coded inside the pipeline —
   so real-label benchmarks can re-tune them without code edits.

## Audit of the current scanner (order §2) — summary of findings

Read: `ContinuousScanner.tsx`, `roi.ts`, `candidates.ts`, `ocr-client.ts`,
`scanner-state.ts`, `scan-source.ts`, `feedback.ts`, `ReceivingTask.tsx`,
`backend/src/modules/receiving/receiving.service.ts`.

Strengths to keep (no rewrite):
- One camera stream stays open across cartons; single rAF decode loop; strict
  explicit state machine (no boolean soup); barcode-first cascade; ROI shared
  by both engines; backend verdict drives SUCCESS/ERROR; repeat-window
  duplicate suppression; lazy Tesseract worker; device-compatibility
  capability probe; wedge-scanner/manual classification.

Weaknesses found (fixed by this batch):
1. **No image-quality gate.** OCR runs on whatever the ROI looks like (glare,
   blur, low light, empty frame). Order §6: DO NOT RUN OCR on a bad image.
2. **No database/corpus validation before submitting an OCR read.** A raw OCR
   token with Tesseract confidence > 45 + 3-frame stabilisation is auto
   submitted. Order §10: exact / candidate / no-match handling required.
3. **Confidence is a single Tesseract number** (> 45). Order §11: composite
   (scanner + OCR + quality + format + database), configurable, HIGH/MEDIUM/LOW.
4. **Single preprocessing recipe** (grayscale → contrast stretch → global
   threshold) for every lighting/rotation condition. Order §7: several
   preprocessing profiles chosen by measured image quality.
5. **Camera**: always asks 1920×1080 ideal, no autofocus/exposure constraints,
   no resolution policy. Order §4: continuous autofocus where available,
   device-aware resolution (not always max), exposure, focus region.
6. **ROI** is a fixed 82%×30% centred band with hard-coded CSS that can drift
   from `computeRoi()`; not adjustable per label type. Order §5: ROI must be
   the same rectangle in code, overlay and quality crop, and adaptable.
7. **Multi-frame voting** exists (3-of-12) but votes are unweighted, ignores
   per-frame quality, and shares no identity with the submit debounce window.
8. **No telemetry**: no scan session id, detection type, latencies, success /
   correction / manual-fallback / false-positive rates. Order §16.
9. Hard-coded magic constants scattered across the file (2500/900/8/18/45).
10. UI shows only generic state labels; no live guided feedback
    («Move closer / Hold steady / Improve lighting / Align label»), no
    low-confidence visual state, no “possible match” confirmation flow.

## New module map (frontend/src/modules/receiving-terminal/)

| File | Responsibility |
|---|---|
| `scan-config.ts` | single configuration source (camera, OCR cadence, quality gate, consensus, validation, confidence thresholds/weights, telemetry) |
| `pixels.ts` | tiny `Pixels` buffer type + shared raster helpers (grayscale, scale, convolve) |
| `image-quality.ts` | quality metrics + gate + guidance ids (blur/low-light/glare/coverage/motion) |
| `preprocess.ts` | preprocessing profiles A–E + auto profile selection (keeps legacy recipe for before/after benchmarks) |
| `fields.ts` | field-aware extraction (article id / tracking / order / customer ref / SKU) — weak priors, never authoritative |
| `normalize.ts` | token normalisation + OCR confusion model + expansion (O/0, I/1, S/5, B/8, G/6 …), applied only format/corpus-driven |
| `validate.ts` | corpus matching: exact / candidate (confusable edit distance) / none |
| `confidence.ts` | composite confidence (source, quality, OCR, format, corpus, votes) → HIGH/MEDIUM/LOW |
| `multiframe.ts` | quality-weighted multi-frame consensus + identity |
| `telemetry.ts` | per-attempt audit trail + aggregate rates (no image storage) |
| `scanner-state.ts` | extended FSM (adds AWAITING_CONFIRM / RESCAN / CONFIRM) |
| `ContinuousScanner.tsx` | guided scan UI + reworked decode loop (barcode → quality gate → OCR pipeline → validation → confidence → auto/confirm/drop) |
| `scanner.css` | guided overlay, quality chips, confirm dialog |

Benchmark/tests:
- `frontend/src/modules/receiving-terminal/**/*.test.ts` — unit tests (vitest).
- `frontend/benchmark/*` — synthetic-label benchmark harness (before/after).

## §17 Synthetic benchmark — results & tuning decisions (2026-09-03)

Harness: `frontend/benchmark/` — `gen_labels.py` (seed 20260903) renders 27
labels / 9 categories; `run-benchmark.mjs` bundles `benchmark/pipeline.ts` (the
exact shipped pure modules) with esbuild and runs the same Tesseract.js (eng)
worker over each label twice: CURRENT legacy recipe vs IMPROVED pipeline.
Freeze: `benchmark/tmp/results.json`. Corpus = the 8 codes the generator draws
from (a receiving session's expected data).

| metric (n=27) | CURRENT | IMPROVED |
|---|---|---|
| correct outcome (read exact OR worker-confirmed correct) | 18/27 = 66.7% | 25/27 = **92.6%** |
| garbage/unknown code silently submitted to Receiving | **9 (33%)** | **0** |
| wrong auto-submission to a *different real* code | 0 | 0 |
| safe drops → rescan / manual (worker loop, nothing entered) | — | 2 (both are the 18-char UPS-style tracking under glare/tilt) |
| avg OCR latency | 39.5 ms | 34.3 ms (+ quality 5.1 ms + preprocess 2.6 ms = 42.0 ms end-to-end) |

Tuning decisions that came out of the benchmark:
1. **Candidate corpus match can never auto-submit** (confidence.ts). A confusable
   near-hit (OCR `S0-88231` → corpus `SO-88231-K`) used to reach HIGH and
   auto-confirm; it is now floored below HIGH so the worker sees
   «Possible match». Exact matches are the only OCR auto-submit path.
2. **Sharpeness is now brightness-invariant** (`magVar/magMean²`, scale 12 in
   image-quality.ts). The old absolute normaliser read dim-but-crisp labels as
   «blurred» → blocked OCR and told workers to hold steady. CV² separates true
   softness/blur (low-DPI print ≈ 9–13, gaussian r≥2.5 ≈ 8–9) from dim-crisp
   (≈ 16–21, same band as clear). Dark thresholds moved to BAD<62 / MARGINAL<112
   luma so a dim frame is coached as «Improve lighting» and preprocessed with
   profile B_LOW_LIGHT instead of being mis-coached as motion blur.
3. Gate semantics kept as a coarse first filter (refuses severe blur / empty
   ROI / extreme dark only); borderline frames proceed to the enforceable
   safety layers (consensus + validation + confidence), which is why unsafe
   auto-submits are 0. Quality-gate veto behaviour is unit-tested.

All numbers above are for the *synthetic* corpus; thresholds are flagged
`tune:` and must be revisited on real warehouse labels (devices/printers) before
deployment.

## ReceivingTask integration rule

Only additions, no business-logic change:
- build `corpus` from the loaded session: carton codes + product SKUs;
- pass `corpus`, and forward the scanner's own confirmation results through the
  SAME `submitCarton`/`submitProduct` paths (still backend-authoritative).
