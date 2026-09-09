import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { PushService } from '../notifications/push.service';
import { TemporaryStorageService } from '../temporary-storage/temporary-storage.service';
import { WorkflowService } from '../workflow/workflow.service';
import { sameScanCode } from '../../common/scan-normalizer';
import { computeLineVerification, receivingTaskStatus } from './verification-status';

export interface ReportActor {
  id: string;
  name?: string;
  ip?: string | null;
}

export interface ReportPhotoInput {
  dataUrl: string;
  caption?: string | null;
  lineId?: string | null;
}

export interface SaveDraftInput {
  description?: string | null;
  observation?: string | null;
  photos?: ReportPhotoInput[];
}

export interface DamageInput {
  quantity?: number;
  note?: string | null;
}

type Db = Prisma.TransactionClient | PrismaService;

const MAX_PHOTOS = 10;
const MAX_PHOTO_CHARS = 3_000_000; // ~2.2MB of binary per photo
const ADMIN_ROLES = ['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_MANAGER'];

/**
 * ORDER 01 — "Rapport de Confirme" (receiving verification report).
 *
 * Additive service: existing receiving flows are untouched. It derives the
 * ORDER verification vocabularies from the live session state, persists a
 * locked snapshot at submit time (CONFIRMER ET ENVOYER), records per-product
 * results, notifies admins and marks CONFIRMED lines ready for the Temporary
 * Storage handoff (the physical move belongs to the next station — out of
 * ORDER 01 scope).
 *
 * Scope note: submit is intentionally INDEPENDENT of session completion.
 * The worker may submit the report on an open session (verification done,
 * totes still being staged) or on a completed one; report SUBMITTED/CLOSED
 * never closes the session and never dispatches tote/sorting tasks.
 */
@Injectable()
export class ReceivingReportsService {
  private readonly logger = new Logger(ReceivingReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly assignments: AssignmentsService,
    private readonly push: PushService,
    private readonly temp: TemporaryStorageService,
    private readonly workflow: WorkflowService,
  ) {}

  // ---------- helpers ----------

  private async requireSession(id: string) {
    const s = await this.prisma.receivingSession.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Receiving session not found.');
    return s;
  }

  /** Same rule as ReceivingService.resolveStationId: ACTIVE station bound to the worker. */
  private async stationSnapshot(db: Db, workerId: string | null | undefined) {
    if (!workerId) return { stationId: null as string | null, stationCode: null as string | null };
    const station = await db.station.findFirst({
      where: { assignedWorkerId: workerId, status: 'ACTIVE' },
      select: { id: true, code: true },
    });
    return { stationId: station?.id ?? null, stationCode: station?.code ?? null };
  }

  private validatePhotos(photos: ReportPhotoInput[] | undefined): ReportPhotoInput[] {
    if (!photos) return [];
    if (!Array.isArray(photos)) throw new BadRequestException('photos must be an array.');
    if (photos.length > MAX_PHOTOS) {
      throw new BadRequestException(`Too many photos (max ${MAX_PHOTOS}).`);
    }
    for (const p of photos) {
      if (typeof p?.dataUrl !== 'string' || !p.dataUrl.startsWith('data:image/')) {
        throw new BadRequestException('Each photo must be an image data URL (data:image/...).');
      }
      if (p.dataUrl.length > MAX_PHOTO_CHARS) {
        throw new BadRequestException('A photo exceeds the size limit (~2MB).');
      }
    }
    return photos;
  }

