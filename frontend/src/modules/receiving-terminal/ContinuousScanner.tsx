import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarcodeFormat,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import type { ScanSource } from './scan-source';
import { computeRoi, preprocessForOcr } from './roi';
import { CandidateStabiliser, extractCandidates } from './candidates';
import { ocrBusy, recogniseRoi, terminateOcr } from './ocr-client';
import './scanner.css';
import { isBusy, next, stateLabel, type ScannerEvent, type ScannerState } from './scanner-state';

/**
 * Continuous Receiving Scanner (spec §16–§31).
 *
 * Behaviour contract:
 *   - The camera opens once and STAYS OPEN across cartons (§16/§26).
 *   - Detection cascades: barcode/QR first, OCR only as a fallback (§17).
 *   - Both engines read the SAME ROI the worker aligns to (§18).
 *   - OCR runs on-device via Tesseract.js; frames never leave the device (§19).
 *   - A candidate is submitted automatically (§24) but is only ever marked
 *     RECEIVED after the BACKEND accepts it (§25).
 *   - EXIT releases camera, decode loop and the OCR worker (§30).
 */

const ZXING_FORMATS: BarcodeFormat[] = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.CODABAR,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.ITF,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
];
const NATIVE_FORMATS = [
  'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'code_93',
  'code_128', 'itf', 'codabar', 'qr_code', 'data_matrix',
];

/** Same code in view is not resubmitted inside this window (§29). */
const REPEAT_WINDOW_MS = 2500;
/** Pause after an accepted read before decoding resumes. */
const RESUME_DELAY_MS = 900;
/** Frames between OCR attempts — OCR is the expensive fallback path. */
const OCR_EVERY_N_FRAMES = 8;
/** Frames of pure-barcode failure before OCR is allowed to start (§17). */
const OCR_AFTER_FRAMES = 18;

export interface ScanOutcome {
  kind: 'ok' | 'bad' | 'info';
  text: string;
  token: number;
}

