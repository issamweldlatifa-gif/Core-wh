# 20 · Directed OCR (SKU template) + native ML Kit text engine

## Pipeline

```
label text (camera engine / pasted block / typed text)
  → DirectedOcr.read(block) through OcrTemplate.SKU   [scanner-core, pure]
    → DirectedOcrResult(candidate?, confidence, alternatives)  [unconfirmed]
      → OCR review panel (multi-line field + suggestion)       [app UI]
        → operator presses SUBMIT SKU
          → ScanCoordinator.onOcrConfirmed → ScannerManager   [same guard]
            → ScanResult(value, MANUAL) → ReceivingWorkflow → server
```

Raw engine text is NEVER submitted: `ScanCoordinator.onScanned(..., fromOcr = true)`
still rejects unreviewed OCR, and `onOcrBlock` only forwards readings that
contain a template candidate to the review UI. The scan guard is unchanged —
only the extracted single-line token reaches it, so multi-line newlines can
never trip the control-character rejection.

## Template (scanner-core)

- `OcrTemplate` scores normalised tokens for one domain shape; `SkuTemplate`
  accepts segmented codes (`AYROVI-RCV-0099`, `SKU-TEST-001`) and long
  letter+digit runs, rejects quantities (pure digits), short noise (< 4
  chars) and merged garbage (> 40 chars). Never scores 1.0.
- `DirectedOcr.read` processes multi-line blocks line by line, so the SKU
  line wins over header words and quantity lines; below-gate tokens are kept
  as review alternatives. `confirmedByOperator()` is the only path to a
  submittable result.
- `DeviceScanModes`: PHONE and CT40 are both barcode-first with OCR as the
  label-text fallback; on CT40 OCR is an explicit TASK ACTIONS fallback,
  never the default path.

## Native engine (app)

- `com.google.mlkit:text-recognition:16.0.1` (bundled Latin model — no
  runtime download, works offline in the warehouse).
- `TextOcrScanner`: CameraX `ImageAnalysis` + `TextRecognition` client, one
  frame in flight, emits at most one block per ~1.2 s. First reading with a
  candidate fills the review field and stops the camera; the operator still
  reviews and confirms. Same permission/timeout/lifecycle handling as the
  barcode adapter; ImageProxy closed on all paths, recognizer closed on
  dispose.
- Reviewed codes submit as `MANUAL` source through the existing contract —
  no backend, wire-format or database change.

## Presentations

- PHONE: `READ LABEL TEXT` action opens the review panel; `SCAN WITH
  CAMERA` runs the live engine inside it.
- CT40: same panel opened from TASK ACTIONS (`READ LABEL (OCR)`); idle
  screen and side-trigger flow unchanged.

## Evidence / gates

- Unit: `DirectedOcrTest`/`SkuTemplateTest`/`DeviceScanModesTest` in
  scanner-core (template scoring, multi-line extraction, confirm gate,
  device policy). Existing `ScanDecision`/`OcrNormalizer` tests untouched.
- CI: `:scanner-core:test :worker-core:test :app:assembleDebug
  :app:lintDebug :app:assembleDebugAndroidTest` plus the emulator suite.
- NOT performed: physical label-read accuracy trials, low-light/damaged
  label matrix, non-Latin scripts. OCR remains an operator-supervised
  fallback, not a certified hands-free path.
