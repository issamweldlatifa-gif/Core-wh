import { Body, Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CartonCardsService } from './carton-cards.service';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Carton Cards')
@ApiBearerAuth()
@Controller('carton-cards')
export class CartonCardsController {
  constructor(
    private readonly cartons: CartonCardsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequirePermissions('shipments.view')
  @ApiOperation({ summary: 'List carton cards (CARTON FIX: shows CARTON identity, suivi, QR, barcode, products count)' })
  async list() {
    const cartons = await this.prisma.warehouseCarton.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { shipment: { select: { code: true, trackingNumber: true, suiviCode: true, sourceProject: true } } },
    });
    return cartons.map((c: any) => ({
      id: c.id,
      externalCartonId: c.externalCartonId,
      cartonReference: c.cartonReference,
      entityType: c.entityType ?? 'CARTON',
      suiviCode: c.suiviCode ?? c.trackingCode,
      trackingCode: c.trackingCode ?? c.suiviCode,
      trackingNumber: c.trackingCode ?? c.suiviCode,
      qrCodeValue: c.qrCodeValue,
      barcodeValue: c.barcodeValue,
      productCount: c.productCount,
      sourceProject: c.sourceProject ?? c.shipment?.sourceProject,
      status: c.status,
      shipmentCode: c.shipment?.code,
      createdAt: c.createdAt,
    }));
  }

  @Get(':idOrCode')
  @RequirePermissions('shipments.view')
  @ApiOperation({ summary: 'Get carton card detail (CARTON FIX)' })
  async detail(@Param('idOrCode') idOrCode: string) {
    const carton = await this.prisma.warehouseCarton.findFirst({
      where: { OR: [{ id: idOrCode }, { externalCartonId: idOrCode }] },
      include: {
        shipment: true,
        arrivalItems: true,
      },
    });
    if (!carton) {
      return { error: 'Carton not found' };
    }
    const cAny = carton as any;
    return {
      id: cAny.id,
      externalCartonId: cAny.externalCartonId,
      cartonReference: cAny.cartonReference,
      entityType: cAny.entityType ?? 'CARTON',
      suiviCode: cAny.suiviCode,
      trackingCode: cAny.trackingCode ?? cAny.suiviCode,
      qrCodeValue: cAny.qrCodeValue,
      barcodeValue: cAny.barcodeValue,
      productCount: cAny.productCount,
      sourceProject: cAny.sourceProject,
      metadata: cAny.metadata,
      originalPayload: cAny.originalPayload,
      status: cAny.status,
      shipment: cAny.shipment ? {
        code: cAny.shipment.code,
        trackingNumber: cAny.shipment.trackingNumber,
        suiviCode: cAny.shipment.suiviCode,
        sourceProject: cAny.shipment.sourceProject,
      } : null,
      products: (cAny.arrivalItems ?? []).map((it: any) => ({
        id: it.id,
        sku: it.sku,
        reference: it.reference,
        productName: it.productName,
        quantity: it.quantity,
      })),
    };
  }
}
