import { BrowserMultiFormatReader } from '@zxing/browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanSource } from './scan-source';

/**
 * Camera scanner — always offers a live camera tool to scan a barcode/QR.
 *
 * Uses ZXing (cross-browser decode) with getUserMedia, so it works on Chrome,
 * Edge, Firefox, Safari, Android, iOS… independent of the native
 * `BarcodeDetector` API. The live camera feed is decoded continuously.
 *
 * Permission is requested ONLY when this overlay is opened. If the camera is
 * unavailable (no device, denied permission, sandboxed iframe without
 * camera access) it degrades to a clear message so the worker uses the
 * external scanner or manual entry — the workflow never blocks.
 */
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
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const stopRef = useRef<() => void>(() => {});
  const lastValueRef = useRef<string>('');

  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const stop = useCallback(() => {
    stopRef.current();
    stopRef.current = () => {};
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera is not supported on this device/browser. Use an external scanner or manual entry.');
        return;
      }
      try {
        const reader = new BrowserMultiFormatReader();
        readerRef.current = reader;
        const controls = await reader.decodeFromVideoDevice(
          undefined, // default camera (usually rear/environment)
          videoRef.current!,
          (result) => {
            const value = result?.getText?.().trim?.();
            if (value && value !== lastValueRef.current) {
              lastValueRef.current = value;
              stop();
              onDetected(value, 'CAMERA');
            }
          },
        );
        stopRef.current = controls.stop;
        if (cancelled) { controls.stop(); return; }
        setReady(true);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/NotAllowed|Permission|denied/i.test(msg)) {
          setError('Camera permission was denied. Allow camera access, or use an external scanner / manual entry.');
        } else if (/NotFound|no camera|Requested device/i.test(msg)) {
          setError('No camera found on this device. Use an external scanner or manual entry.');
        } else {
          setError('Could not start the camera. Use an external scanner or manual entry.');
        }
      }
    }
    start();
    return () => { cancelled = true; stop(); };
  }, [stop, onDetected]);

  return (
    <div className="term-modal" role="dialog" aria-modal="true">
      <div className="term-modal-inner">
        <div className="term-modal-head">
          <span className="prompt">&gt; {title}</span>
          <button className="term-btn" onClick={onClose}>✕ close</button>
        </div>
        <div className="term-cam-stage">
          <video ref={videoRef} className="term-cam-video" muted playsInline />
          <div className="term-cam-reticle" />
          {!ready && !error && <div className="term-cam-note">initialising camera…</div>}
          {ready && <div className="term-cam-note term-cam-note--ok">[ SCANNING ] point the label at the camera</div>}
          {error && <div className="term-cam-note term-cam-note--err">{error}</div>}
        </div>
        <div className="term-modal-foot">
          press <span className="kbd">enter</span> with an external scanner, or type to fall back to manual entry.
        </div>
      </div>
    </div>
  );
}
