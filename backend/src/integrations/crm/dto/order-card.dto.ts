import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payload contract for external Order pushes (CRM/OCR/API) into the EXISTING
 * WarehouseOrder projection (D-41/D-42: external references only, no customer
 * record). Same integration model as the Arrival/Shipment Card endpoints:
 * @Public route + IntegrationApiGuard, idempotent on externalOrderReference.
 */

export class OrderItemDto {
  @ApiProperty({ example: 'MAIN' })
  @IsString() @MinLength(1) @MaxLength(120)
  store!: string;

  @ApiProperty({ example: 'SH-001' })
  @IsString() @MinLength(1) @MaxLength(160)
  externalProductCode!: string;

  @ApiProperty({ example: 'Leather shoes 42' })
  @IsString() @MinLength(1) @MaxLength(300)
  productName!: string;

  @ApiProperty({ example: 2, minimum: 1 })
  @IsInt() @Min(1)
  requestedQuantity!: number;

  @ApiPropertyOptional({ example: 'LINE-1' })
  @IsOptional() @IsString() @MaxLength(160)
  externalLineReference?: string | null;
}

export class OrderCardEventDto {
  @ApiProperty({ example: 'ORD-2026-00042' })
  @IsString() @MinLength(1) @MaxLength(160)
  externalOrderReference!: string;

  @ApiProperty({ example: 'AHMED', description: 'External customer reference only (no PII record).' })
  @IsString() @MinLength(1) @MaxLength(160)
  externalCustomerReference!: string;

  @ApiPropertyOptional({ enum: ['ADMIN', 'CRM', 'OCR', 'API'] })
  @IsOptional() @IsString() @IsIn(['ADMIN', 'CRM', 'OCR', 'API'])
  source?: 'ADMIN' | 'CRM' | 'OCR' | 'API';

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(2000)
  note?: string | null;

  @ApiProperty({ type: [OrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}
