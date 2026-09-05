import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SystemService } from './system.service';
import { SystemController } from './system.controller';
import { LiveController } from './live.controller';
import { ApiClientsSubmodule } from './submodules/api-clients/api-clients.submodule';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [ApiClientsSubmodule, AuditModule, JwtModule],
  controllers: [SystemController, LiveController],
  providers: [SystemService],
  exports: [SystemService],
})
export class SystemModule {}
