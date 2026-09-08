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
import { CartonCardsService } from '../../modules/carton-cards/carton-cards.service';
import { CartonCardEventDto } from './dto/carton-card.dto';

@ApiTags('integrations')
@Public()
@Controller('integrations/carton-cards')
export class CrmCartonCardsController {
  constructor(private readonly cartons: CartonCardsService) {}

  @Post()
  @UseGuards(IntegrationApiGuard)
  @HttpCode(201)
  @ApiOperation({
    summary: 'Receive a Carton Card from external project (CARTON FIX: preserves carton identity, suivi, QR, barcode, products inside, metadata)',
  })
  async receive(
    @Body() dto: CartonCardEventDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: any,
    @Ip() ip: string,
  ) {
    const principal = req.integrationClient;
    if (idempotencyKey && principal) principal.idempotencyKey = idempotencyKey.trim();
    const result = await this.cartons.receiveCartonCard(dto, principal, ip);
    return result;
  }
}

@ApiTags('integrations')
@Public()
@Controller('integrations/arrivals')
export class CrmCartonCardsLegacyController {
  constructor(private readonly cartons: CartonCardsService) {}

  @Post('carton-cards')
  @UseGuards(IntegrationApiGuard)
  @HttpCode(201)
  @ApiOperation({
    summary: 'Legacy: Receive Carton Card via arrivals endpoint (backward compat)',
  })
  async receiveLegacy(
    @Body() dto: CartonCardEventDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: any,
    @Ip() ip: string,
  ) {
    const principal = req.integrationClient;
    if (idempotencyKey && principal) principal.idempotencyKey = idempotencyKey.trim();
    const result = await this.cartons.receiveCartonCard(dto, principal, ip);
    return result;
  }
}
