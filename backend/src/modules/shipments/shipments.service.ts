import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TaskDispatchService } from '../assignments/dispatch.service';
import { PushService } from '../notifications/push.service';
import { ShipmentCardEventDto } from '../../integrations/crm/dto/shipment-card.dto';
import { linkCartonProductContents } from './carton-content';
import type { IntegrationPrincipal } from '../expected-arrivals/expected-arrivals.service';

const WSHP_PREFIX = 'WSHP-';
const WSHP_COUNTER_START = 100;
const WAR_PREFIX = 'WAR-';
const WAR_COUNTER_START = 1000;

export interface ShipmentReceiveResult {
  success: true;
  event: 'shipment.created';
  shipment_id: string;
  warehouse_shipment_id: string;
  status: 'RECEIVED';
  created: boolean;
  duplicate: boolean;
}

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly dispatch: TaskDispatchService,
    private readonly push: PushService,
  ) {}

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
    const ids = cartons.map((c) => c.id.trim());
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Duplicate carton id within the shipment card.');
    }

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
        where: { idempotencyKey: principal.idempotencyKey, externalShipmentId: shipmentId },
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

    const shipmentSuiviCode = 
      (shipment as any).suivi_code?.trim() ||
      (shipment.tracking as any)?.suivi_code?.trim() ||
      shipment.tracking?.tracking_number?.trim() ||
      null;

    const shipmentSourceProject = (shipment as any).source_project?.trim() || (shipment as any).sourceProject?.trim() || null;
    const shipmentMetadata = (shipment as any).metadata || null;

    const summaryProducts = shipment.summary?.total_products ?? 0;
    const summaryUnits = shipment.summary?.total_units ?? 0;

    let totalProductsInCartons = 0;
    for (const c of cartons) {
      const prods = (c as any).products as any[] | null | undefined;
      if (prods && Array.isArray(prods)) {
        totalProductsInCartons += prods.reduce((sum, p) => sum + (Number(p.quantity) || 1), 0);
      }
    }
    // Carton manifest accounting (carton-content.ts): created = content lines
    // beyond the customer card; mirrored = lines already declared on it.
    let cartonContentCreated = 0;
    let cartonContentMirrored = 0;

    const record = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (!arrival) {
        const warCode = await this.generateArrivalCode(tx);
        arrival = await tx.expectedArrival.create({
          data: {
            code: warCode,
            customerArrivalCardId: `shipment:${shipmentId}`,
            arrivalId: externalArrivalId,
            arrivalReference: dto.arrival.reference?.trim() || null,
            customerId: shipment.sender?.company?.trim() || shipment.sender?.name?.trim() || externalArrivalId || shipmentId,
            customerName: shipment.sender?.company?.trim() || shipment.sender?.name?.trim() || 'Pending customer card',
            storeName: null,
            status: 'EXPECTED',
            source: 'ARRIVAL_CRM',
            productCount: summaryProducts || totalProductsInCartons,
            totalUnits: summaryUnits || totalProductsInCartons,
            apiClientId: principal.id,
            idempotencyKey: principal.idempotencyKey ?? null,
            receivedViaApi: true,
            receivedViaApiAt: now,
          },
        });
      }

      const code = await this.generateCode(tx);
      const originalShipmentPayload = JSON.parse(JSON.stringify(dto));

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
          trackingNumber: shipment.tracking?.tracking_number?.trim() || (shipment as any).tracking_number?.trim() || shipmentSuiviCode || null,
          trackingUrl: shipment.tracking?.tracking_url?.trim() || null,
          trackingStatus: (shipment.tracking?.status as any) || 'UNKNOWN',
          masterTrackingNumber: shipment.tracking?.master_tracking_number?.trim() || null,
          carrierTrackingReference: shipment.tracking?.carrier_tracking_reference?.trim() || null,
          suiviCode: shipmentSuiviCode,
          originalPayload: originalShipmentPayload as any,
          metadata: shipmentMetadata as any,
          sourceProject: shipmentSourceProject,
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
          totalProducts: shipment.summary?.total_products ?? totalProductsInCartons ?? 0,
          totalUnits: shipment.summary?.total_units ?? totalProductsInCartons ?? 0,
          totalWeight: shipment.summary?.total_weight ?? null,
          weightUnit: shipment.summary?.weight_unit?.trim() || null,
          apiClientId: principal.id,
          receivedViaApi: true,
          receivedViaApiAt: now,
        },
      });

      for (const c of cartons) {
        const cAny = c as any;
        const suiviCode = 
          cAny.suivi_code?.trim() ||
          cAny.suivi?.trim() ||
          cAny.tracking_code?.trim() ||
          cAny.tracking_number?.trim() ||
          cAny.trackingNumber?.trim() ||
          shipmentSuiviCode ||
          null;

        const trackingCode =
          cAny.tracking_code?.trim() ||
          cAny.tracking_number?.trim() ||
          cAny.trackingNumber?.trim() ||
          suiviCode ||
          null;

        const qrValue = 
          cAny.qr_code_value?.trim() ||
          cAny.qr_code?.trim() ||
          cAny.qrCodeValue?.trim() ||
          cAny.qr?.trim() ||
          c.id.trim();

        const barcodeValue =
          cAny.barcode_value?.trim() ||
          cAny.barcode?.trim() ||
          cAny.barcodeValue?.trim() ||
          null;

        const sourceProject = cAny.source_project?.trim() || cAny.sourceProject?.trim() || shipmentSourceProject || null;
        const metadata = cAny.metadata || null;
        const productsInside = cAny.products as any[] | null | undefined;
        const productCount = productsInside && Array.isArray(productsInside) ? productsInside.length : 0;
        const originalCartonPayload = JSON.parse(JSON.stringify(c));

        const cartonRecord = await tx.warehouseCarton.create({
          data: {
            shipmentId: created.id,
            externalCartonId: c.id.trim(),
            cartonReference: c.reference?.trim() || cAny.carton_id?.trim() || null,
            qrCodeValue: qrValue,
            barcodeValue: barcodeValue,
            suiviCode: suiviCode,
            trackingCode: trackingCode,
            entityType: (cAny.entity_type?.trim() || 'CARTON').toUpperCase(),
            originalPayload: originalCartonPayload as any,
            metadata: metadata as any,
            sourceProject: sourceProject,
            productCount: productCount,
            cartonNumber: c.carton_number,
            totalCartons: c.total_cartons,
            weight: c.weight ?? null,
            weightUnit: c.weight_unit?.trim() || null,
            length: c.dimensions?.length ?? null,
            width: c.dimensions?.width ?? null,
            height: c.dimensions?.height ?? null,
            dimensionUnit: c.dimensions?.unit?.trim() || null,
            status: 'EXPECTED',
          },
        });

        if (productsInside && Array.isArray(productsInside) && productsInside.length > 0) {
          // Link manifest lines WITHOUT double counting lines the Customer
          // Arrival Card already declared (see carton-content.ts policy).
          const content = await linkCartonProductContents({
            tx,
            arrivalId: arrival!.id,
            cartonId: cartonRecord.id,
            products: productsInside as Array<Record<string, unknown>>,
          });
          cartonContentCreated += content.created;
          cartonContentMirrored += content.mirrored;
        }
      }

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
            suivi_code: created.suiviCode,
            cartons: created.totalCartons,
            products: created.totalProducts,
            units: created.totalUnits,
            products_inside_cartons: totalProductsInCartons,
            carton_content_created: cartonContentCreated,
            carton_content_mirrored: cartonContentMirrored,
            api_client: principal.name,
            received_via_api: true,
            entity_type: 'CARTON',
            original_payload_preserved: true,
          },
        },
        tx,
      );

      const arrivalId = arrival?.id ?? null;
      if (arrivalId) {
        await this.dispatch.dispatch(
          'receiving',
          { arrivalId, entityCode: arrival?.code ?? created.code },
          { db: tx, reason: `CRM shipment card ${shipmentId} processed (CARTON FIX)` },
        );
      }

      return created;
    });

    // CARTON FIX: push notification for new carton cards (app open/background/closed)
    // NEW CARTON CARD -> push to every worker holding the receiving permission
    // Fired AFTER the transaction commits; a push outage can never fail intake.
    // Preserves suivi_code end-to-end in notification payload.
    try {
      const firstCarton = cartons[0] as any;
      const suivi =
        firstCarton?.suivi_code?.trim() ||
        firstCarton?.suivi?.trim() ||
        firstCarton?.tracking_code?.trim() ||
        firstCarton?.tracking_number?.trim() ||
        shipmentSuiviCode ||
        shipment.tracking?.tracking_number?.trim() ||
        null;
      // Unified push: arrivalCode, cartonId, suiviCode + legacy compat
      await this.push.notifyNewCartonCard(
        arrival?.code ?? record.code,
        firstCarton?.id?.trim() ?? shipmentId,
        suivi,
      );
      // Also fire legacy signature for any listeners expecting count
      if (cartons.length > 1) {
        await this.push.notifyNewCartonCard(record.code, cartons.length, suivi);
      }
    } catch (err) {
      // best-effort, never fail intake
    }

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
    const last = await tx.warehouseShipment.findFirst({
      where: { code: { startsWith: WSHP_PREFIX } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const lastNumber = last ? Number.parseInt(last.code.slice(WSHP_PREFIX.length), 10) : NaN;
    let next = Number.isFinite(lastNumber) ? lastNumber + 1 : WSHP_COUNTER_START + 1;
    if (next <= WSHP_COUNTER_START) next = WSHP_COUNTER_START + 1;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const code = `${WSHP_PREFIX}${String(next + attempt).padStart(6, '0')}`;
      const clash = await tx.warehouseShipment.findUnique({ where: { code } });
      if (!clash) return code;
    }
    return `${WSHP_PREFIX}R${Date.now().toString().slice(-6)}`;
  }

  private async generateArrivalCode(tx: Prisma.TransactionClient): Promise<string> {
    const last = await tx.expectedArrival.findFirst({
      where: { code: { startsWith: WAR_PREFIX } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const lastNumber = last ? Number.parseInt(last.code.slice(WAR_PREFIX.length), 10) : NaN;
    let next = Number.isFinite(lastNumber) ? lastNumber + 1 : WAR_COUNTER_START + 1;
    if (next <= WAR_COUNTER_START) next = WAR_COUNTER_START + 1;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const code = `${WAR_PREFIX}${String(next + attempt).padStart(6, '0')}`;
      const clash = await tx.expectedArrival.findUnique({ where: { code } });
      if (!clash) return code;
    }
    return `${WAR_PREFIX}R${Date.now().toString().slice(-6)}`;
  }

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
        { suiviCode: { contains: search, mode: 'insensitive' } },
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
      suiviCode: r.suiviCode ?? r.trackingNumber,
      trackingStatus: r.trackingStatus,
      sourceType: r.sourceType,
      sourceProject: r.sourceProject,
      totalCartons: r.totalCartons,
      totalProducts: r.totalProducts,
      totalUnits: r.totalUnits,
      cartons: r._count?.cartons ?? r.totalCartons,
      destinationCode: r.destinationCode,
      receivedViaApiAt: r.receivedViaApiAt ?? r.createdAt,
      createdAt: r.createdAt,
      entityType: 'CARTON',
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
      suiviCode: s.suiviCode,
      sourceProject: s.sourceProject,
      metadata: s.metadata,
      originalPayload: s.originalPayload,
      cartons: (s.cartons ?? []).map((c: any) => ({
        id: c.id,
        externalCartonId: c.externalCartonId,
        reference: c.cartonReference,
        qrCodeValue: c.qrCodeValue,
        barcodeValue: c.barcodeValue,
        suiviCode: c.suiviCode,
        trackingCode: c.trackingCode ?? c.suiviCode,
        trackingNumber: c.trackingCode ?? c.suiviCode,
        entityType: c.entityType ?? 'CARTON',
        cartonNumber: c.cartonNumber,
        totalCartons: c.totalCartons,
        productCount: c.productCount,
        status: c.status,
        sourceProject: c.sourceProject,
        metadata: c.metadata,
        originalPayload: c.originalPayload,
        weight: c.weight, weightUnit: c.weightUnit,
        dimensions: { length: c.length, width: c.width, height: c.height, unit: c.dimensionUnit },
        receivedAt: c.receivedAt,
      })),
    };
  }
}
