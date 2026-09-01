import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ScanSource } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class StartPutawayDto {
  @ApiPropertyOptional({ example: 'SMARTPHONE' })
  @IsOptional() @IsString() @MaxLength(40)
  deviceType?: string;

  @ApiPropertyOptional({ example: 'Zebra TC21' })
  @IsOptional() @IsString() @MaxLength(120)
  deviceName?: string;
}

export class ScanCodeDto {
  @ApiProperty({ example: 'CTN-DEMO-0001' })
  @IsString() @MinLength(1) @MaxLength(160)
  code!: string;
}

/**
 * A placement always carries BOTH codes, so the operation is atomic and
 * replayable: the server never relies on a half-finished client state.
 */
export class PlaceCartonDto {
  @ApiProperty({ example: 'CTN-DEMO-0001' })
  @IsString() @MinLength(1) @MaxLength(160)
  cartonCode!: string;

  @ApiProperty({ example: 'TUN-MAIN-SHOES-A01-R01-L01' })
  @IsString() @MinLength(1) @MaxLength(160)
  locationCode!: string;

  @ApiPropertyOptional({ enum: ScanSource })
  @IsOptional() @IsEnum(ScanSource)
  cartonSource?: ScanSource;

  @ApiPropertyOptional({ enum: ScanSource })
  @IsOptional() @IsEnum(ScanSource)
  locationSource?: ScanSource;
}
