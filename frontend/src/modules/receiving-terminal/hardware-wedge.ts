/**
 * Receiving terminal — hardware scanner input layer (dual-scanner order §5/§6).
 *
 * USB / Bluetooth barcode scanners overwhelmingly enumerate as KEYBOARD-HID
 * (keyboard-wedge): they type the code in a fast burst and press Enter/Tab.
 * Capturing that burst at the window level is the hardware-agnostic path that
 * requires no camera, no browser permission and no business-logic change.
 *
 *   HardwareScannerInput (this file)
 *     ├─ USB-HID wedge capture  → works with the great majority of USB scanners
 *     ├─ WebBluetooth (extra)   → BLE scanners exposing the standard barcode
 *     │                           service 0xFFE0/0xFFE5 (+ notify 0xFFE1) — opt-in
 *     └─ WebUSB (extra)         → vendor-specific custom-protocol scanners
 *                                 (profile hooks for future Industrial providers)
 *
 * Everything here is capture-only: the read is handed up as a string and the
 * Receiving station routes it through the SAME normalise → validate → submit
 * pipeline as a camera/OCR read (§7). No duplicate receiving logic lives here.
 */

import { classifyKeyboardEntry, type ScanSource } from './scan-source';

// ---------------------------------------------------------------------------
// 1) Pure keyboard-wedge parser (no DOM — unit-tested)
// ---------------------------------------------------------------------------

export interface WedgeKeyLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  /** time in ms when the key went down */
  at?: number;
}

export interface WedgeOptions {
  /** keys that terminate a code (default Enter; Tab for some models). */
  terminatorKeys?: string[];
  /** ignore lone function keys / IME etc. */
  ignoreKeys?: string[];
  /** max code length before we force-flush (safety net). */
  maxLength?: number;
}

export const DEFAULT_TERMINATORS = ['Enter'];
const MODIFIER_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock',
  'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

export interface WedgeEvent {
  /** completed code (uppercased, trimmed) */
  value: string;
  source: ScanSource;
  /** elapsed ms across the character burst */
  burstMs: number;
  terminated: boolean;
  at: number;
}

export class WedgeParser {
  private buf: string[] = [];
  private stamps: number[] = [];
  private opts: Required<WedgeOptions>;

  constructor(opts: WedgeOptions = {}) {
    this.opts = {
      terminatorKeys: opts.terminatorKeys ?? DEFAULT_TERMINATORS,
      ignoreKeys: opts.ignoreKeys ?? [],
      maxLength: opts.maxLength ?? 64,
    };
  }

  /** Feed one keydown; returns a completed WedgeEvent or null. */
  push(k: WedgeKeyLike): WedgeEvent | null {
    if (k.repeat) return null;
    if (k.ctrlKey || k.altKey || k.metaKey) return null;
    const key = k.key ?? '';
    const at = k.at ?? Date.now();

    if (this.opts.terminatorKeys.includes(key)) {
      // Deliver the buffer, then suppress the terminator itself.
      return this.flush(at, true);
    }
    if (key.length === 1 || key === ' ') {
      // printable character (incl. space for code 128 FNC style separators)
      if (this.opts.ignoreKeys.includes(key)) return null;
      if (this.buf.length < this.opts.maxLength) {
        this.buf.push(key);
        this.stamps.push(at);
      }
      return null;
    }
    // Any other key (modifier, function, dead key) is ignored — never corrupts.
    if (!MODIFIER_KEYS.has(key)) {
      // Unknown single multi-byte keys — ignore quietly.
      return null;
    }
    return null;
  }

  /** Force out whatever is buffered (e.g. scanner switched, panel closed). */
  flush(now: number, terminated = false): WedgeEvent | null {
    const value = this.buf.join('').toUpperCase().trim();
    const stamps = this.stamps;
    const burstMs = stamps.length >= 2 ? stamps[stamps.length - 1] - stamps[0] : 0;
    this.buf = [];
    this.stamps = [];
    if (value.length < 1) return null;
    const source = classifyKeyboardEntry(stamps, value).source;
    return { value, source, burstMs, terminated, at: now };
  }

  get pending(): string {
    return this.buf.join('');
  }
}

