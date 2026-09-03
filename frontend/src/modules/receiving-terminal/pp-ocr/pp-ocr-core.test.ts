/**
 * Pure-logic guards for the level-2 PP-OCR port (no ONNX / no models needed).
 * The end-to-end engine is validated offline by benchmark/level2/validate-pp.mjs
 * against the real label fixtures (that script needs onnxruntime-node).
 */
import { describe, expect, it } from 'vitest';
import { boxScoreFast, convexHull, minAreaRect, orderQuadTLTRBRBL, pointInPoly, rectCorners } from './geom';
import { ctcDecode, detPreprocess, recPreprocess } from './prep';
import { resizeBilinear, rotate180 } from './image';

describe('geom.orderQuadTLTRBRBL', () => {
  it('orders axis-aligned corners into tl,tr,br,bl', () => {
    const quad = orderQuadTLTRBRBL([
      { x: 0, y: 10 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 0 },
    ]);
    expect(quad.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
  });
});

describe('geom.minAreaRect + rectCorners', () => {
  it('finds the tight rotated rectangle of a horizontal band', () => {
    const pts: { x: number; y: number }[] = [];
    for (let x = 0; x < 40; x++) for (let y = 5; y < 9; y++) pts.push({ x, y });
    const r = minAreaRect(pts);
    expect(r.w).toBeGreaterThanOrEqual(39);
    expect(r.w).toBeLessThanOrEqual(40.1);
    expect(r.h).toBeGreaterThanOrEqual(2.9);
    expect(r.h).toBeLessThanOrEqual(3.1);
    const corners = rectCorners(r);
    expect(corners).toHaveLength(4);
  });
});

describe('geom.pointInPoly / boxScoreFast', () => {
  it('boxScoreFast averages the map inside a quad', () => {
    const map = new Float32Array(20 * 20).fill(0);
    for (let i = 0; i < 400; i++) map[i] = 0.9; // everything high
    const quad = orderQuadTLTRBRBL([
      { x: 2, y: 2 },
      { x: 18, y: 2 },
      { x: 18, y: 18 },
      { x: 2, y: 18 },
    ]);
    const score = boxScoreFast(map, 20, 20, quad);
    expect(score).toBeCloseTo(0.9, 3);
    expect(pointInPoly(quad, 5, 5)).toBe(true);
    expect(pointInPoly(quad, 0, 0)).toBe(false);
    expect(convexHull([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }])).toHaveLength(4);
  });
});

describe('prep.detPreprocess', () => {
  it('scales the short side up to the limit multiple of 32', () => {
    const bgr = new Uint8Array(690 * 620 * 3).fill(128);
    const r = detPreprocess(bgr, 690, 620, 736);
    expect(r.resizeW % 32).toBe(0);
    expect(r.resizeH % 32).toBe(0);
    expect(Math.min(r.resizeW, r.resizeH)).toBeGreaterThanOrEqual(736);
    expect(r.tensor.dims).toEqual([1, 3, r.resizeH, r.resizeW]);
    expect(r.tensor.data.length).toBe(3 * r.resizeW * r.resizeH);
  });
});

describe('prep.recPreprocess', () => {
  it('pads to width ceil(48*ratio) with height 48', () => {
    const bgr = new Uint8Array(48 * 24 * 3).fill(128); // ratio 2
    const r = recPreprocess(bgr, 48, 24);
    expect(r.tensor.dims[2]).toBe(48);
    expect(r.tensor.dims[3]).toBe(96);
  });
});

describe('prep.ctcDecode', () => {
  it('collapses repeats, drops blanks, maps alphabet', () => {
    const keys = ['A', 'B', 'C'];
    // pred dims [1, T=8, C=keys+2(blank,space)=5]
    const C = 5;
    const data = new Float32Array(1 * 8 * C);
    const set = (t: number, c: number) => {
      data[t * C + c] = 1;
    };
    // seq: blank(0), A(1), A(1)repeat, blank(0), B(2), blank, space(4), C(3)
    set(0, 0);
    set(1, 1);
    set(2, 1);
    set(3, 0);
    set(4, 2);
    set(5, 0);
    set(6, 4);
    set(7, 3);
    const { text } = ctcDecode({ data, dims: [1, 8, C] }, keys);
    expect(text).toBe('AB C');
  });
});

describe('image helpers', () => {
  it('rotate180 flips pixels', () => {
    const src = new Uint8Array([1, 2, 3, 4]); // 2x2 1ch
    const out = rotate180(src, 2, 2, 1);
    expect([...out]).toEqual([4, 3, 2, 1]);
  });
  it('resizeBilinear keeps size and endpoints approx', () => {
    const src = new Uint8Array([0, 255]).map((v, i) => v); // not used
    const img = new Uint8Array(2 * 1);
    img[0] = 0;
    img[1] = 255;
    const out = resizeBilinear(img, 2, 1, 1, 4, 1);
    expect(out[0]).toBe(0);
    expect(out[3]).toBe(255);
    expect(out[1]).toBeGreaterThan(0);
    expect(out[2]).toBeLessThan(255);
  });
});
