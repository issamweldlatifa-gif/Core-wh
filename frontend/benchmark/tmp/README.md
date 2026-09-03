# §17 Synthetic OCR Benchmark (reproducible)

Dataset: `labels/*.png` + `manifest.json` — 27 labels / 9 categories, seed 20260903.
Corpus = the 8 AYROVI-style codes the generator renders (== a session's expected data).

Run:
  python3 benchmark/gen_labels.py      # (re)generate dataset
  node benchmark/run-benchmark.mjs     # bundle TS pipeline + Tesseract before/after

Freeze: `tmp/results.json` (last run) — rows, per-category table, aggregate summary + latency.
Pipeline under test = the exact app code: benchmark/pipeline.ts re-exports the pure modules,
bundled by esbuild so Node runs the shipped logic (no browser).

Note on the image-quality gate: on this legible synthetic set the hard gate never fires
(0 hard-blocks). Its veto behaviour (severe blur / empty ROI / extreme dark) is covered by
unit tests in image-quality.test.ts. Borderline frames go to validation+consensus+confidence,
which is the enforceable no-wrong-entry layer (see delivery report).
