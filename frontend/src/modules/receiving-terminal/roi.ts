/**
 * Region Of Interest helpers (codebase spec §18 + P0 order §5).
 *
 * Both engines — barcode/QR detection and OCR — must prioritise the SAME
 * region the worker is told to align the label into, and the ROI must be the
 * same rectangle in code, overlay, quality crop and OCR crop.
 *
 * The ROI is adjustable per label type (order §5): carton labels use a wide
 * band, product/SKU labels a taller one. Ratios come from `scan-config`.
 */

import { legacyPreprocess } from './preprocess';
import { grayToPixels, toGray } from './pixels';

export interface Roi {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RoiRatio {
  w: number;
  h: number;
}

/** Legacy default ROI (wide central band). */
export const ROI_RATIO = { w: 0.82, h: 0.30 } as const;

/** Pixel ROI for a frame of the given size and ratio. */
export function computeRoi(frameWidth: number, frameHeight: number, ratio: RoiRatio = ROI_RATIO): Roi {
  const width = Math.max(16, Math.round(frameWidth * ratio.w));
  const height = Math.max(8, Math.round(frameHeight * ratio.h));
  return {
    x: Math.round((frameWidth - width) / 2),
    y: Math.round((frameHeight - height) / 2),
    width,
    height,
  };
}

/** CSS overlay box (percent of the video stage) for the same ratio — used so
 *  the on-screen frame always matches the analysed ROI for the current mode. */
export function roiOverlayStyle(ratio: RoiRatio): { left: string; top: string; width: string; height: string } {
  const wPct = ratio.w * 100;
  const hPct = ratio.h * 100;
  return {
    left: `${(100 - wPct) / 2}%`,
    top: `${(100 - hPct) / 2}%`,
    width: `${wPct}%`,
    height: `${hPct}%`,
  };
}

/**
 * Legacy OCR preprocessing — kept byte-for-byte equivalent for backward
 * compatibility and as the measurable “before” baseline in the §17 benchmark.
 * New pipeline code should use `preprocess.applyProfile`.
 */
export function preprocessForOcr(source: ImageData): ImageData {
  const gray = legacyPreprocess(toGray(source));
  const px = grayToPixels(gray, source.width, source.height);
  return new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.width, px.height);
}

/** Browser-only: build an HTMLCanvasElement from a (binarised) luma buffer. */
export function canvasFromGray(gray: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return cv;
  const px = grayToPixels(gray, width, height);
  ctx.putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0);
  return cv;
}
