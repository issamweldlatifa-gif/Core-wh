/**
 * P3 pure-layer tests: scan-profile derivation + level-2 candidate selection.
 */
import { describe, expect, it } from 'vitest';
import { buildScanContext, type ScanContext } from './scan-context';
import { deriveScanProfile, leadingAlphaPrefix, longestCommonPrefix, profileFilterFor } from './scan-profile';
import { rankLevel2Lines } from './pp-ocr/select';
import { DEFAULT_SCAN_CONFIG } from './scan-config';
import type { RecognisedLine } from './pp-ocr/types';

function sbCard(): ScanContext {
  return buildScanContext({
    mode: 'PRODUCT',
    products: [
      { sku: 'sb2310176616632001', reference: 'REF-A' },
      { sku: 'sb2310176616632002' },
    ],
  });
}

function numericCard(): ScanContext {
  return buildScanContext({
    mode: 'PRODUCT',
    products: [{ sku: '1234567890123' }, { sku: '9876543210987' }],
  });
}

function line(text: string, confidence: number): RecognisedLine {
  return {
    box: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    text,
    confidence,
  };
}

describe('deriveScanProfile', () => {
  it('SKU card → SKU strip profile with the shared sb prefix', () => {
    const p = deriveScanProfile(sbCard());
    expect(p.mode).toBe('SKU');
    expect(p.prefix).toBe('SB');
    expect(p.frame).toBe('strip');
    expect(p.hint).toContain('SB');
  });

  it('numeric-only SKUs → no over-narrowed prefix, frame strip', () => {
    const p = deriveScanProfile(numericCard());
    expect(p.mode).toBe('SKU');
    expect(p.prefix).toBe('');
    expect(p.frame).toBe('strip');
  });

  it('CARTON context → band frame', () => {
    const p = deriveScanProfile(
      buildScanContext({ mode: 'CARTON', cartons: [{ externalCartonId: 'CTN-1' }] }),
    );
    expect(p.mode).toBe('CARTON');
    expect(p.frame).toBe('band');
  });
});

describe('profileFilterFor', () => {
  it('kills non-family lines but keeps the code', () => {
    const f = profileFilterFor(deriveScanProfile(sbCard()));
    expect(f.accepts('sb2310176616632001')).toBe(true);
    expect(f.accepts('PB2602010156165')).toBe(false);
    expect(f.accepts('Made In China')).toBe(false);
    expect(f.accepts('12')).toBe(false);
  });
});

describe('longestCommonPrefix + leadingAlphaPrefix', () => {
  it('computes shared prefix / alpha prefix', () => {
    expect(longestCommonPrefix(['SB23A', 'SB23B', 'SB99'])).toBe('SB');
    expect(longestCommonPrefix(['SB1'])).toBe('SB1');
    expect(leadingAlphaPrefix('sb2310176616632001')).toBe('SB');
    expect(leadingAlphaPrefix('123456')).toBe('');
  });
});

describe('rankLevel2Lines (level-2 candidate selection)', () => {
  it('keeps only the card-exact code and kills prefix-violating decoy lines', () => {
    const ctx = sbCard();
    const known = ctx.values;
    const profile = deriveScanProfile(ctx);
    const cfg = { ...DEFAULT_SCAN_CONFIG };
    const ranked = rankLevel2Lines(
      [
        line('PB2602010156165', 0.89),
        line('Made In China', 0.8),
        line('sb2310176616632001', 0.9),
      ],
      { mode: 'PRODUCT', cfg, known, profile },
    );
    expect(ranked.length).toBe(1);
    expect(ranked[0].readValue).toBe('SB2310176616632001');
    expect(ranked[0].value).toBe('SB2310176616632001');
    expect(ranked[0].match.kind).toBe('exact');
  });

  it('still accepts an exact expected reference even when it lacks the SKU prefix', () => {
    const ctx = sbCard();
    const profile = deriveScanProfile(ctx);
    const cfg = { ...DEFAULT_SCAN_CONFIG };
    const ranked = rankLevel2Lines(
      [line('Made In China', 0.85), line('REF-A', 0.9), line('sb2310176616632001', 0.9)],
      { mode: 'PRODUCT', cfg, known: ctx.values, profile },
    );
    const reads = ranked.map((r) => r.readValue);
    expect(reads).toContain('SB2310176616632001');
    expect(reads).toContain('REF-A'); // exact expected value, no prefix match needed
    expect(reads).not.toContain('MADEINCHINA');
  });

  it('without a corpus every plausible line is a candidate', () => {
    const cfg = { ...DEFAULT_SCAN_CONFIG };
    const ranked = rankLevel2Lines(
      [line('PB2602010156165', 0.89), line('sb2310176616632001', 0.99)],
      { mode: 'PRODUCT', cfg, known: [] },
    );
    expect(ranked.length).toBe(2);
  });
});
