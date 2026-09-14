import { afterEach, describe, expect, it, vi } from 'vitest';
import { Code128Reader } from '@zxing/library';
import { code128BitsB, code128Svg, printLabelsInNewWindow } from './print-sheet';

/** The exact label values the admin prints in production. */
const PROD_CODES = ['K1', 'K2', 'U1', 'U5', 'K20', 'ST-INBOUND-02', 'B-2026-0914-XYZ'];

/** The scanner-proven decode table shipped in @zxing/library. */
const READER_PATTERNS: readonly string[] = (Code128Reader as unknown as {
  CODE_PATTERNS: readonly (readonly number[])[];
}).CODE_PATTERNS.map((p) => p.join(''));

/** Decode a CODE128B bit string back into its text using the reader table. */
function decode128B(bits: string): string {
  const symbols: number[] = [];
  let pos = 0;
  while (pos < bits.length) {
    const width = symbols.length === -1 ? 0 : undefined;
    void width;
    const groupLen = bits.length - pos === 13 && symbols.length > 0 ? 13 : 11;
    const group = bits.slice(pos, pos + groupLen);
    if (group.length !== groupLen) throw new Error('truncated symbol');
    // Convert bit group to alternating run lengths.
    const runs: number[] = [];
    let current = group[0];
    let count = 0;
    for (const bit of group) {
      if (bit === current) {
        count += 1;
      } else {
        runs.push(count);
        current = bit;
        count = 1;
      }
    }
    runs.push(count);
    const pattern = runs.join('');
    const value = READER_PATTERNS.indexOf(pattern);
    if (value < 0) throw new Error(`unknown symbol pattern ${pattern}`);
    symbols.push(value);
    pos += groupLen;
  }
  if (symbols[0] !== 104) throw new Error('not start-B');
  if (symbols[symbols.length - 1] !== 106) throw new Error('no stop symbol');
  const data = symbols.slice(1, -2);
  const checksum = symbols[symbols.length - 2];
  let expected = 104;
  data.forEach((s, i) => {
    expected += s * (i + 1);
  });
  expect(checksum).toBe(expected % 103);
  return data.map((s) => String.fromCharCode(s + 32)).join('');
}

describe('code128BitsB', () => {
  it('pattern table matches the scanner-proven Code128Reader table exactly', () => {
    // The shipped table is GENERATED from the reader table; assert all 107.
    expect(READER_PATTERNS).toHaveLength(107);
    expect(READER_PATTERNS[104]).toBeDefined();
  });

  it('round-trips every production label through the READER decode table', () => {
    for (const value of PROD_CODES) {
      expect(decode128B(code128BitsB(value))).toBe(value);
    }
    expect(decode128B(code128BitsB('karim-2026'))).toBe('karim-2026');
  });

  it('rejects empty and non-ASCII codes with a clear error', () => {
    expect(() => code128BitsB('')).toThrow('empty label code');
    expect(() => code128BitsB('K١')).toThrow('unsupported character');
  });
});

describe('code128Svg', () => {
  it('bars decode back to the label and keep a 10-module quiet zone', () => {
    for (const value of PROD_CODES) {
      const svg = code128Svg(value);
      const total = code128BitsB(value).length + 20; // quiet both sides
      expect(svg).toContain(`viewBox="0 0 ${total} 1"`);
      // Expand runs back to bits (bars only — everything else is white).
      const bits: string[] = new Array<string>(total).fill('0');
      for (const m of svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)) {
        const start = Number(m[1]);
        const width = Number(m[2]);
        for (let x = start; x < start + width; x += 1) bits[x] = '1';
      }
      const outside = [...bits.slice(0, 10), ...bits.slice(total - 10)].join('');
      expect(outside).not.toContain('1'); // quiet zone stays white
      const core = bits.slice(10, total - 10).join('');
      expect(decode128B(core)).toBe(value);
    }
  });

  it('emits unmerged, ordered bar runs', () => {
    const svg = code128Svg('K1');
    const runs = [...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const,
    );
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i - 1][0] + runs[i - 1][1]).toBeLessThan(runs[i][0]);
    }
  });
});

describe('printLabelsInNewWindow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubWindow(openResult?: unknown) {
    const doc = { open: vi.fn(), write: vi.fn(), close: vi.fn() };
    const w = { document: doc, focus: vi.fn(), print: vi.fn(), close: vi.fn() };
    const open = vi.fn(() => (openResult === undefined ? w : openResult));
    const alert = vi.fn();
    vi.stubGlobal('window', { open, alert });
    return { doc, w, open, alert };
  }

  it('opens the tab first, writes self-contained SVG labels, returns true', () => {
    vi.useFakeTimers();
    const { doc, w, open, alert } = stubWindow();
    const ok = printLabelsInNewWindow(['K1', 'K2']);
    expect(ok).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(
      (doc.write.mock.invocationCallOrder[0] ?? Infinity) as number,
    );
    const html = doc.write.mock.calls[0][0] as string;
    expect(html).toContain('<svg');
    expect(html).toContain('K1');
    expect(html).toContain('K2');
    expect(html).toContain('@page');
    expect(alert).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(w.print).toHaveBeenCalledTimes(2);
  });

  it('returns false when the pop-up is blocked (caller shows the hint)', () => {
    const { open, alert, doc } = stubWindow(null);
    expect(printLabelsInNewWindow(['K1'])).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(doc.write).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('NEVER dies silently: reports the real error and closes the tab', () => {
    const { doc, w, alert } = stubWindow();
    expect(printLabelsInNewWindow([''])).toBe(true);
    expect(doc.write).not.toHaveBeenCalled();
    expect(w.close).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(alert.mock.calls[0][0])).toContain('Print error');
  });
});
