/**
 * esbuild entry so the pp-ocr engine can be bundled to node ESM and exercised
 * offline (benchmark/level2) against fixtures with onnxruntime-node.
 */
export { PPOcrEngine, sortedBoxes } from '../../src/modules/receiving-terminal/pp-ocr/engine';
export type { RecognisedLine, RecogniseResult, RawImage, OrtBackend, PPOcrModelBytes } from '../../src/modules/receiving-terminal/pp-ocr/types';
export { DEFAULT_PPOCR_CONFIG } from '../../src/modules/receiving-terminal/pp-ocr/types';
