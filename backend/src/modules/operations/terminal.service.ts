import { Injectable } from '@nestjs/common';
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
const TASK_REGISTRY: TerminalTask[] = [
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
    ready: false,
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
    key: 'packing',
    label: 'Packing',
    path: '/terminal/packing',
    department: 'PACKING',
    permission: 'packing.execute',
    ready: false,
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
}
