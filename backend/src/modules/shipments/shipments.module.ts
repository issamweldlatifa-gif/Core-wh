import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ShipmentsService } from './shipments.service';
import { ShipmentsController } from './shipments.controller';
import { CrmShipmentsController } from '../../integrations/crm/crm-shipments.controller';
import { IntegrationApiGuard } from '../../integrations/crm/integration-api.guard';

/**
 * Inbound Shipments — physical shipping/carton data pushed by the AYROVI
 * Arrival CRM as Shipment Cards, linked to an Expected Arrival. Two surfaces:
 *  - CrmShipmentsController (@Public + service-auth guard): POST from the CRM
 *  - ShipmentsController (JWT + shipments.view): Warehouse UI read
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [CrmShipmentsController, ShipmentsController],
  providers: [ShipmentsService, IntegrationApiGuard],
  exports: [ShipmentsService],
})
export class ShipmentsModule {}
