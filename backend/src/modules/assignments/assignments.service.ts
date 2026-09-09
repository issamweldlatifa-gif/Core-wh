import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TASK_REGISTRY, taskByKey, isSharedTask } from '../operations/task-registry';

/**
 * WORKER OPERATIONAL ASSIGNMENTS (§5–§11 of the worker order).
 *
 * WorkerTaskAssignment is no longer an advisory "title + relatedCode"
 * checklist item: it carries the task key, AUTHORITATIVE links to the real
 * operational entities (arrival / carton / container / outbound shipment /
 * order / station) and the operational lifecycle:
 *
 *   ASSIGNED → IN_PROGRESS → COMPLETED | COMPLETED_WITH_DISCREPANCY
 *   ASSIGNED/IN_PROGRESS → BLOCKED → ASSIGNED
 *   anything not completed → CANCELLED
 *
 * The lifecycle is driven BY THE WORKFLOW SERVICES (receiving started /
 * completed, carton stored, bin packed, shipment dispatched) — never by the
 * client. The worker may also complete a plain instruction manually with a
 * note (kept for instruction-only assignments).
 */

export type WorkDepartment =
  | 'RECEIVING'
  | 'SORTING'
  | 'PUTAWAY'
  | 'PACKING'
  | 'INVENTORY'
  | 'DISPATCH'
  | 'STAGING';

/** Worker-reportable issue types — exactly the existing discrepancy enum. */
export const WORKER_ISSUE_TYPES = [
  'SHORTAGE',
  'OVERAGE',
  'UNKNOWN_CARTON',
  'WRONG_SHIPMENT',
  'UNEXPECTED_PRODUCT',
  'MISSING_PRODUCT',
  'MISSING_CARTON',
  'IDENTIFICATION_ERROR',
  'OTHER',
] as const;
export type WorkerIssueType = (typeof WORKER_ISSUE_TYPES)[number];

export interface AssignmentActor {
  id: string;
  ip?: string | null;
}

