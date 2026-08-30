import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { WarehousesService } from './warehouses/warehouses.service';
import { WarehousesController } from './warehouses/warehouses.controller';
import { ZonesService } from './zones/zones.service';
import { ZonesController } from './zones/zones.controller';
import { AislesService } from './aisles/aisles.service';
import { AislesController } from './aisles/aisles.controller';
import { RacksService } from './racks/racks.service';
import { RacksController } from './racks/racks.controller';
import { LevelsService } from './levels/levels.service';
import { LevelsController } from './levels/levels.controller';
import { LocationsService } from './locations/locations.service';
import { LocationsController } from './locations/locations.controller';

/**
 * Phase 1 — Physical Warehouse Foundation module.
 *
 * Aggregates the per-entity submodules (warehouses, zones, aisles, racks,
 * levels, locations) under the `warehouse` module boundary. Each submodule
 * talks to the DB via its own service; they do not reach into one another's
 * tables directly (modular-monolith rule). This module only models the
 * PHYSICAL structure — NO operational workflows (receiving/picking/...).
 */
@Module({
  imports: [AuditModule],
  controllers: [
    WarehousesController,
    ZonesController,
    AislesController,
    RacksController,
    LevelsController,
    LocationsController,
  ],
  providers: [
    WarehousesService,
    ZonesService,
    AislesService,
    RacksService,
    LevelsService,
    LocationsService,
  ],
  exports: [WarehousesService],
})
export class WarehouseModule {}
