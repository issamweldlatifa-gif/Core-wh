# SCANNER + OCR — P0 Delivery Report (Receiving Terminal)

**Order scope:** AYROVI Warehouse Core — «أمر تقني P0» — Scanner + OCR rework for the Receiving Terminal.
**Flow preserved:** Arrival → Receiving → Container/Tote → Customer Sorting → Customer Bin → Packing → Shipping → Archive/Trace.
**Identification priority:** QR/Barcode **first** → OCR fallback → Manual confirmation. OCR is never a higher source of truth than a barcode/QR.
**Date:** 2026-09-03

---

## 1. Architecture (as found — "current" baseline)

The pre-existing scanner was a single React component, `frontend/src/modules/receiving-terminal/ContinuousScanner.tsx`, driving one open `MediaStream` and one `requestAnimationFrame` decode loop:

```
Camera frame → full-frame draw → ROI crop (82%×30% band)
            → ZXing MultiFormatReader or BarcodeDetector (barcode/QR, priority)
            → if barcode fails for N frames → OCR fallback:
                 grayscale → contrast stretch → single global threshold
                 → Tesseract.js (PSM 6) whole-ROI recognition
            → raw token filter (candidates.ts) → 3-of-12 unweighted frame stabiliser
            → if Tesseract confidence > 45 → auto-submit to parent
```

Supporting modules read in the audit: `roi.ts`, `candidates.ts`, `ocr-client.ts`, `scanner-state.ts` (explicit FSM — good), `scan-source.ts`, `feedback.ts`, `ReceivingTask.tsx`, and `backend/src/modules/receiving/receiving.service.ts`.

**Good foundations kept (no rewrite):** single persistent camera stream; strict explicit state machine (no boolean soup); barcode-first cascade; ROI shared between engines; backend verdict drives SUCCESS/ERROR; a repeat-window duplicate guard; lazy Tesseract worker; device capability probe; the consumer contract `onDetected(value, source)`.

**Reworked scanner architecture (as delivered):**

```
Frame → ROI (mode-adjustable) → [quality gate]
      ├─ barcode/QR decode first — a valid code always wins, OCR is skipped (§12)
      └─ OCR only after barcode keeps failing AND quality passes:
             assessQuality → profile selection (A–E) → preprocess
             → Tesseract → field-aware extraction → normalisation
             → weighted multi-frame consensus → corpus validation
             → composite confidence → HIGH auto / MEDIUM worker-confirm / LOW retry
All decisions audited through telemetry; nothing stored; backend remains the arbiter.
```

All pipeline logic lives in small **pure modules** (`frontend/src/modules/receiving-terminal/`) that are also imported by the offline benchmark, so the §17 numbers exercise the exact shipped code.

## 2. Problems discovered in the audit

| # | Finding | Consequence | Fixed by |
|---|---|---|---|
| 1 | **No image-quality gate** — OCR ran on glare, blur, dark, empty frames | wasted OCR, wrong worker guidance | `image-quality.ts` gate (see §4) |
| 2 | **No corpus/database validation before submitting an OCR read** | raw OCR token auto-submitted on confidence > 45 | `validate.ts` corpus matching + scanner rework (§7) |
| 3 | **Confidence = a single Tesseract number** | no distinction scanner/OCR/format/db; no HIGH/MEDIUM/LOW policy | `confidence.ts` composite model (§6) |
| 4 | **One preprocessing recipe for every condition** (gray → stretch → global threshold) | poor reads under low light / small text / rotation / glare | `preprocess.ts` profiles A–E + auto-select (§4) |
| 5 | **Camera always asked 1920×1080 ideal; no autofocus/exposure/region policy** | cost/latency/battery, poor near-field focus | per-device resolution policy + `tuneCamera` (§5) |
| 6 | **ROI fixed 82%×30%, CSS could drift from `computeRoi()`** | crop ≠ overlay ≠ what OCR saw; no per-label-type ROI | ROI ratio source of truth, shared + per-mode (§5) |
| 7 | **Multi-frame voting unweighted** (3-of-12), ignored per-frame quality | a few lucky frames could stabilise a wrong token | `multiframe.ts` quality-weighted consensus (§8) |
| 8 | **No telemetry/audit** | no rates to prove anything (barcode success, OCR correction, manual fallback, false positives) | `telemetry.ts` (§8) |
| 9 | **Magic constants scattered** (2500/900/8/18/45) | untunable | `scan-config.ts` single configuration source |
| 10 | **UI**: generic labels only; no «Move closer / Hold steady / Improve lighting / Align label», no low-confidence state, no "possible match" confirmation | workers unguided; low-confidence reads still entered | guided UI + confirmation gate (§3, §8) |

