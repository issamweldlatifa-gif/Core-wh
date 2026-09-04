import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { StationCapability, StationDepartment, StationStatus } from '@prisma/client';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { OperationsService } from './operations.service';
import { StationsService } from './stations.service';
import { CorrectionsService } from './corrections.service';
import { TerminalService } from './terminal.service';
import { RequireApplication } from '../../common/decorators/require-application.decorator';

/**
 * WAREHOUSE OS operational API.
 *
 * Two audiences, one backend (§49):
 *   - `/terminal/*` serves the Worker Terminal (identity + task routing),
 *   - `/operations/*`, `/stations/*`, `/corrections/*` serve the Admin
 *     Control Center.
 *
 * Every route is permission-guarded server side (§9/§41); the frontend hiding
 * things is a UX nicety, never the control.
 */

function actorOf(req: any) {
  const user = req.user ?? {};
  return {
    id: String(user.id ?? user.sub ?? 'unknown'),
    ip: req.ip ?? undefined,
    permissions: (user.permissions ?? []) as string[],
  };
}

@ApiTags('Worker Terminal')
@ApiBearerAuth()
@Controller('terminal')
@RequireApplication('WORKER_NATIVE')
export class TerminalController {
  constructor(private readonly terminal: TerminalService) {}

  @Get('context')
  @ApiOperation({ summary: 'Resolve worker identity, permitted tasks, station and active session.' })
  context(@Req() req: any) {
    const a = actorOf(req);
    return this.terminal.context({ id: a.id, permissions: a.permissions });
  }

  // COMMAND #3 — the worker's own assigned tasks (strictly self-scoped).
  @Get('assignments')
  @ApiOperation({ summary: 'Assigned tasks for the current worker (open + recent).' })
  assignments(@Req() req: any) {
    return this.terminal.myAssignments(actorOf(req).id);
  }

  @Post('assignments/:id/complete')
  @ApiOperation({ summary: 'Mark one of my assigned tasks as done (with optional note).' })
  completeAssignment(@Param('id') id: string, @Body() body: { note?: string }, @Req() req: any) {
    return this.terminal.completeAssignment(actorOf(req).id, id, body?.note);
  }
}

@ApiTags('Stations')
@ApiBearerAuth()
@Controller('stations')
@RequireApplication('ADMIN_WEB')
export class StationsController {
  constructor(private readonly stations: StationsService) {}

  @Get()
  @RequirePermissions('stations.view')
  @ApiOperation({ summary: 'List stations.' })
  @ApiQuery({ name: 'department', required: false })
  @ApiQuery({ name: 'status', required: false })
  list(@Query('department') department?: StationDepartment, @Query('status') status?: StationStatus) {
    return this.stations.list({ department, status });
  }

  @Get(':id')
  @RequirePermissions('stations.view')
  @ApiOperation({ summary: 'Get one station by id or code.' })
  findOne(@Param('id') id: string) {
    return this.stations.findOne(id);
  }

  @Post()
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Create a station.' })
  create(
    @Body()
    body: {
      code: string;
      name: string;
      department: StationDepartment;
      capabilities?: StationCapability[];
      deviceId?: string | null;
      warehouseId?: string | null;
    },
    @Req() req: any,
  ) {
    return this.stations.create(body, actorOf(req));
  }

  @Patch(':id')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Update a station.' })
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; capabilities?: StationCapability[]; deviceId?: string | null },
    @Req() req: any,
  ) {
    return this.stations.update(id, body, actorOf(req));
  }

  @Post(':id/status')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Change station status (ACTIVE/INACTIVE/MAINTENANCE).' })
  setStatus(@Param('id') id: string, @Body() body: { status: StationStatus }, @Req() req: any) {
    return this.stations.setStatus(id, body.status, actorOf(req));
  }

  @Post(':id/assign')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Assign or clear (workerId=null) the station worker.' })
  assign(@Param('id') id: string, @Body() body: { workerId: string | null }, @Req() req: any) {
    return this.stations.assign(id, body.workerId ?? null, actorOf(req));
  }
}

@ApiTags('Operations (Admin Control Center)')
@ApiBearerAuth()
@Controller('operations')
@RequireApplication('ADMIN_WEB')
export class OperationsController {
  constructor(
    private readonly ops: OperationsService,
    private readonly correctionsSvc: CorrectionsService,
  ) {}

  @Get('overview')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Live operational overview: stations, sessions, exceptions.' })
  overview() {
    return this.ops.overview();
  }

