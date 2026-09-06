import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { FulfillmentService } from './fulfillment.service';

/**
 * Operational flow API (JWT): containers, article scans, sorting/storage,
 * customer order sorting, packing and shipping. One controller so the whole
 * SCAN -> DECISION -> ACTION -> CONFIRMATION contract lives in one place;
 * each stage is gated by its own existing permission key.
 */
@ApiTags('Fulfillment')
@ApiBearerAuth()
@Controller('fulfillment')
// Dual surface: the Worker Terminal scans here; the Admin traceability board
// reads containers/shipments here (C-3 — explicit, no longer implicit).
@RequireApplication('WORKER_NATIVE', 'ADMIN_WEB')
export class FulfillmentController {
  constructor(private readonly fulfillment: FulfillmentService) {}

  private actor(req: any) {
    const user = req.user;
    return { id: String(user?.id ?? user?.sub ?? 'unknown'), ip: req.ip ?? null };
  }

  // ---- containers (QR totes + customer bins) ------------------------------

  @Post('containers')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Create an operational container (RECEIVING tote or CUSTOMER bin).' })
  createContainer(
    @Body() body: { type: 'RECEIVING' | 'CUSTOMER'; label?: string; orderReference?: string; capacity?: number },
    @Req() req: any,
  ) {
    return this.fulfillment.createContainer(body, this.actor(req));
  }