Additionally, the §17 benchmark exposed two **policy/calibration defects** that unit tests alone had not caught:
- **A confusable near-match could auto-submit.** OCR `S0-88231` fuzzy-hitting corpus `SO-88231-K` had *enough* composite score to reach HIGH and auto-confirm — i.e. a blind auto-correction (§19 violation). Fixed with the **candidate floor** (§6).
- **The sharpness metric was not brightness-invariant.** Dim-but-crisp synthetic labels scored as `blurred` (0.33), so the gate refused OCR and coached "Hold steady" instead of "Improve lighting". Fixed with a CV²-based metric (§4).

## 3. Changes implemented

**Pure modules added** under `frontend/src/modules/receiving-terminal/`:
- `scan-config.ts` — one configuration source: camera policy, ROI per scan mode, OCR cadence, quality gate, consensus, validation distance/costs, confidence weights + thresholds, telemetry cap; `mergeConfig()` for per-deployment/per-benchmark overrides. All numeric values flagged `tune:`.
- `pixels.ts` — shared raster types/helpers (grayscale, scaling) so every stage (quality, preprocess, ROI) uses identical math in browser and Node.
- `image-quality.ts` — quality metrics + gate + guidance ids + `quickGuidance()`; thresholds exported for tuning.
- `preprocess.ts` — profiles **A_NORMAL, B_LOW_LIGHT, C_SMALL_TEXT, D_ROTATED (skew-estimate + rotate), E_GLARE, LEGACY_GLOBAL** (the old recipe, kept byte-stable as the "current" baseline for before/after runs), plus auto profile selection from measured quality.
- `fields.ts` — field-aware extraction: `ARTICLE / CARTON / TRACKING / ORDER / CUSTOMER_REF` rules with per-field format plausibility; stop-word suppression (no `TRACKING`, `MADEINTUNISIA`… leaking as codes).
- `normalize.ts` — deterministic token cleanup + **OCR confusion model** (`O↔0↔Q`, `I↔1↔l`, `S↔5`, `B↔8`, `G↔6`, `D↔0`…): confusable substitutions cost 0.5, full substitutions cost 1; **no blind glyph replacement** — decisions are driven by format rules and corpus distance, never by global substitution.
- `validate.ts` — `matchAgainstCorpus()` → `exact | candidate | none | no_corpus` with `dbScore`; `buildSessionCorpus()` collects carton identity fields + product SKUs/references from the loaded session; length gate rejects nonsense.
- `confidence.ts` — composite confidence → `HIGH | MEDIUM | LOW` (see §6).
- `multiframe.ts` — quality-weighted consensus (votes × per-frame gate score; window + votes-required from config).
- `telemetry.ts` — per-attempt audit (ts, scan session, mode, scanner type, detection type, processing ms, OCR confidence, image quality, validation result, final result, failure reason, device type, frames) + `summary()` rates + CSV export handle; **no label images stored**.

