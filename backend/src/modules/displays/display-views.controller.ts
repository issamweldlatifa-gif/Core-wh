import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { DisplaysService, snapshotFingerprint, DISPLAY_OFFLINE_AFTER_MS } from './displays.service';

/**
 * PUBLIC, read-only endpoints behind a Station Display URL (§6/§7).
 *
 * Auth = possession of the 256-bit display token in the path. There is NO
 * admin/worker authority here: only two GET routes exist (snapshot + stream),
 * neither accepts any write input. The token can be regenerated from the
 * admin Station → Display Mode panel, killing every old URL instantly.
 */
@ApiTags('display-views')
@Public()
@Controller('display-views')
export class DisplayViewsController {
  /** Domain topics that justify an instant re-snapshot (existing bus). */
  private static readonly INSTANT_TOPICS = [
    'scan.accepted',
    'scan.rejected',
    'bin.ready',
    'packed',
    'shipped',
    'exception.opened',
    'station.activity',
  ];

  constructor(
    private readonly displays: DisplaysService,
    private readonly events: EventEmitter2,
  ) {}

  @Get(':token')
  @ApiOperation({ summary: 'One-shot read-only snapshot for a display screen.' })
  async snapshot(@Param('token') token: string, @Res() res: Response) {
    const snap = await this.displays.snapshotForToken(token);
    if (!snap) return res.status(404).json({ error: 'DISPLAY_NOT_FOUND' });
    void this.displays.touch(token);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(snap);
  }

  @Get(':token/stream')
  @ApiOperation({ summary: 'SSE live stream: snapshot + change pushes + heartbeat. Read-only.' })
  async stream(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const initial = await this.displays.snapshotForToken(token);
    if (!initial) return res.status(404).json({ error: 'DISPLAY_NOT_FOUND' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`event: hello\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
    res.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);

    void this.displays.touch(token);

    let fingerprint = snapshotFingerprint(initial);
    let closed = false;

    const push = async (force = false) => {
      if (closed) return;
      try {
        const snap = await this.displays.snapshotForToken(token);
        if (!snap || closed) return;
        const fp = snapshotFingerprint(snap);
        if (force || fp !== fingerprint) {
          fingerprint = fp;
          res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
        }
        void this.displays.touch(token);
      } catch {
        /* transient DB hiccup — next tick retries */
      }
    };

    // Instant reconcile on domain events (existing event bus), a bounded
    // reconcile tick so stations whose writers emit nothing still update
    // live, and a heartbeat to keep proxies from closing the stream.
    const handlers = DisplayViewsController.INSTANT_TOPICS.map((t) => {
      const h = () => void push(true);
      this.events.on(t, h);
      return [t, h] as [string, () => void];
    });
    const reconcile = setInterval(() => void push(), 3_000);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 25_000);
    // Bound each stream lifetime so a long-lived screen periodically re-enters
    // the (public, token-checked) authorization path — same pattern as Live.
    const renew = setTimeout(() => res.end(), 240_000);

    req.on('close', () => {
      closed = true;
      clearInterval(reconcile);
      clearInterval(heartbeat);
      clearTimeout(renew);
      for (const [t, h] of handlers) this.events.off(t, h);
      void this.displays.touch(token);
    });
    return res;
  }

  @Get(':token/health')
  @ApiOperation({ summary: 'Token liveness for the display page’s offline banner.' })
  async health(@Param('token') token: string) {
    const display = await this.displays.listTokenMeta(token);
    if (!display) return { ok: false };
    const online = display.lastSeenAt ? Date.now() - +new Date(display.lastSeenAt) < DISPLAY_OFFLINE_AFTER_MS : false;
    return { ok: true, enabled: display.enabled, online };
  }
}
