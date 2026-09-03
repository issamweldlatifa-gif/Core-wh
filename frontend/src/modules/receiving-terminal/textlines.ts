/**
 * Text-line targeting — unified P0 §5/§6/§8/§9 (direct SKU / Reference OCR).
 *
 * For a single-line target the scanner must NOT OCR the whole region. It finds
 * the text LINE inside the scan region first (row-projection of vertical edge
 * energy), then OCR runs on the DYNAMIC crop of that line. This module is the
 * pure, browser/Node-shared implementation:
 *
 *   1. downscale (cost bound)         — never analyse full frame
 *   2. vertical-edge energy per row   — text strokes are vertical edges
 *   3. band the rows above a floor    — connected text rows = candidate lines
 *   4. pick the strongest line        — SKU/Reference code line
 *   5. column extent of that band     — tight dynamic ROI (x0..x1)
 *
 * Also exports the tiny orientation helper used to decide deskew on the crop.
 */

export interface LineRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number; // exclusive
  /** Normalised strength 0..1 (band energy / best band energy). */
  score: number;
  /** 0..1 — how close the line centre is to the region centre (alignment). */
  centered: number;
}

export interface LineFindOptions {
  /** Downscale input to at most this width before projecting (cost bound). */
  maxWidth?: number;
  /** Prefer the LOWEST strong band (code line is usually the last line). */
  preferLowest?: boolean;
  /** Minimum band height at analysis scale to count as text. */
  minBandPx?: number;
}

const DEFAULTS: Required<LineFindOptions> = {
  maxWidth: 720,
  preferLowest: true,
  minBandPx: 7,
};

function nearestDownscale(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh);
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, ((y * sh) / dh) | 0);
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, ((x * sw) / dw) | 0);
      out[y * dw + x] = src[sy * sw + sx];
    }
  }
  return out;
}

/**
 * Find text lines in a grayscale region. Returns strongest-first bands.
 * Pure and deterministic — identical in browser and offline benchmark.
 */
export function findTextLines(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  options: LineFindOptions = {},
): LineRegion[] {
  const o = { ...DEFAULTS, ...options };
  let aw = width;
  let ah = height;
  let g: Uint8ClampedArray = gray;
  let scaleX = 1;
  let scaleY = 1;
  if (width > o.maxWidth) {
    scaleX = width / o.maxWidth;
    aw = o.maxWidth;
    ah = Math.max(4, Math.round(height / scaleX));
    scaleY = height / ah;
    g = nearestDownscale(gray, width, height, aw, ah);
  }

  // Vertical-edge energy per row (text strokes). Interior only.
  const rows = new Float64Array(ah);
  let total = 0;
  for (let y = 1; y < ah - 1; y += 1) {
    const rowUp = (y - 1) * aw;
    const rowDn = (y + 1) * aw;
    let e = 0;
    for (let x = 1; x < aw - 1; x += 1) {
      const gy = g[rowDn + x] - g[rowUp + x]; // vertical gradient only
      e += gy < 0 ? -gy : gy;
    }
    rows[y] = e;
    total += e;
  }
  const n = ah - 2;
  const mean = total / Math.max(1, n);
  if (!(mean > 0)) return [];

  // Row floor: text rows sit well above empty-label background.
  const floor = Math.max(1, mean * 0.5);
  // Merge contiguous rows above the floor into bands.
  const bands: Array<{ y0: number; y1: number; energy: number; peak: number }> = [];
  let y = 1;
  while (y < ah - 1) {
    if (rows[y] < floor) {
      y += 1;
      continue;
    }
    let y0 = y;
    let energy = 0;
    let peak = 0;
    while (y < ah - 1 && rows[y] >= floor) {
      energy += rows[y];
      if (rows[y] > peak) peak = rows[y];
      y += 1;
    }
    bands.push({ y0, y1: y, energy, peak });
  }

  // Column extent per band (x where the band's rows actually have edges).
  const withX = bands
    .filter((b) => b.y1 - b.y0 >= o.minBandPx)
    .map((b) => {
      let minX = aw - 1;
      let maxX = 0;
      let colEnergy = 0;
      for (let yy = b.y0; yy < b.y1; yy += 1) {
        for (let xx = 1; xx < aw - 1; xx += 1) {
          const gv = g[(yy + 1) * aw + xx] - g[(yy - 1) * aw + xx];
          const a = gv < 0 ? -gv : gv;
          if (a > 0) {
            colEnergy += a;
            if (xx < minX) minX = xx;
            if (xx > maxX) maxX = xx;
          }
        }
      }
      return { ...b, minX, maxX, colEnergy };
    })
    .filter((b) => b.maxX > b.minX);

  if (!withX.length) return [];

  const bestEnergy = Math.max(...withX.map((b) => b.energy));
  const cy = ah / 2;
  const lines: LineRegion[] = withX
    .map((b) => {
      const mid = (b.y0 + b.y1) / 2;
      const centered = Math.max(0, 1 - Math.abs(mid - cy) / Math.max(1, ah / 2));
      return {
        x0: Math.round(b.minX * scaleX),
        y0: Math.round(b.y0 * scaleY),
        x1: Math.round(b.maxX * scaleX + 1),
        y1: Math.round(b.y1 * scaleY),
        score: b.energy / bestEnergy,
        centered,
      };
    })
    .sort((a, b) => {
      if (o.preferLowest) {
        const diff = b.score - a.score;
        if (Math.abs(diff) > 0.001) return diff;
        return b.y0 - a.y0; // equal strength → lower band wins
      }
      return b.score - a.score;
    });
  return lines;
}

/** Strongest single text line (dynamic ROI candidate), or null. */
export function findDominantLine(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  options: LineFindOptions = {},
): LineRegion | null {
  return findTextLines(gray, width, height, options)[0] ?? null;
}

/**
 * Grow a detected line into an OCR-safe crop box (margin as a fraction of the
 * line height), clamped to the region. Returns null when the line is too thin
 * to OCR meaningfully.
 */
export function lineCropBox(
  line: LineRegion,
  regionWidth: number,
  regionHeight: number,
  marginFraction = 0.5,
): { x: number; y: number; width: number; height: number } | null {
  const lh = line.y1 - line.y0;
  const lw = line.x1 - line.x0;
  if (lh < 2 || lw < 4) return null;
  const pad = Math.max(1, Math.round(lh * marginFraction));
  const x = Math.max(0, line.x0 - Math.max(1, Math.round(lw * 0.02)));
  const y = Math.max(0, line.y0 - pad);
  const x1 = Math.min(regionWidth, line.x1 + Math.max(1, Math.round(lw * 0.02)));
  const y1 = Math.min(regionHeight, line.y1 + pad);
  if (x1 - x < 4 || y1 - y < 3) return null;
  return { x, y, width: x1 - x, height: y1 - y };
}

/**
 * Deskew decision for the DYNAMIC line crop (unified P0 §9): upright lines
 * keep the caller's profile; a real tilt routes the crop through the ROTATED
 * profile (which estimates + corrects skew). Pure.
 */
export function profileForLineSkew(skewDeg: number, base: string): string {
  return Math.abs(skewDeg) >= 0.75 ? 'D_ROTATED' : base;
}
