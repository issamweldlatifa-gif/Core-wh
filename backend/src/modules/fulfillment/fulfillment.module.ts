import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { CategoriesModule } from '../categories/categories.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { FulfillmentController } from './fulfillment.controller';
import { FulfillmentService } from './fulfillment.service';

@Module({
  imports: [AuditModule, AssignmentsModule, CategoriesModule, WorkflowModule],
  controllers: [FulfillmentController],
  providers: [FulfillmentService],
  exports: [FulfillmentService],
})
export class FulfillmentModule {}
