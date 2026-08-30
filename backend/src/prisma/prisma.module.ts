import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global Prisma provider so any module can inject PrismaService.
 * Domain modules should still expose their own repository/service
 * interfaces and avoid leaking raw Prisma calls across module boundaries.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
