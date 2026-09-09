import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AcceptStagingDto } from './accept-staging.dto';
import { WorkflowService } from './workflow.service';

function actorOf(req: any) {
  const user = req.user ?? {};
  return {
    id: String(user.id ?? user.sub ?? 'unknown'),
    ip: req.ip ?? undefined,
  };
}

/**
 * Station-chain workflow API (Phase 2: Receiving -> Temporary Storage, Product Flow).
 *
 * Product Flow ONLY (Produit + Carte): cartons end at the report and never
 * appear here. Backend destination only: no station UI in this phase. Every
 * route is permission-guarded server side; existing station permissions are
 * reused on purpose (stations.view / stations.manage) so the phase works on
 * every environment without a permission re-seed.
 */
@ApiTags('Workflow')
@ApiBearerAuth()
@Controller('workflow')
@RequireApplication('ADMIN_WEB')
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Get('chain')
  @RequirePermissions('stations.view')
  @ApiOperation({ summary: 'Official station chain with per-station input contracts.' })
  chain() {
    return this.workflow.chain();
  }

  @Get('temporary-storage/inbox')
  @RequirePermissions('stations.view')
  @ApiOperation({
    summary:
      'Temporary Storage inbox: CONFIRMED product moves handed off by Receiving (never cartons).',
  })
  inbox() {
    return this.workflow.stagingInbox();
  }

  @Post('temporary-storage/accept')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Temporary Storage intake: a STAGING station accepts a waiting product move.' })
  accept(@Body() body: AcceptStagingDto, @Req() req: any) {
    return this.workflow.acceptAtStaging(body.moveId, body.stationId, actorOf(req));
  }
}
