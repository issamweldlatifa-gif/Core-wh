/**
 * PP-OCR level-2 engine — shared types (P1 spike, level-2 candidate).
 *
 * This engine is a faithful TypeScript port of the RapidOCR/PP-OCRv3 CPU
 * pipeline (det + angle-cls + rec) so printed label text can be read ON DEVICE
 * in the browser via onnxruntime-web/WASM. The core never imports onnxruntime
 * or DOM APIs: the host supplies an `OrtBackend` so the exact same code runs in
 * Node (onnxruntime-node) for offline validation and in the browser
 * (onnxruntime-web) for production.
 */

/** One quadrilateral in image coordinates (pixel units), [tl, tr, br, bl]. */
export type Quad = [Pt, Pt, Pt, Pt];
export interface Pt {
  x: number;
  y: number;
}

/** One recognised line produced by the engine (before any expected matching). */
export interface RecognisedLine {
  /** Quadrilateral in the INPUT image coordinate space (same space the caller drew the ROI from). */
  box: Quad;
  /** Decoded text (already normalised by the caller if required). */
  text: string;
  /** Engine mean confidence in [0,1]. */
  confidence: number;
}

/** Result of a single recognition call. */
export interface RecogniseResult {
  lines: RecognisedLine[];
  /** Breakdown of the pass in ms (det / cls / rec). */
  timings: { detMs: number; clsMs: number; recMs: number; totalMs: number };
}

/** Minimal ONNX runtime surface the pipeline needs (host-provided). */
export interface OrtTensorLike {
  data: Float32Array;
  dims: number[];
}
export interface OrtSessionLike {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
}
export interface OrtBackend {
  /** 'node' | 'web' — informational only. */
  kind: string;
  /** Build a session from raw model bytes (.onnx). */
  makeSession(modelBytes: Uint8Array): Promise<OrtSessionLike>;
  /** Build a float32 tensor. */
  tensor(data: Float32Array, dims: number[]): OrtTensorLike;
}

/** Raw frame handed to the engine. RGBA8 (browser ImageData-like) or RGB8/BGR8. */
export interface RawImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** 'rgba' (default) | 'rgb' | 'bgr'. PP-OCR expects BGR channel order internally. */
  order?: 'rgba' | 'rgb' | 'bgr';
}

/** Engine configuration (mirrors the RapidOCR defaults we validated against). */
export interface PPOcrConfig {
  detLimitSideLen: number; // 736
  detThresh: number; // 0.3
  detBoxThresh: number; // 0.5
  detUnclipRatio: number; // 1.6
  detUseDilation: boolean; // true
  clsThresh: number; // 0.9
  clsImageShape: [number, number, number]; // [3, 48, 192]
  recImageShape: [number, number, number]; // [3, 48, 320]
  recTextScore: number; // 0.5
  minDetSideLen: number; // 3
  minBoxSideLenAfterUnclip: number; // 5 (min_size + 2)
  angleCls: boolean; // true
}

export const DEFAULT_PPOCR_CONFIG: PPOcrConfig = {
  detLimitSideLen: 736,
  detThresh: 0.3,
  detBoxThresh: 0.5,
  detUnclipRatio: 1.6,
  detUseDilation: true,
  clsThresh: 0.9,
  clsImageShape: [3, 48, 192],
  recImageShape: [3, 48, 320],
  recTextScore: 0.5,
  minDetSideLen: 3,
  minBoxSideLenAfterUnclip: 5,
  angleCls: true,
};

/** Model + dictionary sources as raw bytes. Browser host fetches /ocr-models/*. */
export interface PPOcrModelBytes {
  det: Uint8Array;
  cls: Uint8Array;
  rec: Uint8Array;
  /** Alphabet characters (without the CTC 'blank' prefix or trailing space). */
  keys: string[];
}
