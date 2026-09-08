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
      // FCM reported these as unregistered — prune so the table cannot grow
      // into a list of dead handsets.
      await this.prisma.pushToken.deleteMany({ where: { token: { in: invalidTokens } } });
    }
    return list.length - invalidTokens.length;
  }

  /**
   * NEW_RECEIVING_CARD (CARTON lane) — a Shipment Card landed.
   *
   * The carton keeps its own identity in the notification: the worker is told
   * the suivi/tracking code, not a product SKU, so the message matches what
   * they will scan on the box.
   */
  async notifyNewCartonCard(
    shipmentCode: string,
    cartonCount: number,
    trackingNumber: string | null,
  ): Promise<number> {
    try {
      const suivi = trackingNumber ? ` · Suivi: ${trackingNumber}` : '';
      return await this.notifyTaskAudience('receiving', {
        title: 'AYROVI Receiving',
        body: `New carton arrived · ${cartonCount} carton(s)${suivi}`,
        route: '/terminal/receiving',
        data: {
          event: 'NEW_RECEIVING_CARD',
          cardType: 'CARTON',
          shipmentCode,
          cartonCount: String(cartonCount),
          ...(trackingNumber ? { trackingNumber } : {}),
        },
      });
    } catch (err) {
      this.logger.error(`NEW_RECEIVING_CARD (carton) push failed for ${shipmentCode}: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * NEW_RECEIVING_CARD — emitted when a CRM arrival card lands.
   *
   * Delivery is best-effort and must NEVER fail the intake transaction: a
   * push outage cannot be allowed to reject a card that was already stored.
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
