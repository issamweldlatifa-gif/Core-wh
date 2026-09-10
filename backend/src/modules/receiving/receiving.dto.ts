import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Explicit DTOs for the three Receiving endpoints that previously accepted
 * untyped inline bodies (session start, flag, discrepancy resolve).
 *
 * The global ValidationPipe (whitelist + forbidNonWhitelisted) can only
 * enforce payload-abuse protection on classed metadata — with these classes
 * oversized strings and junk fields are now rejected there too. Field names
 * mirror exactly what the Worker App sends (WorkerRepository.kt):
 *   start   → { deviceType, deviceName }
 *   flag    → { reason, sku?, code? }
 *   resolve → { resolution }
 */
export class SessionStartInputDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  deviceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  deviceName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  scanSource?: string;
}

export class FlagInputDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  sku?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class ResolveDiscrepancyInputDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  resolution?: string;
}
