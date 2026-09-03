# Receiving Scanner — Developer Runbook (real-device benchmark & acceptance)

**Executes:** `docs/RECEIVING-SCANNER-FINAL-ORDER.md` **v1.1** — the single active order.
**Your job here:** produce §38 evidence on real hardware and fill the ANNEX table. Nothing below invents numbers; every row maps to a command, a console hook, or a DevTools measurement.

---

## 0. Before you start (30 min setup)

1. Repo on `master` (latest commit includes the v1.1 code + snapshot tooling). Run:
   ```bash
   cd frontend && npm ci
   npm run test        # expect 91 passed
   npx tsc --noEmit    # clean
   npm run build       # clean
   ```
2. Host the app where **cameras work**: `getUserMedia` needs HTTPS (or `localhost`). Easiest: your already-deployed Render URL, or a tunnel over the dev server (`npx localtunnel --port 5173`), or `ngrok http 5173` after `npm run dev`.
3. Devices to test (§28): (a) average Android phone, (b) weaker device if in your target set, (c) a modern device. Record model + Android + browser + version in the ANNEX "model" column.
4. Have scan targets ready:
   - Print a sheet of the synthetic labels: `frontend/benchmark/tmp/labels/*.png` (45 labels: QR, Code128, SKU lines, Reference lines, degraded cases) — e.g. `ls frontend/benchmark/tmp/labels | xargs -I{} ...` or just open the folder and print 4–6 per page.
   - Real carton/product labels from a real session if available.
   - A USB/HID scanner for hardware mode (or use the built-in **DEV: SIMULATE WEDGE** button first to validate the flow, then a real wedge).

---

## 1. How to run each mode (software)

1. Open a **Receiving card** (Receiving station) → the card **prefetches** expected SKU/Reference/QR/Barcode into the in-memory ScanContext before you scan (§5–§7) — you can verify on the network tab that this data is fetched **once at card open**, and that the recognition loop makes **no per-scan backend calls** (§30).
2. Press **SCAN** → method tabs **SOFTWARE | HARDWARE**. On desktop the default is HARDWARE; on the phone, SOFTWARE (§2). Choose **SOFTWARE** on the phone.
3. Camera opens **once** and stays live. Red line is guidance only — you can scan a target **outside** the line (§4).
4. Do the §39 acceptance script (below) — success → auto-next, wrong → instant ✕ → re-aim (no Retry, no camera restart).

## 2. How to run each mode (hardware)

1. Desktop: open Receiving → SCAN → **HARDWARE** is the default; no camera permission is ever requested (§33).
2. Plug a USB scanner (keyboard-wedge). Status flips to **● Connected**. Scan a code → appears in LAST SCAN; same pipeline as camera (§7/§22).
3. Unplug → ○ Disconnected → **RECONNECT**. On phone/tablet the panel also offers **SWITCH TO SOFTWARE SCAN** (§23).
4. Bluetooth: **PAIR BLUETOOTH** (browser must support Web Bluetooth; capability chip shows it). If no standard 0xFFE0/0xFFE5 service is found you get an explicit message — that is an unsupported-device outcome, not a bug.

## 3. Collecting the numbers (§38 items 11–26) — per device

For each device, per method (software / hardware), run a labelled batch and capture:

**A. One console command captures the whole ANNEX row** (new snapshot tooling):
```js
// after a batch of scans on SOFTWARE (camera)…
copy(window.__ayroviScanTelemetry.snapshotCsv())      // -> paste into ANNEX row
// after a batch on HARDWARE…
copy(window.__ayroviHardwareTelemetry.snapshotCsv())  // -> paste into ANNEX row
```
`snapshotCsv()` returns one CSV row with: method/deviceType/provider · cpuCores/deviceMemoryGb/fpsAvg/resolution · attempts · **p50/p90/p95/p99/max** (ms) · accepted/rejected/retryRate/lowConfidenceRate/falseAcceptRate · **per-decode-type** (QR / BARCODE / SKU-OCR / REFERENCE-OCR): n, ok, rate, p50/p95/p99/max.
Raw attempts + stage timings:
```js
copy(window.__ayroviScanTelemetry.csv())              // full per-attempt log
window.__ayroviScanTelemetry.summary()                // readable aggregates
```
(Per-scan rows already carry scan_method/device_type/provider/target_type/decode_type/attempt_number/processing_ms/confidence/validation_result/match_result/success/failure/failure_reason — §32.)

**B. Batches to run per device (reset between batches with `clear()`):**
| Batch | What to scan | Read from snapshotCsv() |
|---|---|---|
| QR | 20 correct QR labels | `qrN/qrOk/qrRate`, `qrP50/95/99` |
| Barcode | 20 correct Code128 labels | `bc…` |
| SKU OCR | 20 product SKU lines | `sku…` |
| Reference OCR | 20 Reference lines | `ref…` |
| Correct/wrong mix | mix correct + wrong + blurred + low-light | overall success/retry/lowConf/falseAccept rates |