/** Putaway soft-claim TTL: a claim older than this is considered abandoned. */
export const CARTON_CLAIM_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------
  // Entity resolution: admin passes a CODE (WAR-/CTN-/RCN-/BIN-/OUT-/order
  // ref); the backend resolves it to the authoritative FK. The legacy
  // relatedType/relatedCode strings are preserved as a display echo.
  // ------------------------------------------------------------------

  private async resolveEntity(taskKey: string | undefined, relatedType?: string, relatedCode?: string) {
    const type = (relatedType ?? '').trim().toUpperCase() || undefined;
    const code = (relatedCode ?? '').trim() || undefined;
    if (!type && !code) return {};

    if (type === 'ARRIVAL' || taskKey === 'receiving') {
      if (!code) throw new BadRequestException('relatedCode is required for an ARRIVAL assignment.');
      const arrival = await this.prisma.expectedArrival.findFirst({
        where: { OR: [{ id: code }, { code }] },
        select: { id: true, code: true },
      });
      if (!arrival) throw new NotFoundException(`Arrival "${code}" not found.`);
      return { arrivalId: arrival.id, arrivalCode: arrival.code, relatedType: 'ARRIVAL', relatedCode: arrival.code };
    }

    if (type === 'CARTON' || taskKey === 'putaway') {
      if (!code) throw new BadRequestException('relatedCode is required for a CARTON assignment.');
      const carton = await this.prisma.warehouseCarton.findFirst({
        where: { OR: [{ id: code }, { externalCartonId: code }, { qrCodeValue: code }, { barcodeValue: code }] },
        select: { id: true, externalCartonId: true },
      });
      if (!carton) throw new NotFoundException(`Carton "${code}" not found.`);
      return { cartonId: carton.id, cartonCode: carton.externalCartonId, relatedType: 'CARTON', relatedCode: carton.externalCartonId };
    }

    if (type === 'CONTAINER' || type === 'BIN' || type === 'TOTE') {
      if (!code) throw new BadRequestException('relatedCode is required for a CONTAINER assignment.');
      const container = await this.prisma.operationalContainer.findUnique({
        where: { code: code.toUpperCase() },
        select: { id: true, code: true, type: true },
      });
      if (!container) throw new NotFoundException(`Container "${code}" not found.`);
      return {
        containerId: container.id,
        containerCode: container.code,
        relatedType: 'CONTAINER',
        relatedCode: container.code,
      };
    }

    if (type === 'OUTBOUND' || type === 'SHIPMENT_OUT' || taskKey === 'shipping') {
      if (!code) throw new BadRequestException('relatedCode is required for an OUTBOUND assignment.');
      const shipment = await this.prisma.outboundShipment.findUnique({
        where: { code: code.toUpperCase() },
        select: { id: true, code: true },
      });
      if (!shipment) throw new NotFoundException(`Outbound shipment "${code}" not found.`);
      return {
        outboundShipmentId: shipment.id,
        outboundCode: shipment.code,
        relatedType: 'OUTBOUND',
        relatedCode: shipment.code,
      };
    }

    if (type === 'ORDER') {
      if (!code) throw new BadRequestException('relatedCode is required for an ORDER assignment.');
      const order = await this.prisma.warehouseOrder.findFirst({
        where: { OR: [{ id: code }, { externalOrderReference: code.toUpperCase() }] },
        select: { id: true, externalOrderReference: true },
      });
      if (!order) throw new NotFoundException(`Order "${code}" not found.`);
      return {
        orderId: order.id,
        orderCode: order.externalOrderReference,
        relatedType: 'ORDER',
        relatedCode: order.externalOrderReference,
      };
    }

    if (type && type !== 'OTHER' && type !== 'STATION') {
      throw new BadRequestException(`Unknown relatedType "${relatedType}" (use ARRIVAL | CARTON | CONTAINER | OUTBOUND | ORDER | STATION | OTHER).`);
    }
    return { relatedType: type ?? 'OTHER', relatedCode: code ?? null };
  }

  // ------------------------------------------------------------------
  // Admin-side operations
  // ------------------------------------------------------------------

  async create(
    input: {
      workerId: string;
      title?: string;
      description?: string;
      taskKey?: string;
      relatedType?: string;
      relatedCode?: string;
      stationId?: string | null;
    },
    actor: AssignmentActor,
  ) {
    const workerId = (input.workerId ?? '').trim();
    if (!workerId) throw new BadRequestException('workerId is required.');
    const taskKey = input.taskKey?.trim() || undefined;
    if (taskKey && !taskByKey(taskKey)) {
      throw new BadRequestException(`Unknown task "${taskKey}". Known tasks: ${TASK_REGISTRY.map((t) => t.key).join(', ')}.`);
    }
    const worker = await this.prisma.user.findUnique({ where: { id: workerId } });
    if (!worker) throw new NotFoundException('Worker not found.');
    if (worker.status === 'DISABLED') throw new BadRequestException(`${worker.employeeCode} was removed — reactivate before assigning tasks.`);

    const resolved = await this.resolveEntity(taskKey, input.relatedType, input.relatedCode);

    // Resolve the operational entity the assignment points at, then derive
    // the task key when the admin gave only the entity.
    const effectiveTaskKey =
      taskKey
      ?? (resolved.arrivalId ? 'receiving' : undefined)
      ?? (resolved.cartonId ? 'putaway' : undefined)
      ?? (resolved.outboundShipmentId ? 'shipping' : undefined)
      ?? null;

    const title =
      (input.title ?? '').trim()
      || (resolved.arrivalCode ? `Receive arrival ${resolved.arrivalCode}` : undefined)
      || (resolved.cartonCode ? `Stow carton ${resolved.cartonCode}` : undefined)
      || (resolved.containerCode ? `Process container ${resolved.containerCode}` : undefined)
      || (resolved.outboundCode ? `Dispatch shipment ${resolved.outboundCode}` : undefined)
      || (resolved.orderCode ? `Fulfil order ${resolved.orderCode}` : undefined)
      || '';
    if (title.length < 3) throw new BadRequestException('A task title of at least 3 characters is required.');

    const stationId = input.stationId?.trim() || null;
    if (stationId) {
      const station = await this.prisma.station.findUnique({ where: { id: stationId } });
      if (!station) throw new NotFoundException('Station not found.');
    }

    const row = await this.prisma.workerTaskAssignment.create({
      data: {
        workerId,
        title,
        description: input.description?.trim() ? input.description.trim() : null,
        taskKey: effectiveTaskKey,
        status: 'ASSIGNED',
        createdById: actor.id || null,
        arrivalId: resolved.arrivalId ?? null,
        cartonId: resolved.cartonId ?? null,
        containerId: resolved.containerId ?? null,
        outboundShipmentId: resolved.outboundShipmentId ?? null,
        orderId: resolved.orderId ?? null,
        stationId,
        relatedType: (resolved as any).relatedType ?? (effectiveTaskKey ? taskByKey(effectiveTaskKey!)?.department === 'RECEIVING' ? 'ARRIVAL' : 'OTHER' : 'OTHER'),
        relatedCode: (resolved as any).relatedCode ?? null,
      },
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'TASK_ASSIGNED' as never,
      entityType: 'worker_task',
      entityId: row.id,
      ipAddress: actor.ip ?? null,
      metadata: {
        taskId: row.id,
        title,
        taskKey: effectiveTaskKey,
        workerId,
        arrival: resolved.arrivalCode ?? null,
        carton: resolved.cartonCode ?? null,
        container: resolved.containerCode ?? null,
        outbound: resolved.outboundCode ?? null,
        order: resolved.orderCode ?? null,
        stationId,
      },
    });
    return { ok: true, id: row.id, status: row.status, taskKey: effectiveTaskKey };
  }

  async list(filter?: { workerId?: string; status?: string; taskKey?: string }) {
    const rows = await this.prisma.workerTaskAssignment.findMany({
      where: {
        ...(filter?.workerId ? { workerId: filter.workerId } : {}),
        ...(filter?.status && filter.status !== 'ALL' ? { status: filter.status as any } : {}),
        ...(filter?.taskKey && filter.taskKey !== 'ALL' ? { taskKey: filter.taskKey } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: {
        worker: { select: { id: true, name: true, employeeCode: true, status: true } },
        createdBy: { select: { id: true, name: true, employeeCode: true } },
        completedBy: { select: { id: true, name: true, employeeCode: true } },
        arrival: { select: { id: true, code: true, status: true } },
        carton: { select: { id: true, externalCartonId: true, status: true } },
        container: { select: { id: true, code: true, status: true, type: true } },
        outboundShipment: { select: { id: true, code: true, status: true } },
        order: { select: { id: true, externalOrderReference: true, status: true } },
        station: { select: { id: true, code: true, name: true } },
      },
    });
    return rows.map((r) => this.shape(r));
  }

  private shape(r: any) {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      taskKey: r.taskKey ?? null,
      relatedType: r.relatedType ?? null,
      relatedCode: r.relatedCode ?? null,
      status: r.status,
      note: r.note,
      createdAt: r.createdAt?.toISOString?.() ?? r.createdAt,
      completedAt: r.completedAt?.toISOString?.() ?? r.completedAt ?? null,
      cancelledAt: r.cancelledAt?.toISOString?.() ?? r.cancelledAt ?? null,
      worker: r.worker ? { id: r.worker.id, name: r.worker.name, employeeCode: r.worker.employeeCode, status: r.worker.status } : null,
      createdBy: r.createdBy ? { id: r.createdBy.id, name: r.createdBy.name, employeeCode: r.createdBy.employeeCode } : null,
      completedBy: r.completedBy ? { id: r.completedBy.id, name: r.completedBy.name, employeeCode: r.completedBy.employeeCode } : null,
      entity: {
        arrival: r.arrival ? { id: r.arrival.id, code: r.arrival.code, status: r.arrival.status } : null,
        carton: r.carton ? { id: r.carton.id, code: r.carton.externalCartonId, status: r.carton.status } : null,
        container: r.container ? { id: r.container.id, code: r.container.code, status: r.container.status, type: r.container.type } : null,
        outbound: r.outboundShipment ? { id: r.outboundShipment.id, code: r.outboundShipment.code, status: r.outboundShipment.status } : null,
        order: r.order ? { id: r.order.id, code: r.order.externalOrderReference, status: r.order.status } : null,
      },
      station: r.station ? { id: r.station.id, code: r.station.code, name: r.station.name } : null,
    };
  }

  async cancel(id: string, actor: AssignmentActor, reason?: string) {
    const row = await this.prisma.workerTaskAssignment.findUnique({
      where: { id },
      include: { worker: { select: { id: true, name: true, employeeCode: true } } },
    });
    if (!row) throw new NotFoundException(`No task assignment found for "${id}".`);
    if (row.status === 'COMPLETED' || row.status === 'COMPLETED_WITH_DISCREPANCY' || row.status === 'CANCELLED') {
      throw new BadRequestException(`Task ${id} is already ${row.status}.`);
    }
    const reasonText = (reason ?? '').trim();
    await this.prisma.workerTaskAssignment.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledById: actor.id || null, cancelledAt: new Date(), cancelReason: reasonText || 'cancelled by admin' },
    });
    await this.audit.log({
      actorUserId: actor.id,
      action: 'TASK_CANCELLED' as never,
      entityType: 'worker_task',
      entityId: row.id,
      ipAddress: actor.ip ?? null,
      metadata: { taskId: row.id, title: row.title, workerId: row.worker?.id ?? null, reason: reasonText || null },
    });
    return { ok: true, id, status: 'CANCELLED' };
  }

  /** BLOCKED ⇄ ASSIGNED (admin only, audited, reason kept in cancelReason). */
  async setBlocked(id: string, blocked: boolean, actor: AssignmentActor, reason?: string) {
    const row = await this.prisma.workerTaskAssignment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`No task assignment found for "${id}".`);
    if (blocked) {
      if (row.status !== 'ASSIGNED' && row.status !== 'IN_PROGRESS') {
        throw new BadRequestException(`Only ASSIGNED/IN_PROGRESS tasks can be blocked (current: ${row.status}).`);
      }
    } else if (row.status !== 'BLOCKED') {
      throw new BadRequestException(`Task ${id} is not blocked.`);
    }
    const status = blocked ? 'BLOCKED' : 'ASSIGNED';
    await this.prisma.workerTaskAssignment.update({
      where: { id },
      data: { status, cancelReason: blocked ? (reason?.trim() || 'blocked by admin') : null },
    });
    await this.audit.log({
      actorUserId: actor.id,
      action: 'TASK_UPDATED' as never,
      entityType: 'worker_task',
      entityId: id,
      ipAddress: actor.ip ?? null,
      metadata: { taskId: id, blocked, reason: reason ?? null },
    });
    return { ok: true, id, status };
  }

  // ------------------------------------------------------------------
  // Worker-side (terminal) operations
  // ------------------------------------------------------------------

  async myAssignments(userId: string) {
    const [open, recent] = await Promise.all([
      this.prisma.workerTaskAssignment.findMany({
        where: { workerId: userId, status: { in: ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED'] } },
        orderBy: { createdAt: 'asc' },
        include: { arrival: true, carton: true, container: true, outboundShipment: true, order: true, station: true },
      }),
      this.prisma.workerTaskAssignment.findMany({
        where: { workerId: userId, status: { in: ['COMPLETED', 'COMPLETED_WITH_DISCREPANCY', 'CANCELLED'] } },
        orderBy: { completedAt: 'desc' },
        take: 10,
        include: { arrival: true, carton: true, container: true, outboundShipment: true, order: true, station: true },
      }),
    ]);
    return { open: open.map((r) => this.shape(r)), recent: recent.map((r) => this.shape(r)) };
  }

  /** Worker closes a plain instruction with a note (manual path). */
  async completeAssignment(userId: string, assignmentId: string, note?: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.workerTaskAssignment.findUnique({ where: { id: assignmentId } });
      if (!row || row.workerId !== userId) throw new NotFoundException('No such assigned task for this worker.');
      if (row.taskKey || row.arrivalId || row.cartonId || row.containerId || row.outboundShipmentId || row.orderId) {
        throw new ForbiddenException('Complete this task through its warehouse workflow.');
      }
      if (row.status !== 'ASSIGNED' && row.status !== 'IN_PROGRESS') throw new ConflictException('This task cannot be completed.');
      const noteText = (note ?? '').trim();
      const changed = await tx.workerTaskAssignment.updateMany({
        where: { id: assignmentId, workerId: userId, status: { in: ['ASSIGNED', 'IN_PROGRESS'] }, taskKey: null,
          arrivalId: null, cartonId: null, containerId: null, outboundShipmentId: null, orderId: null },
        data: { status: 'COMPLETED', note: noteText || null, completedById: userId, completedAt: new Date() },
      });
      if (changed.count !== 1) throw new ConflictException('Task already changed or completed.');
      await tx.auditLog.create({ data: {
        actorUserId: userId, action: 'TASK_COMPLETED', entityType: 'worker_task', entityId: row.id,
        metadata: { taskId: row.id, title: row.title, note: noteText || null, manual: true, previousState: row.status, newState: 'COMPLETED' },
      } });
      return { ok: true, id: assignmentId, status: 'COMPLETED' };
    });
  }

  /** Existing available-floor-work policy is retained; linked work must respect its owner and block state. */
  async assertOperationalAccess(workerId: string, taskKey: string,
    entity: { arrivalId?: string; cartonId?: string; containerId?: string; outboundShipmentId?: string }, db: Prisma.TransactionClient = this.prisma) {
    // SHARED QUEUE TASKS (Receiving): authorization is by PERMISSION only.
    //
    // Receiving is staffed by several workers at one station at the same
    // time, but dispatch() names exactly ONE worker per arrival. Treating
    // that row as an authorization gate meant only the named worker could
    // open/scan/verify/approve the card — every other qualified worker was
    // rejected here. The route guard has already enforced the task
    // permission (receiving.execute) before we get here, so for a shared
    // task that is the whole authorization decision.
    //
    // The assignment row is NOT deleted and NOT ignored elsewhere: it still
    // drives audit, workload balancing and routing. It simply stops acting
    // as a gate. Per-unit concurrency (two workers scanning the same
    // product) is enforced at the write path, not here.
    if (isSharedTask(taskKey)) return;

    const rows = await db.workerTaskAssignment.findMany({ where: { taskKey, ...entity, status: { not: 'CANCELLED' } }, select: { id: true, workerId: true, status: true, stationId: true } });
    if (!rows.length) return; // audited upstream floor-work policy; strict assignment-only cutover remains a gate
    const own = rows.find((row) => row.workerId === workerId && ['ASSIGNED', 'IN_PROGRESS'].includes(row.status));
    if (!own) throw new ForbiddenException('This work is not assigned to you or is blocked/completed.');
    if (own.stationId) {
      const station = await db.station.findUnique({ where: { id: own.stationId } });
      if (!station || station.status !== 'ACTIVE' || station.assignedWorkerId !== workerId) throw new ForbiddenException('This task requires your assigned station.');
    }
  }

  // ------------------------------------------------------------------
  // Workflow-driven lifecycle (called by the workflow services — the
  // backend owns every transition; workers never write these directly).
  // ------------------------------------------------------------------

  /** A receiving session started on this arrival → ASSIGNED → IN_PROGRESS. */
  async receivingStarted(arrivalId: string, sessionCode: string, workerId: string | null, db: Prisma.TransactionClient = this.prisma) {
    if (!workerId) return 0;
    const updated = await db.workerTaskAssignment.updateMany({
      where: { arrivalId, workerId, taskKey: 'receiving', status: 'ASSIGNED' },
      data: { status: 'IN_PROGRESS' },
    });
    if (updated.count > 0) {
      await db.auditLog.create({
        data: {
          actorUserId: workerId,
          action: 'TASK_IN_PROGRESS' as any,
          entityType: 'worker_task',
          entityId: arrivalId,
          metadata: { arrivalId, session: sessionCode, count: updated.count } as any,
        },
      });
    }
    return updated.count;
  }

  /** Receiving completed on this arrival → COMPLETED(_WITH_DISCREPANCY). */
  async receivingCompleted(arrivalId: string, withDiscrepancy: boolean, sessionCode: string, workerId: string | null, db: Prisma.TransactionClient = this.prisma) {
    if (!workerId) return 0;
    const status = withDiscrepancy ? 'COMPLETED_WITH_DISCREPANCY' : 'COMPLETED';
    const updated = await db.workerTaskAssignment.updateMany({
      where: { arrivalId, workerId, taskKey: 'receiving', status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
      data: { status, completedById: workerId, completedAt: new Date(), note: `receiving session ${sessionCode}` },
    });
    if (updated.count > 0) {
      await db.auditLog.create({
        data: {
          actorUserId: workerId,
          action: 'TASK_COMPLETED' as any,
          entityType: 'worker_task',
          entityId: arrivalId,
          metadata: { arrivalId, session: sessionCode, status, count: updated.count } as any,
        },
      });
    }
    return updated.count;
  }

  /** A putaway placement stored the carton an assignment points at. */
  async cartonStored(cartonId: string, workerId: string | null, db: Prisma.TransactionClient = this.prisma) {
    if (!workerId) return 0;
    const updated = await db.workerTaskAssignment.updateMany({
      where: { cartonId, workerId, taskKey: 'putaway', status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
      data: { status: 'COMPLETED', completedById: workerId, completedAt: new Date() },
    });
    if (updated.count > 0) {
      await db.auditLog.create({
        data: {
          actorUserId: workerId,
          action: 'TASK_COMPLETED' as any,
          entityType: 'worker_task',
          entityId: cartonId,
          metadata: { cartonId, count: updated.count } as any,
        },
      });
    }
    return updated.count;
  }

  /** Packing packed the bin an assignment points at. */
  async containerPacked(containerId: string, workerId: string | null, db: Prisma.TransactionClient = this.prisma) {
    if (!workerId) return 0;
    const updated = await db.workerTaskAssignment.updateMany({
      where: { containerId, workerId, taskKey: 'packing', status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
      data: { status: 'COMPLETED', completedById: workerId, completedAt: new Date() },
    });
    if (updated.count > 0) {
      await db.auditLog.create({
        data: {
          actorUserId: workerId,
          action: 'TASK_COMPLETED' as any,
          entityType: 'worker_task',
          entityId: containerId,
          metadata: { containerId, count: updated.count } as any,
        },
      });
    }
    return updated.count;
  }

  /** Shipping dispatched the outbound shipment an assignment points at. */
  async outboundShipped(shipmentId: string, workerId: string | null, db: Prisma.TransactionClient = this.prisma) {
    if (!workerId) return 0;
    const updated = await db.workerTaskAssignment.updateMany({
      where: { outboundShipmentId: shipmentId, workerId, taskKey: 'shipping', status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
      data: { status: 'COMPLETED', completedById: workerId, completedAt: new Date() },
    });
    if (updated.count > 0) {
      await db.auditLog.create({
        data: {
          actorUserId: workerId,
          action: 'TASK_COMPLETED' as any,
          entityType: 'worker_task',
          entityId: shipmentId,
          metadata: { outboundShipmentId: shipmentId, count: updated.count } as any,
        },
      });
    }
    return updated.count;
  }

  // ------------------------------------------------------------------
  // WORK AVAILABILITY — what the Worker Home shows as counters. Backend
  // truth only: every number is a real database count.
  // ------------------------------------------------------------------

  async workCounts(user: { id: string; permissions: string[] }) {
    const claimCutoff = new Date(Date.now() - CARTON_CLAIM_TTL_MS);
    // STATION ↔ DEPARTMENT: department-gated tasks (Temporary Storage =
    // STAGING) only appear for workers bound to a matching ACTIVE station.
    const station = await this.prisma.station
      .findFirst({ where: { assignedWorkerId: user.id, status: 'ACTIVE' }, select: { department: true } })
      .catch(() => null);
    const departmentAllows = (t: (typeof TASK_REGISTRY)[number]) =>
      !t.stationDepartments || (station ? t.stationDepartments.includes(station.department) : false);
    const tasks = TASK_REGISTRY.filter(
      (t) => !t.subtaskOf && user.permissions.includes(t.permission) && departmentAllows(t),
    );

    // Stored articles still needed by at least one OPEN order line —
    // resolved as a two-step query (distinct SKU codes, then count).
    const openOrderItems = await this.prisma.orderItem.findMany({
      where: { status: 'OPEN' },
      select: { product: { select: { externalProductCode: true } } },
      take: 2000,
    });
    const openOrderSkus = Array.from(new Set(openOrderItems.map((r) => r.product.externalProductCode)));

    const [myOpenAssignments, myReceiving, putawayCartons, myClaims, articlesToSort, binsReady, shipmentsReady, articlesAwaitingOrder] =
      await Promise.all([
        this.prisma.workerTaskAssignment.groupBy({
          by: ['taskKey'],
          where: { workerId: user.id, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
          _count: { _all: true },
        }),
        // Receiving card availability is resolved by GET /receiving/home,
        // which applies the worker's assignment/floor scope. Do not expose
        // the global EXPECTED-arrival count here as a worker queue number.
        this.prisma.receivingSession.count({ where: { startedBy: user.id, status: { in: ['RECEIVING', 'PAUSED'] } } }),
        this.prisma.warehouseCarton.count({
          where: {
            status: 'RECEIVED',
            currentLocationId: null,
            OR: [{ claimedById: null }, { claimedAt: { lt: claimCutoff } }],
          },
        }),
        this.prisma.warehouseCarton.count({
          where: { status: 'RECEIVED', currentLocationId: null, claimedById: user.id, claimedAt: { gte: claimCutoff } },
        }),
        this.prisma.articleUnit.count({ where: { status: 'IN_CONTAINER' } }),
        this.prisma.operationalContainer.count({ where: { type: 'CUSTOMER', status: 'READY_FOR_PACKING' } }),
        this.prisma.outboundShipment.count({ where: { status: 'READY_TO_SHIP' } }),
        openOrderSkus.length
          ? this.prisma.articleUnit.count({ where: { status: 'STORED', order: { is: null }, sku: { in: openOrderSkus } } })
          : Promise.resolve(0),
      ]);

    const assignedBy = new Map<string, number>();
    for (const g of myOpenAssignments as any[]) {
      if (g.taskKey) assignedBy.set(g.taskKey, g._count._all);
    }

    const availability: Record<string, { assigned: number; available: number; mine?: number }> = {
      // The Worker app replaces this queue availability with the scoped
      // Receiving Home feed. Keep only the real open session count here.
      receiving: { assigned: assignedBy.get('receiving') ?? 0, available: myReceiving, mine: myReceiving },
      // Temporary Storage availability is resolved by the station scope
      // (GET /temporary-storage/home header) — never duplicated here. Only
      // admin-assigned tasks surface as a counter.
      'temporary-storage': { assigned: assignedBy.get('temporary-storage') ?? 0, available: 0 },
      'receiving-container': { assigned: 0, available: 0 },
      sorting: { assigned: assignedBy.get('sorting') ?? 0, available: articlesToSort },
      putaway: { assigned: assignedBy.get('putaway') ?? 0, available: putawayCartons, mine: myClaims },
      'order-sorting': { assigned: assignedBy.get('order-sorting') ?? 0, available: articlesAwaitingOrder },
      packing: { assigned: assignedBy.get('packing') ?? 0, available: binsReady },
      shipping: { assigned: assignedBy.get('shipping') ?? 0, available: shipmentsReady },
    };

    return tasks.map((t) => ({
      key: t.key,
      label: t.label,
      path: t.path,
      department: t.department,
      assigned: availability[t.key]?.assigned ?? 0,
      available: availability[t.key]?.available ?? 0,
      mine: availability[t.key]?.mine ?? 0,
    }));
  }

  // ------------------------------------------------------------------
  // WORKER ISSUE REPORTING (§41, fix C-16). Always audited; when a
  // receiving session is referenced, also recorded as an OPEN
  // discrepancy so the Admin Exception Center sees it immediately.
  // ------------------------------------------------------------------

  async reportIssue(
    input: {
      type: string;
      description?: string;
      taskKey?: string;
      sessionId?: string;
      entityCode?: string;
    },
    actor: AssignmentActor & { stationId?: string | null },
  ) {
    const type = (input.type ?? '').trim().toUpperCase();
    if (!(WORKER_ISSUE_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(`Unknown issue type "${input.type}". Allowed: ${WORKER_ISSUE_TYPES.join(', ')}.`);
    }
    const description = (input.description ?? '').trim();
    if (description.length < 3) throw new BadRequestException('Describe the issue (at least 3 characters).');

    let discrepancyId: string | null = null;
    const sessionId = input.sessionId?.trim() || undefined;
    if (sessionId) {
      const session = await this.prisma.receivingSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new NotFoundException('Receiving session not found.');
      const d = await this.prisma.receivingDiscrepancy.create({
        data: {
          receivingSessionId: session.id,
          type: type as never,
          reason: `Worker report: ${description}`.slice(0, 500),
          status: 'OPEN',
          createdBy: actor.id,
        },
      });
      discrepancyId = d.id;
    }

    await this.prisma.auditLog.create({
      data: {
        actorUserId: actor.id,
        action: 'WORKER_ISSUE_REPORTED' as any,
        entityType: discrepancyId ? 'receiving_discrepancy' : 'worker_issue',
        entityId: discrepancyId ?? null,
        metadata: {
          type,
          description: description.slice(0, 500),
          taskKey: input.taskKey ?? null,
          sessionId: sessionId ?? null,
          entityCode: input.entityCode ?? null,
          stationId: actor.stationId ?? null,
          discrepancyId,
        } as any,
      },
    });

    return { ok: true, discrepancyId };
  }
}

/**
 * STATION ↔ DEPARTMENT POLICY (§22). Backend enforcement — never UI.
 *
 * Rule: when a worker is ASSIGNED to an ACTIVE station, they may only
 * execute work of that station's department. A worker with NO station is
 * allowed to work (station-less devices must not be blocked — the station
 * remains optional by design). Denials are audited
 * (UNAUTHORIZED_STATION_ACCESS).
 */
@Injectable()
export class WorkPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async assertDepartment(workerId: string, department: WorkDepartment, context?: { url?: string }) {
    const station = await this.prisma.station.findFirst({
      where: { assignedWorkerId: workerId, status: 'ACTIVE' },
      select: { id: true, code: true, department: true },
    });
    if (!station) return; // no station → allowed (explicit policy)
    if ((station.department as string) === department) return;
    await this.prisma.auditLog.create({
      data: {
        actorUserId: workerId,
        action: 'UNAUTHORIZED_STATION_ACCESS' as any,
        entityType: 'station',
        entityId: station.id,
        metadata: {
          station: station.code,
          stationDepartment: station.department,
          requiredDepartment: department,
          url: context?.url ?? null,
        } as any,
      },
    });
    throw new ForbiddenException(
      `This task requires a ${department} station — you are assigned to ${station.code} (${station.department}). Ask a supervisor to reassign your station.`,
    );
  }
}