// ---------------------------------------------------------------------------
// 2) Window-level HID capture (DOM only)
// ---------------------------------------------------------------------------

export interface HidScannerCallbacks {
  onRead: (e: WedgeEvent) => void;
}
export type DetachFn = () => void;

/**
 * Attach a keyboard-wedge listener. Returns a detach function. `active` can be
 * toggled without detaching (cheap). Ignores typing inside inputs/textareas so
 * manual entry fields never double-fire.
 */
export function attachHidScanner(
  cb: HidScannerCallbacks,
  opts: WedgeOptions = {},
): DetachFn {
  const parser = new WedgeParser(opts);
  const onKeyDown = (ev: KeyboardEvent) => {
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }
    const done = parser.push({
      key: ev.key,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
      repeat: ev.repeat,
      at: performance.now(),
    });
    if (done) {
      // Consume Enter so the wedge never "clicks" a focused button.
      ev.preventDefault();
      cb.onRead(done);
    }
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
  return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
}

// ---------------------------------------------------------------------------
// 3) Capability probes (pure, no devices touched)
// ---------------------------------------------------------------------------

export interface HardwareCapabilities {
  hidWedge: boolean; // window key capture — universal
  bluetooth: boolean; // Web Bluetooth API present
  webUsb: boolean; // WebUSB API present
}

export function detectHardwareCapabilities(): HardwareCapabilities {
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator);
  return {
    hidWedge: typeof window !== 'undefined',
    bluetooth: 'bluetooth' in nav,
    webUsb: 'usb' in nav,
  };
}

export interface BleScannerCallbacks {
  onValue: (value: string) => void;
}

const BLE_SERVICES: number[] = [0xffe0, 0xffe5];
const BLE_CHARS: number[] = [0xffe1, 0xffe2];

/**
 * Best-effort Bluetooth scanner connection for devices that expose the common
 * serial-over-BLE barcode service (0xFFE0/0xFFE5 + notify char). Resolves to a
 * { disconnect } handle once notifications are flowing. Rejects with a typed
 * message when Web Bluetooth is missing, pairing is cancelled, or no standard
 * barcode service is found.
 *
 * Not exercised on hardware here (no BLE device in this environment) — the
 * provider seam + capability gate are delivered; device acceptance remains a
 * manual step.
 */
export async function connectBleScanner(cb: BleScannerCallbacks): Promise<{ disconnect: () => void }> {
  const nav = navigator as any;
  if (!nav?.bluetooth?.requestDevice) {
    throw new Error('bluetooth-unsupported');
  }
  const device = await nav.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: BLE_SERVICES.map((s) => s.toString(16).padStart(4, '0')),
  });
  const server = await device.gatt.connect();
  let char: any = null;
  for (const svcId of BLE_SERVICES) {
    try {
      const svc = await server.getPrimaryService(svcId);
      for (const chId of BLE_CHARS) {
        try {
          const c = await svc.getCharacteristic(chId);
          if (c.properties.notify) { char = c; break; }
        } catch { /* next char */ }
      }
      if (char) break;
    } catch { /* next service */ }
  }
  if (!char) {
    try { server.disconnect(); } catch { /* ignore */ }
    throw new Error('bluetooth-no-barcode-service');
  }
  const parser = new WedgeParser();
  await char.startNotifications();
  char.addEventListener('characteristicvaluechanged', (ev: any) => {
    const raw = String.fromCharCode.apply(null, Array.from(new Uint8Array(ev.target.value.buffer)));
    for (const ch of raw) {
      const done = parser.push({ key: ch === '\r' || ch === '\n' ? 'Enter' : ch, at: Date.now() });
      if (done) cb.onValue(done.value);
    }
  });
  return {
    disconnect: () => {
      try { char?.stopNotifications(); } catch { /* ignore */ }
      try { device.gatt.disconnect(); } catch { /* ignore */ }
    },
  };
}

/**
 * WebUSB scaffold for future custom-protocol (non-HID) industrial scanners.
 * No vendor is implemented yet — calling it intentionally throws so the UI can
 * surface "unsupported profile" instead of pretending.
 */
export async function connectUsbScanner(): Promise<never> {
  throw new Error('usb-vendor-profile-required');
}
