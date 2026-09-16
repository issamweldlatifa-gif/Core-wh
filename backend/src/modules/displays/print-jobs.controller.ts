import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { RequireAnyPermission } from '../../common/decorators/require-permissions.decorator';
import { DisplaysService } from './displays.service';

/**
 * WORKER PRINT AGENT API (open item 2026-09-16).
 *
 * Why it exists: a label can be printed from ANY screen (the station display,
 * the admin web, later the terminal), but the physical printer often belongs to
 * the operator's handheld (PM-241-BT paired to the CT40). The display cannot
 * reach that Bluetooth link; the handheld can.
 *
 * Security model — deliberately NOT the display token:
 *  - the agent authenticates as a normal WORKER (existing JWT + application
 *    guard + permission), so no shared secret travels to a phone;
 *  - it only ever sees print jobs of the stations ASSIGNED to that worker
 *    (`Station.assignedWorkerId` — the existing assignment, nothing new);
 *  - it can only resolve QUEUED jobs, once; the display/admin side stays the
 *    only place a job can be CREATED.
 */
/** Any of the six shop-floor execution rights opens the agent; the assignment
 * (`Station.assignedWorkerId`) decides WHICH labels someone sees. An
 * admin-only account with no execution permission still cannot use it. */
const EXECUTION_PERMISSIONS = [
  'receiving.execute',
  'stowing.execute',
  'picking.execute',
  'packing.execute',
  'shipping.execute',
  'batch.execute',
];

class PrintResultDto {
  @IsIn(['PRINTED', 'FAILED']) status!: 'PRINTED' | 'FAILED';
  @IsOptional() @IsString() @MaxLength(300) error?: string;
}

function workerOf(req: any): string {
  const user = req.user ?? {};
  return String(user.id ?? user.sub ?? '');
}

@ApiTags('Station Display — Worker print agent')
@ApiBearerAuth()
@Controller('print-jobs')
@RequireApplication('WORKER_NATIVE')
export class StationPrintJobsController {
  constructor(private readonly displays: DisplaysService) {}

  @Get('pending')
  @RequireAnyPermission(...EXECUTION_PERMISSIONS)
  @ApiOperation({
    summary:
      'Labels queued for a handheld/bridge printer at a station assigned to this worker (oldest first).',
  })
  async pending(@Req() req: any, @Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : undefined;
    const safe = Number.isFinite(parsed as number) ? (parsed as number) : undefined;
    return this.displays.pendingPrintJobsForWorker(workerOf(req), { limit: safe });
  }

  @Post(':id/result')
  @RequireAnyPermission(...EXECUTION_PERMISSIONS)
  @ApiOperation({ summary: 'Report the outcome of a claimed label (PRINTED / FAILED) — once.' })
  async result(@Param('id') id: string, @Body() dto: PrintResultDto, @Req() req: any) {
    return this.displays.printJobResultForWorker(workerOf(req), id, dto);
  }
}
