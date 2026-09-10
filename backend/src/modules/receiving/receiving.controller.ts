import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { ReceivingService, CardConfirmInput, ProductConfirmInput, MismatchInput } from './receiving.service';
import { ReceivingReportsService, SaveDraftInput, DamageInput } from './receiving-reports.service';
import { FlagInputDto, ResolveDiscrepancyInputDto, SessionStartInputDto } from './receiving.dto';

/**
 * Receiving Terminal API (JWT).
 *
 * Card-based receiving (device-side matching rebuild):
 *
 *   CRM ──▶ PRODUCT CARD / CARTON CARD (expected data, immutable)
 *        ──▶ RECEIVING session (worker downloads the card data)
 *        ──▶ [ PRODUIT ] lane: scan / OCR → device-side match → CONFIRM
 *        ──▶ [ CARTON ]  lane: scan → device-side match → CONFIRM
 *
 * The worker device matches the scanned identifier against the expected card
 * data locally; these endpoints are the backend's FINAL validation,
 * persistence, state update, duplicate/conflict protection and the worker
 * activity log. A mismatch never confirms and never completes — it is
 * logged. Expected card data is never modified.
 */
@ApiTags('Receiving')
@ApiBearerAuth()
@Controller('receiving')
@RequireApplication('WORKER_NATIVE')
export class ReceivingController {
  constructor(
    private readonly receiving: ReceivingService,
    private readonly reports: ReceivingReportsService,
  ) {}

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

  // ----------------------------------------------------------------
  // RECEIVING HOME — automatic-dispatch worker feed (card rebuild).
  //
  // GET  /receiving/home            → the worker's PRODUCT + CARTON cards
  //                                    and live counters (no arrival picker)
  // POST /receiving/home/product    → scan/confirm a PRODUCT card
  // POST /receiving/home/carton     → scan/confirm a CARTON card
  // POST /receiving/home/mismatch   → log a device-side MISMATCH
  //
  // The device performs the matching against the downloaded cards; the
  // backend resolves the owning arrival/session automatically and remains
  // the final authority for validation, persistence, duplicate protection
  // and the worker activity log.
  // ----------------------------------------------------------------
  @Get('home')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'Receiving Home: the worker’s available PRODUCT and CARTON cards + live counters.' })
  home(@Req() req: any) {
    return this.receiving.workerHome(this.actor(req).id, this.actor(req));
  }

  @Post('home/product')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Confirm a PRODUCT card scanned from Receiving Home (auto-resolves the session).' })
  homeProduct(@Body() body: ProductConfirmInput, @Req() req: any) {
    return this.receiving.homeConfirmProduct(body, this.actor(req));
  }

  @Post('home/carton')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Confirm a CARTON card scanned from Receiving Home (auto-resolves the session).' })
  homeCarton(@Body() body: CardConfirmInput, @Req() req: any) {
    return this.receiving.homeConfirmCarton(body, this.actor(req));
  }

  @Post('home/mismatch')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Log a device-side MISMATCH from Receiving Home (nothing confirmed, nothing completed).' })
  homeMismatch(@Body() body: MismatchInput, @Req() req: any) {
    return this.receiving.homeMismatch(body, this.actor(req));
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
    @Body() body: SessionStartInputDto,
    @Req() req: any,
  ) {
    return this.receiving.start(idOrCode, this.actor(req), {
      deviceType: body?.deviceType ?? null,
      deviceName: body?.deviceName ?? null,
      scanSource: body?.scanSource ?? null,
    });
  }

  // ORDER 04 — direct reportable-session resolution (one call instead of the
  // arrivals + per-arrival active probes). Declared BEFORE 'sessions/:id' so
  // 'active' is never captured as an :id.
  @Get('sessions/active')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'ORDER 04: the reportable receiving session (open, else latest completed with an actionable report), or null.' })
  activeSession() {
    return this.receiving.activeReceivingSession();
  }

  @Get('sessions/history')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'REPORT HISTORY (settings only): latest reported sessions, newest first.' })
  history() {
    return this.receiving.reportHistory();
  }

  @Get('sessions/:id')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'Full receiving session state: expected product cards + carton cards + tally (device-side matching data).' })
  session(@Param('id') id: string) {
    return this.receiving.sessionDetail(id);
  }

  @Post('sessions/:id/confirm-product')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Confirm a PRODUCT card matched on the device (QR / barcode / OCR SKU / reference). Final server validation + persistence + worker log.' })
  confirmProduct(
    @Param('id') id: string,
    @Body() body: ProductConfirmInput,
    @Req() req: any,
  ) {
    return this.receiving.confirmProduct(id, body, this.actor(req));
  }

  @Post('sessions/:id/confirm-carton')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Confirm a CARTON card matched on the device (carton ref / QR / barcode / tracking). Final server validation + persistence + worker log.' })
  confirmCarton(
    @Param('id') id: string,
    @Body() body: CardConfirmInput,
    @Req() req: any,
  ) {
    return this.receiving.confirmCarton(id, body, this.actor(req));
  }

  @Post('sessions/:id/mismatch')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Log a device-side MISMATCH (failure logged; nothing confirmed, nothing completed).' })
  mismatch(
    @Param('id') id: string,
    @Body() body: MismatchInput,
    @Req() req: any,
  ) {
    return this.receiving.reportMismatch(id, body, this.actor(req));
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
  flag(@Param('id') id: string, @Body() body: FlagInputDto, @Req() req: any) {
    return this.receiving.flag(id, body, this.actor(req));
  }

  @Post('discrepancies/:id/resolve')
  @RequirePermissions('receiving.resolve_discrepancy')
  resolve(@Param('id') id: string, @Body() body: ResolveDiscrepancyInputDto, @Req() req: any) {
    return this.receiving.resolveDiscrepancy(id, body.resolution ?? 'Resolved', this.actor(req));
  }

  @Post('sessions/:id/complete')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Complete receiving (full match -> RECEIVED; else needs supervisor). Duplicate completion is rejected.' })
  complete(@Param('id') id: string, @Req() req: any) {
    return this.receiving.complete(id, this.actor(req));
  }

  // ----------------------------------------------------------------
  // ORDER 01 — Rapport de Confirme (receiving verification report).
  // Additive worker endpoints; existing flows untouched.
  // ----------------------------------------------------------------
  @Get('sessions/:id/report')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'ORDER 01: verification report view (auto totals + lines + manual fields + photos).' })
  report(@Param('id') id: string, @Req() req: any) {
    return this.reports.getReport(id, this.actor(req));
  }

  @Put('sessions/:id/report')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'ORDER 01: save report draft (description / observation / photos).' })
  saveReport(@Param('id') id: string, @Body() body: SaveDraftInput, @Req() req: any) {
    return this.reports.saveDraft(id, body ?? {}, this.actor(req));
  }

  @Post('sessions/:id/lines/:lineId/damage')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'ORDER 01: declare damaged units on a verification line.' })
  markDamage(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: DamageInput,
    @Req() req: any,
  ) {
    return this.reports.markDamage(id, lineId, body ?? {}, this.actor(req));
  }

  @Post('sessions/:id/report/submit')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'ORDER 01: CONFIRMER ET ENVOYER — lock the report, persist results, notify admins.' })
  submitReport(@Param('id') id: string, @Body() body: SaveDraftInput | undefined, @Req() req: any) {
    return this.reports.submitReport(id, body ?? {}, this.actor(req));
  }
}
