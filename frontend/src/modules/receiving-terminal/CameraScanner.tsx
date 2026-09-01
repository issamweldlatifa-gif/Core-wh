import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '../../api/client';
import type { ScanSource } from './scan-source';

/**
 * Camera scanner overlay.
 *
 * Uses the native `BarcodeDetector` API (Chromium/Android/Edge) with a live
 * getUserMedia feed to decode a barcode/QR in-browser with no extra library.
 * When the detector is unavailable this overlay still shows the live camera
 * view but reports that decode is unsupported on this browser, so the worker
 * falls back to an external scanner or manual entry — the workflow never
 * blocks on camera support.
 *
 * Camera permission is requested ONLY when this overlay is opened.
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
  const detectorRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTextRef = useRef<string>('');

  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [decoding, setDecoding] = useState(false);

  const stop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const detectLoop = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !detectorRef.current) return;
    try {
      if (video.readyState >= 2 && decoderSupported()) {
        setDecoding(true);
        const codes = await detectorRef.current.detect(video);
        for (const code of codes) {
          const value = code?.rawValue?.trim?.();
          if (value && value !== lastTextRef.current) {
            lastTextRef.current = value;
            stop();
            onDetected(value, 'CAMERA');
            return;
          }
        }
      }
    } catch {
      // keep looping; a transient frame error should not kill the scan.
    } finally {
      if (streamRef.current) {
        rafRef.current = requestAnimationFrame(() => detectLoop());
      }
    }
  }, [stop, onDetected]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (!decoderSupported()) {
        setError('In-browser barcode decoding is not supported in this browser. Use an external scanner or manual entry.');
        return;
      }
      // 1280x720 environmental camera by default, fall back gracefully.
      const constraints: MediaStreamConstraints = {
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      };
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        try {
          detectorRef.current = new (window as any).BarcodeDetector({
            formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'data_matrix'],
          });
        } catch {
          detectorRef.current = new (window as any).BarcodeDetector();
        }
        setReady(true);
        rafRef.current = requestAnimationFrame(() => detectLoop());
      } catch (e) {
        setError(apiErrorMessage(e) || 'Could not open the camera.');
      }
    }
    start();
    return () => {
      cancelled = true;
      stop();
    };
  }, [stop, detectLoop]);

  return (
    <div className="cam-overlay" role="dialog" aria-modal="true">
      <div className="cam-panel">
        <div className="cam-head">
          <strong>{title}</strong>
          <button className="rcv-btn rcv-btn--ghost" onClick={onClose}>✕ Close</button>
        </div>
        <div className="cam-stage">
          <video ref={videoRef} className="cam-video" muted playsInline />
          <div className="cam-reticle" />
          {!ready && !error && <div className="cam-note">Starting camera…</div>}
          {ready && <div className="cam-note cam-note--ok">Point the label at the camera</div>}
          {decoding && <div className="cam-note cam-note--ok">Scanning…</div>}
          {error && <div className="cam-note cam-note--err">{error}</div>}
        </div>
        <div className="cam-foot">
          Press <kbd>Enter</kbd> on an external scanner or type manually to fall back.
        </div>
      </div>
    </div>
  );
}

function decoderSupported(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}
