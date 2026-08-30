import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateZoneDto {
  @ApiProperty({ description: 'Warehouse id the zone belongs to.' })
  @IsString()
  warehouseId!: string;

  @ApiProperty({ description: 'Zone code (unique within the warehouse, e.g. SHOES).' })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(/^[A-Z0-9_-]+$/, { message: 'code must be uppercase letters, numbers, _ or -' })
  code!: string;

  @ApiProperty({ description: 'Zone display name.' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: 'Zone description.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
