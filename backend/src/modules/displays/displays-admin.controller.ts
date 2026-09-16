import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { DisplaysService, normalizeDisplayConfig } from './displays.service';

class CreateDisplayDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
}

class UpdateDisplayDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsString() stationId?: string;
}

class BulkDto {
  @IsIn(['CREATE_MISSING', 'APPLY_CONFIG', 'SET_ENABLED', 'SET_INTERACTIVE']) action!: 'CREATE_MISSING' | 'APPLY_CONFIG' | 'SET_ENABLED' | 'SET_INTERACTIVE';
  @IsOptional() @IsArray() stationIds?: string[];
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() interactive?: boolean;
}

class MessageDto {
  @IsString() @MaxLength(400) body!: string;
  @IsOptional() @IsIn(['INFO', 'WARNING', 'URGENT']) severity?: string;
  @IsOptional() @IsBoolean() requireAck?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(1440) expiresInMinutes?: number;
}

function actor(req: any): string | null {
  return req?.user?.id ?? req?.user?.sub ?? null;
}

/**
 * Admin management of Station Display Mode (§4/§13) + the stage-2 fleet
 * console (owner order 2026-09-16: «include all stations»).
 * Station configuration — therefore ADMIN_WEB + stations.* permissions, the
 * same permission that governs stations themselves. Read-only viewers get the
 * status via the stations API, never the display URLs.
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
    // The EFFECTIVE config (defaults applied), never the raw stored blob: the
    // admin panel renders exactly what the server will enforce, so a switch can
    // never show "checked" while the backend treats it as off.
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      enabled: d.enabled,
      displayType: d.displayType,
      lastSeenAt: d.lastSeenAt,
      createdAt: d.createdAt,
      config: normalizeDisplayConfig(d.config),
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

  @Get()
  @RequirePermissions('stations.view')
  @ApiOperation({ summary: 'FLEET: every station with its display state (tokens never returned).' })
  async fleet() {
    return this.displays.fleet();
  }

  @Post('bulk')
  @RequirePermissions('stations.manage')
  @ApiOperation({
    summary: 'FLEET bulk: create missing displays / apply a config profile / enable-disable / interactive — one audit entry per run.',
  })
  async bulk(@Body() dto: BulkDto, @Req() req: any) {
    return this.displays.bulk(dto, actor(req));
  }

  @Get('stations/:stationId/actions')
  @RequirePermissions('stations.view')
  @ApiOperation({ summary: 'What humans did on this station’s screens (print/ack/help/exception/message).' })
  async stationActions(@Param('stationId') stationId: string, @Query('take') take?: string) {
    return this.displays.recentActionsForStation(stationId, take ? Number(take) : 20);
  }

  @Patch(':id')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Rename / enable / disable / reconfigure / move a display.' })
  async update(@Param('id') id: string, @Body() dto: UpdateDisplayDto, @Req() req: any) {
    const res = await this.displays.update(id, dto, actor(req));
    if (!res) return { error: 'NOT_FOUND' };
    if ('error' in res && res.error) return res;
    return { ...(res as { row: any }).row };
  }

  @Post(':id/message')
  @RequirePermissions('stations.manage')
  @ApiOperation({ summary: 'Send a message to the station screen (shown full-width until acknowledged).' })
  async message(@Param('id') id: string, @Body() dto: MessageDto, @Req() req: any) {
    const res = await this.displays.sendMessage(id, dto, actor(req));
    if (!res) return { error: 'NOT_FOUND' };
    if ('error' in res && res.error) return res;
    return res.message;
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
