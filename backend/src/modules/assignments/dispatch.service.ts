import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { taskByKey } from '../operations/task-registry';

/**
 * AUTOMATIC TASK DISPATCH — the backend workflow hand-off engine
 * (Master Order §9: "When X is completed, the backend automatically creates
 * or activates the next required operational task. Do NOT require an
 * administrator to manually recreate the next task.")
 *
 * This is NOT a second task system. It writes `WorkerTaskAssignment` rows —
 * the single operational task table (Order §20) — with the authoritative
 * entity FKs, and it is called by the workflow services from inside their
 * transactions, so task creation is atomic with the workflow transition.
 *
 * Dispatch rules (backend-only, documented, not UI-configurable):
 *   1. The worker must be ACTIVE.
 *   2. The worker's roles must grant the task's permission.
 *   3. If the worker is bound to an ACTIVE station, that station's department
 *      must match the task's department (same rule WorkPolicyService enforces
 *      at execution time — a dispatched task must be executable).
 *      A worker with no station is eligible (explicit policy: station-less
 *      devices must not be blocked).
 *   4. Priority: workers whose ACTIVE station matches the task department
 *      (configured routing), then station-less workers; within a group, the
 *      worker with the fewest open assignments (operational availability).
 *   5. One open assignment per (taskKey + entity): replays never duplicate.
 *
 * If no eligible worker exists, NOTHING is created — the work remains visible
 * on the worker home through the real floor availability counters, and an
 * admin can still assign manually. We never invent a worker or bypass the
 * rules (Order §40: no workarounds).
 */

export interface DispatchEntity {
  arrivalId?: string;
  cartonId?: string;
  containerId?: string;
  outboundShipmentId?: string;
  orderId?: string;
  /** Human code for the assignment title / echo fields. */
  entityCode?: string;
}

export interface DispatchContext {
  db?: Prisma.TransactionClient;
  /** The workflow event that triggered the dispatch (audit metadata). */
  reason: string;
  actorId?: string | null;
}

const OPEN_STATUSES = ['ASSIGNED', 'IN_PROGRESS'] as const;

