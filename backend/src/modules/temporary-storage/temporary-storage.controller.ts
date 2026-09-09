import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { TemporaryStorageService } from './temporary-storage.service';
import { ListIntakesQueryDto, ManualIntakeDto, StageIntakeDto } from './dto/intake.dto';

/**
 * Temporary Storage API (JWT, WORKER_NATIVE).
 *
 * Backend/workflow surface for Receiving Output B (Produit + Carte) ONLY.
 * No worker UI is built in this step — these endpoints are the station's
 * input contract (intake), placement contract (stage) and forward contract
 * (ready -> Sorting). Cartons are rejected by the workflow guard: their flow
 * ended at the verification report.
 *
 * Permissions reuse the existing stowing/receiving keys on purpose (no new
 * permission catalog entries, so existing seeded databases keep working):
 *   - manual re-push: receiving.execute (Receiving Output B ownership)
 *   - read: stowing.view · stage/ready/move: stowing.execute
 */
@ApiTags('Temporary Storage')
@ApiBearerAuth()
@Controller('temporary-storage')
@RequireApplication('WORKER_NATIVE')
export class TemporaryStorageController {
  constructor(private readonly temp: TemporaryStorageService) {}

  private actor(req: any) {
    const user = req.user;
    return { id: String(user?.id ?? user?.sub ?? 'unknown'), ip: req.ip ?? null };
  }

  @Post('intakes')
  @RequirePermissions('receiving.execute')
  @ApiOperation({
    summary:
      'Manual re-push (supervisor recovery): hand one CONFIRMED product line of a submitted report to Temporary Storage. ' +
      'Normal flow needs no call — report submit auto-creates the intakes.',
  })
  manualIntake(@Body() body: ManualIntakeDto, @Req() req: any) {
    return this.temp.manualIntake(body, this.actor(req));
  }

  @Get('intakes')
  @RequirePermissions('stowing.view')
  @ApiOperation({ summary: 'List Temporary Storage product intakes (product tracking).' })
  list(@Query() q: ListIntakesQueryDto) {
    return this.temp.listIntakes({ status: q.status, q: q.q, receivingSessionId: q.receivingSessionId, take: q.take });
  }

  @Get('intakes/session/:sessionId')
  @RequirePermissions('stowing.view')
  @ApiOperation({ summary: 'Intakes handed from one receiving session (Receiving -> Temporary Storage trace).' })
  forSession(@Param('sessionId') sessionId: string) {
    return this.temp.intakesForSession(sessionId);
  }

  @Get('intakes/:code')
  @RequirePermissions('stowing.view')
  @ApiOperation({ summary: 'Intake detail + workflow history.' })
  detail(@Param('code') code: string) {
    return this.temp.getIntake(code);
  }

  @Post('intakes/:code/stage')
  @RequirePermissions('stowing.execute')
  @ApiOperation({
    summary:
      'RECEIVED -> STAGED: place the product intake at a STAGING station / zone / section / location. ' +
      'Station and zone are resolved server-side; carton identifiers are rejected.',
  })
  stage(@Param('code') code: string, @Body() body: StageIntakeDto, @Req() req: any) {
    return this.temp.stageIntake(code, body ?? {}, this.actor(req));
  }

  @Post('intakes/:code/ready-for-sorting')
  @RequirePermissions('stowing.execute')
  @ApiOperation({ summary: 'STAGED -> READY_FOR_SORTING: the intake is ready for the Sorting pull.' })
  ready(@Param('code') code: string, @Req() req: any) {
    return this.temp.markReadyForSorting(code, this.actor(req));
  }

  @Post('intakes/:code/move-to-sorting')
  @RequirePermissions('stowing.execute')
  @ApiOperation({ summary: 'READY_FOR_SORTING -> MOVED_TO_SORTING: the intake leaves Temporary Storage toward Sorting.' })
  move(@Param('code') code: string, @Req() req: any) {
    return this.temp.moveToSorting(code, this.actor(req));
  }
}
