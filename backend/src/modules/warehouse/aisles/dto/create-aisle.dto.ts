import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateAisleDto {
  @ApiProperty({ description: 'Zone id the aisle belongs to.' })
  @IsString()
  zoneId!: string;

  @ApiProperty({ description: 'Aisle code (unique within the zone, e.g. A01).' })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(/^[A-Z0-9_-]+$/, { message: 'code must be uppercase letters, numbers, _ or -' })
  code!: string;

  @ApiProperty({ description: 'Aisle display name.' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: 'Aisle description.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
