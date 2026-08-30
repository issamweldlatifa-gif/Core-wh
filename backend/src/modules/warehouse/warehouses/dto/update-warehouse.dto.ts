import { PartialType } from '@nestjs/swagger';
import { CreateWarehouseDto } from './create-warehouse.dto';

/** Partial update — code is typically immutable post-creation, but allowed. */
export class UpdateWarehouseDto extends PartialType(CreateWarehouseDto) {}
