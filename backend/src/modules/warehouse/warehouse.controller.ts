import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WarehouseService } from './warehouse.service';
import { UpsertWarehouseDto } from './dto/upsert-warehouse.dto';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { RequestWithUser } from '../../common/interfaces/request-with-user.interface';

@ApiTags('warehouse')
@ApiBearerAuth()
@Controller('warehouse')
export class WarehouseController {
  constructor(private readonly warehouse: WarehouseService) {}

  @Post()
  @RequirePermissions('warehouse.manage')
  @ApiOperation({ summary: 'Create/update a warehouse (requires warehouse.manage).' })
  upsert(@Body() dto: UpsertWarehouseDto, @CurrentUser() user: AuthenticatedUser, @Req() req: RequestWithUser) {
    return this.warehouse.upsert(dto, user.id, req.ip);
  }

  @Get()
  @RequirePermissions('warehouse.view')
  @ApiOperation({ summary: 'List warehouses (requires warehouse.view).' })
  findAll() {
    return this.warehouse.findAll();
  }

  @Get(':id')
  @RequirePermissions('warehouse.view')
  @ApiOperation({ summary: 'Get a warehouse (requires warehouse.view).' })
  findOne(@Param('id') id: string) {
    return this.warehouse.findOne(id);
  }
}
