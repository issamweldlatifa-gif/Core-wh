# 07 · Scanner architecture and device provisioning

## One pipeline

```
physical trigger / camera / manual input
  → Android ScannerService adapter
    → ScanCoordinator → ScannerManager (scanner-core)
      → ScanResult(value, source, symbology)
        → ReceivingWorkflow → server validation / business rule
          → StateFlow → terminal UI + text/icon/tone feedback
```

One scanner decision implementation for all native workflows. In v1.4.1, one foreground capture host stays mounted across Receiving steps; hidden/review/menu states disable capture without creating another scanner engine. Manual entry expands on demand and retains its input preference across steps; source codes remain exact. No API inside scanner; no scanner implemented separately in each new screen. Existing `ScanDecision` is the reuse point. Web scanner remains frozen fallback and is never packaged as JavaScript in Android.

## Capture / state rules

- Raw barcode identity preserves case/punctuation. Trim only framing whitespace; reject empty, embedded controls (except a GS1 separator), or oversized transport input. These checks are not product validation.
- ScannerState: disabled, ready, scanning, captured, invalid, duplicate, cancelled, timeout, unavailable. Unknown/wrong product/location is a **workflow/server** result, not a camera error.
- Reject repeated camera frames/held trigger with a sliding same-code window; don't keep reaccepting a held label every N seconds. Use a monotonic clock. Independent next physical unit uses an explicit next-step/rearm boundary.
- Busy/review/paused/completed/offline/unauthenticated states do not dispatch stock mutations. The workflow also has a synchronous in-flight guard so rapid callbacks cannot queue multiple HTTP writes.
- Successful decode ≠ successful receipt. Feedback says “identified” until backend confirmation. OCR candidates cannot silently replace SKU characters or authorize stock.
- Camera/soft-trigger timeout and cancellation are explicit. A hardware trigger that produces no decode is not evidence of a barcode; offer rescan/manual fallback. No fabricated successful scan.

## Android adapters

### CameraX + bundled ML Kit

Reuse the existing native adapter. Request camera only when worker chooses it. Close ImageProxy on all paths; close ML Kit/executor; ignore delayed callbacks after disposal; unbind only owned use cases. Report unavailable/permission-denied instead of swallowing failure. The camera is optional in the manifest: integrated-scanner devices must not require a rear camera to install.

### Zebra DataWedge

Managed profile associated with package `com.ayrovi.worker` / its Activity. Enable Barcode input and Intent output; use broadcast action **`com.ayrovi.worker.SCAN`**, category `android.intent.category.DEFAULT`. Disable keystroke output for that profile to avoid dual delivery. Data comes from `com.symbol.datawedge.data_string`, symbology from `com.symbol.datawedge.label_type`.

Software trigger goes to package `com.symbol.datawedge`, action `com.symbol.datawedge.api.ACTION`, extra `com.symbol.datawedge.api.SOFT_SCAN_TRIGGER=START_SCANNING` (STOP_SCANNING on stop). Physical trigger is routed by the configured device profile, not guessed Android key codes.

References for integrator verification: [DataWedge Intent Output](https://techdocs.zebra.com/datawedge/latest/guide/output/intent/) and [Soft Scan Trigger](https://techdocs.zebra.com/datawedge/latest/guide/api/softscantrigger/). Profile/version, trigger and intent delivery must be recorded on actual target hardware; code presence is not a hardware pass.

### Honeywell

Reuse `HoneywellScanner` claim/release integration. Receive only configured barcode actions, parse known string extras; no arbitrary intent URI fallback as a trusted code. Pair activation/deactivation with RESUME/PAUSE. Firmwares differ: record CT40/etc. OS/service versions and validate claim/trigger/release on device. Manual/camera remain available.

### Manual / keyboard fallback

Visible native input always routes through the same coordinator with MANUAL source. Camera emits CAMERA; hardware intent emits EXTERNAL_SCANNER. Do not label typed data as hardware. Do not swallow arbitrary system keys in the Activity. HID-wedge-specific native classification/profile is pending hardware verification; explicit manual field is a safe fallback, not claimed HID certification.

## Security

Enterprise scan broadcasts must be exported to receive a vendor service. An exported action is **not authenticated** merely because it has a vendor-looking name. Accept only exact configured actions, bounded types/payloads, foreground enabled workflow; request managed-device allowlisting/secure intent delivery where available. All decoded strings still pass authenticated backend permissions and validation. Never place tokens in intents. Do not claim scanner spoof resistance or device attestation from manufacturer strings.

## Deferred / forbidden

No online receipt replay in scanner, no generic offline queue, no stock mutation from OCR confidence, no app-per-device, no copied vendor UI. Physical hardware result status is **NOT RUN** until report16 is completed by an operator with devices.
