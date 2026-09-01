/**
 * Scan feedback — audio tones + optional vibration + visual cue.
 *
 * Produces short, distinct beeps with Web Audio (no audio file, no network),
 * so a worker gets an immediate, unmistakable signal at the terminal even
 * without looking. Tones:
 *
 *   SUCCESS  — short rising "beep" (carton identified / product matched)
 *   ERROR    — low double "buzz" (unknown carton / wrong shipment /
 *              duplicate / unexpected product)  — grab attention to fix it
 *   COMPLETE — two-tone "done" chime on reconciliation completion
 *
 * Vibration (mobile) is fired alongside. The function is a no-op if audio
 * blocks are restricted; the visual cue always works.
 */

let ctx: AudioContext | null = null;
let lastBeepAt = 0;

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  let audio: AudioContext | null = ctx;
  if (!audio) {
    try { audio = new AC(); ctx = audio; } catch { return null; }
  }
  if (audio!.state === 'suspended') { try { audio!.resume(); } catch { /* noop */ } }
  return audio;
}

function tone(freq: number, startIn: number, dur: number, vol = 0.18, type: OscillatorType = 'sine') {
  const c: AudioContext | null = ensureCtx();
  if (!c) return;
  const t0 = c.currentTime + startIn;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function vibrate(pattern: number | number[]) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* noop */ }
}

// Debounce: avoid a burst of beeps if multiple events arrive together.
function rateLimit(ms = 120) {
  const now = Date.now();
  if (now - lastBeepAt < ms) return true;
  lastBeepAt = now;
  return false;
}

/** Successful scan — e.g. carton identified or SKU matched. */
export function beepSuccess() {
  if (rateLimit()) return;
  tone(880, 0, 0.12, 0.16, 'sine');   // single clear beep
  tone(1320, 0.11, 0.16, 0.14, 'sine'); // + short high follow (rising feel)
  vibrate([30]);
}

/** Error / mismatch — e.g. unknown carton, wrong shipment, unexpected SKU. */
export function beepError() {
  if (rateLimit()) return;
  tone(220, 0, 0.18, 0.2, 'sawtooth'); // low buzz
  tone(180, 0.2, 0.22, 0.2, 'sawtooth'); // second lower buzz
  vibrate([60, 40, 60]);
}

/** Neutral action — e.g. a session started / resumed. */
export function beepInfo() {
  if (rateLimit()) return;
  tone(660, 0, 0.1, 0.12, 'sine');
}

/** Completion chime (two-tone up) when receiving closes cleanly. */
export function beepDone() {
  if (rateLimit(150)) return;
  tone(660, 0, 0.12, 0.16, 'sine');
  tone(880, 0.12, 0.12, 0.16, 'sine');
  tone(1320, 0.24, 0.2, 0.16, 'sine');
  vibrate([40, 30, 40]);
}
