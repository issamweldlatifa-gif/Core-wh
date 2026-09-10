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
import { PushService } from '../notifications/push.service';

export interface TempActor {
  id: string;
  name?: string | null;
  ip?: string | null;
}

type Db = Prisma.TransactionClient | PrismaService;

const CAPACITY_SETTING_KEY = 'temporary_storage.container_capacity';
const DEFAULT_CAPACITY = 20;
const ADMIN_ROLES = ['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_MANAGER'];

/** Resolved staging move within a station scope (see scopeMoves). */
export interface ScopeMove {
  id: string;
  sku: string | null;
  reference: string | null;
  productName: string | null;
  expectedQuantity: number;
  confirmedQuantity: number;
  result: string;
  acceptedAt: Date | null;
  toStationId: string | null;
  createdAt: Date;
  reportLineId: string | null;
  receivingSessionId: string | null;
  arrival: { id: string; code: string; customerName: string; customerSurname: string | null } | null;
}

export interface SectionContainerShape {
  sectionLetter: string;
  customerName: string;
  status: string;
  currentQuantity: number;
}

/**
 * TEMPORARY STORAGE STATION (Product Flow — Produit + Carte).
 *
 * Routing key = Customer Nom (CRM projection on the SQ/arrival card):
 *   SQ -> Customer Nom -> FIRST LETTER -> Section -> Temporary Container.
 * The worker NEVER types a letter, a section or a container code by hand:
 * scan a product -> the system resolves customer/section/active container ->
 * scan the container -> server-side validation -> placement.
 *
 * Hard rules enforced server-side (final authority):
 *   - Only CONFIRMED verification output (ProductStationMove to STAGING) may
 *     be placed; a move's remaining budget = confirmed - already stored.
 *   - A unit is placed at most once (move budget + scan operationId).
 *   - Wrong container (different section letter / different customer batch)
 *     is rejected with NO movement and NO quantity change.
 *   - A FULL container rejects more units; the system then opens the next
 *     container automatically (capacity is configurable, never hardcoded).
 *   - Cartons NEVER enter this station (explicit CARTON_NOT_ALLOWED reject).
 *   - Unknown / unplaceable products go to the REVIEW lane: REVIEW item +
 *     OperationalException + admin alert (no ordinary-container placement).
 *
 * Event traceability (existing audit mechanism): PRODUCT_STORED_IN_TEMP_
 * CONTAINER, TEMP_SCAN_REJECTED, CONTAINER_FULL, EXCEPTION_CREATED,
 * TEMPORARY_STORAGE_COMPLETED (plus receiving-side CARTON_CLOSED_AT_RECEIVING
 * and TEMPORARY_STORAGE_HANDOFF which already exist).
 */
@Injectable()
export class TemporaryStorageService {
  private readonly logger = new Logger(TemporaryStorageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly push: PushService,
  ) {}

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  private normalize(term?: string | null): string {
    return String(term ?? '').trim().toUpperCase();
  }

  /** Routing letter: first character of the Customer Nom. Non A-Z -> '0'. */
  sectionLetterOf(customerName?: string | null): string {
    const n = String(customerName ?? '').trim();
    if (!n) return '0';
    const first = Array.from(n)[0].toUpperCase();
    return /^[A-Z]$/.test(first) ? first : '0';
  }

  private async capacityOf(db: Db): Promise<number> {
    const row = await db.systemSetting.findUnique({
      where: { key: CAPACITY_SETTING_KEY },
    });
    const raw = Number(row?.value ?? DEFAULT_CAPACITY);
    const v = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_CAPACITY;
    return Math.min(v, 1000);
  }

  private async requireStation(db: Db, workerId: string) {
    const station = await db.station.findFirst({
      where: { assignedWorkerId: workerId, status: 'ACTIVE', department: 'STAGING' },
    });
    if (!station) {
      throw new BadRequestException(
        'No active Temporary Storage station is bound to this worker (STAGING department).',
      );
    }
    return station;
  }

  private termMatches(term: string, value?: string | null): boolean {
    const n = this.normalize(value);
    return n.length > 0 && n === term;
  }

