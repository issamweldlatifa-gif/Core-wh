import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const RCV_PREFIX = 'RCV-';
const RCV_START = 200;

export interface ReceivingActor {
  id: string;
  name?: string;
  // role-derived capability flag (resolve via permissions guard upstream).
  canResolveDiscrepancy?: boolean;
  ip?: string | null;
}

/** Input device that produced a scan. The workflow is identical; this only
 * records where the value came from (device support layer). */
export type ScanSource = 'CAMERA' | 'EXTERNAL_SCANNER' | 'MANUAL';

export interface StartOpts {
  deviceType?: string | null;
  deviceName?: string | null;
  scanSource?: string | null;
}

/**
 * Receiving — physically confirm that the cartons/units EXPECTED (from the
 * Customer Arrival Card + Shipment Card) actually arrived.
 *
 * Critical integrity rule: expected data is IMMUTABLE here. Receiving writes
 * its own observation rows (ReceivingSession/Carton/Product/Discrepancy) and
 * never overwrites expected quantities. Carton-first: a session scans cartons,
 * then product lines are reconciled against the Expected Arrival items.
 */
@Injectable()
export class ReceivingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------- helpers ----------
  private async genCode(tx: Prisma.TransactionClient) {
    for (let i = 0; i < 5; i += 1) {
      const count = await tx.receivingSession.count();
      const code = `${RCV_PREFIX}${String(RCV_START + count + 1).padStart(6, '0')}`;
      if (!(await tx.receivingSession.findUnique({ where: { code } }))) return code;
    }
    return `${RCV_PREFIX}R${Date.now().toString().slice(-6)}`;
  }

  // ---------- start ----------
  async start(arrivalIdOrCode: string, actor: ReceivingActor, opts: StartOpts = {}) {
    const arrival = await this.prisma.expectedArrival.findFirst({
      where: { OR: [{ id: arrivalIdOrCode }, { code: arrivalIdOrCode }] },
      include: {
        items: true,
        shipments: { where: {}, include: { cartons: true } },
      },
    });
    if (!arrival) throw new NotFoundException('Expected arrival not found.');
    if (arrival.status === 'RECEIVED' || arrival.status === 'RECEIVED_WITH_DISCREPANCY') {
      throw new ConflictException('This arrival is already received.');
    }

    // 1 active (RECEIVING/PAUSED) session per arrival.
    const active = await this.prisma.receivingSession.findFirst({
      where: { arrivalId: arrival.id, status: { in: ['RECEIVING', 'PAUSED'] } },
    });
    if (active) return this.sessionDetail(active.id);

    const primaryShipment = arrival.shipments[0] ?? null;
    return this.prisma.$transaction(async (tx) => {
      const code = await this.genCode(tx);
      const session = await tx.receivingSession.create({
        data: {
          code,
          arrivalId: arrival.id,
          shipmentId: primaryShipment?.id ?? null,
          status: 'RECEIVING',
          startedBy: actor.id,
          startedAt: new Date(),
          deviceType: opts.deviceType ?? null,
          deviceName: opts.deviceName ?? null,
          scanSource: opts.scanSource ?? null,
        },
      });
      // Seed the expected product reconciliation rows from the Expected Arrival items.
      const lines: Record<string, { qty: number; name: string; ref: string | null; itemId: string }> = {};
      for (const it of arrival.items) {
        const key = it.sku || it.reference || '';
        if (!key) {
          // Product line has no usable SKU/reference -> needs review.
          await tx.receivingProduct.create({
            data: {
              receivingSessionId: session.id, arrivalItemId: it.id, sku: null, reference: it.reference,
              productName: it.productName, expectedQuantity: it.quantity, receivedQuantity: 0,
              difference: -it.quantity, status: 'NEEDS_REVIEW',
            },
          });
          continue;
        }
        const norm = key.trim();
        if (!lines[norm]) lines[norm] = { qty: 0, name: it.productName || '', ref: it.reference, itemId: it.id };
        lines[norm].qty += it.quantity;
      }
      for (const [sku, agg] of Object.entries(lines)) {
        await tx.receivingProduct.create({
          data: {
            receivingSessionId: session.id, arrivalItemId: agg.itemId, sku, reference: agg.ref,
            productName: agg.name, expectedQuantity: agg.qty, receivedQuantity: 0,
            difference: -agg.qty, status: 'EXPECTED',
          },
        });
      }
      await tx.expectedArrival.update({ where: { id: arrival.id }, data: { status: 'RECEIVING' } });
      await this.audit.log({
        actorUserId: actor.id, action: 'RECEIVING_STARTED' as never, entityType: 'receiving_session',
        entityId: session.id, ipAddress: actor.ip ?? null,
        metadata: { session: code, arrival: arrival.code, shipment: primaryShipment?.code ?? null },
      }, tx);
      return session;
    }).then((s) => this.sessionDetail(s.id));
  }

  // ---------- scan / identify carton ----------
  async scanCarton(sessionId: string, code: string, scanType: 'QR' | 'BARCODE' | 'MANUAL', actor: ReceivingActor, operationId?: string, source: ScanSource = 'MANUAL') {
    const session = await this.requireActiveSession(sessionId);
    const term = code.trim();
    if (!term) throw new BadRequestException('Scan code is required.');

    // Idempotency: same physical operation processed once.
    if (operationId) {
      const dup = await this.prisma.receivingCarton.findUnique({ where: { operationId } });
      if (dup) return this.sessionDetail(sessionId);
    }

    // Search cartons: by external id / qr / barcode / reference, across ANY shipment.
    const carton = await this.prisma.warehouseCarton.findFirst({
      where: { OR: [
        { externalCartonId: term }, { qrCodeValue: term }, { barcodeValue: term }, { cartonReference: term },
      ] },
      include: { shipment: { include: { expectedArrival: true } } },
    });

    // Unknown carton -> flag, do not attach.
    if (!carton) {
      await this.prisma.$transaction(async (tx) => {
        const rc = await tx.receivingCarton.create({ data: {
          receivingSessionId: sessionId, scannedCode: term, scanType, source, status: 'UNKNOWN',
          receivedBy: actor.id, receivedAt: new Date(), operationId: operationId ?? null,
        } });
        await tx.receivingDiscrepancy.create({ data: {
          receivingSessionId: sessionId, type: 'UNKNOWN_CARTON', reason: `Unknown carton scan: ${term}`,
          status: 'OPEN', createdBy: actor.id,
        } });
        await this.audit.log({ actorUserId: actor.id, action: 'UNKNOWN_CARTON' as never, entityType: 'receiving_carton',
          entityId: rc.id, metadata: { code: term, scanType } }, tx);
      });
      return this.sessionDetail(sessionId, { flash: { kind: 'UNKNOWN_CARTON', code: term } });
    }

    // Carton belongs to a different shipment/arrival -> wrong shipment.
    if (session.shipmentId && carton.shipmentId !== session.shipmentId) {
      await this.prisma.$transaction(async (tx) => {
        const rc = await tx.receivingCarton.create({ data: {
          receivingSessionId: sessionId, cartonId: carton.id, scannedCode: term, scanType, source,
          status: 'WRONG_SHIPMENT', receivedBy: actor.id, receivedAt: new Date(), operationId: operationId ?? null,
        } });
        await tx.receivingDiscrepancy.create({ data: {
          receivingSessionId: sessionId, cartonId: carton.id, type: 'WRONG_SHIPMENT',
          reason: `Carton ${carton.externalCartonId} belongs to shipment ${carton.shipment.code}`,
          status: 'OPEN', createdBy: actor.id,
        } });
        await this.audit.log({ actorUserId: actor.id, action: 'WRONG_SHIPMENT' as never, entityType: 'receiving_carton',
          entityId: rc.id, metadata: { carton: carton.externalCartonId, shipment: carton.shipment.code } }, tx);
      });
      return this.sessionDetail(sessionId, { flash: { kind: 'WRONG_SHIPMENT', carton: carton.externalCartonId, shipment: carton.shipment.code } });
    }

    // Already received in this session -> duplicate, do not double count.
    const alreadyReceived = await this.prisma.receivingCarton.findFirst({
      where: { receivingSessionId: sessionId, cartonId: carton.id, status: 'RECEIVED' },
    });
    if (alreadyReceived || carton.status === 'RECEIVED') {
      await this.audit.log({ actorUserId: actor.id, action: 'DUPLICATE_CARTON' as never, entityType: 'warehouse_carton',
        entityId: carton.id, ipAddress: actor.ip ?? null, metadata: { carton: carton.externalCartonId } });
      return this.sessionDetail(sessionId, { flash: { kind: 'DUPLICATE_CARTON', carton: carton.externalCartonId } });
    }

    // Identified but not yet received -> return for the worker to confirm.
    const flash = {
      kind: 'CARTON_IDENTIFIED' as const,
      carton: {
        id: carton.id, externalCartonId: carton.externalCartonId, reference: carton.cartonReference,
        cartonNumber: carton.cartonNumber, totalCartons: carton.totalCartons,
        qrCodeValue: carton.qrCodeValue, barcodeValue: carton.barcodeValue,
        weight: carton.weight, weightUnit: carton.weightUnit,
        shipment: { code: carton.shipment.code, externalShipmentId: carton.shipment.externalShipmentId },
      },
    };
    await this.audit.log({ actorUserId: actor.id, action: 'CARTON_SCANNED' as never, entityType: 'warehouse_carton',
      entityId: carton.id, ipAddress: actor.ip ?? null,
      metadata: { code: term, scanType, shipment: carton.shipment.code } });
    return this.sessionDetail(sessionId, { flash });
  }

  // ---------- confirm carton received ----------
  async receiveCarton(sessionId: string, cartonExternalId: string, actor: ReceivingActor, operationId?: string, source: ScanSource = 'MANUAL') {
    const session = await this.requireActiveSession(sessionId);
    const carton = await this.prisma.warehouseCarton.findFirst({
      where: { OR: [{ externalCartonId: cartonExternalId }, { qrCodeValue: cartonExternalId }, { id: cartonExternalId }] },
      include: { shipment: true },
    });
    if (!carton) throw new NotFoundException('Carton not found.');
    if (session.shipmentId && carton.shipmentId !== session.shipmentId) {
      throw new ConflictException('Carton belongs to a different shipment.');
    }

    if (operationId) {
      const dup = await this.prisma.receivingCarton.findUnique({ where: { operationId } });
      if (dup) return this.sessionDetail(sessionId);
    }
    const existing = await this.prisma.receivingCarton.findFirst({
      where: { receivingSessionId: sessionId, cartonId: carton.id, status: 'RECEIVED' },
    });
    if (existing) return this.sessionDetail(sessionId, { flash: { kind: 'DUPLICATE_CARTON', carton: carton.externalCartonId } });

    await this.prisma.$transaction(async (tx) => {
      await tx.receivingCarton.create({ data: {
        receivingSessionId: sessionId, cartonId: carton.id, scannedCode: carton.externalCartonId,
        scanType: 'MANUAL', source, status: 'RECEIVED', receivedBy: actor.id, receivedAt: new Date(),
        operationId: operationId ?? null,
      } });
      await tx.warehouseCarton.update({ where: { id: carton.id }, data: { status: 'RECEIVED', receivedAt: new Date(), receivedBy: actor.id } });
      await this.audit.log({ actorUserId: actor.id, action: 'CARTON_RECEIVED' as never, entityType: 'warehouse_carton',
        entityId: carton.id, ipAddress: actor.ip ?? null,
        metadata: { carton: carton.externalCartonId, number: carton.cartonNumber, of: carton.totalCartons } }, tx);
    });
    return this.sessionDetail(sessionId);
  }

  // ---------- product scan / receive units ----------
  async receiveProduct(sessionId: string, sku: string, quantity: number, actor: ReceivingActor, source: ScanSource = 'MANUAL') {
    const session = await this.requireActiveSession(sessionId);
    const qty = Math.max(1, Math.floor(Number(quantity) || 1));
    const term = (sku || '').trim();
    if (!term) throw new BadRequestException('SKU/reference is required.');

    const line = await this.prisma.receivingProduct.findFirst({
      where: { receivingSessionId: sessionId, sku: term },
    });

    if (!line) {
      // Unexpected product -> record discrepancy, do NOT add to expected.
      await this.prisma.$transaction(async (tx) => {
        const rp = await tx.receivingProduct.create({ data: {
          receivingSessionId: sessionId, sku: term, expectedQuantity: 0, receivedQuantity: qty,
          difference: qty, status: 'UNEXPECTED',
        } });
        await tx.receivingDiscrepancy.create({ data: {
          receivingSessionId: sessionId, receivingProductId: rp.id, type: 'UNEXPECTED_PRODUCT',
          expectedQuantity: 0, actualQuantity: qty, difference: qty,
          reason: `Unexpected SKU ${term} (+${qty})`, status: 'OPEN', createdBy: actor.id,
        } });
        await this.audit.log({ actorUserId: actor.id, action: 'UNEXPECTED_PRODUCT' as never, entityType: 'receiving_product',
          entityId: rp.id, metadata: { sku: term, quantity: qty, source } }, tx);
      });
      return this.sessionDetail(sessionId, { flash: { kind: 'UNEXPECTED_PRODUCT', sku: term } });
    }

    const expectedLine = line!;
    const received = expectedLine.receivedQuantity + qty;
    const difference = received - expectedLine.expectedQuantity;
    await this.prisma.$transaction(async (tx) => {

      let status: string = expectedLine.status;
      if (received >= expectedLine.expectedQuantity) status = received === expectedLine.expectedQuantity ? 'RECEIVED' : 'OVERAGE';
      else status = received > 0 ? 'PARTIALLY_RECEIVED' : 'EXPECTED';

      const updated = await tx.receivingProduct.update({
        where: { id: expectedLine.id },
        data: { receivedQuantity: received, difference, status: status as any },
      });

      if (updated.status === 'OVERAGE' && expectedLine.status !== 'OVERAGE') {
        await tx.receivingDiscrepancy.create({ data: {
          receivingSessionId: sessionId, receivingProductId: expectedLine.id, type: 'OVERAGE',
          expectedQuantity: expectedLine.expectedQuantity, actualQuantity: received, difference,
          reason: `Overage on ${term} (+${difference})`, status: 'OPEN', createdBy: actor.id,
        } });
      }
      await this.audit.log({ actorUserId: actor.id, action: 'PRODUCT_RECEIVED' as never, entityType: 'receiving_product',
        entityId: expectedLine.id, metadata: { sku: term, received, expected: expectedLine.expectedQuantity, added: qty, source } }, tx);
    });
    return this.sessionDetail(sessionId, { flash: { kind: 'PRODUCT_MATCH', sku: term, received, expected: expectedLine.expectedQuantity } });
  }

  // ---------- pause / resume ----------
  async pause(sessionId: string, actor: ReceivingActor) {
    const session = await this.requireSession(sessionId);
    if (session.status !== 'RECEIVING') throw new ConflictException('Session is not active.');
    await this.prisma.$transaction(async (tx) => {
      await tx.receivingSession.update({ where: { id: sessionId }, data: { status: 'PAUSED', pausedAt: new Date() } });
      await tx.expectedArrival.update({ where: { id: session.arrivalId }, data: { status: 'PAUSED' } });
      await this.audit.log({ actorUserId: actor.id, action: 'RECEIVING_PAUSED' as never, entityType: 'receiving_session', entityId: sessionId }, tx);
    });
    return this.sessionDetail(sessionId);
  }

  async resume(sessionId: string, actor: ReceivingActor) {
    const session = await this.requireSession(sessionId);
    if (session.status !== 'PAUSED') throw new ConflictException('Session is not paused.');
    await this.prisma.$transaction(async (tx) => {
      await tx.receivingSession.update({ where: { id: sessionId }, data: { status: 'RECEIVING', resumedAt: new Date() } });
      await tx.expectedArrival.update({ where: { id: session.arrivalId }, data: { status: 'RECEIVING' } });
      await this.audit.log({ actorUserId: actor.id, action: 'RECEIVING_RESUMED' as never, entityType: 'receiving_session', entityId: sessionId }, tx);
    });
    return this.sessionDetail(sessionId);
  }

  // ---------- flag / resolve discrepancy ----------
  async flag(sessionId: string, payload: { code?: string; sku?: string; reason?: string }, actor: ReceivingActor) {
    await this.requireActiveSession(sessionId);
    const type = payload.sku ? 'IDENTIFICATION_ERROR' : 'UNKNOWN_CARTON';
    await this.prisma.receivingDiscrepancy.create({ data: {
      receivingSessionId: sessionId, type: type as any, reason: payload.reason || payload.code || payload.sku || 'Flagged',
      status: 'OPEN', createdBy: actor.id,
    } });
    return this.sessionDetail(sessionId);
  }

  async resolveDiscrepancy(discrepancyId: string, resolution: string, actor: ReceivingActor) {
    if (!actor.canResolveDiscrepancy) {
      throw new ForbiddenException('Only a supervisor can resolve discrepancies.');
    }
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.receivingDiscrepancy.update({
        where: { id: discrepancyId },
        data: { status: 'RESOLVED', resolvedBy: actor.id, resolvedAt: new Date(), resolution: resolution || 'Resolved' },
      });
      // If an OVERAGE was approved, keep the line OVERAGE but discrepancy closed.
      await this.audit.log({ actorUserId: actor.id, action: 'DISCREPANCY_RESOLVED' as never, entityType: 'receiving_discrepancy',
        entityId: d.id, metadata: { type: d.type, resolution } }, tx);
    });
    const d = await this.prisma.receivingDiscrepancy.findUnique({ where: { id: discrepancyId } });
    return this.sessionDetail(d!.receivingSessionId);
  }

  // ---------- complete ----------
  async complete(sessionId: string, actor: ReceivingActor) {
    const session = await this.requireActiveSession(sessionId);
    const tally = await this.reconcile(sessionId);

    const hasOpenDiscrepancies = tally.openDiscrepancies > 0
      || tally.shortUnits > 0 || tally.overageUnits > 0 || tally.unexpectedProducts > 0 || tally.missingCartons > 0;

    if (hasOpenDiscrepancies && !actor.canResolveDiscrepancy) {
      throw new ForbiddenException('Receiving has discrepancies; a supervisor must close it.');
    }

    const finalStatus = hasOpenDiscrepancies ? 'COMPLETED_WITH_DISCREPANCY' : 'COMPLETED';
    const arrivalStatus = hasOpenDiscrepancies ? 'RECEIVED_WITH_DISCREPANCY' : 'RECEIVED';

    await this.prisma.$transaction(async (tx) => {
      await tx.receivingSession.update({
        where: { id: sessionId },
        data: { status: finalStatus as any, completedBy: actor.id, completedAt: new Date() },
      });
      await tx.expectedArrival.update({ where: { id: session.arrivalId }, data: { status: arrivalStatus as any } });
      // Mark short lines.
      if (hasOpenDiscrepancies) {
        await tx.receivingProduct.updateMany({
          where: { receivingSessionId: sessionId, status: { in: ['EXPECTED', 'PARTIALLY_RECEIVED'] } },
          data: { status: 'SHORT' },
        });
      }
      await this.audit.log({
        actorUserId: actor.id,
        action: (hasOpenDiscrepancies ? 'RECEIVING_COMPLETED_WITH_DISCREPANCY' : 'RECEIVING_COMPLETED') as never,
        entityType: 'receiving_session', entityId: sessionId, ipAddress: actor.ip ?? null,
        metadata: { finalStatus: arrivalStatus, tally },
      }, tx);
    });
    return this.sessionDetail(sessionId);
  }

  // ---------- read ----------
  async listForReceiving() {
    // Arrivals that are expected/receiving and have at least a shipment or just expected.
    const arrivals = await this.prisma.expectedArrival.findMany({
      where: { status: { in: ['EXPECTED', 'RECEIVING', 'PAUSED'] } },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { items: true, shipments: true } }, shipments: { include: { cartons: true } } },
    });
    return arrivals.map((a) => ({
      id: a.id, code: a.code, customerName: a.customerName, storeName: a.storeName,
      status: a.status, products: a.productCount, units: a.totalUnits,
      shipments: a._count.shipments,
      carrier: a.shipments[0]?.carrierName ?? null,
      tracking: a.shipments[0]?.trackingNumber ?? null,
      cartons: a.shipments.reduce((n, s) => n + s.cartons.length, 0),
    }));
  }

  private async requireSession(id: string) {
    const s = await this.prisma.receivingSession.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Receiving session not found.');
    return s;
  }
  private async requireActiveSession(id: string) {
    const s = await this.requireSession(id);
    if (s.status === 'COMPLETED' || s.status === 'COMPLETED_WITH_DISCREPANCY' || s.status === 'CANCELLED') {
      throw new ConflictException('Receiving session is closed.');
    }
    return s;
  }

  async reconcile(sessionId: string) {
    const session = await this.requireSession(sessionId);
    const [products, openDisc, receivedCartons, arrivalWithShipments] = await Promise.all([
      this.prisma.receivingProduct.findMany({ where: { receivingSessionId: sessionId } }),
      this.prisma.receivingDiscrepancy.count({ where: { receivingSessionId: sessionId, status: 'OPEN' } }),
      this.prisma.receivingCarton.count({ where: { receivingSessionId: sessionId, status: 'RECEIVED' } }),
      this.prisma.expectedArrival.findUnique({
        where: { id: session.arrivalId },
        include: { shipments: { include: { cartons: true } } },
      }),
    ]);
    const expectedUnits = products.filter((p) => p.expectedQuantity > 0).reduce((n, p) => n + p.expectedQuantity, 0);
    const receivedUnits = products.reduce((n, p) => n + p.receivedQuantity, 0);
    const expectedProducts = products.filter((p) => p.expectedQuantity > 0).length;
    const receivedProducts = products.filter((p) => p.expectedQuantity > 0 && p.receivedQuantity >= p.expectedQuantity).length;
    const expectedCartons = arrivalWithShipments?.shipments.reduce((n, s) => n + s.cartons.length, 0) ?? 0;
    const shortUnits = products
      .filter((p) => p.expectedQuantity > 0 && p.receivedQuantity < p.expectedQuantity)
      .reduce((n, p) => n + (p.expectedQuantity - p.receivedQuantity), 0);
    const overageUnits = products.filter((p) => p.status === 'OVERAGE').reduce((n, p) => n + p.difference, 0);
    const unexpectedProducts = products.filter((p) => p.status === 'UNEXPECTED').length;
    return {
      expectedCartons, receivedCartons,
      expectedProducts, receivedProducts,
      expectedUnits, receivedUnits,
      openDiscrepancies: openDisc,
      shortUnits: Math.max(0, shortUnits),
      overageUnits: Math.max(0, overageUnits),
      unexpectedProducts,
      missingCartons: Math.max(0, expectedCartons - receivedCartons),
    };
  }

  async sessionDetail(sessionId: string, opts?: { flash?: any }) {
    const session = await this.prisma.receivingSession.findUnique({
      where: { id: sessionId },
      include: {
        expectedArrival: { include: { shipments: { include: { cartons: { orderBy: { cartonNumber: 'asc' } } } } } },
        shipment: true,
        cartons: { orderBy: { createdAt: 'desc' }, include: { carton: true } },
        products: { orderBy: { status: 'asc' } },
        discrepancies: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!session) throw new NotFoundException('Receiving session not found.');

    const tally = await this.reconcile(sessionId);
    const shipment = session.shipment
      ? (session.expectedArrival.shipments.find((s) => s.id === session.shipmentId) ?? session.shipment)
      : session.expectedArrival.shipments[0] ?? null;
    return {
      id: session.id,
      code: session.code,
      status: session.status,
      startedAt: session.startedAt,
      pausedAt: session.pausedAt,
      completedAt: session.completedAt,
      deviceType: session.deviceType ?? null,
      deviceName: session.deviceName ?? null,
      scanSource: session.scanSource ?? null,
      arrival: {
        id: session.expectedArrival.id,
        code: session.expectedArrival.code,
        externalArrivalId: session.expectedArrival.arrivalId,
        customerName: session.expectedArrival.customerName,
        customerId: session.expectedArrival.customerId,
        storeName: session.expectedArrival.storeName,
        status: session.expectedArrival.status,
      },
      shipment: shipment ? {
        id: shipment.id, code: shipment.code, externalShipmentId: shipment.externalShipmentId,
        carrierName: shipment.carrierName, carrierCode: shipment.carrierCode, trackingNumber: shipment.trackingNumber,
        senderName: shipment.senderName, senderCompany: shipment.senderCompany,
        totalCartons: shipment.totalCartons, totalProducts: shipment.totalProducts, totalUnits: shipment.totalUnits,
      } : null,
      cartons: (shipment as any)?.cartons?.map((c: any) => ({
        id: c.id, externalCartonId: c.externalCartonId, reference: c.cartonReference,
        qrCodeValue: c.qrCodeValue, barcodeValue: c.barcodeValue,
        cartonNumber: c.cartonNumber, totalCartons: c.totalCartons, status: c.status,
        weight: c.weight, weightUnit: c.weightUnit,
      })) ?? [],
      receivedCartonEvents: session.cartons.map((rc) => ({
        id: rc.id, code: rc.scannedCode, scanType: rc.scanType, source: rc.source, status: rc.status,
        cartonId: rc.carton?.externalCartonId ?? null, receivedAt: rc.receivedAt,
      })),
      products: session.products.map((p) => ({
        id: p.id, sku: p.sku, reference: p.reference, productName: p.productName,
        expected: p.expectedQuantity, received: p.receivedQuantity,
        remaining: Math.max(0, p.expectedQuantity - p.receivedQuantity),
        difference: p.difference, status: p.status,
      })),
      discrepancies: session.discrepancies.map((d) => ({
        id: d.id, type: d.type, status: d.status, reason: d.reason,
        expected: d.expectedQuantity, actual: d.actualQuantity, difference: d.difference, resolution: d.resolution,
      })),
      tally,
      flash: opts?.flash ?? null,
    };
  }

  async activeSessionForArrival(arrivalIdOrCode: string) {
    const arrival = await this.prisma.expectedArrival.findFirst({
      where: { OR: [{ id: arrivalIdOrCode }, { code: arrivalIdOrCode }] },
    });
    if (!arrival) throw new NotFoundException('Expected arrival not found.');
    const s = await this.prisma.receivingSession.findFirst({
      where: { arrivalId: arrival.id, status: { in: ['RECEIVING', 'PAUSED'] } },
      orderBy: { startedAt: 'desc' },
    });
    return s ? this.sessionDetail(s.id) : null;
  }
}
