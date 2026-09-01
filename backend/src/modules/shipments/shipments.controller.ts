import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ShipmentsService } from './shipments.service';

/**
 * Read-only Warehouse UI API for inbound Shipments (Shipment Cards pushed by
 * the Arrival CRM). Session/JWT + `shipments.view`. Physical receiving lives
 * in the Receiving module.
 */
@ApiTags('Shipments')
@ApiBearerAuth()
@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get()
  @RequirePermissions('shipments.view')
  @ApiOperation({ summary: 'List inbound shipments (shipments.view).' })
  list(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.shipments.list({
      search: search ?? undefined,
      status: status ?? undefined,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get(':idOrCode')
  @RequirePermissions('shipments.view')
  @ApiOperation({ summary: 'Get one Shipment with its cartons (WSHP code / external id / uuid).' })
  detail(@Param('idOrCode') idOrCode: string) {
    return this.shipments.detail(idOrCode);
  }
}
