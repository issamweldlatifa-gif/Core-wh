import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
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
 * Payload contract for the Arrival CRM -> Warehouse inbound push.
 *
 * Structured JSON only (no HTML/screenshot/PDF). The CRM sends a Customer
 * Arrival Card once an Arrival is confirmed and the card is READY_TO_SEND.
 * Fields that a given store does not provide arrive as `null` (the schema is
 * deliberately store-agnostic).
 */

export class ArrivalRefDto {
  @ApiProperty({ example: 'ARR-JAN-2026-001' })
  @IsString() @MinLength(1) @MaxLength(160)
  id!: string;

  @ApiPropertyOptional({ example: 'JAN-2026-001' })
  @IsOptional() @IsString() @MaxLength(160)
  reference?: string | null;
}

export class ArrivalCustomerDto {
  @ApiProperty({ example: 'CUS-001' })
  @IsString() @MinLength(1) @MaxLength(160)
  id!: string;

  @ApiProperty({ example: 'Ahmed' })
  @IsString() @MinLength(1) @MaxLength(200)
  name!: string;
}

export class ArrivalStoreDto {
  @ApiPropertyOptional({ example: 'STORE-SHEIN' })
  @IsOptional() @IsString() @MaxLength(160)
  id?: string | null;

  @ApiPropertyOptional({ example: 'SHEIN' })
  @IsOptional() @IsString() @MaxLength(160)
  name?: string | null;
}

export class ArrivalProductDto {
  @ApiPropertyOptional({ example: 'prd_123' })
  @IsOptional() @IsString() @MaxLength(160)
  product_id?: string | null;

  @ApiPropertyOptional({ example: 'sb25092090066487374' })
  @IsOptional() @IsString() @MaxLength(160)
  sku?: string | null;

  @ApiPropertyOptional({ example: 'sb25092090066487374' })
  @IsOptional() @IsString() @MaxLength(160)
  reference?: string | null;

  @ApiPropertyOptional({ example: 'Grande boîte à bijoux' })
  @IsOptional() @IsString() @MaxLength(400)
  product_name?: string | null;

  @ApiProperty({ example: 1, minimum: 1, maximum: 100000 })
  @IsInt() @Min(1) @Max(100000)
  quantity!: number;

  @ApiPropertyOptional({ example: 'Multicolore-Blanc' })
  @IsOptional() @IsString() @MaxLength(300)
  variant?: string | null;

  @ApiPropertyOptional({ example: 'Black', nullable: true })
  @IsOptional() @IsString() @MaxLength(120)
  color?: string | null;

  @ApiPropertyOptional({ example: '42', nullable: true })
  @IsOptional() @IsString() @MaxLength(80)
  size?: string | null;

  @ApiPropertyOptional({ example: 'STORE-SHEIN' })
  @IsOptional() @IsString() @MaxLength(160)
  store_id?: string | null;

  @ApiPropertyOptional({ example: 'SHEIN' })
  @IsOptional() @IsString() @MaxLength(160)
  store_name?: string | null;
}

export class CustomerArrivalCardDto {
  @ApiProperty({ example: 'CARD-ARR-2026-000145' })
  @IsString() @MinLength(1) @MaxLength(160)
  id!: string;

  @ApiProperty({ type: ArrivalCustomerDto })
  @IsObject() @ValidateNested() @Type(() => ArrivalCustomerDto)
  customer!: ArrivalCustomerDto;

  @ApiPropertyOptional({ type: ArrivalStoreDto })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => ArrivalStoreDto)
  store?: ArrivalStoreDto | null;

  @ApiProperty({ type: [ArrivalProductDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000)
  @ValidateNested({ each: true }) @Type(() => ArrivalProductDto)
  products!: ArrivalProductDto[];
}

export class CustomerArrivalCardEventDto {
  @ApiProperty({ example: 'customer_arrival_card.created' })
  @IsString() @IsIn(['customer_arrival_card.created'])
  event!: 'customer_arrival_card.created';

  @ApiProperty({ type: ArrivalRefDto })
  @IsObject() @ValidateNested() @Type(() => ArrivalRefDto)
  arrival!: ArrivalRefDto;

  @ApiProperty({ type: CustomerArrivalCardDto })
  @IsObject() @ValidateNested() @Type(() => CustomerArrivalCardDto)
  customer_arrival_card!: CustomerArrivalCardDto;
}
