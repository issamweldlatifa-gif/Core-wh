/**
 * Image Quality Gate — order §6.
 *
 * Runs BEFORE OCR is allowed. It inspects the ROI that the worker is aligning
 * and decides whether feeding it to OCR would be a waste (OCR on a bad photo
 * cannot be fixed by a better model). When the gate fails, OCR is NOT run and
 * the worker receives targeted guidance instead:
 *
 *   «Move closer / Hold steady / Improve lighting / Align label inside frame»
 *
 * Design rules:
 *   - Pure arithmetic over a luma buffer → identical behaviour in browser and
 *     in the offline benchmark.
 *   - Returns machine-readable ids (reasons) plus human guidance text; the UI
 *     renders the latter.
 *   - Thresholds are exported so the real-label benchmark (§17) can tune them.
 *   - Everything here is advisory: it never rejects a barcode read (barcode
 *     decode is deterministic and keeps priority over OCR, §12).
 */

import type { Gray } from './pixels';

export type QualityLevel = 'GOOD' | 'MARGINAL' | 'BAD';

export type GuidanceId =
  | 'no_label'
  | 'blurred'
  | 'motion_blur'
  | 'low_light'
  | 'glare'
  | 'small_text'
  | 'label_cropped'
  | 'ok';

export interface QualityMetrics {
  level: QualityLevel;
  /** 0..1 composite quality used by the confidence model (1 = perfect). */
  score: number;
  /** Passes the gate → OCR may run. Fails → DO NOT RUN OCR (§6). */
  pass: boolean;
  reasons: GuidanceId[];
  /** Short worker guidance (top reasons). */
  advice: string[];
  meanGray: number;
  stdGray: number;
  darkPixRatio: number;
  saturPixRatio: number;
  edgeRatio: number;
  sharpness: number; // 0..1 normalised variance of gradient magnitude
  hGradVsVGrad: number; // >1 horizontal structure dominates (rotation/motion hint)
  textBBox: { x: number; y: number; w: number; h: number } | null;
  coverage: number; // edge bounding-box area / ROI area
  analysisW: number;
  analysisH: number;
}

/**
 * tune: initial values verified on the synthetic label set (unit tests);
 * revisit against real warehouse labels in the §17 benchmark.
 */
export const QUALITY_THRESHOLDS = {
  darkCutoff: 28, // luma below this counts as “near black”
  darkMeanBad: 62, // ROI mean below this ⇒ unusably dark (block OCR)
  darkMeanMarginal: 112, // dim ⇒ OCR discouraged but allowed at worker risk
  saturCutoff: 246, // luma above this counts as blown/specular
  saturBad: 0.05, // >5% blown pixels ⇒ glare handling required
  saturMarginal: 0.02,
  minEdgeRatio: 0.008, // below this the ROI has (almost) no text
  sharpBad: 0.5, // normalised edge variance below this ⇒ blur (block OCR)
  sharpMarginal: 0.75,
  smallTextCoverage: 0.035, // crisp but tiny text bbox ⇒ “Move closer”
} as const;

/**
 * Sharpeness normaliser scale: maps the coefficient-of-variation² of Sobel
 * magnitudes into 0..1. CV² = magVar / magMean² is brightness-invariant, so a
 * dim-but-sharp label scores the same as a well-lit one (verified on the §17
 * synthetic set: clear≈21, low-light≈21, soft low-DPI print≈9-13, gaussian
 * blur r≥2.5≈8-9). The old absolute normaliser misclassified dim labels as
 * «blurred» and told workers to hold steady when they needed light.
 */
export const SHARPNESS_CV2_SCALE = 12;

export const GUIDANCE_TEXT: Record<GuidanceId, string> = {
  no_label: 'Align label inside the frame',
  blurred: 'Hold steady',
  motion_blur: 'Hold steady — do not move while scanning',
  low_light: 'Improve lighting',
  glare: 'Tilt label away from glare',
  small_text: 'Move closer',
  label_cropped: 'Move label fully inside the frame',
  ok: '',
};

interface SobelResult {
  mag: Float32Array;
  hEnergy: number;
  vEnergy: number;
}

