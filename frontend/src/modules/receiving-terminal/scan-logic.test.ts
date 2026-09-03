import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_CONFIG, mergeConfig } from './scan-config';
import { computeRoi, roiOverlayStyle, ROI_RATIO } from './roi';
import { normaliseToken, ocrEditDistance, confusableAliases } from './normalize';
import { matchAgainstCorpus, buildSessionCorpus, cleanCode } from './validate';
import { computeConfidence } from './confidence';
import { createConsensus } from './multiframe';
import { createTelemetry } from './telemetry';
import { extractFieldTokens } from './fields';

describe('scan-config', () => {
  it('deep-merges partial overrides and keeps defaults', () => {
    const cfg = mergeConfig(DEFAULT_SCAN_CONFIG, {
      confidence: { thresholds: { high: 90 } },
      camera: { resolution: { DESKTOP: { width: 1280, height: 720 } } },
    });
    expect(cfg.confidence.thresholds.high).toBe(90);
    expect(cfg.confidence.thresholds.medium).toBe(DEFAULT_SCAN_CONFIG.confidence.thresholds.medium);
    expect(cfg.camera.resolution.DESKTOP.width).toBe(1280);
    expect(cfg.camera.resolution.SMARTPHONE.width).toBe(DEFAULT_SCAN_CONFIG.camera.resolution.SMARTPHONE.width);
    expect(cfg.ocr.framesBeforeOcr).toBe(DEFAULT_SCAN_CONFIG.ocr.framesBeforeOcr);
  });
});

describe('roi', () => {
  it('computes a centred region with the given ratio', () => {
    const r = computeRoi(1280, 720, ROI_RATIO);
    expect(r.width).toBe(Math.round(1280 * 0.82));
    expect(r.height).toBe(Math.round(720 * 0.3));
    expect(r.x + r.width / 2).toBeCloseTo(640);
    expect(r.y + r.height / 2).toBeCloseTo(360);
  });
  it('overlay style matches the analysed region', () => {
    const s = roiOverlayStyle({ w: 0.82, h: 0.3 });
    expect(parseFloat(s.width)).toBeCloseTo(82);
    expect(parseFloat(s.left)).toBeCloseTo(9);
  });
});

describe('normalize — OCR confusion model (order §9)', () => {
  it('cleans raw OCR noise deterministically', () => {
    expect(normaliseToken(' aBc_12345 ')).toBe('ABC12345');
    expect(normaliseToken('|SKU-123|')).toBe('SKU-123');
  });
  it('treats confusable glyph substitutions as cheap', () => {
    expect(confusableAliases('I')).toContain('1');
    expect(confusableAliases('B')).toContain('8');
    // P0 example: OCR "ABCI2345" → record "ABC12345" is only 0.5 away.
    expect(ocrEditDistance('ABCI2345', 'ABC12345')).toBeLessThanOrEqual(0.6);
    // a real different code stays expensive
    expect(ocrEditDistance('ABCI2345', 'ZZZZZZZZ')).toBeGreaterThan(3);
  });
  it('does not blindly equalise confusables', () => {
    // O is a plausible real letter in many references; distance keeps the
    // distinction instead of replacing all O→0.
    expect(ocrEditDistance('ABO', 'AB0')).toBe(0.5);
    expect(ocrEditDistance('ABO', 'ABO')).toBe(0);
  });
});

describe('validate — corpus matching (order §10)', () => {
  const corpus = ['ABC12345', 'CTN-000123', '1Z999AA10123456784', 'SKU-100200300'];
  it('exact match is reported as exact (HIGH source)', () => {
    const m = matchAgainstCorpus('ABC12345', corpus, DEFAULT_SCAN_CONFIG.validation);
    expect(m.kind).toBe('exact');
    expect(m.matched).toBe('ABC12345');
    expect(m.dbScore).toBe(1);
  });
  it('confusable OCR read becomes a candidate, not a guess', () => {
    const m = matchAgainstCorpus('ABCI2345', corpus, DEFAULT_SCAN_CONFIG.validation);
    expect(m.kind).toBe('candidate');
    expect(m.candidates[0]?.value).toBe('ABC12345');
    expect(m.bestDistance).toBeLessThanOrEqual(1.2);
  });
  it('unrelated code → none with low dbScore', () => {
    const m = matchAgainstCorpus('XYZ99999', corpus, DEFAULT_SCAN_CONFIG.validation);
    expect(m.kind).toBe('none');
    expect(m.candidates).toHaveLength(0);
  });
  it('length gate rejects nonsense matches', () => {
    const m = matchAgainstCorpus('AB', corpus, DEFAULT_SCAN_CONFIG.validation);
    expect(['none', 'no_corpus']).toContain(m.kind);
  });
  it('no corpus → no_corpus with a neutral score (never auto-HIGH on its own)', () => {
    const m = matchAgainstCorpus('ABC12345', [], DEFAULT_SCAN_CONFIG.validation);
    expect(m.kind).toBe('no_corpus');
    expect(m.dbScore).toBe(DEFAULT_SCAN_CONFIG.validation.noCorpusNeutralScore);
  });
});