  /** Live verification computation from the current session state. */
  private async computeLive(db: Db, sessionId: string) {
    const session = await db.receivingSession.findUnique({
      where: { id: sessionId },
      include: {
        expectedArrival: { include: { shipments: { include: { cartons: true } } } },
        products: { orderBy: [{ sku: 'asc' }, { reference: 'asc' }] },
        cartons: true,
      },
    });
    if (!session) throw new NotFoundException('Receiving session not found.');

    const lines = session.products.map((p) => {
      const v = computeLineVerification({
        expected: p.expectedQuantity,
        received: p.receivedQuantity,
        damaged: p.damagedQuantity ?? 0,
      });
      return {
        receivingProductId: p.id,
        sku: p.sku,
        reference: p.reference,
        productName: p.productName,
        expectedQuantity: p.expectedQuantity,
        scannedQuantity: v.scanned,
        confirmedQuantity: v.confirmed,
        missingQuantity: v.missing,
        damagedQuantity: v.damaged,
        result: v.result,
        note: p.damageNote ?? null,
      };
    });

    const totals = {
      expectedProducts: lines.length,
      confirmedProducts: lines.filter((l) => l.result === 'CONFIRMED').length,
      missingProducts: lines.filter((l) => l.result === 'MISSING').length,
      damagedProducts: lines.filter((l) => l.result === 'DAMAGED').length,
      expectedUnits: lines.reduce((n, l) => n + l.expectedQuantity, 0),
      scannedUnits: lines.reduce((n, l) => n + l.scannedQuantity, 0),
      confirmedUnits: lines.reduce((n, l) => n + l.confirmedQuantity, 0),
      missingUnits: lines.reduce((n, l) => n + l.missingQuantity, 0),
      damagedUnits: lines.reduce((n, l) => n + l.damagedQuantity, 0),
      expectedCartons: session.expectedArrival.shipments.reduce((n, s) => n + s.cartons.length, 0),
      receivedCartons: session.cartons.filter((c) => c.status === 'RECEIVED').length,
      missingCartons: 0,
    };
    totals.missingCartons = Math.max(0, totals.expectedCartons - totals.receivedCartons);

    // WORKFLOW SEPARATION — Output A (Carton verification lines).
    // Every expected carton gets one row: received -> CONFIRMED; expected but
    // not received -> PENDING while the session is open, MISSING (with an
    // error detail) once verification closes. Receipt scans with no expected
    // row are kept as unexpected-but-received (never silently dropped).
    const sessionOpen = session.status === 'RECEIVING' || session.status === 'PAUSED';
    const receivedByCartonId = new Map<string, (typeof session.cartons)[number]>();
    for (const rc of session.cartons) {
      if (rc.cartonId && !receivedByCartonId.has(rc.cartonId)) receivedByCartonId.set(rc.cartonId, rc);
    }
    const cartonLines: Array<{
      cartonId: string | null;
      externalCartonId: string | null;
      reference: string | null;
      trackingNumber: string | null;
      expected: boolean;
      received: boolean;
      result: 'PENDING' | 'CONFIRMED' | 'MISSING' | 'DAMAGED';
      scannedAt: Date | null;
      errorDetail: string | null;
      note: string | null;
    }> = [];
    for (const s of session.expectedArrival.shipments) {
      for (const c of s.cartons) {
        const rc =
          (c.id ? receivedByCartonId.get(c.id) : undefined) ??
          session.cartons.find((r) => !r.cartonId && sameScanCode(r.scannedCode, c.externalCartonId)) ??
          null;
        const received = !!rc || c.status === 'RECEIVED' || c.status === 'STORED';
        cartonLines.push({
          cartonId: c.id,
          externalCartonId: c.externalCartonId,
          reference: c.cartonReference,
          trackingNumber:
            (c as { trackingCode?: string | null }).trackingCode ??
            (c as { suiviCode?: string | null }).suiviCode ??
            s.trackingNumber ??
            (s as { suiviCode?: string | null }).suiviCode ??
            null,
          expected: true,
          received,
          result: received ? 'CONFIRMED' : sessionOpen ? 'PENDING' : 'MISSING',
          scannedAt: rc?.receivedAt ?? c.receivedAt ?? null,
          errorDetail: !received && !sessionOpen ? 'Carton expected but not received at verification.' : null,
          note: null,
        });
      }
    }
    for (const rc of session.cartons) {
      if (!rc.cartonId || cartonLines.some((l) => l.cartonId === rc.cartonId)) continue;
      cartonLines.push({
        cartonId: rc.cartonId,
        externalCartonId: rc.scannedCode,
        reference: null,
        trackingNumber: null,
        expected: false,
        received: true,
        result: 'CONFIRMED',
        scannedAt: rc.receivedAt,
        errorDetail: null,
        note: 'Received without an expected carton row.',
      });
    }

    return { session, lines, totals, cartonLines };
  }

  // ---------- worker: read ----------

