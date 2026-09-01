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
import { ExpectedArrivalsService } from '../../modules/expected-arrivals/expected-arrivals.service';
import {
  CustomerArrivalCardEventDto,
} from './dto/customer-arrival-card.dto';

/**
 * External integration boundary: Arrival CRM -> Warehouse.
 *
 * Receives a Customer Arrival Card (structured JSON) and records it as an
 * EXPECTED arrival. This endpoint is NOT a session/JWT route — it uses
 * service authentication (x-api-key / registered API client) and is
 * idempotent on the card id / Idempotency-Key header.
 *
 * The route is @Public() so the global JWT guard skips it; the dedicated
 * IntegrationApiGuard enforces service credentials.
 */
@ApiTags('integrations')
@Public()
@Controller('integrations/arrivals')
export class CrmArrivalsController {
  constructor(private readonly arrivals: ExpectedArrivalsService) {}

  @Post('customer-cards')
  @UseGuards(IntegrationApiGuard)
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Receive a Customer Arrival Card from the Arrival CRM as an Expected Arrival (service-auth, idempotent).',
  })
  async receive(
    @Body() dto: CustomerArrivalCardEventDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: any,
    @Ip() ip: string,
  ) {
    // The guard may also read the header; pass it explicitly for clarity.
    const principal = req.integrationClient;
    if (idempotencyKey && principal) principal.idempotencyKey = idempotencyKey.trim();

    const result = await this.arrivals.receiveCard(dto, principal, ip);
    // Idempotent acceptance: a first push and a duplicate replay both resolve
    // to the SAME Expected Arrival, so both return a successful 2xx. The
    // `created` flag tells the CRM whether this was the first insert.
    return {
      success: result.success,
      customer_arrival_card_id: result.customer_arrival_card_id,
      warehouse_arrival_id: result.warehouse_arrival_id,
      // The expected-arrival domain status. This is NEVER "RECEIVED": goods
      // are only EXPECTED to arrive (physical receiving is a later phase).
      arrival_status: result.status,
      created: result.created,
      duplicate: !result.created,
    };
  }
}
