import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TaskDispatchService } from '../assignments/dispatch.service';

/**
 * PUSH DELIVERY for worker-facing events.
 *
 * The Worker App must be told about a new receiving card even when it is in
 * the background or fully closed, so the notification cannot be produced by
 * the app itself. The backend owns the event and pushes it to every device
 * registered by a worker who is ALLOWED to do the work.
 *
 * Audience = permission, not assignment. A receiving card is a shared queue
 * item, so every worker holding the receiving permission is notified — not
 * only the one named by the auto-dispatched WorkerTaskAssignment row.
 *
 * TRANSPORT: `PushTransport` is the seam to FCM. A real FCM sender is wired
 * in production via PUSH_TRANSPORT; when no credentials are configured the
 * no-op transport logs instead of sending, so the rest of the pipeline
 * (audience resolution, payload, token lifecycle) is fully exercised and
 * testable without a Firebase project.
 */
export interface PushMessage {
  title: string;
  body: string;
  /** Deep-link route the app opens when the notification is tapped. */
  route: string;
  data?: Record<string, string>;
}

export interface PushTransport {
  send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }>;
}

/** Default transport: no credentials configured -> log, never throw. */
export class LoggingPushTransport implements PushTransport {
  private readonly logger = new Logger('PushTransport');
  async send(tokens: string[], message: PushMessage) {
    this.logger.log(
      `PUSH (no FCM credentials configured) -> ${tokens.length} device(s): ${message.title} | ${message.body} | route=${message.route}`,
    );
    return { invalidTokens: [] };
  }
}

export const PUSH_TRANSPORT = Symbol('PUSH_TRANSPORT');

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: TaskDispatchService,
    private readonly transport: PushTransport,
  ) {}

  /** Register (or refresh) a device token for a worker. Idempotent per token. */
  async register(userId: string, token: string, platform = 'ANDROID', deviceId?: string) {
    if (!token?.trim()) return null;
    return this.prisma.pushToken.upsert({
      where: { token },
      // A phone can be handed to another worker: re-registering an existing
      // token must move it, never create a duplicate row.
      update: { userId, platform, deviceId: deviceId ?? null, lastSeenAt: new Date() },
      create: { token, userId, platform, deviceId: deviceId ?? null },
    });
  }

  /** Drop a token (logout / app uninstall reported by the client). */
  async unregister(token: string) {
    await this.prisma.pushToken.deleteMany({ where: { token } });
  }

  /**
   * Notify every worker eligible to execute `taskKey`.
   * Returns the number of devices the message was sent to.
   */
  async notifyTaskAudience(taskKey: string, message: PushMessage): Promise<number> {
    const workers = await this.dispatch.eligibleWorkers(taskKey);
    if (workers.length === 0) {
      this.logger.warn(`No worker is eligible for "${taskKey}" — push not sent. Check roles/permissions.`);
      return 0;
    }
    const tokens = await this.prisma.pushToken.findMany({
      where: { userId: { in: workers.map((w) => w.id) } },
      select: { token: true },
    });
    if (tokens.length === 0) {
      this.logger.warn(`${workers.length} eligible worker(s) for "${taskKey}" but no registered device token.`);
      return 0;
    }
    const list = tokens.map((t) => t.token);
    const { invalidTokens } = await this.transport.send(list, message);
    if (invalidTokens.length) {
      await this.prisma.pushToken.deleteMany({ where: { token: { in: invalidTokens } } });
    }
    return list.length - invalidTokens.length;
  }

  /**
   * CARTON FIX - Unified notifyNewCartonCard
   * Supports both signatures:
   *  - (shipmentCode, cartonCount, trackingNumber) -> legacy / remote
   *  - (arrivalCode, cartonId, suiviCode) -> new carton fix
   *
   * The carton keeps its own identity in the notification: the worker is told
   * the suivi/tracking code, not a product SKU, so the message matches what
   * they will scan on the box.
   *
   * Works when app open/background/closed via FCM.
   * Example payload required:
   * {
   *   "event": "NEW_CARTON_CARD",
   *   "arrivalCode": "WAR-...",
   *   "cartonId": "CTN-...",
   *   "suiviCode": "SUIVI-12345",
   *   "entityType": "CARTON",
   *   "route": "/terminal/receiving",
   *   "title": "AYROVI Receiving",
   *   "body": "📦 New carton arrived\nSuivi: SUIVI-12345"
   * }
   */
  async notifyNewCartonCard(
    shipmentOrArrivalCode: string,
    cartonIdOrCount: string | number,
    suiviOrTracking: string | null | undefined,
  ): Promise<number> {
    try {
      const isCount = typeof cartonIdOrCount === 'number';
      const cartonId = isCount ? shipmentOrArrivalCode : String(cartonIdOrCount);
      const suiviCode = suiviOrTracking ?? null;
      const cartonCount = isCount ? (cartonIdOrCount as number) : 1;

      // Body with suivi if available
      const body = suiviCode
        ? `📦 New carton arrived\nSuivi: ${suiviCode}`
        : isCount
          ? `📦 New carton arrived · ${cartonCount} carton(s)`
          : `📦 New carton arrived · ${cartonId}`;

      // Extra tracking info for legacy
      const suiviSuffix = !isCount && suiviCode ? '' : suiviCode ? ` · Suivi: ${suiviCode}` : '';

      return await this.notifyTaskAudience('receiving', {
        title: 'AYROVI Receiving',
        body: isCount && !suiviCode ? `New carton arrived · ${cartonCount} carton(s)` : body,
        route: '/terminal/receiving',
        data: {
          event: 'NEW_CARTON_CARD',
          arrivalCode: shipmentOrArrivalCode,
          cartonId: cartonId,
          suiviCode: suiviCode ?? '',
          entityType: 'CARTON',
          route: '/terminal/receiving',
          // legacy fields for backward compat
          shipmentCode: shipmentOrArrivalCode,
          cartonCount: String(cartonCount),
          ...(suiviCode ? { trackingNumber: suiviCode, tracking_code: suiviCode, suivi_code: suiviCode } : {}),
        },
      });
    } catch (err) {
      this.logger.error(`NEW_CARTON_CARD push failed for ${shipmentOrArrivalCode}: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * NEW_RECEIVING_CARD — emitted when a CRM arrival card lands.
   */
  async notifyNewReceivingCard(arrivalCode: string, productCount: number): Promise<number> {
    try {
      return await this.notifyTaskAudience('receiving', {
        title: 'AYROVI Receiving',
        body: `New receiving card arrived · ${arrivalCode}`,
        route: '/terminal/receiving',
        data: { event: 'NEW_RECEIVING_CARD', cardType: 'PRODUCT', arrivalCode, productCount: String(productCount) },
      });
    } catch (err) {
      this.logger.error(`NEW_RECEIVING_CARD push failed for ${arrivalCode}: ${(err as Error).message}`);
      return 0;
    }
  }
}
