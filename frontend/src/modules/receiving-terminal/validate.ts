/**
 * Validation against AYROVI data — order §10.
 *
 * An OCR result is never trusted because it “looks right”. It is looked up
 * against the known corpus (expected cartons + expected products of the
 * receiving session). Outcomes:
 *
 *   EXACT     — the code exists verbatim      → HIGH (can confirm/auto)
 *   CANDIDATE — OCR is a few confusable edits  → «Possible match: X» shown,
 *              never auto-submitted past a documented threshold
 *   NONE      — «No matching Article found»    → retry or manual entry
 *
 * Matching uses `ocrEditDistance` so that OCR confusions (O/0, I/1, B/8 …)
 * make a real record cheap to reach — but ONLY a real record. Blind global
 * substitution is never applied to OCR output (order §9/§19).
 */

import { normaliseToken, ocrEditDistance } from './normalize';

export interface ValidationConfigLike {
  maxCandidateDistance: number;
  confusableSubstitutionCost: number;
  maxCandidates: number;
  noCorpusNeutralScore: number;
  exactMatchScore: number;
}

export type MatchKind = 'exact' | 'candidate' | 'none' | 'no_corpus';

export interface CorpusCandidate {
  value: string;
  distance: number;
  /** closeness 0..1 (1 = distance 0) */
  score: number;
}

export interface CorpusMatch {
  kind: MatchKind;
  matched?: string;
  bestDistance: number;
  candidates: CorpusCandidate[];
  /** 0..1 score for the confidence model. */
  dbScore: number;
}

/** Clean a corpus code once (cached, avoids re-uppercasing every frame). */
export function cleanCode(raw: string): string {
  return (raw ?? '').trim().toUpperCase();
}

/**
 * Look up one normalised token against the corpus.
 * `corpus` must already be cleaned upper-case strings (see cleanCode).
 */
export function matchAgainstCorpus(
  rawToken: string,
  corpus: string[],
  cfg: ValidationConfigLike,
): CorpusMatch {
  const token = normaliseToken(rawToken);
  if (!token) return empty('no_corpus', cfg);
  if (!corpus || corpus.length === 0) {
    return {
      kind: 'no_corpus',
      bestDistance: 0,
      candidates: [],
      dbScore: cfg.noCorpusNeutralScore,
    };
  }

  // 1) exact
  for (const c of corpus) if (c === token) return exactMatch(c, cfg);

  // 2) candidate — confusable edit distance over the corpus
  const scored: CorpusCandidate[] = [];
  for (const c of corpus) {
    if (Math.abs(c.length - token.length) > 2) continue; // length gate
    const d = ocrEditDistance(token, c, cfg.confusableSubstitutionCost);
    if (d <= cfg.maxCandidateDistance && d > 0) {
      scored.push({ value: c, distance: d, score: clamp(1 - d / cfg.maxCandidateDistance, 0, 1) });
    }
  }
  scored.sort((a, b) => a.distance - b.distance || a.value.localeCompare(b.value));
  const candidates = scored.slice(0, cfg.maxCandidates);
  if (candidates.length === 0) {
    return {
      kind: 'none',
      bestDistance: Infinity,
      candidates: [],
      dbScore: 0.12,
    };
  }
  const best = candidates[0];
  return {
    kind: 'candidate',
    matched: best.value,
    bestDistance: best.distance,
    candidates,
    dbScore: clamp(0.55 + best.score * 0.45, 0, 1),
  };
}

function exactMatch(value: string, cfg: ValidationConfigLike): CorpusMatch {
  return {
    kind: 'exact',
    matched: value,
    bestDistance: 0,
    candidates: [{ value, distance: 0, score: 1 }],
    dbScore: cfg.exactMatchScore,
  };
}

function empty(kind: MatchKind, cfg: ValidationConfigLike): CorpusMatch {
  return { kind, bestDistance: Infinity, candidates: [], dbScore: cfg.noCorpusNeutralScore };
}

/** Corpus sources a receiving session knows about (carton + product rows). */
export interface CartonCorpusSource {
  externalCartonId?: string | null;
  qrCodeValue?: string | null;
  barcodeValue?: string | null;
  reference?: string | null;
}
export interface ProductCorpusSource {
  sku?: string | null;
  reference?: string | null;
}

/** Build the upper-case corpus for validation from session detail data. */
export function buildSessionCorpus(
  cartons: CartonCorpusSource[],
  products: ProductCorpusSource[],
): string[] {
  const set = new Set<string>();
  const add = (v?: string | null) => {
    const c = cleanCode(v ?? '');
    if (c.length >= 2) set.add(c);
  };
  for (const c of cartons ?? []) {
    add(c.externalCartonId);
    add(c.qrCodeValue);
    add(c.barcodeValue);
    add(c.reference);
  }
  for (const p of products ?? []) {
    add(p.sku);
    add(p.reference);
  }
  return [...set];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

