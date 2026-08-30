import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AislesService } from './aisles.service';
import { CreateAisleDto } from './dto/create-aisle.dto';
import { UpdateAisleDto } from './dto/update-aisle.dto';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { RequestWithUser } from '../../../common/interfaces/request-with-user.interface';

@ApiTags('Aisles')
@ApiBearerAuth()
@Controller('aisles')
export class AislesController {
  constructor(private readonly aisles: AislesService) {}

  @Post()
  @RequirePermissions('aisles.create')
  @ApiOperation({ summary: 'Create an aisle (aisles.create).' })
  create(@Body() dto: CreateAisleDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.aisles.create(dto, user.id, req.ip);
  }

  @Get()
  @RequirePermissions('aisles.view')
  @ApiOperation({ summary: 'List aisles for a zone (aisles.view).' })
  @ApiQuery({ name: 'zoneId', required: true })
  list(@Query('zoneId') zoneId: string) {
    return this.aisles.listByZone(zoneId);
  }

  @Get(':id')
  @RequirePermissions('aisles.view')
  @ApiOperation({ summary: 'Get an aisle (aisles.view).' })
  findOne(@Param('id') id: string) {
    return this.aisles.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('aisles.update')
  @ApiOperation({ summary: 'Update an aisle (aisles.update).' })
  update(@Param('id') id: string, @Body() dto: UpdateAisleDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.aisles.update(id, dto, user.id, req.ip);
  }

  @Post(':id/activate')
  @RequirePermissions('aisles.activate')
  @ApiOperation({ summary: 'Activate an aisle (aisles.activate).' })
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.aisles.activate(id, user.id, req.ip);
  }

  @Post(':id/deactivate')
  @RequirePermissions('aisles.deactivate')
  @ApiOperation({ summary: 'Deactivate an aisle (aisles.deactivate).' })
  deactivate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.aisles.deactivate(id, user.id, req.ip);
  }
}
