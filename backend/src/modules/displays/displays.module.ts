import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DisplaysService } from './displays.service';
import { DisplayItemAdminController, StationDisplaysAdminController } from './displays-admin.controller';
import { DisplayViewsController } from './display-views.controller';

/**
 * Station Display Mode (owner order 2026-09-16).
 * Admin side: Station → Display Mode (JWT + stations.* permissions).
 * Public side: /display/:token screens — read-only snapshot + SSE stream,
 * authenticated by the display token alone. CT40 and the worker workflow
 * are untouched: the display reads the same transaction tables.
 */
@Module({
  imports: [AuditModule],
  controllers: [StationDisplaysAdminController, DisplayItemAdminController, DisplayViewsController],
  providers: [DisplaysService],
  exports: [DisplaysService],
})
export class DisplaysModule {}
