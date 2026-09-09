import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * WORKFLOW SEPARATION — Temporary Storage input contract.
 *
 * PRODUCT ONLY (Receiving Output B: Produit + Carte). There is deliberately
 * NO carton field in this contract: a carton identifier is rejected by the
 * workflow guard before any intake row can be created.
 */
export class ManualIntakeDto {
  /** Receiving session that verified the product (Output B owner). */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  receivingSessionId!: string;

  /** Verified receiving product line to hand to Temporary Storage. */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  receivingProductId!: string;
}

export class StageIntakeDto {
  /** Explicit STAGING station code (else the worker's own ACTIVE station). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  stationCode?: string;

  /** Explicit zone code (else the station's configured zone). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  zoneCode?: string;

  /** Expandable section label inside the zone (e.g. "A-03"). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  section?: string;

  /** Optional concrete location code (must be ACTIVE, in the same zone). */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  locationCode?: string;
}

export class ListIntakesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  receivingSessionId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}
