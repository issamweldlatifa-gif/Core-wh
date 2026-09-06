import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AssignmentsService, WorkPolicyService } from './assignments.service';
import { TaskDispatchService } from './dispatch.service';

/**
 * Worker operational assignments + work policy + automatic dispatch.
 *
 * Imported by Receiving, Putaway, Fulfillment (workflow-driven lifecycle
 * sync + station/department enforcement + automatic next-task dispatch) and
 * by Operations (admin assignment management). Depends only on Prisma +
 * Audit — no cycles.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  providers: [AssignmentsService, WorkPolicyService, TaskDispatchService],
  exports: [AssignmentsService, WorkPolicyService, TaskDispatchService],
})
export class AssignmentsModule {}