**C. Items the snapshot can’t measure (fill from DevTools, honestly):**
- **CPU % / RAM MB:** Android → enable Developer options → USB debugging, open `chrome://inspect` → your tab → Performance/Memory. Record idle-vs-scanning peak.
- **Average FPS / resolution:** snapshot includes `fpsAvg` (the scanner’s own counter) and you can confirm resolution in `getUserMedia` capabilities; cross-check in `chrome://media-internals`.
- **Network requests per scan:** DevTools → Network, filter `receiving`; count requests attributable to ONE scan decision (expect **0** inside the recognition loop; the only traffic is the submit/confirm that the business flow already makes — §30).
- **Frames processed per successful scan:** DevTools Performance trace count of `requestAnimationFrame` decode ticks between target-present and success, OR reason from fps + latency: ≈ fps × (p50/1000). Record which method you used.

## 4. Before/After benchmark (§38-27)

Repo scripts produce the **before/after** on the synthetic corpus (same run, same engines) so the developer can also re-run after any local change:
```bash
cd frontend/benchmark
node run-benchmark.mjs        # software: 45 labels/16 categories → tmp/results.json
node run-hw-benchmark.mjs     # hardware pipeline → tmp/hardware-results.json
```
Report the deltas (baseline numbers already in the order’s Appendix A) **plus** the real-device rows from §3. The device rows are what prove the order’s “real speed, not animation”.

## 5. §39 Final acceptance script (run on the real Android phone, screen-recording)

1. Open Receiving card → confirm prefetch already happened (network: data fetched at open) → press SCAN.
2. Camera LIVE → point approximately at a correct QR → ✓ → NEXT automatically. **Camera still LIVE.**
3. Point a correct SKU line → ✓ → NEXT. Camera still LIVE.
4. Point a **wrong** value → ✕ (short feedback) → camera still LIVE, no retry button — just re-aim at the correct target → ✓ → NEXT.
5. Repeat 5× without opening/closing the camera.
Record the whole flow as the screen recording (§38-29). Screenshots: software mode frame with ROI + phase chip, and hardware mode panel (● Connected + LAST SCAN) (§38-30/31).

## 6. Fill the ANNEX and return

- Paste each device’s `snapshotCsv()` row into the ANNEX table in `docs/RECEIVING-SCANNER-FINAL-ORDER.md`, then add CPU/RAM/fps/network/frames notes per row.
- Deliverables checklist (§38 items 1–36): root cause latency (bottleneck analysis §29 with evidence), architecture diagram/summary, the 6 code docs (prefetch/scanContext/cleanup/warm/camera lifecycle — see Appendix B of the order), benchmarks + device rows, screenshots/recording paths, build/test/lint-typecheck output, commit hash(es), files-changed list (use `git show --stat <your-commit>`).
- Open a PR/commit **with the numbers**; the order will then be bumped to v1.2 with your measured results. Do **not** edit the order text itself without review.

## Honesty rules (from the order)
No made-up numbers. A row you could not measure stays blank with a reason. `snapshotCsv()` never fabricates fps/CPU/RAM — those come only from DevTools or real probes.

## 7. Level-2 OCR engine (PP-OCRv3) — opt-in measurement (post-P1 spike)

What shipped (feature-flagged, product default UNCHANGED = tesseract):

- `frontend/src/.../pp-ocr/*` — PP-OCRv3 engine (det+angle-cls+rec) in TS,
  offline-validated ALL PASS against real label photos
  (`frontend/benchmark/level2/validate-pp.mjs`, onnxruntime-node).
- Models are static assets: `frontend/public/ocr-models/*.onnx` (~13.7 MB) +
  `ppocr_keys.json`. Loaded once and kept warm across sessions.
- Runtime seam: `ocr.engine: 'tesseract' | 'ppocr'` (`scan-config`). The level-2
  path (own detection, line ranking with the card-derived prefix filter +
  expected/corpus match → same HIGH/MEDIUM/LOW gates) only runs when the engine
  is `ppocr`.

To measure it on a real device:

1. Serve the onnxruntime WASM same-origin (the browser chunk needs it):
   ```bash
   mkdir -p frontend/public/ocr-wasm
   cp frontend/node_modules/onnxruntime-web/dist/ort-wasm*.wasm frontend/public/ocr-wasm/
   ```
   (Only needed when ppocr is enabled; the default path is `/ocr-wasm/`.)
2. Opt in WITHOUT code change (dev/benchmark hook, stored locally on that phone):
   ```js
   localStorage.setItem('ayrovi.ocrEngine', 'ppocr')
   ```
   Then open a Receiving card and press SCAN. Reset with `'tesseract'`.
3. Warm-up is automatic while the session loads (model fetch ~13.7 MB once,
   then cached). First OCR frames while still warming report
   `failureReason=level2_engine_warming` and simply retry on the next cadence.
4. Measure with the same harness as §3: run a real batch of SKU/Reference
   labels, then
   `copy(window.__ayroviScanTelemetry.snapshotCsv())` — rows now carry
   `scannerType=ppocr` so level-2 and tesseract attempts are separable.
5. Report the device row in the ANNEX with the engine note (ppocr). Decision to
   flip the product default to `ppocr` happens ONLY with those measured numbers
   (target to confirm, not a claim: warm p95 ≤ ~1.5 s per attempt on the target
   device, zero false accepts), and lands as a v1.2 review.
