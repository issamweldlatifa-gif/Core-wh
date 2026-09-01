import type { Worker as TesseractWorker } from 'tesseract.js';

/**
 * On-device OCR (spec §19).
 *
 * Hard constraints from the spec:
 *   - Tesseract.js, running locally in the browser.
 *   - No paid cloud OCR, and camera frames are NEVER sent to an external
 *     service. Everything here stays on the device.
 *
 * Tesseract is loaded lazily in two stages so it never taxes users who are not
 * doing OCR:
 *   1. the library itself is a dynamic import(), so it is a separate chunk and
 *      is not part of the app's initial download at all,
 *   2. the worker (and its ~2MB language data) is only fetched the first time
 *      OCR is actually needed — i.e. after barcode/QR detection has failed —
 *      so pure barcode scanning stays instant (§17).
 */

let workerPromise: Promise<TesseractWorker> | null = null;
let busy = false;

/** Character set of plausible SKU/reference glyphs — boosts accuracy. */
const CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      // Dynamic import keeps tesseract.js out of the main bundle.
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng');
      await worker.setParameters({
        tessedit_char_whitelist: CHAR_WHITELIST,
        // A label line is a single uniform block of text; telling Tesseract so
        // avoids expensive layout analysis on every frame.
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
 * Recognise text in a preprocessed ROI.
 * Returns the raw text plus Tesseract's confidence, or null if unavailable.
 * Frames are dropped while a previous pass is in flight: OCR is slower than
 * the camera, and queueing would build unbounded latency on a phone (§42).
 */
export async function recogniseRoi(
  canvas: HTMLCanvasElement,
): Promise<{ text: string; confidence: number } | null> {
  if (busy) return null;
  busy = true;
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    return { text: data.text ?? '', confidence: data.confidence ?? 0 };
  } catch {
    return null;
  } finally {
    busy = false;
  }
}

/**
 * Release the OCR worker and its memory (§30).
 * Must be called when the scanner exits, or the WASM heap stays resident.
 */
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