  /**
   * Product moves currently placeable at a station scope: STAGING moves whose
   * latest position is STAGING and which are either unclaimed (acceptedAt
   * null) or already accepted by this station. Includes the arrival card
   * (customer Nom/Prénom) needed for routing.
   */
  private async scopeMoves(db: Db, stationId: string): Promise<ScopeMove[]> {
    const moves = await db.productStationMove.findMany({
      where: { toDepartment: 'STAGING' },
      include: {
        receivingProduct: {
          include: {
            session: {
              include: {
                expectedArrival: { select: { id: true, code: true, customerName: true, customerSurname: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Latest move per report line is the live one (history is append-only).
    const lineIds = [...new Set(moves.map((m) => m.reportLineId).filter((v): v is string => !!v))];
    const latestByLine = new Map<string, string>();
    if (lineIds.length > 0) {
      const latests = await db.productStationMove.findMany({
        where: { reportLineId: { in: lineIds } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, reportLineId: true },
      });
      for (const m of latests) {
        if (m.reportLineId && !latestByLine.has(m.reportLineId)) latestByLine.set(m.reportLineId, m.id);
      }
    }
    return moves
      .filter((m) => !m.reportLineId || latestByLine.get(m.reportLineId) === m.id)
      .filter((m) => m.acceptedAt === null || m.toStationId === stationId)
      .map((m) => ({
        id: m.id,
        sku: m.sku,
        reference: m.reference,
        productName: m.productName,
        expectedQuantity: m.expectedQuantity,
        confirmedQuantity: m.confirmedQuantity,
        result: m.result,
        acceptedAt: m.acceptedAt,
        toStationId: m.toStationId,
        createdAt: m.createdAt,
        reportLineId: m.reportLineId,
        receivingSessionId: m.receivingSessionId,
        arrival: m.receivingProduct?.session?.expectedArrival
          ? {
              id: m.receivingProduct.session.expectedArrival.id,
              code: m.receivingProduct.session.expectedArrival.code,
              customerName: m.receivingProduct.session.expectedArrival.customerName,
              customerSurname: m.receivingProduct.session.expectedArrival.customerSurname ?? null,
            }
          : null,
      }));
  }

  /** Remaining (confirmed - stored) per move id. */
  private async remainingByMove(db: Db, moveIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (moveIds.length === 0) return map;
    const rows = await db.temporaryStorageItem.groupBy({
      by: ['productMoveId'],
      where: { productMoveId: { in: moveIds }, status: 'STORED' },
      _sum: { quantity: true },
    });
    for (const r of rows) {
      if (r.productMoveId) map.set(r.productMoveId, r._sum.quantity ?? 0);
    }
    return map;
  }

  /** True when the scanned code belongs to a known CARTON (never stored here). */
  private async isCartonCode(db: Db, term: string): Promise<boolean> {
    if (!term) return false;
    const found = await db.warehouseCarton.findFirst({
      where: {
        OR: [
          { externalCartonId: { equals: term, mode: 'insensitive' } },
          { cartonReference: { equals: term, mode: 'insensitive' } },
          { qrCodeValue: { equals: term, mode: 'insensitive' } },
          { barcodeValue: { equals: term, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    });
    return !!found;
  }

  private async genExceptionCode(db: Db): Promise<string> {
    const count = await db.operationalException.count();
    const candidate = `EXC-${String(count + 1).padStart(6, '0')}`;
    const exists = await db.operationalException.findUnique({ where: { code: candidate } });
    if (exists) return `EXC-R${Date.now().toString().slice(-6)}`;
    return candidate;
  }

  private async notifyAdmins(kind: 'REVIEW' | 'REPORT', payload: { title: string; body: string; route: string }) {
    try {
      const admins = await this.prisma.user.findMany({
        where: { roles: { some: { role: { name: { in: ADMIN_ROLES } } } } },
        select: { id: true },
      });
      if (admins.length === 0) return 0;
      return await this.push.notifyUsers(
        admins.map((a) => a.id),
        { title: payload.title, body: payload.body, route: payload.route, data: { event: kind } },
      );
    } catch (e) {
      this.logger.warn(`Temporary Storage admin notification failed: ${(e as Error).message}`);
      return 0;
    }
  }

  // ------------------------------------------------------------------
  // WORKER — home / sections (read)
  // ------------------------------------------------------------------

  /**
   * Station home header (MASTER ORDER §9):
   * Active Products (received) / Containers / Completed (stored) / Remaining
   * + CURRENT SECTION (the section holding the active target container).
   */
  async home(workerId: string) {
    const station = await this.requireStation(this.prisma, workerId);
    const moves = await this.scopeMoves(this.prisma, station.id);
    const remainingMap = await this.remainingByMove(
      this.prisma,
      moves.map((m) => m.id),
    );
    const received = moves.reduce((s, m) => s + m.confirmedQuantity, 0);
    const stored = moves.reduce(
      (s, m) => s + (remainingMap.get(m.id) ?? 0),
      0,
    );
    const remaining = received - stored;
    const [containers, reviewItems] = await Promise.all([
      this.prisma.temporaryStorageContainer.findMany({
        where: { stationId: station.id },
        orderBy: [{ sectionLetter: 'asc' }, { code: 'asc' }],
      }),
      this.prisma.temporaryStorageItem.findMany({
        where: { stationId: station.id, status: 'REVIEW' },
        select: { quantity: true },
      }),
    ]);
    const containersUsed = containers.filter((c) => c.currentQuantity > 0 || c.status === 'FULL').length;
    const reviewUnits = reviewItems.reduce((s, r) => s + r.quantity, 0);
    const activeTarget = containers.find((c) => c.status === 'ACTIVE' && c.currentQuantity < c.capacity);
    const active = moves.filter(
      (m) => m.acceptedAt === null || (m.confirmedQuantity - (remainingMap.get(m.id) ?? 0)) > 0,
    );
    const sections = await this.sectionsOf(active, remainingMap, containers);
    return {
      station: { id: station.id, code: station.code, name: station.name, department: station.department },
      header: {
        activeProducts: received,
        containers: containersUsed,
        completed: stored,
        remaining: Math.max(0, remaining - reviewUnits),
        review: reviewUnits,
      },
      currentSection: activeTarget?.sectionLetter ?? null,
      sections,
    };
  }

  /** Sections that REALLY have products (never a static A-Z board). */
  private async sectionsOf(
    moves: ScopeMove[],
    remainingMap: Map<string, number>,
    containers: SectionContainerShape[],
  ) {
    const byLetter = new Map<
      string,
      { letter: string; customers: Map<string, { name: string; received: number; remaining: number }> }
    >();
    for (const m of moves) {
      if (!m.arrival) continue;
      const letter = this.sectionLetterOf(m.arrival.customerName);
      const remaining = m.confirmedQuantity - (remainingMap.get(m.id) ?? 0);
      if (remaining <= 0 && m.acceptedAt !== null) continue; // done, no longer active
      const bucket = byLetter.get(letter) ?? {
        letter,
        customers: new Map<string, { name: string; received: number; remaining: number }>(),
      };
      const cust = bucket.customers.get(m.arrival.customerName) ?? {
        name: m.arrival.customerName,
        received: 0,
        remaining: 0,
      };
      cust.received += m.confirmedQuantity;
      cust.remaining += remaining;
      bucket.customers.set(m.arrival.customerName, cust);
      byLetter.set(letter, bucket);
    }
    // Sections that only have stored containers (work in progress visible).
    for (const c of containers) {
      const bucket = byLetter.get(c.sectionLetter) ?? {
        letter: c.sectionLetter,
        customers: new Map<string, { name: string; received: number; remaining: number }>(),
      };
      if (!bucket.customers.has(c.customerName)) {
        bucket.customers.set(c.customerName, { name: c.customerName, received: 0, remaining: 0 });
      }
      byLetter.set(c.sectionLetter, bucket);
    }
    return [...byLetter.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([letter, bucket]) => ({
        letter,
        products: [...bucket.customers.values()].reduce((s, c) => s + c.received, 0),
        stored: 0, // computed at section level on demand (payload stays light)
        customers: [...bucket.customers.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => ({ customer: c.name, received: c.received, remaining: Math.max(0, c.remaining) })),
      }));
  }

  /** Full section board (MASTER ORDER §11/§12): customer batches + containers. */
  async section(letter: string, workerId: string) {
    const normLetter = this.normalize(letter);
    if (!/^[A-Z0-9]$/.test(normLetter)) throw new BadRequestException('Invalid section letter.');
    const station = await this.requireStation(this.prisma, workerId);
    const moves = (await this.scopeMoves(this.prisma, station.id)).filter(
      (m) => m.arrival && this.sectionLetterOf(m.arrival.customerName) === normLetter,
    );
    const remainingMap = await this.remainingByMove(
      this.prisma,
      moves.map((m) => m.id),
    );
    const containers = await this.prisma.temporaryStorageContainer.findMany({
      where: { stationId: station.id, sectionLetter: normLetter },
      include: { items: { where: { status: 'STORED' }, select: { quantity: true, productMoveId: true } } },
      orderBy: { code: 'asc' },
    });
    const byCustomer = new Map<string, { customer: string; surname: string | null; received: number; remaining: number }>();
    for (const m of moves) {
      if (!m.arrival) continue;
      const cur = byCustomer.get(m.arrival.customerName) ?? {
        customer: m.arrival.customerName,
        surname: m.arrival.customerSurname,
        received: 0,
        remaining: 0,
      };
      cur.received += m.confirmedQuantity;
      cur.remaining += m.confirmedQuantity - (remainingMap.get(m.id) ?? 0);
      byCustomer.set(m.arrival.customerName, cur);
    }
    const reviewItems = await this.prisma.temporaryStorageItem.findMany({
      where: { stationId: station.id, sectionLetter: normLetter, status: 'REVIEW' },
      orderBy: { scannedAt: 'desc' },
      take: 100,
    });
    const activeContainerIds = new Set<string>();
    for (const c of containers) {
      if (c.status === 'ACTIVE' && c.currentQuantity < c.capacity) activeContainerIds.add(c.id);
    }
    const customers = [...byCustomer.values()].map((c) => {
      const custContainers = containers.filter((k) => this.normalize(k.customerName) === this.normalize(c.customer));
      return {
        ...c,
        remaining: Math.max(0, c.remaining),
        stored: custContainers.reduce(
          (s, k) => s + k.items.reduce((x, i) => x + i.quantity, 0),
          0,
        ),
        containers: custContainers.map((k) => ({
          code: k.code,
          current: k.currentQuantity,
          capacity: k.capacity,
          status: k.status,
          active: activeContainerIds.has(k.id),
        })),
        hasReview: reviewItems.some((r) => this.normalize(r.customerName) === this.normalize(c.customer)),
      };
    });
    return {
      station: { id: station.id, code: station.code, name: station.name },
      letter: normLetter,
      reviewItems: reviewItems.map((r) => ({
        id: r.id,
        sku: r.sku,
        reference: r.reference,
        productName: r.productName,
        customerName: r.customerName,
        reason: r.reviewReason,
        scannedAt: r.scannedAt,
        scannedBy: r.scannedBy,
      })),
      customers: customers.sort((a, b) => a.customer.localeCompare(b.customer)),
    };
  }

  // ------------------------------------------------------------------
  // WORKER — scanning
  // ------------------------------------------------------------------

  /**
   * Scan a product: system identifies product -> customer -> section ->
   * target container (advisory, non-mutating except audit). The FINAL
   * validation happens on /place.
   */
  async scanProduct(input: { operationId: string; code: string }, actor: TempActor, device?: { deviceType?: string | null; deviceName?: string | null }) {
    const station = await this.requireStation(this.prisma, actor.id);
    const term = this.normalize(input.code);
    if (!term) throw new BadRequestException('Scan code is required.');

    const moves = await this.scopeMoves(this.prisma, station.id);
    const remainingMap = await this.remainingByMove(
      this.prisma,
      moves.map((m) => m.id),
    );
    const placeable = moves.filter((m) => (m.confirmedQuantity - (remainingMap.get(m.id) ?? 0)) > 0);
    const match = placeable.find((m) =>
      this.termMatches(term, m.sku) || this.termMatches(term, m.reference) || this.termMatches(term, m.productName),
    );

    if (!match) {
      // Not a confirmed/placeable unit: is it a carton? -> explicit reject.
      if (await this.isCartonCode(this.prisma, term)) {
        await this.audit.log({
          actorUserId: actor.id,
          action: 'TEMP_SCAN_REJECTED',
          entityType: 'warehouse_carton',
          entityId: null,
          ipAddress: actor.ip ?? null,
          metadata: { code: term, reason: 'CARTON_NOT_ALLOWED', station: station.code },
        });
        return { status: 'CARTON_NOT_ALLOWED' as const, message: 'Cartons end at Receiving and never enter Temporary Storage.' };
      }
      const already = moves.find(
        (m) => this.termMatches(term, m.sku) || this.termMatches(term, m.reference) || this.termMatches(term, m.productName),
      );
      if (already && (remainingMap.get(already.id) ?? 0) >= already.confirmedQuantity) {
        return { status: 'ALREADY_STORED' as const, message: 'All confirmed units of this product are already stored.' };
      }
      await this.audit.log({
        actorUserId: actor.id,
        action: 'TEMP_SCAN_REJECTED',
        entityType: 'product_station_move',
        entityId: null,
        ipAddress: actor.ip ?? null,
        metadata: { code: term, reason: 'NOT_A_PLACEABLE_UNIT', station: station.code },
      });
      return {
        status: 'PRODUCT_NOT_FOUND' as const,
        message: 'No confirmed product matches this code. Scan the product then the container to send it to Review.',
      };
    }

    const customerName = match.arrival?.customerName ?? '';
    const letter = this.sectionLetterOf(customerName);
    const containers = await this.prisma.temporaryStorageContainer.findMany({
      where: { stationId: station.id, sectionLetter: letter, status: { in: ['ACTIVE', 'EMPTY', 'FULL'] } },
      orderBy: { code: 'asc' },
    });
    const own = containers.filter((c) => this.normalize(c.customerName) === this.normalize(customerName));
    const target =
      own.find((c) => c.status === 'ACTIVE' && c.currentQuantity < c.capacity) ??
      own.find((c) => c.status === 'EMPTY') ??
      null;
    const nextCode = target ? null : await this.nextContainerCode(station.id, letter);
    return {
      status: 'VALID' as const,
      product: {
        sku: match.sku,
        reference: match.reference,
        productName: match.productName,
        customer: customerName,
        surname: match.arrival?.customerSurname ?? null,
        section: letter,
      },
      remaining: match.confirmedQuantity - (remainingMap.get(match.id) ?? 0),
      targetContainer: target
        ? { code: target.code, current: target.currentQuantity, capacity: target.capacity, status: target.status, mustCreate: false }
        : { code: nextCode, current: 0, capacity: await this.capacityOf(this.prisma), status: 'EMPTY', mustCreate: true },
      receivedAtStation: null,
    };
  }

  private async nextContainerCode(stationId: string, letter: string): Promise<string> {
    const existing = await this.prisma.temporaryStorageContainer.findMany({
      where: { stationId, sectionLetter: letter },
      select: { code: true },
    });
    let maxNum = 0;
    for (const c of existing) {
      const num = Number(c.code.replace(new RegExp(`^${letter}`), ''));
      if (Number.isFinite(num) && num > maxNum) maxNum = num;
    }
    return `${letter}${maxNum + 1}`;
  }

  // ------------------------------------------------------------------
  // WORKER — placement (final server-side validation)
  // ------------------------------------------------------------------

  async place(
    input: { operationId: string; code: string; containerCode: string },
    actor: TempActor,
    device?: { deviceType?: string | null; deviceName?: string | null },
  ) {
    const term = this.normalize(input.code);
    const containerTerm = this.normalize(input.containerCode);
    if (!term) throw new BadRequestException('Product scan code is required.');
    if (!containerTerm) throw new BadRequestException('Container code is required.');
    const station = await this.requireStation(this.prisma, actor.id);

    // Carton attempt: never stored, never recorded as movement.
    if (await this.isCartonCode(this.prisma, term)) {
      await this.audit.log({
        actorUserId: actor.id,
        action: 'TEMP_SCAN_REJECTED',
        entityType: 'warehouse_carton',
        entityId: null,
        ipAddress: actor.ip ?? null,
        metadata: { code: term, reason: 'CARTON_NOT_ALLOWED', station: station.code },
      });
      return { status: 'CARTON_NOT_ALLOWED' as const, message: 'Cartons never enter Temporary Storage.' };
    }

    const moves = await this.scopeMoves(this.prisma, station.id);
    const remainingMap = await this.remainingByMove(
      this.prisma,
      moves.map((m) => m.id),
    );
    const placeable = moves.filter((m) => (m.confirmedQuantity - (remainingMap.get(m.id) ?? 0)) > 0);
    const match = placeable.find((m) =>
      this.termMatches(term, m.sku) || this.termMatches(term, m.reference) || this.termMatches(term, m.productName),
    );

    // No placeable confirmed unit -> REVIEW lane (exception + admin alert).
    if (!match) {
      const elsewhere = moves.filter(
        (m) =>
          this.termMatches(term, m.sku) || this.termMatches(term, m.reference) || this.termMatches(term, m.productName),
      );
      const movedElsewhere = elsewhere.some(
        (m) => m.acceptedAt !== null && m.toStationId !== station.id && (m.confirmedQuantity - (remainingMap.get(m.id) ?? 0)) > 0,
      );
      if (movedElsewhere) {
        return { status: 'AT_OTHER_STATION' as const, message: 'This product is being stored at another Temporary Storage station.' };
      }
      // Everything confirmed for this code is already stored (anti-duplicate):
      if (elsewhere.length > 0 && elsewhere.every((m) => (remainingMap.get(m.id) ?? 0) >= m.confirmedQuantity)) {
        await this.audit.log({
          actorUserId: actor.id,
          action: 'TEMP_SCAN_REJECTED',
          entityType: 'product_station_move',
          entityId: elsewhere[0].id,
          ipAddress: actor.ip ?? null,
          metadata: { code: term, reason: 'ALREADY_STORED', station: station.code },
        });
        return { status: 'ALREADY_STORED' as const, message: 'All confirmed units of this product are already stored here.' };
      }
      return this.sendToReview({ ...input, reason: 'Not a confirmed placeable unit.' }, actor, device, station);
    }

    const customerName = match.arrival?.customerName ?? '';
    const letter = this.sectionLetterOf(customerName);

    return this.prisma.$transaction(async (tx) => {
      // Idempotent replay of the exact same physical scan.
      const existingOp = await tx.temporaryStorageItem.findUnique({
        where: { operationId: input.operationId },
      });
      if (existingOp) {
        return this.replay(existingOp, match, station);
      }
      // Station re-check inside the transaction.
      const lockStation = await tx.station.findUnique({
        where: { id: station.id, assignedWorkerId: actor.id, status: 'ACTIVE', department: 'STAGING' },
      });
      if (!lockStation) throw new BadRequestException('Station is no longer active for this worker.');

      // Claim/confirm the move for this station atomically (race-safe).
      const claim = await tx.productStationMove.updateMany({
        where: {
          id: match.id,
          toDepartment: 'STAGING',
          OR: [{ acceptedAt: null }, { toStationId: station.id }],
        },
        data: { toStationId: station.id, acceptedAt: new Date() },
      });
      if (claim.count === 0) {
        throw new ConflictException('This product was accepted by another Temporary Storage station.');
      }

      // Container resolution: existing (must match section letter + customer
      // batch) or auto-created when the system suggested a fresh code.
      let container = await tx.temporaryStorageContainer.findFirst({
        where: { stationId: station.id, code: containerTerm },
      });
      if (!container) {
        const suggested = await this.nextContainerCode(station.id, letter);
        if (containerTerm !== suggested) {
          throw new BadRequestException(`Container ${containerTerm} does not exist here. Expected ${suggested}.`);
        }
        try {
          container = await tx.temporaryStorageContainer.create({
            data: {
              code: containerTerm,
              stationId: station.id,
              sectionLetter: letter,
              customerName,
              capacity: await this.capacityOf(tx),
              status: 'EMPTY',
              openedBy: actor.id,
            },
          });
        } catch (e: any) {
          if (e?.code === 'P2002') {
            container = await tx.temporaryStorageContainer.findFirst({
              where: { stationId: station.id, code: containerTerm },
            });
          } else throw e;
        }
      }
      if (!container) throw new ConflictException('Could not resolve the target container.');

      if (this.normalize(container.sectionLetter) !== letter || this.normalize(container.customerName) !== this.normalize(customerName)) {
        await this.audit.log(
          {
            actorUserId: actor.id,
            action: 'TEMP_SCAN_REJECTED',
            entityType: 'temporary_storage_container',
            entityId: container.id,
            ipAddress: actor.ip ?? null,
            metadata: {
              code: term,
              reason: 'WRONG_CONTAINER',
              expectedSection: letter,
              scannedSection: container.sectionLetter,
              scannedContainer: container.code,
              station: station.code,
            },
          },
          tx,
        );
        return {
          status: 'WRONG_CONTAINER' as const,
          message: `Product ${customerName} belongs to section ${letter}.`,
          expected: { section: letter, containerCode: await this.nextContainerCode(station.id, letter) },
        };
      }
      if (container.status === 'FULL') {
        await this.audit.log(
          {
            actorUserId: actor.id,
            action: 'TEMP_SCAN_REJECTED',
            entityType: 'temporary_storage_container',
            entityId: container.id,
            ipAddress: actor.ip ?? null,
            metadata: { code: term, reason: 'CONTAINER_FULL', container: container.code, station: station.code },
          },
          tx,
        );
        const next = await this.nextContainerCode(station.id, letter);
        return {
          status: 'WRONG_CONTAINER' as const,
          message: `Container ${container.code} is FULL.`,
          expected: { section: letter, containerCode: next },
        };
      }

      // Capacity-safe increment (guarded inside the tx).
      const inc = await tx.temporaryStorageContainer.updateMany({
        where: { id: container.id, status: { not: 'FULL' }, currentQuantity: { lt: container.capacity } },
        data: { currentQuantity: { increment: 1 }, status: 'ACTIVE' },
      });
      if (inc.count === 0) {
        throw new ConflictException('Container just became FULL — scan the product again for the next container.');
      }
      const item = await tx.temporaryStorageItem.create({
        data: {
          operationId: input.operationId,
          stationId: station.id,
          containerId: container.id,
          productMoveId: match.id,
          sku: match.sku,
          reference: match.reference,
          productName: match.productName,
          customerName,
          sectionLetter: letter,
          quantity: 1,
          status: 'STORED',
          scannedBy: actor.id,
          deviceType: device?.deviceType ?? null,
          deviceName: device?.deviceName ?? null,
        },
      });
      // ---- bridge into Sorting -> Packing -> Shipping --------------------
      // The placed unit becomes a real ArticleUnit (one row per physical
      // unit, the unit of account of the downstream operations). Category is
      // copied from the product master when it is known; otherwise the unit
      // stays NEEDS_REVIEW instead of inventing a classification.
      const master = match.sku
        ? await tx.product.findFirst({
            where: { externalProductCode: { equals: match.sku.trim(), mode: 'insensitive' } },
            select: { name: true, productType: true },
          })
        : null;
      const article = await tx.articleUnit.create({
        data: {
          code: await this.genArticleCode(tx),
          sku: match.sku ?? term,
          productName: match.productName ?? master?.name ?? null,
          category: master?.productType ?? null,
          categoryStatus: master?.productType ? 'CONFIRMED' : 'NEEDS_REVIEW',
          status: 'IN_CONTAINER',
          receivingSessionId: match.receivingSessionId ?? null,
        },
      });
      await tx.temporaryStorageItem.update({
        where: { id: item.id },
        data: { articleUnitId: article.id },
      });
      const refreshed = await tx.temporaryStorageContainer.findUnique({ where: { id: container.id } });
      const nowQty = refreshed?.currentQuantity ?? 1;
      let nextTarget: { code: string; current: number; capacity: number; status: string } | null = null;
      if (nowQty >= (refreshed?.capacity ?? 0)) {
        await tx.temporaryStorageContainer.update({
          where: { id: container.id },
          data: { status: 'FULL', closedAt: new Date(), closedBy: actor.id },
        });
        await this.audit.log(
          {
            actorUserId: actor.id,
            action: 'CONTAINER_FULL',
            entityType: 'temporary_storage_container',
            entityId: container.id,
            ipAddress: actor.ip ?? null,
            metadata: { code: container.code, capacity: refreshed?.capacity, station: station.code },
          },
          tx,
        );
        const remainingAfter = (await this.remainingAfter(tx, match.id)) - 1;
        if (remainingAfter > 0) {
          const cap = await this.capacityOf(tx);
          const nxt = await tx.temporaryStorageContainer.create({
            data: {
              code: await this.nextContainerCode(station.id, letter),
              stationId: station.id,
              sectionLetter: letter,
              customerName,
              capacity: cap,
              status: 'EMPTY',
              openedBy: actor.id,
            },
          });
          nextTarget = { code: nxt.code, current: 0, capacity: nxt.capacity, status: 'EMPTY' };
        }
      }
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'PRODUCT_STORED_IN_TEMP_CONTAINER',
          entityType: 'temporary_storage_item',
          entityId: item.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            sku: match.sku,
            container: container.code,
            section: letter,
            customer: customerName,
            moveId: match.id,
            station: station.code,
          },
        },
        tx,
      );
      return {
        status: 'VALID' as const,
        itemId: item.id,
        // The physical unit now exists downstream: this is the code the
        // SORTING agent scans at the next operation.
        article: { id: article.id, code: article.code, status: article.status },
        product: { sku: match.sku, reference: match.reference, productName: match.productName, customer: customerName, section: letter },
        container: { code: container.code, current: nowQty, capacity: refreshed?.capacity ?? 0, status: nowQty >= (refreshed?.capacity ?? 0) ? 'FULL' : 'ACTIVE' },
        remaining: Math.max(0, (await this.remainingAfter(tx, match.id))),
        nextTarget,
      };
    });
  }

  /**
   * Materialize the REAL ArticleUnit for a unit the storage agent just put
   * away. Without this row the reference chain stops at Temporary Storage:
   * the sorting / packing / shipping operations work on ArticleUnits, so the
   * placement must produce one (SKU + provenance) inside the same
   * transaction as the placement ledger row.
   */
  private async genArticleCode(tx: Db): Promise<string> {
    for (let i = 0; i < 5; i += 1) {
      const count = await tx.articleUnit.count();
      const code = `ART-${String(count + 1 + i).padStart(8, '0')}`;
      if (!(await tx.articleUnit.findUnique({ where: { code } }))) return code;
    }
    return `ART-R${Date.now().toString().slice(-8)}`;
  }

  private async remainingAfter(tx: Db, moveId: string): Promise<number> {
    const move = await tx.productStationMove.findUnique({
      where: { id: moveId },
      select: { confirmedQuantity: true },
    });
    if (!move) return 0;
    const aggr = await tx.temporaryStorageItem.aggregate({
      where: { productMoveId: moveId, status: 'STORED' },
      _sum: { quantity: true },
    });
    return move.confirmedQuantity - (aggr._sum.quantity ?? 0);
  }

  /** Deterministic no-op answer for an already-processed scan (idempotency). */
  private async replay(
    item: {
      id: string;
      status: string;
      containerId: string | null;
      reviewReason: string | null;
      articleUnitId?: string | null;
    },
    match: { sku: string | null; reference: string | null; productName: string | null },
    station: { code: string },
  ) {
    if (item.status === 'REVIEW') {
      return {
        status: 'ALREADY_IN_REVIEW' as const,
        message: 'This scan was already sent to Review.',
        review: { itemId: item.id, reason: item.reviewReason },
      };
    }
    const article = item.articleUnitId
      ? await this.prisma.articleUnit.findUnique({
          where: { id: item.articleUnitId },
          select: { id: true, code: true, status: true },
        })
      : null;
    return {
      status: 'VALID' as const,
      alreadyStored: true,
      message: 'This scan was already stored.',
      itemId: item.id,
      article,
      product: { sku: match.sku, reference: match.reference, productName: match.productName },
    };
  }

  /**
   * Review lane: product cannot be stored (unknown / unconfirmed / damaged /
   * workflow problem). Creates the REVIEW row + OperationalException and
   * alerts admins. The section stays flagged until the exception is handled.
   */
  async sendToReview(
    input: { operationId: string; code: string; reason?: string | null; toReview?: boolean | null },
    actor: TempActor,
    device?: { deviceType?: string | null; deviceName?: string | null },
    station?: { id: string; code: string },
  ) {
    const stationResolved = station ?? (await this.requireStation(this.prisma, actor.id));
    const st = { id: stationResolved.id, code: stationResolved.code };
    return this.prisma.$transaction(async (tx) => {
      const existingOp = await tx.temporaryStorageItem.findUnique({ where: { operationId: input.operationId } });
      if (existingOp) {
        if (existingOp.status === 'STORED') {
          return {
            status: 'VALID' as const,
            alreadyStored: true,
            message: 'This scan was already stored.',
            itemId: existingOp.id,
          };
        }
        return {
          status: 'ALREADY_IN_REVIEW' as const,
          message: 'This scan was already processed.',
          review: { itemId: existingOp.id, reason: existingOp.reviewReason ?? null },
        };
      }
      // Best-effort identity snapshot: resolved from placeable history even
      // when nothing is left to place (e.g. scan of an exhausted line).
      const term = this.normalize(input.code);
      const known = await tx.productStationMove.findFirst({
        where: { toDepartment: 'STAGING', OR: [{ sku: { equals: term, mode: 'insensitive' } }, { reference: { equals: term, mode: 'insensitive' } }, { productName: { equals: term, mode: 'insensitive' } }] },
        include: { receivingProduct: { include: { session: { include: { expectedArrival: { select: { customerName: true, code: true } } } } } } },
        orderBy: { createdAt: 'desc' },
      });
      const customerName = known?.receivingProduct?.session?.expectedArrival?.customerName ?? null;
      const arrivalCode = known?.receivingProduct?.session?.expectedArrival?.code ?? null;
      const letter = customerName ? this.sectionLetterOf(customerName) : null;
      const reason = input.reason ?? 'Product cannot be placed in an ordinary container (see Review lane).';
      const item = await tx.temporaryStorageItem.create({
        data: {
          operationId: input.operationId,
          stationId: st.id,
          productMoveId: known?.id ?? null,
          sku: known?.sku ?? null,
          reference: known?.reference ?? null,
          productName: known?.productName ?? null,
          customerName,
          sectionLetter: letter,
          quantity: 1,
          status: 'REVIEW',
          reviewReason: reason,
          scannedBy: actor.id,
          deviceType: device?.deviceType ?? null,
          deviceName: device?.deviceName ?? null,
        },
      });
      const code = await this.genExceptionCode(tx);
      const exception = await tx.operationalException.create({
        data: {
          code,
          type: 'TEMPORARY_STORAGE_REVIEW',
          status: 'OPEN',
          entityType: known ? 'receiving_session' : 'other',
          entityId: known?.receivingSessionId ?? null,
          entityCode: arrivalCode,
          reason: `Temporary Storage review: ${reason}`,
          reportedById: actor.id,
          stationId: st.id,
        },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'EXCEPTION_CREATED',
          entityType: 'temporary_storage_item',
          entityId: item.id,
          ipAddress: actor.ip ?? null,
          metadata: { exception: code, sku: item.sku, customer: customerName, station: st.code },
        },
        tx,
      );
      return {
        status: 'REVIEW' as const,
        review: { itemId: item.id, exceptionCode: code, reason },
        message: 'Product sent to the Review lane. An exception was created for the admin.',
      };
    }).then(async (res) => {
      if (res.status === 'REVIEW') {
        const n = await this.notifyAdmins('REVIEW', {
          title: 'Temporary Storage — Review item',
          body: `EXC ${(res.review as { exceptionCode: string }).exceptionCode}: a product could not be stored at ${st.code}.`,
          route: '/admin/exceptions',
        });
        return { ...res, notifiedAdmins: n };
      }
      return res;
    });
  }

  // ------------------------------------------------------------------
  // WORKER — Rapport de Fin
  // ------------------------------------------------------------------

  async submitReport(input: { observation?: string | null }, actor: TempActor, device?: { deviceType?: string | null; deviceName?: string | null }) {
    const station = await this.requireStation(this.prisma, actor.id);
    const now = new Date();
    const previous = await this.prisma.temporaryStorageReport.findFirst({
      where: { stationId: station.id },
      orderBy: { finishedAt: 'desc' },
    });
    const windowStart = previous?.finishedAt ?? null;

    return this.prisma.$transaction(async (tx) => {
      const items = await tx.temporaryStorageItem.findMany({
        where: {
          stationId: station.id,
          ...(windowStart ? { scannedAt: { gt: windowStart } } : {}),
        },
        include: { container: { select: { code: true, sectionLetter: true } } },
        orderBy: { scannedAt: 'asc' },
      });
      const storedItems = items.filter((i) => i.status === 'STORED');
      const reviewItems = items.filter((i) => i.status === 'REVIEW');
      const containersUsed = new Set(storedItems.map((i) => i.containerId).filter((v): v is string => !!v)).size;
      const bySection = new Map<string, { letter: string; customerName: string; stored: number }>();
      for (const i of storedItems) {
        const letter = i.sectionLetter ?? i.container?.sectionLetter ?? '0';
        const key = `${letter}|${i.customerName ?? '?'}`;
        const cur = bySection.get(key) ?? { letter, customerName: i.customerName ?? '?', stored: 0 };
        cur.stored += i.quantity;
        bySection.set(key, cur);
      }
      const sectionsProcessed = [...bySection.values()]
        .sort((a, b) => a.letter.localeCompare(b.letter))
        .map((s) => ({ letter: s.letter, customer: s.customerName, stored: s.stored }));

      // Products received in the window = confirmed units of moves accepted
      // at this station during the window.
      const acceptedMoves = await tx.productStationMove.findMany({
        where: {
          toStationId: station.id,
          acceptedAt: { not: null },
          ...(windowStart ? { acceptedAt: { gt: windowStart } } : {}),
        },
        select: { confirmedQuantity: true, id: true },
      });
      const productsReceived = acceptedMoves.reduce((s, m) => s + m.confirmedQuantity, 0);
      const exceptions = await tx.operationalException.count({
        where: { stationId: station.id, createdAt: { gt: windowStart ?? new Date(0) } },
      });

      const report = await tx.temporaryStorageReport.create({
        data: {
          stationId: station.id,
          stationCode: station.code,
          workerId: actor.id,
          workerName: actor.name ?? null,
          deviceType: device?.deviceType ?? null,
          deviceName: device?.deviceName ?? null,
          status: 'SUBMITTED',
          observation: input.observation ?? null,
          startedAt: windowStart,
          finishedAt: now,
          sectionsProcessed: sectionsProcessed as Prisma.InputJsonValue,
          containersUsed,
          productsReceived,
          productsStored: storedItems.reduce((s, i) => s + i.quantity, 0),
          productsInReview: reviewItems.reduce((s, i) => s + i.quantity, 0),
          exceptions,
          submittedBy: actor.id,
          submittedAt: now,
        },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'TEMPORARY_STORAGE_COMPLETED',
          entityType: 'temporary_storage_report',
          entityId: report.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            station: station.code,
            sections: sectionsProcessed.length,
            containers: containersUsed,
            stored: report.productsStored,
            review: report.productsInReview,
          },
        },
        tx,
      );
      return {
        id: report.id,
        stationCode: station.code,
        status: report.status,
        totals: {
          productsReceived: report.productsReceived,
          productsStored: report.productsStored,
          productsInReview: report.productsInReview,
          containersUsed: report.containersUsed,
          exceptions: report.exceptions,
          sectionsProcessed: sectionsProcessed.length,
        },
        finishedAt: report.finishedAt,
        observation: report.observation,
      };
    }).then(async (report) => {
      const n = await this.notifyAdmins('REPORT', {
        title: 'Temporary Storage — Rapport de Fin',
        body: `${report.stationCode}: stored ${report.totals.productsStored}/${report.totals.productsReceived}, review ${report.totals.productsInReview}.`,
        route: '/admin/temporary-storage',
      });
      return { ...report, notifiedAdmins: n };
    });
  }

  // ------------------------------------------------------------------
  // CONFIG (admin) — capacity is configuration, never hardcoded
  // ------------------------------------------------------------------

  async setCapacity(capacity: number, actor: TempActor) {
    const v = Math.min(1000, Math.max(1, Math.floor(capacity)));
    await this.prisma.systemSetting.upsert({
      where: { key: CAPACITY_SETTING_KEY },
      create: { key: CAPACITY_SETTING_KEY, value: String(v) },
      update: { value: String(v) },
    });
    await this.audit.log({
      actorUserId: actor.id,
      action: 'SETTINGS_UPDATED',
      entityType: 'system_setting',
      entityId: CAPACITY_SETTING_KEY,
      ipAddress: actor.ip ?? null,
      metadata: { key: CAPACITY_SETTING_KEY, value: v },
    });
    return { capacity: v };
  }

  async getConfig() {
    return { capacity: await this.capacityOf(this.prisma) };
  }

  // ------------------------------------------------------------------
  // ADMIN — overview + reports
  // ------------------------------------------------------------------

  async overview() {
    const [containers, stations, openMoves, reviewItems] = await Promise.all([
      this.prisma.temporaryStorageContainer.findMany({
        include: { items: { where: { status: 'STORED' }, select: { quantity: true } } },
        orderBy: [{ stationId: 'asc' }, { code: 'asc' }],
      }),
      this.prisma.station.findMany({ where: { department: 'STAGING' }, select: { id: true, code: true, name: true, status: true } }),
      this.prisma.productStationMove.count({ where: { toDepartment: 'STAGING', acceptedAt: null } }),
      this.prisma.temporaryStorageItem.findMany({
        where: { status: 'REVIEW' },
        orderBy: { scannedAt: 'desc' },
        take: 200,
        include: { productMove: { select: { receivingSessionId: true } } },
      }),
    ]);
    const perStation = stations.map((s) => {
      const c = containers.filter((k) => k.stationId === s.id);
      const stored = c.reduce((sum, k) => sum + k.items.reduce((x, i) => x + i.quantity, 0), 0);
      const capacity = c.reduce((sum, k) => sum + k.capacity, 0);
      const review = reviewItems.filter((r) => r.stationId === s.id).length;
      return {
        station: { id: s.id, code: s.code, name: s.name, status: s.status },
        sections: [...new Set(c.map((k) => k.sectionLetter))].sort(),
        containers: c.length,
        stored,
        capacity,
        remaining: Math.max(0, capacity - stored),
        reviewItems: review,
      };
    });
    return {
      stations: perStation,
      openMovesWaiting: openMoves,
      reviewItems: reviewItems.map((r) => ({
        id: r.id,
        sku: r.sku,
        reference: r.reference,
        productName: r.productName,
        customerName: r.customerName,
        section: r.sectionLetter,
        reason: r.reviewReason,
        scannedAt: r.scannedAt,
        scannedBy: r.scannedBy,
      })),
      capacity: await this.capacityOf(this.prisma),
    };
  }

  async listReports(filter: { status?: string }) {
    const where: Prisma.TemporaryStorageReportWhereInput = {};
    if (filter.status && ['SUBMITTED', 'REVIEWED', 'CLOSED'].includes(filter.status)) {
      where.status = filter.status as never;
    }
    const rows = await this.prisma.temporaryStorageReport.findMany({
      where,
      orderBy: [{ finishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      stationCode: r.stationCode,
      stationId: r.stationId,
      workerName: r.workerName,
      status: r.status,
      totals: {
        productsReceived: r.productsReceived,
        productsStored: r.productsStored,
        productsInReview: r.productsInReview,
        containersUsed: r.containersUsed,
        exceptions: r.exceptions,
      },
      finishedAt: r.finishedAt,
      submittedAt: r.submittedAt,
      reviewedAt: r.reviewedAt,
      closedAt: r.closedAt,
    }));
  }

  async reportDetail(reportId: string) {
    const r = await this.prisma.temporaryStorageReport.findUnique({ where: { id: reportId } });
    if (!r) throw new NotFoundException('Temporary Storage report not found.');
    return {
      id: r.id,
      stationCode: r.stationCode,
      stationId: r.stationId,
      workerName: r.workerName,
      deviceType: r.deviceType,
      deviceName: r.deviceName,
      status: r.status,
      observation: r.observation,
      sectionsProcessed: r.sectionsProcessed,
      totals: {
        productsReceived: r.productsReceived,
        productsStored: r.productsStored,
        productsInReview: r.productsInReview,
        containersUsed: r.containersUsed,
        exceptions: r.exceptions,
      },
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      submittedAt: r.submittedAt,
      submittedBy: r.submittedBy,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt,
      reviewNote: r.reviewNote,
      closedBy: r.closedBy,
      closedAt: r.closedAt,
    };
  }

  async reviewReport(reportId: string, note: string | undefined, actor: TempActor) {
    const report = await this.prisma.temporaryStorageReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Temporary Storage report not found.');
    if (report.status !== 'SUBMITTED') throw new ConflictException(`Only a SUBMITTED report can be reviewed (now ${report.status}).`);
    await this.prisma.$transaction(async (tx) => {
      await tx.temporaryStorageReport.update({
        where: { id: reportId },
        data: { status: 'REVIEWED', reviewedBy: actor.id, reviewedAt: new Date(), reviewNote: note ?? null },
      });
      await this.audit.log(
        { actorUserId: actor.id, action: 'REPORT_REVIEWED', entityType: 'temporary_storage_report', entityId: reportId, metadata: { note: note ?? null } },
        tx,
      );
    });
    return this.reportDetail(reportId);
  }

  async closeReport(reportId: string, actor: TempActor) {
    const report = await this.prisma.temporaryStorageReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Temporary Storage report not found.');
    if (report.status !== 'SUBMITTED' && report.status !== 'REVIEWED') {
      throw new ConflictException(`Only a SUBMITTED/REVIEWED report can be closed (now ${report.status}).`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.temporaryStorageReport.update({
        where: { id: reportId },
        data: { status: 'CLOSED', closedBy: actor.id, closedAt: new Date() },
      });
      await this.audit.log(
        { actorUserId: actor.id, action: 'REPORT_CLOSED', entityType: 'temporary_storage_report', entityId: reportId },
        tx,
      );
    });
    return this.reportDetail(reportId);
  }
}
