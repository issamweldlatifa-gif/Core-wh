import { Module } from '@nestjs/common';
import { SystemService } from './system.service';
import { SystemController } from './system.controller';
import { ApiClientsSubmodule } from './submodules/api-clients/api-clients.submodule';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [ApiClientsSubmodule, AuditModule],
  controllers: [SystemController],
  providers: [SystemService],
  exports: [SystemService],
})
export class SystemModule {}
