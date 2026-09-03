/**
 * Receiving terminal — scan-method selection (dual-scanner order §1/§15).
 *
 * Pure device-mode policy. The Receiving station presents exactly what this
 * module computes; nothing is hard-coded in the UI:
 *
 *   Desktop        → Hardware Scan is PRIMARY (never opens the computer camera
 *                    by default). Software Scan may still be chosen explicitly.
 *   Smartphone     → Software Scan is PRIMARY. Hardware Scan is offered too
 *                    (USB/BT-wedge phones exist).
 *   Tablet         → both offered; Software first.
 *
 * Availability is capability-based (scan-source §9): software requires
 * getUserMedia; hardware requires a usable input path (keyboard-wedge capture
 * is universal; WebBluetooth/WebUSB are extra, device-gated).
 */

import type { DeviceCapabilities } from './scan-source';

export type ScanMethod = 'software' | 'hardware';
export type DeviceClass = 'DESKTOP' | 'SMARTPHONE' | 'TABLET' | 'UNKNOWN';

export interface ScanMethodChoice {
  available: ScanMethod[];
  /** Method pre-selected when the scanner opens (default). */
  default: ScanMethod;
  /** Display order for the UI (first = emphasised). */
  ordered: ScanMethod[];
}

export const SCAN_METHOD_LABEL: Record<ScanMethod, string> = {
  software: 'Software Scan',
  hardware: 'Hardware Scan',
};

/** Human capability label for telemetry / diagnostics. */
export const PROVIDER_LABEL: Record<string, string> = {
  'software-camera': 'SoftwareScannerProvider',
  'demo-camera': 'DemoScannerProvider',
  hid: 'USBScannerProvider (HID wedge)',
  bluetooth: 'BluetoothScannerProvider',
  usb: 'USBScannerProvider (WebUSB)',
  industrial: 'IndustrialScannerProvider (future)',
  manual: 'ManualEntry',
};

interface CapSlice {
  deviceType?: DeviceCapabilities['deviceType'];
  getUserMedia?: boolean;
  cameraScanningSupported?: boolean;
  canDetectExternalScanner?: boolean;
}

/**
 * Pick which scan methods a device may use + which to default to.
 * Pure — no DOM, unit-tested with fixture capability objects.
 */
export function chooseScanMethods(caps: CapSlice): ScanMethodChoice {
  const softwareUsable = Boolean(caps.getUserMedia && caps.cameraScanningSupported);
  const hardwareUsable = caps.canDetectExternalScanner !== false;
  const cls = caps.deviceType ?? 'UNKNOWN';

  const both: ScanMethod[] = [];
  if (softwareUsable) both.push('software');
  if (hardwareUsable) both.push('hardware');

  if (cls === 'DESKTOP') {
    // §1/§15: Hardware primary on desktop — never open the webcam implicitly.
    const ordered: ScanMethod[] = both.includes('hardware')
      ? ['hardware', ...both.filter((m) => m !== 'hardware')]
      : both;
    const fallback: ScanMethod = both.includes('hardware') ? 'hardware' : 'software';
    return { available: both, default: both.length ? fallback : 'hardware', ordered };
  }

  // Smartphone / Tablet / UNKNOWN → software first when usable.
  const ordered: ScanMethod[] = both.includes('software')
    ? ['software', ...both.filter((m) => m !== 'software')]
    : both;
  const defaultMethod: ScanMethod = both.includes('software') ? 'software'
    : both.includes('hardware') ? 'hardware'
    : 'software';
  return { available: both, default: defaultMethod, ordered };
}

/** Quick classification of the current browser into a friendly device class. */
export function deviceClassOf(caps: Pick<DeviceCapabilities, 'deviceType'>): DeviceClass {
  const d = caps.deviceType;
  if (d === 'SMARTPHONE' || d === 'TABLET' || d === 'DESKTOP') return d;
  return 'UNKNOWN';
}
