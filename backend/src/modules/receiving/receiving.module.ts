import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { ReceivingService } from './receiving.service';
import { ReceivingReportsService } from './receiving-reports.service';
import { ReceivingController } from './receiving.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { TemporaryStorageModule } from '../temporary-storage/temporary-storage.module';
import { WorkflowModule } from '../workflow/workflow.module';

/**
 * Receiving — physical receipt of Expected Arrivals/Shipments pushed by the
 * AYROVI Arrival CRM. Consumes ExpectedArrival + WarehouseShipment/Carton
 * data and records receiving observations (sessions/cartons/products/
 * discrepancies) without ever mutating the expected data.
 *
 * WORKFLOW SEPARATION: report submit hands CONFIRMED product lines to
 * Temporary Storage (Output B) and ends the carton flow at the report
 * (Output A) — hence the TemporaryStorage + Workflow imports.
 */
@Module({
  imports: [PrismaModule, AuditModule, AssignmentsModule, NotificationsModule, TemporaryStorageModule, WorkflowModule],
  controllers: [ReceivingController],
  providers: [ReceivingService, ReceivingReportsService],
  exports: [ReceivingService, ReceivingReportsService],
})
export class ReceivingModule {}
