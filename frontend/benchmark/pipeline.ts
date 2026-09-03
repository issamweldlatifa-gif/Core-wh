/**
 * Benchmark entry: re-exports the pure (DOM-free) pipeline so the §17
 * before/after benchmark runs the SAME TypeScript code shipped in the scanner.
 * esbuild bundles this file → `tmp/pipeline.mjs` (node/esm).
 */

export { DEFAULT_SCAN_CONFIG, mergeConfig } from '../src/modules/receiving-terminal/scan-config';
export type { ScanConfig } from '../src/modules/receiving-terminal/scan-config';
export {
  toGray,
  grayToPixels,
  scaleGray,
  rotateGray,
  boxBlur3,
} from '../src/modules/receiving-terminal/pixels';
export type { Pixels } from '../src/modules/receiving-terminal/pixels';
export { assessQuality, quickGuidance, GUIDANCE_TEXT } from '../src/modules/receiving-terminal/image-quality';
export type { QualityMetrics } from '../src/modules/receiving-terminal/image-quality';
export {
  applyProfile,
  selectProfile,
  legacyPreprocess,
  estimateSkewDeg,
} from '../src/modules/receiving-terminal/preprocess';
export type { ProfileId } from '../src/modules/receiving-terminal/preprocess';
export { extractFieldTokens, orderForLabel, formatScoreForToken } from '../src/modules/receiving-terminal/fields';
export type { FieldToken, LabelKind } from '../src/modules/receiving-terminal/fields';
export { normaliseToken, ocrEditDistance } from '../src/modules/receiving-terminal/normalize';
export { matchAgainstCorpus, cleanCode, buildSessionCorpus } from '../src/modules/receiving-terminal/validate';
export type { CorpusMatch } from '../src/modules/receiving-terminal/validate';
export { computeConfidence } from '../src/modules/receiving-terminal/confidence';
export type { ConfidenceResult } from '../src/modules/receiving-terminal/confidence';
export { extractCandidates, normaliseToken as normToken } from '../src/modules/receiving-terminal/candidates';
