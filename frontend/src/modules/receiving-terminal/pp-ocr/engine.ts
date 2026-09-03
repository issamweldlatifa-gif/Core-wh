/**
 * PP-OCRv3 (RapidOCR) orchestrator — faithful TS port of RapidOCR.recognise:
 *
 *   1. det:   DetResizeForTest(736 min, /32) → DB segmentation → DB post-process
 *   2. boxes: filter degenerate + sort top→bottom, left→right
 *   3. crop:  perspective warp (bicubic, replicate) of each quad; rot90 if tall
 *   4. cls:   rotate 180° crops the classifier marks as upside-down (score>0.9)
 *   5. rec:   resize to h48 dynamic width → CTC decode with the model's alphabet
 *   6. emit lines whose confidence ≥ text_score
 *
 * DOM-free: host provides models bytes + an `OrtBackend` (onnxruntime-web in
 * the browser, onnxruntime-node for offline validation/tests).
 */

import type {
  OrtBackend,
  OrtSessionLike,
  PPOcrConfig,
  PPOcrModelBytes,
  Quad,
  RawImage,
  RecognisedLine,
  RecogniseResult,
} from './types';
import { DEFAULT_PPOCR_CONFIG } from './types';
import { dbBoxesFromPred, filterTagDetRes, type DetBox } from './db';
import { detPreprocess, clsPreprocess, recPreprocess, ctcDecode, type FloatTensor } from './prep';
import { homographyFromQuads, rotate180, rotate90CCW, toBgrPacked, warpPerspectiveBicubic, type Homography } from './image';
import type { Pt2 } from './geom';
import { dist } from './geom';

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Mimics RapidOCR.sorted_boxes (y, then x, with a same-row swap pass). */
export function sortedBoxes(boxes: Pt2[][]): Pt2[][] {
  const sorted = boxes
    .slice()
    .sort((a, b) => (a[0].y !== b[0].y ? a[0].y - b[0].y : a[0].x - b[0].x));
  for (let i = 0; i < sorted.length - 1; i++) {
    if (
      Math.abs(sorted[i + 1][0].y - sorted[i][0].y) < 10 &&
      sorted[i + 1][0].x < sorted[i][0].x
    ) {
      const tmp = sorted[i];
      sorted[i] = sorted[i + 1];
      sorted[i + 1] = tmp;
    }
  }
  return sorted;
}

export class PPOcrEngine {
  private cfg: PPOcrConfig;
  private sessions?: { det: OrtSessionLike; cls: OrtSessionLike; rec: OrtSessionLike };
  private keys: string[] = [];
  private backend: OrtBackend;

  constructor(backend: OrtBackend, cfg: Partial<PPOcrConfig> = {}) {
    this.backend = backend;
    this.cfg = { ...DEFAULT_PPOCR_CONFIG, ...cfg };
  }

  get ready(): boolean {
    return this.sessions !== undefined;
  }

  /** Create the three ONNX sessions + load the alphabet. Idempotent. */
  async init(models: PPOcrModelBytes): Promise<void> {
    if (this.sessions) return;
    const [det, cls, rec] = await Promise.all([
      this.backend.makeSession(models.det),
      this.backend.makeSession(models.cls),
      this.backend.makeSession(models.rec),
    ]);
    this.sessions = { det, cls, rec };
    this.keys = models.keys;
  }

  /** True when a full recognition pass can run (models loaded). */
  isWarm(): boolean {
    return this.ready;
  }

  private session(): { det: OrtSessionLike; cls: OrtSessionLike; rec: OrtSessionLike } {
    if (!this.sessions) {
      throw new Error('PPOcrEngine: models not initialised — call init() first');
    }
    return this.sessions;
  }

  private runModel(
    session: OrtSessionLike,
    input: FloatTensor,
  ): Promise<FloatTensor> {
    const feed: Record<string, ReturnType<OrtBackend['tensor']>> = {};
    feed[session.inputNames[0]] = this.backend.tensor(input.data, input.dims);
    return session.run(feed).then((out) => {
      const name = session.outputNames[0];
      const t = out[name];
      return { data: t.data, dims: t.dims as number[] };
    });
  }

