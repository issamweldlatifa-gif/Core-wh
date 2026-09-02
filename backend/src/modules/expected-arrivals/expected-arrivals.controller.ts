import { Body, Controller, Get, Ip, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ExpectedArrivalsService } from './expected-arrivals.service';

class ChangeCategoryDto {
  @IsString() @MinLength(2) @MaxLength(120)
  category!: string;

  @IsOptional() @IsString() @MaxLength(120)
  subcategory?: string | null;
}

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

  @Post('items/:itemId/category')
  @RequirePermissions('inventory.manage')
  @ApiOperation({
    summary:
      'Manually resolve/correct the category of one arrival line against the Category Master (audited: CATEGORY_MANUALLY_CHANGED).',
  })
  changeCategory(
    @Param('itemId') itemId: string,
    @Body() dto: ChangeCategoryDto,
    @Req() req: any,
    @Ip() ip: string,
  ) {
    return this.arrivals.changeItemCategory(itemId, dto, { id: req.user?.id ?? null, ip });
  }
}
