import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CrmOrdersController } from '../../integrations/crm/crm-orders.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * Orders — API layer over the existing Phase-2 order projection models.
 *  - CrmOrdersController (@Public + service-auth guard): external intake.
 *  - OrdersController (JWT): read surface for admin/terminals.
 */
@Module({
  imports: [AuditModule],
  controllers: [CrmOrdersController, OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
