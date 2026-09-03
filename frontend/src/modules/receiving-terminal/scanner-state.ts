/**
 * Explicit scanner state machine (spec §31).
 *
 * The spec forbids "uncontrolled boolean combinations". Every transition is
 * declared here and validated, so the scanner can never end up in an
 * impossible state (e.g. submitting while the camera is still starting) — the
 * class of bug that previously froze the scanner permanently.
 */

export type ScannerState =
  | 'IDLE'
  | 'CAMERA_STARTING'
  | 'SCANNING'
  | 'BARCODE_DETECTING'
  | 'OCR_PROCESSING'
  | 'CANDIDATE_FOUND'
  | 'VALIDATING'
  | 'SUBMITTING'
  | 'SUCCESS'
  | 'ERROR'
  | 'EXITING';

export type ScannerEvent =
  | 'OPEN'
  | 'CAMERA_READY'
  | 'CAMERA_FAILED'
  | 'BARCODE_SCAN'
  | 'OCR_SCAN'
  | 'CANDIDATE'
  | 'VALIDATE'
  | 'SUBMIT'
  | 'CONFIRM'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'RESUME'
  | 'EXIT'
  | 'CLOSED';

/**
 * Allowed transitions. Anything not listed is rejected by `next()`.
 *
 * Two rules are load-bearing:
 *  1. Every non-terminal state can go to EXITING — the worker must always be
 *     able to leave, whatever the scanner is doing (§30).
 *  2. SUCCESS and ERROR both accept RESUME back into SCANNING, because the
 *     scanner stays open and continues after each carton (§16/§26/§27).
 */
const TRANSITIONS: Record<ScannerState, Partial<Record<ScannerEvent, ScannerState>>> = {
  IDLE: {
    OPEN: 'CAMERA_STARTING',
    EXIT: 'EXITING',
  },
  CAMERA_STARTING: {
    CAMERA_READY: 'SCANNING',
    CAMERA_FAILED: 'ERROR',
    EXIT: 'EXITING',
  },
  SCANNING: {
    BARCODE_SCAN: 'BARCODE_DETECTING',
    OCR_SCAN: 'OCR_PROCESSING',
    CANDIDATE: 'CANDIDATE_FOUND',
    EXIT: 'EXITING',
  },
  BARCODE_DETECTING: {
    // Barcode has priority; if it finds nothing we fall through to OCR (§17).
    CANDIDATE: 'CANDIDATE_FOUND',
    OCR_SCAN: 'OCR_PROCESSING',
    RESUME: 'SCANNING',
    EXIT: 'EXITING',
  },
  OCR_PROCESSING: {
    CANDIDATE: 'CANDIDATE_FOUND',
    RESUME: 'SCANNING',
    EXIT: 'EXITING',
  },
  CANDIDATE_FOUND: {
    VALIDATE: 'VALIDATING',
    // A candidate that fails the local pre-check simply resumes scanning.
    RESUME: 'SCANNING',
    EXIT: 'EXITING',
  },
  VALIDATING: {
    SUBMIT: 'SUBMITTING',
    // P0: a MEDIUM-confidence candidate is held here until the worker
    // confirms (→ SUBMITTING) or scans again (RESUME → SCANNING). LOW ones
    // never reach VALIDATING at all.
    CONFIRM: 'SUBMITTING',
    REJECTED: 'ERROR',
    RESUME: 'SCANNING',
    EXIT: 'EXITING',
  },
  SUBMITTING: {
    // Only the backend can move us to SUCCESS (§25).
    ACCEPTED: 'SUCCESS',
    REJECTED: 'ERROR',
    EXIT: 'EXITING',
  },
  SUCCESS: {
    RESUME: 'SCANNING',
    EXIT: 'EXITING',
  },
  ERROR: {
    RESUME: 'SCANNING',
    // Retrying after a camera failure re-opens the device.
    OPEN: 'CAMERA_STARTING',
    EXIT: 'EXITING',
  },
  EXITING: {
    CLOSED: 'IDLE',
  },
};

/** Compute the next state, or null when the transition is not permitted. */
export function next(state: ScannerState, event: ScannerEvent): ScannerState | null {
  return TRANSITIONS[state]?.[event] ?? null;
}

/** True when the machine is in a state that should be decoding frames. */
export function isScanning(state: ScannerState): boolean {
  return state === 'SCANNING' || state === 'BARCODE_DETECTING' || state === 'OCR_PROCESSING';
}

/** True when a submission is in flight and input must be ignored (§29). */
export function isBusy(state: ScannerState): boolean {
  return state === 'VALIDATING' || state === 'SUBMITTING';
}

/** Human-facing label for the operational status line (§5). */
export function stateLabel(state: ScannerState): string {
  switch (state) {
    case 'IDLE': return 'READY';
    case 'CAMERA_STARTING': return 'STARTING CAMERA';
    case 'SCANNING': return 'SCANNING';
    case 'BARCODE_DETECTING': return 'READING BARCODE';
    case 'OCR_PROCESSING': return 'READING TEXT (OCR)';
    case 'CANDIDATE_FOUND': return 'CANDIDATE FOUND';
    case 'VALIDATING': return 'VALIDATING';
    case 'SUBMITTING': return 'SUBMITTING';
    case 'SUCCESS': return 'ACCEPTED';
    case 'ERROR': return 'NOT ACCEPTED';
    case 'EXITING': return 'CLOSING';
    default: return state;
  }
}
