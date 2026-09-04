import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { PutawayService } from './putaway.service';
import { PlaceCartonDto, ScanCodeDto, StartPutawayDto } from './dto/putaway.dto';
import { RequireApplication } from '../../common/decorators/require-application.decorator';

/**
 * Putaway (stowing) Terminal API.
 *
 * Permissions mirror the task registry: `stowing.view` to look,
 * `stowing.execute` to move stock. Enforced server-side (§9/§41).
 */
@ApiTags('Putaway')
@ApiBearerAuth()
@Controller('putaway')
@RequireApplication('WORKER_NATIVE')
export class PutawayController {
  constructor(private readonly putaway: PutawayService) {}

  private actor(req: any) {
    const user = req.user ?? {};
    return {
      id: String(user.id ?? user.sub ?? 'unknown'),
      name: user.name ?? user.employeeCode ?? null,
    };
  }

  @Get('queue')
  @RequirePermissions('stowing.view')
  @ApiOperation({ summary: 'Cartons received but not yet stored (work queue).' })
  queue(@Query('limit') limit?: string) {
    return this.putaway.queue(limit ? Number(limit) : 50);
  }

  @Get('sessions/active')
  @RequirePermissions('stowing.view')
  @ApiOperation({ summary: "The worker's open putaway session, if any." })
  active(@Req() req: any) {
    return this.putaway.active(this.actor(req));
  }

  @Get('sessions/:id')
  @RequirePermissions('stowing.view')
  @ApiOperation({ summary: 'Putaway session detail.' })
  detail(@Param('id') id: string) {
    return this.putaway.detail(id);
  }

  @Post('sessions/start')
  @RequirePermissions('stowing.execute')
  @ApiOperation({ summary: 'Start (or resume) a putaway session.' })
  start(@Body() body: StartPutawayDto, @Req() req: any) {
    return this.putaway.start(this.actor(req), body ?? {});
  }

  @Post('scan-carton')
  @RequirePermissions('stowing.execute')
  @ApiOperation({ summary: 'Identify a scanned carton (no write).' })
  scanCarton(@Body() body: ScanCodeDto) {
    return this.putaway.scanCarton(body.code).then((flash) => ({ flash }));
  }

  @Post('scan-location')
  @RequirePermissions('stowing.execute')
  @ApiOperation({ summary: 'Identify a scanned location (no write).' })
  scanLocation(@Body() body: ScanCodeDto) {
    return this.putaway.scanLocation(body.code).then((flash) => ({ flash }));
  }

  @Post('sessions/:id/place')
  @RequirePermissions('stowing.execute')
  @ApiOperation({ summary: 'Commit carton -> location placement.' })
  place(@Param('id') id: string, @Body() body: PlaceCartonDto, @Req() req: any) {
    return this.putaway.place(id, body, this.actor(req));
  }

  @Post('sessions/:id/pause')
  @RequirePermissions('stowing.execute')
  pause(@Param('id') id: string, @Req() req: any) {
    return this.putaway.pause(id, this.actor(req));
  }

  @Post('sessions/:id/resume')
  @RequirePermissions('stowing.execute')
  resume(@Param('id') id: string, @Req() req: any) {
    return this.putaway.resume(id, this.actor(req));
  }

  @Post('sessions/:id/complete')
  @RequirePermissions('stowing.execute')
  complete(@Param('id') id: string, @Req() req: any) {
    return this.putaway.complete(id, this.actor(req));
  }
}
