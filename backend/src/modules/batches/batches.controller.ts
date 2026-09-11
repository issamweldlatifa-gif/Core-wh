import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import {
  BatchCompleteReceivingDto,
  BatchCreateDto,
  BatchDecisionDto,
  BatchReceiveUnitDto,
  BatchSendDto,
  BatchUnitInputDto,
  BatchVoidDto,
} from './dto/batch-card.dto';
import { BatchesService, BatchActor } from './batches.service';

/**
 * AYROVI BATCH API — Phase 2 slice 2 (services + controllers).
 *
 * Surface split (both surfaces declared; granular RBAC on top):
 *   WORKER_NATIVE — create / add units / submit / scan-receive
 *   ADMIN_WEB     — accept / send-to-receiving / void / list & trace
 *
 * Permissions (existing RBAC, seeded): batch.view/create/execute/accept/
 * send/receive/void. The `batch.enabled` flag is enforced in the service
 * for every route (OFF = 403 BATCH_FEATURE_DISABLED everywhere).
 */
@ApiTags('Batches')
@ApiBearerAuth()
@Controller('batches')
@RequireApplication('WORKER_NATIVE', 'ADMIN_WEB')
export class BatchesController {
  constructor(private readonly batches: BatchesService) {}

  private actor(req: any): BatchActor {
    const user = req.user;
    return {
      id: String(user?.id ?? user?.sub ?? 'unknown'),
      name: user?.name ?? user?.employeeCode,
      ip: req.ip ?? null,
    };
  }

  @Post()
  @ApiOperation({ summary: 'Worker creates a batch (+ optional first scan). Idempotent by key.' })
  @RequirePermissions('batch.create')
  create(@Req() req: any, @Body() dto: BatchCreateDto) {
    return this.batches.create(this.actor(req), dto);
  }

  @Get()
  @ApiOperation({ summary: 'List batches (newest first).' })
  @RequirePermissions('batch.view')
  list(@Query('status') status?: string) {
    return this.batches.list({ status });
  }

  @Get(':id')
  @ApiOperation({ summary: 'One batch with customer + items + units.' })
  @RequirePermissions('batch.view')
  get(@Param('id') id: string) {
    return this.batches.get(id);
  }

  @Post(':id/units')
  @ApiOperation({ summary: 'Add ONE physical unit (AYP identity generated). Idempotent by key.' })
  @RequirePermissions('batch.execute')
  addUnit(@Req() req: any, @Param('id') id: string, @Body() dto: BatchUnitInputDto) {
    return this.batches.addUnit(this.actor(req), id, dto);
  }

  @Post(':id/submit')
  @ApiOperation({ summary: 'Worker submits the batch — CREATED → SUBMITTED.' })
  @RequirePermissions('batch.execute')
  submit(@Req() req: any, @Param('id') id: string, @Body() dto: { idempotencyKey: string; note?: string }) {
    return this.batches.submit(this.actor(req), id, dto);
  }

  @Post(':id/accept')
  @ApiOperation({ summary: 'Admin accepts — SUBMITTED → ACCEPTED.' })
  @RequirePermissions('batch.accept')
  accept(@Req() req: any, @Param('id') id: string, @Body() dto: BatchDecisionDto) {
    return this.batches.accept(this.actor(req), id, dto);
  }

  @Post(':id/send')
  @ApiOperation({ summary: 'Admin sends to receiving — ACCEPTED → SENT_TO_RECEIVING.' })
  @RequirePermissions('batch.send')
  send(@Req() req: any, @Param('id') id: string, @Body() dto: BatchSendDto) {
    return this.batches.send(this.actor(req), id, dto);
  }

  @Post(':id/void')
  @ApiOperation({ summary: 'VOID + reason + audit. No real DELETE exists.' })
  @RequirePermissions('batch.void')
  void(@Req() req: any, @Param('id') id: string, @Body() dto: BatchVoidDto) {
    return this.batches.voidBatch(this.actor(req), id, dto);
  }

  @Post(':id/receiving/start')
  @ApiOperation({ summary: 'Receiving station opens the batch.' })
  @RequirePermissions('batch.receive')
  startReceiving(@Req() req: any, @Param('id') id: string) {
    return this.batches.startReceiving(this.actor(req), id);
  }

  @Post(':id/receiving/units')
  @ApiOperation({ summary: 'ONE scan = ONE unit. Echo of a received label is a no-op.' })
  @RequirePermissions('batch.receive')
  receiveUnit(@Req() req: any, @Param('id') id: string, @Body() dto: BatchReceiveUnitDto) {
    return this.batches.receiveUnit(this.actor(req), id, dto);
  }

  @Post(':id/receiving/complete')
  @ApiOperation({ summary: 'Complete — requires EVERY unit received (10/10).' })
  @RequirePermissions('batch.receive')
  completeReceiving(@Req() req: any, @Param('id') id: string, @Body() dto: BatchCompleteReceivingDto) {
    return this.batches.completeReceiving(this.actor(req), id, dto);
  }
}
