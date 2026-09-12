import { isSharedTask, taskByKey } from '../operations/task-registry';

/**
 * BATCH task in the worker terminal registry (Phase 2 worker-app slice).
 * The command forbids a BATCH STATION — the build task is deliberately NOT
 * station-bound (no stationDepartments/stationRequired), it is permission-
 * served (batch.execute), and it must never be marked shared (authorization
 * is per-worker permission, not a shared queue).
 */
describe('task registry — batch build task', () => {
  const task = taskByKey('batch');

  it('exists, is ready and gated by batch.execute', () => {
    expect(task).toBeDefined();
    expect(task!.ready).toBe(true);
    expect(task!.permission).toBe('batch.execute');
    expect(task!.path).toBe('/terminal/batch');
  });

  it('is NOT station-bound — no BATCH station was created', () => {
    expect(task!.stationDepartments).toBeUndefined();
    expect(task!.stationRequired).toBeUndefined();
  });

  it('is not a shared-queue task (worker-owned builds)', () => {
    expect(task!.shared).toBeUndefined();
    expect(isSharedTask('batch')).toBe(false);
  });

  describe('batch-in (receiving slice)', () => {
    const receive = taskByKey('batch-in');

    it('exists, ready, gated by batch.receive, station-less', () => {
      expect(receive).toBeDefined();
      expect(receive!.ready).toBe(true);
      expect(receive!.permission).toBe('batch.receive');
      expect(receive!.stationDepartments).toBeUndefined();
      expect(receive!.stationRequired).toBeUndefined();
      expect(isSharedTask('batch-in')).toBe(false);
    });

    it('DISPATCH reuse check: no batch task rides the DISPATCH department', () => {
      // The command's station rule: DISPATCH is outbound-only; neither the
      // build nor the receive task is bound to it (no new station, no
      // DISPATCH hijack).
      const { TASK_REGISTRY } = require('../operations/task-registry');
      const batchTasks = TASK_REGISTRY.filter((t: { key: string }) => t.key.startsWith('batch'));
      expect(batchTasks.length).toBe(2);
      expect(batchTasks.every((t: { stationDepartments?: string[] }) => t.stationDepartments === undefined)).toBe(true);
    });
  });

  it('does not collide with any existing task key/path', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TASK_REGISTRY } = require('../operations/task-registry');
    const keys = TASK_REGISTRY.map((t: { key: string }) => t.key);
    expect(keys.filter((k: string) => k === 'batch')).toHaveLength(1);
    const paths = TASK_REGISTRY.map((t: { path: string }) => t.path);
    expect(paths.filter((p: string) => p === '/terminal/batch')).toHaveLength(1);
  });
});