  /** Perspective-warp crop of a quad from the BGR image (get_rotate_crop_image). */
  private cropQuad(
    bgr: Uint8Array,
    srcW: number,
    srcH: number,
    quad: Pt2[],
  ): { data: Uint8Array; w: number; h: number } {
    const [tl, tr, br, bl] = quad;
    const cw = Math.max(Math.round(dist(tl, tr)), Math.round(dist(bl, br)));
    const ch = Math.max(Math.round(dist(tl, bl)), Math.round(dist(tr, br)));
    const srcPts: [number, number][] = [
      [tl.x, tl.y],
      [tr.x, tr.y],
      [br.x, br.y],
      [bl.x, bl.y],
    ];
    const dstPts: [number, number][] = [
      [0, 0],
      [cw, 0],
      [cw, ch],
      [0, ch],
    ];
    const H: Homography = homographyFromQuads(srcPts, dstPts);
    let data = warpPerspectiveBicubic(bgr, srcW, srcH, H, cw, ch);
    let hh = ch;
    let ww = cw;
    if ((hh * 1.0) / ww >= 1.5) {
      data = rotate90CCW(data, ww, hh, 3);
      const tmp = hh;
      hh = ww;
      ww = tmp;
    }
    return { data, w: ww, h: hh };
  }

  private async maybeRotateByCls(crop: { data: Uint8Array; w: number; h: number }): Promise<void> {
    if (!this.cfg.angleCls) return;
    const input = clsPreprocess(crop.data, crop.w, crop.h, this.cfg.clsImageShape[2], this.cfg.clsImageShape[1]);
    const out = await this.runModel(this.session().cls, input);
    // output [1,2]; labels ['0','180']
    const p0 = out.data[0];
    const p1 = out.data[1];
    const idx = p1 > p0 ? 1 : 0;
    const score = Math.max(p0, p1);
    if (idx === 1 && score > this.cfg.clsThresh) {
      crop.data = rotate180(crop.data, crop.w, crop.h, 3);
    }
  }

  /**
   * Run the whole text-detection + recognition on a raw frame (RGBA/RGB/BGR).
   */
  async recognize(raw: RawImage): Promise<RecogniseResult> {
    const t0 = nowMs();
    const srcW = raw.width;
    const srcH = raw.height;
    const order = raw.order ?? 'rgba';
    const bgr = toBgrPacked(raw.data, srcW, srcH, order);

    const t1 = nowMs();
    // ---------- detection ----------
    const pre = detPreprocess(bgr, srcW, srcH, this.cfg.detLimitSideLen);
    const detOut = await this.runModel(this.session().det, pre.tensor);
    const [,, predH, predW] = detOut.dims as [number, number, number, number];
    const predMap = detOut.data;
    const { raw: rawBoxes } = dbBoxesFromPred(predMap, predW, predH, srcW, srcH, this.cfg);
    const detBoxes = filterTagDetRes(rawBoxes, srcW, srcH);
    const t2 = nowMs();

    const lines: RecognisedLine[] = [];
    if (detBoxes.length > 0) {
      const boxes = sortedBoxes(detBoxes);
      // ---------- crop + angle classifier + recognition ----------
      for (const box of boxes) {
        const crop = this.cropQuad(bgr, srcW, srcH, box);
        if (crop.w < 2 || crop.h < 2) continue;
        await this.maybeRotateByCls(crop);
        const recIn = recPreprocess(crop.data, crop.w, crop.h);
        const recOut = await this.runModel(this.session().rec, recIn.tensor);
        const { text, confidence } = ctcDecode(recOut, this.keys);
        if (confidence >= this.cfg.recTextScore) {
          lines.push({
            box: box as Quad,
            text,
            confidence,
          });
        }
      }
    }
    const t3 = nowMs();
    return {
      lines,
      timings: {
        detMs: t2 - t1,
        clsMs: 0,
        recMs: t3 - t2,
        totalMs: t3 - t0,
      },
    };
  }
}
