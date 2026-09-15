/**
 * PRINTER MANAGER — admin-web client for the LOCAL print bridge running in
 * the AYROVI worker app on the SAME Honeywell CT40 (task 2026-09-15).
 *
 * WHY a native bridge: a browser page has NO Bluetooth Classic/SPP API (Web
 * Bluetooth is BLE-only), so the native worker app on the CT40 hosts a
 * loopback HTTP server (127.0.0.1:8787) that owns the single SPP link to the
 * PM-241-BT. This client speaks to that bridge; it NEVER talks to a server
 * for printing (task §23) and works fully offline once the label data is
 * local (task §24).
 *
 * Chrome notes: requests from the https page to the loopback are answered
 * with CORS + Private-Network-Access preflight headers by the bridge.
 */

export const BRIDGE_PORT = 8787;

export type BridgeState = 'UNAVAILABLE' | 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'PRINTING' | 'ERROR';

export interface BridgePrinter {
  name: string;
  address: string;
  likely?: boolean;
}

export interface BridgeStatus {
  bridge: boolean;
  state: BridgeState;
  printer?: { name: string; address: string; firmware?: string };
  detail?: string;
}

export interface LabelData {
  title?: string;
  customerName?: string;
  containerCode?: string;
  section?: string;
  qrPayload?: string;
  barcodeValue?: string;
}

export type PrinterAuditEvent =
  | 'PRINTER_ADDED'
  | 'PRINTER_CONNECTED'
  | 'PRINTER_DISCONNECTED'
  | 'PRINTER_REMOVED'
  | 'PRINTER_TEST_PRINTED'
  | 'PRINTER_CONFIGURATION_CHANGED'
  | 'PRINT_FAILED';

const TOKEN_KEY = 'printer_bridge_token';
const OUTBOX_KEY = 'printer_audit_outbox';

export function bridgeToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setBridgeToken(token: string): void {
  if (token.trim()) localStorage.setItem(TOKEN_KEY, token.trim());
  else localStorage.removeItem(TOKEN_KEY);
}

export class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(path: string, init?: RequestInit, timeoutMs = 4000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Print-Token': bridgeToken(),
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = String(body.error ?? `HTTP_${res.status}`);
      const detail = String(body.detail ?? '');
      throw new BridgeError(code, detail || code);
    }
    return body as T;
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    throw new BridgeError('BRIDGE_DOWN', 'Print bridge not available on this device.');
  } finally {
    clearTimeout(timer);
  }
}

export const printerBridge = {
  status: () => call<BridgeStatus>('/status', { method: 'GET' }),
  printers: () => call<{ printers: BridgePrinter[] }>('/printers', { method: 'GET' }),
  scan: () => call<{ printers: BridgePrinter[] }>('/printers/scan', { method: 'POST', body: '{}' }, 15000),
  connect: (address: string, name?: string) =>
    call<{ ok: boolean; state: BridgeState }>('/connect', { method: 'POST', body: JSON.stringify({ address, name }) }, 12000),
  disconnect: () => call<{ ok: boolean }>('/disconnect', { method: 'POST', body: '{}' }),
  reconnect: () => call<{ ok: boolean }>('/reconnect', { method: 'POST', body: '{}' }, 12000),
  forget: () => call<{ ok: boolean }>('/forget', { method: 'POST', body: '{}' }),
  printTest: (jobId: string) =>
    call<{ ok: boolean; duplicate: boolean }>('/print/test', { method: 'POST', body: JSON.stringify({ jobId }) }, 20000),
  printQr: (jobId: string, label: LabelData) =>
    call<{ ok: boolean; duplicate: boolean }>('/print/qr', { method: 'POST', body: JSON.stringify({ jobId, ...label }) }, 20000),
  printBarcode: (jobId: string, label: LabelData) =>
    call<{ ok: boolean; duplicate: boolean }>('/print/barcode', { method: 'POST', body: JSON.stringify({ jobId, ...label }) }, 20000),
};

/** Client-side duplicate guard on top of the bridge's persisted ids. */
export function newJobId(): string {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------ audit outbox */
/* §22: every printer action lands in the EXISTING audit system. Printing
 * must work offline (§24), so audit posts are queued in localStorage and
 * flushed on the next page load when the API is reachable again. */

export interface PrinterAuditPayload {
  event: PrinterAuditEvent;
  printerName: string;
  address?: string;
  model?: string;
  firmware?: string;
  detail?: string;
}

type Poster = (payload: PrinterAuditPayload) => Promise<unknown>;

export function queuePrinterAudit(payload: PrinterAuditPayload): void {
  const box = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') as Array<PrinterAuditPayload & { at: string }>;
  box.push({ ...payload, at: new Date().toISOString() });
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(box.slice(-100)));
}

export async function flushPrinterAudit(post: Poster): Promise<number> {
  const box = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') as Array<PrinterAuditPayload & { at: string }>;
  if (box.length === 0) return 0;
  const remaining: Array<PrinterAuditPayload & { at: string }> = [];
  let sent = 0;
  for (const item of box) {
    try {
      await post(item);
      sent += 1;
    } catch {
      remaining.push(item);
    }
  }
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(remaining));
  return sent;
}
