import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
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
    @Body() body: { type: 'RECEIVING' | 'CUSTOMER'; label?: string; orderReference?: string },
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

  // ---- 1+2. receiving article scan ----------------------------------------

  @Post('receiving/sessions/:sessionId/scan-article')
  @RequirePermissions('receiving.execute')
  @ApiOperation({
    summary:
      'Scan one article out of an opened carton into a receiving tote (creates the traceable ArticleUnit).',
  })
  scanArticle(
    @Param('sessionId') sessionId: string,
    @Body() body: { sku: string; containerCode: string; cartonCode?: string },
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

  @Get('shipping/shipments/:code')
  @RequirePermissions('shipping.execute')
  @ApiOperation({ summary: 'Shipping scan: outbound shipment detail (order, articles, tracking).' })
  shippingScan(@Param('code') code: string) {
    return this.fulfillment.shippingScan(code);
  }

  @Post('shipping/shipments/:code/ship')
  @RequirePermissions('shipping.execute')
  @ApiOperation({ summary: 'Dispatch: SHIPPED + audited container cleanup (history kept).' })
  ship(@Param('code') code: string, @Req() req: any) {
    return this.fulfillment.ship(code, this.actor(req));
  }

  // ---- traceability ----------------------------------------------------------------

  @Get('articles/:code/trace')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Full traceability chain for one article (Card -> ... -> SHIPPED).' })
  trace(@Param('code') code: string) {
    return this.fulfillment.articleTrace(code);
  }
}
