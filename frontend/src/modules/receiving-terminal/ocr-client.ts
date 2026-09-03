import type { Worker as TesseractWorker } from 'tesseract.js';
import { CHAR_WHITELIST } from './normalize';

/**
 * On-device OCR (codebase spec §19 + P0 order §7).
 *
 * Hard constraints:
 *   - Tesseract.js, running locally in the browser.
 *   - No paid cloud OCR, camera frames are NEVER sent to an external service.
 *
 * Tesseract is loaded lazily in two stages so it never taxes users who are not
 * doing OCR: the library is a dynamic import (separate chunk, absent from the
 * initial download) and the worker + ~2MB language data load only on the first
 * OCR pass — pure barcode scanning stays instant (§17).
 *
 * P0 changes:
 *   - `recogniseRoi(canvas, opts)` now accepts a per-call PSM so preprocessing
 *     profiles can ask for a single-line read when the ROI looks like one code.
 *   - The char whitelist is the single source in `normalize.ts`.
 */

let workerPromise: Promise<TesseractWorker> | null = null;
let busy = false;

export interface RecogniseOptions {
  /** Tesseract page segmentation mode ("6" default, "7" = single line). */
  psm?: string;
}

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng');
      await worker.setParameters({
        tessedit_char_whitelist: CHAR_WHITELIST,
        // A label line is a single uniform block of text; this avoids
        // expensive layout analysis on every frame. Single-line PSM is
        // requested per call via recogniseRoi when the profile wants it.
        tessedit_pageseg_mode: '6' as never,
      });
      return worker;
    })().catch((err) => {
      // Reset so a transient network failure can be retried later instead of
      // permanently poisoning the promise.
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/** True when an OCR pass is already running (frames are dropped, not queued). */
export function ocrBusy(): boolean {
  return busy;
}

/**
 * Recognise text in a preprocessed ROI canvas.
 * Returns raw text + Tesseract confidence, or null when unavailable.
 * Frames are dropped while a previous pass is in flight.
 */
export async function recogniseRoi(
  canvas: HTMLCanvasElement,
  opts: RecogniseOptions = {},
): Promise<{ text: string; confidence: number } | null> {
  if (busy) return null;
  busy = true;
  try {
    const worker = await getWorker();
    const psm = opts.psm ?? '6';
    if (psm !== '6') {
      await worker.setParameters({ tessedit_pageseg_mode: psm as never });
    }
    const { data } = await worker.recognize(canvas);
    if (psm !== '6') {
      // restore the default segmentation mode for subsequent general reads
      await worker.setParameters({ tessedit_pageseg_mode: '6' as never });
    }
    return { text: data.text ?? '', confidence: data.confidence ?? 0 };
  } catch {
    return null;
  } finally {
    busy = false;
  }
}

/** Release the OCR worker and its memory (§30). */
export async function terminateOcr(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  busy = false;
  if (!p) return;
  try {
    const worker = await p;
    await worker.terminate();
  } catch {
    /* already gone — nothing to release */
  }
}
