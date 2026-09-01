import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payload contract for the Arrival CRM -> Warehouse Shipment Card push.
 *
 * A Shipment Card carries the PHYSICAL shipping information (carrier,
 * tracking, sender, destination, dates, cartons) for one Arrival. It is a
 * distinct object from the Customer Arrival Card (which holds the customer
 * products). Structured JSON only; most fields are nullable because not every
 * carrier/exporter provides them.
 */

export class ShipmentArrivalRefDto {
  @ApiProperty({ example: 'ARR-2026-00087' })
  @IsString() @MinLength(1) @MaxLength(160)
  id!: string;

  @ApiPropertyOptional({ example: 'ARR-2026-00087' })
  @IsOptional() @IsString() @MaxLength(160)
  reference?: string | null;
}

export class ShipmentSourceDto {
  @ApiProperty({ enum: ['MANUAL', 'CARRIER_API', 'IMPORT', 'OTHER'] })
  @IsString() @IsIn(['MANUAL', 'CARRIER_API', 'IMPORT', 'OTHER'])
  type!: 'MANUAL' | 'CARRIER_API' | 'IMPORT' | 'OTHER';

  @ApiPropertyOptional({ example: 'carrier-reference-123' })
  @IsOptional() @IsString() @MaxLength(200)
  reference?: string | null;
}

export class ShipmentCarrierDto {
  @ApiPropertyOptional({ example: 'DHL' })
  @IsOptional() @IsString() @MaxLength(80)
  id?: string | null;

  @ApiPropertyOptional({ example: 'DHL' })
  @IsOptional() @IsString() @MaxLength(120)
  name?: string | null;

  @ApiPropertyOptional({ example: 'DHL' })
  @IsOptional() @IsString() @MaxLength(40)
  code?: string | null;

  @ApiPropertyOptional({ example: 'Express' })
  @IsOptional() @IsString() @MaxLength(120)
  service?: string | null;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(160)
  account_reference?: string | null;
}

export class ShipmentTrackingDto {
  @ApiPropertyOptional({ example: '1234567890' })
  @IsOptional() @IsString() @MaxLength(160)
  tracking_number?: string | null;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500)
  tracking_url?: string | null;

  @ApiProperty({ enum: ['CREATED', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'UNKNOWN'] })
  @IsString() @IsIn(['CREATED', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'UNKNOWN'])
  status!: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(160)
  master_tracking_number?: string | null;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(160)
  carrier_tracking_reference?: string | null;
}

export class ShipmentSenderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) company?: string | null;
  @ApiPropertyOptional({ example: 'CN' }) @IsOptional() @IsString() @MaxLength(40) country?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) city?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) reference?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) address?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) phone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) email?: string | null;
}

export class ShipmentDestinationDto {
  @ApiPropertyOptional({ example: 'TN' }) @IsOptional() @IsString() @MaxLength(40) country?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) city?: string | null;
  @ApiPropertyOptional({ example: 'AYROVI-WH-TN' }) @IsOptional() @IsString() @MaxLength(80) code?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) reference?: string | null;
}

export class ShipmentDatesDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) created_at?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) shipped_at?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) estimated_arrival_at?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) actual_arrival_at?: string | null;
}

export class ShipmentSummaryDto {
  @ApiProperty({ example: 8 }) @IsInt() @Min(0) @Max(100000) total_cartons!: number;
  @ApiProperty({ example: 100 }) @IsInt() @Min(0) @Max(1_000_000) total_products!: number;
  @ApiProperty({ example: 127 }) @IsInt() @Min(0) @Max(10_000_000) total_units!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) total_weight?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) weight_unit?: string | null;
}

export class CartonDimensionsDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) length?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) width?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) height?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) unit?: string | null;
}

export class ShipmentCartonDto {
  @ApiProperty({ example: 'CTN-2026-000001' })
  @IsString() @MinLength(1) @MaxLength(120)
  id!: string;

  @ApiPropertyOptional({ example: 'SHP145-01' })
  @IsOptional() @IsString() @MaxLength(120)
  reference?: string | null;

  @ApiPropertyOptional({ example: 'CTN-2026-000001' })
  @IsOptional() @IsString() @MaxLength(200)
  qr_code_value?: string | null;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(200)
  barcode_value?: string | null;

  @ApiProperty({ example: 1 }) @IsInt() @Min(1) @Max(100000) carton_number!: number;

  @ApiProperty({ example: 8 }) @IsInt() @Min(1) @Max(100000) total_cartons!: number;

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) weight?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) weight_unit?: string | null;

  @ApiPropertyOptional({ type: CartonDimensionsDto })
  @IsOptional() @ValidateNested() @Type(() => CartonDimensionsDto)
  dimensions?: CartonDimensionsDto | null;
}

export class ShipmentDto {
  @ApiProperty({ example: 'SHP-2026-000145' })
  @IsString() @MinLength(1) @MaxLength(160)
  id!: string;

  @ApiPropertyOptional({ example: 'SHEIN-TN-2026-00145' })
  @IsOptional() @IsString() @MaxLength(160)
  reference?: string | null;

  @ApiProperty({ type: ShipmentSourceDto })
  @ValidateNested() @Type(() => ShipmentSourceDto)
  source!: ShipmentSourceDto;

  @ApiPropertyOptional({ type: ShipmentCarrierDto })
  @IsOptional() @ValidateNested() @Type(() => ShipmentCarrierDto)
  carrier?: ShipmentCarrierDto | null;

  @ApiPropertyOptional({ type: ShipmentTrackingDto })
  @IsOptional() @ValidateNested() @Type(() => ShipmentTrackingDto)
  tracking?: ShipmentTrackingDto | null;

  @ApiPropertyOptional({ type: ShipmentSenderDto })
  @IsOptional() @ValidateNested() @Type(() => ShipmentSenderDto)
  sender?: ShipmentSenderDto | null;

  @ApiPropertyOptional({ type: ShipmentDestinationDto })
  @IsOptional() @ValidateNested() @Type(() => ShipmentDestinationDto)
  destination?: ShipmentDestinationDto | null;

  @ApiPropertyOptional({ type: ShipmentDatesDto })
  @IsOptional() @ValidateNested() @Type(() => ShipmentDatesDto)
  dates?: ShipmentDatesDto | null;

  @ApiProperty({ type: ShipmentSummaryDto })
  @ValidateNested() @Type(() => ShipmentSummaryDto)
  summary!: ShipmentSummaryDto;

  @ApiProperty({ type: [ShipmentCartonDto] })
  @ValidateNested({ each: true }) @Type(() => ShipmentCartonDto)
  cartons!: ShipmentCartonDto[];
}

export class ShipmentCardEventDto {
  @ApiProperty({ example: 'shipment.created' })
  @IsString() @IsIn(['shipment.created'])
  event!: 'shipment.created';

  @ApiPropertyOptional({ example: '1.0' })
  @IsOptional() @IsString() @MaxLength(20)
  schema_version?: string;

  @ApiProperty({ type: () => Object })
  @ValidateNested() @Type(() => ShipmentArrivalRefDto)
  arrival!: ShipmentArrivalRefDto;

  @ApiProperty({ type: ShipmentDto })
  @ValidateNested() @Type(() => ShipmentDto)
  shipment!: ShipmentDto;
}
