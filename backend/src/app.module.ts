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
import { ShipmentsModule } from './modules/shipments/shipments.module';
import { ReceivingModule } from './modules/receiving/receiving.module';
import { OperationsModule } from './modules/operations/operations.module';
import { PutawayModule } from './modules/putaway/putaway.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { OrdersModule } from './modules/orders/orders.module';
import { FulfillmentModule } from './modules/fulfillment/fulfillment.module';
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
      // SECURITY: never fall back to .env.example — it contains placeholder
      // JWT secrets. Falling back silently would let a misconfigured
      // production deploy run with publicly known signing keys.
      envFilePath: ['.env', '../.env'],
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
    ShipmentsModule,
    ReceivingModule,
    OperationsModule,
    PutawayModule,
    CategoriesModule,
    OrdersModule,
    FulfillmentModule,
  ],
  providers: [
    // Global guards: every route is authenticated and permission-checked
    // unless explicitly marked @Public() / @RequirePermissions().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
