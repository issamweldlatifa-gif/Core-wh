import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateZoneDto {
  @ApiPropertyOptional({ description: 'Zone code (unique within the warehouse).' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  code?: string;

  @ApiPropertyOptional({ description: 'Zone display name.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Zone description.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
