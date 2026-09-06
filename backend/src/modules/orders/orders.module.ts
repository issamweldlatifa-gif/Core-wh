import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { CrmOrdersController } from '../../integrations/crm/crm-orders.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * Orders — API layer over the existing Phase-2 order projection models.
 *  - CrmOrdersController (@Public + service-auth guard): external intake.
 *  - OrdersController (JWT): read surface for admin/terminals.
 */
@Module({
  imports: [AuditModule, PrismaModule, AssignmentsModule],
  controllers: [CrmOrdersController, OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
