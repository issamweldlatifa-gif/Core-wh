import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ScanSource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Putaway / stowing — move RECEIVED cartons onto real storage locations.
 *
 * Integrity rules, mirroring Receiving:
 *   - the backend is the authority: a carton is only STORED once this service
 *     has validated it and written the row (never on frontend detection),
 *   - movement history is append-only. Re-stowing a carton closes the previous
 *     CartonPlacement (releasedAt) and appends a new one instead of rewriting
 *     it, so the carton's location history stays reconstructable,
 *   - a carton that was never received cannot be stowed, and a location that
 *     is INACTIVE/BLOCKED cannot receive stock.
 */

const PUT_PREFIX = 'PUT-';

export interface PutawayActor {
  id: string;
  name?: string | null;
}

export interface StartPutawayOpts {
  deviceType?: string | null;
  deviceName?: string | null;
}

/** Outcome of a scan, mirroring the receiving `flash` contract. */
export type PutawayFlash =
  | { kind: 'CARTON_READY'; carton: unknown }
  | { kind: 'LOCATION_READY'; location: unknown }
  | { kind: 'STORED'; carton: unknown; location: unknown; moved: boolean }
  | { kind: 'UNKNOWN_CARTON'; code: string }
  | { kind: 'UNKNOWN_LOCATION'; code: string }
  | { kind: 'CARTON_NOT_RECEIVED'; code: string; status: string }
  | { kind: 'LOCATION_UNAVAILABLE'; code: string; status: string };