**Modified legacy files:**
- `ContinuousScanner.tsx` — full decode-loop rework: quality gate before OCR, profile-based preprocess, field extraction, consensus, corpus validation, composite-confidence decision, worker **CONFIRM / RESCAN / EXIT-TO-MANUAL** gate, duplicate suppression tied to identity+time+session, guidance phases (`SEARCHING / BARCODE_DETECTED / OCR_DETECTED / LOW_CONFIDENCE / CONFIRM_NEEDED / CONFIRMED`), torch/flip camera controls, live FPS + guidance strip.
- `roi.ts` — ROI computed once per mode (CARTON wide band `0.82w×0.30h`, PRODUCT taller band `0.64w×0.42h`) and used for overlay **and** the crop sent to quality/OCR; overlay style derives from the same ratio (no drift).
- `ocr-client.ts` — lazy single worker, busy flag, `recogniseRoi` with PSM by profile, `terminateOcr` on teardown (kept device-local; no cloud OCR).
- `scanner-state.ts` — FSM extended with `CONFIRM` transition (VALIDATING → SUBMITTING) so a MEDIUM candidate is *held* until the worker confirms or rescans; LOW never reaches VALIDATING.
- `scanner.css` — guided overlay, ROI corners/hint, status chips, quality guidance, confirmation dialog, no-camera/error states.
- `frontend/src/terminal/ReceivingTask.tsx` — integration **additions only**: builds the session corpus (expected cartons + expected products) and passes it to the scanner; confirmation flows through the **same** `submitCarton`/`submitProduct` paths. **Backend business logic untouched** (`git status backend` clean).
- `frontend/package.json` — scripts `test`/`test:watch`; dev deps `pngjs`, `esbuild`, `vitest`.

## 4. OCR pipeline (new) + image-quality gate

Stage-by-stage (browser and benchmark run the identical pure code):

1. **Crop ROI** — only the alignment rectangle is analysed; the full frame is never sent to OCR (§ ROI).
2. **Quality gate** — `assessQuality(gray)`: dark-pixel ratio, specular (glare) ratio, Sobel edge energy/ratio, **brightness-invariant sharpness** `min(1, magVar / (magMean² × 12))`, coverage & cropping tests, h/v gradient ratio (rotation/motion hint). Levels `GOOD / MARGINAL / BAD`; `BAD` → **OCR is refused** and the worker gets targeted guidance. Thresholds: dark mean `BAD<62 / MARGINAL<112` luma, glare `>5% / >2%` blown, sharp `BAD<0.5 / MARGINAL<0.75`.
3. **Profile selection** — from the measured quality (`selectProfile`): A normal, B low-light, C small-text (with 2× upscale), D rotated (skew estimate; deskews only when `|skew| ≥ 0.75°`), E glare. OCR PSM 7 for C, PSM 6 otherwise.
4. **OCR** — Tesseract.js (eng), lazy single worker, char whitelist `A–Z 0–9 -`.
5. **Field-aware extraction** — tokenised with per-field plausibility (ARTICLE/CARTON/TRACKING/ORDER/REF/SKU patterns; stop-word suppression).
6. **Normalisation** — deterministic cleanup only (case, separators, noise). Confusable glyphs are *priced* in distance, never replaced blindly.
7. **Multi-frame consensus** — quality-weighted votes; a token stabilises only after `votesRequired` in `windowFrames`.
8. **Validation** — against the session corpus (exact / candidate / none / no-corpus).
9. **Confidence + decision** — §6; LOW retries with guidance, MEDIUM opens the confirmation dialog, HIGH (exact only) auto-submits.

Gate calibration note from the §17 set: with the retuned metric the hard gate no longer fires on **legible** synthetic labels (0 hard-blocks — each of the 9 categories is recoverable by design); its veto role (severe defocus/motion blur, empty ROI, extreme dark) is covered by unit tests (`image-quality.test.ts`: blur-r5 → refuse OCR, empty ROI → `no_label`, darken-0.18 → `low_light` block). Borderline quality is handed to the enforceable safety layers — consensus + validation + confidence — which is why unsafe auto-submits are 0. This split is deliberate: a coarse first filter plus a strict final arbiter, not the reverse.

## 5. Camera improvements

- **Device-aware resolution policy (never always-max):** SMARTPHONE/TABLET/UNKNOWN request **1280×720**, DESKTOP **1920×1080** (config `camera.resolution`). Rationale: a 720p ROI is sufficient for barcode + our OCR input width cap (960); reduces CPU/RAM/battery vs the old unconditional 1080p ideal.
- **Continuous autofocus / exposure / white-balance** requested through `applyConstraints({advanced})` **only when the platform advertises them** (`tuneCamera`), so devices that do not support a mode are never over-constrained — getUserMedia is wrapped with Overconstrained error handling and a soft-abort retry.
- **Frame-rate policy** ideal 30 / max 60 (advertised-capability clamped).
- **OCR throttling:** OCR runs only after `framesBeforeOcr` (18) barcode-failure frames and then on a cadence of `ocrCadence` (8) frames, guarded by `ocrBusy()` — never on every frame. First-detection loop stays lightweight (rAF).
- **Live guidance between OCR triggers** via cheap sampled `quickGuidance()` (light/glare hints) so the worker is steered while searching.
- ROI analysed **per scan mode**, adjustable for label type; frame capture for analysis is the ROI crop only.
- Latency/CPU telemetry fields (`processingMs`, `avgScanTimeMs`, `avgOcrMs`, p95) aggregated in `telemetry.ts`; FPS shown live in the UI. Battery/CPU profiling is expected on-device (see §10/§11).

