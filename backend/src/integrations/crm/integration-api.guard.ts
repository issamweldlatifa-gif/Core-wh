import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Service-to-service authentication for external integration endpoints.
 *
 * Two accepted credentials (server-side only, never exposed to the UI):
 *
 *  1. A static shared secret sent as `x-api-key` (or `Authorization: Bearer`)
 *     matching `WAREHOUSE_INTEGRATION_API_KEY`. This is the simple
 *     CRM→Warehouse credential configured in the CRM environment.
 *
 *  2. A registered ApiClient: send client id as `x-client-id` and the
 *     plaintext secret as `x-api-key`. The stored secret is SHA-256 hashed,
 *     so comparison is constant-time against the hash.
 *
 * The route is otherwise skipped by the global JWT guard (it is marked
 * @Public) — this guard is its dedicated authentication layer.
 */
@Injectable()
export class IntegrationApiGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const headers = request.headers ?? {};

    const apiKey =
      String(headers['x-api-key'] ?? '').trim() ||
      (String(headers['authorization'] ?? '').startsWith('Bearer ')
        ? String(headers['authorization']).slice(7).trim()
        : '');
    const clientId = String(headers['x-client-id'] ?? '').trim();
    const idempotencyKey = String(headers['idempotency-key'] ?? '').trim() || null;

    if (!apiKey) {
      throw new UnauthorizedException('Missing API credential (x-api-key).');
    }

    // 1) Static shared integration secret.
    const staticKey = (process.env.WAREHOUSE_INTEGRATION_API_KEY ?? '').trim();
    if (staticKey && this.safeEqual(apiKey, staticKey)) {
      request.integrationClient = { kind: 'static', id: null, name: 'ARRIVAL_CRM', idempotencyKey };
      return true;
    }

    // 2) Registered API client (id + secret).
    if (clientId) {
      const client = await this.prisma.apiClient.findUnique({ where: { clientId } });
      if (client && client.status === 'ACTIVE') {
        const presentedHash = this.sha256(apiKey);
        if (this.safeEqual(presentedHash, client.clientSecretHash)) {
          request.integrationClient = {
            kind: 'api_client',
            id: client.id,
            name: client.name,
            idempotencyKey,
          };
          return true;
        }
      }
    }

    throw new UnauthorizedException('Invalid integration credentials.');
  }
}
