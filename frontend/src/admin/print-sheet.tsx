/**
 * CODE 128 (code set B) encoder — SELF-CONTAINED, zero runtime dependencies.
 *
 * ROOT CAUSE (reproduced in CI 2026-09-14): @zxing/library ships NO CODE_128
 * writer — MultiFormatWriter.encode(..., CODE_128) throws
 * "IllegalArgumentException: No encoder available for format 4" on EVERY
 * device. That exception fired before window.open() in the previous attempt,
 * which is exactly the owner's dead print button. The pattern table below was
 * GENERATED from @zxing/library's Code128Reader.CODE_PATTERNS (the scanner-
 * proven decode table) and the vitest suite round-trip-decodes every encoded
 * label against that same table, so any standard scanner reads our labels.
 */
/** CODE128 symbol patterns: index = symbol value (0..102 data/aux, 103..106
 * start A/B/C + stop); digits are alternating bar/space widths (start=bar).
 * Symbols 0..105 span 11 modules; the stop symbol spans 13 (incl. the final
 * 2-module termination bar). */
const CODE128_PATTERNS: readonly string[] = ["212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212","112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131","311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321","112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121","313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111","314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114","122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212","124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113","114311","411113","411311","113141","114131","311141","411131","211412","211214","211232","2331112"];

const CODE128_START_B = 104;
const CODE128_STOP = 106;
/** Quiet zone in modules on each side (scanner requirement). */
const QUIET_MODULES = 10;

function patternBits(value: number): string {
  const pattern = CODE128_PATTERNS[value];
  let bits = '';
  for (let i = 0; i < pattern.length; i += 1) {
    bits += (i % 2 === 0 ? '1' : '0').repeat(Number(pattern[i]));
  }
  return bits;
}

/** Full CODE128B bit pattern for a value (no quiet zone — the SVG adds it). */
export function code128BitsB(value: string): string {
  if (!value.length) throw new Error('empty label code');
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c < 32 || c > 126) throw new Error(`unsupported character in label: ${value[i]!}`);
  }
  let bits = patternBits(CODE128_START_B);
  let checksum = CODE128_START_B;
  for (let i = 0; i < value.length; i += 1) {
    const symbol = value.charCodeAt(i) - 32;
    bits += patternBits(symbol);
    checksum += symbol * (i + 1);
  }
  bits += patternBits(checksum % 103);
  bits += patternBits(CODE128_STOP);
  return bits;
}

/** Escape a label code for safe interpolation into the printed HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * CODE 128 rendered as an INLINE SVG string (module-accurate, losslessly
 * scalable). SVG needs no canvas, no 2d context, no raster APIs and no
 * external images — the whole pipeline is pure string building, so there is
 * nothing left that can throw on a device.
 */
export function code128Svg(value: string): string {
  const bits = code128BitsB(value);
  // Merge consecutive black modules into runs → one <rect> per bar, offset by
  // the quiet zone so the rendered label always keeps its scanner margin.
  const bars: string[] = [];
  let runStart = -1;
  for (let x = 0; x <= bits.length; x += 1) {
    const black = x < bits.length && bits[x] === '1';
    if (black && runStart < 0) {
      runStart = x;
    } else if (!black && runStart >= 0) {
      bars.push(
        `<rect x="${runStart + QUIET_MODULES}" y="0" width="${x - runStart}" height="1" fill="#000"/>`,
      );
      runStart = -1;
    }
  }
  const total = bits.length + QUIET_MODULES * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} 1"` +
    ' preserveAspectRatio="none" shape-rendering="crispEdges" role="img"' +
    ` aria-label="${esc(value)}">${bars.join('')}</svg>`
  );
}

/** Styles for the self-contained print document. */
const PRINT_CSS = `
    @page { margin: 10mm; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .lbl { display: flex; flex-direction: column; align-items: center; gap: 4mm;
           page-break-inside: avoid; border-bottom: 1px dashed #bbb; padding: 6mm 0 7mm; }
    .lbl svg { width: 130mm; height: 26mm; }
    .lbl h2 { margin: 0; font: 700 22pt/1.2 monospace; letter-spacing: .08em; color: #000; }
`;

/**
 * PRINT (owner reports 2026-09-14: button DEAD on Android Chrome — the PNG
 * canvas pipeline threw before the window opened; both earlier CSS techniques
 * printed blank). Final approach — a SELF-CONTAINED print window:
 *
 * 1. window.open() runs FIRST, before ANY work that could throw, so the tap
 *    always opens the tab (pop-up gesture requirement) and the button can
 *    never look dead. Blocked pop-up → returns false (caller shows the hint).
 * 2. Labels are inline SVG (no canvas, no images, no cached assets) written
 *    into the fresh document. Any failure closes the tab and ALERTS the real
 *    error text — a silent failure is unacceptable for remote diagnosis.
 * 3. Auto-print fires from the opener at 400ms and again at 1600ms (Android
 *    Chrome sometimes swallows a single deferred print); the user can always
 *    print manually from the opened tab's browser menu.
 */
export function printLabelsInNewWindow(codes: string[]): boolean {
  const w = window.open('', '_blank');
  if (!w) return false;
  try {
    const labels = codes
      .map((c) => `<div class="lbl">${code128Svg(c)}<h2>${esc(c)}</h2></div>`)
      .join('');
    w.document.open();
    w.document.write(
      `<!doctype html><html><head><meta charset="utf-8">` +
        `<title>AYROVI labels</title><style>${PRINT_CSS}</style></head>` +
        `<body>${labels}</body></html>`,
    );
    w.document.close();
  } catch (e) {
    try {
      w.close();
    } catch {
      /* the tab may already be gone — nothing to clean up */
    }
    window.alert(`Print error: ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
  const trigger = () => {
    try {
      w.focus();
      w.print();
    } catch {
      /* the user can print manually from the opened tab (menu → Print) */
    }
  };
  setTimeout(trigger, 400);
  setTimeout(trigger, 1600);
  return true;
}
