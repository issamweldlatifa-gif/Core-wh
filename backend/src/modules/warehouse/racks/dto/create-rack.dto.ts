import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateRackDto {
  @ApiProperty({ description: 'Aisle id the rack belongs to.' })
  @IsString()
  aisleId!: string;

  @ApiProperty({ description: 'Rack code (unique within the aisle, e.g. R01).' })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(/^[A-Z0-9_-]+$/, { message: 'code must be uppercase letters, numbers, _ or -' })
  code!: string;

  @ApiProperty({ description: 'Rack display name.' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: 'Rack description.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
