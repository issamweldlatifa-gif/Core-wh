import { Module } from '@nestjs/common';

/**
 * AYROVI BATCH — Phase 2 CONTRACT module.
 *
 * Ships the data model (Prisma), the lifecycle state machine, the AYB/AYP
 * code generators, the feature flag (`batch.enabled`, OFF by default), the
 * permission keys and the strict DTOs. NO controller and NO routes yet:
 * wiring lands in the following phases (Worker App -> Admin -> Receiving),
 * each behind its own green gate. The module is registered so the contract
 * is part of the compiled application from day one.
 */
@Module({})
export class BatchesModule {}