  /**
   * Report view for the worker terminal / mobile: live auto data when no
   * locked report exists, locked snapshot afterwards. Manual fields and
   * photos always come from the persisted row (if any).
   */
  async getReport(sessionId: string, actor: ReportActor) {
    const session = await this.requireSession(sessionId);
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', {
      arrivalId: session.arrivalId,
    });
    const persisted = await this.prisma.receivingReport.findUnique({
      where: { receivingSessionId: sessionId },
      include: { lines: true, cartonLines: true, photos: { orderBy: { takenAt: 'asc' } } },
    });
    const live = await this.computeLive(this.prisma, sessionId);
    const locked = !!persisted && persisted.status !== 'DRAFT';
    const station = locked
      ? { stationId: persisted.stationId, stationCode: persisted.stationCode }
      : await this.stationSnapshot(this.prisma, actor.id);

    return {
      session: {
        id: live.session.id,
        code: live.session.code,
        status: live.session.status,
        startedAt: live.session.startedAt,
        completedAt: live.session.completedAt,
        deviceType: live.session.deviceType ?? null,
        deviceName: live.session.deviceName ?? null,
      },
      arrival: {
        id: live.session.expectedArrival.id,
        code: live.session.expectedArrival.code,
        customerName: live.session.expectedArrival.customerName,
        storeName: live.session.expectedArrival.storeName,
        status: live.session.expectedArrival.status,
      },
      taskStatus: receivingTaskStatus({
        hasSession: true,
        sessionStatus: live.session.status,
        reportStatus: persisted?.status ?? null,
      }),
      reportStatus: persisted?.status ?? 'NONE',
      reportId: persisted?.id ?? null,
      totals: locked
        ? {
            expectedProducts: persisted.expectedProducts,
            confirmedProducts: persisted.confirmedProducts,
            missingProducts: persisted.missingProducts,
            damagedProducts: persisted.damagedProducts,
            expectedUnits: persisted.expectedUnits,
            scannedUnits: persisted.scannedUnits,
            confirmedUnits: persisted.confirmedUnits,
            missingUnits: persisted.missingUnits,
            damagedUnits: persisted.damagedUnits,
            expectedCartons: persisted.expectedCartons,
            receivedCartons: persisted.receivedCartons,
            missingCartons: persisted.missingCartons,
          }
        : live.totals,
      lines: locked
        ? persisted.lines.map((l) => ({
            receivingProductId: l.receivingProductId,
            sku: l.sku,
            reference: l.reference,
            productName: l.productName,
            expectedQuantity: l.expectedQuantity,
            scannedQuantity: l.scannedQuantity,
            confirmedQuantity: l.confirmedQuantity,
            missingQuantity: l.missingQuantity,
            damagedQuantity: l.damagedQuantity,
            result: l.result,
            note: l.note,
          }))
        : live.lines,
      // Output A — carton verification (the carton flow ends at this report).
      // Locked snapshot when submitted, live computation while the session
      // is still open. Same shape either way (worker web + mobile).
      cartonLines: locked
        ? persisted.cartonLines.map((l) => ({
            cartonId: l.cartonId,
            externalCartonId: l.externalCartonId,
            reference: l.reference,
            trackingNumber: l.trackingNumber,
            expected: l.expected,
            received: l.received,
            result: l.result,
            scannedAt: l.scannedAt,
            errorDetail: l.errorDetail,
            note: l.note,
          }))
        : live.cartonLines,
      cartonFlow: { ended: !!persisted?.cartonFlowEndedAt, endedAt: persisted?.cartonFlowEndedAt ?? null },
      manual: {
        description: persisted?.description ?? null,
        observation: persisted?.observation ?? null,
      },
      photos: (persisted?.photos ?? []).map((p) => ({
        id: p.id,
        lineId: p.lineId,
        dataUrl: p.dataUrl,
        caption: p.caption,
        takenBy: p.takenBy,
        takenAt: p.takenAt,
      })),
      actor: locked
        ? {
            workerId: persisted.workerId,
            workerName: persisted.workerName,
            stationId: persisted.stationId,
            stationCode: persisted.stationCode,
            deviceType: persisted.deviceType,
            deviceName: persisted.deviceName,
          }
        : {
            workerId: actor.id,
            workerName: actor.name ?? null,
            stationId: station.stationId,
            stationCode: station.stationCode,
            deviceType: live.session.deviceType ?? null,
            deviceName: live.session.deviceName ?? null,
          },
      submittedAt: persisted?.submittedAt ?? null,
      reviewedAt: persisted?.reviewedAt ?? null,
      closedAt: persisted?.closedAt ?? null,
      reviewNote: persisted?.reviewNote ?? null,
      handoffReadyAt: persisted?.handoffReadyAt ?? null,
    };
  }

  // ---------- worker: draft ----------

  /** Save manual fields + photos as DRAFT (only before the report is locked). */
  async saveDraft(sessionId: string, input: SaveDraftInput, actor: ReportActor) {
    const session = await this.requireSession(sessionId);
    if (session.status === 'CANCELLED') throw new ConflictException('Session is cancelled.');
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', {
      arrivalId: session.arrivalId,
    });
    const photos = this.validatePhotos(input.photos);
    const existing = await this.prisma.receivingReport.findUnique({
      where: { receivingSessionId: sessionId },
    });
    if (existing && existing.status !== 'DRAFT') {
      throw new ConflictException(`Report is ${existing.status} — it is locked.`);
    }
    await this.prisma.$transaction(async (tx) => {
      const report = existing
        ? await tx.receivingReport.update({
            where: { id: existing.id },
            data: {
              description: input.description ?? existing.description,
              observation: input.observation ?? existing.observation,
            },
          })
        : await tx.receivingReport.create({
            data: {
              receivingSessionId: sessionId,
              status: 'DRAFT',
              description: input.description ?? null,
              observation: input.observation ?? null,
            },
          });
      if (input.photos) {
        await tx.receivingReportPhoto.deleteMany({ where: { reportId: report.id } });
        if (photos.length > 0) {
          await tx.receivingReportPhoto.createMany({
            data: photos.map((p) => ({
              reportId: report.id,
              lineId: p.lineId ?? null,
              dataUrl: p.dataUrl,
              caption: p.caption ?? null,
              takenBy: actor.id,
            })),
          });
        }
      }
    });
    return this.getReport(sessionId, actor);
  }

  // ---------- worker: damage ----------

  /**
   * Declare damaged units on a verification line (verification-time only:
   * open session + no locked report). Damaged units are a subset of the
   * scanned units; confirmed = scanned - damaged.
   */
  async markDamage(sessionId: string, lineId: string, input: DamageInput, actor: ReportActor) {
    const session = await this.requireSession(sessionId);
    if (session.status !== 'RECEIVING' && session.status !== 'PAUSED') {
      throw new ConflictException('Damage can only be declared on an open session.');
    }
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', {
      arrivalId: session.arrivalId,
    });
    const locked = await this.prisma.receivingReport.findUnique({
      where: { receivingSessionId: sessionId },
      select: { status: true },
    });
    if (locked && locked.status !== 'DRAFT') {
      throw new ConflictException(`Report is ${locked.status} — verification is locked.`);
    }
    const qty = Math.floor(Number(input.quantity) || 0);
    if (qty < 1) throw new BadRequestException('quantity must be at least 1.');
    const line = await this.prisma.receivingProduct.findFirst({
      where: { id: lineId, receivingSessionId: sessionId },
    });
    if (!line) throw new NotFoundException('Verification line not found.');
    const damaged = line.damagedQuantity + qty;
    if (damaged > line.receivedQuantity) {
      throw new ConflictException(
        `Damaged (${damaged}) cannot exceed scanned (${line.receivedQuantity}).`,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.receivingProduct.update({
        where: { id: line.id },
        data: { damagedQuantity: damaged, damageNote: input.note ?? line.damageNote },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'DAMAGE_RECORDED',
          entityType: 'receiving_product',
          entityId: line.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            session: session.code,
            sku: line.sku,
            reference: line.reference,
            added: qty,
            damaged,
            scanned: line.receivedQuantity,
            note: input.note ?? null,
          },
        },
        tx,
      );
    });
    const updated = await this.prisma.receivingProduct.findUnique({ where: { id: line.id } });
    return {
      lineId: line.id,
      verification: computeLineVerification({
        expected: updated!.expectedQuantity,
        received: updated!.receivedQuantity,
        damaged: updated!.damagedQuantity,
      }),
    };
  }

  // ---------- worker: CONFIRMER ET ENVOYER ----------

  /**
   * Submit the verification report (CONFIRMER ET ENVOYER). Atomically:
   *  - locks a snapshot of every PRODUCT result + every CARTON result,
   *  - ends the CARTON flow at this report (Output A -> Admin, no handoff),
   *  - hands every CONFIRMED product line to Temporary Storage (Output B),
   *  - records worker/station/device/date-time + the workflow ledger rows,
   *  - notifies admins (best-effort, never fails the submit).
   * Idempotent guard: one locked report.
   */
  async submitReport(sessionId: string, input: SaveDraftInput, actor: ReportActor) {
    const session = await this.requireSession(sessionId);
    if (session.status === 'CANCELLED') throw new ConflictException('Session is cancelled.');
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', {
      arrivalId: session.arrivalId,
    });
    const existing = await this.prisma.receivingReport.findUnique({
      where: { receivingSessionId: sessionId },
    });
    if (existing && existing.status !== 'DRAFT') {
      throw new ConflictException(`Report is already ${existing.status}.`);
    }
    const photos = this.validatePhotos(input.photos);

    const submitted = await this.prisma.$transaction(async (tx) => {
      const live = await this.computeLive(tx, sessionId);
      const station = await this.stationSnapshot(tx, actor.id);
      const now = new Date();
      const report = existing
        ? await tx.receivingReport.update({
            where: { id: existing.id },
            data: {
              status: 'SUBMITTED',
              ...live.totals,
              description: input.description ?? existing.description,
              observation: input.observation ?? existing.observation,
              workerId: actor.id,
              workerName: actor.name ?? null,
              stationId: station.stationId,
              stationCode: station.stationCode,
              deviceType: live.session.deviceType ?? null,
              deviceName: live.session.deviceName ?? null,
              submittedBy: actor.id,
              submittedAt: now,
              handoffReadyAt: now,
              cartonFlowEndedAt: now,
            },
          })
        : await tx.receivingReport.create({
            data: {
              receivingSessionId: sessionId,
              status: 'SUBMITTED',
              ...live.totals,
              description: input.description ?? null,
              observation: input.observation ?? null,
              workerId: actor.id,
              workerName: actor.name ?? null,
              stationId: station.stationId,
              stationCode: station.stationCode,
              deviceType: live.session.deviceType ?? null,
              deviceName: live.session.deviceName ?? null,
              submittedBy: actor.id,
              submittedAt: now,
              handoffReadyAt: now,
              cartonFlowEndedAt: now,
            },
          });
      if (input.photos) {
        await tx.receivingReportPhoto.deleteMany({ where: { reportId: report.id } });
        if (photos.length > 0) {
          await tx.receivingReportPhoto.createMany({
            data: photos.map((p) => ({
              reportId: report.id,
              lineId: p.lineId ?? null,
              dataUrl: p.dataUrl,
              caption: p.caption ?? null,
              takenBy: actor.id,
            })),
          });
        }
      }
      await tx.receivingReportLine.deleteMany({ where: { reportId: report.id } });
      if (live.lines.length > 0) {
        await tx.receivingReportLine.createMany({
          data: live.lines.map((l) => ({
            reportId: report.id,
            receivingProductId: l.receivingProductId,
            sku: l.sku,
            reference: l.reference,
            productName: l.productName,
            expectedQuantity: l.expectedQuantity,
            scannedQuantity: l.scannedQuantity,
            confirmedQuantity: l.confirmedQuantity,
            missingQuantity: l.missingQuantity,
            damagedQuantity: l.damagedQuantity,
            result: l.result,
            note: l.note,
          })),
        });
      }
      // Output A — carton snapshot (the carton's end of flow).
      await tx.receivingReportCartonLine.deleteMany({ where: { reportId: report.id } });
      if (live.cartonLines.length > 0) {
        await tx.receivingReportCartonLine.createMany({
          data: live.cartonLines.map((l) => ({
            reportId: report.id,
            cartonId: l.cartonId,
            externalCartonId: l.externalCartonId,
            reference: l.reference,
            trackingNumber: l.trackingNumber,
            expected: l.expected,
            received: l.received,
            result: l.result,
            scannedAt: l.scannedAt,
            errorDetail: l.errorDetail,
            note: l.note,
          })),
        });
      }
      // CARTON FLOW END — one ledger row per carton + one summary audit row.
      for (const l of live.cartonLines) {
        await this.workflow.logEvent(
          {
            flow: 'CARTON',
            event: 'CARTON_FLOW_ENDED',
            entityType: 'carton',
            entityId: l.cartonId,
            entityCode: l.externalCartonId,
            receivingSessionId: sessionId,
            fromStation: 'RECEIVING',
            actorId: actor.id,
            metadata: { result: l.result, received: l.received, reportId: report.id },
          },
          tx,
        );
      }
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'WORKFLOW_CARTON_FLOW_ENDED',
          entityType: 'receiving_report',
          entityId: report.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            session: live.session.code,
            cartons: live.cartonLines.length,
            confirmed: live.cartonLines.filter((l) => l.result === 'CONFIRMED').length,
            missing: live.cartonLines.filter((l) => l.result === 'MISSING').length,
          },
        },
        tx,
      );
      // Output B — CONFIRMED product lines move to Temporary Storage now.
      const createdLines = await tx.receivingReportLine.findMany({ where: { reportId: report.id } });
      const lineIdByProduct = new Map(createdLines.map((l) => [l.receivingProductId, l.id]));
      let tempIntakes = 0;
      for (const l of live.lines) {
        if (l.result !== 'CONFIRMED' || l.confirmedQuantity < 1) continue;
        await this.temp.createIntakeFromReceiving(
          tx,
          {
            receivingSessionId: sessionId,
            receivingProductId: l.receivingProductId,
            receivingReportId: report.id,
            receivingReportLineId: lineIdByProduct.get(l.receivingProductId) ?? null,
            sku: l.sku,
            reference: l.reference,
            productName: l.productName,
            quantity: l.confirmedQuantity,
            verificationResult: 'CONFIRMED',
          },
          { id: actor.id, ip: actor.ip ?? null },
        );
        tempIntakes += 1;
      }
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'REPORT_SUBMITTED',
          entityType: 'receiving_report',
          entityId: report.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            session: live.session.code,
            arrival: live.session.expectedArrival.code,
            totals: live.totals,
            handoff: `${tempIntakes} CONFIRMED line(s) handed to Temporary Storage`,
          },
        },
        tx,
      );
      return { reportId: report.id, tempIntakes };
    });

    // Admin notification never fails the submit (best-effort delivery).
    let notifiedAdmins = 0;
    try {
      notifiedAdmins = await this.notifyAdmins(submitted.reportId, actor);
    } catch (e) {
      this.logger.warn(`Admin notification failed for report ${submitted.reportId}: ${(e as Error).message}`);
    }
    return { ...(await this.getReport(sessionId, actor)), notifiedAdmins, tempIntakesCreated: submitted.tempIntakes };
  }

  /** Push the submission to every admin-role user (plus audit trail). */
  private async notifyAdmins(reportId: string, actor: ReportActor): Promise<number> {
    const report = await this.prisma.receivingReport.findUnique({
      where: { id: reportId },
      include: { session: { include: { expectedArrival: true } } },
    });
    if (!report) return 0;
    const admins = await this.prisma.user.findMany({
      where: { roles: { some: { role: { name: { in: ADMIN_ROLES } } } } },
      select: { id: true },
    });
    const count = await this.push.notifyUsers(
      admins.map((a) => a.id),
      {
        title: 'Rapport de Confirmé soumis',
        body:
          `${report.session.code} · ${report.session.expectedArrival.code} — ` +
          `Confirmés: ${report.confirmedUnits}/${report.expectedUnits}, ` +
          `Manquants: ${report.missingUnits}, Endommagés: ${report.damagedUnits}`,
        route: `/admin/sessions/${report.session.id}`,
        data: { event: 'REPORT_SUBMITTED', reportId, sessionId: report.session.id },
      },
    );
    await this.audit.log({
      actorUserId: actor.id,
      action: 'REPORT_SUBMITTED',
      entityType: 'receiving_report',
      entityId: reportId,
      metadata: { adminAudience: admins.length, notifiedDevices: count },
    });
    return count;
  }

  // ---------- admin: review / close ----------

  async reviewReport(reportId: string, input: { note?: string }, actor: { id: string }) {
    const report = await this.prisma.receivingReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found.');
    if (report.status !== 'SUBMITTED') {
      throw new ConflictException(`Only a SUBMITTED report can be reviewed (now ${report.status}).`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.receivingReport.update({
        where: { id: reportId },
        data: { status: 'REVIEWED', reviewedBy: actor.id, reviewedAt: new Date(), reviewNote: input.note ?? null },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'REPORT_REVIEWED',
          entityType: 'receiving_report',
          entityId: reportId,
          metadata: { note: input.note ?? null },
        },
        tx,
      );
    });
    return this.reportDetail(reportId);
  }

  async closeReport(reportId: string, actor: { id: string }) {
    const report = await this.prisma.receivingReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found.');
    if (report.status !== 'SUBMITTED' && report.status !== 'REVIEWED') {
      throw new ConflictException(`Only a SUBMITTED/REVIEWED report can be closed (now ${report.status}).`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.receivingReport.update({
        where: { id: reportId },
        data: { status: 'CLOSED', closedBy: actor.id, closedAt: new Date() },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'REPORT_CLOSED',
          entityType: 'receiving_report',
          entityId: reportId,
        },
        tx,
      );
    });
    return this.reportDetail(reportId);
  }

  // ---------- admin: list / detail ----------

  async listReports(filter: { status?: string; q?: string }) {
    const where: Prisma.ReceivingReportWhereInput = {};
    if (filter.status && ['DRAFT', 'SUBMITTED', 'REVIEWED', 'CLOSED'].includes(filter.status)) {
      where.status = filter.status as never;
    }
    if (filter.q?.trim()) {
      const q = filter.q.trim();
      where.OR = [
        { session: { code: { contains: q, mode: 'insensitive' } } },
        { session: { expectedArrival: { code: { contains: q, mode: 'insensitive' } } } },
      ];
    }
    const rows = await this.prisma.receivingReport.findMany({
      where,
      orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
      include: {
        session: {
          select: {
            id: true,
            code: true,
            status: true,
            expectedArrival: { select: { code: true, customerName: true } },
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session.id,
      sessionCode: r.session.code,
      sessionStatus: r.session.status,
      arrivalCode: r.session.expectedArrival.code,
      customerName: r.session.expectedArrival.customerName,
      status: r.status,
      totals: {
        expectedUnits: r.expectedUnits,
        scannedUnits: r.scannedUnits,
        confirmedUnits: r.confirmedUnits,
        missingUnits: r.missingUnits,
        damagedUnits: r.damagedUnits,
      },
      workerName: r.workerName,
      submittedAt: r.submittedAt,
      reviewedAt: r.reviewedAt,
      closedAt: r.closedAt,
    }));
  }

  /** Full report detail (admin screen + print): totals, lines, carton lines, photos, actor. */
  async reportDetail(reportId: string) {
    const r = await this.prisma.receivingReport.findUnique({
      where: { id: reportId },
      include: {
        lines: { orderBy: [{ sku: 'asc' }, { reference: 'asc' }] },
        cartonLines: { orderBy: [{ externalCartonId: 'asc' }] },
        photos: { orderBy: { takenAt: 'asc' } },
        session: {
          include: { expectedArrival: { select: { id: true, code: true, customerName: true, storeName: true } } },
        },
      },
    });
    if (!r) throw new NotFoundException('Report not found.');
    return {
      id: r.id,
      status: r.status,
      session: { id: r.session.id, code: r.session.code, status: r.session.status },
      arrival: r.session.expectedArrival,
      taskStatus: receivingTaskStatus({
        hasSession: true,
        sessionStatus: r.session.status,
        reportStatus: r.status,
      }),
      totals: {
        expectedProducts: r.expectedProducts,
        confirmedProducts: r.confirmedProducts,
        missingProducts: r.missingProducts,
        damagedProducts: r.damagedProducts,
        expectedUnits: r.expectedUnits,
        scannedUnits: r.scannedUnits,
        confirmedUnits: r.confirmedUnits,
        missingUnits: r.missingUnits,
        damagedUnits: r.damagedUnits,
        expectedCartons: r.expectedCartons,
        receivedCartons: r.receivedCartons,
        missingCartons: r.missingCartons,
      },
      lines: r.lines,
      // Output A — carton verification snapshot (carton flow ends here).
      cartonLines: r.cartonLines,
      cartonFlow: { ended: !!r.cartonFlowEndedAt, endedAt: r.cartonFlowEndedAt },
      manual: { description: r.description, observation: r.observation },
      photos: r.photos,
      actor: {
        workerId: r.workerId,
        workerName: r.workerName,
        stationId: r.stationId,
        stationCode: r.stationCode,
        deviceType: r.deviceType,
        deviceName: r.deviceName,
      },
      submittedAt: r.submittedAt,
      reviewedAt: r.reviewedAt,
      reviewNote: r.reviewNote,
      closedAt: r.closedAt,
      handoffReadyAt: r.handoffReadyAt,
      createdAt: r.createdAt,
    };
  }
}
