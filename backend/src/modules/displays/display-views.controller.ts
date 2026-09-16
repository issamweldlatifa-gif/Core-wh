import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, Max } from 'class-validator';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import {
  DisplaysService,
  displayPushFingerprint,
  DISPLAY_OFFLINE_AFTER_MS,
} from './displays.service';

/**
 * PUBLIC endpoints behind a Station Display URL (§6/§7 + stage 2).
 *
 * Auth = possession of the 256-bit display token in the path. There is NO
 * admin/worker authority here: the GET routes are read-only, and the POST
 * routes are STATION-SCOPED actions that the owner explicitly enabled on that
 * display (`config.interactive === true`, default OFF).
 *
 * Contract (never broken):
 *  - read: snapshot / SSE / health — always available while the display is on;
 *  - act: print|reprint, ack, help, exception, message-seen — ONLY when the
 *    display is enabled AND interactive AND the single action switch is on;
 *  - every action is rate-limited per display and audited with the display's
 *    identity (`displayId` + `stationId`), so a screen is never anonymous;
 *  - the token can be regenerated from the admin Station → Display Mode panel
 *    (or the fleet console), killing read AND write instantly.
 */
// DTOs are declared BEFORE the controller: with `emitDecoratorMetadata` the
// design:paramtypes of a decorated method reference these classes at module
// load time, so declaring them below the controller is a TDZ crash at boot
// (caught by booting the built server, not by tsc).
class AckDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsString() @MaxLength(80) refId?: string;
}

class HelpDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
}

class ExceptionDto {
  @IsOptional() @IsString() @MaxLength(40) type?: string;
  @IsString() @MaxLength(400) reason!: string;
  @IsOptional() @IsString() @MaxLength(60) code?: string;
}

class PrintDto {
  @IsOptional() @IsIn(['SCAN', 'CARTON', 'UNIT', 'STATION_SUMMARY']) target?: 'SCAN' | 'CARTON' | 'UNIT' | 'STATION_SUMMARY';
  @IsOptional() @IsString() @MaxLength(80) refId?: string;
  @IsOptional() @IsString() @MaxLength(60) reprintOf?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) copies?: number;
}

class PrintResultDto {
  @IsIn(['PRINTED', 'FAILED']) status!: 'PRINTED' | 'FAILED';
  @IsOptional() @IsString() @MaxLength(300) error?: string;
}

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

    // Fingerprint WITHOUT lastUpdate: it is regenerated on every build, so
    // including it made every tick look "changed" and re-pushed a full
    // snapshot every 3s per screen even when the station was idle.
    let fingerprint = displayPushFingerprint(initial);
    let closed = false;

    const push = async (force = false) => {
      if (closed) return;
      try {
        const snap = await this.displays.snapshotForToken(token);
        if (!snap || closed) return;
        const fp = displayPushFingerprint(snap);
        if (force || fp !== fingerprint) {
          fingerprint = fp;
          res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
        }
        void this.displays.touch(token);
      } catch {
        /* transient DB hiccup — next tick retries */
      }
    };

    // Instant reconcile on domain events (existing event bus) — COALESCED:
    // one write can emit several topics (and every display listens to all of
    // them), so forced pushes are batched into one re-snapshot per ~600ms
    // instead of one per event per screen.
    let forced: ReturnType<typeof setTimeout> | null = null;
    const schedulePush = () => {
      if (closed || forced) return;
      forced = setTimeout(() => {
        forced = null;
        void push(true);
      }, 600);
    };
    const handlers = DisplayViewsController.INSTANT_TOPICS.map((t) => {
      const h = () => schedulePush();
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
      if (forced) clearTimeout(forced);
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

  // ------------------------------------------------------------------
  // STAGE 2 — station actions from the screen (interactive displays only).
  // ------------------------------------------------------------------

  @Post(':token/actions/ack')
  @ApiOperation({ summary: 'Acknowledge the alert shown on this station screen.' })
  async ack(@Param('token') token: string, @Body() dto: AckDto) {
    return this.displays.acknowledge(token, { note: dto.note, refId: dto.refId });
  }

  @Post(':token/actions/help')
  @ApiOperation({ summary: 'Call a supervisor to this station (push + audit + feed).' })
  async help(@Param('token') token: string, @Body() dto: HelpDto) {
    return this.displays.requestHelp(token, { note: dto.note, urgent: dto.urgent });
  }

  @Post(':token/actions/exception')
  @ApiOperation({ summary: 'Raise a real OperationalException from the station screen.' })
  async exception(@Param('token') token: string, @Body() dto: ExceptionDto) {
    return this.displays.raiseException(token, { type: dto.type, reason: dto.reason, code: dto.code });
  }

  @Post(':token/actions/print')
  @ApiOperation({ summary: 'Queue a label print (or reprint) for this station; returns the rendered payload.' })
  async print(@Param('token') token: string, @Body() dto: PrintDto) {
    return this.displays.printLabel(token, {
      target: dto.target,
      refId: dto.refId,
      reprintOf: dto.reprintOf,
      copies: dto.copies,
    });
  }

  @Post(':token/actions/print/:jobId/result')
  @ApiOperation({ summary: 'Report the physical result of a queued print job (PRINTED / FAILED).' })
  async printResult(@Param('token') token: string, @Param('jobId') jobId: string, @Body() dto: PrintResultDto) {
    return this.displays.printResult(token, jobId, {
      status: dto.status,
      error: dto.error,
    });
  }

  @Get(':token/actions/print-queue')
  @ApiOperation({
    summary: 'Claim QUEUED jobs for a BRIDGE/CT40 transport (local bridge agent or worker handheld).',
  })
  async printQueue(@Param('token') token: string) {
    return this.displays.claimPrintJobs(token, {});
  }

  @Post(':token/messages/:messageId/ack')
  @ApiOperation({ summary: 'Confirm the worker/supervisor has seen an operator message.' })
  async ackMessage(@Param('token') token: string, @Param('messageId') messageId: string, @Body() dto: AckDto) {
    return this.displays.acknowledgeMessage(token, messageId, { note: dto.note });
  }
}
