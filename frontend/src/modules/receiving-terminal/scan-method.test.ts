import { describe, expect, it } from 'vitest';
import { chooseScanMethods, deviceClassOf } from './scan-method';

function caps(over: Record<string, unknown> = {}) {
  return {
    deviceType: 'DESKTOP',
    getUserMedia: true,
    cameraScanningSupported: true,
    canDetectExternalScanner: true,
    touch: false,
    screenWidthPx: 1280,
    ...over,
  } as any;
}

describe('dual-scanner scan-method selection (order §1/§15)', () => {
  it('Desktop: Hardware is the default; camera is never implied', () => {
    const c = chooseScanMethods(caps());
    expect(c.available).toEqual(['software', 'hardware']);
    expect(c.default).toBe('hardware');
    expect(c.ordered[0]).toBe('hardware');
  });

  it('Desktop without webcam: only hardware is offered', () => {
    const c = chooseScanMethods(caps({ getUserMedia: false, cameraScanningSupported: false }));
    expect(c.available).toEqual(['hardware']);
    expect(c.default).toBe('hardware');
  });

  it('Smartphone: software is primary, hardware still offered', () => {
    const c = chooseScanMethods(caps({ deviceType: 'SMARTPHONE', touch: true, screenWidthPx: 390 }));
    expect(c.available).toEqual(['software', 'hardware']);
    expect(c.default).toBe('software');
    expect(c.ordered[0]).toBe('software');
  });

  it('Tablet: both offered, software first', () => {
    const c = chooseScanMethods(caps({ deviceType: 'TABLET', touch: true, screenWidthPx: 820 }));
    expect(c.available).toEqual(['software', 'hardware']);
    expect(c.default).toBe('software');
  });

  it('Camera-only phone (no external scanner): software only', () => {
    const c = chooseScanMethods(caps({
      deviceType: 'SMARTPHONE', canDetectExternalScanner: false, touch: true, screenWidthPx: 390,
    }));
    expect(c.available).toEqual(['software']);
    expect(c.default).toBe('software');
  });

  it('Desktop with camera permission denied: never falls back to camera automatically', () => {
    const c = chooseScanMethods(caps({ getUserMedia: true, cameraScanningSupported: true }));
    // the CHOICE policy is independent of permission state — camera is
    // requested only when the worker explicitly taps Software Scan (§16)
    expect(c.default).toBe('hardware');
  });

  it('deviceClassOf normalises unknown device types', () => {
    expect(deviceClassOf({ deviceType: 'DESKTOP' })).toBe('DESKTOP');
    expect(deviceClassOf({ deviceType: 'SMARTPHONE' })).toBe('SMARTPHONE');
    expect(deviceClassOf({ deviceType: 'TABLET' })).toBe('TABLET');
    expect(deviceClassOf({ deviceType: 'UNKNOWN' })).toBe('UNKNOWN');
  });
});
