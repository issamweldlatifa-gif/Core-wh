import { describe, expect, it } from 'vitest';
import { WedgeParser, DEFAULT_TERMINATORS, detectHardwareCapabilities } from './hardware-wedge';
import { sanitiseWedgeRead, prepareHardwareRead } from './hardware-scan';
import { EMPTY_DEDUPE } from './dedupe';

/** Fast burst: one char every 15ms (typical HID scanner) + Enter. */
function wedgeBurst(code: string, gapMs = 15, end = 'Enter') {
  const parser = new WedgeParser({ terminatorKeys: DEFAULT_TERMINATORS });
  let t = 1000;
  for (const ch of code) {
    parser.push({ key: ch, at: t });
    t += gapMs;
  }
  return { parser, ev: parser.push({ key: end, at: t + 10 }) };
}

describe('hardware keyboard-wedge parser (order §5)', () => {
  it('assembles a fast HID burst and classifies it as an external scanner', () => {
    const { ev } = wedgeBurst('SKU-100200300');
    expect(ev).not.toBeNull();
    expect(ev!.value).toBe('SKU-100200300');
    expect(ev!.source).toBe('EXTERNAL_SCANNER');
    expect(ev!.terminated).toBe(true);
  });

  it('a slow human typing stays MANUAL but is still delivered', () => {
    const { ev } = wedgeBurst('ABO-123456', 250);
    expect(ev!.value).toBe('ABO-123456');
    expect(ev!.source).toBe('MANUAL');
  });

  it('modifier combos (Ctrl/Alt/Meta) never pollute the buffer', () => {
    const parser = new WedgeParser();
    parser.push({ key: 'a', at: 1 });
    parser.push({ key: 'c', ctrlKey: true, at: 2 });
    parser.push({ key: 'v', metaKey: true, at: 3 });
    parser.push({ key: 'x', altKey: true, at: 4 });
    parser.push({ key: '1', at: 5 });
    const ev = parser.push({ key: 'Enter', at: 6 });
    expect(ev!.value).toBe('A1');
  });

  it('key repeat is ignored', () => {
    const parser = new WedgeParser();
    parser.push({ key: 'S', at: 1 });
    parser.push({ key: 'S', repeat: true, at: 2 });
    const ev = parser.push({ key: 'Enter', at: 3 });
    expect(ev!.value).toBe('S');
  });

  it('function/modifier keys alone never complete a code', () => {
    const parser = new WedgeParser();
    parser.push({ key: 'F5', at: 1 });
    parser.push({ key: 'Shift', at: 2 });
    expect(parser.push({ key: 'Enter', at: 3 })).toBeNull();
  });

  it('Tab-terminated models deliver when configured', () => {
    const parser = new WedgeParser({ terminatorKeys: ['Tab'] });
    for (const ch of 'CTN-000123') parser.push({ key: ch, at: 100 });
    const ev = parser.push({ key: 'Tab', at: 200 });
    expect(ev!.value).toBe('CTN-000123');
  });

  it('multiple codes in a row each deliver independently', () => {
    const parser = new WedgeParser();
    for (const ch of 'AAA111') parser.push({ key: ch, at: 1 });
    const a = parser.push({ key: 'Enter', at: 100 });
    for (const ch of 'BBB222') parser.push({ key: ch, at: 200 });
    const b = parser.push({ key: 'Enter', at: 300 });
    expect(a!.value).toBe('AAA111');
    expect(b!.value).toBe('BBB222');
  });
});

describe('hardware read sanitisation + duplicate guard (order §6/§7)', () => {
  it('sanitises case and keeps valid codes', () => {
    expect(sanitiseWedgeRead('  sku-100200300  ')).toBe('SKU-100200300');
  });
  it('rejects junk / too-short / illegal chars', () => {
    expect(sanitiseWedgeRead('abc')).toBeNull();
    expect(sanitiseWedgeRead('*&^%$#')).toBeNull();
    expect(sanitiseWedgeRead('')).toBeNull();
    expect(sanitiseWedgeRead(undefined)).toBeNull();
  });
  it('repeat of the last code in the window is a duplicate (one event)', () => {
    const dup = { ...EMPTY_DEDUPE };
    const w = 2500;
    const first = prepareHardwareRead(dup, 'CTN-000123', 1000, w);
    expect(first!.duplicate).toBe(false);
    expect(first!.value).toBe('CTN-000123');
    // continuous re-sends of the SAME code stay suppressed
    for (let t = 1100; t <= 8000; t += 100) {
      const again = prepareHardwareRead(dup, 'CTN-000123', t, w);
      expect(again!.duplicate).toBe(true);
    }
  });
  it('a different code passes immediately after a duplicate stream', () => {
    const dup = { ...EMPTY_DEDUPE };
    prepareHardwareRead(dup, 'CTN-000123', 1000, 2500);
    prepareHardwareRead(dup, 'CTN-000123', 1100, 2500);
    const next = prepareHardwareRead(dup, 'CTN-000124', 1200, 2500);
    expect(next!.duplicate).toBe(false);
    expect(next!.value).toBe('CTN-000124');
  });
});

describe('hardware capability probe (order §9)', () => {
  it('returns a stable structure without touching devices', () => {
    const h = detectHardwareCapabilities();
    expect(typeof h.hidWedge).toBe('boolean');
    expect(typeof h.bluetooth).toBe('boolean');
    expect(typeof h.webUsb).toBe('boolean');
  });
});
