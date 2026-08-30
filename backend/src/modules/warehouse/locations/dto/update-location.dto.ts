import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { LocationStatus, LocationType } from '@prisma/client';

export class UpdateLocationDto {
  @ApiPropertyOptional({ description: 'Reparent — must keep a valid full ancestry.' })
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  zoneId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  aisleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rackId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  levelId?: string;

  @ApiPropertyOptional({ description: 'Optional QR value.' })
  @IsOptional()
  @IsString()
  qrValue?: string;

  @ApiPropertyOptional({ enum: LocationType })
  @IsOptional()
  @IsEnum(LocationType)
  locationType?: LocationType;

  @ApiPropertyOptional({ enum: LocationStatus })
  @IsOptional()
  @IsEnum(LocationStatus)
  status?: LocationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  maxWeight?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  maxVolume?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxUnits?: number;
}
