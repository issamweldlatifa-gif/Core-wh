import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RacksService } from './racks.service';
import { CreateRackDto } from './dto/create-rack.dto';
import { UpdateRackDto } from './dto/update-rack.dto';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { RequestWithUser } from '../../../common/interfaces/request-with-user.interface';
import { RequireApplication } from '../../../common/decorators/require-application.decorator';

@ApiTags('Racks')
@ApiBearerAuth()
@Controller('racks')
@RequireApplication('ADMIN_WEB')
export class RacksController {
  constructor(private readonly racks: RacksService) {}

  @Post()
  @RequirePermissions('racks.create')
  @ApiOperation({ summary: 'Create a rack (racks.create).' })
  create(@Body() dto: CreateRackDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.racks.create(dto, user.id, req.ip);
  }

  @Get()
  @RequirePermissions('racks.view')
  @ApiOperation({ summary: 'List racks for an aisle (racks.view).' })
  @ApiQuery({ name: 'aisleId', required: true })
  list(@Query('aisleId') aisleId: string) {
    return this.racks.listByAisle(aisleId);
  }

  @Get(':id')
  @RequirePermissions('racks.view')
  @ApiOperation({ summary: 'Get a rack (racks.view).' })
  findOne(@Param('id') id: string) {
    return this.racks.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('racks.update')
  @ApiOperation({ summary: 'Update a rack (racks.update).' })
  update(@Param('id') id: string, @Body() dto: UpdateRackDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.racks.update(id, dto, user.id, req.ip);
  }

  @Post(':id/activate')
  @RequirePermissions('racks.activate')
  @ApiOperation({ summary: 'Activate a rack (racks.activate).' })
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.racks.activate(id, user.id, req.ip);
  }

  @Post(':id/deactivate')
  @RequirePermissions('racks.deactivate')
  @ApiOperation({ summary: 'Deactivate a rack (racks.deactivate).' })
  deactivate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.racks.deactivate(id, user.id, req.ip);
  }
}
