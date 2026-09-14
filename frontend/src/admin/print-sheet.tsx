import { BarcodeFormat, MultiFormatWriter } from '@zxing/library';

/** CODE 128 rendered to a PNG data-URL (zxing encode → offscreen canvas). */
export function code128DataUrl(value: string, width = 560, height = 120): string {
  const matrix = new MultiFormatWriter().encode(value, BarcodeFormat.CODE_128, width, height, new Map());
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  const cell = width / matrix.getWidth();
  for (let x = 0; x < matrix.getWidth(); x += 1) {
    if (matrix.get(x, 0)) {
      ctx.fillRect(Math.floor(x * cell), 0, Math.ceil(cell), height);
    }
  }
  return canvas.toDataURL('image/png');
}

/**
 * PRINT (owner reports 2026-09-14: Android Chrome printed BLANK pages from
 * both CSS techniques). Final approach — a SELF-CONTAINED print window:
 * labels are inline PNG data-URLs in a fresh document with no app CSS, so
 * nothing from the SPA (cache, styles, portals) can blank the page. Must be
 * called synchronously from the click handler (pop-up gesture requirement).
 * Returns false when the pop-up is blocked (caller shows the hint).
 */
export function printLabelsInNewWindow(codes: string[]): boolean {
  const labels = codes
    .map((c) => `<div class="lbl"><img src="${code128DataUrl(c)}" alt="${c}"/><h2>${c}</h2></div>`)
    .join('');
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>AYROVI labels</title><style>
    @page { margin: 10mm; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .lbl { display: flex; flex-direction: column; align-items: center; gap: 6px;
           page-break-inside: avoid; border-bottom: 1px dashed #bbb; padding: 8px 0 10px; }
    .lbl img { width: 130mm; height: 28mm; image-rendering: pixelated; }
    .lbl h2 { margin: 0; font-size: 22pt; letter-spacing: .1em; color: #000; font-family: monospace; }
  </style></head><body>${labels}</body></html>`);
  w.document.close();
  setTimeout(() => {
    try {
      w.focus();
      w.print();
    } catch {
      /* the user can print manually from the opened tab (⋮ → Print) */
    }
  }, 350);
  return true;
}
