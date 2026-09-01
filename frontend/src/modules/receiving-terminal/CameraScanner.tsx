import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarcodeFormat,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import type { ScanSource } from './scan-source';

/**
 * Camera scanner — live camera tool to read a barcode/QR.
 *
 * Decode strategy (reliability-first):
 *   1. Native `BarcodeDetector` when present (Chrome/Edge/Android, iOS 17+,
 *      Samsung Internet). It is tuned for real-world 1D codes (Code128/39/EAN)
 *      and is far more robust + faster than a JS decoder — critical for the
 *      thin, low-contrast bars typical of product pouch labels.
 *   2. ZXing (`@zxing/library`) fallback for browsers without BarcodeDetector,
 *      run over every video frame with TRY_HARDER + explicit formats.
 *
 * Both engines run a continuous requestAnimationFrame loop that draws each
 * video frame to a canvas and decodes it. Capture is requested at high
 * resolution (ideal 1920x1080) and, where available, we offer torch + a rear
 * camera toggle so thin / reflective labels can be lit and focused.
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
const DEFAULT_NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'code_93', 'code_128', 'itf', 'codabar', 'qr_code', 'data_matrix'];

export default function CameraScanner({
  title,
  onDetected,
  onClose,
}: {
  title: string;
  onDetected: (value: string, source: ScanSource) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopAllRef = useRef<() => void>(() => {});

  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'init' | 'scanning' | 'reading' | 'off'>('init');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [torch, setTorch] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);

  const stopAll = useCallback(() => {
    stopAllRef.current();
  }, []);

  const start = useCallback((facingMode: 'environment' | 'user') => {
    // stop any previously-opened stream before re-opening (camera flip / retry)
    stopAllRef.current();
    setFacing(facingMode);
    setError(null);
    setTorch(false);
    setHasTorch(false);
    setStatus('init');

    const el = videoRef.current;
    if (!el) return;
    let nativeDetector: any = null;

    let running = true;
    let raf = 0;
    let stream: MediaStream | null = null;
    let track: MediaStreamTrack | null = null;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const zxing = new MultiFormatReader();
    const hints = new Map();
    hints.set(DecodeHintType.TRY_HARDER, true);
    hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS);
    zxing.setHints(hints);

    let lastValue = '';
    let lastAt = 0;

    const cleanup = () => {
      running = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    stopAllRef.current = cleanup;

    async function tick() {
      if (!running) return;
      const vw = el!.videoWidth, vh = el!.videoHeight;
      if (vw && vh && ctx) {
        canvas.width = vw;
        canvas.height = vh;
        ctx.drawImage(el!, 0, 0, vw, vh);
        let value: string | null = null;
        if (nativeDetector) {
          // Native detector — accepts the canvas directly.
          try {
            const res = await nativeDetector.detect(canvas);
            if (res && res.length && res[0]?.rawValue) value = String(res[0].rawValue).trim();
          } catch { value = null; }
        } else {
          // ZXing fallback
          try {
            const frame = ctx.getImageData(0, 0, vw, vh);
            const data = frame.data;
            const lum = new Uint8ClampedArray(vw * vh);
            for (let i = 0; i < vw * vh; i++) {
              lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
            }
            const src = new RGBLuminanceSource(lum, vw, vh);
            const r = zxing.decode(new HybridBinarizer(src) as any);
            value = r?.getText?.().trim() || null;
          } catch { value = null; }
        }
        if (value) {
          const now = Date.now();
          if (value === lastValue && now - lastAt < 1600) {
            // same code already read recently — re-scan for a fresh one
            raf = requestAnimationFrame(tick);
            return;
          }
          lastValue = value;
          lastAt = now;
          setStatus('reading');
          cleanup();
          onDetected(value, 'CAMERA');
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    }

    async function begin() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera is not supported on this device/browser. Use an external scanner or manual entry.');
        setStatus('off');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        track = stream.getVideoTracks()[0];
        const caps: any = track.getCapabilities ? track.getCapabilities() : {};
        if (caps?.torch === true) setHasTorch(true);
        el!.srcObject = stream;
        await el!.play();

        // Build the decode engine exactly once: native BarcodeDetector if
        // present (and formats probeable), else the ZXing fallback.
        const B = (window as any).BarcodeDetector;
        if (B) {
          try {
            const formats = typeof B.getSupportedFormats === 'function' ? await B.getSupportedFormats() : DEFAULT_NATIVE_FORMATS;
            nativeDetector = formats?.length ? new B({ formats }) : null;
          } catch { nativeDetector = null; }
        }
        setStatus('scanning');
        raf = requestAnimationFrame(tick);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/NotAllowed|Permission|denied/i.test(msg)) setError('Camera permission was denied. Allow camera access, or use an external scanner / manual entry.');
        else if (/NotFound|no camera|Requested device|Overconstrained/i.test(msg)) setError('No usable camera found on this device. Use an external scanner or manual entry.');
        else setError('Could not start the camera. Use an external scanner or manual entry.');
        setStatus('off');
      }
    }
    begin();
    return cleanup;
  }, [onDetected]);

  useEffect(() => {
    start(facing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTorch = useCallback(async () => {
    const el = videoRef.current;
    if (!el || !el.srcObject) return;
    const track = (el.srcObject as MediaStream).getVideoTracks()[0];
    if (!track || !hasTorch) return;
    const next = !torch;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] as any });
      setTorch(next);
    } catch { /* unsupported at runtime — ignore */ }
  }, [hasTorch, torch]);

  const toggleFacing = useCallback(() => {
    start(facing === 'environment' ? 'user' : 'environment');
  }, [facing, start]);

  return (
    <div className="term-modal" role="dialog" aria-modal="true">
      <div className="term-modal-inner">
        <div className="term-modal-head">
          <span className="prompt">&gt; {title}</span>
          <button className="term-btn" onClick={() => { stopAll(); onClose(); }}>✕ close</button>
        </div>
        <div className="term-cam-stage">
          <video ref={videoRef} className="term-cam-video" muted playsInline />
          <div className="term-cam-reticle" />
          {status === 'init' && <div className="term-cam-note">initialising camera…</div>}
          {status === 'scanning' && <div className="term-cam-note term-cam-note--ok">[ SCANNING ] fill the frame with the label, hold steady</div>}
          {status === 'reading' && <div className="term-cam-note term-cam-note--ok">[ OK ] code read</div>}
          {error && <div className="term-cam-note term-cam-note--err">{error}</div>}
          <div className="term-cam-ctrl">
            <button type="button" className="term-btn term-btn--cam" disabled={!hasTorch || error != null} onClick={toggleTorch}>
              {torch ? 'torch on' : 'torch off'}
            </button>
            <button type="button" className="term-btn term-btn--cam" disabled={error != null} onClick={toggleFacing}>
              flip camera
            </button>
          </div>
        </div>
        <div className="term-modal-foot">hold the code flat, close to the camera, in good light — reads automatically once recognised. for stubborn labels tap <span className="kbd">torch</span>.</div>
      </div>
    </div>
  );
}
