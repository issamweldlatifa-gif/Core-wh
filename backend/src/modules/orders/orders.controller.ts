import { Get, Controller, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { OrdersService } from './orders.service';

/**
 * Read surface over the existing order projection (admin + terminals).
 * Order CREATION happens only through the service-authenticated integration
 * endpoint (external system of record) — there is deliberately no
 * user-facing create/update here.
 */
@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
@RequireApplication('ADMIN_WEB')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'List warehouse orders (projection).' })
  list(@Query('status') status?: string, @Query('q') q?: string) {
    return this.orders.list({ status, q });
  }

  @Get(':reference')
  @RequirePermissions('operations.view')
  @ApiOperation({ summary: 'Order detail with items, bins, articles and outbound shipments.' })
  detail(@Param('reference') reference: string) {
    return this.orders.detail(reference);
  }
}
