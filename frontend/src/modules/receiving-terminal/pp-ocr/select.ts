/**
 * Level-2 candidate selection — turns PP-OCR lines into the same
 * value/readValue/match/confidence structure the tesseract path produces, so
 * the scanner's HIGH/MEDIUM/LOW gates and dedupe/telemetry stay identical.
 *
 * PP-OCR returns every text line it can find ("Made In China", "金色", …).
 * Picking blindly would be noise; picking from those that look like this card's
 * codes is what makes the level-2 pass precise. Order of preference:
 *   1. lines accepted by the scan-profile prefix filter (derived from the card)
 *   2. among those, corpus/expected-exact values rank above anything else
 *   3. then by composite confidence (engine conf + format + DB weight)
 */

import type { ScanConfig } from '../scan-config';
import type { ScanMode } from '../scan-context';
import type { CorpusMatch } from '../validate';
import { matchAgainstCorpus } from '../validate';
import type { ConfidenceResult } from '../confidence';
import { computeConfidence } from '../confidence';
import { normaliseToken } from '../normalize';
import { formatScoreForToken } from '../fields';
import type { ProfileMatchFilter } from '../scan-profile';
import { profileFilterFor, deriveScanProfile, type ScanProfile } from '../scan-profile';
import type { RecognisedLine } from './types';

export interface Level2Candidate {
  /** Canonical value to submit (corpus value when candidate match). */
  value: string;
  /** The text exactly as read. */
  readValue: string;
  match: CorpusMatch;
  confidence: ConfidenceResult;
  /** Engine confidence of the source line (diagnostics). */
  lineConfidence: number;
}

export interface RankLevel2Options {
  mode: ScanMode;
  cfg: ScanConfig;
  known: string[];
  qualityScore?: number;
  /** Optional prefetched card context — derives the prefix filter when present. */
  profile?: ScanProfile;
  /** Optional explicit filter (used when a context-based profile is available). */
  filter?: ProfileMatchFilter;
}

/** Empty/meaningless PP-OCR lines (UI chrome words etc.) never become candidates. */
function plausible(raw: string): boolean {
  const t = normaliseToken(raw);
  return t.length >= 3;
}

export function rankLevel2Lines(
  lines: RecognisedLine[],
  opts: RankLevel2Options,
): Level2Candidate[] {
  const profile = opts.profile ?? (opts.filter ? undefined : deriveFromKnown(opts.known, opts.cfg));
  const filter =
    opts.filter ?? (profile ? profileFilterFor(profile) : { accepts: () => true });

  const results: Level2Candidate[] = [];
  for (const line of lines) {
    if (!plausible(line.text)) continue;
    const clean = normaliseToken(line.text);
    // A line that exactly matches an expected/corpus value is ALWAYS a valid
    // candidate (e.g. a reference that does not share the SKU prefix); the
    // prefix filter only prunes the noise lines that cannot be this card.
    const exactKnown = opts.known.includes(clean);
    if (!exactKnown && !filter.accepts(clean)) continue;
    const match = matchAgainstCorpus(clean, opts.known, opts.cfg.validation);
    const fmt = formatScoreForToken(clean, opts.mode === 'PRODUCT' ? 'PRODUCT' : 'CARTON');
    const confidence = computeConfidence(
      {
        detection: 'OCR',
        ocrConfidence: Math.max(0, Math.min(1, line.confidence)),
        qualityScore: opts.qualityScore ?? 0.75,
        formatScore: fmt,
        dbScore: match.dbScore,
        corpusPresent: opts.known.length > 0,
        matchKind: match.kind,
        votes: opts.cfg.consensus.votesRequired,
      },
      opts.cfg,
    );
    const value = match.kind === 'candidate' && match.matched ? match.matched : clean;
    results.push({ value, readValue: clean, match, confidence, lineConfidence: line.confidence });
  }
  return results.sort((a, b) => {
    const aExact = a.match.kind === 'exact' ? 1 : 0;
    const bExact = b.match.kind === 'exact' ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return b.confidence.score - a.confidence.score;
  });
}

/** When no card profile is supplied, derive one from the known corpus. */
export function deriveFromKnown(
  known: string[],
  cfg: ScanConfig,
): ScanProfile {
  return deriveScanProfile({
    mode: 'PRODUCT',
    builtAt: 0,
    sourceRecords: known.length,
    entries: [],
    values: known,
    byValue: new Map(),
    targetType: 'SKU',
  });
}
