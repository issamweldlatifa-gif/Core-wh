/**
 * Receiving terminal — HARDWARE SCANNER panel (dual-scanner order §5/§8).
 *
 * No camera, no getUserMedia, no browser camera permission (§16). Reads come
 * from USB/BT keyboard-wedge scanners captured at the window level, with an
 * optional Web Bluetooth connection for serial-over-BLE models and a WebUSB
 * hook for future Industrial custom-protocol providers. Every read is routed
 * through prepareHardwareRead → onDetected(value, 'EXTERNAL_SCANNER'), i.e. the
 * exact same channel a software barcode/QR read uses (§7 — shared pipeline).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ScanOutcome } from './ContinuousScanner';
import type { ScanSource } from './scan-source';
import { DEFAULT_SCAN_CONFIG } from './scan-config';
import { createTelemetry, exposeDebugHandle, type TelemetrySink } from './telemetry';
import { exposeBenchmarkSnapshot } from './device-benchmark';
import { attachHidScanner, detectHardwareCapabilities, connectBleScanner } from './hardware-wedge';
import { prepareHardwareRead } from './hardware-scan';
import { EMPTY_DEDUPE, type DedupeState } from './dedupe';
import './scanner.css';

export type HardwareStatus = 'connecting' | 'connected' | 'disconnected';
export type BleState = 'unsupported' | 'off' | 'pairing' | 'on' | 'failed';

interface Props {
  title: string;
  outcome?: ScanOutcome | null;
  onDetected: (value: string, source: ScanSource) => void;
  onClose: () => void;
  /** Mobile/Tablet only per §14 — Desktop must offer Reconnect not switch. */
  canSwitchToSoftware: boolean;
  onSwitchToSoftware: () => void;
  /** Optional method tabs (Software/Hardware) rendered in the header. */
  methodTabs?: ReactNode;
}

interface LastScanEntry {
  value: string;
  at: number;
  duplicate: boolean;
  kind: 'ok' | 'info';
}

const CAP_ROW: Array<[string, string, (c: { hidWedge: boolean; bluetooth: boolean; webUsb: boolean }) => boolean]> = [
  ['USB / HID wedge', 'keyboard-wedge capture — works with most USB scanners', (c) => c.hidWedge],
  ['Bluetooth', 'Web Bluetooth (serial-over-BLE barcode service)', (c) => c.bluetooth],
  ['WebUSB', 'vendor profiles for future industrial scanners', (c) => c.webUsb],
];

