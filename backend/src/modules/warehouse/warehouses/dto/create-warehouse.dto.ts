import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateWarehouseDto {
  @ApiProperty({ description: 'Unique, stable warehouse code (e.g. TUN-MAIN).' })
  @IsString()
  @MinLength(2)
  @MaxLength(30)
  @Matches(/^[A-Z0-9_-]+$/, { message: 'code must be uppercase letters, numbers, _ or -' })
  code!: string;

  @ApiProperty({ description: 'Warehouse display name.' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: 'Warehouse description.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
