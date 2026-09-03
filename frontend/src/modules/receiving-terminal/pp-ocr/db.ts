/**
 * DB (Differentiable Binarization) text detection post-process — faithful TS
 * port of RapidOCR `ch_ppocr_v3_det/utils.py` (DBPostProcess) plus the
 * TextDetector.filter_tag_det_res stage.
 *
 * Native pieces (cv2.findContours / minAreaRect / pyclipper offset / fillPoly)
 * are reproduced with: 8-connected component labelling, rotating-calipers
 * min-area rect, rectangle expansion (= pyclipper JT_ROUND for a rectangle)
 * and polygon mean scores.
 */

import type { PPOcrConfig } from './types';
import {
  boxScoreFast,
  dist,
  minAreaRect,
  orderQuadTLTRBRBL,
  polygonArea,
  polygonPerimeter,
  rectCorners,
  type Pt2,
  type Rect2,
} from './geom';

export interface DetBox {
  /** Quadrilateral in the ORIGINAL (dest) image coordinates, [tl,tr,br,bl]. */
  quad: Pt2[];
  /** box_score_fast of the pre-unclip box. */
  score: number;
}

function dilate2x2(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = mask[y * w + x];
      if (v === 0) continue;
      out[y * w + x] = 1;
      if (x + 1 < w) out[y * w + x + 1] = 1;
      if (y + 1 < h) {
        out[(y + 1) * w + x] = 1;
        if (x + 1 < w) out[(y + 1) * w + x + 1] = 1;
      }
    }
  }
  return out;
}

/** 8-connected component labelling. Returns pixel lists per component. */
function connectedComponents(mask: Uint8Array, w: number, h: number): Pt2[][] {
  const visited = new Uint8Array(w * h);
  const comps: Pt2[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (visited[start] || mask[start] === 0) continue;
    const comp: Pt2[] = [];
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const x = idx % w;
      const y = (idx - x) / w;
      comp.push({ x, y });
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nIdx = ny * w + nx;
          if (visited[nIdx] || mask[nIdx] === 0) continue;
          visited[nIdx] = 1;
          stack.push(nIdx);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

/** Corner-extents of a rect: quad in rect's own frame then reordered [tl,tr,br,bl]. */
function rectToOrderedQuad(r: Rect2): { quad: Pt2[]; minSide: number } {
  const quad = orderQuadTLTRBRBL(rectCorners(r));
  return { quad, minSide: Math.min(r.w, r.h) };
}

/**
 * Expand a rectangle by `distance` on every side (pyclipper JT_ROUND offset of
 * a rectangle equals the same rect grown by distance on each side).
 */
function unclipRect(r: Rect2, distance: number): Rect2 {
  return { ...r, w: r.w + 2 * distance, h: r.h + 2 * distance };
}

export function dbBoxesFromPred(
  predMap: Float32Array,
  predW: number,
  predH: number,
  destW: number,
  destH: number,
  cfg: PPOcrConfig,
): { raw: Pt2[][]; score: number[] } {
  const thresholded = new Uint8Array(predW * predH);
  for (let i = 0; i < predW * predH; i++) thresholded[i] = predMap[i] > cfg.detThresh ? 1 : 0;
  const mask = cfg.detUseDilation ? dilate2x2(thresholded, predW, predH) : thresholded;
  const comps = connectedComponents(mask, predW, predH);

  const raw: Pt2[][] = [];
  const scores: number[] = [];
  for (const comp of comps) {
    // Contour -> minAreaRect: use the convex-hull min-area rect of the component pixels.
    const rect = minAreaRect(comp);
    const first = rectToOrderedQuad(rect);
    const quad = first.quad;
    if (first.minSide < cfg.minDetSideLen) continue;

    const score = boxScoreFast(predMap, predW, predH, quad);
    if (cfg.detBoxThresh > score) continue;

    const area = polygonArea(quad);
    const perim = polygonPerimeter(quad);
    const distance = perim > 0 ? (area * cfg.detUnclipRatio) / perim : 0;
    const expanded = rectToOrderedQuad(unclipRect(rect, distance));
    if (expanded.minSide < cfg.minBoxSideLenAfterUnclip) continue;

    const outQuad: Pt2[] = expanded.quad.map((p) => ({
      x: Math.max(0, Math.min(destW, Math.round((p.x / predW) * destW))),
      y: Math.max(0, Math.min(destH, Math.round((p.y / predH) * destH))),
    }));
    raw.push(outQuad);
    scores.push(score);
  }
  return { raw, score: scores };
}

/**
 * TextDetector.filter_tag_det_res: order points clockwise, clip to the original
 * image, drop degenerate boxes (side <= 3 px).
 */
export function filterTagDetRes(boxes: Pt2[][], imgW: number, imgH: number): Pt2[][] {
  const out: Pt2[][] = [];
  for (const b of boxes) {
    const quad = orderQuadTLTRBRBL(b);
    const clipped = quad.map((p) => ({
      x: Math.min(Math.max(Math.round(p.x), 0), imgW - 1),
      y: Math.min(Math.max(Math.round(p.y), 0), imgH - 1),
    }));
    const width = Math.round(dist(clipped[0], clipped[1]));
    const height = Math.round(dist(clipped[0], clipped[3]));
    if (width <= 3 || height <= 3) continue;
    out.push(clipped);
  }
  return out;
}
