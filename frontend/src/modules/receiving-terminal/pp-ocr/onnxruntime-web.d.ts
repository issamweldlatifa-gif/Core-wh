/**
 * Minimal ambient types for onnxruntime-web.
 *
 * The package ships `types.d.ts` but its package.json "exports" map prevents
 * moduleResolution="bundler" from resolving it. We only use a tiny surface in
 * the level-2 runtime adapter, so we declare exactly that here.
 */

declare module 'onnxruntime-web' {
  export interface EnvWasm {
    wasmPaths?: string;
    numThreads?: number;
  }
  export interface Env {
    wasm: EnvWasm;
    [k: string]: unknown;
  }
  export const env: Env;
  export interface SessionLike {
    inputNames: string[];
    outputNames: string[];
    run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>;
  }
  export interface TensorLike {
    data: Float32Array;
    dims: number[];
  }
  export class Tensor implements TensorLike {
    constructor(type: 'float32', data: Float32Array, dims: number[]);
    data: Float32Array;
    dims: number[];
  }
  export namespace InferenceSession {
    function create(modelBytes: Uint8Array): Promise<SessionLike>;
  }
}
