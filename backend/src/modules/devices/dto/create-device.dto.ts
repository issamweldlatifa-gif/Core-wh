import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDeviceDto {
  @ApiProperty({ description: 'Unique device code, e.g. AYROVI-RCV-01.' })
  @IsString()
  @MinLength(2)
  @MaxLength(30)
  code!: string;

  @ApiProperty({ description: 'Human friendly device name.' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: 'Hardware model / label.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @ApiPropertyOptional({ description: 'Worker id this device is assigned to (optional at registration).' })
  @IsOptional()
  @IsString()
  workerId?: string;

  @ApiPropertyOptional({ description: 'Display-only station code the device sits at.' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  stationCode?: string;
}
