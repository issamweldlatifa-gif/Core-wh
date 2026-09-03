import { describe, expect, it } from 'vitest';
import { createEngineManager } from './engine';

interface FakeHooks {
  warm: () => Promise<void>;
  shutdown: () => Promise<void>;
  warmCount: number;
  shutdownCount: number;
  schedule: (fn: () => void, ms: number) => number;
  cancel: (id: number) => void;
  fireIdle: () => void;
}

function makeHooks(graceCheck?: () => number): FakeHooks & { now: () => number } {
  let nowMs = 1000;
  let idleId = 0;
  const pending = new Map<number, () => void>();
  const h: FakeHooks & { now: () => number } = {
    warmCount: 0,
    shutdownCount: 0,
    now: () => (graceCheck ? graceCheck() : nowMs),
    warm: async () => { h.warmCount += 1; },
    shutdown: async () => { h.shutdownCount += 1; },
    schedule: (fn, ms) => {
      idleId += 1;
      pending.set(idleId, fn);
      return idleId;
    },
    cancel: (id) => { pending.delete(id); },
    fireIdle: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const f of fns) f();
    },
  };
  return h;
}

describe('warm scanner engine (final order §18–§20)', () => {
  it('acquire warms the engine once for many holders', async () => {
    const h = makeHooks();
    const eng = createEngineManager(h, { idleGraceMs: 1000 });
    eng.acquire({ warm: true });
    eng.acquire({ warm: true });
    await Promise.resolve();
    expect(h.warmCount).toBe(1);
    expect(eng.state().holders).toBe(2);
    expect(eng.state().warm).toBe(true);
  });

  it('acquire without warm (barcode-only station) does not load the OCR runtime', async () => {
    const h = makeHooks();
    const eng = createEngineManager(h, { idleGraceMs: 1000 });
    eng.acquire({ warm: false });
    await Promise.resolve();
    expect(h.warmCount).toBe(0);
    expect(eng.state().holders).toBe(1);
  });

  it('release keeps the engine warm — idle shutdown only fires after the grace', async () => {
    const h = makeHooks();
    const eng = createEngineManager(h, { idleGraceMs: 1000 });
    eng.acquire({ warm: true });
    await Promise.resolve();
    eng.release();
    // right after release the engine is still warm (not shut down)
    expect(eng.state().holders).toBe(0);
    expect(eng.state().warm).toBe(true);
    expect(eng.state().idleTimerActive).toBe(true);
    expect(h.shutdownCount).toBe(0);
    // grace elapses without a new session → real shutdown
    h.fireIdle();
    expect(eng.state().warm).toBe(false);
    expect(h.shutdownCount).toBe(1);
  });

  it('a new session re-acquiring before the grace reuses the warm engine', async () => {
    const h = makeHooks();
    const eng = createEngineManager(h, { idleGraceMs: 1000 });
    eng.acquire({ warm: true });
    await Promise.resolve();
    eng.release();
    // session 2 opens before the idle timer fires
    eng.acquire({ warm: true });
    expect(h.shutdownCount).toBe(0);
    expect(eng.state().warm).toBe(true);
    expect(eng.state().idleTimerActive).toBe(false); // pending shutdown cancelled
    eng.release();
    h.fireIdle();
    expect(h.shutdownCount).toBe(1);
  });

  it('release → re-acquire only warms once (no double worker load across sessions)', async () => {
    const h = makeHooks();
    const eng = createEngineManager(h, { idleGraceMs: 1000 });
    eng.acquire({ warm: true });
    await Promise.resolve();
    eng.release();
    eng.acquire({ warm: true });
    await Promise.resolve();
    expect(h.warmCount).toBe(1); // still warm — never re-initialised
  });

  it('shutdownNow is an explicit full teardown (not used per session)', async () => {
    const h = makeHooks();
    const eng = createEngineManager(h, { idleGraceMs: 1000 });
    eng.acquire({ warm: true });
    await Promise.resolve();
    eng.shutdownNow();
    expect(h.shutdownCount).toBe(1);
    expect(eng.state().holders).toBe(0);
    expect(eng.state().warm).toBe(false);
  });

  it('a transient warm failure resets warm so the next session can retry', async () => {
    const h = makeHooks();
    h.warm = async () => { throw new Error('network'); };
    const eng = createEngineManager(h, { idleGraceMs: 1000 });
    eng.acquire({ warm: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(eng.state().warm).toBe(false);
    expect(eng.state().holders).toBe(1);
  });
});
