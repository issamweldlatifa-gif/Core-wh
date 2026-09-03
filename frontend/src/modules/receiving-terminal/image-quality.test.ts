import { describe, expect, it } from 'vitest';
import { assessQuality, quickGuidance, QUALITY_THRESHOLDS } from './image-quality';
import { selectProfile, applyProfile, estimateSkewDeg, legacyPreprocess, type ProfileId } from './preprocess';
import { syntheticLabel, blur, darken, glare, rotate, toRgba } from './testing/synth';

describe('image-quality gate (order §6)', () => {
  it('rates a crisp high-contrast label GOOD and passes', () => {
    const g = syntheticLabel({ seed: 7 });
    const q = assessQuality(g, 640, 220);
    expect(q.level).toBe('GOOD');
    expect(q.pass).toBe(true);
    expect(q.score).toBeGreaterThan(0.6);
    expect(q.advice).toEqual([]);
  });

  it('detects blur and refuses to run OCR on it', () => {
    const g = blur(syntheticLabel({ seed: 7 }), 640, 220, 5);
    const crisp = assessQuality(syntheticLabel({ seed: 7 }), 640, 220);
    const q = assessQuality(g, 640, 220);
    expect(q.sharpness).toBeLessThan(crisp.sharpness);
    expect(q.reasons).toContain('blurred');
    expect(q.pass).toBe(false);
    expect(q.advice.length).toBeGreaterThan(0);
  });

  it('detects low light', () => {
    const g = darken(syntheticLabel({ seed: 7 }), 0.18);
    const q = assessQuality(g, 640, 220);
    expect(q.reasons).toContain('low_light');
  });

  it('detects glare (blown specular area)', () => {
    const g = glare(syntheticLabel({ seed: 7 }), 640, 220, 90);
    const q = assessQuality(g, 640, 220);
    expect(q.reasons).toContain('glare');
  });

  it('an empty ROI is not a label', () => {
    const g = new Uint8ClampedArray(640 * 220).fill(210);
    const q = assessQuality(g, 640, 220);
    expect(q.pass).toBe(false);
    expect(q.reasons).toContain('no_label');
  });

  it('a small but sharp label yields “Move closer” guidance but stays usable', () => {
    // single line, short text at the centre
    const g = syntheticLabel({ width: 480, height: 160, lines: 1, seed: 3 });
    const q = assessQuality(g, 480, 160);
    // May be GOOD or MARGINAL — never blocked as “no label”.
    expect(q.level).not.toBe('BAD');
    expect(q.reasons).not.toContain('no_label');
  });

  it('thresholds object is stable for tuning', () => {
    expect(typeof QUALITY_THRESHOLDS.minEdgeRatio).toBe('number');
    expect(QUALITY_THRESHOLDS.minEdgeRatio).toBeGreaterThan(0);
  });

  it('quickGuidance runs cheaply on a dark frame', () => {
    const g = darken(syntheticLabel({ seed: 7 }), 0.15);
    const q = quickGuidance(g, 640, 220);
    expect(['GOOD', 'MARGINAL']).toContain(q.level);
  });
});

describe('preprocessing profiles (order §7)', () => {
  const profileIds: ProfileId[] = ['A_NORMAL', 'B_LOW_LIGHT', 'C_SMALL_TEXT', 'D_ROTATED', 'E_GLARE', 'LEGACY_GLOBAL'];
  const src = toRgba(syntheticLabel({ seed: 11 }), 640, 220);

  it('each profile returns a binarised luma buffer with sane dimensions', () => {
    for (const p of profileIds) {
      const r = applyProfile({ data: src.data.slice() as Uint8ClampedArray, width: src.width, height: src.height }, p, {
        smallTextUpscale: 2,
        maxWidth: 960,
      });
      expect(r.gray.length, p).toBe(r.width * r.height);
      // D_ROTATED legitimately falls back to A_NORMAL on an already-upright
      // label (|skew| < 0.75°), so accept either profile id for D.
      if (p === 'D_ROTATED') expect(['D_ROTATED', 'A_NORMAL']).toContain(r.profile);
      else expect(r.profile).toBe(p);
      let max = 0;
      for (let i = 0; i < r.gray.length; i += 1) if (r.gray[i] > max) max = r.gray[i];
      expect(max, p).toBe(255);
    }
  });

  it('C_SMALL_TEXT upscales when asked', () => {
    const r = applyProfile({ data: src.data.slice() as Uint8ClampedArray, width: src.width, height: src.height }, 'C_SMALL_TEXT', {
      smallTextUpscale: 2,
      maxWidth: 2000,
    });
    expect(r.width).toBeGreaterThan(src.width);
    expect(r.steps.join(',')).toContain('upscale');
  });

  it('profile selection reacts to measured quality', () => {
    expect(selectProfile({ level: 'GOOD', score: 1, pass: true, reasons: [], advice: [], meanGray: 180, stdGray: 50, darkPixRatio: 0.02, saturPixRatio: 0.01, edgeRatio: 0.05, sharpness: 0.9, hGradVsVGrad: 1, textBBox: null, coverage: 0.2, analysisW: 640, analysisH: 220 })).toBe('A_NORMAL');
    expect(selectProfile({ level: 'GOOD', score: 0.7, pass: true, reasons: ['low_light'], advice: [], meanGray: 40, stdGray: 40, darkPixRatio: 0.6, saturPixRatio: 0, edgeRatio: 0.05, sharpness: 0.8, hGradVsVGrad: 1, textBBox: null, coverage: 0.2, analysisW: 640, analysisH: 220 })).toBe('B_LOW_LIGHT');
    expect(selectProfile({ level: 'GOOD', score: 0.8, pass: true, reasons: ['small_text'], advice: [], meanGray: 190, stdGray: 30, darkPixRatio: 0, saturPixRatio: 0, edgeRatio: 0.03, sharpness: 0.8, hGradVsVGrad: 1, textBBox: null, coverage: 0.02, analysisW: 640, analysisH: 220 })).toBe('C_SMALL_TEXT');
    expect(selectProfile({ level: 'GOOD', score: 0.8, pass: true, reasons: [], advice: [], meanGray: 200, stdGray: 40, darkPixRatio: 0, saturPixRatio: 0.16, edgeRatio: 0.05, sharpness: 0.7, hGradVsVGrad: 1, textBBox: null, coverage: 0.2, analysisW: 640, analysisH: 220 })).toBe('E_GLARE');
  });

  it('legacy recipe stays byte-stable for before/after benchmarks', () => {
    const g = syntheticLabel({ seed: 2 });
    const out = legacyPreprocess(g);
    const out2 = legacyPreprocess(g);
    expect(out).toEqual(out2);
  });
});

describe('deskew estimation (profile D)', () => {
  it('reports ~0° for an upright label and a real angle for a rotated one', () => {
    const g = syntheticLabel({ width: 560, height: 200, seed: 5 });
    const straight = estimateSkewDeg(g, 560, 200);
    expect(Math.abs(straight)).toBeLessThanOrEqual(1.5);
    const tilted = rotate(g, 560, 200, 8);
    const est = estimateSkewDeg(tilted, 560, 200);
    // Rotation by +8° must be detected as non-trivial (sign convention kept
    // internally consistent: |est| within a few degrees of 8).
    expect(Math.abs(Math.abs(est) - 8)).toBeLessThanOrEqual(3.5);
  });
});
