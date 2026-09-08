import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CartonCardsService } from './carton-cards.service';
import { CartonCardsController } from './carton-cards.controller';
import { CrmCartonCardsController, CrmCartonCardsLegacyController } from '../../integrations/crm/crm-carton-cards.controller';
import { IntegrationApiGuard } from '../../integrations/crm/integration-api.guard';

@Module({
  imports: [PrismaModule, AuditModule, AssignmentsModule, NotificationsModule],
  controllers: [CartonCardsController, CrmCartonCardsController, CrmCartonCardsLegacyController],
  providers: [CartonCardsService, IntegrationApiGuard],
  exports: [CartonCardsService],
})
export class CartonCardsModule {}
