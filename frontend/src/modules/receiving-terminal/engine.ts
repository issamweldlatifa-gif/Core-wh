/**
 * Receiving — warm scanner engine (final order §18–§20).
 *
 * “Clean, don't shut down”: when a Receiving session ends, the session state
 * (ScanContext, results, buffers) is dropped by its owner, but the reusable
 * scanner engine — OCR runtime, decoder, workers — must STAY warm so the next
 * session never pays the initialisation cost (§20).
 *
 * This is a tiny ref-counted engine manager: each open scanner component
 * `acquire()`s on mount and `release()`s on unmount. Releasing does NOT kill
 * the engine; it schedules an IDLE shutdown after a grace period. If the next
 * session re-acquires before the grace elapses, the engine is reused warm. The
 * manager is dependency-injected (hooks) so it stays pure and unit-testable.
 */

export interface EngineHooks {
  /** Pre-load the OCR runtime (idempotent, fire-and-forget safe). */
  warm: () => Promise<void>;
  /** Tear the OCR runtime down for real. */
  shutdown: () => Promise<void>;
  /** Clock (defaults to Date.now). */
  now?: () => number;
  /** Scheduler (defaults to window.setTimeout / setTimeout). */
  schedule?: (fn: () => void, ms: number) => number;
  /** Canceller (defaults to window.clearTimeout / clearTimeout). */
  cancel?: (id: number) => void;
}

export interface EngineOptions {
  /** How long an unused engine is kept warm before idle shutdown. */
  idleGraceMs?: number;
}

export interface EngineState {
  holders: number;
  warm: boolean;
  idleTimerActive: boolean;
}

export const DEFAULT_IDLE_GRACE_MS = 5 * 60 * 1000; // 5 minutes

/** Factory used by tests and by the app-level singleton. */
export function createEngineManager(hooks: EngineHooks, options: EngineOptions = {}) {
  const graceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  const now = hooks.now ?? (() => Date.now());
  const schedule = hooks.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number);
  const cancel = hooks.cancel ?? ((id: number) => clearTimeout(id));

  let holders = 0;
  let warm = false;
  let idleTimer: number | null = null;
  let lastAcquiredAt = 0;

  const clearIdle = () => {
    if (idleTimer !== null) {
      cancel(idleTimer);
      idleTimer = null;
    }
  };

  const scheduleIdle = () => {
    clearIdle();
    idleTimer = schedule(() => {
      idleTimer = null;
      // Only shut down if nobody re-acquired meanwhile.
      if (holders <= 0) {
        warm = false;
        void hooks.shutdown();
      }
    }, graceMs);
  };

  /**
   * Another scanner instance opened: mark warm (when this station uses OCR)
   * and cancel any pending idle shutdown so the engine is reused.
   */
  const acquire = (options: { warm?: boolean } = {}): void => {
    clearIdle();
    holders += 1;
    lastAcquiredAt = now();
    if (options.warm && !warm) {
      warm = true; // mark first so concurrent acquires don't double-fire
      void hooks.warm().catch(() => {
        warm = false; // transient failure → next acquire retries
      });
    }
  };

  /**
   * A scanner instance closed. Session cleanup WITHOUT engine shutdown (§19):
   * the engine stays warm until the idle grace elapses; re-acquire before that
   * and the next session reuses it.
   */
  const release = (): void => {
    holders = Math.max(0, holders - 1);
    if (holders === 0) scheduleIdle();
  };

  /** Explicit full teardown (app-level / tests) — not used per-session. */
  const shutdownNow = (): void => {
    clearIdle();
    holders = 0;
    warm = false;
    void hooks.shutdown();
  };

  const state = (): EngineState => ({ holders, warm, idleTimerActive: idleTimer !== null });

  return { acquire, release, shutdownNow, state, lastAcquiredAt: () => lastAcquiredAt };
}

export type ScannerEngine = ReturnType<typeof createEngineManager>;

// ---------------------------------------------------------------------------
// App-level singleton bound to the real OCR runtime.
// ---------------------------------------------------------------------------

/**
 * Pre-load the OCR worker without running recognition (busy flag untouched).
 * Idempotent; safe to call from acquire().
 */
export async function warmOcrEngine(): Promise<void> {
  const { warmOcr } = await import('./ocr-client');
  await warmOcr();
}

/** Real shutdown of the OCR worker. */
export async function shutdownOcrEngine(): Promise<void> {
  const { terminateOcr } = await import('./ocr-client');
  await terminateOcr();
}

let shared: ScannerEngine | null = null;

/** The Receiving singleton engine. Lazily created on first acquire. */
export function receivingEngine(): ScannerEngine {
  if (!shared) {
    shared = createEngineManager({
      warm: () => warmOcrEngine(),
      shutdown: () => shutdownOcrEngine(),
    });
  }
  return shared;
}

/** For tests: reset the singleton so a fresh manager can be created. */
export function __resetReceivingEngineForTests(): void {
  if (shared) shared.shutdownNow();
  shared = null;
}