## 6. Confidence model

Composite, configurable, never hard-coded (order §11):

```
raw = qualityScore·wQ + ocrConf·wO + formatScore·wF + dbScore·wD   (weights 0.2/0.3/0.2/0.3)
score = raw·100  +  consensus bonus (up to +8, only for multi-frame reads)
level  = score ≥ high(82) → HIGH     ≥ medium(58) → MEDIUM     else → LOW
```

Policy floors applied on top (each one *lowers* an over-confident read to a safe level):
- **Barcode/QR** decode ⇒ score 100 / HIGH (deterministic identification, order §12).
- **No corpus** ⇒ OCR can never reach HIGH (database weight redistributed to OCR+quality; score capped below HIGH) → MEDIUM at best → worker confirmation.
- **Bad format** (`formatScore < 0.3`) ⇒ capped below HIGH.
- **Candidate corpus match** ⇒ capped below HIGH — **only an exact corpus hit may auto-submit.** This closes the blind auto-correction hole found by the benchmark (§19).

Level semantics: **HIGH** auto-submits (exact corpus match + strong OCR/quality); **MEDIUM** opens the confirmation dialog — for candidates it shows `Possible match: <code>` with selectable candidates and the raw OCR read, CONFIRM disabled for `none`; **LOW** never submits — the worker gets «No matching Article found — rescan or manual entry» or quality guidance and scanning continues.
Thresholds (82/58) and weights are initial conservative values flagged `tune:` to be re-set from a real-label benchmark.

## 7. Validation logic (against AYROVI data)

- The corpus is built from the loaded Receiving session only: **expected carton codes** (`externalCartonId`, barcode/QR values, references) + **expected product SKUs/references** (`buildSessionCorpus`) — client-side validation, with the backend kept as the single arbiter of what is actually RECEIVED.
- `matchAgainstCorpus(read, corpus, cfg)` uses the confusable-aware weighted edit distance (§4): distance ≤ `maxCandidateDistance` (1.2) ⇒ `candidate` (with up to `maxCandidates` suggestions); distance 0 and length-format plausible ⇒ `exact`; otherwise `none`; empty corpus ⇒ `no_corpus` (neutral score 0.5).
- Outcomes drive the UI exactly as ordered:
  - **Exact match** → high source → auto-confirm path (subject to composite confidence and the duplicate guard).
  - **Candidate** → `Possible match: …` shown, never auto-registered, worker chooses/confirms (only the *canonical* corpus value is submitted).
  - **No match** → «No matching Article found» → RESCAN or EXIT to manual entry; nothing is entered silently.
- Length gate rejects nonsense short tokens; stop-word suppression in field extraction prevents non-code words from ever being validated.

## 8. §17 Benchmark — method, results, before/after

**Method (fully reproducible):** `frontend/benchmark/`
- `gen_labels.py` (seed `20260903`) renders **27 PNG labels / 9 categories** in real fonts (DejaVu Sans/Bold/Mono/Serif): **Clear (3) · Small Text (3) · Low Light (3) · Glare (3) · Tilted (3) · Damaged (3) · Fonts (3) · Printers/low-DPI (3) · Sizes (3)**. Ground truth drawn from an 8-code AYROVI-style corpus (`ABO-…`, `TUN-…`, `SKU-…`, `CTN-…`, `1Z999…` UPS tracking, `ORD-…`, `AYROVI-…`, `SO-…-K`); that same set is the validation corpus (mirrors a session’s expected data).
- `pipeline.ts` re-exports the pure app modules; `run-benchmark.mjs` esbuild-bundles it and runs **the same Tesseract.js worker** over each label twice:
  - **CURRENT:** legacy recipe (grayscale→stretch→global threshold) → Tesseract → first raw candidate **auto-submitted** (old scanner policy: no gate, no validation).
  - **IMPROVED:** gate → profile → preprocess → OCR → fields → consensus (1 frame) → validation → composite confidence → HIGH auto / MEDIUM confirm / LOW drop.
