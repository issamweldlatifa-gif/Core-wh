import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { DisplaysService } from './displays.service';

class CreateDisplayDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
}

class UpdateDisplayDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsString() stationId?: string;
}

function actor(req: any): string | null {
  return req?.user?.id ?? req?.user?.sub ?? null;
}

/**
 * Admin management of Station Display Mode (§4/§13). Station configuration —
 * therefore ADMIN_WEB + stations.manage, the same permission that governs
 * stations themselves. Read-only viewers get the status via the stations API,
 * never the display URLs.
 */
@ApiTags('station-displays')
@RequireApplication('ADMIN_WEB')
@Controller('stations/:stationId/displays')
export class StationDisplaysAdminController {
  constructor(private readonly displays: DisplaysService) {}

  @Get()
  @RequirePermissions('stations.view')
  @ApiOperation({ summary: 'List a station’s displays (no tokens — URLs are manage-only).' })
  async list(@Param('stationId') stationId: string) {
    const rows = await this.displays.listForStation(stationId);
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      enabled: d.enabled,
      displayType: d.displayType,
      lastSeenAt: d.lastSeenAt,
      createdAt: d.createdAt,
      config: d.config,
    }));
  }

  @Post()
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Create a display for the station; returns the display URL path once.' })
  async create(@Param('stationId') stationId: string, @Body() dto: CreateDisplayDto, @Req() req: any) {
    const row = await this.displays.create(stationId, dto, actor(req));
    if (!row) return { error: 'STATION_NOT_FOUND' };
    return { ...row, urlPath: `/display/${row.accessToken}` };
  }
}

@ApiTags('station-displays')
@RequireApplication('ADMIN_WEB')
@Controller('station-displays')
export class DisplayItemAdminController {
  constructor(private readonly displays: DisplaysService) {}

  @Patch(':id')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Rename / enable / disable / reconfigure / move a display.' })
  async update(@Param('id') id: string, @Body() dto: UpdateDisplayDto, @Req() req: any) {
    const res = await this.displays.update(id, dto, actor(req));
    if (!res) return { error: 'NOT_FOUND' };
    if ('error' in res && res.error) return res;
    return { ...(res as { row: any }).row };
  }

  @Post(':id/regenerate')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Regenerate the access token; old display URLs stop working immediately.' })
  async regenerate(@Param('id') id: string, @Req() req: any) {
    const row = await this.displays.regenerate(id, actor(req));
    if (!row) return { error: 'NOT_FOUND' };
    return { ...row, urlPath: `/display/${row.accessToken}` };
  }

  @Delete(':id')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Delete a display (the URL dies with it; stations are untouched).' })
  async remove(@Param('id') id: string, @Req() req: any) {
    const row = await this.displays.remove(id, actor(req));
    if (!row) return { error: 'NOT_FOUND' };
    return { ok: true, id: row.id };
  }
}
