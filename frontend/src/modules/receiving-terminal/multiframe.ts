/**
 * Multi-frame recognition & consensus — order §13.
 *
 * A single OCR frame is never trusted (§23 in codebase spec). Candidate
 * tokens are accumulated across consecutive frames and only become STABLE
 * when their accumulated weight reaches `votesRequired`.
 *
 * Votes are QUALITY-WEIGHTED: a crisp frame counts for more than a marginal
 * one, so a blurred frame cannot help a wrong token cross the bar. The window
 * slides (a lone old vote cannot accumulate forever).
 */

import type { ConsensusConfig } from './scan-config';
import { normaliseToken } from './normalize';

export interface FrameVotes {
  token: string; // raw candidate
  /** per-frame weight 0..1 (from image quality / engine confidence) */
  weight: number;
}

export interface ConsensusAggregator {
  pushFrame(votes: FrameVotes[]): string[]; // stable tokens this frame (may be >1)
  reset(): void;
  readonly size: number;
}

/**
 * Build a quality-weighted multi-frame consensus aggregator.
 * Each frame supplies per-token weights (callers fold in the measured ROI
 * quality); tokens stabilise when accumulated weight reaches votesRequired.
 */
export function createConsensus(cfg: ConsensusConfig): ConsensusAggregator {
  const hits = new Map<string, { w: number; firstFrame: number }>();
  let frames = 0;
  const { votesRequired, windowFrames } = cfg;

  const slideWindow = () => {
    const floor = frames - windowFrames; // absolute frame index
    if (floor <= 0) return;
    for (const [k, v] of hits) if (v.firstFrame < floor) hits.delete(k);
  };

  return {
    pushFrame(votes: FrameVotes[]): string[] {
      frames += 1;
      const stable: string[] = [];
      const seenThisFrame = new Set<string>();
      for (const v of votes) {
        const token = normaliseToken(v.token);
        if (!token || seenThisFrame.has(token)) continue;
        seenThisFrame.add(token);
        const cur = hits.get(token);
        const w = Math.max(0, Math.min(1, v.weight));
        if (cur) {
          cur.w += w;
          hits.set(token, cur);
        } else {
          hits.set(token, { w, firstFrame: frames });
        }
      }
      // Resolve stables (in descending weight), then slide the window.
      const ranked = [...hits.entries()]
        .filter(([, v]) => v.w >= votesRequired)
        .sort((a, b) => b[1].w - a[1].w);
      for (const [token] of ranked) stable.push(token);
      slideWindow();
      // Clean stables so they do not immediately re-fire on the next frame.
      for (const token of stable) hits.delete(token);
      return stable;
    },
    reset() {
      hits.clear();
      frames = 0;
    },
    get size() {
      return hits.size;
    },
  };
}

/** Default weight mapping used by the scanner (tie to measured ROI quality). */
export function frameWeightForQuality(qualityScore: number): number {
  const q = Math.max(0, Math.min(1, qualityScore));
  return 0.4 + 0.6 * q;
}
