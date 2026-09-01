import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Ip,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { IntegrationApiGuard } from './integration-api.guard';
import { ShipmentsService } from '../../modules/shipments/shipments.service';
import { ShipmentCardEventDto } from './dto/shipment-card.dto';

/**
 * External integration boundary: Arrival CRM -> Warehouse SHIPMENT cards.
 *
 * Receives physical shipping/carton data (carrier, tracking, sender, cartons)
 * for an Arrival as a Warehouse Shipment + Cartons, linked to the Expected
 * Arrival. Uses the SAME service-auth guard and idempotency model as the
 * Customer Arrival Card endpoint. Does NOT mark anything physically received.
 */
@ApiTags('integrations')
@Public()
@Controller('integrations/arrivals')
export class CrmShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Post('shipments')
  @UseGuards(IntegrationApiGuard)
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Receive a Shipment Card from the Arrival CRM (service-auth, idempotent): creates a Warehouse Shipment + cartons linked to the Expected Arrival.',
  })
  async receive(
    @Body() dto: ShipmentCardEventDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: any,
    @Ip() ip: string,
  ) {
    const principal = req.integrationClient;
    if (idempotencyKey && principal) principal.idempotencyKey = idempotencyKey.trim();
    const result = await this.shipments.receiveShipment(dto, principal, ip);
    return result;
  }
}
