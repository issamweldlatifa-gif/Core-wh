/**
 * Receiving terminal — hardware read → shared receiving path (dual order §7).
 *
 * A hardware scan is a pre-decoded code string (wedge/BLE/USB). It is NOT OCR
 * so it does not need OCR confidence, but it MUST enter the same channel as a
 * software barcode/QR read: sanitise → duplicate guard (the SAME dedupe module
 * the camera uses) → the parent's single receiving submit (which runs the
 * shared backend validation/business rules). No separate receiving logic
 * exists for hardware (§7 forbids it).
 */

import { cleanCode } from './validate';
import { isDuplicate, noteSubmission, type DedupeState } from './dedupe';

const ALLOWED = /^[A-Z0-9][A-Z0-9-]{2,}$/;

/**
 * Sanitise a wedge/BLE read into a Receiving code. Returns null when the burst
 * is not a plausible code (junk keys, very short, illegal chars) so accidental
 * key spam never reaches the receiving pipeline.
 */
export function sanitiseWedgeRead(raw: string | undefined | null): string | null {
  const cleaned = cleanCode(raw ?? '');
  if (cleaned.length < 4 || cleaned.length > 64) return null;
  if (!ALLOWED.test(cleaned)) return null;
  return cleaned;
}

export interface HardwareReadResult {
  /** true = suppressed repeat of the last submitted code (no event emitted) */
  duplicate: boolean;
  value: string;
}

/**
 * Single decision used by the Hardware panel AND the hardware benchmark:
 * sanitise → duplicate guard. Non-duplicate values are meant to flow to
 * `onDetected(value, 'EXTERNAL_SCANNER')` exactly like a software read.
 */
export function prepareHardwareRead(
  dup: DedupeState,
  raw: string,
  now: number,
  repeatWindowMs: number,
): HardwareReadResult | null {
  const value = sanitiseWedgeRead(raw);
  if (!value) return null;
  const duplicate = isDuplicate(dup, value, now, repeatWindowMs);
  if (!duplicate) noteSubmission(dup, value, now);
  return { duplicate, value };
}
