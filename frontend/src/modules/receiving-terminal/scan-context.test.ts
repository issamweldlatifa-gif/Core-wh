import { describe, expect, it } from 'vitest';
import {
  buildScanContext, localExpectedMatch, normaliseExpected,
  isEmptyContext, expectedHint, EMPTY_SCAN_CONTEXT,
} from './scan-context';

const cartons = [
  { externalCartonId: 'CTN-000123', qrCodeValue: 'QR-AYROVI-1', barcodeValue: 'BR-88231', reference: 'REF-C1' },
  { externalCartonId: null, qrCodeValue: 'qr-ayrovi-1', barcodeValue: null, reference: null }, // duplicate QR (case)
  { externalCartonId: 'CTN-000124', qrCodeValue: null, barcodeValue: 'BR-88232', reference: 'REF-C2' },
];
const products = [
  { sku: 'SKU-250125789', reference: 'SO-55991-K' },
  { sku: 'sku-764332100', reference: null }, // duplicate sku (case-insensitive)
  { sku: null, reference: 'CUST-55991-AB' },
];

describe('scan context — prefetch + expected normalisation (final order §5–§7)', () => {
  it('CARTON mode collects carton id + QR + barcode + reference, de-duplicated', () => {
    const ctx = buildScanContext({ mode: 'CARTON', cartons, products });
    expect(ctx.values).toContain('CTN-000123');
    expect(ctx.values).toContain('QR-AYROVI-1');
    expect(ctx.values).toContain('BR-88231');
    expect(ctx.values).toContain('REF-C1');
    // dedupe of the repeated lower-case QR value
    expect(ctx.values.filter((v) => v === 'QR-AYROVI-1').length).toBe(1);
    expect(ctx.targetType).toBe('CARTON');
    expect(ctx.sourceRecords).toBe(cartons.length);
    // PRODUCT skus must NOT leak into carton context (mode-gated matching)
    expect(ctx.values).not.toContain('SKU-250125789');
  });

  it('PRODUCT mode collects SKUs + references only, deduped & uppercased', () => {
    const ctx = buildScanContext({ mode: 'PRODUCT', cartons, products });
    expect(ctx.values).toContain('SKU-250125789');
    expect(ctx.values).toContain('SKU-764332100');
    expect(ctx.values).toContain('CUST-55991-AB');
    expect(ctx.targetType).toBe('SKU');
    // carton codes must NOT leak into product context
    expect(ctx.values).not.toContain('CTN-000123');
  });

  it('a product set without any SKU reports REFERENCE target', () => {
    const ctx = buildScanContext({ mode: 'PRODUCT', products: [{ sku: null, reference: 'SO-1-K' }] });
    expect(ctx.targetType).toBe('REFERENCE');
  });

  it('normalisation is comparison-ready (uppercase, stripped, no junk)', () => {
    expect(normaliseExpected('  sku_250125789 ')).toBe('SKU250125789');
    expect(normaliseExpected('SKU-250125789')).toBe('SKU-250125789');
    expect(normaliseExpected('---')).toBe('');
    expect(normaliseExpected(null)).toBe('');
  });

  it('empty input → empty context that is safely not matching', () => {
    const ctx = buildScanContext({ mode: 'PRODUCT', cartons: [], products: [] });
    expect(isEmptyContext(ctx)).toBe(true);
    expect(isEmptyContext(EMPTY_SCAN_CONTEXT)).toBe(true);
    expect(localExpectedMatch(ctx, 'ANYTHING').matched).toBe(false);
  });
});

describe('local expected matching (final order §11/§30 — no backend per frame)', () => {
  const ctx = buildScanContext({ mode: 'PRODUCT', cartons: [], products });

  it('exact local match returns true and the entry kind', () => {
    const m = localExpectedMatch(ctx, 'SKU-250125789');
    expect(m.matched).toBe(true);
    expect(m.entry?.kind).toBe('SKU');
  });

  it('case-insensitive observed value still matches (normalised once)', () => {
    expect(localExpectedMatch(ctx, '  sku-250125789 ').matched).toBe(true);
  });

  it('a value NOT in the expected set is rejected locally (no DB sweep)', () => {
    expect(localExpectedMatch(ctx, 'SKU-999999999').matched).toBe(false);
    expect(localExpectedMatch(ctx, 'CTN-000123').matched).toBe(false); // carton code ≠ product expected
  });

  it('expectedHint guides the worker per target type', () => {
    expect(expectedHint(buildScanContext({ mode: 'CARTON', cartons, products: [] }))).toContain('carton');
    expect(expectedHint(ctx)).toContain('SKU');
  });
});
