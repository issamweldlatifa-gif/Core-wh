import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AssignmentsService, WorkPolicyService } from './assignments.service';

/**
 * Worker operational assignments + work policy.
 *
 * Imported by Receiving, Putaway, Fulfillment (workflow-driven lifecycle
 * sync + station/department enforcement) and by Operations (admin
 * assignment management). Depends only on Prisma + Audit — no cycles.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  providers: [AssignmentsService, WorkPolicyService],
  exports: [AssignmentsService, WorkPolicyService],
})
export class AssignmentsModule {}
