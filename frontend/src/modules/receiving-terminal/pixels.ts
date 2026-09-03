/**
 * Shared raster helpers for the OCR pipeline (P0 Scanner+OCR batch).
 *
 * Everything image-related below operates on a minimal structural type
 * (`Pixels`) instead of the DOM `ImageData` class so the exact same code can:
 *   - run in the browser against real camera frames (ImageData conforms),
 *   - run in Node for unit tests and the offline label benchmark
 *     (`frontend/benchmark`), where no DOM canvas exists.
 *
 * No frame is ever stored or uploaded — these functions only transform
 * pixels in memory (order §16/§19).
 */

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, in row-major order — same layout as ImageData. */
  data: Uint8ClampedArray;
}

export type Gray = Uint8ClampedArray;

/** Precompute the 4-luma weights once (BT.601). */
const R = 0.299;
const G = 0.587;
const B = 0.114;

/** Luma (0..255) of the RGBA buffer at pixel index i (raster row-major). */
export function lumaAt(data: Uint8ClampedArray, i: number): number {
  const p = i << 2; // i * 4
  return (data[p] * R + data[p + 1] * G + data[p + 2] * B) | 0;
}

/** Convert an RGBA buffer into a single-channel luma buffer. */
export function toGray(src: Pixels): Gray {
  const { data, width, height } = src;
  const n = width * height;
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i += 1) out[i] = lumaAt(data, i);
  return out;
}

/** Wrap a luma buffer back into RGBA pixels (opaque black/white/gray). */
export function grayToRgba(gray: Gray, width: number, height: number): Pixels {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    const v = gray[i];
    out[p] = v;
    out[p + 1] = v;
    out[p + 2] = v;
    out[p + 3] = 255;
  }
  return { width, height, data: out };
}

export function grayToPixels(gray: Gray, width: number, height: number): Pixels {
  return grayToRgba(gray, width, height);
}

/** 3×3 box blur on a luma buffer (single pass, edges clamped). */
export function boxBlur3(gray: Gray, width: number, height: number): Gray {
  const out = new Uint8ClampedArray(gray.length);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let s = 0;
      let c = 0;
      for (let yy = y0; yy <= y1; yy += 1) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx += 1) {
          s += gray[row + xx];
          c += 1;
        }
      }
      out[y * width + x] = s / c;
    }
  }
  return out;
}

/** Median of up to 9 ints (for a 3×3 neighbourhood); used for denoise. */
function medianOf(values: number[]): number {
  const v = values.slice().sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** 3×3 median filter (light denoise that preserves edges). */
export function median3(gray: Gray, width: number, height: number): Gray {
  const out = new Uint8ClampedArray(gray.length);
  const win = new Array<number>(9);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let k = 0;
      for (let yy = y0; yy <= y1; yy += 1) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx += 1) win[k++] = gray[row + xx];
      }
      out[y * width + x] = medianOf(win.slice(0, k));
    }
  }
  return out;
}

/** Simple bilinear scale of a luma buffer (preserves glyph edges reasonably). */
export function scaleGray(
  src: Gray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Gray {
  if (dstW === srcW && dstH === srcH) return src.slice(0) as Gray;
  const out = new Uint8ClampedArray(dstW * dstH);
  const xr = srcW / dstW;
  const yr = srcH / dstH;
  for (let y = 0; y < dstH; y += 1) {
    const sy = y * yr;
    const y0 = Math.min(srcH - 1, sy | 0);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dstW; x += 1) {
      const sx = x * xr;
      const x0 = Math.min(srcW - 1, sx | 0);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = sx - x0;
      const v00 = src[y0 * srcW + x0];
      const v01 = src[y0 * srcW + x1];
      const v10 = src[y1 * srcW + x0];
      const v11 = src[y1 * srcW + x1];
      const top = v00 + (v01 - v00) * fx;
      const bot = v10 + (v11 - v10) * fx;
      out[y * dstW + x] = top + (bot - top) * fy;
    }
  }
  return out;
}

/** Rotate a luma buffer by `angleDeg` (clockwise) around its centre, bilinear. */
export function rotateGray(gray: Gray, width: number, height: number, angleDeg: number): Gray {
  if (!angleDeg) return gray;
  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const out = new Uint8ClampedArray(gray.length);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Inverse map: sample (sx, sy) from source for destination (x,y).
      const dx = x - cx;
      const dy = y - cy;
      const sx = dx * cosA + dy * sinA + cx;
      const sy = -dx * sinA + dy * cosA + cy;
      if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) {
        out[y * width + x] = 255;
        continue;
      }
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const v00 = gray[y0 * width + x0];
      const v01 = gray[y0 * width + x1];
      const v10 = gray[y1 * width + x0];
      const v11 = gray[y1 * width + x1];
      const top = v00 + (v01 - v00) * fx;
      const bot = v10 + (v11 - v10) * fx;
      out[y * width + x] = top + (bot - top) * fy;
    }
  }
  return out;
}

/** Crop a luma buffer to an integer rectangle. */
export function cropGray(
  gray: Gray,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Gray {
  const out = new Uint8ClampedArray(w * h);
  for (let yy = 0; yy < h; yy += 1) {
    const srow = (y + yy) * width + x;
    out.set(gray.subarray(srow, srow + w), yy * w);
  }
  return out;
}

/** Spatial variance of the Laplacian — the classic sharpness/blur detector. */
export function laplacianVariance(gray: Gray, width: number, height: number): number {
  const k = [
    [0, 1, 0],
    [1, -4, 1],
    [0, 1, 0],
  ];
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let lap = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          lap += gray[(y + dy) * width + (x + dx)] * k[dy + 1][dx + 1];
        }
      }
      sum += lap;
      sumSq += lap * lap;
      n += 1;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}
