import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { LocationStatus, LocationType } from '@prisma/client';

export class CreateLocationDto {
  @ApiProperty({ description: 'Warehouse id (must match the full parent chain).' })
  @IsString()
  warehouseId!: string;

  @ApiProperty({ description: 'Zone id (must belong to warehouseId).' })
  @IsString()
  zoneId!: string;

  @ApiProperty({ description: 'Aisle id (must belong to zoneId).' })
  @IsString()
  aisleId!: string;

  @ApiProperty({ description: 'Rack id (must belong to aisleId).' })
  @IsString()
  rackId!: string;

  @ApiProperty({ description: 'Level id (must belong to rackId).' })
  @IsString()
  levelId!: string;

  @ApiPropertyOptional({ description: 'Optional QR value. Defaults to location code (D-33).' })
  @IsOptional()
  @IsString()
  qrValue?: string;

  @ApiProperty({ enum: LocationType, description: 'Physical location type.' })
  @IsEnum(LocationType)
  locationType!: LocationType;

  @ApiPropertyOptional({ enum: LocationStatus, description: 'Initial status. Default ACTIVE.' })
  @IsOptional()
  @IsEnum(LocationStatus)
  status?: LocationStatus;

  @ApiPropertyOptional({ description: 'Max weight capacity metadata.' })
  @IsOptional()
  @IsNumber()
  maxWeight?: number;

  @ApiPropertyOptional({ description: 'Max volume capacity metadata.' })
  @IsOptional()
  @IsNumber()
  maxVolume?: number;

  @ApiPropertyOptional({ description: 'Max units capacity metadata.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxUnits?: number;
}