export default function ContinuousScanner({
  title,
  hint,
  enableOcr = true,
  outcome = null,
  mode,
  onModeChange,
  onDetected,
  onClose,
}: {
  title: string;
  hint?: string;
  /** Station capability gate: OCR only when the station offers it (§10/§11). */
  enableOcr?: boolean;
  /** Result of the last submission, owned by the parent (backend truth). */
  outcome?: ScanOutcome | null;
  /** What the scanner is submitting: cartons or product units. */
  mode?: 'CARTON' | 'PRODUCT';
  onModeChange?: (m: 'CARTON' | 'PRODUCT') => void;
  onDetected: (value: string, source: ScanSource) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const teardownRef = useRef<() => void>(() => {});

  /**
   * Live reference to the parent's detection callback. The camera loop is a
   * long-lived closure; if it captured `onDetected` directly, every identity
   * change (e.g. switching CARTON→PRODUCT mode in the parent) would re-run
   * the whole camera effect and leave TWO decode loops running — the stale
   * one still routing scans to the previous mode. Reading through a ref keeps
   * ONE loop that always dispatches to the CURRENT handler.
   */
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  /** Which camera to open — a ref so FLIP can restart without re-mounting. */
  const facingRef = useRef<'environment' | 'user'>('environment');

  const [state, setState] = useState<ScannerState>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const [detector, setDetector] = useState<'native' | 'zxing' | null>(null);
  const [ocrActive, setOcrActive] = useState(false);
  const [torch, setTorch] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [scanCount, setScanCount] = useState(0);

  // The state machine is read inside the rAF loop, which must not re-subscribe
  // on every render — keep a ref in lockstep with the rendered state.
  const stateRef = useRef<ScannerState>('IDLE');
  const send = useCallback((event: ScannerEvent): ScannerState | null => {
    const target = next(stateRef.current, event);
    if (!target) return null; // illegal transition: ignored by design (§31)
    stateRef.current = target;
    setState(target);
    return target;
  }, []);

  /** Parent tells us the backend verdict; move SUBMITTING -> SUCCESS/ERROR. */
  useEffect(() => {
    if (!outcome) return;
    if (outcome.kind === 'ok') send('ACCEPTED');
    else if (outcome.kind === 'bad') send('REJECTED');
    // Return to scanning shortly after, keeping the camera open (§26/§27).
    const t = window.setTimeout(() => send('RESUME'), RESUME_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [outcome, send]);

  const start = useCallback(() => {
    teardownRef.current();
    setError(null);
    setTorch(false);
    setHasTorch(false);
    stateRef.current = 'IDLE';
    setState('IDLE');
    send('OPEN');

    const el = videoRef.current;
    if (!el) return;

    let running = true;
    let raf = 0;
    let timer = 0;
    let stream: MediaStream | null = null;
    let nativeDetector: any = null;
    let frame = 0;
    let framesSinceBarcode = 0;
    let lastValue = '';
    let lastAt = 0;

    const full = document.createElement('canvas');
    const fullCtx = full.getContext('2d', { willReadFrequently: true });
    const roiCanvas = document.createElement('canvas');
    const roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });

    const zxing = new MultiFormatReader();
    const hints = new Map();
    hints.set(DecodeHintType.TRY_HARDER, true);
    hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS);
    zxing.setHints(hints);

    const stabiliser = new CandidateStabiliser(3, 12);

    const teardown = () => {
      // Full release (§30): loop, timers, tracks, video element and OCR.
      running = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      if (el) el.srcObject = null;
      stabiliser.reset();
      void terminateOcr();
    };
    teardownRef.current = teardown;

    /** Hand a value to the parent exactly once per physical code (§29). */
    const submit = (value: string, source: ScanSource) => {
      const now = Date.now();
      if (value === lastValue && now - lastAt < REPEAT_WINDOW_MS) {
        lastAt = now;
        return false;
      }
      lastValue = value;
      lastAt = now;
      setLastCode(value);
      setScanCount((n) => n + 1);
      stabiliser.reset();

      // CANDIDATE -> VALIDATE -> SUBMIT. The parent then calls the backend;
      // only its answer can produce SUCCESS (§25).
      send('CANDIDATE');
      send('VALIDATE');
      send('SUBMIT');
      onDetectedRef.current(value, source);
      return true;
    };

    async function readBarcode(vw: number, vh: number): Promise<string | null> {
      if (!fullCtx) return null;
      const roi = computeRoi(vw, vh);
      // Decode the ROI only — same region the worker aligns to (§18).
      if (nativeDetector) {
        try {
          const res = await nativeDetector.detect(roiCanvas);
          if (res?.length && res[0]?.rawValue) return String(res[0].rawValue).trim();
        } catch { /* fall through */ }
        return null;
      }
      try {
        const img = roiCtx!.getImageData(0, 0, roi.width, roi.height);
        const lum = new Uint8ClampedArray(roi.width * roi.height);
        for (let i = 0; i < lum.length; i += 1) {
          const p = i * 4;
          lum[i] = (img.data[p] * 0.299 + img.data[p + 1] * 0.587 + img.data[p + 2] * 0.114) | 0;
        }
        const src = new RGBLuminanceSource(lum, roi.width, roi.height);
        const r = zxing.decode(new HybridBinarizer(src) as any);
        return r?.getText?.().trim() || null;
      } catch {
        return null;
      }
    }

    async function tick() {
      if (!running) return;
      const s = stateRef.current;

      // Never decode while a submission is in flight or after a verdict is
      // being displayed — that is what previously caused double submits.
      if (isBusy(s) || s === 'SUCCESS' || s === 'ERROR') {
        raf = requestAnimationFrame(tick);
        return;
      }

      const vw = el!.videoWidth;
      const vh = el!.videoHeight;
      if (vw && vh && fullCtx && roiCtx) {
        frame += 1;
        full.width = vw;
        full.height = vh;
        fullCtx.drawImage(el!, 0, 0, vw, vh);

        const roi = computeRoi(vw, vh);
        roiCanvas.width = roi.width;
        roiCanvas.height = roi.height;
        roiCtx.drawImage(full, roi.x, roi.y, roi.width, roi.height, 0, 0, roi.width, roi.height);

        // ---- PRIORITY 1: barcode / QR (§17) ----
        send('BARCODE_SCAN');
        const code = await readBarcode(vw, vh);

        if (code) {
          framesSinceBarcode = 0;
          if (submit(code, 'CAMERA')) {
            // Continuous scanning (§16): the loop must survive every success.
            // Without this rAF the scanner would show the verdict chip and
            // silently stop decoding until it was fully reopened.
            raf = requestAnimationFrame(tick);
            return;
          }
          send('RESUME');
        } else {
          framesSinceBarcode += 1;
          send('RESUME');

          // ---- PRIORITY 2: OCR fallback, only after barcode keeps failing ----
          const shouldOcr =
            enableOcr &&
            framesSinceBarcode >= OCR_AFTER_FRAMES &&
            frame % OCR_EVERY_N_FRAMES === 0 &&
            !ocrBusy();

          if (shouldOcr) {
            send('OCR_SCAN');
            setOcrActive(true);
            try {
              const prepared = preprocessForOcr(roiCtx.getImageData(0, 0, roi.width, roi.height));
              roiCtx.putImageData(prepared, 0, 0);
              const res = await recogniseRoi(roiCanvas);
              if (res && res.confidence > 45) {
                // Multi-frame stabilisation: a single weak read is never
                // trusted (§23).
                const stable = stabiliser.push(extractCandidates(res.text));
                if (stable && submit(stable, 'CAMERA')) {
                  // Same §16 rule as the barcode path: keep the loop alive.
                  raf = requestAnimationFrame(tick);
                  return;
                }
              }
            } finally {
              setOcrActive(false);
              if (stateRef.current === 'OCR_PROCESSING') send('RESUME');
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }

    async function begin() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera is not supported on this device. Use an external scanner or manual entry.');
        send('CAMERA_FAILED');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: facingRef.current }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        const track = stream.getVideoTracks()[0];
        const caps: any = track?.getCapabilities ? track.getCapabilities() : {};
        if (caps?.torch === true) setHasTorch(true);
        el!.srcObject = stream;
        try {
          await el!.play();
        } catch (playErr: any) {
          // Chrome aborts play() when the srcObject assignment races the play
          // pipeline (canvas streams, some Android devices). The element
          // usually still plays — verify instead of failing the whole camera.
          const soft = /abort|interrupt/i.test(String(playErr?.name ?? '') + String(playErr?.message ?? ''));
          if (!soft) throw playErr;
          await new Promise<void>((resolve) => {
            if (el!.readyState >= 2) return resolve();
            const ok = () => resolve();
            el!.addEventListener('playing', ok, { once: true });
            window.setTimeout(ok, 1500);
          });
        }

        const B = (window as any).BarcodeDetector;
        if (B) {
          try {
            const formats = typeof B.getSupportedFormats === 'function'
              ? await B.getSupportedFormats()
              : NATIVE_FORMATS;
            nativeDetector = formats?.length ? new B({ formats }) : null;
          } catch { nativeDetector = null; }
        }
        setDetector(nativeDetector ? 'native' : 'zxing');
        send('CAMERA_READY');
        raf = requestAnimationFrame(tick);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/NotAllowed|Permission|denied/i.test(msg)) {
          setError('Camera permission denied. Allow access, or use an external scanner / manual entry.');
        } else if (/NotFound|Requested device|Overconstrained/i.test(msg)) {
          setError('No usable camera found. Use an external scanner or manual entry.');
        } else {
          setError('Could not start the camera. Use an external scanner or manual entry.');
        }
        send('CAMERA_FAILED');
      }
    }

    void begin();
  }, [enableOcr, send]);

  useEffect(() => {
    start();
    return () => {
      teardownRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exit = useCallback(() => {
    send('EXIT');
    teardownRef.current();
    send('CLOSED');
    onClose();
  }, [onClose, send]);

  const toggleTorch = useCallback(async () => {
    const el = videoRef.current;
    const track = (el?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
    if (!track || !hasTorch) return;
    const nextTorch = !torch;
    try {
      await track.applyConstraints({ advanced: [{ torch: nextTorch }] as any });
      setTorch(nextTorch);
    } catch { /* unsupported at runtime */ }
  }, [hasTorch, torch]);

  /** FLIP (§12): restart the stream on the other camera without leaving the
   *  scanner work mode. The teardown/bring-up pair is the same one the mount
   *  effect uses, so camera state stays consistent. */
  const flipCamera = useCallback(() => {
    facingRef.current = facingRef.current === 'environment' ? 'user' : 'environment';
    setTorch(false);
    setHasTorch(false);
    teardownRef.current();
    start();
  }, [start]);

  const banner =
    state === 'SUCCESS' ? 'ok' : state === 'ERROR' ? 'bad' : null;

  return (
    <div className="cs-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="cs-frame">
        <header className="cs-head">
          <div className="cs-title">
            <span className="cs-dot" data-state={state} />
            {title}
          </div>
          <div className="cs-head-meta">
            {mode && onModeChange && (
              <div className="cs-modes" role="tablist" aria-label="Scan mode">
                {(['CARTON', 'PRODUCT'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={mode === m}
                    className={`cs-mode${mode === m ? ' is-active' : ''}`}
                    onClick={() => onModeChange(m)}
                  >
                    {m === 'CARTON' ? 'CARTONS' : 'PRODUCTS'}
                  </button>
                ))}
              </div>
            )}
            <span className="os-tag os-tag--muted">{scanCount} scanned</span>
            <button type="button" className="os-btn os-btn--danger" onClick={exit}>
              EXIT
            </button>
          </div>
        </header>

        <div className="cs-stage">
          <video ref={videoRef} className="cs-video" muted playsInline />

          {/* ROI the worker aligns the label into (§18) */}
          <div className="cs-roi" aria-hidden="true">
            <span className="cs-corner tl" />
            <span className="cs-corner tr" />
            <span className="cs-corner bl" />
            <span className="cs-corner br" />
            <div className="cs-roi-hint">
              {mode === 'PRODUCT' ? 'ALIGN SKU / PRODUCT LABEL' : 'ALIGN CARTON LABEL'}
            </div>
          </div>

          {/* Live operational state (§5/§31) */}
          <div className="cs-status" data-state={state}>
            {stateLabel(state)}
            {ocrActive && <span className="cs-sub"> · OCR</span>}
            {detector && !ocrActive && <span className="cs-sub"> · {detector === 'native' ? 'FAST' : 'ZXING'}</span>}
          </div>

          {lastCode && (
            <div className="cs-lastcode os-mono">{lastCode}</div>
          )}

          {/* Backend verdict, shown without closing the scanner (§26/§27) */}
          {outcome && banner && (
            <div key={outcome.token} className={`cs-result cs-result--${outcome.kind}`}>
              <strong>{outcome.kind === 'ok' ? '✓ RECEIVED' : '✕ NOT ACCEPTED'}</strong>
              <span>{outcome.text}</span>
            </div>
          )}

          {error && (
            <div className="cs-result cs-result--bad">
              <strong>✕ CAMERA</strong>
              <span>{error}</span>
              <button type="button" className="os-btn" onClick={start}>RETRY</button>
            </div>
          )}
        </div>

        <footer className="cs-foot">
          <div className="cs-foot-hint">
            {hint ?? 'Scanner stays open — keep passing cartons. Barcode/QR first, text (OCR) as fallback.'}
          </div>
          <div className="os-row">
            <button
              type="button"
              className="os-btn"
              disabled={!hasTorch || !!error}
              onClick={toggleTorch}
            >
              {torch ? 'TORCH ON' : 'TORCH'}
            </button>
            <button type="button" className="os-btn" disabled={!!error} onClick={flipCamera}>
              FLIP CAMERA
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
