import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ReceivingService } from './receiving.service';
import { ReceivingController } from './receiving.controller';

/**
 * Receiving — physical receipt of Expected Arrivals/Shipments pushed by the
 * AYROVI Arrival CRM. Consumes ExpectedArrival + WarehouseShipment/Carton
 * data and records receiving observations (sessions/cartons/products/
 * discrepancies) without ever mutating the expected data.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [ReceivingController],
  providers: [ReceivingService],
  exports: [ReceivingService],
})
export class ReceivingModule {}
