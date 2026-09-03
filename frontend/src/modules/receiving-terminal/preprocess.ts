/**
 * Preprocessing profiles for OCR — order §7.
 *
 * One fixed recipe (the old grayscale → stretch → global threshold) cannot
 * serve every real condition. Instead we ship several profiles and pick the
 * best one from the Image Quality Gate measurements:
 *
 *   A_NORMAL     — clean, evenly lit label
 *   B_LOW_LIGHT  — dark frame: gamma lift + stretch + threshold
 *   C_SMALL_TEXT — upscale first, then threshold (small glyphs)
 *   D_ROTATED    — estimate skew, deskew, then threshold
 *   E_GLARE      — clip blown highlights before thresholding
 *
 *   LEGACY_GLOBAL — the exact old recipe, kept as the measurable "before"
 *                   baseline for the §17 benchmark and for `roi.ts` compat.
 *
 * Not every profile runs every step (order §7: "لا تستخدم جميع مراحل
 * preprocessing دائمًا"). Everything is pure arithmetic over luma buffers so
 * it runs identically in-browser and in the offline benchmark.
 */

import {
  median3,
  rotateGray,
  scaleGray,
  toGray,
  type Gray,
  type Pixels,
} from './pixels';
import type { QualityMetrics } from './image-quality';

export type ProfileId = 'A_NORMAL' | 'B_LOW_LIGHT' | 'C_SMALL_TEXT' | 'D_ROTATED' | 'E_GLARE' | 'LEGACY_GLOBAL';

export interface PreprocessOptions {
  smallTextUpscale?: number;
  /** Hard cap on the largest dimension after any upscale (latency bound). */
  maxWidth?: number;
  rotate?: boolean; // allow profile D to rotate (default true)
}

export interface PreprocessResult {
  gray: Gray;
  width: number;
  height: number;
  profile: ProfileId;
  /** Diagnostics: which transformations actually ran. */
  steps: string[];
  /** Estimated skew (degrees) when profile D ran, else 0. */
  skewDeg?: number;
  scale?: number;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Otsu global threshold over a luma buffer; returns the cutoff value. */
export function otsuThreshold(gray: Gray): number {
  const H = 256;
  const hist = new Float64Array(H);
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < H; t += 1) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let maxVar = -1;
  for (let t = 0; t < H; t += 1) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      best = t;
    }
  }
  return best;
}

function binarize(gray: Gray, cut: number): Gray {
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) out[i] = gray[i] > cut ? 255 : 0;
  return out;
}

/** Percentile contrast stretch (clips specular black/white tails). */
export function percentileStretch(gray: Gray, loQ = 0.015, hiQ = 0.985): Gray {
  const H = 256;
  const hist = new Float64Array(H);
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
  const total = gray.length;
  const loN = total * loQ;
  const hiN = total * hiQ;
  let lo = 0;
  let hi = 255;
  let acc = 0;
  for (let t = 0; t < H; t += 1) {
    acc += hist[t];
    if (acc >= loN) { lo = t; break; }
  }
  acc = 0;
  for (let t = 0; t < H; t += 1) {
    acc += hist[t];
    if (acc >= hiN) { hi = t; break; }
  }
  if (hi <= lo) return gray;
  const span = hi - lo;
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    out[i] = clamp(((gray[i] - lo) / span) * 255);
  }
  return out;
}

/** Simple gamma correction (value ~0.8 lifts dark mid-tones). */
export function gammaCorrect(gray: Gray, gamma: number): Gray {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v += 1) lut[v] = clamp(255 * Math.pow(v / 255, 1 / gamma) | 0);
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) out[i] = lut[gray[i]];
  return out;
}

/**
 * Adaptive local threshold via integral image (window ~ s/8). Keeps glyph
 * strokes when illumination varies across the ROI.
 */
