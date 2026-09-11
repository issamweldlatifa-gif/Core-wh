import { Type } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * BATCH CARD CONTRACT DTOs — Phase 2: contract classes ONLY (no controller).
 * Strict validation mirrors the CRM intake DTO style (forbidNonWhitelisted
 * at the pipe level in later phases).
 */

export const BATCH_IDENTIFIER_TYPES = ['SKU', 'BARCODE', 'REFERENCE', 'QR', 'MANUAL'] as const;
export type BatchIdentifierTypeValue = (typeof BATCH_IDENTIFIER_TYPES)[number];

export class BatchCustomerInputDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalRef?: string;
}

export class BatchUnitInputDto {
  @IsString()
  @Length(8, 64)
  /** Add-item idempotency anchor (a retried add returns the SAME item). */
  idempotencyKey!: string;

  @IsEnum(BATCH_IDENTIFIER_TYPES)
  identifierType!: BatchIdentifierTypeValue;

  /** REQUIRED unless identifierType = MANUAL (never invented for MANUAL). */
  @IsOptional()
  @IsString()
  @Length(1, 1024)
  identifierValue?: string;

  /** Original identity stored VERBATIM — never replaced, never invented. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  originalBarcode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  originalSku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  originalReference?: string;
}

export class BatchCreateDto {
  @IsString()
  @Length(8, 64)
  /** Create-batch idempotency anchor (a retried create returns THIS batch). */
  idempotencyKey!: string;

  @ValidateNested()
  @Type(() => BatchCustomerInputDto)
  customer!: BatchCustomerInputDto;

  /** First scan may land together with the create (one round-trip on the floor). */
  @IsOptional()
  @ValidateNested()
  @Type(() => BatchUnitInputDto)
  firstItem?: BatchUnitInputDto;
}

export class BatchSubmitDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  note?: string;
}

/** Admin decisions (accept / send / void) — operator attribution required. */
export class BatchDecisionDto {
  @IsString()
  @Length(1, 64)
  operatorId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  reason?: string;
}

/**
 * Cross-field rule the decorators cannot express: identifierValue is
 * REQUIRED for every identifierType EXCEPT MANUAL (an unreadable product
 * has no original value — it is never invented).
 */
export function unitInputViolations(u: BatchUnitInputDto): string[] {
  const v: string[] = [];
  if (u.identifierType !== 'MANUAL') {
    const val = (u.identifierValue ?? '').trim();
    if (!val) v.push('identifierValue is required unless identifierType is MANUAL');
    if (val.length > 1024) v.push('identifierValue exceeds 1024 characters');
  }
  const originals = [u.originalBarcode, u.originalSku, u.originalReference];
  if (u.identifierType === 'MANUAL' && originals.some((o) => (o ?? '').trim() !== '')) {
    v.push('MANUAL items must NOT invent original barcode/SKU/reference values');
  }
  return v;
}
