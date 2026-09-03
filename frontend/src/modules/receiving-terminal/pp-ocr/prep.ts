/**
 * PP-OCR input preparation: OpenCV-equivalent resizing + normalisation into
 * NCHW float32 tensors (faithful to RapidOCR config files).
 */

import { resizeBilinear } from './image';

export interface FloatTensor {
  data: Float32Array;
  dims: number[];
}

function normalizeToCHW(
  resized: Uint8Array,
  resizeW: number,
  resizeH: number,
  mean: [number, number, number],
  std: [number, number, number],
): FloatTensor {
  // resized is packed BGR.
  const n = resizeW * resizeH;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const b = resized[i * 3];
    const g = resized[i * 3 + 1];
    const r = resized[i * 3 + 2];
    out[i] = (b / 255 - mean[0]) / std[0];
    out[n + i] = (g / 255 - mean[1]) / std[1];
    out[2 * n + i] = (r / 255 - mean[2]) / std[2];
  }
  return { data: out, dims: [1, 3, resizeH, resizeW] };
}

export interface DetResized {
  tensor: FloatTensor;
  resizeW: number;
  resizeH: number;
}

/**
 * det config pre_process:
 *   DetResizeForTest(limit_side_len=736, limit_type='min') then round to multiple
 *   of 32, NormalizeImage(mean/std ImageNet, hwc) then ToCHW.
 */
export function detPreprocess(
  bgr: Uint8Array,
  srcW: number,
  srcH: number,
  limitSideLen = 736,
): DetResized {
  const h = srcH;
  const w = srcW;
  let ratio: number;
  if (Math.min(h, w) < limitSideLen) {
    ratio = h < w ? limitSideLen / h : limitSideLen / w;
  } else {
    ratio = 1;
  }
  let resizeH = Math.round((h * ratio) / 32) * 32;
  let resizeW = Math.round((w * ratio) / 32) * 32;
  resizeH = Math.max(1, resizeH);
  resizeW = Math.max(1, resizeW);
  const resized = resizeBilinear(bgr, w, h, 3, resizeW, resizeH);
  const tensor = normalizeToCHW(resized, resizeW, resizeH, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);
  return { tensor, resizeW, resizeH };
}

/**
 * cls config resize_norm_img: fixed height 48, width capped 192, /255 → (x-0.5)/0.5.
 */
export function clsPreprocess(
  bgr: Uint8Array,
  w: number,
  h: number,
  imgW = 192,
  imgH = 48,
): FloatTensor {
  const ratio = w / h;
  let resizedW = Math.ceil(imgH * ratio);
  if (resizedW > imgW) resizedW = imgW;
  if (resizedW < 1) resizedW = 1;
  const resized = resizeBilinear(bgr, w, h, 3, resizedW, imgH);
  const n = resizedW * imgH;
  const out = new Float32Array(3 * imgW * imgH).fill(0);
  for (let i = 0; i < n; i++) {
    const b = (resized[i * 3] / 255 - 0.5) / 0.5;
    const g = (resized[i * 3 + 1] / 255 - 0.5) / 0.5;
    const r = (resized[i * 3 + 2] / 255 - 0.5) / 0.5;
    out[i] = b;
    out[imgW * imgH + i] = g;
    out[2 * imgW * imgH + i] = r;
  }
  return { data: out, dims: [1, 3, imgH, imgW] };
}

/**
 * rec config resize_norm_img: fixed height 48, width = ceil(48*ratio) capped by
 * int(48*max_wh_ratio) (batching is sequential here so ratio == max ratio).
 */
export function recPreprocess(bgr: Uint8Array, w: number, h: number): { tensor: FloatTensor; width: number } {
  const imgH = 48;
  const ratio = w / h;
  const maxWh = ratio; // single-image batch
  const maxWidth = Math.floor(imgH * maxWh);
  let resizedW = Math.ceil(imgH * ratio);
  if (resizedW > maxWidth) resizedW = maxWidth;
  if (resizedW < 1) resizedW = 1;
  const resized = resizeBilinear(bgr, w, h, 3, resizedW, imgH);
  const n = resizedW * imgH;
  const out = new Float32Array(3 * resizedW * imgH).fill(0);
  for (let i = 0; i < n; i++) {
    const b = (resized[i * 3] / 255 - 0.5) / 0.5;
    const g = (resized[i * 3 + 1] / 255 - 0.5) / 0.5;
    const r = (resized[i * 3 + 2] / 255 - 0.5) / 0.5;
    out[i] = b;
    out[n + i] = g;
    out[2 * n + i] = r;
  }
  return { tensor: { data: out, dims: [1, 3, imgH, resizedW] }, width: resizedW };
}

/** CTC decode: blanks are removed, consecutive duplicates collapsed (argmax per step). */
export function ctcDecode(
  pred: FloatTensor,
  keys: string[],
): { text: string; confidence: number } {
  const [B, T, C] = pred.dims as [number, number, number];
  const data = pred.data;
  // char index 0 = blank; then keys; trailing space appended at end (python order).
  const total = keys.length + 2; // 0 blank, then keys, then space (index keys.length+1)
  const text: string[] = [];
  const confs: number[] = [];
  for (let b = 0; b < B; b++) {
    let prevIdx = -1;
    for (let t = 0; t < T; t++) {
      let best = 0;
      let bestP = -Infinity;
      const base = (b * T + t) * C;
      for (let c = 0; c < C; c++) {
        const p = data[base + c];
        if (p > bestP) {
          bestP = p;
          best = c;
        }
      }
      if (best === 0) {
        prevIdx = best;
        continue;
      }
      if (best === prevIdx) continue; // duplicate collapse
      prevIdx = best;
      confs.push(bestP);
      if (best <= keys.length) {
        text.push(keys[best - 1]);
      } else {
        text.push(' ');
      }
    }
  }
  void total;
  const joined = text.join('');
  // python: np.mean(conf_list + [1e-50])
  let sum = 1e-50;
  for (const c of confs) sum += c;
  const confidence = confs.length > 0 ? sum / (confs.length + 1) : 1e-50;
  return { text: joined, confidence };
}
