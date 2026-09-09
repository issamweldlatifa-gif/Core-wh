import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TaskDispatchService } from '../assignments/dispatch.service';
import { PushService } from '../notifications/push.service';
import { CartonCardEventDto } from '../../integrations/crm/dto/carton-card.dto';
import { linkCartonProductContents } from '../shipments/carton-content';
import type { IntegrationPrincipal } from '../expected-arrivals/expected-arrivals.service';

const WSHP_PREFIX = 'WSHP-';
const WSHP_COUNTER_START = 100;
const WAR_PREFIX = 'WAR-';
const WAR_COUNTER_START = 1000;

@Injectable()
export class CartonCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly dispatch: TaskDispatchService,
    private readonly push: PushService,
  ) {}

  /**
   * CARTON CARD INGESTION — Full preservation of original carton card.
   * 
   * Incoming payload is ALWAYS CARTON, never PRODUCT, even if it contains SKU/reference/products.
   * Preserves: carton_id, suivi_code, tracking_code, qr_code, barcode, shipment info, products inside, metadata
   */
  async receiveCartonCard(
    dto: CartonCardEventDto,
    principal: IntegrationPrincipal,
    ip?: string | null,
  ) {
    const cartonDto = dto.carton;
    if (!cartonDto || !cartonDto.id) {
      throw new BadRequestException('Carton card missing id.');
    }

    const cartonId = cartonDto.id.trim();
    // Carton manifest accounting (carton-content.ts): created = content lines
    // beyond the customer card; mirrored = lines already declared on it.
    let cartonContentCreated = 0;
    let cartonContentMirrored = 0;
    const arrivalRef = dto.arrival.id.trim();

    // Idempotency on carton id
    const existingCarton = await this.prisma.warehouseCarton.findUnique({
      where: { externalCartonId: cartonId },
    });
    if (existingCarton) {
      return {
        success: true,
        event: 'carton.created',
        carton_id: cartonId,
        warehouse_carton_id: existingCarton.id,
        status: 'RECEIVED',
        created: false,
        duplicate: true,
        entity_type: 'CARTON',
      };
    }

    let arrival = await this.prisma.expectedArrival.findFirst({
      where: { OR: [{ arrivalId: arrivalRef }, { arrivalReference: dto.arrival.reference?.trim() || undefined }] },
    });

    const now = new Date();

    // Extract all possible aliases for suivi/tracking/qr/barcode
    const cAny = cartonDto as any;
    const suiviCode =
      cAny.suivi_code?.trim() ||
      cAny.suivi?.trim() ||
      cAny.tracking_code?.trim() ||
      cAny.tracking_number?.trim() ||
      null;

    const trackingCode =
      cAny.tracking_code?.trim() ||
      cAny.tracking_number?.trim() ||
      suiviCode ||
      null;

    const qrValue =
      cAny.qr_code_value?.trim() ||
      cAny.qr_code?.trim() ||
      cAny.qr?.trim() ||
      cartonId;

    const barcodeValue =
      cAny.barcode_value?.trim() ||
      cAny.barcode?.trim() ||
      null;

    const sourceProject = cAny.source_project?.trim() || null;
    const metadata = cAny.metadata || cAny.shipment_info || null;
    const productsInside = cAny.products as any[] | null | undefined;

    const result = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (!arrival) {
        const warCode = await this.generateArrivalCode(tx);
        arrival = await tx.expectedArrival.create({
          data: {
            code: warCode,
            customerArrivalCardId: `carton:${cartonId}`,
            arrivalId: arrivalRef,
            arrivalReference: dto.arrival.reference?.trim() || null,
            customerId: arrivalRef || cartonId,
            customerName: 'Carton arrival',
            storeName: null,
            status: 'EXPECTED',
            source: 'ARRIVAL_CRM',
            productCount: productsInside?.length ?? 0,
            totalUnits: productsInside?.reduce((sum: number, p: any) => sum + (Number(p.quantity) || 1), 0) ?? 0,
            apiClientId: principal.id,
            idempotencyKey: principal.idempotencyKey ?? null,
            receivedViaApi: true,
            receivedViaApiAt: now,
          },
        });
      }

      // Ensure shipment exists for carton (create stub shipment if needed)
      let shipment = await tx.warehouseShipment.findFirst({
        where: { arrivalId: arrival!.id },
      });

      if (!shipment) {
        const wshpCode = await this.generateShipmentCode(tx);
        const originalPayload = JSON.parse(JSON.stringify(dto));
        shipment = await tx.warehouseShipment.create({
          data: {
            code: wshpCode,
            externalShipmentId: `SHP-${cartonId}`,
            shipmentReference: dto.arrival.reference?.trim() || null,
            idempotencyKey: principal.idempotencyKey,
            arrivalId: arrival!.id,
            externalArrivalId: arrivalRef,
            arrivalReference: dto.arrival.reference?.trim() || null,
            sourceType: 'MANUAL',
            trackingNumber: trackingCode || suiviCode,
            suiviCode: suiviCode,
            originalPayload: originalPayload as any,
            metadata: metadata as any,
            sourceProject: sourceProject,
            totalCartons: 1,
            totalProducts: productsInside?.length ?? 0,
            totalUnits: productsInside?.reduce((sum: number, p: any) => sum + (Number(p.quantity) || 1), 0) ?? 0,
            apiClientId: principal.id,
            receivedViaApi: true,
            receivedViaApiAt: now,
          },
        });
      }

      const originalCartonPayload = JSON.parse(JSON.stringify(dto));

      const cartonRecord = await tx.warehouseCarton.create({
        data: {
          shipmentId: shipment!.id,
          externalCartonId: cartonId,
          cartonReference: cartonDto.reference?.trim() || (cartonDto as any).carton_id?.trim() || null,
          qrCodeValue: qrValue,
          barcodeValue: barcodeValue,
          suiviCode: suiviCode,
          trackingCode: trackingCode,
          entityType: 'CARTON',
          originalPayload: originalCartonPayload as any,
          metadata: metadata as any,
          sourceProject: sourceProject,
          productCount: productsInside?.length ?? 0,
          cartonNumber: cartonDto.carton_number ?? 1,
          totalCartons: cartonDto.total_cartons ?? 1,
          weight: cartonDto.weight ?? null,
          weightUnit: cartonDto.weight_unit?.trim() || null,
          length: cartonDto.dimensions?.length ?? null,
          width: cartonDto.dimensions?.width ?? null,
          height: cartonDto.dimensions?.height ?? null,
          dimensionUnit: cartonDto.dimensions?.unit?.trim() || null,
          status: 'EXPECTED',
        },
      });

      // Preserve products inside carton as relationship, but keep parent as
      // CARTON — WITHOUT double counting lines the Customer Arrival Card
      // already declared (see carton-content.ts policy).
      if (productsInside && Array.isArray(productsInside) && productsInside.length > 0) {
        const content = await linkCartonProductContents({
          tx,
          arrivalId: arrival!.id,
          cartonId: cartonRecord.id,
          products: productsInside as Array<Record<string, unknown>>,
        });
        cartonContentCreated += content.created;
        cartonContentMirrored += content.mirrored;
      }

      await this.audit.log(
        {
          actorUserId: null,
          action: 'SHIPMENT_CARD_RECEIVED' as never,
          entityType: 'warehouse_carton',
          entityId: cartonRecord.id,
          ipAddress: ip ?? null,
          metadata: {
            source: 'EXTERNAL_PROJECT',
            external_carton_id: cartonId,
            warehouse_carton_id: cartonRecord.id,
            entity_type: 'CARTON',
            suivi_code: suiviCode,
            tracking_code: trackingCode,
            qr_code: qrValue,
            barcode: barcodeValue,
            products_count: productsInside?.length ?? 0,
            carton_content_created: cartonContentCreated,
            carton_content_mirrored: cartonContentMirrored,
            original_payload_preserved: true,
            arrival_code: arrival!.code,
            source_project: sourceProject,
          },
        },
        tx,
      );

      await this.dispatch.dispatch(
        'receiving',
        { arrivalId: arrival!.id, entityCode: arrival!.code },
        { db: tx, reason: `External carton card ${cartonId} received (CARTON FIX)` },
      );

      return cartonRecord;
    });

    // CARTON FIX: push notification (app open/background/closed) -> opens receiving
    try {
      await this.push.notifyNewCartonCard(arrival?.code ?? `WAR-${cartonId}`, cartonId, suiviCode);
    } catch {}

    return {
      success: true,
      event: 'carton.created',
      carton_id: cartonId,
      warehouse_carton_id: result.id,
      suivi_code: suiviCode,
      tracking_code: trackingCode,
      qr_code: qrValue,
      barcode: barcodeValue,
      entity_type: 'CARTON',
      status: 'EXPECTED',
      created: true,
      duplicate: false,
    };
  }

  private async generateShipmentCode(tx: Prisma.TransactionClient): Promise<string> {
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
}