  @Get('workers')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Workers with station and today\'s activity.' })
  workers() {
    return this.ops.workers();
  }

  @Get('activity')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Live Activity feed: recent operational events from the audit trail.' })
  @ApiQuery({ name: 'limit', required: false })
  activity(@Query('limit') limit?: string) {
    return this.ops.activity(limit ? Number(limit) : 50);
  }

  @Get('tasks')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Workforce task registry with real station/executor/open-work counts.' })
  tasks() {
    return this.ops.taskBoard();
  }

  @Get('receiving-containers')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Receiving Containers/Totes board with capacity, count, worker, station.' })
  receivingContainers() {
    return this.ops.containersBoard({ type: 'RECEIVING', take: 100 });
  }

  @Get('customer-bins')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Customer Bins board with expected/count, customer, order.' })
  customerBins() {
    return this.ops.containersBoard({ type: 'CUSTOMER', take: 100 });
  }

  @Get('containers/:code')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Container detail: contents + provenance links (container → article → carton → session → order → bin → shipment).' })
  container(@Param('code') code: string) {
    return this.ops.containerDetail(code);
  }

  @Get('workers/:id')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'One worker and their recent sessions.' })
  worker(@Param('id') id: string) {
    return this.ops.worker(id);
  }

  @Get('sessions/:id')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Full session drill-down with a merged operational timeline.' })
  session(@Param('id') id: string) {
    return this.ops.session(id);
  }

  @Get('exceptions')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Exception Center feed.' })
  @ApiQuery({ name: 'status', required: false, enum: ['OPEN', 'RESOLVED', 'REJECTED', 'ALL'] })
  exceptions(@Query('status') status?: 'OPEN' | 'RESOLVED' | 'REJECTED' | 'ALL') {
    return this.ops.exceptions(status ?? 'OPEN');
  }

  // ---- Corrections (audited, never destructive) --------------------------

  @Get('corrections')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'List applied corrections with before/after snapshots.' })
  @ApiQuery({ name: 'sessionId', required: false })
  corrections(@Query('sessionId') sessionId?: string) {
    return this.correctionsSvc.list({ sessionId });
  }

  @Post('corrections/reverse-carton')
  @RequirePermissions('operations.correct')
  @ApiOperation({ summary: 'Reverse a received carton (history preserved).' })
  reverseCarton(@Body() body: { receivingCartonId: string; reason: string }, @Req() req: any) {
    return this.correctionsSvc.reverseCarton(body.receivingCartonId, body.reason, actorOf(req));
  }

  @Post('corrections/correct-quantity')
  @RequirePermissions('operations.correct')
  @ApiOperation({ summary: 'Correct a received product quantity (history preserved).' })
  correctQuantity(
    @Body() body: { receivingProductId: string; newQuantity: number; reason: string },
    @Req() req: any,
  ) {
    return this.correctionsSvc.correctQuantity(body.receivingProductId, body.newQuantity, body.reason, actorOf(req));
  }

  @Post('corrections/resolve-exception')
  @RequirePermissions('operations.correct')
  @ApiOperation({ summary: 'Resolve an exception with a mandatory audited reason.' })
  resolveException(
    @Body() body: { discrepancyId: string; resolution?: string; reason: string },
    @Req() req: any,
  ) {
    return this.correctionsSvc.resolveException(body.discrepancyId, body.resolution ?? '', body.reason, actorOf(req));
  }

  @Post('corrections/reopen-session')
  @RequirePermissions('operations.correct')
  @ApiOperation({ summary: 'Reopen a completed session (history preserved).' })
  reopenSession(@Body() body: { sessionId: string; reason: string }, @Req() req: any) {
    return this.correctionsSvc.reopenSession(body.sessionId, body.reason, actorOf(req));
  }

  // ---- Admin Data Control (soft-void; view to read, correct to act) -------

  @Get('data-control/search')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Search operational records by code or info (WAR/CTN/RCN/BIN/ART/ORD...).' })
  @ApiQuery({ name: 'q', required: true })
  dataControlSearch(@Query('q') q?: string) {
    return this.ops.dataControlSearch(q ?? '');
  }

  @Get('data-control/voided')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Recent admin soft-voids from the audit trail.' })
  dataControlVoided() {
    return this.ops.dataControlVoided();
  }

  @Post('data-control/void')
  @RequirePermissions('operations.correct')
  @ApiOperation({ summary: 'Soft-void an operational record (admin only, audited, never deletes).' })
  dataControlVoid(
    @Body()
    body: {
      kind: 'arrival' | 'order' | 'container' | 'article' | 'carton';
      id?: string;
      code: string;
      reason?: string;
    },
    @Req() req: any,
  ) {
    return this.ops.dataControlVoid(body, actorOf(req));
  }

  // ---- Worker Control (COMMAND #3; admin only — users.manage) --------------

  @Post('workers/:id/block')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Block a worker (LOCKED — temporary, reversible, login refused).' })
  blockWorker(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: any) {
    return this.ops.blockWorker(id, actorOf(req), body?.reason);
  }

  @Post('workers/:id/unblock')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Unblock a worker (LOCKED → ACTIVE).' })
  unblockWorker(@Param('id') id: string, @Req() req: any) {
    return this.ops.unblockWorker(id, actorOf(req));
  }

  @Post('workers/:id/remove')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Remove a worker permanently (DISABLED — account kept for audit; open tasks cancelled).' })
  removeWorker(@Param('id') id: string, @Body() body: { reason: string }, @Req() req: any) {
    return this.ops.removeWorker(id, actorOf(req), body?.reason);
  }

  // ---- Worker task assignments (admin side) ---------------------------------

  @Get('worker-tasks')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'List worker task assignments (optionally filtered).' })
  @ApiQuery({ name: 'workerId', required: false })
  @ApiQuery({ name: 'status', required: false })
  workerTasks(@Query('workerId') workerId?: string, @Query('status') status?: string) {
    return this.ops.workerTasksList(workerId, status);
  }

  @Post('worker-tasks')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Assign a specific task to a worker.' })
  workerTaskCreate(
    @Body()
    body: { workerId: string; title: string; description?: string; relatedType?: string; relatedCode?: string },
    @Req() req: any,
  ) {
    return this.ops.workerTaskCreate(body, actorOf(req));
  }

  @Post('worker-tasks/:id/cancel')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Cancel an open assigned task (with optional reason).' })
  workerTaskCancel(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: any) {
    return this.ops.workerTaskCancel(id, actorOf(req), body?.reason);
  }
}
