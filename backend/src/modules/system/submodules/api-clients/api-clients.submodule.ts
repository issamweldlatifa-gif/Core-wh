import { Module } from '@nestjs/common';
import { ApiClientsService } from './api-clients.service';
import { ApiClientsController } from './api-clients.controller';
import { AuditModule } from '../../../audit/audit.module';

/**
 * API Clients submodule — proves the internal module/submodule boundary.
 * Phase 0 provides schema + CRUD only; no machine-to-machine auth flow is
 * enabled yet (see OPEN-DECISIONS.md).
 */
@Module({
  imports: [AuditModule],
  controllers: [ApiClientsController],
  providers: [ApiClientsService],
  exports: [ApiClientsService],
})
export class ApiClientsSubmodule {}
