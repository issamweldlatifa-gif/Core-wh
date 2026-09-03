/**
 * Composite confidence model — order §11.
 *
 * Final confidence is computed from several independent signals and is NOT
 * hard-coded in the pipeline:
 *
 *   Scanner confidence (deterministic barcode/QR = full)
 *   OCR engine confidence (Tesseract)
 *   Image-quality score (gate)
 *   Format validation (field rules)
 *   Database match (corpus: exact / candidate / none / no-corpus)
 *   Multi-frame consensus votes
 *
 * Levels (configurable in scan-config):
 *   HIGH   → automatic confirmation allowed
 *   MEDIUM → worker confirmation required
 *   LOW    → retry scan (never submit)
 *
 * The thresholds below are conservative initial values — re-tune from the
 * §17 real-label benchmark without touching pipeline code.
 */

import type { ScanConfig } from './scan-config';
import type { QualityLevel } from './image-quality';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export type DetectionType = 'BARCODE' | 'QR' | 'OCR';

export interface ConfidenceInput {
  /** What produced the code. */
  detection: DetectionType;
  /** OCR engine confidence 0..1 (Tesseract), when detection === 'OCR'. */
  ocrConfidence?: number;
  /** Image Quality gate score 0..1, when available. */
  qualityScore?: number;
  /** Field-format plausibility 0..1 (fields.ts). */
  formatScore?: number;
  /** Corpus dbScore 0..1 (validate.ts) when a corpus was supplied. */
  dbScore?: number;
  /** Corpus present? (drives how dbScore is interpreted). */
  corpusPresent?: boolean;
  /** What the corpus lookup concluded — candidates may NEVER auto-submit. */
  matchKind?: 'exact' | 'candidate' | 'none' | 'no_corpus';
  /** Weighted consensus votes for this token (multiframe.ts). */
  votes?: number;
}

export interface ConfidenceResult {
  score: number; // 0..100
  level: ConfidenceLevel;
  components: { quality: number; ocr: number; format: number; database: number };
  reasons: string[];
}

/**
 * Compose the final confidence.
 * Barcode/QR paths are deterministic identification: they short-circuit OCR
 * and are always HIGH (order §12) — subject to the duplicate guard.
 */
export function computeConfidence(input: ConfidenceInput, cfg: ScanConfig): ConfidenceResult {
  const { thresholds, weights, consensusBonusMax } = cfg.confidence;

  if (input.detection === 'BARCODE' || input.detection === 'QR') {
    return {
      score: 100,
      level: 'HIGH',
      components: { quality: 1, ocr: 1, format: 1, database: 1 },
      reasons: ['barcode_deterministic'],
    };
  }

  const q = clamp01(input.qualityScore ?? 0.35);
  const o = clamp01(input.ocrConfidence ?? 0);
  const f = clamp01(input.formatScore ?? 0.4);
  const hasCorpus = input.corpusPresent === true && input.dbScore !== undefined;
  const db = hasCorpus ? clamp01(input.dbScore ?? 0) : cfg.validation.noCorpusNeutralScore;

  // When there is no corpus we cannot claim database evidence either way —
  // spread the database weight over OCR+quality so an unvalidatable OCR read
  // still requires a high engine+quality score to reach HIGH.
  let wQ = weights.quality;
  let wO = weights.ocr;
  let wF = weights.format;
  let wD = weights.database;
  const total = wQ + wO + wF + wD;
  if (!hasCorpus) {
    wO += wD; // engine confidence carries the weight of the missing corpus
    wD = 0;
  }

  const raw = (q * wQ + o * wO + f * wF + db * wD) / Math.max(1e-9, wQ + wO + wF + wD);
  let score = raw * 100;

  // Multi-frame consensus bonus (capped): repeated independent reads raise
  // confidence, a lone read gets none.
  const votes = input.votes ?? 0;
  const voteFactor = clamp01((votes - 1) / 3);
  score += consensusBonusMax * 100 * voteFactor;

  // Format floor for OCR: a token that fails every format rule is capped below
  // HIGH even if the engine was confident — it must not auto-submit.
  if (input.detection === 'OCR' && f < 0.3) {
    score = Math.min(score, thresholds.high - 1);
  }
  // Corpus-absence floor: with no corpus to validate against, an OCR read can
  // never auto-submit silently — it always needs worker confirmation (§10).
  if (input.detection === 'OCR' && !hasCorpus) {
    score = Math.min(score, thresholds.high - 1);
  }
  // Candidate floor: only an EXACT corpus hit may auto-confirm. A confusable
  // near-match (ABCI2345 vs ABC12345) must always be shown to the worker as
  // «Possible match» (§10/§11/§19 — never blind auto-correction).
  if (input.detection === 'OCR' && hasCorpus && input.matchKind === 'candidate') {
    score = Math.min(score, thresholds.high - 1);
  }

  score = clamp(score, 0, 100);
  const level = score >= thresholds.high ? 'HIGH' : score >= thresholds.medium ? 'MEDIUM' : 'LOW';
  const reasons: string[] = [];
  if (q < 0.5) reasons.push('low_image_quality');
  if (o < 0.6) reasons.push('low_ocr_confidence');
  if (f < 0.3) reasons.push('bad_format');
  if (hasCorpus && db === 1) reasons.push('exact_corpus_match');
  else if (hasCorpus && db > 0.5) reasons.push('candidate_corpus_match');
  else if (hasCorpus) reasons.push('no_corpus_match');
  if (votes >= 3) reasons.push(`consensus_${votes}`);

  return { score, level, components: { quality: q, ocr: o, format: f, database: db }, reasons };
}

/** Map the gate level to a 0..1 seed when no full metrics exist yet. */
export function levelScore(level: QualityLevel): number {
  switch (level) {
    case 'GOOD': return 0.95;
    case 'MARGINAL': return 0.6;
    default: return 0.25;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
