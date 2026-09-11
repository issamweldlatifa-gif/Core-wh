import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BatchesController } from './batches.controller';
import { BatchesService } from './batches.service';

/**
 * AYROVI BATCH — Phase 2 module (contract + operations).
 *
 * Contract slice: data model, state machine, AYB/AYP generators, feature
 * flag, permission keys, strict DTOs.
 * Operations slice (this version): BatchesService + BatchesController —
 * create/add-unit/submit (worker), accept/send/void (admin), start/receive/
 * complete (receiving) — every write replay-safe, audited atomically,
 * gated by `batch.enabled` (OFF by default).
 *
 * The module is deliberately SELF-CONTAINED: it depends only on Prisma
 * (global) and the existing AuditModule. It never touches expected-arrivals,
 * receiving, cartons or CRM — the DISPATCH-station reuse check happens in
 * the receiving slice and cannot introduce such a dependency.
 */
@Module({
  imports: [AuditModule],
  controllers: [BatchesController],
  providers: [BatchesService],
  exports: [BatchesService],
})
export class BatchesModule {}
