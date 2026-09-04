import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ReceivingService } from './receiving.service';
import { RequireApplication } from '../../common/decorators/require-application.decorator';

/**
 * Receiving Terminal API (JWT). Warehouse workers scan cartons/products
 * against the Expected Arrival + Shipment data already stored in the
 * Warehouse. Expected data is never modified by these endpoints.
 */
@ApiTags('Receiving')
@ApiBearerAuth()
@Controller('receiving')
@RequireApplication('WORKER_NATIVE')
export class ReceivingController {
  constructor(private readonly receiving: ReceivingService) {}

  private actor(req: any) {
    const user = req.user;
    const perms: string[] = user?.permissions ?? [];
    return {
      id: String(user?.id ?? user?.sub ?? 'unknown'),
      name: user?.name ?? user?.employeeCode,
      canResolveDiscrepancy: perms.includes('receiving.resolve_discrepancy'),
      ip: req.ip ?? null,
    };
  }

  @Get('arrivals')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'List arrivals awaiting/in receiving (terminal picker).' })
  arrivals() {
    return this.receiving.listForReceiving();
  }

  @Get('arrivals/:idOrCode/active')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'Get the active receiving session for an arrival, if any.' })
  active(@Param('idOrCode') idOrCode: string) {
    return this.receiving.activeSessionForArrival(idOrCode);
  }

  @Post('arrivals/:idOrCode/start')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Start a Receiving Session for an Expected Arrival.' })
  start(
    @Param('idOrCode') idOrCode: string,
    @Body() body: { deviceType?: string; deviceName?: string; scanSource?: string } | undefined,
    @Req() req: any,
  ) {
    return this.receiving.start(idOrCode, this.actor(req), {
      deviceType: body?.deviceType ?? null,
      deviceName: body?.deviceName ?? null,
      scanSource: body?.scanSource ?? null,
    });
  }

  @Get('sessions/:id')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'Full receiving session state (terminal).' })
  session(@Param('id') id: string) {
    return this.receiving.sessionDetail(id);
  }

  @Post('sessions/:id/scan-carton')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Scan/identify a carton by QR/barcode/manual code.' })
  scan(
    @Param('id') id: string,
    @Body() body: { code: string; scanType?: 'QR' | 'BARCODE' | 'MANUAL'; operationId?: string; source?: 'CAMERA' | 'EXTERNAL_SCANNER' | 'MANUAL' },
    @Req() req: any,
  ) {
    return this.receiving.scanCarton(id, body.code, body.scanType ?? 'MANUAL', this.actor(req), body.operationId, body.source);
  }

  @Post('sessions/:id/receive-carton')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Confirm an identified carton physically received.' })
  receiveCarton(
    @Param('id') id: string,
    @Body() body: { cartonId: string; operationId?: string; source?: 'CAMERA' | 'EXTERNAL_SCANNER' | 'MANUAL' },
    @Req() req: any,
  ) {
    return this.receiving.receiveCarton(id, body.cartonId, this.actor(req), body.operationId, body.source);
  }

  @Post('sessions/:id/receive-product')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Scan/receive product units against the Expected Arrival lines.' })
  receiveProduct(
    @Param('id') id: string,
    @Body() body: { sku: string; quantity?: number; source?: 'CAMERA' | 'EXTERNAL_SCANNER' | 'MANUAL' },
    @Req() req: any,
  ) {
    return this.receiving.receiveProduct(id, body.sku, body.quantity ?? 1, this.actor(req), body.source);
  }

  @Post('sessions/:id/pause')
  @RequirePermissions('receiving.execute')
  pause(@Param('id') id: string, @Req() req: any) {
    return this.receiving.pause(id, this.actor(req));
  }

  @Post('sessions/:id/resume')
  @RequirePermissions('receiving.execute')
  resume(@Param('id') id: string, @Req() req: any) {
    return this.receiving.resume(id, this.actor(req));
  }

  @Post('sessions/:id/flag')
  @RequirePermissions('receiving.execute')
  flag(@Param('id') id: string, @Body() body: { code?: string; sku?: string; reason?: string }, @Req() req: any) {
    return this.receiving.flag(id, body, this.actor(req));
  }

  @Post('discrepancies/:id/resolve')
  @RequirePermissions('receiving.resolve_discrepancy')
  resolve(@Param('id') id: string, @Body() body: { resolution?: string }, @Req() req: any) {
    return this.receiving.resolveDiscrepancy(id, body.resolution ?? 'Resolved', this.actor(req));
  }

  @Post('sessions/:id/complete')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Complete receiving (full match -> RECEIVED; else needs supervisor).' })
  complete(@Param('id') id: string, @Req() req: any) {
    return this.receiving.complete(id, this.actor(req));
  }
}