export default function HardwareScannerPanel({
  title,
  outcome = null,
  onDetected,
  onClose,
  canSwitchToSoftware,
  onSwitchToSoftware,
  methodTabs,
}: Props) {
  const [caps] = useState(() => detectHardwareCapabilities());
  const [status, setStatus] = useState<HardwareStatus>('connecting');
  const [ble, setBle] = useState<BleState>(caps.bluetooth ? 'off' : 'unsupported');
  const [error, setError] = useState<string | null>(null);
  const [lastScans, setLastScans] = useState<LastScanEntry[]>([]);
  const [telem] = useState<TelemetrySink>(() => createTelemetry(DEFAULT_SCAN_CONFIG.telemetry.maxAttempts));
  const dupRef = useRef<DedupeState>({ ...EMPTY_DEDUPE });
  const detachHidRef = useRef<(() => void) | null>(null);
  const bleRef = useRef<{ disconnect: () => void } | null>(null);
  const detach = useCallback(() => detachHidRef.current?.(), []);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'bad'; text: string; token: number } | null>(null);

  // expose a separate debug handle so hardware telemetry is measurable (§12)
  useEffect(() => {
    exposeDebugHandle(telem, '__ayroviHardwareTelemetry');
    exposeBenchmarkSnapshot(telem, '__ayroviHardwareTelemetry', () => ({
      method: 'hardware',
      provider: ble === 'on' ? 'bluetooth' : 'hid',
      deviceType: 'HID',
    }));
  }, [telem, ble]);

  // ---- attach the HID wedge listener (no permission needed) ----
  useEffect(() => {
    setStatus('connecting');
    detachHidRef.current = attachHidScanner(
      { onRead: (e) => handleRead(e.value) },
      { terminatorKeys: ['Enter'], maxLength: DEFAULT_SCAN_CONFIG.hardware?.maxCodeLength ?? 64 },
    );
    setStatus('connected');
    return () => {
      detachHidRef.current?.();
      detachHidRef.current = null;
      bleRef.current?.disconnect();
      bleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRead = useCallback((raw: string, provider = 'hid') => {
    const t0 = performance.now();
    const now = Date.now();
    const w = DEFAULT_SCAN_CONFIG.duplicate.repeatWindowMs;
    const res = prepareHardwareRead(dupRef.current, raw, now, w);
    const ms = Math.max(0, performance.now() - t0);
    if (!res) return; // junk key spam — never reaches receiving
    const entry = (kind: 'ok' | 'info'): LastScanEntry => ({ value: res.value, at: now, duplicate: res.duplicate, kind });
    if (res.duplicate) {
      setLastScans((l) => [entry('info'), ...l].slice(0, 8));
      return;
    }
    telem.record({
      ts: now,
      scanMethod: 'hardware',
      provider,
      scannerType: 'external',
      detectionType: 'SCANNER',
      processingMs: ms,
      validationResult: 'na',
      finalResult: 'auto_submitted',
      deviceType: provider === 'bluetooth' ? 'BLUETOOTH' : 'HID',
    });
    setLastScans((l) => [entry('ok'), ...l].slice(0, 8));
    onDetected(res.value, 'EXTERNAL_SCANNER');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDetected, telem]);

  // ---- backend verdict → telemetry ----
  useEffect(() => {
    if (!outcome) return;
    setBanner({ kind: outcome.kind === 'ok' ? 'ok' : 'bad', text: outcome.text, token: outcome.token });
    telem.markBackendVerdict(outcome.kind === 'ok');
    const t = window.setTimeout(() => setBanner(null), 2600);
    return () => window.clearTimeout(t);
  }, [outcome, telem]);

  const reconnect = useCallback(() => {
    setError(null);
    detach();
    detachHidRef.current = attachHidScanner(
      { onRead: (e) => handleRead(e.value) },
      { terminatorKeys: ['Enter'], maxLength: 64 },
    );
    setStatus('connected');
  }, [detach, handleRead]);

  const toggleBle = useCallback(async () => {
    if (ble !== 'off' && ble !== 'failed') return;
    setBle('pairing');
    setError(null);
    try {
      const h = await connectBleScanner({
        onValue: (value) => handleRead(value),
      });
      bleRef.current = h;
      detach(); // one scanner path at a time — avoid double reads
      setBle('on');
      setStatus('connected');
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? '');
      setBle('failed');
      setError(
        msg === 'bluetooth-unsupported'
          ? 'Bluetooth not supported by this browser/OS.'
          : msg === 'bluetooth-no-barcode-service'
            ? 'Connected, but no standard barcode service (0xFFE0/0xFFE5) was found on the device.'
            : 'Bluetooth pairing was cancelled or failed. You can keep using USB/HID.'
      );
    }
  }, [ble, detach, handleRead]);

  const simulate = useCallback(() => {
    // DEV/QA: push a real-looking code through the SAME wedge pipeline without
    // a physical scanner, so the receiving flow can be verified in a browser.
    handleRead('SIMU-DEMO0001');
  }, [handleRead]);

  const statusOk = status === 'connected';
  return (
    <div className="cs-overlay" role="dialog" aria-modal="true" aria-label="Hardware scanner">
      <div className="cs-frame">
        <header className="cs-head">
          <div className="cs-title">
            <span className="cs-dot" data-state={statusOk ? 'SUCCESS' : 'ERROR'} />
            {title} · HARDWARE
          </div>
          <div className="cs-head-meta">
            {methodTabs}
            <span className="os-tag os-tag--muted">EXTERNAL SCANNER</span>
            <button type="button" className="os-btn os-btn--danger" onClick={onClose}>EXIT</button>
          </div>
        </header>

        <div className="cs-stage hw-body">
          <div className="hw-hero">
            <div className={`hw-indicator${statusOk ? ' is-on' : ' is-off'}`} aria-hidden="true">
              {statusOk ? '●' : '○'}
            </div>
            <div className="hw-status-text">
              <strong>Hardware Scanner</strong>
              <span className={statusOk ? 'hw-on' : 'hw-off'}>
                Status: {statusOk ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <div className="hw-sub">
              {statusOk ? 'Ready to scan — scan a code with the USB / Bluetooth device' : 'Connect the scanner below'}
            </div>
          </div>

          {error && (
            <div className="hw-error os-mono">{error}</div>
          )}

          <div className="hw-actions">
            <button type="button" className="os-btn os-btn--primary" onClick={reconnect}>
              {statusOk ? 'RECONNECT' : 'CONNECT SCANNER'}
            </button>
            {caps.bluetooth && ble === 'pairing' && (
              <button type="button" className="os-btn" disabled>PAIRING…</button>
            )}
            {caps.bluetooth && (ble === 'off' || ble === 'failed') && (
              <button type="button" className="os-btn" onClick={toggleBle}>PAIR BLUETOOTH</button>
            )}
            {ble === 'on' && (
              <span className="os-tag os-tag--ok">BLUETOOTH CONNECTED</span>
            )}
            <button type="button" className="os-btn" onClick={simulate} title="Dev/QA: push a code through the same wedge pipeline without a physical scanner">
              DEV: SIMULATE WEDGE
            </button>
            {canSwitchToSoftware && (
              <button type="button" className="os-btn" onClick={onSwitchToSoftware}>
                SWITCH TO SOFTWARE SCAN
              </button>
            )}
          </div>

          <div className="hw-caps">
            {CAP_ROW.map(([name, desc, ok]) => (
              <div key={name} className="hw-cap">
                <span className={`hw-cap-dot ${ok(caps) ? 'ok' : 'no'}`} />
                <div>
                  <div className="hw-cap-name">{name}</div>
                  <div className="hw-cap-desc">{desc}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="hw-list-title">LAST SCAN</div>
          {lastScans.length === 0 ? (
            <div className="hw-empty os-muted">No scans yet — scan a code or press “DEV: SIMULATE WEDGE”.</div>
          ) : (
            <ul className="hw-list">
              {lastScans.map((s, i) => (
                <li key={`${s.at}-${i}`} className="hw-row">
                  <span className="os-mono hw-code">{s.value}</span>
                  <span className={`os-tag ${s.duplicate ? 'os-tag--warn' : 'os-tag--ok'}`}>
                    {s.duplicate ? 'DUPLICATE · IGNORED' : 'ACCEPTED'}
                  </span>
                  <span className="os-muted hw-time">{new Date(s.at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}

          {banner && (
            <div key={banner.token} className={`cs-result cs-result--${banner.kind === 'ok' ? 'ok' : 'bad'}`}>
              <strong>{banner.kind === 'ok' ? '✓ RECEIVED' : '✕ NOT ACCEPTED'}</strong>
              <span>{banner.text}</span>
            </div>
          )}

          <div className="hw-foot">
            USB / HID scans arrive as a fast keyboard burst — no camera or browser permission is used.
            Bluetooth & WebUSB connect through the provider seam and reuse the exact same receiving pipeline.
          </div>
        </div>
      </div>
    </div>
  );
}