/** One-pass Sobel: magnitude image + horizontal/vertical gradient energies. */
function sobel(gray: Gray, width: number, height: number): SobelResult {
  const mag = new Float32Array(gray.length);
  let hEnergy = 0;
  let vEnergy = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const row0 = (y - 1) * width;
    const row1 = y * width;
    const row2 = (y + 1) * width;
    for (let x = 1; x < width - 1; x += 1) {
      const i00 = gray[row0 + x - 1];
      const i01 = gray[row0 + x];
      const i02 = gray[row0 + x + 1];
      const i10 = gray[row1 + x - 1];
      const i12 = gray[row1 + x + 1];
      const i20 = gray[row2 + x - 1];
      const i21 = gray[row2 + x];
      const i22 = gray[row2 + x + 1];
      const gx = -i00 + i02 - 2 * i10 + 2 * i12 - i20 + i22;
      const gy = i00 + 2 * i01 + i02 - i20 - 2 * i21 - i22;
      mag[row1 + x] = Math.sqrt(gx * gx + gy * gy);
      hEnergy += Math.abs(gx);
      vEnergy += Math.abs(gy);
    }
  }
  return { mag, hEnergy, vEnergy };
}

function downscaleNearest(src: Gray, sw: number, sh: number, dw: number, dh: number): Gray {
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

/** Otsu threshold over a magnitude buffer (edge/no-edge split). */
function otsuCutoff(mag: Float32Array): number {
  const H = 256;
  const hist = new Float64Array(H);
  let runningMax = 0;
  for (let i = 0; i < mag.length; i += 1) if (mag[i] > runningMax) runningMax = mag[i];
  const span = Math.max(1, runningMax);
  const total = mag.length;
  for (let i = 0; i < total; i += 1) {
    hist[Math.min(H - 1, ((mag[i] / span) * 255) | 0)] += 1;
  }
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
  return Math.max(1, (best / H) * span);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Evaluate ROI quality. `gray` is the ROI luma buffer; internally downscaled
 * to at most 720px wide so thresholds stay scale-stable and cost stays low.
 */
export function assessQuality(gray: Gray, width: number, height: number): QualityMetrics {
  let aw = width;
  let ah = height;
  let g: Gray = gray;
  const ANALYSIS_MAX = 720;
  if (width > ANALYSIS_MAX) {
    aw = ANALYSIS_MAX;
    ah = Math.max(2, Math.round((height * ANALYSIS_MAX) / width));
    g = downscaleNearest(gray, width, height, aw, ah);
  }
  const n = aw * ah;

  let sum = 0;
  let sumSq = 0;
  let dark = 0;
  let satur = 0;
  for (let i = 0; i < n; i += 1) {
    const v = g[i];
    sum += v;
    sumSq += v * v;
    if (v < QUALITY_THRESHOLDS.darkCutoff) dark += 1;
    if (v > QUALITY_THRESHOLDS.saturCutoff) satur += 1;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));

  const { mag, hEnergy, vEnergy } = sobel(g, aw, ah);
  const cutoff = otsuCutoff(mag);
  let edgeCount = 0;
  let magSum = 0;
  let magSumSq = 0;
  let minX = aw;
  let minY = ah;
  let maxX = -1;
  let maxY = -1;
  for (let y = 1; y < ah - 1; y += 1) {
    for (let x = 1; x < aw - 1; x += 1) {
      const m = mag[y * aw + x];
      magSum += m;
      magSumSq += m * m;
      if (m >= cutoff) {
        edgeCount += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const edgeRatio = edgeCount / n;
  const magMean = magSum / Math.max(1, n);
  const magVar = magSumSq / Math.max(1, n) - magMean * magMean;
  // Coefficient-of-variation² of gradient magnitude — brightness-invariant.
  // A dim-but-crisp label keeps its crispness score; only genuinely smeared
  // edges (defocus / motion blur / soft print) drop (calibrated on §17 set).
  const sharpness = magMean > 1e-6
    ? clamp(magVar / (magMean * magMean * SHARPNESS_CV2_SCALE), 0, 1)
    : 0;

  const hasText = edgeRatio > QUALITY_THRESHOLDS.minEdgeRatio;
  const textBBox = hasText
    ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
    : null;
  const coverage = hasText && textBBox ? Math.min(1, (textBBox.w * textBBox.h) / ((aw - 2) * (ah - 2))) : 0;

  const darkPixRatio = dark / n;
  const saturPixRatio = satur / n;
  const hGradVsVGrad = vEnergy > 0.0001 ? hEnergy / vEnergy : 1;

  const reasons: GuidanceId[] = [];
  let level: QualityLevel = 'GOOD';
  const push = (id: GuidanceId, severity: 'bad' | 'marginal') => {
    if (!reasons.includes(id)) reasons.push(id);
    if (severity === 'bad') level = 'BAD';
    else if (level === 'GOOD') level = 'MARGINAL';
  };

  if (!hasText) {
    push('no_label', 'bad');
  } else {
    if (sharpness < QUALITY_THRESHOLDS.sharpBad) push('blurred', 'bad');
    else if (sharpness < QUALITY_THRESHOLDS.sharpMarginal) push('blurred', 'marginal');
    // A crisp but very small bbox = genuinely small/far text → “Move closer”,
    // not “no label”: it is still a label, OCR just needs it bigger.
    if (coverage < QUALITY_THRESHOLDS.smallTextCoverage) push('small_text', 'marginal');
    if (minX <= 1 || minY <= 1 || maxX >= aw - 2 || maxY >= ah - 2) {
      push('label_cropped', 'marginal');
    }
  }
  // Whole-frame darkness is the low-light signal — the dark pixel ratio alone
  // is not, because black label ink is *supposed* to be dark.
  if (mean < QUALITY_THRESHOLDS.darkMeanBad) push('low_light', 'bad');
  else if (mean < QUALITY_THRESHOLDS.darkMeanMarginal) push('low_light', 'marginal');
  // Blown specular highlights (glare).
  if (saturPixRatio > QUALITY_THRESHOLDS.saturBad) push('glare', 'marginal');
  else if (saturPixRatio > QUALITY_THRESHOLDS.saturMarginal) push('glare', 'marginal');
  if (hGradVsVGrad > 3.2 || hGradVsVGrad < 0.3) push('motion_blur', 'marginal');

  const ordered: GuidanceId[] = [
    // Lighting first: a dim frame that also reads as soft is almost always
    // just under-lit — «Improve lighting» is the right first instruction.
    'no_label', 'label_cropped', 'low_light', 'glare', 'blurred', 'motion_blur', 'small_text',
  ];
  const uniqueReasons = ordered.filter((r) => reasons.includes(r));

  let score = 1;
  const penalties: Record<QualityLevel, number> = { BAD: 0.45, MARGINAL: 0.18, GOOD: 0 };
  if (hasText && textBBox) {
    score = clamp(score - penalties[level], 0, 1);
    if (mean < QUALITY_THRESHOLDS.darkMeanBad) score -= 0.15;
    else if (mean < QUALITY_THRESHOLDS.darkMeanMarginal) score -= 0.05;
    if (saturPixRatio > QUALITY_THRESHOLDS.saturBad) score -= 0.06;
  } else {
    score = 0;
  }
  score = clamp(score, 0, 1);

  return {
    level,
    score,
    // cast: TS narrows `level` past the closure writes made by push()
    pass: (level as QualityLevel) !== 'BAD',
    reasons: uniqueReasons,
    advice: uniqueReasons.slice(0, 2).map((r) => GUIDANCE_TEXT[r]),
    meanGray: mean,
    stdGray: std,
    darkPixRatio,
    saturPixRatio,
    edgeRatio,
    sharpness,
    hGradVsVGrad,
    textBBox,
    coverage,
    analysisW: aw,
    analysisH: ah,
  };
}

/** Cheap live-guidance probe (sampled grid) for the always-on status strip. */
export function quickGuidance(
  gray: Gray,
  width: number,
  height: number,
): { level: QualityLevel; hint: GuidanceId[] } {
  const sx = Math.max(4, (width / 120) | 0);
  const sy = Math.max(4, (height / 60) | 0);
  let dark = 0;
  let sat = 0;
  let samples = 0;
  let sum = 0;
  for (let y = 0; y < height; y += sy) {
    for (let x = 0; x < width; x += sx) {
      const v = gray[y * width + x];
      sum += v;
      samples += 1;
      if (v < QUALITY_THRESHOLDS.darkCutoff) dark += 1;
      if (v > QUALITY_THRESHOLDS.saturCutoff) sat += 1;
    }
  }
  const darkR = samples ? dark / samples : 0;
  const satR = samples ? sat / samples : 0;
  const mean = samples ? sum / samples : 128;
  const hints: GuidanceId[] = [];
  if (mean < QUALITY_THRESHOLDS.darkMeanBad && darkR > 0.02) hints.push('low_light');
  else if (mean < QUALITY_THRESHOLDS.darkMeanMarginal && darkR > 0.02) hints.push('low_light');
  if (satR > QUALITY_THRESHOLDS.saturBad) hints.push('glare');
  return { level: hints.length ? 'MARGINAL' : 'GOOD', hint: hints };
}
