import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateRackDto {
  @ApiPropertyOptional({ description: 'Rack code (unique within the aisle).' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  code?: string;

  @ApiPropertyOptional({ description: 'Rack display name.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Rack description.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
