import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { LocationStatus, LocationType } from '@prisma/client';

export class ListLocationsQuery {
  @ApiPropertyOptional({ description: 'Filter by warehouse.' })
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @ApiPropertyOptional({ description: 'Filter by zone.' })
  @IsOptional()
  @IsString()
  zoneId?: string;

  @ApiPropertyOptional({ enum: LocationStatus, description: 'Filter by status.' })
  @IsOptional()
  @IsEnum(LocationStatus)
  status?: LocationStatus;

  @ApiPropertyOptional({ enum: LocationType, description: 'Filter by location type.' })
  @IsOptional()
  @IsEnum(LocationType)
  locationType?: LocationType;

  @ApiPropertyOptional({ description: 'Pagination: offset.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ description: 'Pagination: limit (max 200).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take?: number;
}
