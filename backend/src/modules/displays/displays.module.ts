import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DisplaysService } from './displays.service';
import { DisplayItemAdminController, StationDisplaysAdminController } from './displays-admin.controller';
import { DisplayViewsController } from './display-views.controller';

/**
 * Station Display Mode (owner order 2026-09-16).
 * Admin side: Station → Display Mode (JWT + stations.* permissions) and the
 * stage-2 fleet console (/station-displays).
 * Public side: /display/:token screens — read-only snapshot + SSE stream, and
 * (stage 2, opt-in per display) station actions: print/reprint, acknowledge,
 * help, exception, message-seen. Every action is audited with the display's
 * identity. CT40 and the worker workflow are untouched: the display reads the
 * same transaction tables and reuses the same services.
 */
@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [StationDisplaysAdminController, DisplayItemAdminController, DisplayViewsController],
  providers: [DisplaysService],
  exports: [DisplaysService],
})
export class DisplaysModule {}