export function adaptiveThreshold(gray: Gray, width: number, height: number, C = 12): Gray {
  const int = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    const row = (y + 1) * (width + 1);
    const pRow = y * (width + 1);
    let s = 0;
    for (let x = 0; x < width; x += 1) {
      s += gray[y * width + x];
      int[row + x + 1] = int[pRow + x + 1] + s;
    }
  }
  const win = Math.max(3, Math.round(Math.min(width, height) / 8));
  const half = win >> 1;
  const out = new Uint8ClampedArray(gray.length);
  const sumArea = (x0: number, y0: number, x1: number, y1: number) =>
    int[(y1) * (width + 1) + x1] - int[y0 * (width + 1) + x1] - int[y1 * (width + 1) + x0] + int[y0 * (width + 1) + x0];
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height, y + half + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width, x + half + 1);
      const area = (x1 - x0) * (y1 - y0);
      const mean = sumArea(x0, y0, x1, y1) / area;
      out[y * width + x] = gray[y * width + x] > mean - C ? 255 : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// deskew (profile D)
// ---------------------------------------------------------------------------

/** Estimate the skew angle of text in a luma buffer (downsampled internally). */
export function estimateSkewDeg(gray: Gray, width: number, height: number): number {
  // Analysis at most ~360px wide keeps the scan cheap.
  const AW = 360;
  let g = gray;
  let w = width;
  let h = height;
  if (width > AW) {
    w = AW;
    h = Math.max(2, ((height * AW) / width) | 0);
    g = scaleGray(gray, width, height, w, h);
  }
  // Score = sum of squared per-row DARK-pixel counts after rotating by the
  // candidate angle. Straight text concentrates dark pixels into a few heavy
  // text lines → score is maximal at the de-skewing angle; a skewed image
  // smears glyphs across rows. Rotation fills out-of-range with bright 255,
  // which contributes 0 dark pixels and never corrupts the objective.
  const DARK = 100;
  const score = (angle: number): number => {
    const r = rotateGray(g, w, h, angle);
    let energy = 0;
    for (let y = 0; y < h; y += 1) {
      let cnt = 0;
      const row = y * w;
      for (let x = 0; x < w; x += 1) if (r[row + x] < DARK) cnt += 1;
      energy += cnt * cnt;
    }
    return energy;
  };
  let best = 0;
  let bestE = -1;
  const coarse: number[] = [];
  for (let a = -15; a <= 15; a += 1.5) coarse.push(a);
  for (const a of coarse) {
    const e = score(a);
    if (e > bestE) { bestE = e; best = a; }
  }
  // Refine ±1.5° at 0.5° steps around the coarse peak.
  for (let a = best - 1.5; a <= best + 1.5 + 0.001; a += 0.5) {
    const e = score(a);
    if (e > bestE) { bestE = e; best = a; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// the profile table
// ---------------------------------------------------------------------------

export interface ProfileRunner {
  (gray: Gray, width: number, height: number, o: Required<Pick<PreprocessOptions, 'smallTextUpscale' | 'maxWidth'>>):
    PreprocessResult;
}

function profileA(gray: Gray, width: number, height: number): PreprocessResult {
  const stretched = percentileStretch(gray);
  const cut = otsuThreshold(stretched);
  return {
    gray: binarize(stretched, cut), width, height,
    profile: 'A_NORMAL', steps: ['stretch', 'otsu'],
  };
}

function profileB(gray: Gray, width: number, height: number): PreprocessResult {
  const lifted = gammaCorrect(gray, 0.72);
  const stretched = percentileStretch(lifted, 0.01, 0.99);
  const cut = otsuThreshold(stretched);
  return {
    gray: binarize(stretched, cut), width, height,
    profile: 'B_LOW_LIGHT', steps: ['gamma0.72', 'stretch', 'otsu'],
  };
}

function profileC(
  gray: Gray, width: number, height: number,
  o: { smallTextUpscale: number; maxWidth: number },
): PreprocessResult {
  let scale = o.smallTextUpscale > 1 ? o.smallTextUpscale : 1;
  let g = gray;
  let w = width;
  let h = height;
  const steps = ['upscale'];
  if (scale > 1) {
    let nw = Math.round(width * scale);
    let nh = Math.round(height * scale);
    if (nw > o.maxWidth) {
      const f = o.maxWidth / nw;
      nw = o.maxWidth;
      nh = Math.max(2, Math.round(nh * f));
      scale = f;
    }
    g = scaleGray(gray, width, height, nw, nh);
    w = nw;
    h = nh;
    steps.push(`x${scale.toFixed(2)}`);
  }
  const stretched = percentileStretch(g);
  const cut = otsuThreshold(stretched);
  return {
    gray: binarize(stretched, cut), width: w, height: h,
    profile: 'C_SMALL_TEXT', steps: [...steps, 'otsu'], scale,
  };
}

function profileD(gray: Gray, width: number, height: number, allowRotate: boolean): PreprocessResult {
  if (!allowRotate) return profileA(gray, width, height);
  const skew = estimateSkewDeg(gray, width, height);
  const steps = ['deskew'];
  if (Math.abs(skew) < 0.75) return profileA(gray, width, height);
  const rotated = rotateGray(gray, width, height, skew);
  const cut = otsuThreshold(rotated);
  return {
    gray: binarize(rotated, cut), width, height,
    profile: 'D_ROTATED', steps: [...steps, `skew${skew.toFixed(1)}°`, 'otsu'], skewDeg: skew,
  };
}

function profileE(gray: Gray, width: number, height: number): PreprocessResult {
  // Kill blown highlights (glare) by soft-clipping the top tail BEFORE binarising.
  const H = 256;
  const hist = new Float64Array(H);
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
  const total = gray.length;
  let acc = 0;
  let clip = 255;
  for (let t = 255; t >= 0; t -= 1) {
    acc += hist[t];
    if (acc >= total * 0.04) { clip = t; break; }
  }
  clip = Math.min(255, clip + 8);
  const stretched = percentileStretch(gray);
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    out[i] = clamp(((stretched[i] / Math.max(1, clip)) * 210));
  }
  const cut = otsuThreshold(out);
  return {
    gray: binarize(out, cut), width, height,
    profile: 'E_GLARE', steps: ['clipGlare', 'otsu'],
  };
}

/** The exact legacy recipe (contrast stretch + mean×0.92 global threshold). */
export function legacyPreprocess(gray: Gray): Gray {
  let min = 255;
  let max = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const v = gray[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = Math.max(1, max - min);
  const stretched = new Uint8ClampedArray(gray.length);
  let sum = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const v = ((gray[i] - min) / span) * 255;
    stretched[i] = v;
    sum += v;
  }
  const mean = sum / gray.length;
  const cut = mean * 0.92;
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) out[i] = stretched[i] > cut ? 255 : 0;
  return out;
}

/** Apply a profile to RGBA pixels; returns binarised luma result. */
export function applyProfile(src: Pixels, profile: ProfileId, opts: PreprocessOptions = {}): PreprocessResult {
  const gray = toGray(src);
  const smallTextUpscale = opts.smallTextUpscale ?? 2;
  const maxWidth = opts.maxWidth ?? 960;
  const allowRotate = opts.rotate !== false;
  const o = { smallTextUpscale, maxWidth };
  switch (profile) {
    case 'A_NORMAL': return profileA(gray, src.width, src.height);
    case 'B_LOW_LIGHT': return profileB(gray, src.width, src.height);
    case 'C_SMALL_TEXT': return profileC(gray, src.width, src.height, o);
    case 'D_ROTATED': return profileD(gray, src.width, src.height, allowRotate);
    case 'E_GLARE': return profileE(gray, src.width, src.height);
    case 'LEGACY_GLOBAL':
      return {
        gray: legacyPreprocess(gray), width: src.width, height: src.height,
        profile: 'LEGACY_GLOBAL', steps: ['stretch', 'meanThreshold'],
      };
    default:
      return profileA(gray, src.width, src.height);
  }
}

/** Choose the profile best suited to the measured quality of the ROI. */
export function selectProfile(metrics: QualityMetrics | null): ProfileId {
  if (!metrics) return 'A_NORMAL';
  // Priority is about the most damaging failure mode for THIS image.
  if (metrics.saturPixRatio > 0.10) return 'E_GLARE';
  if (metrics.darkPixRatio > 0.30 && metrics.meanGray < 70) return 'B_LOW_LIGHT';
  if (metrics.reasons.includes('small_text') && metrics.sharpness > 0.12) return 'C_SMALL_TEXT';
  // Strong one-axis dominance often means the label is tilted in frame.
  if (metrics.hGradVsVGrad > 2.8 || metrics.hGradVsVGrad < 0.34) return 'D_ROTATED';
  if (metrics.meanGray < 110) return 'B_LOW_LIGHT';
  return 'A_NORMAL';
}
