/**
 * Receiving terminal — scan input / device support layer.
 *
 * The receiving workflow must be IDENTICAL regardless of the input device.
 * This module only classifies WHERE a captured value came from:
 *
 *   CAMERA            — built-in / attached camera scan
 *   EXTERNAL_SCANNER  — Bluetooth / USB / keyboard-wedge scanner
 *   MANUAL            — typed or picked manually
 *
 * The backend receives the same operational event for all three. This layer
 * is intentionally lightweight (a support layer, not a hard requirement):
 * camera scanning is progressive (native BarcodeDetector + getUserMedia) and
 * degrades gracefully to external scanner or manual entry when unavailable.
 */

export type ScanSource = 'CAMERA' | 'EXTERNAL_SCANNER' | 'MANUAL';
export type ScanCodeType = 'QR' | 'BARCODE' | 'MANUAL';

export interface DeviceCapabilities {
  deviceType: 'SMARTPHONE' | 'TABLET' | 'DESKTOP' | 'UNKNOWN';
  touch: boolean;
  /** Can we open a live camera feed (getUserMedia)? */
  getUserMedia: boolean;
  /** Can we decode barcodes in-browser (native BarcodeDetector)? */
  barcodeDetector: boolean;
  /** True if the camera tool can be offered (getUserMedia only — ZXing handles decode). */
  cameraScanningSupported: boolean;
  canDetectExternalScanner: boolean;
  userAgent: string;
  screenWidthPx: number;
  online: boolean;
}

export const EXPLICIT_SOURCES: ScanSource[] = ['CAMERA', 'EXTERNAL_SCANNER', 'MANUAL'];

const KNOWN_DETECTOR_EXCEPTIONS = new Set<string>([
  'Chrome', 'Chromium', 'Google Chrome', 'Microsoft Edge', 'Opera',
  'Samsung Internet', 'Android Browser', 'Firefox 105+ (WebExtension)',
]);

/** Detect device + scanning capabilities for the current browser/terminal. */
export function detectCapabilities(): DeviceCapabilities {
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator);
  const ua = nav.userAgent ?? '';
  const touch = 'ontouchstart' in (typeof window !== 'undefined' ? window : {})
    || (nav.maxTouchPoints ?? 0) > 0;
  const width = typeof window !== 'undefined' ? window.innerWidth : 1024;

  let deviceType: DeviceCapabilities['deviceType'] = 'UNKNOWN';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (touch && width >= 700)) deviceType = 'TABLET';
  else if (touch && width < 700) deviceType = 'SMARTPHONE';
  else if (/Mobile|iPhone|Android/i.test(ua)) deviceType = 'SMARTPHONE';
  else deviceType = 'DESKTOP';

  const hasGetUserMedia =
    typeof nav !== 'undefined' && !!(nav.mediaDevices && nav.mediaDevices.getUserMedia);

  // `BarcodeDetector` is not in all TypeScript DOM typings; probe safely.
  const hasBarcodeDetector =
    typeof window !== 'undefined' && 'BarcodeDetector' in window
    && typeof (window as any).BarcodeDetector === 'function';

  return {
    deviceType,
    touch,
    getUserMedia: hasGetUserMedia,
    barcodeDetector: hasBarcodeDetector,
    // The camera tool only needs getUserMedia; ZXing performs the decode
    // (cross-browser), so we do NOT require native BarcodeDetector.
    cameraScanningSupported: hasGetUserMedia,
    canDetectExternalScanner: true,
    userAgent: ua,
    screenWidthPx: width,
    online: typeof nav !== 'undefined' ? nav.onLine : true,
  };
}

/** Human label for a scan source. */
export function sourceLabel(s: ScanSource): string {
  return s === 'CAMERA' ? 'Camera' : s === 'EXTERNAL_SCANNER' ? 'External scanner' : 'Manual';
}

/**
 * Classify a completed keyboard entry (the buffer captured before Enter) as
 * an external-scanner wedge read or manual typing. Keyboard-wedge scanners
 * emit a very fast burst of characters followed by Enter; humans type slowly.
 */
export function classifyKeyboardEntry(
  charStamps: number[],
  value: string,
): { source: ScanSource; latency: number } {
  if (charStamps.length >= 4 && value.length >= 4) {
    const first = charStamps[0];
    const last = charStamps[charStamps.length - 1];
    const span = last - first; // ms across the burst
    const avg = span / Math.max(1, charStamps.length - 1);
    // Fast, sub-40ms per char => almost certainly a wedge scanner.
    if (avg < 40) return { source: 'EXTERNAL_SCANNER', latency: span };
  }
  return { source: 'MANUAL', latency: 0 };
}

/** Generate a unique client operation id for network-retry idempotency. */
export function freshOperationId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
