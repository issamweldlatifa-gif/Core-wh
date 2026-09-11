import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ExpectedArrivalsService } from './expected-arrivals.service';
import { ExpectedArrivalsController } from './expected-arrivals.controller';

/**
 * Expected Arrivals — the HISTORICAL arrival ledger (previous CRM Arrival
 * flow) and its Warehouse-UI read/manage surface. NOT physical receiving
 * (status stays EXPECTED / RECEIVED / VOIDED …).
 *
 * PHASE 1 (AYROVI Batch architecture): the legacy CRM intake controller
 * (POST /integrations/arrivals/customer-cards) and its auto-dispatch/push
 * wiring were REMOVED — new operational arrivals no longer enter through
 * CRM. Historical records stay fully readable/auditable here.
 *
 * One surface:
 *  - ExpectedArrivalsController (JWT + expected_arrivals.view): Warehouse UI
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [ExpectedArrivalsController],
  providers: [ExpectedArrivalsService],
  exports: [ExpectedArrivalsService],
})
export class ExpectedArrivalsModule {}
