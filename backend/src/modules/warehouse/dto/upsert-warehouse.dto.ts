import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpsertWarehouseDto {
  @ApiProperty({ description: 'Unique warehouse code.' })
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

  @ApiPropertyOptional({ description: 'Address.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;
}
