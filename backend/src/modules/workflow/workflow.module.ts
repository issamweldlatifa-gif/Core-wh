import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

/**
 * Station-chain workflow. Deliberately depends only on Prisma + Audit:
 * the receiving module consumes it (submit -> handoff) without a cycle.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [WorkflowController],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
