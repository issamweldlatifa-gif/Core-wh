import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StationsService } from './stations.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { TASK_REGISTRY, type OperationalTask } from './task-registry';

// Backwards-compatible re-export: the registry itself now lives in
// `task-registry.ts` so the assignments module can use it without a module
// cycle. `subtaskOf` marks worker-visible sub-actions (tote filling) that
// share the parent workflow's route and authority.
export type TerminalTask = OperationalTask;
export { TASK_REGISTRY };

/**
 * Worker Terminal context resolver (spec §2/§3).
 *
 * The frontend must never decide what a worker may do. It asks this endpoint
 * "who am I and what can I work on?" and receives the authoritative list of
 * permitted tasks, the assigned station and any session already in flight.
 *
 * Routing rule (§3):
 *   - exactly one permitted task screen -> terminal opens straight into it,
 *   - several                           -> the terminal home lets the worker pick,
 *   - none                              -> the terminal says so (a worker is never
 *                                          bounced into the Admin dashboard, §2).
 *
 * Sub-actions (receiving-container) share their parent's route, so routing
 * counts DISTINCT paths, not registry entries.
 */
@Injectable()
export class TerminalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stations: StationsService,
    private readonly assignments: AssignmentsService,
  ) {}

  /**
   * Resolve everything the Worker Terminal needs in one round trip, so the
   * shell can route without a waterfall of requests on a slow floor device.
   */
  async context(user: { id: string; permissions: string[] }) {
    // Station lookup must never break the terminal: an unassigned worker is a
    // normal state, not an error. Resolved FIRST so department-gated tasks
    // (Temporary Storage = STAGING) can be filtered authoritatively below.
    const station = await this.stations.forWorker(user.id).catch(() => null);
    const departmentAllows = (t: OperationalTask) =>
      !t.stationDepartments || (station ? t.stationDepartments.includes(station.department) : false);
    const tasks = TASK_REGISTRY.filter(
      (t) => user.permissions.includes(t.permission) && departmentAllows(t),
    );
    const readyTasks = tasks.filter((t) => t.ready);
    const readyPaths = Array.from(new Set(readyTasks.map((t) => t.path)));

    // A session already in flight wins over any default routing — the worker
    // returns exactly where they left off after a refresh or a dropped tab.
    // Both operational task types are checked, so a worker who is halfway
    // through stowing is not silently sent back to Receiving.
    const [activeSession, activePutaway] = await Promise.all([
      this.prisma.receivingSession.findFirst({
        where: { startedBy: user.id, status: { in: ['RECEIVING', 'PAUSED'] } },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          code: true,
          status: true,
          startedAt: true,
          expectedArrival: { select: { id: true, code: true, customerName: true } },
        },
      }),
      this.prisma.putawaySession.findFirst({
        where: { workerId: user.id, status: { in: ['ACTIVE', 'PAUSED'] } },
        orderBy: { startedAt: 'desc' },
        select: { id: true, code: true, status: true, startedAt: true },
      }),
    ]);

    // Whichever work is genuinely open decides where the worker lands; the
    // most recently started one wins if somehow both are open.
    const resumeCandidates = [
      activeSession
        ? { kind: 'RECEIVING' as const, path: '/terminal/receiving', startedAt: activeSession.startedAt, code: activeSession.code }
        : null,
      activePutaway
        ? { kind: 'PUTAWAY' as const, path: '/terminal/putaway', startedAt: activePutaway.startedAt, code: activePutaway.code }
        : null,
    ].filter(Boolean) as Array<{ kind: 'RECEIVING' | 'PUTAWAY'; path: string; startedAt: Date; code: string }>;

    resumeCandidates.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const resume = resumeCandidates[0] ?? null;

    const home = resume ? resume.path : readyPaths.length === 1 ? readyPaths[0] : '/terminal';

    return {
      worker: { id: user.id },
      tasks,
      readyTaskCount: readyTasks.length,
      home,
      station: station
        ? {
            id: station.id,
            code: station.code,
            name: station.name,
            department: station.department,
            capabilities: station.capabilities,
          }
        : null,
      activeSession,
      activePutaway,
      /** Where the worker should land: open work first, else their only task. */
      resume,
    };
  }

  // ---------------------------------------------------------------------
  // COMMAND #3 — Worker Control: the worker's own assigned tasks. These are
  // concrete instructions an admin attached to this specific worker; they
  // appear on the terminal home. Scoped strictly to the authenticated user.
  // Delegated to AssignmentsService, which owns the operational lifecycle
  // (ASSIGNED/IN_PROGRESS/COMPLETED/...).
  // ---------------------------------------------------------------------
  myAssignments(userId: string) {
    return this.assignments.myAssignments(userId);
  }

  completeAssignment(userId: string, assignmentId: string, note?: string) {
    return this.assignments.completeAssignment(userId, assignmentId, note);
  }
}
