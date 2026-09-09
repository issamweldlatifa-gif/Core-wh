import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Temporary Storage worker DTOs (CT40 / Web Terminal).
 * Every mutating call carries a client `operationId` idempotency key: one
 * physical scan = one key, so a retried HTTP call is never double-counted.
 */

export class ScanProductDto {
  @ApiProperty({ example: 'scan-op-0001' })
  @IsString() @MinLength(4) @MaxLength(128)
  operationId!: string;

  @ApiProperty({ example: 'sb25092090066487374' })
  @IsString() @MinLength(1) @MaxLength(300)
  code!: string;

  @ApiPropertyOptional({ example: 'CT40' })
  @IsOptional() @IsString() @MaxLength(80)
  deviceType?: string | null;

  @ApiPropertyOptional({ example: 'CT40-01' })
  @IsOptional() @IsString() @MaxLength(120)
  deviceName?: string | null;
}

export class PlaceProductDto extends ScanProductDto {
  @ApiProperty({ example: 'A3' })
  @IsString() @MinLength(1) @MaxLength(20)
  containerCode!: string;
}

export class ReviewProductDto extends ScanProductDto {
  @ApiPropertyOptional({ example: 'Damaged packaging' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string | null;

  /** Explicit worker request to send the scanned product to the Review lane. */
  @ApiPropertyOptional()
  @IsOptional() @IsBoolean()
  toReview?: boolean | null;
}

export class ReportFinDto {
  @ApiPropertyOptional({ example: 'Temporary storage completed for arrival WAR-000145.' })
  @IsOptional() @IsString() @MaxLength(1000)
  observation?: string | null;
}

export class CapacityConfigDto {
  @ApiProperty({ example: 20 })
  @IsInt() @Min(1) @Max(1000)
  capacity!: number;
}
