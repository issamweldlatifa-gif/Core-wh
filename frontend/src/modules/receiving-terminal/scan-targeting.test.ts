import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCAN_CONFIG,
  applyScannerProfile,
  mergeConfig,
  SCANNER_PROFILE_KEYS,
  SCANNER_PROFILES,
  type ScannerProfileKey,
} from './scan-config';
import { isDuplicate, noteSubmission, EMPTY_DEDUPE } from './dedupe';
import { findTextLines, findDominantLine, lineCropBox, profileForLineSkew } from './textlines';
import { syntheticLabel } from './testing/synth';
import {
  buildVideoConstraints,
  planAdvancedConstraints,
  summarizeTrackCapabilities,
  EMPTY_CAPABILITY_SUMMARY,
} from './providers';

describe('scanner operating profiles (unified P0 §27)', () => {
  it('defines the five required profiles, none touching business config', () => {
    expect(SCANNER_PROFILE_KEYS).toEqual([
      'FAST', 'BALANCED', 'HIGH_ACCURACY', 'LOW_LIGHT', 'SMALL_TEXT',
    ]);
    for (const key of SCANNER_PROFILE_KEYS) {
      expect(typeof SCANNER_PROFILES[key]).toBe('object');
      // profiles may only tune camera/ocr/consensus — never confidence/validation
      const p = SCANNER_PROFILES[key] as any;
      expect(p.confidence).toBeUndefined();
      expect(p.validation).toBeUndefined();
      expect(p.duplicate).toBeUndefined();
      expect(p.telemetry).toBeUndefined();
    }
  });
  it('applyScannerProfile returns a valid full config (deep merged)', () => {
    for (const key of SCANNER_PROFILE_KEYS) {
      const cfg = applyScannerProfile(DEFAULT_SCAN_CONFIG, key as ScannerProfileKey);
      expect(cfg.ocr.framesBeforeOcr).toBeGreaterThan(0);
      expect(cfg.confidence.thresholds.high).toBe(DEFAULT_SCAN_CONFIG.confidence.thresholds.high);
      expect(cfg.camera.roi.CARTON.w).toBe(DEFAULT_SCAN_CONFIG.camera.roi.CARTON.w);
      expect(cfg.targeting.enabled).toBe(true);
    }
    const fast = applyScannerProfile(DEFAULT_SCAN_CONFIG, 'FAST');
    expect(fast.ocr.framesBeforeOcr).toBeLessThan(DEFAULT_SCAN_CONFIG.ocr.framesBeforeOcr);
    expect(fast.camera.resolution.SMARTPHONE.width).toBeLessThan(DEFAULT_SCAN_CONFIG.camera.resolution.SMARTPHONE.width);
    const acc = applyScannerProfile(DEFAULT_SCAN_CONFIG, 'HIGH_ACCURACY');
    expect(acc.ocr.ocrMaxWidth).toBeGreaterThan(DEFAULT_SCAN_CONFIG.ocr.ocrMaxWidth);
  });
  it('mergeConfig keeps new targeting block intact', () => {
    const cfg = mergeConfig(DEFAULT_SCAN_CONFIG, { targeting: { stableFrames: 4 } });
    expect(cfg.targeting.stableFrames).toBe(4);
    expect(cfg.targeting.minScore).toBe(DEFAULT_SCAN_CONFIG.targeting.minScore);
  });
});

describe('duplicate scan prevention (unified P0 §26)', () => {
  it('same code inside the window is suppressed; new code passes', () => {
    const st = { ...EMPTY_DEDUPE };
    expect(isDuplicate(st, 'CTN-000123', 1000, 2500)).toBe(false); // first sight — not dup
    noteSubmission(st, 'CTN-000123', 1000);
    expect(isDuplicate(st, 'CTN-000123', 1200, 2500)).toBe(true);
    expect(isDuplicate(st, 'CTN-000123', 5000, 2500)).toBe(false); // outside window
    noteSubmission(st, 'CTN-000123', 5000);
    expect(isDuplicate(st, 'ABO-123456', 5100, 2500)).toBe(false); // different code
    noteSubmission(st, 'ABO-123456', 5100);
  });
  it('repeat stream stays suppressed across the whole window (one event)', () => {
    const st = { ...EMPTY_DEDUPE };
    let accepted = 0;
    const tick = (v: string, t: number) => {
      if (!isDuplicate(st, v, t, 2500)) {
        accepted += 1;
        noteSubmission(st, v, t);
      }
    };
    for (let t = 0; t < 100000; t += 200) tick('CTN-000123', t); // continuous hold
    expect(accepted).toBe(1);
  });
});