  @Get('containers')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'List operational containers.' })
  listContainers(@Query('type') type?: string, @Query('status') status?: string) {
    return this.fulfillment.listContainers({ type, status });
  }

  @Get('containers/:code')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'Container detail: order, label, contained articles.' })
  container(@Param('code') code: string) {
    return this.fulfillment.containerDetail(code);
  }

  @Post('containers/:code/close')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Manually close a receiving tote at ANY count (no minimum) — it becomes READY_FOR_SORTING.' })
  closeContainer(@Param('code') code: string, @Req() req: any) {
    return this.fulfillment.closeContainer(code, this.actor(req));
  }

  @Post('containers/:code/stage')
  @RequirePermissions('receiving.execute')
  @ApiOperation({
    summary:
      'Stage a CLOSED (READY_FOR_SORTING) tote to its temporary storage station/zone (Order §11). ' +
      'The station is resolved server-side from the worker station or the given stationCode.',
  })
  stageContainer(
    @Param('code') code: string,
    @Body() body: { stationCode?: string },
    @Req() req: any,
  ) {
    return this.fulfillment.stageContainer(code, this.actor(req), { stationCode: body?.stationCode });
  }

  // ---- 1+2. receiving article scan ----------------------------------------

  @Post('receiving/sessions/:sessionId/scan-article')
  @RequirePermissions('receiving.execute')
  @ApiOperation({
    summary:
      'Scan one article out of an opened carton into a receiving tote (creates the traceable ArticleUnit).',
  })
  scanArticle(
    @Param('sessionId') sessionId: string,
    @Body() body: { sku: string; containerCode: string; cartonCode?: string; operationId?: string },
    @Req() req: any,
  ) {
    return this.fulfillment.scanArticleAtReceiving(sessionId, body, this.actor(req));
  }

  // ---- 3. sorting + storage -------------------------------------------------

  @Get('sorting/articles/:code')
  @RequirePermissions('stowing.execute')
  @ApiOperation({ summary: 'Sorting scan: system resolves the configured destination for the article.' })
  sortingScan(@Param('code') code: string) {
    return this.fulfillment.sortingScanArticle(code);
  }

  @Post('sorting/store')
  @RequirePermissions('stowing.execute')
  @ApiOperation({ summary: 'Confirm storage: article + scanned location -> STORED (zone validated).' })
  sortingStore(@Body() body: { articleCode: string; locationCode: string }, @Req() req: any) {
    return this.fulfillment.sortingStore(body, this.actor(req));
  }

  // ---- 4. customer order sorting --------------------------------------------

  @Get('order-sorting/articles/:code')
  @RequirePermissions('picking.execute')
  @ApiOperation({ summary: 'Order-sorting scan: system matches article -> customer order -> bin.' })
  orderSortingScan(@Param('code') code: string) {
    return this.fulfillment.orderSortingScanArticle(code);
  }

  @Post('order-sorting/assign')
  @RequirePermissions('picking.execute')
  @ApiOperation({ summary: 'Confirm: article into the scanned customer bin (wrong bin rejected).' })
  orderSortingAssign(
    @Body() body: { articleCode: string; containerCode: string },
    @Req() req: any,
  ) {
    return this.fulfillment.orderSortingAssign(body, this.actor(req));
  }

  // ---- 5. packing -------------------------------------------------------------

  @Get('packing/containers/:code')
  @RequirePermissions('packing.execute')
  @ApiOperation({ summary: 'Packing scan: bin -> customer + order + required items for verification.' })
  packingScan(@Param('code') code: string) {
    return this.fulfillment.packingScanContainer(code);
  }

  @Post('packing/containers/:code/pack')
  @RequirePermissions('packing.execute')
  @ApiOperation({ summary: 'Pack the verified bin: creates the outbound shipment + internal label.' })
  pack(@Param('code') code: string, @Req() req: any) {
    return this.fulfillment.pack(code, this.actor(req));
  }

  // ---- 6. shipping --------------------------------------------------------------

  @Get('outbound-shipments')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Recent outbound shipments (admin board).' })
  listOutboundShipments(@Query('status') status?: string, @Query('q') q?: string) {
    return this.fulfillment.listOutboundShipments({ status, q });
  }

  @Get('shipping/shipments/:code')
  @RequirePermissions('shipping.execute')
  @ApiOperation({
    summary:
      'Shipping scan (Order §17): scan the customer container QR (AYROVI:…) or the OUT- label -> ' +
      'the verification card (customer, container, status, contents).',
  })
  shippingScan(@Param('code') code: string) {
    return this.fulfillment.shippingScan(code);
  }

  @Post('shipping/shipments/:code/verify')
  @RequirePermissions('shipping.execute')
  @ApiOperation({
    summary:
      'Pre-dispatch verification (Order §17): verify customer + container + status and create a ' +
      '10-minute, content-hash-bound verification. Shipping without it is rejected.',
  })
  shippingVerify(@Param('code') code: string, @Req() req: any) {
    return this.fulfillment.shippingVerify(code, this.actor(req));
  }

  @Post('shipping/shipments/:code/ship')
  @RequirePermissions('shipping.execute')
  @ApiOperation({
    summary:
      'Dispatch (Order §17): SHIPPED + audited container cleanup — only with a valid, unexpired, ' +
      'content-bound verification (the SHIPPING click).',
  })
  ship(@Param('code') code: string, @Req() req: any) {
    return this.fulfillment.ship(code, this.actor(req));
  }

  // ---- 8. bordereau (Order §18) ------------------------------------------------

  @Get('shipping/bordereau/search')
  @RequirePermissions('operations.view')
  @ApiOperation({
    summary:
      'Bordereau search (Order §18): find shipping documents by customer name/surname, ' +
      'order reference, customer reference, shipment number, tracking or container QR.',
  })
  bordereauSearch(@Query('q') q: string) {
    return this.fulfillment.searchBordereau(q ?? '');
  }

  @Get('shipping/bordereau/:code')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'The printable bordereau for a shipment / container QR (Order §18).' })
  bordereau(@Param('code') code: string) {
    return this.fulfillment.bordereau(code);
  }

  // ---- REPORT PROBLEM (Order §14) — available at every stage --------------

  @Post('exceptions')
  @ApiOperation({
    summary:
      'REPORT PROBLEM (Order §14): a worker at ANY stage reports an operational problem. ' +
      'Creates a real OperationalException row, immediately visible in Admin, audited.',
  })
  reportProblem(
    @Body() body: { stage: string; entityType?: string; entityCode?: string; type?: string; reason: string },
    @Req() req: any,
  ) {
    return this.fulfillment.reportProblem(body, this.actor(req));
  }

  @Get('exceptions')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Admin: unified operational exceptions across all stages.' })
  listExceptions(@Query('status') status?: string, @Query('q') q?: string) {
    return this.fulfillment.listExceptions({ status, q });
  }

  @Post('exceptions/:id/resolve')
  @RequirePermissions('operations.correct')
  @ApiOperation({ summary: 'Admin: resolve or reject a reported problem (audited).' })
  resolveException(
    @Param('id') id: string,
    @Body() body: { resolution: 'RESOLVED' | 'REJECTED'; note?: string },
    @Req() req: any,
  ) {
    return this.fulfillment.resolveException(id, body.resolution, body.note ?? '', this.actor(req));
  }

  // ---- traceability ----------------------------------------------------------------

  @Get('articles')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Recent article units (admin traceability board).' })
  listArticles(@Query('status') status?: string, @Query('q') q?: string) {
    return this.fulfillment.listArticles({ status, q });
  }

  @Get('articles/:code/trace')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Full traceability chain for one article (Card -> ... -> SHIPPED).' })
  trace(@Param('code') code: string) {
    return this.fulfillment.articleTrace(code);
  }
}
