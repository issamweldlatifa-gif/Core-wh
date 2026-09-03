/**
 * Duplicate-scan prevention (unified P0 §26).
 *
 * A continuous / multi-frame scanner must never turn one physical scan into
 * several Receiving events. This pure helper implements the identity + time
 * gate used by both the live scanner and the offline benchmark, so the rule
 * is proven once and enforced in both places:
 *
 *   - identity  : same normalised value as the last submitted code
 *   - timestamp : inside repeatWindowMs of that submission
 *
 * A single physical code therefore produces exactly one hand-off to the
 * caller; a NEW code (or the same code after the window) passes immediately.
 */

export interface DedupeState {
  lastValue: string;
  lastAt: number;
}

export const EMPTY_DEDUPE: DedupeState = { lastValue: '', lastAt: 0 };

/**
 * Decide whether `value` at `now` is a repeat of the last submitted code.
 * When it is a repeat, `now` is refreshed so a continuous stream of the same
 * code keeps being suppressed (it never re-fires half-way through the window).
 */
export function isDuplicate(
  state: DedupeState,
  value: string,
  now: number,
  repeatWindowMs: number,
): boolean {
  if (value && value === state.lastValue && now - state.lastAt < repeatWindowMs) {
    state.lastAt = now;
    return true;
  }
  return false;
}

/** Record a (possibly) new submission. Returns the updated state. */
export function noteSubmission(state: DedupeState, value: string, now: number): DedupeState {
  state.lastValue = value;
  state.lastAt = now;
  return state;
}
