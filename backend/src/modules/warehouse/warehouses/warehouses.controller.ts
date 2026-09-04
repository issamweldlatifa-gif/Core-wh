import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WarehousesService } from './warehouses.service';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { RequestWithUser } from '../../../common/interfaces/request-with-user.interface';
import { RequireApplication } from '../../../common/decorators/require-application.decorator';

@ApiTags('Warehouses')
@ApiBearerAuth()
@Controller('warehouses')
@RequireApplication('ADMIN_WEB')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Post()
  @RequirePermissions('warehouses.create')
  @ApiOperation({ summary: 'Create a warehouse (warehouses.create).' })
  create(@Body() dto: CreateWarehouseDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.warehouses.create(dto, user.id, req.ip);
  }

  @Get()
  @RequirePermissions('warehouses.view')
  @ApiOperation({ summary: 'List warehouses (warehouses.view).' })
  findAll() {
    return this.warehouses.findAll();
  }

  @Get(':id/structure')
  @RequirePermissions('warehouses.view')
  @ApiOperation({ summary: 'Get the nested physical structure tree (warehouses.view).' })
  structure(@Param('id') id: string) {
    return this.warehouses.structure(id);
  }

  @Get(':id')
  @RequirePermissions('warehouses.view')
  @ApiOperation({ summary: 'Get a warehouse (warehouses.view).' })
  findOne(@Param('id') id: string) {
    return this.warehouses.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('warehouses.update')
  @ApiOperation({ summary: 'Update a warehouse (warehouses.update).' })
  update(@Param('id') id: string, @Body() dto: UpdateWarehouseDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.warehouses.update(id, dto, user.id, req.ip);
  }

  @Post(':id/activate')
  @RequirePermissions('warehouses.activate')
  @ApiOperation({ summary: 'Activate a warehouse (warehouses.activate).' })
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.warehouses.setStatus(id, 'ACTIVE', user.id, req.ip);
  }

  @Post(':id/deactivate')
  @RequirePermissions('warehouses.deactivate')
  @ApiOperation({ summary: 'Deactivate a warehouse (warehouses.deactivate).' })
  deactivate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.warehouses.setStatus(id, 'INACTIVE', user.id, req.ip);
  }
}