describe('validate — buildSessionCorpus', () => {
  it('collects carton identity fields and product SKUs/references', () => {
    const codes = buildSessionCorpus(
      [
        { externalCartonId: 'ctn-1', qrCodeValue: 'QR1', barcodeValue: 'BC1', reference: null },
        { externalCartonId: 'ctn-2' },
      ],
      [{ sku: 'sku-9', reference: 'r' }],
    );
    expect(codes).toContain('CTN-1');
    expect(codes).toContain('QR1');
    expect(codes).toContain('SKU-9');
    expect(codes.filter((c) => c === 'CTN-2')).toHaveLength(1);
  });
  it('cleanCode is stable', () => {
    expect(cleanCode('  abc123  ')).toBe('ABC123');
  });
});

describe('confidence (order §11)', () => {
  const cfg = DEFAULT_SCAN_CONFIG;
  it('barcode/QR decode is always HIGH (deterministic identification)', () => {
    expect(computeConfidence({ detection: 'BARCODE' }, cfg).level).toBe('HIGH');
    expect(computeConfidence({ detection: 'QR' }, cfg).level).toBe('HIGH');
  });
  it('strong OCR with an exact corpus hit is HIGH', () => {
    const r = computeConfidence(
      { detection: 'OCR', ocrConfidence: 0.9, qualityScore: 0.9, formatScore: 0.9, dbScore: 1, corpusPresent: true, votes: 3 },
      cfg,
    );
    expect(r.level).toBe('HIGH');
    expect(r.score).toBeGreaterThanOrEqual(cfg.confidence.thresholds.high);
  });
  it('fuzzy OCR that hits an exact DB record is MEDIUM → worker confirmation, not auto', () => {
    const r = computeConfidence(
      { detection: 'OCR', ocrConfidence: 0.3, qualityScore: 0.3, formatScore: 0.4, dbScore: 1, corpusPresent: true, votes: 3 },
      cfg,
    );
    expect(r.level).toBe('MEDIUM');
  });
  it('CANDIDATE corpus match can never auto-submit, even with a perfect OCR read (§10/§19)', () => {
    // OCR read ABCI2345 → fuzzy-hit ABC12345: dbScore is near-full because the
    // distance is tiny, but the match kind is 'candidate' (a correction, not a
    // confirmation). The candidate floor must keep it below HIGH so the worker
    // sees «Possible match: ABC12345» instead of a blind auto-submit.
    const r = computeConfidence(
      { detection: 'OCR', ocrConfidence: 0.95, qualityScore: 0.95, formatScore: 0.9, dbScore: 0.98, corpusPresent: true, matchKind: 'candidate', votes: 3 },
      cfg,
    );
    expect(r.level).not.toBe('HIGH');
    expect(r.level).toBe('MEDIUM');
    expect(r.reasons).toContain('candidate_corpus_match');
  });
  it('weak OCR with NO corpus match stays LOW (never submits)', () => {
    const r = computeConfidence(
      { detection: 'OCR', ocrConfidence: 0.3, qualityScore: 0.3, formatScore: 0.4, dbScore: 0.12, corpusPresent: true, votes: 3 },
      cfg,
    );
    expect(r.level).toBe('LOW');
  });
  it('no corpus: OCR can never silently reach HIGH (worker confirmation required)', () => {
    const r = computeConfidence(
      { detection: 'OCR', ocrConfidence: 0.95, qualityScore: 0.95, formatScore: 0.95, corpusPresent: false, votes: 3 },
      cfg,
    );
    expect(r.level).not.toBe('HIGH');
    expect(r.level).toBe('MEDIUM');
  });
  it('bad format caps an otherwise confident OCR read below HIGH', () => {
    const r = computeConfidence(
      { detection: 'OCR', ocrConfidence: 0.95, qualityScore: 0.95, formatScore: 0.1, dbScore: 1, corpusPresent: true, votes: 3 },
      cfg,
    );
    expect(r.level).not.toBe('HIGH');
  });
});

