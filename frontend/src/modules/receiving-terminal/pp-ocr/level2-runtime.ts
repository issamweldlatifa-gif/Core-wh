/**
 * Level-2 OCR runtime binding for the BROWSER (P2 — opt-in seam).
 *
 * Same PPOcrEngine core as the offline-validated engine, but sessions are built
 * from onnxruntime-web (WASM) and the model weights ship as static assets under
 * `/ocr-models/`. Models are fetched once and cached by the engine singleton,
 * mirroring the tesseract worker pattern (warm, idempotent, never per-frame).
 *
 * IMPORTANT (honesty rule): choosing `ppocr` is opt-in. The product default
 * stays `tesseract` until on-device numbers are collected (runbook §ANNEX).
 */

import { PPOcrEngine } from './engine';
import type { OrtBackend, OrtTensorLike, RawImage, RecogniseResult } from './types';

export interface Level2RuntimeOptions {
  /** Static-asset base for the .onnx + keys files (default '/ocr-models/'). */
  modelBase?: string;
  /** Optional explicit WASM path for onnxruntime-web (e.g. '/ocr-runtime/'). */
  wasmPaths?: string;
}

export const DEFAULT_LEVEL2_MODEL_BASE = '/ocr-models/';
/** onnxruntime-web needs its .wasm served same-origin. Copy the dist .wasm
 *  files into /public/ocr-wasm/ before enabling ppocr on a device
 *  (runbook §Level-2). Defaults are set here so the opt-in path is turnkey. */
export const DEFAULT_LEVEL2_WASM_PATHS = '/ocr-wasm/';

export const LEVEL2_MODEL_FILES = {
  det: 'ch_PP-OCRv3_det_infer.onnx',
  cls: 'ch_ppocr_mobile_v2.0_cls_infer.onnx',
  rec: 'ch_PP-OCRv3_rec_infer.onnx',
  keys: 'ppocr_keys.json',
} as const;

let shared: Level2OcrRuntime | null = null;

export interface Level2OcrRuntime {
  /** True after models+sessions are ready (first warm succeeded). */
  isWarm(): boolean;
  /** In-flight or completed initialisation promise. */
  warm(): Promise<void>;
  /** Run one recognition pass; null when the runtime is not warm yet. */
  recognise(raw: RawImage): Promise<RecogniseResult | null>;
  /** Release sessions + memory (test / app shutdown only, not per-session). */
  shutdown(): Promise<void>;
}

export function getLevel2OcrRuntime(opts: Level2RuntimeOptions = {}): Level2OcrRuntime {
  if (!shared) shared = createLevel2OcrRuntime(opts);
  return shared;
}

export function createLevel2OcrRuntime(opts: Level2RuntimeOptions = {}): Level2OcrRuntime {
  const modelBase = opts.modelBase ?? DEFAULT_LEVEL2_MODEL_BASE;
  let engine: PPOcrEngine | null = null;
  let initPromise: Promise<void> | null = null;

  async function loadBytes(url: string): Promise<Uint8Array> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`level-2 OCR model fetch failed (${res.status}): ${url}`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  async function initialise(): Promise<void> {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.wasmPaths = opts.wasmPaths ?? DEFAULT_LEVEL2_WASM_PATHS;
    ort.env.wasm.numThreads = 1; // single-threaded: predictable on phones
    const base = modelBase.endsWith('/') ? modelBase : `${modelBase}/`;

    const backend: OrtBackend = {
      kind: 'web',
      async makeSession(modelBytes: Uint8Array) {
        return ort.InferenceSession.create(modelBytes);
      },
      tensor(data: Float32Array, dims: number[]): OrtTensorLike {
        return new ort.Tensor('float32', data, dims);
      },
    };
    const det = await loadBytes(base + LEVEL2_MODEL_FILES.det);
    const cls = await loadBytes(base + LEVEL2_MODEL_FILES.cls);
    const rec = await loadBytes(base + LEVEL2_MODEL_FILES.rec);
    const keysRes = await fetch(base + LEVEL2_MODEL_FILES.keys);
    if (!keysRes.ok) throw new Error('level-2 OCR keys fetch failed');
    const keys: string[] = await keysRes.json();

    const eng = new PPOcrEngine(backend);
    await eng.init({ det, cls, rec, keys });
    engine = eng;
  }

  return {
    isWarm: () => engine !== null,
    warm: () => {
      if (!initPromise) {
        initPromise = initialise().catch((err) => {
          initPromise = null; // transient failure → next warm retries
          throw err;
        });
      }
      return initPromise;
    },
    recognise: async (raw) => {
      if (!engine) return null;
      return engine.recognize(raw);
    },
    shutdown: async () => {
      engine = null;
      initPromise = null;
    },
  };
}

/** test helper: replace the singleton (e.g. with a fake runtime). */
export function __setLevel2RuntimeForTests(rt: Level2OcrRuntime | null): void {
  shared = rt;
}
