import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { WorkflowService } from './workflow.service';

/**
 * WORKFLOW SEPARATION kernel: the append-only flow ledger + the
 * product-station carton guard. Imported by Receiving, Temporary Storage and
 * Fulfillment; imports nothing operational (no cycles by construction).
 */
@Module({
  imports: [PrismaModule, AuditModule],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
