import { Type } from 'class-transformer';
import {
  IsArray,
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

export class CartonArrivalRefDto {
  @ApiProperty({ example: 'ARR-2026-00087' })
  @IsString() @MinLength(1) @MaxLength(160)
  id!: string;

  @ApiPropertyOptional({ example: 'ARR-2026-00087' })
  @IsOptional() @IsString() @MaxLength(160)
  reference?: string | null;
}

export class CartonProductDto {
  @ApiPropertyOptional({ example: 'prd_123' })
  @IsOptional() @IsString() @MaxLength(160)
  product_id?: string | null;

  @ApiPropertyOptional({ example: 'SKU-ABC-123' })
  @IsOptional() @IsString() @MaxLength(160)
  sku?: string | null;

  @ApiPropertyOptional({ example: 'REF-123' })
  @IsOptional() @IsString() @MaxLength(160)
  reference?: string | null;

  @ApiPropertyOptional({ example: 'Product name' })
  @IsOptional() @IsString() @MaxLength(400)
  product_name?: string | null;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional() @IsInt() @Min(1) @Max(100000)
  quantity?: number | null;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(300)
  variant?: string | null;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(120)
  color?: string | null;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(80)
  size?: string | null;
}

export class CartonDimensionsDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) length?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) width?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) height?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) unit?: string | null;
}

export class CartonCardDto {
  @ApiProperty({ example: 'CTN-2026-000001' })
  @IsString() @MinLength(1) @MaxLength(200)
  id!: string;

  @ApiPropertyOptional({ example: 'SHP145-01' })
  @IsOptional() @IsString() @MaxLength(200)
  reference?: string | null;

  // Explicit carton identity — must be CARTON, not PRODUCT
  @ApiPropertyOptional({ example: 'CARTON', enum: ['CARTON', 'PRODUCT'] })
  @IsOptional() @IsString() @MaxLength(20)
  entity_type?: string | null;

  @ApiPropertyOptional({ example: 'CTN-000123' })
  @IsOptional() @IsString() @MaxLength(200)
  carton_id?: string | null;

  // Suivi / Tracking preservation — multiple aliases supported
  @ApiPropertyOptional({ example: 'TRK-938472' })
  @IsOptional() @IsString() @MaxLength(200)
  suivi_code?: string | null;

  @ApiPropertyOptional({ example: 'TRK-938472' })
  @IsOptional() @IsString() @MaxLength(200)
  suivi?: string | null;

  @ApiPropertyOptional({ example: 'TRK-938472' })
  @IsOptional() @IsString() @MaxLength(200)
  tracking_code?: string | null;

  @ApiPropertyOptional({ example: 'TRK-938472' })
  @IsOptional() @IsString() @MaxLength(200)
  tracking_number?: string | null;

  @ApiPropertyOptional({ example: 'QR-123456' })
  @IsOptional() @IsString() @MaxLength(500)
  qr_code?: string | null;

  @ApiPropertyOptional({ example: 'CTN-2026-000001' })
  @IsOptional() @IsString() @MaxLength(500)
  qr_code_value?: string | null;

  @ApiPropertyOptional({ example: 'BC-123456' })
  @IsOptional() @IsString() @MaxLength(500)
  barcode?: string | null;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500)
  barcode_value?: string | null;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(200)
  source_project?: string | null;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional() @IsInt() @Min(1) @Max(100000)
  carton_number?: number | null;

  @ApiPropertyOptional({ example: 8 })
  @IsOptional() @IsInt() @Min(1) @Max(100000)
  total_cartons?: number | null;

  @ApiPropertyOptional()
  @IsOptional() @IsNumber() @Min(0)
  weight?: number | null;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(20)
  weight_unit?: string | null;

  @ApiPropertyOptional({ type: CartonDimensionsDto })
  @IsOptional() @ValidateNested() @Type(() => CartonDimensionsDto)
  dimensions?: CartonDimensionsDto | null;

  // Products inside carton — preserve relationship but keep parent as CARTON
  @ApiPropertyOptional({ type: [CartonProductDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CartonProductDto)
  products?: CartonProductDto[] | null;

  @ApiPropertyOptional({ description: 'Shipment / tracking info' })
  @IsOptional()
  shipment_info?: Record<string, any> | null;

  @ApiPropertyOptional({ description: 'Any additional metadata' })
  @IsOptional()
  metadata?: Record<string, any> | null;
}

export class CartonCardEventDto {
  @ApiProperty({ example: 'carton.created', enum: ['carton.created', 'carton_card.created'] })
  @IsString() @IsIn(['carton.created', 'carton_card.created'])
  event!: 'carton.created' | 'carton_card.created';

  @ApiPropertyOptional({ example: '1.0' })
  @IsOptional() @IsString() @MaxLength(20)
  schema_version?: string;

  @ApiProperty({ type: CartonArrivalRefDto })
  @ValidateNested() @Type(() => CartonArrivalRefDto)
  arrival!: CartonArrivalRefDto;

  @ApiProperty({ type: CartonCardDto })
  @ValidateNested() @Type(() => CartonCardDto)
  carton!: CartonCardDto;

  @ApiPropertyOptional({ description: 'Optional shipment wrapper' })
  @IsOptional()
  shipment?: Record<string, any> | null;
}
