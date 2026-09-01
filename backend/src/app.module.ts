import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { EventsModule } from './events/events.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { RolesModule } from './modules/roles/roles.module';
import { PermissionsModule } from './modules/permissions/permissions.module';
import { AuditModule } from './modules/audit/audit.module';
import { SystemModule } from './modules/system/system.module';
import { WarehouseModule } from './modules/warehouse/warehouse.module';
import { ExpectedArrivalsModule } from './modules/expected-arrivals/expected-arrivals.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';

/**
 * AYROVI Warehouse Core — Modular Monolith root module.
 *
 * Each directory under modules/ is an isolated module. Horizontal
 * communication happens through services / an internal event bus only —
 * never by reaching into another module's tables directly. This keeps the
 * design ready for extracting any module into an independent service later.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env', '.env.example'],
    }),
    PrismaModule,
    EventsModule,
    IntegrationsModule,
    AuthModule,
    UsersModule,
    RolesModule,
    PermissionsModule,
    AuditModule,
    SystemModule,
    WarehouseModule,
    ExpectedArrivalsModule,
  ],
  providers: [
    // Global guards: every route is authenticated and permission-checked
    // unless explicitly marked @Public() / @RequirePermissions().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
