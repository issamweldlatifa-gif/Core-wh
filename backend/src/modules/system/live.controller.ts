import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Request, Response } from 'express';
import { RequireApplication } from '../../common/decorators/require-application.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';

/**
 * Server-Sent Events stream for the Admin Live Dashboard.
 * Uses the shared JWT/application/permission guards. Credentials never travel in a URL.
 * Emits: scan.accepted, scan.rejected, exception.opened, bin.ready, packed, shipped, worker.heartbeat.
 */
@ApiTags('live')
@Controller('live')
@RequireApplication('ADMIN_WEB')
@RequirePermissions('operations.view')
export class LiveController {
  private clients = new Set<Response>();
  constructor(private readonly events: EventEmitter2) {
    const forward = (topic: string) => (payload: any) => this.broadcast({ topic, ts: Date.now(), payload });
    ['scan.accepted', 'scan.rejected', 'exception.opened', 'bin.ready', 'packed', 'shipped', 'worker.heartbeat']
      .forEach((t) => events.on(t, forward(t)));
  }

  @Get('events')
  @ApiOperation({ summary: 'Authenticated Admin operation stream.' })
  async stream(@Req() req: Request, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`event: hello\ndata: ${JSON.stringify({ t: Date.now(), ok: true })}\n\n`);

    this.clients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 25000);
    // Bound each stream lifetime so subsequent connection re-enters live DB authorization guards.
    const renew = setTimeout(() => res.end(), 60_000);
    req.on('close', () => { clearInterval(ping); clearTimeout(renew); this.clients.delete(res); });
  }

  private broadcast(event: any) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of Array.from(this.clients)) {
      try { c.write(data); } catch { /* closed */ }
    }
  }
}
