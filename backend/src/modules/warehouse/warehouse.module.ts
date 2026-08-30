import { Module } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { WarehouseController } from './warehouse.controller';
import { AuditModule } from '../audit/audit.module';

/**
 * Warehouse module — Phase 0 exposes ONLY the minimal warehouse foundation
 * (identification/config of the warehouse being managed). NO operational
 * workflows: no receiving, picking, packing, shipping, inventory movement.
 */
@Module({
  imports: [AuditModule],
  controllers: [WarehouseController],
  providers: [WarehouseService],
  exports: [WarehouseService],
})
export class WarehouseModule {}
