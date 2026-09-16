/**
 * DISPLAY PRINT — the screen's printing side (stage 2).
 *
 * The backend decides WHAT prints (station_print_jobs row with the rendered
 * payload, same codes the operator sees). This module decides HOW it reaches
 * paper, and it is the only place that knows about transports:
 *
 *  - BROWSER (default): a self-contained print window with an inline Code128
 *    barcode — works on any PC/TV screen with any printer, no hardware change.
 *  - CT40 / BRIDGE: the SAME label is handed to the local print bridge
 *    (127.0.0.1:8787) hosted by the worker app on the device that owns the
 *    Bluetooth SPP link to the PM-241. If the bridge is not reachable the
 *    screen falls back to the browser window and says so — a label is never
 *    silently dropped.
 *
 * Every path reports its real result back to the API (PRINTED / FAILED), so
 * the audit trail says what physically happened.
 */

import { code128Svg } from '../admin/print-sheet';
import { printerBridge, newJobId, BridgeError } from '../admin/printer-bridge';

export interface LabelPayload {
  title?: string;
  code?: string | null;
  kind?: string | null;
  quantity?: number | null;
  status?: string | null;
  customer?: string | null;
  reference?: string | null;
  station?: { code?: string | null; name?: string | null } | null;
  worker?: { code?: string | null; name?: string | null } | null;
  printedAt?: string | null;
}

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const PRINT_CSS = `
  @page { margin: 6mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 12px; }
  .lbl { width: 62mm; padding: 6mm 0; text-align: center; page-break-after: always; }
  .lbl:last-child { page-break-after: auto; }
  .title { font-size: 12px; letter-spacing: 1px; text-transform: uppercase; opacity: .75; }
  .code { font-size: 20px; font-weight: 800; letter-spacing: 1px; margin: 6px 0; word-break: break-all; }
  .rows { font-size: 12px; margin-top: 6px; }
  .rows div { display: flex; justify-content: space-between; gap: 8px; }
  svg { max-width: 100%; height: auto; }
`;

/** The label as a standalone HTML document (also used by the tests). */
export function labelDocument(payload: LabelPayload, copies = 1): string {
  const code = payload.code ?? payload.reference ?? '—';
  const rows: Array<[string, string]> = [];
  if (payload.kind) rows.push(['Kind', String(payload.kind)]);
  if (payload.quantity != null) rows.push(['Qty', String(payload.quantity)]);
  if (payload.customer) rows.push(['Customer', String(payload.customer)]);
  if (payload.station?.code) rows.push(['Station', String(payload.station.code)]);
  if (payload.worker?.code) rows.push(['Worker', String(payload.worker.code)]);
  if (payload.status) rows.push(['Status', String(payload.status)]);

  const one = `<div class="lbl">
    <div class="title">${esc(payload.title ?? 'AYROVI LABEL')}${payload.printedAt ? ` · REPRINT` : ''}</div>
    ${code128Svg(String(code))}
    <div class="code">${esc(code)}</div>
    <div class="rows">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
  </div>`;
  const count = Math.min(Math.max(copies, 1), 5);
  return `<!doctype html><html><head><meta charset="utf-8"><title>AYROVI label</title><style>${PRINT_CSS}</style></head><body>${one.repeat(count)}</body></html>`;
}

export type PrintOutcome = { ok: true; via: 'BROWSER' | 'BRIDGE' | 'CT40' } | { ok: false; via: string; error: string };

/**
 * Print window FIRST (pop-up gesture requirement), then write the label — the
 * same hard-won order as the admin print sheet: a tap must never look dead.
 */
export function printViaBrowser(payload: LabelPayload, copies = 1): PrintOutcome {
  const w = window.open('', '_blank');
  if (!w) return { ok: false, via: 'BROWSER', error: 'POPUP_BLOCKED' };
  try {
    w.document.open();
    w.document.write(labelDocument(payload, copies));
    w.document.close();
  } catch (e) {
    try { w.close(); } catch { /* tab already gone */ }
    return { ok: false, via: 'BROWSER', error: e instanceof Error ? e.message : String(e) };
  }
  const trigger = () => {
    try { w.focus(); w.print(); } catch { /* manual print from the tab */ }
  };
  setTimeout(trigger, 400);
  setTimeout(trigger, 1600);
  return { ok: true, via: 'BROWSER' };
}

/** Hand the label to the local Bluetooth bridge (worker app on the CT40). */
export async function printViaBridge(payload: LabelPayload): Promise<PrintOutcome> {
  try {
    const jobId = newJobId();
    await printerBridge.printBarcode(jobId, {
      title: payload.title,
      customerName: payload.customer ?? undefined,
      containerCode: payload.station?.code ?? undefined,
      barcodeValue: String(payload.code ?? payload.reference ?? ''),
      qrPayload: String(payload.code ?? payload.reference ?? ''),
    });
    return { ok: true, via: 'BRIDGE' };
  } catch (e) {
    const error = e instanceof BridgeError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    return { ok: false, via: 'BRIDGE', error };
  }
}

/** Transport-aware print: bridge when configured, browser as the safe floor. */
export async function printLabelByTransport(
  payload: LabelPayload,
  transport: 'BROWSER' | 'BRIDGE' | 'CT40' = 'BROWSER',
  copies = 1,
): Promise<PrintOutcome & { fallback?: string }> {
  if (transport === 'BROWSER') return printViaBrowser(payload, copies);
  const viaBridge = await printViaBridge(payload);
  if (viaBridge.ok) return { ...viaBridge, via: transport };
  // The bridge is a LOCAL device service: it can be off, unpaired or on
  // another machine. Never lose the label — print from the screen and say why.
  const fallback = printViaBrowser(payload, copies);
  return fallback.ok ? { ...fallback, fallback: viaBridge.error } : { ...fallback, fallback: viaBridge.error };
}