- Outputs per-category + aggregate tables and freezes `tmp/results.json`.

**Aggregate (n = 27):**

| Metric | CURRENT | IMPROVED |
|---|---|---|
| Correct outcome (read exactly **or** worker-confirmed correct) | **18/27 = 66.7%** | **25/27 = 92.6%** |
| Garbage/unknown code silently submitted to Receiving | **9/27 = 33.3%** | **0** |
| Wrong auto-submission to a *different real* corpus code | 0 | 0 |
| Safe drops → rescan / manual (nothing entered) | — | 2 (18-char `1Z999…` tracking under glare/tilt; OCR fails → retry/manual) |
| Avg OCR latency / label | 41.2 ms | 36.3 ms (OCR) + 4.6 (quality) + 3.0 (preprocess) = **43.9 ms end-to-end** |
| Total run | ~3.4 s (54 OCR passes) | ~3.4 s |

**Per category (% of each group):**

| Category | n | CURRENT read-exact | CURRENT wrong/unknown **submitted** | IMPROVED auto-exact | IMPROVED confirm-ok | IMPROVED drop |
|---|---|---|---|---|---|---|
| Clear | 3 | 66.7% | 33.3% | 66.7% | 33.3% | 0% |
| Small text | 3 | 33.3% | 66.7% | 66.7% | 33.3% | 0% |
| Low light | 3 | 66.7% | 33.3% | 66.7% | 33.3% | 0% |
| Glare | 3 | 66.7% | 33.3% | 66.7% | 0% | 33.3% |
| Tilted | 3 | 33.3% | 66.7% | 33.3% | 33.3% | 33.3% |
| Damaged | 3 | 66.7% | 33.3% | 33.3% | 66.7% | 0% |
| Fonts (bold/mono/serif) | 3 | 66.7% | 33.3% | 66.7% | 33.3% | 0% |
| Printers (low DPI) | 3 | 100% | 0% | 100% | 0% | 0% |
| Sizes | 3 | 100% | 0% | 100% | 0% | 0% |

**Illustrative rows from `results.json`** (what changed and why):
- *small-text label containing caption noise*: CURRENT submitted `HAZ3-BOX1712` (garbage caption token); IMPROVED field extraction + stopwords selected the real `50-88231`/`CTN-…` → exact or confirm-correct.
- *mono-font / damaged / low-light `SO-88231-K` read as `50-88231(-K)`*: CURRENT submitted garbage (`50-88231`); IMPROVED maps it to a **candidate** `SO-88231-K` and requires worker confirmation (possible-match), never auto-substituting `S→5`.
- *clear label read `S0-88231`*: same story — candidate floor keeps it out of the auto path.
- *tilted/glare `1Z999AA10123456784`*: OCR genuinely fails (`14999…`, `17999…`); IMPROVED **drops** (nothing entered) → worker re-scans or uses manual; CURRENT submitted the wrong read.

**Why these numbers matter:** the old scanner’s success *rate* (66.7%) hides that 33.3% of entries were garbage auto-submitted to Receiving — false reads that would poison downstream receiving events. The new pipeline is not just more accurate (92.6% correct outcomes) — it is **safe by construction**: 0 silent garbage, 0 blind auto-corrections, and every failure ends in RESCAN/MANUAL, never an unverified entry. (Synthetic corpus; thresholds flagged for real-label validation — §11.)

## 9. Before / After summary

