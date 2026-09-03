import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listSettings() {
    return this.prisma.systemSetting.findMany({ orderBy: { key: 'asc' } });
  }

  async getSetting(key: string) {
    return this.prisma.systemSetting.findUnique({ where: { key } });
  }

  async upsertSetting(key: string, value: Record<string, unknown>, description: string | undefined, actorUserId: string, ip?: string) {
    const saved = await this.prisma.systemSetting.upsert({
      where: { key },
      update: { value: value as any, description: description ?? null, updatedBy: actorUserId },
      create: { key, value: value as any, description: description ?? null, updatedBy: actorUserId },
    });
    await this.audit.log({
      actorUserId,
      action: 'SETTINGS_UPDATED',
      entityType: 'system_setting',
      entityId: key,
      ipAddress: ip,
      metadata: { key },
    });
    return saved;
  }

  async health() {
    const db = await this.prisma.$queryRaw`SELECT 1 as ok`.catch(() => null);
    return {
      status: 'ok',
      version: '0.1.0',
      phase: '0',
      database: db ? 'up' : 'down',
      build: this.readBuildInfo(),
      timestamp: new Date().toISOString(),
    };
  }

  /** Reads public/build-info.json written by build.sh (additive; absent in dev).
   *  Runtime cwd is backend/ and the SPA is served from backend/public (see
   *  main.ts), so from dist/modules/system that is three levels up. */
  private readBuildInfo(): Record<string, string> {
    try {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const file = path.join(__dirname, '..', '..', '..', 'public', 'build-info.json');
      if (!fs.existsSync(file)) return { commitShort: 'dev', spaAsset: 'vite' };
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { commitShort: 'unknown', spaAsset: 'unknown' };
    }
  }
}
