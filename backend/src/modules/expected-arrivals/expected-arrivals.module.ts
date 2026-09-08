import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { ExpectedArrivalsService } from './expected-arrivals.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ExpectedArrivalsController } from './expected-arrivals.controller';
import { CrmArrivalsController } from '../../integrations/crm/crm-arrivals.controller';
import { IntegrationApiGuard } from '../../integrations/crm/integration-api.guard';

/**
 * Expected Arrivals — inbound Customer Arrival Cards pushed by the AYROVI
 * Arrival CRM via the external integration endpoint, read back through the
 * Warehouse UI. NOT physical receiving (status stays EXPECTED).
 *
 * Two surfaces share one service:
 *  - CrmArrivalsController (public + service-auth guard) : POST from the CRM
 *  - ExpectedArrivalsController (JWT + expected_arrivals.view): Warehouse UI
 */
@Module({
  imports: [NotificationsModule, PrismaModule, AuditModule, AssignmentsModule],
  controllers: [CrmArrivalsController, ExpectedArrivalsController],
  providers: [ExpectedArrivalsService, IntegrationApiGuard],
  exports: [ExpectedArrivalsService],
})
export class ExpectedArrivalsModule {}
