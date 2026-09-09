import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { TemporaryStorageService } from './temporary-storage.service';
import { TemporaryStorageController } from './temporary-storage.controller';

/**
 * Temporary Storage — backend/workflow station for Receiving Output B
 * (Produit + Carte). Imported by Receiving (auto-handoff on report submit)
 * and Operations (admin read). No worker UI in this step.
 */
@Module({
  imports: [PrismaModule, AuditModule, AssignmentsModule, WorkflowModule],
  controllers: [TemporaryStorageController],
  providers: [TemporaryStorageService],
  exports: [TemporaryStorageService],
})
export class TemporaryStorageModule {}
