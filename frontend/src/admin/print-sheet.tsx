import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BarcodeFormat, MultiFormatWriter } from '@zxing/library';

/** CODE 128 drawn locally (zxing encode → canvas). */
export function drawCode128(canvas: HTMLCanvasElement | null, value: string) {
  if (!canvas) return;
  const width = 560;
  const height = 120;
  const matrix = new MultiFormatWriter().encode(value, BarcodeFormat.CODE_128, width, height, new Map());
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  const cell = width / matrix.getWidth();
  for (let x = 0; x < matrix.getWidth(); x += 1) {
    if (matrix.get(x, 0)) {
      ctx.fillRect(Math.floor(x * cell), 0, Math.ceil(cell), height);
    }
  }
}

let stylesInjected = false;

/**
 * PRINT FIX (owner report 2026-09-14: blank pages from Android Chrome —
 * the old visibility+absolute trick prints an empty sheet there, and it
 * regressed batch labels too). Android-Chrome-safe technique:
 *   - this subtree is portaled to document.body (escapes every app
 *     overflow/transform container),
 *   - during print the APP ROOT is display:none and ONLY this subtree
 *     renders (display-based, deterministic),
 *   - on screen the root stays display:none (no preview, no layout impact).
 * Give window.print() ~300ms after mounting so the canvases are drawn.
 */
export function PrintSheet({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'ayrovi-print-style';
    style.textContent = `
      .ayrovi-print-root { display: none; }
      @media print {
        body > #root { display: none !important; }
        .ayrovi-print-root { display: block !important; background: #fff; color: #000; }
      }
    `;
    document.head.appendChild(style);
  }, []);
  return createPortal(<div className="ayrovi-print-root">{children}</div>, document.body);
}
