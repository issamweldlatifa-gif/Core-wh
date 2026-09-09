import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { WorkflowService } from '../workflow/workflow.service';
import { computeLineVerification } from '../receiving/verification-status';
import { normalizeScan } from '../../common/scan-normalizer';

export interface TempStorageActor {
  id: string;
  ip?: string | null;
}

type Db = Prisma.TransactionClient | PrismaService;

const TMP_PREFIX = 'TMP-';
const VALID_STATUSES = ['RECEIVED', 'STAGED', 'READY_FOR_SORTING', 'MOVED_TO_SORTING', 'VOIDED'] as const;

/**
 * TEMPORARY STORAGE — backend/workflow only (no worker UI in this step).
 *
 * Input contract: Receiving Output B (Produit + Carte) ONLY.
 *   Receiving -> Verification -> Rapport -> [CONFIRMED product lines]
 *     -> TemporaryStorageIntake (RECEIVED -> STAGED -> READY_FOR_SORTING
 *     -> MOVED_TO_SORTING) -> Sorting Input (next station step).
 *
 * Cartons NEVER enter here: the table has no carton column, the DTO has no
 * carton field, and the workflow guard rejects carton identifiers at every
 * scan-like entry point. The carton flow ended at the report (Output A).
 */
@Injectable()
export class TemporaryStorageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly assignments: AssignmentsService,
    private readonly workflow: WorkflowService,
  ) {}

  // ------------------------------------------------------------------
  // Intake creation — Receiving Output B -> Temporary Storage Input
  // ------------------------------------------------------------------

  private async genCode(tx: Prisma.TransactionClient) {
    for (let i = 0; i < 25; i += 1) {
      const count = await tx.temporaryStorageIntake.count();
      const code = `${TMP_PREFIX}${String(count + 1 + i).padStart(6, '0')}`;
      if (!(await tx.temporaryStorageIntake.findUnique({ where: { code } }))) return code;
    }
    return `${TMP_PREFIX}R${Date.now().toString().slice(-6)}`;
  }

  /**
   * System handoff: create ONE intake per verified product line, inside the
   * caller's transaction (report submit). Idempotent per report line: a
   * re-run for the same line returns the existing intake instead of a
   * duplicate row.
   */
  async createIntakeFromReceiving(
    db: Prisma.TransactionClient,
    input: {
      receivingSessionId: string;
      receivingProductId: string | null;
      receivingReportId: string;
      receivingReportLineId: string | null;
      sku: string | null;
      reference: string | null;
      productName: string | null;
      quantity: number;
      verificationResult: 'CONFIRMED' | 'MISSING' | 'DAMAGED' | 'PENDING';
    },
    actor: TempStorageActor,
  ) {
    if (input.verificationResult !== 'CONFIRMED') {
      throw new ConflictException(
        `Only CONFIRMED product lines move to Temporary Storage (line is ${input.verificationResult}).`,
      );
    }
    const qty = Math.floor(Number(input.quantity) || 0);
    if (qty < 1) throw new BadRequestException('quantity must be at least 1.');
    // The handoff carries product (+card) identifiers only — a carton value
    // here means the caller mixed Output A with Output B. Refuse loudly.
    for (const value of [input.sku, input.reference]) {
      if (value) await this.workflow.assertNotCartonIdentifier(value, 'TEMPORARY_STORAGE', actor, db);
    }
    if (input.receivingReportLineId) {
      const existing = await db.temporaryStorageIntake.findFirst({
        where: { receivingReportLineId: input.receivingReportLineId, status: { not: 'VOIDED' } },
      });
      if (existing) return existing;
    }
    const code = await this.genCode(db);
    const row = await db.temporaryStorageIntake.create({
      data: {
        code,
        status: 'RECEIVED',
        receivingSessionId: input.receivingSessionId,
        receivingProductId: input.receivingProductId,
        receivingReportId: input.receivingReportId,
        receivingReportLineId: input.receivingReportLineId,
        sku: input.sku,
        reference: input.reference,
        productName: input.productName,
        quantity: qty,
        verificationResult: input.verificationResult,
        receivedBy: actor.id,
      },
    });
    await this.audit.log(
      {
        actorUserId: actor.id,
        action: 'TEMP_INTAKE_CREATED',
        entityType: 'temp_intake',
        entityId: row.id,
        ipAddress: actor.ip ?? null,
        metadata: {
          intake: code,
          session: input.receivingSessionId,
          sku: input.sku,
          reference: input.reference,
          quantity: qty,
        },
      },
      db,
    );
    await this.workflow.logEvent(
      {
        flow: 'PRODUCT',
        event: 'PRODUCT_HANDOFF_TEMP',
        entityType: 'product',
        entityId: input.receivingProductId,
        entityCode: input.sku ?? input.reference,
        receivingSessionId: input.receivingSessionId,
        fromStation: 'RECEIVING',
        toStation: 'TEMPORARY_STORAGE',
        actorId: actor.id,
        metadata: { intake: code, quantity: qty },
      },
      db,
    );
    await this.workflow.logEvent(
      {
        flow: 'PRODUCT',
        event: 'TEMP_STORAGE_RECEIVED',
        entityType: 'temp_intake',
        entityId: row.id,
        entityCode: code,
        receivingSessionId: input.receivingSessionId,
        toStation: 'TEMPORARY_STORAGE',
        actorId: actor.id,
        metadata: { sku: input.sku, reference: input.reference, quantity: qty },
      },
      db,
    );
    return row;
  }

  /**
   * Manual re-push (supervisor recovery): hand ONE verified product line of
   * an already-submitted report to Temporary Storage. The report gate keeps
   * the station order (Receiving -> Verification -> Report -> Temp): no
   * report, no handoff. Only CONFIRMED lines move.
   */
  async manualIntake(
    input: { receivingSessionId: string; receivingProductId: string },
    actor: TempStorageActor,
  ) {
    await this.assignments.assertOperationalAccess(actor.id, 'temporary-storage', {});
    const session = await this.prisma.receivingSession.findUnique({
      where: { id: input.receivingSessionId },
    });
    if (!session) throw new NotFoundException('Receiving session not found.');
    const report = await this.prisma.receivingReport.findUnique({
      where: { receivingSessionId: session.id },
      include: { lines: true },
    });
    if (!report || report.status === 'DRAFT') {
      throw new ConflictException('The verification report must be submitted before the Temporary Storage handoff.');
    }
    const line = await this.prisma.receivingProduct.findFirst({
      where: { id: input.receivingProductId, receivingSessionId: session.id },
    });
    if (!line) throw new NotFoundException('Receiving product line not found.');
    const v = computeLineVerification({
      expected: line.expectedQuantity,
      received: line.receivedQuantity,
      damaged: line.damagedQuantity ?? 0,
    });
    if (v.result !== 'CONFIRMED') {
      throw new ConflictException(`Only CONFIRMED product lines move to Temporary Storage (line is ${v.result}).`);
    }
    const reportLine = report.lines.find((l) => l.receivingProductId === line.id) ?? null;
    return this.prisma.$transaction((tx) =>
      this.createIntakeFromReceiving(
        tx,
        {
          receivingSessionId: session.id,
          receivingProductId: line.id,
          receivingReportId: report.id,
          receivingReportLineId: reportLine?.id ?? null,
          sku: line.sku,
          reference: line.reference,
          productName: line.productName,
          quantity: v.confirmed,
          verificationResult: 'CONFIRMED',
        },
        actor,
      ),
    );
  }

  // ------------------------------------------------------------------
  // Read — product tracking at Temporary Storage
  // ------------------------------------------------------------------

  async listIntakes(filter: { status?: string; q?: string; receivingSessionId?: string; take?: number }) {
    const where: Prisma.TemporaryStorageIntakeWhereInput = {};
    if (filter.status && (VALID_STATUSES as readonly string[]).includes(filter.status)) {
      where.status = filter.status as never;
    }
    if (filter.receivingSessionId) where.receivingSessionId = filter.receivingSessionId;
    const q = normalizeScan(filter.q).toUpperCase();
    if (q) {
      where.OR = [
        { code: { contains: q } },
        { sku: { contains: q, mode: 'insensitive' } },
        { reference: { contains: q, mode: 'insensitive' } },
        { productName: { contains: q, mode: 'insensitive' } },
      ];
    }
    return this.prisma.temporaryStorageIntake.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(filter.take ?? 100, 1), 200),
      include: {
        station: { select: { code: true, name: true, department: true } },
        zone: { select: { code: true } },
        location: { select: { locationCode: true } },
      },
    });
  }

  async getIntake(code: string) {
    const row = await this.prisma.temporaryStorageIntake.findUnique({
      where: { code: normalizeScan(code).toUpperCase() },
      include: {
        station: { select: { code: true, name: true, department: true } },
        zone: { select: { code: true } },
        location: { select: { locationCode: true } },
      },
    });
    if (!row) throw new NotFoundException('Temporary Storage intake not found.');
    const history = await this.workflow.historyFor('temp_intake', row.id);
    return { ...row, history };
  }

  // ------------------------------------------------------------------
  // Placement — RECEIVED -> STAGED (station/section/location, expandable)
  // ------------------------------------------------------------------

  /**
   * Place an intake at a temporary-storage position. The station is resolved
   * SERVER-SIDE ONLY (explicit valid STAGING station, else the worker's own
   * ACTIVE station); the zone defaults to the station's configured zone; an
   * optional concrete location must be ACTIVE and inside that zone.
   */
  async stageIntake(
    code: string,
    input: { stationCode?: string | null; zoneCode?: string | null; section?: string | null; locationCode?: string | null },
    actor: TempStorageActor & { stationId?: string | null },
  ) {
    await this.assignments.assertOperationalAccess(actor.id, 'temporary-storage', {});
    const intake = await this.prisma.temporaryStorageIntake.findUnique({
      where: { code: normalizeScan(code).toUpperCase() },
    });
    if (!intake) throw new NotFoundException('Temporary Storage intake not found.');
    if (intake.status !== 'RECEIVED') {
      throw new ConflictException(`Intake ${intake.code} is ${intake.status} — only RECEIVED intakes can be staged.`);
    }
    // Scan-like inputs must never be carton identifiers (carton flow ended).
    if (input.locationCode) {
      await this.workflow.assertNotCartonIdentifier(input.locationCode, 'TEMPORARY_STORAGE', actor);
    }

    // Resolve the STAGING station server-side (same rule as tote staging).
    let station;
    const requestedCode = normalizeScan(input.stationCode).toUpperCase();
    if (requestedCode) {
      station = await this.prisma.station.findUnique({
        where: { code: requestedCode },
        include: { zone: { select: { id: true, code: true } } },
      });
      if (!station) throw new NotFoundException(`Staging station "${input.stationCode}" not found.`);
    } else if (actor.stationId) {
      station = await this.prisma.station.findUnique({
        where: { id: actor.stationId },
        include: { zone: { select: { id: true, code: true } } },
      });
    } else {
      station = await this.prisma.station.findFirst({
        where: { assignedWorkerId: actor.id, status: 'ACTIVE' },
        orderBy: { code: 'asc' },
        include: { zone: { select: { id: true, code: true } } },
      });
    }
    if (!station || station.department !== 'STAGING') {
      throw new ConflictException(
        'No STAGING station is available for this worker. A supervisor must configure a temporary storage station.',
      );
    }
    if (station.status !== 'ACTIVE') {
      throw new ConflictException(`Staging station ${station.code} is ${station.status}.`);
    }

    // Zone: explicit code wins, else the station's configured zone.
    let zoneId: string | null = station.zoneId ?? null;
    let zoneCode: string | null = station.zone?.code ?? null;
    const requestedZone = normalizeScan(input.zoneCode).toUpperCase();
    if (requestedZone) {
      const zone = await this.prisma.zone.findFirst({
        where: { code: requestedZone, status: 'ACTIVE' },
        select: { id: true, code: true },
      });
      if (!zone) throw new NotFoundException(`Zone "${input.zoneCode}" not found or inactive.`);
      zoneId = zone.id;
      zoneCode = zone.code;
    }
    if (!zoneId) {
      throw new ConflictException(`Staging station ${station.code} has no zone configured. Assign its zone in Admin.`);
    }

    // Optional concrete location: must be ACTIVE and inside the same zone.
    let locationId: string | null = null;
    const locationCode = normalizeScan(input.locationCode);
    if (locationCode) {
      const location = await this.prisma.location.findFirst({
        where: {
          OR: [{ locationCode }, { barcodeValue: locationCode }, { qrValue: locationCode }],
        },
        select: { id: true, locationCode: true, status: true, zoneId: true },
      });
      if (!location) throw new NotFoundException('Location not found.');
      if (location.status !== 'ACTIVE') {
        throw new ConflictException(`Location ${location.locationCode} is ${location.status}.`);
      }
      if (location.zoneId !== zoneId) {
        throw new ConflictException(
          `Wrong zone: location ${location.locationCode} is not inside temporary-storage zone ${zoneCode}.`,
        );
      }
      locationId = location.id;
    }

    const section = normalizeScan(input.section) || null;

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.temporaryStorageIntake.findUnique({ where: { id: intake.id } });
      if (!current || current.status !== 'RECEIVED') {
        throw new ConflictException('Intake already changed or staged.');
      }
      const staged = await tx.temporaryStorageIntake.update({
        where: { id: intake.id },
        data: {
          status: 'STAGED',
          stationId: station.id,
          zoneId,
          section,
          locationId,
          stagedBy: actor.id,
          stagedAt: new Date(),
        },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'TEMP_INTAKE_STAGED',
          entityType: 'temp_intake',
          entityId: intake.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            intake: intake.code,
            station: station.code,
            zone: zoneCode,
            section,
            location: locationCode || null,
          },
        },
        tx,
      );
      await this.workflow.logEvent(
        {
          flow: 'PRODUCT',
          event: 'TEMP_STORAGE_STAGED',
          entityType: 'temp_intake',
          entityId: intake.id,
          entityCode: intake.code,
          receivingSessionId: intake.receivingSessionId,
          toStation: station.code,
          actorId: actor.id,
          metadata: { zone: zoneCode, section, location: locationCode || null },
        },
        tx,
      );
      return {
        ok: true as const,
        code: intake.code,
        status: staged.status,
        station: { code: station.code, name: station.name },
        zone: zoneCode ? { code: zoneCode } : null,
        section,
        location: locationCode || null,
        stagedAt: staged.stagedAt,
      };
    });
  }

  // ------------------------------------------------------------------
  // Forward transitions — STAGED -> READY_FOR_SORTING -> MOVED_TO_SORTING
  // (Sorting input contract lands with the next station step; the Output
  //  event + status here is already the explicit handoff.)
  // ------------------------------------------------------------------

  async markReadyForSorting(code: string, actor: TempStorageActor) {
    await this.assignments.assertOperationalAccess(actor.id, 'temporary-storage', {});
    const intake = await this.prisma.temporaryStorageIntake.findUnique({
      where: { code: normalizeScan(code).toUpperCase() },
    });
    if (!intake) throw new NotFoundException('Temporary Storage intake not found.');
    if (intake.status !== 'STAGED') {
      throw new ConflictException(`Intake ${intake.code} is ${intake.status} — only STAGED intakes become ready for Sorting.`);
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.temporaryStorageIntake.findUnique({ where: { id: intake.id } });
      if (!current || current.status !== 'STAGED') throw new ConflictException('Intake already changed.');
      const updated = await tx.temporaryStorageIntake.update({
        where: { id: intake.id },
        data: { status: 'READY_FOR_SORTING', readyAt: new Date() },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'TEMP_INTAKE_READY_FOR_SORTING',
          entityType: 'temp_intake',
          entityId: intake.id,
          ipAddress: actor.ip ?? null,
          metadata: { intake: intake.code },
        },
        tx,
      );
      await this.workflow.logEvent(
        {
          flow: 'PRODUCT',
          event: 'TEMP_STORAGE_READY',
          entityType: 'temp_intake',
          entityId: intake.id,
          entityCode: intake.code,
          receivingSessionId: intake.receivingSessionId,
          fromStation: 'TEMPORARY_STORAGE',
          toStation: 'SORTING',
          actorId: actor.id,
        },
        tx,
      );
      return { ok: true as const, code: intake.code, status: updated.status, readyAt: updated.readyAt };
    });
  }

  /** Sorting pull: the intake leaves Temporary Storage toward Sorting. */
  async moveToSorting(code: string, actor: TempStorageActor) {
    await this.assignments.assertOperationalAccess(actor.id, 'temporary-storage', {});
    const intake = await this.prisma.temporaryStorageIntake.findUnique({
      where: { code: normalizeScan(code).toUpperCase() },
    });
    if (!intake) throw new NotFoundException('Temporary Storage intake not found.');
    if (intake.status !== 'READY_FOR_SORTING') {
      throw new ConflictException(
        `Intake ${intake.code} is ${intake.status} — only READY_FOR_SORTING intakes move to Sorting.`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.temporaryStorageIntake.findUnique({ where: { id: intake.id } });
      if (!current || current.status !== 'READY_FOR_SORTING') throw new ConflictException('Intake already changed.');
      const updated = await tx.temporaryStorageIntake.update({
        where: { id: intake.id },
        data: { status: 'MOVED_TO_SORTING', movedAt: new Date() },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'TEMP_INTAKE_MOVED_TO_SORTING',
          entityType: 'temp_intake',
          entityId: intake.id,
          ipAddress: actor.ip ?? null,
          metadata: { intake: intake.code },
        },
        tx,
      );
      await this.workflow.logEvent(
        {
          flow: 'PRODUCT',
          event: 'TEMP_STORAGE_MOVED_TO_SORTING',
          entityType: 'temp_intake',
          entityId: intake.id,
          entityCode: intake.code,
          receivingSessionId: intake.receivingSessionId,
          fromStation: 'TEMPORARY_STORAGE',
          toStation: 'SORTING',
          actorId: actor.id,
        },
        tx,
      );
      return { ok: true as const, code: intake.code, status: updated.status, movedAt: updated.movedAt };
    });
  }

  /** Session-scoped intake summary (flow tracking per receiving session). */
  async intakesForSession(receivingSessionId: string) {
    return this.prisma.temporaryStorageIntake.findMany({
      where: { receivingSessionId },
      orderBy: { createdAt: 'asc' },
      include: {
        station: { select: { code: true, name: true } },
        zone: { select: { code: true } },
        location: { select: { locationCode: true } },
      },
    });
  }
}
