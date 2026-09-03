import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StationsService } from './stations.service';

/**
 * Worker Terminal context resolver (spec §2/§3).
 *
 * The frontend must never decide what a worker may do. It asks this endpoint
 * "who am I and what can I work on?" and receives the authoritative list of
 * permitted tasks, the assigned station and any session already in flight.
 *
 * Routing rule (§3):
 *   - exactly one permitted task  -> terminal opens straight into it,
 *   - several                     -> the terminal home lets the worker pick,
 *   - none                        -> the terminal says so (a worker is never
 *                                    bounced into the Admin dashboard, §2).
 */
export interface TerminalTask {
  key: string;
  label: string;
  path: string;
  department: string;
  /** Backend permission that unlocks this task — mirrored for UX only. */
  permission: string;
  /** False when the task exists in the framework but has no workflow yet. */
  ready: boolean;
}

/**
 * The task registry. Adding a future terminal (§44) is a single entry here
 * plus its route; identity, station, scanner, audio, session, permissions and
 * audit are inherited from the shared framework.
 */
export const TASK_REGISTRY: TerminalTask[] = [
  {
    key: 'receiving',
    label: 'Receiving',
    path: '/terminal/receiving',
    department: 'RECEIVING',
    permission: 'receiving.execute',
    ready: true,
  },
  {
    key: 'sorting',
    label: 'Sorting',
    path: '/terminal/sorting',
    department: 'SORTING',
    permission: 'stowing.execute',
    ready: true,
  },
  {
    key: 'putaway',
    label: 'Putaway',
    path: '/terminal/putaway',
    department: 'PUTAWAY',
    permission: 'stowing.execute',
    ready: true,
  },
  {
    key: 'order-sorting',
    label: 'Order Sorting',
    path: '/terminal/order-sorting',
    department: 'SORTING',
    permission: 'picking.execute',
    ready: true,
  },
  {
    key: 'packing',
    label: 'Packing',
    path: '/terminal/packing',
    department: 'PACKING',
    permission: 'packing.execute',
    ready: true,
  },
  {
    key: 'shipping',
    label: 'Shipping',
    path: '/terminal/shipping',
    department: 'DISPATCH',
    permission: 'shipping.execute',
    ready: true,
  },
];

@Injectable()
export class TerminalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stations: StationsService,
  ) {}

  /**
   * Resolve everything the Worker Terminal needs in one round trip, so the
   * shell can route without a waterfall of requests on a slow floor device.
   */
  async context(user: { id: string; permissions: string[] }) {
    const tasks = TASK_REGISTRY.filter((t) => user.permissions.includes(t.permission));
    const readyTasks = tasks.filter((t) => t.ready);

    // Station lookup must never break the terminal: an unassigned worker is a
    // normal state, not an error.
    const station = await this.stations.forWorker(user.id).catch(() => null);

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

    const home = resume
      ? resume.path
      : readyTasks.length === 1
        ? readyTasks[0].path
        : '/terminal';

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
  // ---------------------------------------------------------------------
  async myAssignments(userId: string) {
    const [open, recent] = await Promise.all([
      this.prisma.workerTaskAssignment.findMany({
        where: { workerId: userId, status: 'OPEN' },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.workerTaskAssignment.findMany({
        where: { workerId: userId, status: { in: ['DONE', 'CANCELLED'] } },
        orderBy: { completedAt: 'desc' },
        take: 10,
      }),
    ]);
    const shape = (r: any) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      relatedType: r.relatedType,
      relatedCode: r.relatedCode,
      status: r.status,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    });
    return { open: open.map(shape), recent: recent.map(shape) };
  }

  async completeAssignment(userId: string, assignmentId: string, note?: string) {
    const row = await this.prisma.workerTaskAssignment.findUnique({ where: { id: assignmentId } });
    if (!row) throw new NotFoundException('No such assigned task.');
    if (row.workerId !== userId) throw new NotFoundException('No such assigned task for this worker.');
    if (row.status !== 'OPEN') throw new ConflictException(`Task "${row.title}" is already ${row.status}.`);
    const noteText = (note ?? '').trim();
    await this.prisma.workerTaskAssignment.update({
      where: { id: assignmentId },
      data: { status: 'DONE', note: noteText || null, completedById: userId, completedAt: new Date() },
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'TASK_COMPLETED' as any,
        entityType: 'worker_task',
        entityId: row.id,
        metadata: { taskId: row.id, title: row.title, note: noteText || null } as any,
      },
    });
    return { ok: true, id: assignmentId, status: 'DONE' };
  }
}

