/**
 * Pixel helpers for the PP-OCR port — tuned to reproduce cv2 semantics:
 *  - resizeBilinear mirrors cv2.resize(..., INTER_LINEAR): src = (dst + 0.5)*scale - 0.5
 *  - warpPerspectiveBicubic mirrors cv2.warpPerspective(..., INTER_CUBIC, BORDER_REPLICATE)
 *  - rotate180 / rotate90CCW mirror cv2.rotate(…, ROTATE_180) and np.rot90
 *
 * All image buffers are row-major planes; for multichannel we use pixel-interleaved
 * [x + (y*w + c)*?] helpers below with explicit channel stride = 1 (packed).
 */

export interface Image {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

export function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Packed-channel bilinear resize (1..4 channels). */
export function resizeBilinear(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  channels: number,
  dstW: number,
  dstH: number,
  dst?: Uint8Array,
): Uint8Array {
  const out = dst ?? new Uint8Array(dstW * dstH * channels);
  const sx = dstW > 1 ? (srcW - 0) / dstW : 0;
  const sy = dstH > 1 ? (srcH - 0) / dstH : 0;
  for (let y = 0; y < dstH; y++) {
    const srcY = (y + 0.5) * sy - 0.5;
    const y0 = Math.floor(srcY);
    const y1 = y0 + 1;
    const fy = srcY - y0;
    const ya = y0 < 0 ? 0 : y0 >= srcH ? srcH - 1 : y0;
    const yb = y1 < 0 ? 0 : y1 >= srcH ? srcH - 1 : y1;
    for (let x = 0; x < dstW; x++) {
      const srcX = (x + 0.5) * sx - 0.5;
      const x0 = Math.floor(srcX);
      const x1 = x0 + 1;
      const fx = srcX - x0;
      const xa = x0 < 0 ? 0 : x0 >= srcW ? srcW - 1 : x0;
      const xb = x1 < 0 ? 0 : x1 >= srcW ? srcW - 1 : x1;
      for (let c = 0; c < channels; c++) {
        const p00 = src[(ya * srcW + xa) * channels + c];
        const p01 = src[(ya * srcW + xb) * channels + c];
        const p10 = src[(yb * srcW + xa) * channels + c];
        const p11 = src[(yb * srcW + xb) * channels + c];
        const top = p00 + (p01 - p00) * fx;
        const bot = p10 + (p11 - p10) * fx;
        out[(y * dstW + x) * channels + c] = clampByte(Math.round(top + (bot - top) * fy));
      }
    }
  }
  return out;
}

/** Rotate 180° (same as cv2.rotate(img, ROTATE_180)). */
export function rotate180(src: Uint8Array, w: number, h: number, channels: number): Uint8Array {
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((h - 1 - y) * w + (w - 1 - x)) * channels;
      const d = (y * w + x) * channels;
      for (let c = 0; c < channels; c++) out[d + c] = src[s + c];
    }
  }
  return out;
}

/** Rotate 90° counter-clockwise (np.rot90) — output shape (h=srcW, w=srcH). */
export function rotate90CCW(src: Uint8Array, w: number, h: number, channels: number): Uint8Array {
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * channels; // src col x, row y (h,w)
      const d = (x * w + (w - 1 - y)) * channels; // dst size (w,h); row = x, col = w-1-y
      for (let c = 0; c < channels; c++) out[d + c] = src[s + c];
    }
  }
  return out;
}

/** 3x3 homography (row-major, 9 values) mapping SOURCE -> DEST. */
export type Homography = [number, number, number, number, number, number, number, number, number];

/** Invert a homography analytically. Returns null when singular. */
export function invertHomography(h: Homography): Homography | null {
  const [a, b, c, d, e, f, g, hh, i] = h;
  const det = a * (e * i - f * hh) - b * (d * i - f * g) + c * (d * hh - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    inv * (e * i - f * hh),
    inv * (c * hh - b * i),
    inv * (b * f - c * e),
    inv * (f * g - d * i),
    inv * (a * i - c * g),
    inv * (c * d - a * f),
    inv * (d * hh - e * g),
    inv * (b * g - a * hh),
    inv * (a * e - b * d),
  ];
}

/** Solve the homography mapping src quad -> dest quad (4 point correspondences). */
export function homographyFromQuads(
  src: [number, number][],
  dst: [number, number][],
): Homography {
  // Direct Linear Transform, 8x9 system → solve via Gaussian elimination on 9 unknowns.
  // Build A (8x9), solve least one null-space by elimination with pivot on last col.
  const A: number[] = [];
  const pushRow = (sx: number, sy: number, dx: number, dy: number) => {
    A.push(sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy, -dx);
    A.push(0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy, -dy);
  };
  for (let i = 0; i < 4; i++) pushRow(src[i][0], src[i][1], dst[i][0], dst[i][1]);
  return solveHomogeneous8x9(A);
}

