import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TemporaryStorageService } from './temporary-storage.service';
import {
  TemporaryStorageAdminController,
  TemporaryStorageController,
} from './temporary-storage.controller';

/**
 * Temporary Storage station — Product Flow only (Produit + Carte).
 *
 * Worker terminal (WORKER_NATIVE) + admin oversight (ADMIN_WEB) reuse the
 * existing auth/permission/audit/push layers. The station consumes the
 * receiving output (STAGING product moves) and emits: stored units inside
 * section containers, REVIEW items + exceptions, and the Rapport de Fin.
 */
@Module({
  imports: [PrismaModule, AuditModule, NotificationsModule],
  controllers: [TemporaryStorageController, TemporaryStorageAdminController],
  providers: [TemporaryStorageService],
  exports: [TemporaryStorageService],
})
export class TemporaryStorageModule {}
