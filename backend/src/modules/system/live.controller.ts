import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Request, Response } from 'express';
import { JwtService } from '@nestjs/jwt';

/**
 * Server-Sent Events stream for the Admin Live Dashboard.
 * Accepts JWT via ?token= query parameter (EventSource cannot send headers).
 * Emits: scan.accepted, scan.rejected, exception.opened, bin.ready, packed, shipped, worker.heartbeat.
 */
@ApiTags('live')
@Controller('live')
export class LiveController {
  private clients = new Set<Response>();
  constructor(private readonly events: EventEmitter2, private readonly jwt: JwtService) {
    const forward = (topic: string) => (payload: any) => this.broadcast({ topic, ts: Date.now(), payload });
    ['scan.accepted', 'scan.rejected', 'exception.opened', 'bin.ready', 'packed', 'shipped', 'worker.heartbeat']
      .forEach((t) => events.on(t, forward(t)));
  }

  @Get('events')
  @ApiOperation({ summary: 'SSE stream of warehouse events (admin, token via ?token=)' })
  async stream(@Req() req: Request, @Res() res: Response, @Query('token') token?: string) {
    // Authenticate: support both Authorization header and ?token= (for EventSource)
    const authHeader = req.headers.authorization;
    const rawToken = token ?? (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
    if (!rawToken) { res.status(401).end('Unauthorized'); return; }
    try {
      this.jwt.verify(rawToken);
    } catch {
      res.status(401).end('Invalid token');
      return;
    }

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
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }

  private broadcast(event: any) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of Array.from(this.clients)) {
      try { c.write(data); } catch { /* closed */ }
    }
  }
}
