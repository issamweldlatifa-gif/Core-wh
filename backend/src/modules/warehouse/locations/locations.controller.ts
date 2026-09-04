import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { LocationsService } from './locations.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { ListLocationsQuery } from './dto/list-locations.query';
import { SearchLocationsQuery } from './dto/search-locations.query';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { RequestWithUser } from '../../../common/interfaces/request-with-user.interface';
import { RequireApplication } from '../../../common/decorators/require-application.decorator';

@ApiTags('Locations')
@ApiBearerAuth()
@Controller('locations')
@RequireApplication('ADMIN_WEB')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Post()
  @RequirePermissions('locations.create')
  @ApiOperation({ summary: 'Create a location (locations.create). Code auto-derived from the parent chain.' })
  create(@Body() dto: CreateLocationDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.locations.create(dto, user.id, req.ip);
  }

  @Get()
  @RequirePermissions('locations.view')
  @ApiOperation({ summary: 'List/filter locations (locations.view).' })
  findAll(@Query() query: ListLocationsQuery) {
    return this.locations.findAll(query);
  }

  @Get('search')
  @RequirePermissions('locations.view')
  @ApiOperation({ summary: 'Fast search over location codes/barcodes (locations.view).' })
  @ApiQuery({ name: 'q', required: true })
  search(@Query() query: SearchLocationsQuery) {
    return this.locations.search(query);
  }

  @Get(':id')
  @RequirePermissions('locations.view')
  @ApiOperation({ summary: 'Get a location (locations.view).' })
  findOne(@Param('id') id: string) {
    return this.locations.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('locations.update')
  @ApiOperation({ summary: 'Update a location (locations.update). Reparent is validated.' })
  update(@Param('id') id: string, @Body() dto: UpdateLocationDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.locations.update(id, dto, user.id, req.ip);
  }

  @Post(':id/activate')
  @RequirePermissions('locations.activate')
  @ApiOperation({ summary: 'Activate a location (locations.activate).' })
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.locations.setStatus(id, 'ACTIVE', user.id, req.ip);
  }

  @Post(':id/deactivate')
  @RequirePermissions('locations.deactivate')
  @ApiOperation({ summary: 'Deactivate a location (locations.deactivate).' })
  deactivate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.locations.setStatus(id, 'INACTIVE', user.id, req.ip);
  }

  @Post(':id/block')
  @RequirePermissions('locations.deactivate')
  @ApiOperation({ summary: 'Block a location (locations.deactivate permission; LOCATION_BLOCKED).' })
  block(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.locations.block(id, user.id, req.ip);
  }

  @Post(':id/unblock')
  @RequirePermissions('locations.activate')
  @ApiOperation({ summary: 'Unblock a location (locations.activate permission; LOCATION_UNBLOCKED).' })
  unblock(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.locations.unblock(id, user.id, req.ip);
  }
}
