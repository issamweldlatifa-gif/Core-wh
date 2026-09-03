/**
 * Geometry helpers for the DB text-detection post-process (faithful port).
 * Provides the cv2.open-cv pieces we need without native deps:
 *  - convex hull (monotone chain)
 *  - min-area rectangle of a pixel cloud (≈ cv2.minAreaRect on the contour)
 *  - polygon area/perimeter + unclip offset for a rectangle (≈ pyclipper JT_ROUND)
 *  - fast box score (mean of a probability map inside a quad, ≈ box_score_fast)
 */

export interface Rect2 {
  cx: number;
  cy: number;
  /** unit axis along the rectangle's width */
  ux: number;
  uy: number;
  /** unit axis along the rectangle's height (perpendicular to u) */
  vx: number;
  vy: number;
  w: number;
  h: number;
}

export interface Pt2 {
  x: number;
  y: number;
}

export function convexHull(points: Pt2[]): Pt2[] {
  const pts = points.slice().sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  if (pts.length <= 2) return pts;
  const cross = (o: Pt2, a: Pt2, b: Pt2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Pt2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Rotating-calipers over the hull → min-area enclosing rectangle. */
export function minAreaRect(points: Pt2[]): Rect2 {
  const hull = convexHull(points);
  const n = hull.length;
  if (n === 1) {
    const p = hull[0];
    return { cx: p.x, cy: p.y, ux: 1, uy: 0, vx: 0, vy: 1, w: 1, h: 1 };
  }
  if (n === 2) {
    const dx = hull[1].x - hull[0].x;
    const dy = hull[1].y - hull[0].y;
    const len = Math.hypot(dx, dy) || 1;
    return {
      cx: (hull[0].x + hull[1].x) / 2,
      cy: (hull[0].y + hull[1].y) / 2,
      ux: dx / len,
      uy: dy / len,
      vx: -dy / len,
      vy: dx / len,
      w: len,
      h: 1,
    };
  }
  let bestArea = Infinity;
  let best: Rect2 | null = null;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const el = Math.hypot(ex, ey) || 1;
    const ux = ex / el;
    const uy = ey / el;
    // project all points onto u and v (v = perpendicular)
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const pu = (p.x - a.x) * ux + (p.y - a.y) * uy;
      const pv = -(p.x - a.x) * uy + (p.y - a.y) * ux;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = w * h;
    if (area < bestArea) {
      bestArea = area;
      // center in world coords = a + u*midU + v*midV
      const midU = (minU + maxU) / 2;
      const midV = (minV + maxV) / 2;
      const cx = a.x + ux * midU + -uy * midV;
      const cy = a.y + uy * midU + ux * midV;
      best = { cx, cy, ux, uy, vx: -uy, vy: ux, w, h };
    }
  }
  if (!best) {
    throw new Error('minAreaRect: no candidate');
  }
  return best;
}

/** The four corners of a rect, in arbitrary but stable order. */
export function rectCorners(r: Rect2): Pt2[] {
  const hw = r.w / 2;
  const hh = r.h / 2;
  return [
    { x: r.cx + r.ux * hw + r.vx * hh, y: r.cy + r.uy * hw + r.vy * hh },
    { x: r.cx + r.ux * hw - r.vx * hh, y: r.cy + r.uy * hw - r.vy * hh },
    { x: r.cx - r.ux * hw - r.vx * hh, y: r.cy - r.uy * hw - r.vy * hh },
    { x: r.cx - r.ux * hw + r.vx * hh, y: r.cy - r.uy * hw + r.vy * hh },
  ];
}

/**
 * Reorders 4 corners into [tl, tr, br, bl] exactly like RapidOCR's
 * get_mini_boxes (sort by x, then pair the y-sorted left/right columns).
 */
export function orderQuadTLTRBRBL(corners: Pt2[]): Pt2[] {
  const byX = corners.slice().sort((a, b) => a.x - b.x);
  const left = byX.slice(0, 2).sort((a, b) => a.y - b.y); // [tl, bl]
  const right = byX.slice(2, 4).sort((a, b) => a.y - b.y); // [tr, br]
  return [left[0], right[0], right[1], left[1]];
}

export function dist(a: Pt2, b: Pt2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polygonArea(pts: Pt2[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export function polygonPerimeter(pts: Pt2[]): number {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    p += dist(pts[i], pts[(i + 1) % pts.length]);
  }
  return p;
}

/** Even-odd point-in-polygon test. */
export function pointInPoly(pts: Pt2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * box_score_fast: mean of the probability map (pred, already sigmoided) over the
 * quad's bounding box restricted to the quad interior. Maps to cv2.mean(img, mask).
 */
export function boxScoreFast(
  pred: Float32Array,
  predW: number,
  predH: number,
  quad: Pt2[],
): number {
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const p of quad) {
    if (p.x < xmin) xmin = p.x;
    if (p.x > xmax) xmax = p.x;
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }
  xmin = Math.max(0, Math.min(predW - 1, Math.floor(xmin)));
  xmax = Math.max(0, Math.min(predW - 1, Math.ceil(xmax)));
  ymin = Math.max(0, Math.min(predH - 1, Math.floor(ymin)));
  ymax = Math.max(0, Math.min(predH - 1, Math.ceil(ymax)));
  let sum = 0;
  let count = 0;
  for (let y = ymin; y <= ymax; y++) {
    for (let x = xmin; x <= xmax; x++) {
      if (pointInPoly(quad, x + 0.5, y + 0.5)) {
        sum += pred[y * predW + x];
        count++;
      }
    }
  }
  return count === 0 ? 0 : sum / count;
}
