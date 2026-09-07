/**
 * DEVICE-SIDE MATCHING — card-based receiving (web terminal).
 *
 * E2E matrix (device level): PRODUCT lane (QR/barcode/OCR-SKU/OCR-ref
 * match, wrong identifier mismatch, completed card reject), CARTON lane
 * (tracking/QR/barcode/ref match, wrong mismatch, completed reject,
 * ambiguous tracking) and multiple independent cards (each lane only ever
 * sees its own card type).
 */
import { describe, expect, it } from 'vitest';
import type { CartonCard, ProductCard } from './api';
import { matchCartonCard, matchProductCard, normalizeTerm, sameCode } from './match';

function product(over: Partial<ProductCard> = {}): ProductCard {
  return {
    id: 'pc-1',
    sku: 'SKU/A-01',
    reference: 'REF-01',
    productName: 'Test product',
    category: 'CLOTHING',
    subcategory: null,
    categoryStatus: 'CONFIRMED',
    expected: 3,
    received: 0,
    remaining: 3,
    status: 'EXPECTED',
    identifiers: ['SKU/A-01', 'REF-01'],
    ...over,
  };
}

function carton(over: Partial<CartonCard> = {}): CartonCard {
  return {
    id: 'cc-1',
    externalCartonId: 'CTN-001',
    reference: 'REF-CTN-1',
    qrCodeValue: 'QR123456789',
    barcodeValue: '6291001002011',
    cartonNumber: 1,
    totalCartons: 2,
    trackingNumber: 'TRK-111',
    senderName: 'Sender Co',
    shippedAt: '2026-09-01T08:00:00.000Z',
    weight: 12,
    weightUnit: 'KG',
    dimensions: null,
    status: 'EXPECTED',
    identifiers: ['CTN-001', 'REF-CTN-1', 'QR123456789', '6291001002011'],
    ...over,
  };
}

describe('normalization (mirrors backend scan-normalizer)', () => {
  it('collapses whitespace, trims, uppercases', () => {
    expect(normalizeTerm('  sku / a-01\n\tb ')).toBe('SKU / A-01 B');
  });

  it('sameCode is case-insensitive and ignores short codes', () => {
    expect(sameCode('sku/a-01', 'SKU/A-01')).toBe(true);
    expect(sameCode('ab', 'ABC')).toBe(false);
    expect(sameCode('A', 'A')).toBe(false); // length < 2 is not a usable code
    expect(sameCode(null, 'CTN-001')).toBe(false);
  });
});

describe('PRODUCT card matching (PRODUIT lane)', () => {
  const cards = [product(), product({ id: 'pc-2', sku: 'SKU/B-02', reference: 'REF-02', identifiers: ['SKU/B-02', 'REF-02'] })];

  it('matches a QR / barcode identifier against card identifiers', () => {
    expect(matchProductCard('sku/a-01', cards)?.id).toBe('pc-1');
    expect(matchProductCard('SKU/B-02', cards)?.id).toBe('pc-2');
  });

  it('matches SKU and reference (OCR-read values), case-insensitive', () => {
    expect(matchProductCard('ref-01', cards)?.id).toBe('pc-1');
    expect(matchProductCard('REF / 01 ', cards)).toBeNull(); // normalization keeps the slash
    expect(matchProductCard('ref-02', cards)?.id).toBe('pc-2');
  });

  it('reports MISMATCH for a wrong identifier / wrong product', () => {
    expect(matchProductCard('SKU/ZZZ', cards)).toBeNull();
    expect(matchProductCard('6291001002011', cards)).toBeNull(); // a carton code is not a product
  });

  it('rejects a completed card (duplicate completion protection, local)', () => {
    const done = product({ received: 3, remaining: 0, status: 'RECEIVED' });
    const m = matchProductCard('SKU/A-01', [done]);
    expect(m).not.toBeNull(); // the match still identifies the card…
    expect(m!.received >= m!.expected).toBe(true); // …so the UI refuses to confirm
  });
});

