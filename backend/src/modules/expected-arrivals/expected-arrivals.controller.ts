import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ExpectedArrivalsService } from './expected-arrivals.service';

/**
 * Read-only Warehouse UI API for Expected Arrivals (the inbound projection of
 * Customer Arrival Cards pushed by the Arrival CRM). Standard session/JWT +
 * `expected_arrivals.view`. Receiving/mutation endpoints are intentionally
 * absent here (Receiving is a later phase).
 */
@ApiTags('Expected Arrivals')
@ApiBearerAuth()
@Controller('expected-arrivals')
export class ExpectedArrivalsController {
  constructor(private readonly arrivals: ExpectedArrivalsService) {}

  @Get()
  @RequirePermissions('expected_arrivals.view')
  @ApiOperation({ summary: 'List Expected Arrivals (expected_arrivals.view).' })
  list(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.arrivals.list({
      status: status ?? undefined,
      search: search ?? undefined,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get(':idOrCode')
  @RequirePermissions('expected_arrivals.view')
  @ApiOperation({ summary: 'Get one Expected Arrival with its products.' })
  detail(@Param('idOrCode') idOrCode: string) {
    return this.arrivals.detail(idOrCode);
  }
}
