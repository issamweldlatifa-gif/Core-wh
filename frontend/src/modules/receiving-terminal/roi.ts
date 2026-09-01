/**
 * Region Of Interest helpers (spec §18).
 *
 * Both engines — barcode/QR detection and OCR — must prioritise the SAME
 * region the worker is told to align the label into. Cropping before OCR is
 * also the single biggest performance win on a phone (§42): Tesseract cost
 * scales with pixel count, and the ROI is roughly a tenth of the frame.
 */

export interface Roi {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ROI as a fraction of the frame: a wide, central band. */
export const ROI_RATIO = { w: 0.82, h: 0.30 } as const;

/** Compute the pixel ROI for a frame of the given size. */
export function computeRoi(frameWidth: number, frameHeight: number): Roi {
  const width = Math.round(frameWidth * ROI_RATIO.w);
  const height = Math.round(frameHeight * ROI_RATIO.h);
  return {
    x: Math.round((frameWidth - width) / 2),
    y: Math.round((frameHeight - height) / 2),
    width,
    height,
  };
}

/**
 * Preprocess the ROI for OCR (§20): greyscale, contrast stretch, then a
 * light adaptive threshold. Printed labels are high-contrast black-on-white,
 * so binarising sharply improves Tesseract accuracy and speed versus feeding
 * it a raw colour photo.
 */
export function preprocessForOcr(source: ImageData): ImageData {
  const { data, width, height } = source;
  const gray = new Uint8ClampedArray(width * height);

  let min = 255;
  let max = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    gray[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }

  // Contrast stretch; guard against a flat frame (min === max).
  const span = Math.max(1, max - min);
  let sum = 0;
  for (let p = 0; p < gray.length; p += 1) {
    const v = ((gray[p] - min) * 255) / span;
    gray[p] = v;
    sum += v;
  }

  // Global mean threshold with a small bias keeps thin glyph strokes intact.
  const mean = sum / gray.length;
  const cut = mean * 0.92;

  const out = new ImageData(width, height);
  for (let p = 0, i = 0; p < gray.length; p += 1, i += 4) {
    const v = gray[p] > cut ? 255 : 0;
    out.data[i] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}
