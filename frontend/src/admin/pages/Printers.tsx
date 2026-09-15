import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
  BridgeError,
  bridgeToken,
  flushPrinterAudit,
  newJobId,
  printerBridge,
  queuePrinterAudit,
  setBridgeToken,
  type BridgePrinter,
  type BridgeStatus,
} from '../printer-bridge';
import { adminApi } from '../api';

/**
 * PRINTER MANAGER (owner task 2026-09-15) — Admin → STATIONS → Printers.
 *
 * Talks ONLY to the local print bridge inside the AYROVI worker app on the
 * same Honeywell CT40 (127.0.0.1:8787 → Bluetooth Classic SPP → PM-241-BT,
 * TSPL II). No Labelife, no Zebra APIs, no Android system printing, no raw
 * commands through the backend — lifecycle events go to the EXISTING audit
 * via /v1/printers/audit (queued offline in localStorage).
 */

type Feedback = { tone: 'ok' | 'err' | 'info'; text: string } | null;

export default function Printers() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('stations.manage');

  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [bridgeDown, setBridgeDown] = useState(false);
  const [printers, setPrinters] = useState<BridgePrinter[] | null>(null);
  const [busy, setBusy] = useState<'scan' | 'connect' | 'disconnect' | 'test' | 'qr' | 'reconnect' | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [advancedToken, setAdvancedToken] = useState(bridgeToken());
  const flushed = useRef(false);

  const audit = useCallback((payload: Parameters<typeof queuePrinterAudit>[0]) => {
    queuePrinterAudit(payload);
    void flushPrinterAudit((p) => adminApi.printersAudit(p)).catch(() => undefined);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await printerBridge.status();
      setStatus(s);
      setBridgeDown(false);
    } catch {
      setStatus(null);
      setBridgeDown(true);
    }
  }, []);

  useEffect(() => {
    if (!flushed.current) {
      flushed.current = true;
      void flushPrinterAudit((p) => adminApi.printersAudit(p)).catch(() => undefined);
    }
    void refreshStatus();
  }, [refreshStatus]);

  async function search() {
    setBusy('scan');
    setFeedback(null);
    try {
      // Paired printers first (the PM-241-BT bond made once via Labelife
      // persists on the CT40; printing itself never needs Labelife).
      const bonded = await printerBridge.printers();
      let list = bonded.printers;
      if (list.length === 0) {
        const scanned = await printerBridge.scan();
        list = scanned.printers;
      }
      setPrinters(list);
      setFeedback(list.length === 0
        ? { tone: 'info', text: 'No printers found. Pair the PM-241-BT in Android Bluetooth settings once, then search again.' }
        : null);
    } catch (e) {
      setFeedback({ tone: 'err', text: humanize(e) });
    } finally {
      setBusy(null);
    }
  }

  async function connect(p: BridgePrinter) {
    setBusy('connect');
    setFeedback(null);
    try {
      await printerBridge.connect(p.address, p.name);
      await refreshStatus();
      audit({ event: 'PRINTER_CONNECTED', printerName: p.name, address: p.address, detail: 'connected from Admin (CT40 bridge)' });
      setFeedback({ tone: 'ok', text: `Connected to ${p.name}.` });
    } catch (e) {
      audit({ event: 'PRINTER_ADDED', printerName: p.name, address: p.address, detail: `connection failed: ${humanize(e)}` });
      setFeedback({ tone: 'err', text: humanize(e) });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy('disconnect');
    try {
      const name = status?.printer?.name ?? 'printer';
      const address = status?.printer?.address;
      await printerBridge.disconnect();
      await refreshStatus();
      audit({ event: 'PRINTER_DISCONNECTED', printerName: name, address, detail: 'disconnected from Admin' });
      setFeedback({ tone: 'info', text: 'Printer disconnected.' });
    } catch (e) {
      setFeedback({ tone: 'err', text: humanize(e) });
    } finally {
      setBusy(null);
    }
  }

  async function reconnect() {
    setBusy('reconnect');
    try {
      await printerBridge.reconnect();
      await refreshStatus();
      const name = status?.printer?.name ?? 'printer';
      audit({ event: 'PRINTER_CONNECTED', printerName: name, address: status?.printer?.address, detail: 'auto-reconnect from Admin' });
      setFeedback({ tone: 'ok', text: 'Printer reconnected.' });
    } catch (e) {
      setFeedback({ tone: 'err', text: humanize(e) });
    } finally {
      setBusy(null);
    }
  }

  async function testPrint() {
    setBusy('test');
    setFeedback({ tone: 'info', text: 'Printing…' });
    const name = status?.printer?.name ?? 'printer';
    try {
      const r = await printerBridge.printTest(newJobId());
      await refreshStatus();
      audit({ event: 'PRINTER_TEST_PRINTED', printerName: name, address: status?.printer?.address, firmware: status?.printer?.firmware, detail: r.duplicate ? 'duplicate id — not re-sent' : 'printed' });
      setFeedback({ tone: 'ok', text: r.duplicate ? 'Already printed (duplicate protected).' : 'Printed successfully.' });
    } catch (e) {
      audit({ event: 'PRINT_FAILED', printerName: name, address: status?.printer?.address, detail: humanize(e) });
      setFeedback({ tone: 'err', text: humanize(e) });
    } finally {
      setBusy(null);
    }
  }

  async function printQrTest() {
    setBusy('qr');
    setFeedback({ tone: 'info', text: 'Printing…' });
    const name = status?.printer?.name ?? 'printer';
    try {
      const r = await printerBridge.printQr(newJobId(), {
        customerName: 'AHMED',
        containerCode: 'C-0042',
        section: 'A',
        qrPayload: 'C-0042',
        barcodeValue: 'C-0042',
      });
      await refreshStatus();
      audit({ event: 'PRINTER_TEST_PRINTED', printerName: name, address: status?.printer?.address, detail: r.duplicate ? 'QR duplicate — not re-sent' : 'QR label printed' });
      setFeedback({ tone: 'ok', text: r.duplicate ? 'Already printed (duplicate protected).' : 'QR label printed. Scan it with the CT40 to verify.' });
    } catch (e) {
      audit({ event: 'PRINT_FAILED', printerName: name, address: status?.printer?.address, detail: `QR: ${humanize(e)}` });
      setFeedback({ tone: 'err', text: humanize(e) });
    } finally {
      setBusy(null);
    }
  }

  async function forget() {
    if (!window.confirm('Forget the saved printer on this device?')) return;
    const name = status?.printer?.name ?? 'printer';
    const address = status?.printer?.address;
    try {
      await printerBridge.forget();
      setPrinters(null);
      await refreshStatus();
      audit({ event: 'PRINTER_REMOVED', printerName: name, address, detail: 'removed from this device' });
      setFeedback({ tone: 'info', text: 'Saved printer removed.' });
    } catch (e) {
      setFeedback({ tone: 'err', text: humanize(e) });
    }
  }

  const connected = status?.state === 'CONNECTED' || status?.state === 'PRINTING';

  return (
    <>
      <header className="ac-head">
        <div>
          <h1 className="ac-title">Printers</h1>
          <p className="ac-sub">
            Label printing from THIS device (Bluetooth). The printer link lives in the AYROVI worker app&apos;s local
            print bridge — no Labelife, no system print screens.
          </p>
        </div>
      </header>

      {(feedback?.tone === 'err') && <div className="ac-error">{feedback.text}</div>}

      {bridgeDown && (
        <section className="os-card" style={{ marginBottom: 14, borderLeft: '3px solid #f0b429' }}>
          <h2 className="os-card-title">PRINT BRIDGE NOT AVAILABLE</h2>
          <p className="os-muted" style={{ fontSize: '0.85rem', lineHeight: 1.7 }}>
            On THIS CT40: open the <b>AYROVI</b> worker app → ⚙ SETTINGS → <b>PRINTER BRIDGE</b> → <b>ENABLE BRIDGE</b>
            {' '}(allow the Bluetooth permission once), keep the app running, then come back here.
          </p>
          <button className="os-btn" onClick={() => void refreshStatus()} disabled={busy !== null}>Retry</button>
        </section>
      )}

      {!bridgeDown && (
        <section className="os-card" style={{ marginBottom: 14 }}>
          <h2 className="os-card-title">PRINTER MANAGER</h2>
          {!connected && (
            <p className="os-muted">No printer connected.</p>
          )}
          {connected && status?.printer && (
            <div style={{ lineHeight: 1.9 }}>
              <div style={{ fontWeight: 800, fontSize: '1.05rem' }}>{status.printer.name}</div>
              <div>
                <span className="os-tag os-tag--info">Bluetooth</span>{' '}
                <span className={`os-tag ${status.state === 'PRINTING' ? 'os-tag--warn' : 'os-tag--ok'}`}>
                  ● {status.state === 'PRINTING' ? 'Printing…' : 'Connected'}
                </span>
              </div>
              <div className="os-muted" style={{ fontSize: '0.85rem' }}>Address: <span className="mono">{status.printer.address || '—'}</span></div>
              {status.printer.firmware && (
                <div className="os-muted" style={{ fontSize: '0.85rem' }}>Firmware: <span className="mono">{status.printer.firmware}</span></div>
              )}
            </div>
          )}

          <div className="os-row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            {!connected && canManage && (
              <button className="os-btn os-btn--primary" onClick={() => void search()} disabled={busy !== null}>
                {busy === 'scan' ? 'Searching…' : 'Search for Printers'}
              </button>
            )}
            {!connected && (
              <button className="os-btn" onClick={() => void reconnect()} disabled={busy !== null}>
                {busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect'}
              </button>
            )}
            {connected && canManage && (
              <>
                <button className="os-btn os-btn--primary" onClick={() => void testPrint()} disabled={busy !== null}>
                  {busy === 'test' ? 'Printing…' : 'Test Print'}
                </button>
                <button className="os-btn" onClick={() => void printQrTest()} disabled={busy !== null}>
                  {busy === 'qr' ? 'Printing…' : 'Print QR Test'}
                </button>
                <button className="os-btn os-btn--danger" onClick={() => void disconnect()} disabled={busy !== null}>
                  Disconnect
                </button>
              </>
            )}
          </div>

          {feedback && feedback.tone !== 'err' && (
            <p style={{ marginTop: 10, fontWeight: 600 }} className={feedback.tone === 'ok' ? '' : 'os-muted'}>
              {feedback.tone === 'ok' ? '✓ ' : ''}{feedback.text}
            </p>
          )}
        </section>
      )}

      {!bridgeDown && printers && printers.length > 0 && !connected && (
        <section className="os-card" style={{ marginBottom: 14 }}>
          <h2 className="os-card-title">AVAILABLE PRINTERS</h2>
          {printers.map((p) => (
            <div key={p.address} className="os-row" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border, #2a3140)' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{p.name} {p.likely && <span className="os-tag os-tag--ok">printer</span>}</div>
                <div className="os-muted" style={{ fontSize: '0.8rem' }}><span className="mono">{p.address}</span> · Bluetooth · Available</div>
              </div>
              {canManage && (
                <button className="os-btn os-btn--primary" onClick={() => void connect(p)} disabled={busy !== null}>
                  {busy === 'connect' ? 'Connecting…' : 'Connect'}
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="os-card">
        <details>
          <summary className="os-muted" style={{ cursor: 'pointer', fontSize: '0.85rem' }}>Advanced</summary>
          <div style={{ marginTop: 10 }}>
            <p className="os-muted" style={{ fontSize: '0.8rem' }}>
              Bridge: http://127.0.0.1:8787 (loopback only, inside the worker app) · protocol: TSPL II over Bluetooth
              SPP · status JSON: {status ? 'received' : 'none'}
            </p>
            {canManage && (
              <>
                <label className="os-label" htmlFor="pb-token" style={{ marginTop: 8 }}>Bridge token (optional shared secret)</label>
                <div className="os-row" style={{ display: 'flex', gap: 8 }}>
                  <input id="pb-token" className="os-input" value={advancedToken} onChange={(e) => setAdvancedToken(e.target.value)} placeholder="empty = no token" />
                  <button
                    className="os-btn"
                    onClick={() => {
                      setBridgeToken(advancedToken);
                      audit({ event: 'PRINTER_CONFIGURATION_CHANGED', printerName: status?.printer?.name ?? 'bridge', detail: 'bridge token updated' });
                      setFeedback({ tone: 'ok', text: 'Bridge token saved.' });
                    }}
                  >
                    Save token
                  </button>
                </div>
                <div className="os-row" style={{ marginTop: 10 }}>
                  <button className="os-btn os-btn--danger" onClick={() => void forget()} disabled={busy !== null}>Forget saved printer</button>
                </div>
              </>
            )}
          </div>
        </details>
      </section>
    </>
  );
}

/** §20: simple user-facing sentences only — no stack traces. */
function humanize(e: unknown): string {
  if (e instanceof BridgeError) {
    switch (e.code) {
      case 'BRIDGE_DOWN': return 'Print bridge not available on this device.';
      case 'BT_OFF': case 'NO_ADAPTER': return 'Bluetooth is disabled.';
      case 'PERMISSION': return 'Bluetooth permission is required to connect to the printer.';
      case 'NOT_CONNECTED': case 'LINK_LOST': return 'Printer disconnected.';
      case 'CONNECT_FAILED': case 'BAD_ADDRESS': case 'NO_PRINTER': return 'Printer not found.';
      case 'PRINT_FAILED': case 'TIMEOUT': return 'Printing failed. Check the printer.';
      case 'SCAN_NOT_STARTED': return 'Could not start scanning. Is Bluetooth on?';
      case 'BAD_TOKEN': return 'Bridge token rejected (Advanced).';
      default: return e.message || 'Printer error.';
    }
  }
  return 'Printer error.';
}
