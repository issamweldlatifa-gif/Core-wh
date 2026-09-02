import {
  Body,
  Controller,
  HttpCode,
  Ip,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { IntegrationApiGuard } from './integration-api.guard';
import { OrdersService } from '../../modules/orders/orders.service';
import { OrderCardEventDto } from './dto/order-card.dto';

/**
 * External integration boundary: Order pushes -> Warehouse Order projection.
 *
 * Discovery fact: the WarehouseOrder/OrderItem/Product models existed but had
 * NO API at all. This is the missing intake, built on the SAME service-auth
 * guard and idempotency model (externalOrderReference + contentHash) as the
 * Arrival and Shipment Card endpoints. It does not redesign the models.
 */
@ApiTags('integrations')
@Public()
@Controller('integrations/orders')
export class CrmOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @UseGuards(IntegrationApiGuard)
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Receive an Order from an external system (service-auth, idempotent on externalOrderReference).',
  })
  async receive(@Body() dto: OrderCardEventDto, @Req() req: any, @Ip() ip: string) {
    const principal = req.integrationClient;
    return this.orders.intake(dto, principal?.name ?? 'integration', ip);
  }
}