@Injectable()
export class PutawayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async genCode(tx: Prisma.TransactionClient) {
    for (let i = 0; i < 5; i += 1) {
      const count = await tx.putawaySession.count();
      const code = `${PUT_PREFIX}${String(count + 1).padStart(6, '0')}`;
      if (!(await tx.putawaySession.findUnique({ where: { code } }))) return code;
    }
    return `${PUT_PREFIX}R${Date.now().toString().slice(-6)}`;
  }

  /** Station is resolved server-side, never trusted from the client (§13). */
  private async resolveStationId(tx: Prisma.TransactionClient, workerId: string) {
    const station = await tx.station.findFirst({
      where: { assignedWorkerId: workerId, status: 'ACTIVE' },
      select: { id: true },
    });
    return station?.id ?? null;
  }

  // ---------- session lifecycle ----------

  /** Resume the worker's open session, or start a new one. */
  async start(actor: PutawayActor, opts: StartPutawayOpts = {}) {
    const existing = await this.prisma.putawaySession.findFirst({
      where: { workerId: actor.id, status: { in: ['ACTIVE', 'PAUSED'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (existing) return this.detail(existing.id);

    const session = await this.prisma.$transaction(async (tx) => {
      const code = await this.genCode(tx);
      return tx.putawaySession.create({
        data: {
          code,
          status: 'ACTIVE',
          workerId: actor.id,
          stationId: await this.resolveStationId(tx, actor.id),
          deviceType: opts.deviceType ?? null,
          deviceName: opts.deviceName ?? null,
        },
      });
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'PUTAWAY_STARTED',
      entityType: 'putaway_session',
      entityId: session.id,
      metadata: { code: session.code },
    });
    return this.detail(session.id);
  }

  async active(actor: PutawayActor) {
    const s = await this.prisma.putawaySession.findFirst({
      where: { workerId: actor.id, status: { in: ['ACTIVE', 'PAUSED'] } },
      orderBy: { startedAt: 'desc' },
    });
    return s ? this.detail(s.id) : null;
  }

  /**
   * Cartons that are received but not yet on a shelf — the actual work queue.
   * This is what makes the screen useful: the worker sees what is left.
   */
  async queue(limit = 50) {
    const cartons = await this.prisma.warehouseCarton.findMany({
      where: { status: 'RECEIVED', currentLocationId: null },
      orderBy: { receivedAt: 'asc' },
      take: Math.min(limit, 200),
      include: {
        shipment: {
          select: {
            code: true,
            expectedArrival: {
              select: {
                code: true,
                customerName: true,
                // Categories ride with the carton into the queue so the next
                // stage (Sorting) can decide a destination. The CRM contract
                // has no per-carton contents, so this is the ARRIVAL-level
                // category set. NULL category -> UNKNOWN (needs review).
                items: { select: { category: true } },
              },
            },
          },
        },
      },
    });
    return cartons.map((c) => ({
      id: c.id,
      externalCartonId: c.externalCartonId,
      cartonNumber: c.cartonNumber,
      totalCartons: c.totalCartons,
      receivedAt: c.receivedAt,
      shipmentCode: c.shipment?.code ?? null,
      arrivalCode: c.shipment?.expectedArrival?.code ?? null,
      customerName: c.shipment?.expectedArrival?.customerName ?? null,
      // Distinct categories of the arrival this carton belongs to.
      // NOTE: Category -> Zone/Destination mapping is NOT implemented —
      // DECISION REQUIRED (business rule does not exist in the repo).
      categories: Array.from(
        new Set(
          (c.shipment?.expectedArrival?.items ?? []).map((i) => i.category ?? 'UNKNOWN'),
        ),
      ),
    }));
  }

  async detail(id: string) {
    const session = await this.prisma.putawaySession.findFirst({
      where: { OR: [{ id }, { code: id.toUpperCase() }] },
      include: {
        worker: { select: { id: true, name: true, employeeCode: true } },
        station: { select: { id: true, code: true, name: true } },
        placements: {
          orderBy: { placedAt: 'desc' },
          include: {
            carton: { select: { id: true, externalCartonId: true, status: true } },
            location: { select: { id: true, locationCode: true, locationType: true } },
          },
        },
      },
    });
    if (!session) throw new NotFoundException('Putaway session not found.');

    const pending = await this.prisma.warehouseCarton.count({
      where: { status: 'RECEIVED', currentLocationId: null },
    });

    return {
      id: session.id,
      code: session.code,
      status: session.status,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      worker: session.worker,
      station: session.station,
      placements: session.placements.map((p) => ({
        id: p.id,
        cartonCode: p.carton.externalCartonId,
        locationCode: p.location.locationCode,
        placedAt: p.placedAt,
        releasedAt: p.releasedAt,
        cartonSource: p.cartonSource,
        locationSource: p.locationSource,
      })),
      tally: {
        storedThisSession: session.placements.filter((p) => !p.releasedAt).length,
        totalPlacements: session.placements.length,
        pendingCartons: pending,
      },
    };
  }

  // ---------- scanning ----------

  /**
   * Identify a scanned carton without storing anything yet.
   * Returns an explicit rejection reason rather than throwing, so the terminal
   * can show a readable message and keep the scanner open (§27).
   */
  async scanCarton(code: string): Promise<PutawayFlash> {
    const value = code.trim();
    if (!value) throw new BadRequestException('Empty carton code.');

    const carton = await this.prisma.warehouseCarton.findFirst({
      where: {
        OR: [
          { externalCartonId: value },
          { qrCodeValue: value },
          { barcodeValue: value },
        ],
      },
      include: {
        currentLocation: { select: { locationCode: true } },
        shipment: {
          select: { code: true, expectedArrival: { select: { code: true, customerName: true } } },
        },
      },
    });
    if (!carton) return { kind: 'UNKNOWN_CARTON', code: value };

    // Only a physically received carton may be stowed.
    if (carton.status !== 'RECEIVED' && carton.status !== 'STORED') {
      return { kind: 'CARTON_NOT_RECEIVED', code: value, status: carton.status };
    }

    return {
      kind: 'CARTON_READY',
      carton: {
        id: carton.id,
        externalCartonId: carton.externalCartonId,
        status: carton.status,
        currentLocation: carton.currentLocation?.locationCode ?? null,
        arrivalCode: carton.shipment?.expectedArrival?.code ?? null,
        customerName: carton.shipment?.expectedArrival?.customerName ?? null,
      },
    };
  }

  /** Identify a scanned location and confirm it can accept stock. */
  async scanLocation(code: string): Promise<PutawayFlash> {
    const value = code.trim().toUpperCase();
    if (!value) throw new BadRequestException('Empty location code.');

    const location = await this.prisma.location.findFirst({
      where: { OR: [{ locationCode: value }, { barcodeValue: value }, { qrValue: value }] },
      select: { id: true, locationCode: true, locationType: true, status: true },
    });
    if (!location) return { kind: 'UNKNOWN_LOCATION', code: value };
    if (location.status !== 'ACTIVE') {
      return { kind: 'LOCATION_UNAVAILABLE', code: value, status: location.status };
    }
    return { kind: 'LOCATION_READY', location };
  }

  /**
   * Commit the placement: carton -> location.
   *
   * Runs in a transaction and is idempotent for the no-op case (re-scanning a
   * carton into the location it already occupies does not append noise).
   */
  async place(
    sessionId: string,
    input: {
      cartonCode: string;
      locationCode: string;
      cartonSource?: ScanSource;
      locationSource?: ScanSource;
    },
    actor: PutawayActor,
  ) {
    const session = await this.prisma.putawaySession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Putaway session not found.');
    if (session.status !== 'ACTIVE') {
      throw new ConflictException('This putaway session is not active.');
    }

    const cartonFlash = await this.scanCarton(input.cartonCode);
    if (cartonFlash.kind !== 'CARTON_READY') return { flash: cartonFlash };
    const locationFlash = await this.scanLocation(input.locationCode);
    if (locationFlash.kind !== 'LOCATION_READY') return { flash: locationFlash };

    const cartonId = (cartonFlash.carton as { id: string }).id;
    const location = locationFlash.location as { id: string; locationCode: string };

    const result = await this.prisma.$transaction(async (tx) => {
      const carton = await tx.warehouseCarton.findUnique({ where: { id: cartonId } });
      if (!carton) throw new NotFoundException('Carton disappeared.');

      const alreadyHere = carton.currentLocationId === location.id;
      const moved = !!carton.currentLocationId && !alreadyHere;

      if (alreadyHere) {
        return { carton, moved: false, unchanged: true };
      }

      // Close the previous placement instead of editing it (append-only).
      if (carton.currentLocationId) {
        await tx.cartonPlacement.updateMany({
          where: { cartonId: carton.id, releasedAt: null },
          data: { releasedAt: new Date() },
        });
      }

      await tx.cartonPlacement.create({
        data: {
          cartonId: carton.id,
          locationId: location.id,
          putawaySessionId: session.id,
          cartonSource: input.cartonSource ?? 'MANUAL',
          locationSource: input.locationSource ?? 'MANUAL',
          placedBy: actor.id,
        },
      });

      const updated = await tx.warehouseCarton.update({
        where: { id: carton.id },
        data: {
          currentLocationId: location.id,
          storedAt: new Date(),
          status: 'STORED',
        },
      });

      return { carton: updated, moved, unchanged: false };
    });

    // Only log a real state change. Re-scanning a carton into the location it
    // already occupies is a no-op and must not pollute the audit trail.
    if (!result.unchanged) {
      await this.audit.log({
        actorUserId: actor.id,
        action: result.moved ? 'ITEM_MOVED' : 'ITEM_STORED',
        entityType: 'warehouse_carton',
        entityId: cartonId,
        metadata: {
          location: location.locationCode,
          sessionId: session.id,
          moved: result.moved,
        },
      });
    }

    return {
      flash: {
        kind: 'STORED',
        carton: {
          id: result.carton.id,
          externalCartonId: result.carton.externalCartonId,
          status: result.carton.status,
        },
        location,
        moved: result.moved,
      } as PutawayFlash,
      session: await this.detail(session.id),
    };
  }

  // ---------- pause / resume / complete ----------

  async pause(sessionId: string, actor: PutawayActor) {
    await this.prisma.putawaySession.update({
      where: { id: sessionId },
      data: { status: 'PAUSED', pausedAt: new Date() },
    });
    await this.audit.log({
      actorUserId: actor.id, action: 'PUTAWAY_PAUSED',
      entityType: 'putaway_session', entityId: sessionId,
    });
    return this.detail(sessionId);
  }

  async resume(sessionId: string, actor: PutawayActor) {
    await this.prisma.putawaySession.update({
      where: { id: sessionId },
      data: { status: 'ACTIVE' },
    });
    await this.audit.log({
      actorUserId: actor.id, action: 'PUTAWAY_RESUMED',
      entityType: 'putaway_session', entityId: sessionId,
    });
    return this.detail(sessionId);
  }

  async complete(sessionId: string, actor: PutawayActor) {
    const session = await this.prisma.putawaySession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Putaway session not found.');
    if (session.status === 'COMPLETED') return this.detail(sessionId);

    await this.prisma.putawaySession.update({
      where: { id: sessionId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await this.audit.log({
      actorUserId: actor.id, action: 'PUTAWAY_COMPLETED',
      entityType: 'putaway_session', entityId: sessionId,
    });
    return this.detail(sessionId);
  }
}
