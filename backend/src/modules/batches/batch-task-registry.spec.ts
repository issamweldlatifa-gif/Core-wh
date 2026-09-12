import { isSharedTask, taskByKey } from '../operations/task-registry';

/**
 * BATCH tasks in the worker terminal registry (Phase 2).
 * Owner order (2026-09-12): batch is a full station operation in its OWN
 * department — BATCH (station BATCH-01, managed from the admin Stations
 * page). Both tasks are bound to BATCH-department stations, are permission-
 * served (batch.execute / batch.receive), and are never marked shared
 * (authorization is per-worker permission, not a shared queue).
 */
describe('task registry — batch build task', () => {
  const task = taskByKey('batch');

  it('exists, is ready and gated by batch.execute', () => {
    expect(task).toBeDefined();
    expect(task!.ready).toBe(true);
    expect(task!.permission).toBe('batch.execute');
    expect(task!.path).toBe('/terminal/batch');
  });

  it('is station-bound to the dedicated BATCH department', () => {
    // USER ORDER 2026-09-12: batch became a full station operation with its
    // own department (BATCH — station BATCH-01).
    expect(task!.department).toBe('BATCH');
    expect(task!.stationDepartments).toEqual(['BATCH']);
    expect(task!.stationRequired).toBeUndefined(); // unassigned devices stay usable
  });

  it('is not a shared-queue task (worker-owned builds)', () => {
    expect(task!.shared).toBeUndefined();
    expect(isSharedTask('batch')).toBe(false);
  });

  describe('batch-in (receiving slice)', () => {
    const receive = taskByKey('batch-in');

    it('exists, ready, gated by batch.receive, bound to BATCH stations', () => {
      expect(receive).toBeDefined();
      expect(receive!.ready).toBe(true);
      expect(receive!.permission).toBe('batch.receive');
      expect(receive!.department).toBe('BATCH');
      expect(receive!.stationDepartments).toEqual(['BATCH']);
      expect(receive!.stationRequired).toBeUndefined();
      expect(isSharedTask('batch-in')).toBe(false);
    });

    it('DISPATCH reuse check stands: no batch task rides the DISPATCH department', () => {
      // The command's station rule: DISPATCH is outbound-only. The batch
      // lane lives in its own BATCH department — never DISPATCH.
      const { TASK_REGISTRY } = require('../operations/task-registry');
      const batchTasks = TASK_REGISTRY.filter((t: { key: string }) => t.key.startsWith('batch'));
      expect(batchTasks.length).toBe(2);
      expect(batchTasks.every((t: { stationDepartments?: string[] }) =>
        !(t.stationDepartments ?? []).includes('DISPATCH'),
      )).toBe(true);
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