describe('text-line targeting (unified P0 §5/§8/§9)', () => {
  it('finds the text lines of a synthetic label and ranks the strongest first', () => {
    const w = 640;
    const h = 220;
    const gray = syntheticLabel({ width: w, height: h, lines: 3, seed: 11 });
    const lines = findTextLines(gray, w, h);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].score).toBe(1);
    // every line is inside the region and taller than a sliver
    for (const l of lines) {
      expect(l.x0).toBeGreaterThanOrEqual(0);
      expect(l.x1).toBeLessThanOrEqual(w);
      expect(l.y0).toBeGreaterThanOrEqual(0);
      expect(l.y1).toBeLessThanOrEqual(h);
      expect(l.y1 - l.y0).toBeGreaterThanOrEqual(5);
    }
    // at least one line should cover a good chunk of horizontal span
    expect(Math.max(...lines.map((l) => l.x1 - l.x0))).toBeGreaterThan(w * 0.4);
  });
  it('dominant line returns the strongest band; empty image returns null', () => {
    const w = 480;
    const h = 160;
    const gray = syntheticLabel({ width: w, height: h, lines: 2, seed: 3 });
    expect(findDominantLine(gray, w, h)).not.toBeNull();
    const blank = new Uint8ClampedArray(w * h).fill(210);
    expect(findDominantLine(blank, w, h)).toBeNull();
    expect(findTextLines(blank, w, h)).toEqual([]);
  });
  it('lineCropBox grows the line into a safe box clamped to the region', () => {
    const w = 640;
    const h = 220;
    const gray = syntheticLabel({ width: w, height: h, lines: 1, seed: 7 });
    const dom = findDominantLine(gray, w, h);
    expect(dom).not.toBeNull();
    const box = lineCropBox(dom!, w, h, 0.5)!;
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(w);
    expect(box.y + box.height).toBeLessThanOrEqual(h);
    // crop contains the original line
    expect(box.y).toBeLessThanOrEqual(dom!.y0);
    expect(box.y + box.height).toBeGreaterThanOrEqual(dom!.y1);
  });
  it('profileForLineSkew routes tilted crops through the deskew profile', () => {
    expect(profileForLineSkew(8, 'A_NORMAL')).toBe('D_ROTATED');
    expect(profileForLineSkew(-3.2, 'B_LOW_LIGHT')).toBe('D_ROTATED');
    expect(profileForLineSkew(0.2, 'A_NORMAL')).toBe('A_NORMAL');
  });
});

describe('scanner input providers — pure capability layer (unified P0 §22/§23)', () => {
  it('summarizeTrackCapabilities reads only what a track advertises', () => {
    const track = {
      getCapabilities: () => ({
        torch: true,
        focusMode: ['continuous', 'manual'],
        exposureMode: ['continuous'],
        frameRate: { max: 60, min: 1 },
      }),
    };
    const s = summarizeTrackCapabilities(track as any);
    expect(s.torch).toBe(true);
    expect(s.focusModes).toContain('continuous');
    expect(s.frameRateMax).toBe(60);
    expect(summarizeTrackCapabilities(null)).toEqual(EMPTY_CAPABILITY_SUMMARY);
    expect(summarizeTrackCapabilities({} as any)).toEqual(EMPTY_CAPABILITY_SUMMARY);
  });
  it('planAdvancedConstraints never pushes an unsupported capability', () => {
    const s = summarizeTrackCapabilities({} as any);
    expect(planAdvancedConstraints(s, DEFAULT_SCAN_CONFIG.camera)).toEqual([]);
    const rich = summarizeTrackCapabilities({
      getCapabilities: () => ({
        torch: false,
        focusMode: ['continuous'],
        exposureMode: [],
        whiteBalanceMode: ['continuous', 'auto'],
        frameRate: { max: 30, min: 2 },
      }),
    } as any);
    const adv = planAdvancedConstraints(rich, DEFAULT_SCAN_CONFIG.camera) as any[];
    expect(adv.some((c) => c.focusMode === 'continuous')).toBe(true);
    expect(adv.some((c) => c.exposureMode)).toBe(false); // not advertised
    expect(adv.some((c) => c.whiteBalanceMode === 'continuous')).toBe(true);
    const fr = adv.find((c) => c.frameRate);
    expect(fr.frameRate.max).toBe(30);
    expect(fr.frameRate.ideal).toBeLessThanOrEqual(30);
  });
  it('buildVideoConstraints requests the device-class resolution, never max-by-default', () => {
    const c = buildVideoConstraints(DEFAULT_SCAN_CONFIG.camera, 'SMARTPHONE', 'environment');
    const video = c as any;
    expect(video.facingMode).toEqual({ ideal: 'environment' });
    expect(video.width).toEqual({ ideal: 1280 });
    expect(video.height).toEqual({ ideal: 720 });
    expect(video.frameRate.ideal).toBe(30);
    const desk = buildVideoConstraints(DEFAULT_SCAN_CONFIG.camera, 'DESKTOP', 'user') as any;
    expect(desk.width.ideal).toBe(1920);
  });
});
