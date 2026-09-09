import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { OperationsService } from './operations.service';
import { StationsService } from './stations.service';
import { CorrectionsService } from './corrections.service';
import { TerminalService } from './terminal.service';
import { ReceivingModule } from '../receiving/receiving.module';
import { TemporaryStorageModule } from '../temporary-storage/temporary-storage.module';
import { WorkflowModule } from '../workflow/workflow.module';
import {
  OperationsController,
  StationsController,
  TerminalController,
} from './operations.controller';

/**
 * WAREHOUSE OS operations module: Station registry, Worker Terminal context,
 * Admin Control Center read models and the audited Correction workflow.
 *
 * It owns no receiving business logic — it reads the receiving tables and
 * mutates them only through the controlled, audited correction operations
 * (§7/§8), keeping ReceivingService the single writer for normal scanning.
 */
@Module({
  imports: [PrismaModule, AuditModule, AssignmentsModule, ReceivingModule, TemporaryStorageModule, WorkflowModule],
  controllers: [TerminalController, StationsController, OperationsController],
  providers: [OperationsService, StationsService, CorrectionsService, TerminalService],
  exports: [StationsService, TerminalService],
})
export class OperationsModule {}
