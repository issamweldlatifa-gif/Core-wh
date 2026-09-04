import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ZonesService } from './zones.service';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { RequestWithUser } from '../../../common/interfaces/request-with-user.interface';
import { RequireApplication } from '../../../common/decorators/require-application.decorator';

@ApiTags('Zones')
@ApiBearerAuth()
@Controller('zones')
@RequireApplication('ADMIN_WEB')
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  @Post()
  @RequirePermissions('zones.create')
  @ApiOperation({ summary: 'Create a zone (zones.create).' })
  create(@Body() dto: CreateZoneDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.zones.create(dto, user.id, req.ip);
  }

  @Get()
  @RequirePermissions('zones.view')
  @ApiOperation({ summary: 'List zones for a warehouse (zones.view).' })
  @ApiQuery({ name: 'warehouseId', required: true })
  list(@Query('warehouseId') warehouseId: string) {
    return this.zones.listByWarehouse(warehouseId);
  }

  @Get(':id')
  @RequirePermissions('zones.view')
  @ApiOperation({ summary: 'Get a zone (zones.view).' })
  findOne(@Param('id') id: string) {
    return this.zones.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('zones.update')
  @ApiOperation({ summary: 'Update a zone (zones.update).' })
  update(@Param('id') id: string, @Body() dto: UpdateZoneDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.zones.update(id, dto, user.id, req.ip);
  }

  @Post(':id/activate')
  @RequirePermissions('zones.activate')
  @ApiOperation({ summary: 'Activate a zone (zones.activate).' })
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.zones.activate(id, user.id, req.ip);
  }

  @Post(':id/deactivate')
  @RequirePermissions('zones.deactivate')
  @ApiOperation({ summary: 'Deactivate a zone (zones.deactivate).' })
  deactivate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.zones.deactivate(id, user.id, req.ip);
  }
}