@Injectable()
export class TaskDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private db(ctx?: DispatchContext) {
    return ctx?.db ?? this.prisma;
  }

  /**
   * Dispatch the next operational task for an entity, if one is needed and
   * an eligible worker exists. Idempotent: returns null when an open
   * assignment for (taskKey + entity) already exists or no worker qualifies.
   */
  async dispatch(taskKey: string, entity: DispatchEntity, ctx: DispatchContext): Promise<string | null> {
    const task = taskByKey(taskKey);
    if (!task) return null;
    const db = this.db(ctx);

    // 1) Idempotency — one open assignment per (taskKey + entity).
    const entityFilter: any = {};
    if (entity.arrivalId) entityFilter.arrivalId = entity.arrivalId;
    if (entity.cartonId) entityFilter.cartonId = entity.cartonId;
    if (entity.containerId) entityFilter.containerId = entity.containerId;
    if (entity.outboundShipmentId) entityFilter.outboundShipmentId = entity.outboundShipmentId;
    if (entity.orderId) entityFilter.orderId = entity.orderId;

    const existing = await db.workerTaskAssignment.findFirst({
      where: { taskKey, ...entityFilter, status: { in: [...OPEN_STATUSES, 'BLOCKED'] } },
      select: { id: true },
    });
    if (existing) return null;

    // 2) Eligible + ordered candidate workers.
    const candidates = await this.eligibleWorkers(taskKey, ctx);
    if (candidates.length === 0) return null;

    // 3) Load current open-assignment counts for availability ordering.
    const counts = await db.workerTaskAssignment.groupBy({
      by: ['workerId'],
      where: { status: { in: [...OPEN_STATUSES] } },
      _count: { _all: true },
    });
    const load = new Map(counts.map((c: any) => [c.workerId, c._count._all]));
    candidates.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));
    const worker = candidates[0];

    const title = this.titleFor(taskKey, entity);
    const row = await db.workerTaskAssignment.create({
      data: {
        workerId: worker.id,
        title,
        description: `Auto-dispatched: ${ctx.reason}`,
        taskKey,
        status: 'ASSIGNED',
        createdById: ctx.actorId ?? null,
        arrivalId: entity.arrivalId ?? null,
        cartonId: entity.cartonId ?? null,
        containerId: entity.containerId ?? null,
        outboundShipmentId: entity.outboundShipmentId ?? null,
        orderId: entity.orderId ?? null,
        relatedType: this.relatedTypeFor(taskKey),
        relatedCode: entity.entityCode ?? null,
      },
    });

    await this.audit.log(
      {
        actorUserId: ctx.actorId ?? null,
        action: 'TASK_AUTO_DISPATCHED' as never,
        entityType: 'worker_task',
        entityId: row.id,
        metadata: {
          taskId: row.id,
          taskKey,
          workerId: worker.id,
          worker: worker.employeeCode,
          entity: entity.entityCode ?? null,
          reason: ctx.reason,
          autoDispatch: true,
        } as never,
      },
      ctx?.db ?? undefined,
    );

    return row.id;
  }

  private titleFor(taskKey: string, entity: DispatchEntity): string {
    const code = entity.entityCode ?? 'task';
    switch (taskKey) {
      case 'receiving':
        return `Receive arrival ${code}`;
      case 'receiving-container':
        return `Container placement ${code}`;
      case 'sorting':
        return `Sort container ${code}`;
      case 'putaway':
        return `Stow carton ${code}`;
      case 'order-sorting':
        return `Customer sorting ${code}`;
      case 'packing':
        return `Pack container ${code}`;
      case 'shipping':
        return `Dispatch shipment ${code}`;
      default:
        return `Task ${code}`;
    }
  }

  private relatedTypeFor(taskKey: string): string {
    switch (taskKey) {
      case 'receiving':
        return 'ARRIVAL';
      case 'putaway':
        return 'CARTON';
      case 'receiving-container':
      case 'sorting':
      case 'packing':
        return 'CONTAINER';
      case 'order-sorting':
        return 'ORDER';
      case 'shipping':
        return 'OUTBOUND';
      default:
        return 'OTHER';
    }
  }

  /**
   * ACTIVE workers holding the task permission whose station binding (if any)
   * does not conflict with the task department. Ordered: station-matched
   * first (configured routing), then station-less.
   */
  async eligibleWorkers(taskKey: string, ctx?: DispatchContext): Promise<Array<{ id: string; employeeCode: string }>> {
    const task = taskByKey(taskKey);
    if (!task) return [];
    const db = this.db(ctx);

    const users = await db.user.findMany({
      where: {
        status: 'ACTIVE',
        roles: {
          // Role -> RolePermission -> Permission.key.
          // applicationClass filter: only OPERATIONAL-class roles qualify —
          // admin-class roles (SUPER_ADMIN etc.) grant the same permissions
          // for oversight, but admin accounts are never FLOOR workers and
          // must never receive auto-dispatched tasks.
          some: {
            role: {
              isSystem: true,
              applicationClass: 'OPERATIONAL',
              permissions: { some: { permission: { key: task.permission } } },
            },
          },
        },
      },
      select: {
        id: true,
        employeeCode: true,
        stationsAssigned: {
          where: { status: 'ACTIVE' },
          select: { department: true },
        },
      },
    });

    const department = task.department as string;
    const result: Array<{ id: string; employeeCode: string; stationMatch: boolean }> = [];
    for (const u of users) {
      const stations = u.stationsAssigned ?? [];
      if (stations.length > 0 && !stations.some((s) => s.department === department)) {
        continue; // station-bound to another department → cannot execute this task
      }
      result.push({ id: u.id, employeeCode: u.employeeCode, stationMatch: stations.length > 0 });
    }
    // Station-matched (configured routing) first, then station-less workers.
    result.sort((a, b) => Number(b.stationMatch) - Number(a.stationMatch));
    return result;
  }

  /**
   * Receiving completed → next task per tote of the session
   * (Master Order §9: RECEIVING COMPLETED → PUTAWAY/CONTAINER TASK → NEXT WORKER).
   *   - tote still ACTIVE            → receiving-container (finish/close/stage)
   *   - tote READY_FOR_SORTING (not staged) → receiving-container (close/stage)
   * Containers with no articles need no work.
   */
  async onReceivingCompleted(
    session: { id: string; code: string; arrivalId: string },
    actorId: string | null,
    ctx?: DispatchContext,
  ): Promise<void> {
    const db = this.db(ctx);
    const containers = await db.operationalContainer.findMany({
      where: {
        type: 'RECEIVING',
        status: { in: ['ACTIVE', 'READY_FOR_SORTING'] },
        articles: { some: { receivingSessionId: session.id, status: { in: ['IN_CONTAINER', 'RECEIVED'] } } },
      },
      select: { id: true, code: true, status: true, stagedAt: true },
    });
    for (const c of containers) {
      if (c.stagedAt) continue; // already staged — sorting dispatch happened at stage time
      await this.dispatch('receiving-container', { containerId: c.id, entityCode: c.code }, {
        ...ctx,
        reason: `receiving ${session.code} completed`,
        actorId,
      });
    }
  }

  /**
   * A tote was staged to a temporary storage station → the sorting task takes
   * over the container (articles get sorted out of it).
   */
  async onContainerStaged(container: { id: string; code: string }, actorId: string | null, ctx?: DispatchContext): Promise<void> {
    // The container/placement task for this container is done by the stage.
    const db = this.db(ctx);
    await db.workerTaskAssignment.updateMany({
      where: { containerId: container.id, taskKey: 'receiving-container', status: { in: [...OPEN_STATUSES] } },
      data: { status: 'COMPLETED', completedById: actorId ?? undefined, completedAt: new Date(), note: `container staged: ${container.code}` },
    });
    await this.dispatch('sorting', { containerId: container.id, entityCode: container.code }, {
      ...ctx,
      reason: `container ${container.code} staged to temporary storage`,
      actorId,
    });
  }

  /** Customer bin completed (READY_FOR_PACKING) → packing task. */
  async onBinReady(container: { id: string; code: string }, actorId: string | null, ctx?: DispatchContext): Promise<void> {
    await this.dispatch('packing', { containerId: container.id, entityCode: container.code }, {
      ...ctx,
      reason: `customer container ${container.code} ready for packing`,
      actorId,
    });
  }

  /** Pack completed (READY_TO_SHIP) → shipping task. */
  async onPacked(shipment: { id: string; code: string }, actorId: string | null, ctx?: DispatchContext): Promise<void> {
    await this.dispatch('shipping', { outboundShipmentId: shipment.id, entityCode: shipment.code }, {
      ...ctx,
      reason: `shipment ${shipment.code} ready to ship`,
      actorId,
    });
  }

  /**
   * A new CRM order arrived → customer-sorting task, but only when there is
   * actually work: at least one article in the system whose SKU an open line
   * of the order still needs. Otherwise the dispatch is deferred until the
   * matching article is received (see onArticleReceived).
   */
  async onOrderCreated(
    order: { id: string; externalOrderReference: string },
    actorId: string | null,
    ctx?: DispatchContext,
  ): Promise<void> {
    const db = this.db(ctx);
    const items = await db.orderItem.findMany({
      where: { orderId: order.id, status: 'OPEN' },
      select: { product: { select: { externalProductCode: true } } },
    });
    const skus = Array.from(new Set(items.map((i) => i.product.externalProductCode)));
    if (skus.length === 0) return;
    const available = await db.articleUnit.count({
      where: { status: { in: ['IN_CONTAINER', 'RECEIVED', 'STORED'] }, sku: { in: skus } },
    });
    if (available > 0) {
      await this.dispatch('order-sorting', { orderId: order.id, entityCode: order.externalOrderReference }, {
        ...ctx,
        reason: `order ${order.externalOrderReference} received with matching goods available`,
        actorId,
      });
    }
  }

  /**
   * An article unit was received into a tote → if an open order needs this
   * SKU and has no open customer-sorting assignment yet, dispatch it now
   * (deferred dispatch when the order arrived before the goods).
   */
  async onArticleReceived(sku: string, actorId: string | null, ctx?: DispatchContext): Promise<void> {
    const db = this.db(ctx);
    const items = await db.orderItem.findMany({
      where: {
        status: 'OPEN',
        order: { status: 'OPEN' },
        product: { externalProductCode: { equals: sku, mode: 'insensitive' } },
      },
      select: { order: { select: { id: true, externalOrderReference: true } } },
      take: 20,
    });
    for (const item of items) {
      const assigned = await db.articleUnit.count({
        where: { order: { id: item.order.id }, status: { in: ['IN_CUSTOMER_BIN', 'PACKED', 'SHIPPED'] } },
      });
      if (assigned > 0) continue; // already being sorted for this order
      const existing = await db.workerTaskAssignment.findFirst({
        where: { taskKey: 'order-sorting', orderId: item.order.id, status: { in: [...OPEN_STATUSES, 'BLOCKED'] } },
        select: { id: true },
      });
      if (existing) continue;
      // Only dispatch when at least one matching article is actually available.
      const available = await db.articleUnit.count({
        where: { status: { in: ['IN_CONTAINER', 'RECEIVED', 'STORED'] }, sku: { equals: sku, mode: 'insensitive' } },
      });
      if (available > 0) {
        await this.dispatch('order-sorting', { orderId: item.order.id, entityCode: item.order.externalOrderReference }, {
          ...ctx,
          reason: `article SKU ${sku} received, needed by order ${item.order.externalOrderReference}`,
          actorId,
        });
      }
      break; // one order per dispatch call is enough; other orders dispatch on their own turns
    }
  }
}
