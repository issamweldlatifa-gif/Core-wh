/**
 * Shared synthetic-image helpers for unit tests.
 *
 * No canvas/DOM: these build luma (Uint8ClampedArray) buffers with a tiny
 * deterministic rasteriser that mimics label text well enough for the quality
 * gate, deskew and preprocessing tests. Real-font OCR benchmarking lives in
 * frontend/benchmark (PIL-generated labels).
 */

import { boxBlur3, type Gray } from '../pixels';
import { rotateGray } from '../pixels';

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LabelOptions {
  width?: number;
  height?: number;
  bg?: number; // background gray
  ink?: number; // text gray
  lines?: number; // text lines
  seed?: number;
  lineHeight?: number;
  marginX?: number;
}

/** Draw pseudo-text lines: deterministic glyph strokes per line. */
export function syntheticLabel(o: LabelOptions = {}): Gray {
  const width = o.width ?? 640;
  const height = o.height ?? 220;
  const bg = o.bg ?? 215;
  const ink = o.ink ?? 20;
  const lines = o.lines ?? 3;
  const seed = o.seed ?? 1;
  const lineHeight = o.lineHeight ?? 26;
  const marginX = o.marginX ?? 40;
  const rand = mulberry32(seed);
  const out = new Uint8ClampedArray(width * height).fill(bg);
  const gap = Math.max(12, lineHeight >> 1);
  const totalH = lines * lineHeight + (lines - 1) * gap;
  let top = Math.max(8, (height - totalH) >> 1);
  for (let li = 0; li < lines; li += 1) {
    const y0 = top;
    top += lineHeight + gap;
    let x = marginX + rand() * 8;
    const endX = width - marginX;
    while (x < endX - 14) {
      // glyph: deterministic set of strokes inside a cell
      const cw = 9 + rand() * 12;
      const strokes = 2 + Math.floor(rand() * 4);
      for (let s = 0; s < strokes; s += 1) {
        const sx = x + (s * (cw - 4)) / Math.max(1, strokes - 1) + rand() * 2;
        const sh = lineHeight * (0.45 + rand() * 0.5);
        const sy = y0 + (lineHeight - sh) * 0.2;
        const sw = Math.max(2, 3 + rand() * 4);
        for (let yy = 0; yy < sh; yy += 1) {
          for (let xx = 0; xx < sw; xx += 1) {
            const px = Math.round(sx + xx);
            const py = Math.round(sy + yy);
            if (px >= 0 && px < width && py >= 0 && py < height) out[py * width + px] = ink;
          }
        }
      }
      // space between glyphs
      x += cw + 2 + rand() * 6;
    }
  }
  return out;
}

export function blur(gray: Gray, w: number, h: number, passes = 1): Gray {
  let g = gray;
  for (let i = 0; i < passes; i += 1) g = boxBlur3(g, w, h);
  return g;
}

/** Multiply luma to simulate dark exposure. */
export function darken(gray: Gray, factor = 0.2): Gray {
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) out[i] = Math.min(255, gray[i] * factor);
  return out;
}

/** Add a blown specular blob (glare) in the top-left area. */
export function glare(gray: Gray, w: number, h: number, size = 60): Gray {
  const out = gray.slice() as Gray;
  const x0 = Math.round(w * 0.25);
  const y0 = Math.round(h * 0.1);
  for (let y = y0; y < Math.min(h, y0 + size); y += 1) {
    for (let x = x0; x < Math.min(w, x0 + size); x += 1) out[y * w + x] = 255;
  }
  return out;
}

export function rotate(gray: Gray, w: number, h: number, deg: number): Gray {
  return rotateGray(gray, w, h, deg);
}

/** Convert Gray → {data,width,height} RGBA for profile/preprocess tests. */
export function toRgba(gray: Gray, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    data[p] = gray[i];
    data[p + 1] = gray[i];
    data[p + 2] = gray[i];
    data[p + 3] = 255;
  }
  return { data, width: w, height: h };
}
