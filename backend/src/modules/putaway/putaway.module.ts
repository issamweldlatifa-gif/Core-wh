import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { CategoriesModule } from '../categories/categories.module';
import { PutawayService } from './putaway.service';
import { PutawayController } from './putaway.controller';

/**
 * Putaway / stowing — moves RECEIVED cartons onto real storage locations and
 * keeps an append-only placement ledger.
 */
@Module({
  imports: [PrismaModule, AuditModule, CategoriesModule],
  controllers: [PutawayController],
  providers: [PutawayService],
  exports: [PutawayService],
})
export class PutawayModule {}
