import { Body, Controller, Get, Param, Post, Query, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import {
  PlaceProductDto,
  ReportFinDto,
  ReviewProductDto,
  ScanProductDto,
} from './temporary-storage.dto';
import { TemporaryStorageService } from './temporary-storage.service';

function actorOf(req: any) {
  const user = req.user ?? {};
  return {
    id: String(user.id ?? user.sub ?? 'unknown'),
    name: user.name ?? user.employeeCode ?? null,
    ip: req.ip ?? null,
  };
}

function deviceOf(body: any) {
  return {
    deviceType: body?.deviceType ?? null,
    deviceName: body?.deviceName ?? null,
  };
}

/**
 * Temporary Storage worker API (CT40 / Web Terminal) — Product Flow ONLY.
 *
 * Same application guard and permission vocabulary as the Receiving
 * terminal. Station binding is enforced inside the service: only the ACTIVE
 * STAGING station assigned to the worker accepts scans. Cartons never
 * appear here.
 */
@ApiTags('Temporary Storage — Worker')
@ApiBearerAuth()
@Controller('temporary-storage')
@RequireApplication('WORKER_NATIVE')
export class TemporaryStorageController {
  constructor(private readonly service: TemporaryStorageService) {}

  @Get('home')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'Station home: header counters + ACTIVE sections (real data only).' })
  home(@Req() req: any) {
    return this.service.home(actorOf(req).id);
  }

  @Get('sections')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'Dynamic sections (letters that actually have products).' })
  sections(@Req() req: any) {
    return this.service.home(actorOf(req).id);
  }

  @Get('sections/:letter')
  @RequirePermissions('receiving.view')
  @ApiOperation({ summary: 'Section board: customer batches + container cards + review flag.' })
  section(@Param('letter') letter: string, @Req() req: any) {
    return this.service.section(letter, actorOf(req).id);
  }

  @Post('scan')
  @RequirePermissions('receiving.execute')
  @ApiOperation({
    summary:
      'Scan a product: system resolves customer -> section -> active target container (advisory; /place is the final validation).',
  })
  scan(@Body() body: ScanProductDto, @Req() req: any) {
    return this.service.scanProduct(
      { operationId: body.operationId, code: body.code },
      actorOf(req),
      deviceOf(body),
    );
  }

  @Post('place')
  @RequirePermissions('receiving.execute')
  @ApiOperation({
    summary:
      'Scan product + scan container -> server validation -> store unit (VALID / WRONG_CONTAINER / CONTAINER_FULL / REVIEW / CARTON_NOT_ALLOWED).',
  })
  place(@Body() body: PlaceProductDto, @Req() req: any) {
    return this.service.place(
      { operationId: body.operationId, code: body.code, containerCode: body.containerCode },
      actorOf(req),
      deviceOf(body),
    );
  }

  @Post('review')
  @RequirePermissions('receiving.execute')
  @ApiOperation({
    summary: 'Send a scanned product to the Review lane (REVIEW row + exception + admin alert).',
  })
  review(@Body() body: ReviewProductDto, @Req() req: any) {
    return this.service.sendToReview(
      {
        operationId: body.operationId,
        code: body.code,
        reason: body.reason ?? null,
        toReview: body.toReview ?? false,
      },
      actorOf(req),
      deviceOf(body),
    );
  }

  @Post('report')
  @RequirePermissions('receiving.execute')
  @ApiOperation({ summary: 'Rapport de Fin — close the shift and send the report to Admin → Reports.' })
  report(@Body() body: ReportFinDto | undefined, @Req() req: any) {
    return this.service.submitReport({ observation: body?.observation ?? null }, actorOf(req), deviceOf(body));
  }
}

/**
 * Temporary Storage admin API — overview, reports (Rapport de Fin) and the
 * container capacity configuration.
 */
@ApiTags('Temporary Storage — Admin')
@ApiBearerAuth()
@Controller('temporary-storage')
@RequireApplication('ADMIN_WEB')
export class TemporaryStorageAdminController {
  constructor(private readonly service: TemporaryStorageService) {}

  @Get('admin/overview')
  @RequirePermissions('stations.view')
  @ApiOperation({
    summary: 'Admin overview: stations, sections, containers, stored/review, capacity, open moves.',
  })
  overview() {
    return this.service.overview();
  }

  @Get('admin/config')
  @RequirePermissions('stations.view')
  @ApiOperation({ summary: 'Read container capacity configuration.' })
  config() {
    return this.service.getConfig();
  }

  @Put('admin/config')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Set the container capacity (runtime configuration, no code change).' })
  setConfig(@Body() body: { capacity: number }, @Req() req: any) {
    return this.service.setCapacity(Number(body?.capacity), actorOf(req));
  }

  @Get('admin/reports')
  @RequirePermissions('stations.view')
  @ApiOperation({ summary: 'Rapport de Fin list (Admin → Reports).' })
  listReports(@Query('status') status?: string) {
    return this.service.listReports({ status: status ?? undefined });
  }

  @Get('admin/reports/:id')
  @RequirePermissions('stations.view')
  @ApiOperation({ summary: 'Rapport de Fin detail.' })
  reportDetail(@Param('id') id: string) {
    return this.service.reportDetail(id);
  }

  @Post('admin/reports/:id/review')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Review a submitted Rapport de Fin.' })
  reviewReport(@Param('id') id: string, @Body() body: { note?: string } | undefined, @Req() req: any) {
    return this.service.reviewReport(id, body?.note, actorOf(req));
  }

  @Post('admin/reports/:id/close')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Close a Rapport de Fin.' })
  closeReport(@Param('id') id: string, @Req() req: any) {
    return this.service.closeReport(id, actorOf(req));
  }
}
