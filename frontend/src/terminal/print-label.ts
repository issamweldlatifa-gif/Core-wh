import { QRCodeWriter, BarcodeFormat, EncodeHintType } from '@zxing/library';

/**
 * Printable QR labels for operational containers and shipment labels.
 *
 * Uses the ALREADY-BUNDLED @zxing/library encoder (no new dependency) to
 * render the QR as inline SVG, then opens a minimal print window. The QR
 * payload is exactly the container/shipment code — the same value every
 * terminal accepts as a scan.
 */

export interface LabelSpec {
  /** The scannable code — QR payload AND the monospace headline (RCN-/BIN-/OUT-). */
  code: string;
  /** Big human label, e.g. the customer reference on a bin ("AHMED"). */
  bigLabel?: string | null;
  /** Secondary lines (order reference, carrier, tracking …). */
  lines?: Array<{ k: string; v: string }>;
  /** Label kind headline, e.g. "CUSTOMER BIN" / "RECEIVING TOTE" / "SHIPPING LABEL". */
  kind: string;
}

/** Render a QR code as an SVG string (module-per-rect, crisp at any size). */
function qrSvg(value: string, sizePx: number): string {
  const hints = new Map<EncodeHintType, unknown>([[EncodeHintType.MARGIN, 1]]);
  const matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 0, 0, hints);
  const w = matrix.getWidth();
  const h = matrix.getHeight();
  let rects = '';
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (matrix.get(x, y)) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges" fill="#000">${rects}</svg>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the standalone printable HTML document for one or more labels. */
export function labelsHtml(specs: LabelSpec[]): string {
  const cards = specs
    .map((spec) => {
      const lines = (spec.lines ?? [])
        .map((l) => `<div class="line"><span class="k">${esc(l.k)}</span><span class="v">${esc(l.v)}</span></div>`)
        .join('');
      return `
  <div class="label">
    <div class="kind">${esc(spec.kind)}</div>
    ${spec.bigLabel ? `<div class="big">${esc(spec.bigLabel)}</div>` : ''}
    <div class="qr">${qrSvg(spec.code, 220)}</div>
    <div class="code">${esc(spec.code)}</div>
    ${lines}
  </div>`;
    })
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>AYROVI label</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Courier New', ui-monospace, monospace; background: #fff; color: #000;
         display: flex; flex-wrap: wrap; gap: 8mm; padding: 8mm; }
  .label { width: 100mm; border: 2px solid #000; padding: 6mm; text-align: center;
           page-break-inside: avoid; }
  .kind { font-size: 11px; letter-spacing: 0.25em; border-bottom: 1px solid #000;
          padding-bottom: 3mm; margin-bottom: 3mm; }
  .big { font-size: 34px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase;
         margin-bottom: 3mm; word-break: break-word; }
  .qr { margin: 2mm 0; }
  .code { font-size: 20px; font-weight: 700; letter-spacing: 0.12em; margin-top: 2mm; }
  .line { display: flex; justify-content: space-between; font-size: 12px; margin-top: 2mm;
          border-top: 1px dashed #999; padding-top: 2mm; }
  .line .k { color: #555; letter-spacing: 0.1em; }
  @media print { body { padding: 0; gap: 4mm; } }
</style></head><body>${cards}
<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},150);});</script>
</body></html>`;
}

/** Open the browser print dialog for the given label(s). */
export function printLabel(spec: LabelSpec | LabelSpec[]): void {
  const specs = Array.isArray(spec) ? spec : [spec];
  const win = window.open('', '_blank', 'width=480,height=640');
  if (!win) return; // popup blocked — the caller's UI still shows the code
  win.document.write(labelsHtml(specs));
  win.document.close();
}
