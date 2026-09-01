import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ShipmentCardEventDto } from '../../integrations/crm/dto/shipment-card.dto';
import type { IntegrationPrincipal } from '../expected-arrivals/expected-arrivals.service';

const WSHP_PREFIX = 'WSHP-';
const WSHP_COUNTER_START = 100; // human codes start at WSHP-000100
const WAR_PREFIX = 'WAR-';
const WAR_COUNTER_START = 1000; // human codes start at WAR-001000

export interface ShipmentReceiveResult {
  success: true;
  event: 'shipment.created';
  shipment_id: string;
  warehouse_shipment_id: string;
  status: 'RECEIVED'; // accepted via API (the goods are still EXPECTED physically)
  created: boolean;
  duplicate: boolean;
}

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Receive a Shipment Card pushed by the Arrival CRM. Idempotent on the
   * external shipment id (and Idempotency-Key header). Links to the matching
   * Expected Arrival by external arrival id when present. The physical cartons
   * are stored as WarehouseCarton rows (status EXPECTED) — receiving happens
   * later in the Receiving module.
   */
  async receiveShipment(
    dto: ShipmentCardEventDto,
    principal: IntegrationPrincipal,
    ip?: string | null,
  ): Promise<ShipmentReceiveResult> {
    const shipment = dto.shipment;
    const shipmentId = shipment.id.trim();
    const cartons = shipment.cartons ?? [];

    if (!cartons.length) {
      throw new BadRequestException('Shipment card contains no cartons.');
    }
    // Carton external ids must be unique within the card.
    const ids = cartons.map((c) => c.id.trim());
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Duplicate carton id within the shipment card.');
    }

    // --- Idempotency: external shipment id is the primary anchor ---
    const existing = await this.prisma.warehouseShipment.findUnique({
      where: { externalShipmentId: shipmentId },
    });
    if (existing) {
      return {
        success: true,
        event: 'shipment.created',
        shipment_id: shipmentId,
        warehouse_shipment_id: existing.code,
        status: 'RECEIVED',
        created: false,
        duplicate: true,
      };
    }
    if (principal.idempotencyKey) {
      const byKey = await this.prisma.warehouseShipment.findFirst({
        where: { idempotencyKey: principal.idempotencyKey },
      });
      if (byKey) {
        return {
          success: true,
          event: 'shipment.created',
          shipment_id: shipmentId,
          warehouse_shipment_id: byKey.code,
          status: 'RECEIVED',
          created: false,
          duplicate: true,
        };
      }
    }

    // Link to the Expected Arrival by the CRM arrival id (stored on the card).
    const externalArrivalId = dto.arrival.id?.trim() || null;
    let arrival = externalArrivalId
      ? await this.prisma.expectedArrival.findFirst({
          where: { OR: [{ arrivalId: externalArrivalId }, { arrivalReference: dto.arrival.reference?.trim() || undefined }] },
        })
      : null;

    const now = new Date();
    const parseDate = (v?: string | null) => {
      if (!v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    // Summary values that describe the arrival-level projection.
    const summaryProducts = shipment.summary?.total_products ?? 0;
    const summaryUnits = shipment.summary?.total_units ?? 0;

    const record = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // A Shipment Card always belongs to an Arrival. If the Expected Arrival
      // has not been pushed yet (shipment arrives first), create a minimal
      // stub so the shipment is never orphaned; it is enriched later when the
      // Customer Arrival Card arrives / is matched by external arrival id.
      if (!arrival) {
        const warCode = await this.generateArrivalCode(tx);
        arrival = await tx.expectedArrival.create({
          data: {
            code: warCode,
            // Shipment-only arrivals are anchored by the shipment id (unique).
            customerArrivalCardId: `shipment:${shipmentId}`,
            arrivalId: externalArrivalId,
            arrivalReference: dto.arrival.reference?.trim() || null,
            customerId: shipment.sender?.company?.trim() || shipment.sender?.name?.trim() || externalArrivalId || shipmentId,
            customerName: shipment.sender?.company?.trim() || shipment.sender?.name?.trim() || 'Pending customer card',
            storeName: null,
            status: 'EXPECTED',
            source: 'ARRIVAL_CRM',
            productCount: summaryProducts,
            totalUnits: summaryUnits,
            apiClientId: principal.id,
            idempotencyKey: principal.idempotencyKey ?? null,
            receivedViaApi: true,
            receivedViaApiAt: now,
          },
        });
      }

      const code = await this.generateCode(tx);
      const created = await tx.warehouseShipment.create({
        data: {
          code,
          externalShipmentId: shipmentId,
          shipmentReference: shipment.reference?.trim() || null,
          idempotencyKey: principal.idempotencyKey,
          arrivalId: arrival?.id ?? null,
          externalArrivalId,
          arrivalReference: dto.arrival.reference?.trim() || null,
          sourceType: (shipment.source?.type as any) || 'MANUAL',
          sourceReference: shipment.source?.reference?.trim() || null,
          carrierId: shipment.carrier?.id?.trim() || null,
          carrierName: shipment.carrier?.name?.trim() || null,
          carrierCode: shipment.carrier?.code?.trim() || null,
          serviceName: shipment.carrier?.service?.trim() || null,
          carrierAccountReference: shipment.carrier?.account_reference?.trim() || null,
          trackingNumber: shipment.tracking?.tracking_number?.trim() || null,
          trackingUrl: shipment.tracking?.tracking_url?.trim() || null,
          trackingStatus: (shipment.tracking?.status as any) || 'UNKNOWN',
          masterTrackingNumber: shipment.tracking?.master_tracking_number?.trim() || null,
          carrierTrackingReference: shipment.tracking?.carrier_tracking_reference?.trim() || null,
          senderName: shipment.sender?.name?.trim() || null,
          senderCompany: shipment.sender?.company?.trim() || null,
          senderCountry: shipment.sender?.country?.trim() || null,
          senderCity: shipment.sender?.city?.trim() || null,
          senderReference: shipment.sender?.reference?.trim() || null,
          senderAddress: shipment.sender?.address?.trim() || null,
          senderPhone: shipment.sender?.phone?.trim() || null,
          senderEmail: shipment.sender?.email?.trim() || null,
          destinationCountry: shipment.destination?.country?.trim() || null,
          destinationCity: shipment.destination?.city?.trim() || null,
          destinationCode: shipment.destination?.code?.trim() || null,
          destinationReference: shipment.destination?.reference?.trim() || null,
          shipmentCreatedAt: parseDate(shipment.dates?.created_at),
          shippedAt: parseDate(shipment.dates?.shipped_at),
          estimatedArrivalAt: parseDate(shipment.dates?.estimated_arrival_at),
          actualArrivalAt: parseDate(shipment.dates?.actual_arrival_at),
          totalCartons: shipment.summary?.total_cartons ?? cartons.length,
          totalProducts: shipment.summary?.total_products ?? 0,
          totalUnits: shipment.summary?.total_units ?? 0,
          totalWeight: shipment.summary?.total_weight ?? null,
          weightUnit: shipment.summary?.weight_unit?.trim() || null,
          apiClientId: principal.id,
          receivedViaApi: true,
          receivedViaApiAt: now,
          cartons: {
            create: cartons.map((c) => ({
              externalCartonId: c.id.trim(),
              cartonReference: c.reference?.trim() || null,
              qrCodeValue: c.qr_code_value?.trim() || c.id.trim(),
              barcodeValue: c.barcode_value?.trim() || null,
              cartonNumber: c.carton_number,
              totalCartons: c.total_cartons,
              weight: c.weight ?? null,
              weightUnit: c.weight_unit?.trim() || null,
              length: c.dimensions?.length ?? null,
              width: c.dimensions?.width ?? null,
              height: c.dimensions?.height ?? null,
              dimensionUnit: c.dimensions?.unit?.trim() || null,
              status: 'EXPECTED',
            })),
          },
        },
      });

      await this.audit.log(
        {
          actorUserId: null,
          action: 'SHIPMENT_CARD_RECEIVED' as never,
          entityType: 'warehouse_shipment',
          entityId: created.id,
          ipAddress: ip ?? null,
          metadata: {
            source: 'ARRIVAL_CRM',
            external_shipment_id: shipmentId,
            warehouse_shipment_id: code,
            status: 'SUCCESS',
            external_arrival_id: externalArrivalId,
            linked_expected_arrival: arrival?.code ?? null,
            carrier: created.carrierCode,
            tracking_number: created.trackingNumber,
            cartons: created.totalCartons,
            products: created.totalProducts,
            units: created.totalUnits,
            api_client: principal.name,
            received_via_api: true,
          },
        },
        tx,
      );

      return created;
    });

    return {
      success: true,
      event: 'shipment.created',
      shipment_id: shipmentId,
      warehouse_shipment_id: record.code,
      status: 'RECEIVED',
      created: true,
      duplicate: false,
    };
  }

  private async generateCode(tx: Prisma.TransactionClient): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const count = await tx.warehouseShipment.count();
      const number = WSHP_COUNTER_START + count + 1;
      const code = `${WSHP_PREFIX}${String(number).padStart(6, '0')}`;
      const clash = await tx.warehouseShipment.findUnique({ where: { code } });
      if (!clash) return code;
    }
    return `${WSHP_PREFIX}R${Date.now().toString().slice(-6)}`;
  }

  /** Generate a `WAR-XXXXXX` code aligned with ExpectedArrivals numbering. */
  private async generateArrivalCode(tx: Prisma.TransactionClient): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const count = await tx.expectedArrival.count();
      const number = WAR_COUNTER_START + count + 1;
      const code = `${WAR_PREFIX}${String(number).padStart(6, '0')}`;
      const clash = await tx.expectedArrival.findUnique({ where: { code } });
      if (!clash) return code;
    }
    return `${WAR_PREFIX}R${Math.floor(Math.random() * 1e6)}`;
  }

  // ---- Read side ----

  async list(filters: { search?: string; status?: string; take?: number; skip?: number }) {
    const where: Prisma.WarehouseShipmentWhereInput = {};
    if (filters.status) where.trackingStatus = filters.status as never;
    const search = (filters.search ?? '').trim();
    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { externalShipmentId: { contains: search, mode: 'insensitive' } },
        { shipmentReference: { contains: search, mode: 'insensitive' } },
        { carrierName: { contains: search, mode: 'insensitive' } },
        { trackingNumber: { contains: search, mode: 'insensitive' } },
      ];
    }
    const take = Math.min(filters.take ?? 50, 200);
    const skip = filters.skip ?? 0;
    const [data, total] = await Promise.all([
      this.prisma.warehouseShipment.findMany({
        where,
        orderBy: { receivedViaApiAt: 'desc' },
        take,
        skip,
        include: { _count: { select: { cartons: true } }, expectedArrival: true },
      }),
      this.prisma.warehouseShipment.count({ where }),
    ]);
    return { data: data.map((r) => this.toListShape(r)), total, take, skip };
  }

  async detail(idOrCode: string) {
    const shipment = await this.prisma.warehouseShipment.findFirst({
      where: { OR: [{ id: idOrCode }, { code: idOrCode }, { externalShipmentId: idOrCode }] },
      include: { cartons: { orderBy: { cartonNumber: 'asc' } }, expectedArrival: true },
    });
    if (!shipment) throw new NotFoundException('Shipment not found.');
    return this.toDetailShape(shipment);
  }

  private toListShape(r: any) {
    return {
      id: r.id,
      warehouseShipmentId: r.code,
      code: r.code,
      externalShipmentId: r.externalShipmentId,
      shipmentReference: r.shipmentReference,
      arrivalId: r.expectedArrival?.code ?? null,
      externalArrivalId: r.externalArrivalId,
      carrierName: r.carrierName,
      carrierCode: r.carrierCode,
      trackingNumber: r.trackingNumber,
      trackingStatus: r.trackingStatus,
      sourceType: r.sourceType,
      totalCartons: r.totalCartons,
      totalProducts: r.totalProducts,
      totalUnits: r.totalUnits,
      cartons: r._count?.cartons ?? r.totalCartons,
      destinationCode: r.destinationCode,
      receivedViaApiAt: r.receivedViaApiAt ?? r.createdAt,
      createdAt: r.createdAt,
    };
  }

  private toDetailShape(s: any) {
    return {
      ...this.toListShape({ ...s, _count: { cartons: s.cartons?.length ?? s.totalCartons } }),
      idempotencyKey: s.idempotencyKey,
      serviceName: s.serviceName,
      sender: {
        name: s.senderName, company: s.senderCompany, country: s.senderCountry, city: s.senderCity,
      },
      destination: { country: s.destinationCountry, city: s.destinationCity, code: s.destinationCode },
      dates: {
        created_at: s.shipmentCreatedAt, shipped_at: s.shippedAt,
        estimated_arrival_at: s.estimatedArrivalAt, actual_arrival_at: s.actualArrivalAt,
      },
      summary: {
        total_cartons: s.totalCartons, total_products: s.totalProducts, total_units: s.totalUnits,
        total_weight: s.totalWeight, weight_unit: s.weightUnit,
      },
      cartons: (s.cartons ?? []).map((c: any) => ({
        id: c.id,
        externalCartonId: c.externalCartonId,
        reference: c.cartonReference,
        qrCodeValue: c.qrCodeValue,
        barcodeValue: c.barcodeValue,
        cartonNumber: c.cartonNumber,
        totalCartons: c.totalCartons,
        status: c.status,
        weight: c.weight, weightUnit: c.weightUnit,
        dimensions: { length: c.length, width: c.width, height: c.height, unit: c.dimensionUnit },
        receivedAt: c.receivedAt,
      })),
    };
  }
}
