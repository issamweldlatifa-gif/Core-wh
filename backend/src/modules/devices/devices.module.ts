import { Module } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { DevicesController } from './devices.controller';
import { AuditModule } from '../audit/audit.module';

/**
 * Device registry (Doc3 §11, Doc2 §11). The devices the native worker app
 * runs on are real server entities: admin registers hardware, binds it to a
 * worker, disables it (which revokes that worker's device-bound sessions),
 * and watches lastSeen/appVersion for scanner monitoring.
 *
 * Surface: ADMIN_WEB only — workers never manage devices.
 */
@Module({
  imports: [AuditModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
