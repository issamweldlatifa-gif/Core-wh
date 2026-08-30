import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateAisleDto {
  @ApiPropertyOptional({ description: 'Aisle code (unique within the zone).' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  code?: string;

  @ApiPropertyOptional({ description: 'Aisle display name.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Aisle description.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