| Dimension | Before (CURRENT) | After (IMPROVED) |
|---|---|---|
| Correct outcomes (synthetic, n=27) | 66.7% | 92.6% |
| Silent garbage entries into Receiving | 9 (33%) | 0 |
| Blind auto-corrections of confusable reads | present (e.g. `S0-88231`→`SO-88231-K` auto) | impossible (candidate ⇒ worker confirmation) |
| OCR latency | 41.2 ms avg | 36.3 ms avg (OCR) / 43.9 ms incl. quality+preprocess |
| OCR triggers | on stabilised frames regardless of image | gated by quality + barcode-priority cadence (≤1/8 frames after 18 failures) |
| Image handling | full-frame-to-OCR, single threshold | ROI-only, profile-selected (A–E), gate before OCR |
| Confidence | single Tesseract number (>45) | composite, configurable HIGH/MEDIUM/LOW + policy floors |
| Camera | 1080p ideal always, no AF/exposure | per-device resolution (720p mobile), continuous AF/AE/WB where advertised, framerate cap |
| Verification evidence | none | telemetry rates (barcode/OCR/correction/fallback/false-positive), CSV audit handle |

## 10. Devices tested

**Executed in this environment:**
- **Node v20.20.2 + Tesseract.js (eng)** — OCR parity path: the benchmark runs the *identical* pipeline code (esbuild bundle of the shipped pure modules) and the same Tesseract engine the app uses in the browser; 54 OCR passes executed.
- **Unit/type level** — `vitest` 39 tests (2 files), `tsc --noEmit` clean over the whole frontend, so every device branch in `scan-source.ts`/`tuneCamera()`/capability probing is compiled and statically checked.
- **PIL-generated label corpus** across all 9 degradation categories.

**Not executed here (requires field hardware):** physical camera/phone/tablet runs, torch, focus/exposure capability matrices, battery/CPU sampling, wedge scanners. The code paths for SMARTPHONE/TABLET/DESKTOP resolution policies and continuous-AF `applyConstraints` are capability-probed and error-softened by design; they must be spot-checked on the actual devices listed in `scan-source.ts` (Android Chrome / iOS Safari phones + tablets, desktop webcam, USB wedge) before deployment. This is called out as a limitation (§11), not claimed as done.

## 11. Known limitations

1. **Synthetic corpus only.** Confidence thresholds (82/58), gate thresholds and profile gains were tuned/verified on seeded synthetic labels — the benchmark must be re-run on real warehouse labels/printers and thresholds re-set via `scan-config` (`tune:` flags) with no code edits.
2. **No physical-device verification yet** (see §10): focus/exposure behaviour, torch, battery/CPU and true FPS numbers are device-dependent.
3. **Consensus in the benchmark uses single frames**; the live scanner aggregates multiple frames (votesRequired 3 / window 12) — multi-frame behaviour is unit-tested, not yet measured end-to-end on device.
4. **No blurred/empty-frame synthetic category** in the §17 nine categories: the quality gate's veto cases are unit-tested (blur r5, empty ROI, extreme dark), not benchmark-counted.
5. Tracking-number OCR (`1Z999…`) remains hard under glare/tilt — pipeline drops safely rather than guessing (correct by design), but a real-label dataset may improve profile/PSM choice for that format.
6. Long-session telemetry is in-memory (ring capped at `maxAttempts`); production persistence/export is a follow-up (CSV handle provided).
7. Engines: OCR model is English-only; Arabic/French numerals on labels need a trained-data follow-up (code is language-agnostic — one config value).

## 12. Files changed

Modified:
- `frontend/src/modules/receiving-terminal/ContinuousScanner.tsx`
- `frontend/src/modules/receiving-terminal/ocr-client.ts`
- `frontend/src/modules/receiving-terminal/roi.ts`
- `frontend/src/modules/receiving-terminal/scanner-state.ts`
- `frontend/src/modules/receiving-terminal/scanner.css`
- `frontend/src/terminal/ReceivingTask.tsx`
- `frontend/package.json`, `frontend/package-lock.json`

Added:
- `frontend/src/modules/receiving-terminal/scan-config.ts`, `pixels.ts`, `image-quality.ts`, `preprocess.ts`, `fields.ts`, `normalize.ts`, `validate.ts`, `confidence.ts`, `multiframe.ts`, `telemetry.ts`, `P0-SCANNER-OCR.md`
- `frontend/src/modules/receiving-terminal/testing/synth.ts` (+ helpers)
- Tests: `frontend/src/modules/receiving-terminal/scan-logic.test.ts`, `image-quality.test.ts`
- `frontend/benchmark/` — `gen_labels.py`, `pipeline.ts`, `run-benchmark.mjs`, `.gitignore`, `tmp/{labels, manifest.json, results.json, README.md}` (dataset + frozen results)