describe('multiframe consensus (order §13)', () => {
  it('requires repeated weighted votes before a token stabilises', () => {
    const agg = createConsensus(DEFAULT_SCAN_CONFIG.consensus);
    expect(agg.pushFrame([{ token: 'ABC12345', weight: 1 }])).toEqual([]);
    expect(agg.pushFrame([{ token: 'ABC12345', weight: 1 }])).toEqual([]);
    const stable = agg.pushFrame([{ token: 'ABC12345', weight: 1 }]);
    expect(stable).toEqual(['ABC12345']);
  });
  it('low-quality (weak) frames cannot reach the bar', () => {
    const agg = createConsensus(DEFAULT_SCAN_CONFIG.consensus);
    for (let i = 0; i < 8; i += 1) {
      expect(agg.pushFrame([{ token: 'WEAK0001', weight: 0.35 }])).toEqual([]);
    }
  });
  it('clears after a stable result (identity dedupe)', () => {
    const agg = createConsensus(DEFAULT_SCAN_CONFIG.consensus);
    agg.pushFrame([{ token: 'ABC12345', weight: 1 }]);
    agg.pushFrame([{ token: 'ABC12345', weight: 1 }]);
    expect(agg.pushFrame([{ token: 'ABC12345', weight: 1 }])).toEqual(['ABC12345']);
    // must re-accumulate before it can fire again
    expect(agg.pushFrame([{ token: 'ABC12345', weight: 1 }])).toEqual([]);
  });
});

describe('fields (order §8)', () => {
  it('pulls plausible code tokens out of shipping-label noise', () => {
    const text = [
      'Ship To: TUN CENTER',
      'PO: 4581',
      'TRACKING 1Z999AA10123456784',
      'CTN-000123',
    ].join('\n');
    const tokens = extractFieldTokens(text);
    const vals = tokens.map((t) => t.token);
    expect(vals).toContain('CTN-000123');
    expect(vals).toContain('1Z999AA10123456784');
    // stopwords like TRACKING/PO do not leak as codes
    expect(vals).not.toContain('TRACKING');
  });
});

describe('telemetry (order §16)', () => {
  it('aggregates rates and never stores images', () => {
    const t = createTelemetry(100, 'S-1');
    t.record({ ts: 1, scanSessionId: 'S-1', mode: 'CARTON', scanMethod: 'software', provider: 'software-camera', scannerType: 'tesseract', detectionType: 'OCR', processingMs: 120, ocrConfidence: 0.6, imageQuality: 0.7, validationResult: 'candidate', finalResult: 'worker_confirmed', deviceType: 'SMARTPHONE' });
    t.record({ ts: 2, scanSessionId: 'S-1', mode: 'CARTON', scanMethod: 'hardware', provider: 'hid', scannerType: 'external', detectionType: 'SCANNER', processingMs: 30, validationResult: 'na', finalResult: 'auto_submitted', deviceType: 'HID' });
    t.markBackendVerdict(true);
    const s = t.summary();
    expect(s.attempts).toBe(2);
    expect(s.byMethod).toEqual({ software: 1, hardware: 1 });
    expect(s.byDetection.OCR).toBe(1);
    expect(s.byDetection.SCANNER).toBe(1);
    expect(s.barcodeAttempts).toBe(0);
    expect(s.accepted).toBe(1);
    expect(s.ocrCorrections).toBe(1);
    // final-order §27 latency distribution over attempts
    expect(s.latency.p50).toBeGreaterThanOrEqual(0);
    expect(s.latency.max).toBeGreaterThanOrEqual(s.latency.p99);
    expect(s.latency.p99).toBeGreaterThanOrEqual(s.latency.p95);
    expect(s.latency.p95).toBeGreaterThanOrEqual(s.latency.p50);
    // dual-order §12 — csv exposes method/provider/attempt fields
    expect(t.toCSV()).toContain('ts,attemptNumber,scanMethod,provider,scannerType');
    t.clear();
    expect(t.summary().attempts).toBe(0);
  });
  it('rejects stay counted as false positives', () => {
    const t = createTelemetry();
    t.record({ ts: 1, scannerType: 'tesseract', detectionType: 'OCR', processingMs: 10, validationResult: 'exact', finalResult: 'auto_submitted' });
    t.markBackendVerdict(false);
    expect(t.summary().falsePositives).toBe(1);
  });
});