/** Solve for the vector h (9) with Ah=0 using row-reduction (the 9th col is the RHS=0 pivot pattern). */
function solveHomogeneous8x9(A: number[]): Homography {
  // Standard approach: reduce to find h as the kernel. We perform elimination treating
  // column 9 as constants that will be scaled by the free variable h9 (set =1) unless pivot singular.
  const m = 8;
  const n = 9;
  const M: number[][] = [];
  for (let r = 0; r < m; r++) {
    M.push([]);
    for (let c = 0; c < n; c++) M[r].push(A[r * n + c]);
  }
  let pivots = 0;
  const where: number[] = new Array(n).fill(-1);
  for (let col = 0; col < n - 1 && pivots < m; col++) {
    let sel = -1;
    for (let r = pivots; r < m; r++) {
      if (Math.abs(M[r][col]) > 1e-9) {
        sel = r;
        break;
      }
    }
    if (sel < 0) continue;
    const tmp = M[sel];
    M[sel] = M[pivots];
    M[pivots] = tmp;
    const pv = M[pivots][col];
    for (let c = 0; c < n; c++) M[pivots][c] /= pv;
    for (let r = 0; r < m; r++) {
      if (r !== pivots && Math.abs(M[r][col]) > 1e-12) {
        const f = M[r][col];
        for (let c = 0; c < n; c++) M[r][c] -= f * M[pivots][c];
      }
    }
    where[col] = pivots;
    pivots++;
  }
  const x = new Array(n).fill(0);
  let freeCol = -1;
  for (let col = 0; col < n; col++) {
    if (where[col] < 0) {
      freeCol = col;
      break;
    }
  }
  if (freeCol < 0) freeCol = n - 1;
  x[freeCol] = 1;
  for (let col = 0; col < n; col++) {
    if (col === freeCol) continue;
    if (where[col] >= 0) {
      const r = where[col];
      // row r: x[col] = -sum_{c!=col} M[r][c]*x[c]   (M[r][col] == 1 after normalize)
      let s = 0;
      for (let c = 0; c < n; c++) if (c !== col) s += M[r][c] * x[c];
      x[col] = -s;
    }
  }
  const H = x as unknown as Homography;
  const s = Math.abs(H[8]) > 1e-12 ? H[8] : 1;
  for (let i = 0; i < 9; i++) H[i] /= s;
  return H;
}

/** Cubic convolution kernel (a = -0.75), matching cv2 INTER_CUBIC. */
function cubicKernel(t: number, a = -0.75): number {
  const x = Math.abs(t);
  if (x <= 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1;
  if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
  return 0;
}

/**
 * Sample a 3-channel (BGR-packed) image with bicubic interpolation + replicate border.
 */
function sampleBicubic3(src: Uint8Array, w: number, h: number, x: number, y: number, out: number[]): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    let wsum = 0;
    for (let j = -1; j <= 2; j++) {
      const yy = y0 + j;
      const yc = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
      const wy = cubicKernel(y - yy);
      for (let i = -1; i <= 2; i++) {
        const xx = x0 + i;
        const xc = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
        const wgt = wy * cubicKernel(x - xx);
        acc += src[(yc * w + xc) * 3 + c] * wgt;
        wsum += wgt;
      }
    }
    out[c] = wsum !== 0 ? clampByte(Math.round(acc / wsum)) : 0;
  }
}

/**
 * cv2.warpPerspective(src, H, (dstW,dstH), INTER_CUBIC, BORDER_REPLICATE)
 * where H maps source → dest. Sampling uses the inverse map.
 */
export function warpPerspectiveBicubic(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  H: Homography,
  dstW: number,
  dstH: number,
): Uint8Array {
  const inv = invertHomography(H);
  if (!inv) {
    throw new Error('warpPerspectiveBicubic: singular homography');
  }
  const out = new Uint8Array(dstW * dstH * 3);
  const tmp: number[] = [0, 0, 0];
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const den = inv[6] * x + inv[7] * y + inv[8];
      const sx = (inv[0] * x + inv[1] * y + inv[2]) / den;
      const sy = (inv[3] * x + inv[4] * y + inv[5]) / den;
      sampleBicubic3(src, srcW, srcH, sx, sy, tmp);
      const d = (y * dstW + x) * 3;
      out[d] = tmp[0];
      out[d + 1] = tmp[1];
      out[d + 2] = tmp[2];
    }
  }
  return out;
}

/** Convert packed RGBA / RGB pixels to packed BGR (PP-OCR training convention). */
export function toBgrPacked(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  order: 'rgba' | 'rgb' | 'bgr',
): Uint8Array {
  const out = new Uint8Array(w * h * 3);
  if (order === 'bgr') {
    out.set(data instanceof Uint8ClampedArray ? new Uint8Array(data.buffer, data.byteOffset, data.length) : data);
    return out;
  }
  const step = order === 'rgba' ? 4 : 3;
  for (let i = 0, o = 0; i < w * h; i++, o += 3) {
    const s = i * step;
    const r = data[s];
    const g = data[s + 1];
    const b = data[s + 2];
    out[o] = b; // B
    out[o + 1] = g;
    out[o + 2] = r;
  }
  return out;
}