describe('CARTON card matching (CARTON lane)', () => {
  const c1 = carton();
  const c2 = carton({ id: 'cc-2', externalCartonId: 'CTN-002', cartonNumber: 2, reference: 'REF-CTN-2', qrCodeValue: 'QR999', barcodeValue: '6291001002022', identifiers: ['CTN-002', 'REF-CTN-2', 'QR999', '6291001002022'] });
  const cards = [c1, c2];

  it('matches carton reference / external id / QR / barcode', () => {
    expect(matchCartonCard('ctn-001', cards)).toMatchObject({ result: 'card', card: { externalCartonId: 'CTN-001' } });
    expect(matchCartonCard('REF-CTN-2', cards)).toMatchObject({ result: 'card', card: { externalCartonId: 'CTN-002' } });
    expect(matchCartonCard('QR123456789', cards)).toMatchObject({ result: 'card', card: { externalCartonId: 'CTN-001' } });
    expect(matchCartonCard('6291001002022', cards)).toMatchObject({ result: 'card', card: { externalCartonId: 'CTN-002' } });
  });

  it('matches the shipment TRACKING number when exactly one carton is open', () => {
    const oneOpen = [carton(), carton({ id: 'cc-2', externalCartonId: 'CTN-002', cartonNumber: 2, status: 'RECEIVED', identifiers: [] })];
    expect(matchCartonCard('TRK-111', oneOpen)).toMatchObject({ result: 'card', matchedOn: 'TRACKING NUMBER', card: { externalCartonId: 'CTN-001' } });
  });

  it('reports AMBIGUOUS when the tracking number leaves several cartons open', () => {
    const m = matchCartonCard('TRK-111', cards);
    expect(m.result).toBe('ambiguous');
    if (m.result === 'ambiguous') {
      expect(m.cartons.map((c) => c.externalCartonId).sort()).toEqual(['CTN-001', 'CTN-002']);
    }
  });

  it('reports all-received when the tracking number has no open cartons', () => {
    const allReceived = [carton({ status: 'RECEIVED', identifiers: [] }), carton({ id: 'cc-2', externalCartonId: 'CTN-002', cartonNumber: 2, status: 'RECEIVED', identifiers: [] })];
    expect(matchCartonCard('TRK-111', allReceived).result).toBe('all-received');
  });

  it('rejects a received carton (duplicate completion protection, local)', () => {
    const m = matchCartonCard('CTN-001', [carton({ status: 'RECEIVED' })]);
    expect(m).toMatchObject({ result: 'card' });
    if (m.result === 'card') expect(m.card.status).toBe('RECEIVED'); // UI shows ALREADY RECEIVED, no confirm
  });

  it('reports MISMATCH for a wrong identifier', () => {
    expect(matchCartonCard('NOPE-999', cards).result).toBe('none');
    expect(matchCartonCard('SKU/A-01', cards).result).toBe('none'); // a product code is not a carton
  });
});

describe('multiple cards — independent card types, never merged', () => {
  it('the PRODUCT lane only matches product cards (carton codes never match)', () => {
    const products = [product()];
    expect(matchProductCard('CTN-001', products)).toBeNull();
    expect(matchProductCard('QR123456789', products)).toBeNull();
    expect(matchProductCard('SKU/A-01', products)?.sku).toBe('SKU/A-01');
  });

  it('the CARTON lane only matches carton cards (product codes never match)', () => {
    const cartons = [carton()];
    expect(matchCartonCard('SKU/A-01', cartons).result).toBe('none');
    expect(matchCartonCard('CTN-001', cartons).result).toBe('card');
  });

  it('each card is matched independently (two confirmations, two cards)', () => {
    const products = [product(), product({ id: 'pc-2', sku: 'SKU/B-02', reference: 'REF-02', identifiers: ['SKU/B-02', 'REF-02'] })];
    const a = matchProductCard('SKU/A-01', products)!;
    const b = matchProductCard('SKU/B-02', products)!;
    expect(a.id).not.toBe(b.id);
    // confirming one card does not move the other
    const after = products.map((p) => (p.id === a.id ? { ...p, received: 1, remaining: 2 } : p));
    expect(matchProductCard('SKU/B-02', after)!.received).toBe(0);
  });
});