Untouched by design: `backend/**` (Receiving business logic), workflow/flow code outside Receiving terminal UI additions.

## 13. Tests added

`frontend/src/modules/receiving-terminal/` (vitest):
- `image-quality.test.ts` (13 tests) — GOOD/MARGINAL/BAD classification, blur refuses OCR, low-light & glare detection, empty-ROI rejection, small-text guidance stays usable, threshold stability, quickGuidance; preprocessing profiles A–E (output dims, max=255, D→A legal fallback on upright labels), C upscaling, profile auto-selection, legacy byte-stability.
- `scan-logic.test.ts` (26 tests) — config deep-merge; ROI math + overlay parity; normalisation & confusable distance (O↔0, I↔1, P0 example `ABCI2345`→`ABC12345` ≤ 0.6, no blind equalisation); corpus matching exact/candidate/none/no-corpus + length gate; session-corpus builder; **confidence**: barcode/QR always HIGH, strong-OCR+exact HIGH, weak-OCR MEDIUM, no-match LOW, no-corpus never HIGH, bad-format capped, **candidate never HIGH (§19 regression test)**; multi-frame consensus (required votes, weak frames can't reach bar, reset after result); field extraction with stop-words; telemetry aggregation + false-positive counting + CSV, no images stored.

Total: **39 tests / 2 files passing.**

## 14. Regression results

- `npx vitest run` (frontend) → **Test Files 2 passed, Tests 39 passed** (0 failures).
- `npx tsc --noEmit` → **clean** (0 errors) over the frontend incl. the new pure modules and the scanner component.
- Backend regression surface: **none touched** — `git status backend` is empty; Receiving submit paths unchanged; scanner changes are additive to `ReceivingTask.tsx`.
- Barcode/QR priority regression check: barcode decode runs first on every frame and a valid code short-circuits OCR (unchanged ordering, §12); duplicate suppression + identity debounce retained (2 500 ms repeat window).
- Benchmark determinism: re-runs reproduce the same outcome counts (92.6% / 0 unsafe; minor run-to-run OCR latency variance only).

## 15. Commit hash

Code + benchmark + working plan commit: **`41ef6c0`** —
*«P0 — Receiving Scanner + OCR rework: quality gate, profiles A–E, corpus validation, composite confidence, guided UI, telemetry + §17 before/after benchmark»*
(backend untouched in this commit; full diff reviewed in §12.)

---

### Acceptance recap (against the P0 gate)

| Acceptance criterion | Status |
|---|---|
| No barcode regression; QR/Barcode priority kept | ✔ barcode-first loop unchanged; unit-tested HIGH determinism |
| ROI stable (code = overlay = analysis crop), adjustable per label type | ✔ per-mode ROI ratio single source |
| Duplicates prevented | ✔ identity + time + session + repeat window |
| OCR only when needed | ✔ barcode-priority + `framesBeforeOcr` + cadence + `ocrBusy()` |
| Image-quality gate effective | ✔ BAD refused (unit-tested); borderline → validation layer |
| Preprocessing improved (profiles) | ✔ A–E + auto-select, benchmarked |
| Field extraction clear | ✔ fields + formatScore + stop-words |
| Validation vs AYROVI data | ✔ exact/candidate/none/no-corpus vs session corpus |
| Confidence exists & configurable | ✔ composite HIGH/MEDIUM/LOW, config-thresholds |
| Low-confidence never auto-entered | ✔ LOW → retry/manual; MEDIUM → worker confirm; candidate → never auto |
| Worker flow Point → Detect → Confirm → Continue | ✔ guided UI + confirmation gate + continuous loop |
| OCR failure ends in Retry/Manual only | ✔ drops (2/27) → RESCAN / EXIT-TO-MANUAL; no unverified entry |
| **Proven better (not just "reads more")** | ✔ +25.9pp correct outcomes, −33pp silent garbage, 0 blind corrections, ~same latency, worker-guided & auditable |
