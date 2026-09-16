import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PushService } from '../notifications/push.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes } from 'crypto';

/**
 * Station Display Mode (owner order 2026-09-16).
 *
 * A StationDisplay is a live view bound to one station. The token in the
 * public URL is the display's ONLY credential (256-bit hex); it grants nothing
 * beyond reading/streaming that station's view and, since STAGE 2, the
 * station actions the owner explicitly enabled on that display. All data comes
 * from the same tables the CT40 transactions write, so the display shows the
 * very same transactions (same ids) — it never creates or mirrors any.
 *
 * STAGE 2 — INTERACTIVE DISPLAYS (owner order 2026-09-16).
 * «the display must help the worker, show and record every action, and let us
 * act from it — print or other actions — for all stations».
 *  - Opt-in: `config.interactive` (default FALSE) + per-action switches.
 *  - Every action is audited (DISPLAY_*) with the display's identity, recorded
 *    in `station_display_actions` and pushed to the live feed.
 *  - Rate-limited per display (a screen is not a bot).
 *  - Revocable instantly: disabling the display or regenerating its token kills
 *    read AND write in one step.
 */

/** Visibility switches (§4 Data Visibility). `reports` stays off in v1. */
export const DISPLAY_CONFIG_FIELDS = [
  'worker',
  'operation',
  'task',
  'lastScan',
  'product',
  'customer',
  'quantity',
  'status',
  'progress',
  'station',
  'recent',
  'reports',
] as const;

export type DisplayConfigField = (typeof DISPLAY_CONFIG_FIELDS)[number];

/** Stage-2 behaviour flags (not data visibility — how the screen behaves). */
export const DISPLAY_FLAG_FIELDS = ['interactive', 'sound'] as const;
export type DisplayFlagField = (typeof DISPLAY_FLAG_FIELDS)[number];

/** Stage-2 actions a display MAY be allowed to trigger. */
export const DISPLAY_ACTION_FIELDS = ['print', 'reprint', 'ack', 'help', 'exception', 'message', 'move'] as const;
export type DisplayActionField = (typeof DISPLAY_ACTION_FIELDS)[number];

/** Where a label physically prints. Pluggable by design (see StationPrintJob). */
export const PRINT_TRANSPORTS = ['BROWSER', 'BRIDGE', 'CT40'] as const;
export type PrintTransport = (typeof PRINT_TRANSPORTS)[number];

export const DEFAULT_DISPLAY_CONFIG: Record<DisplayConfigField, boolean> = {
  worker: true,
  operation: true,
  task: true,
  lastScan: true,
  product: true,
  customer: true,
  quantity: true,
  status: true,
  progress: true,
  station: true,
  // Recent-actions feed (owner request 2026-09-16: the display shows ALL the
  // actions, not only the last scan).
  recent: true,
  reports: false,
};

/** Stage-2 defaults: the screen stays passive until an admin turns it on. */
export const DEFAULT_DISPLAY_FLAGS: Record<DisplayFlagField, boolean> = {
  interactive: false,
  sound: true,
};

/**
 * Default action set of a newly interactive display — OWNER DECISION
 * (2026-09-16): the first batch is PRINTING. A display switched interactive
 * therefore offers PRINT + REPRINT out of the box; the assist actions
 * (ACK / HELP / REPORT PROBLEM) stay switched OFF until an admin ticks them on
 * that display, and station moves stay off entirely (next stage).
 *
 * `message` is the one exception and stays ON: it is NOT a station action — the
 * message itself is written by an ADMIN, and this switch only lets the screen
 * confirm the human read it (MESSAGE_SEEN). With it off, a supervisor message
 * could never be marked as seen.
 */
export const DEFAULT_DISPLAY_ACTIONS: Record<DisplayActionField, boolean> = {
  print: true,
  reprint: true,
  // Assist actions — available, but not part of the first batch (owner order).
  ack: false,
  help: false,
  exception: false,
  message: true,
  // Station moves (TS put / station IN-OUT) are reserved for the next stage:
  // default OFF so nothing starts writing stock from a screen by accident.
  move: false,
};

export const DEFAULT_PRINT_TRANSPORT: PrintTransport = 'BROWSER';

/** A display that has not hit the API for this long shows as Offline. */
export const DISPLAY_OFFLINE_AFTER_MS = 90_000;

/** Defensive bound on display-triggered actions (per display, sliding window). */
export const DISPLAY_ACTION_RATE = { windowMs: 60_000, max: 30 } as const;

export interface DisplayConfig extends Record<DisplayConfigField, boolean> {
  interactive: boolean;
  sound: boolean;
  actions: Record<DisplayActionField, boolean>;
  printTransport: PrintTransport;
}

export function generateDisplayToken(): string {
  return randomBytes(32).toString('hex');
}

/** Keep only known keys, coerce to boolean, fill defaults. Unknown keys are dropped. */
export function normalizeDisplayConfig(input: unknown): DisplayConfig {
  const raw = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_DISPLAY_CONFIG, ...DEFAULT_DISPLAY_FLAGS } as DisplayConfig;
  for (const key of DISPLAY_CONFIG_FIELDS) {
    if (key in raw) out[key] = raw[key] === true;
  }
  for (const key of DISPLAY_FLAG_FIELDS) {
    if (key in raw) out[key] = raw[key] === true;
  }
  // Nested action switches: only known keys, only when explicitly true.
  const rawActions = (raw.actions && typeof raw.actions === 'object' && !Array.isArray(raw.actions)
    ? raw.actions
    : {}) as Record<string, unknown>;
  out.actions = { ...DEFAULT_DISPLAY_ACTIONS };
  for (const key of DISPLAY_ACTION_FIELDS) {
    if (key in rawActions) out.actions[key] = rawActions[key] === true;
  }
  const transport = String(raw.printTransport ?? '').toUpperCase() as PrintTransport;
  out.printTransport = (PRINT_TRANSPORTS as readonly string[]).includes(transport) ? transport : DEFAULT_PRINT_TRANSPORT;
  // An interactive display with every action switched off would only render
  // dead buttons — treat it as non-interactive so the UI never lies.
  if (!Object.values(out.actions).some(Boolean)) out.interactive = false;
  return out;
}

/** The actions this display is allowed to trigger (server-side truth). */
export function displayActionAvailability(config: unknown): DisplayActionField[] {
  const cfg = normalizeDisplayConfig(config);
  if (!cfg.interactive) return [];
  return DISPLAY_ACTION_FIELDS.filter((k) => cfg.actions[k]);
}

/** True when the raw snapshot section changed — used to skip no-op SSE pushes. */
export function snapshotFingerprint(raw: unknown): string {
  return createHash('sha1').update(JSON.stringify(raw ?? null)).digest('hex');
}

/**
 * Fingerprint of a snapshot for change detection. `lastUpdate` is regenerated
 * on every build, so including it made every SSE tick look "changed" and the
 * server re-sent a full snapshot every 3s per screen even when idle. It is
 * excluded here; everything the operator can SEE still counts.
 */
export function displayPushFingerprint(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return snapshotFingerprint(snapshot);
  const { lastUpdate: _ignored, ...rest } = snapshot as Record<string, unknown>;
  return snapshotFingerprint(rest);
}

/** Feed label for a display-triggered action (rendered by the screen + admin). */
export const DISPLAY_ACTION_LABELS: Record<string, string> = {
  ACK: 'ACK',
  HELP: 'HELP',
  EXCEPTION: 'EXCEPTION',
  PRINT: 'PRINT',
  REPRINT: 'REPRINT',
  MESSAGE: 'MESSAGE',
  MESSAGE_SEEN: 'MESSAGE SEEN',
};

export interface DisplayActor {
  displayId: string;
  displayName: string;
  stationId: string;
  stationCode: string;
  ip?: string | null;
}

@Injectable()
export class DisplaysService {
  private readonly logger = new Logger(DisplaysService.name);

  /** Sliding-window action counter per display token (anti-abuse, in-process). */
  private readonly actionWindow = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly push?: PushService,
  ) {}

  // ------------------------------------------------------------------
  // Admin CRUD (audit-logged). Token values are returned only here.
  // ------------------------------------------------------------------

  async create(stationId: string, input: { name?: string; config?: unknown }, actorUserId: string | null) {
    const station = await this.prisma.station.findUnique({ where: { id: stationId } });
    if (!station) return null;
    const displayName = input.name?.trim() || `${station.name} Display`;
    const row = await this.prisma.stationDisplay.create({
      data: {
        stationId,
        name: displayName,
        accessToken: generateDisplayToken(),
        config: normalizeDisplayConfig(input.config) as unknown as object,
      },
    });
    await this.audit.log({
      actorUserId,
      action: 'DISPLAY_CREATED',
      entityType: 'station_display',
      entityId: row.id,
      metadata: { stationId, name: displayName, displayType: row.displayType },
    });
    return row;
  }

  listForStation(stationId: string) {
    return this.prisma.stationDisplay.findMany({
      where: { stationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async update(
    id: string,
    input: { name?: string; enabled?: boolean; config?: unknown; stationId?: string },
    actorUserId: string | null,
  ) {
    const before = await this.prisma.stationDisplay.findUnique({ where: { id } });
    if (!before) return null;

    const data: { name?: string; enabled?: boolean; config?: object; stationId?: string } = {};
    if (typeof input.name === 'string' && input.name.trim()) data.name = input.name.trim();
    if (typeof input.enabled === 'boolean') data.enabled = input.enabled;
    if (input.config !== undefined) data.config = normalizeDisplayConfig(input.config) as unknown as object;
    if (typeof input.stationId === 'string' && input.stationId !== before.stationId) {
      const target = await this.prisma.station.findUnique({ where: { id: input.stationId } });
      if (!target) return { error: 'STATION_NOT_FOUND' as const };
      data.stationId = input.stationId;
    }

    const row = await this.prisma.stationDisplay.update({ where: { id }, data });
    // Card action switches emitted by the admin UI carry the interactive flag —
    // any change of what a screen may DO is audited on its own event.
    const flagsBefore = normalizeDisplayConfig(before.config);
    const flagsAfter = normalizeDisplayConfig(row.config);
    if (flagsBefore.interactive !== flagsAfter.interactive) {
      await this.audit.log({
        actorUserId,
        action: 'DISPLAY_UPDATED',
        entityType: 'station_display',
        entityId: id,
        metadata: {
          stationId: row.stationId,
          name: row.name,
          interactive: flagsAfter.interactive,
          previousInteractive: flagsBefore.interactive,
          actions: flagsAfter.actions,
        },
      });
    }

    if (data.stationId) {
      await this.audit.log({
        actorUserId,
        action: 'DISPLAY_STATION_CHANGED',
        entityType: 'station_display',
        entityId: id,
        metadata: { from: before.stationId, to: data.stationId, name: row.name },
      });
    }
    if (typeof input.enabled === 'boolean' && input.enabled !== before.enabled) {
      await this.audit.log({
        actorUserId,
        action: input.enabled ? 'DISPLAY_ENABLED' : 'DISPLAY_DISABLED',
        entityType: 'station_display',
        entityId: id,
        metadata: { stationId: row.stationId, name: row.name, previousValue: before.enabled, newValue: input.enabled },
      });
    }
    if (data.name || data.config) {
      await this.audit.log({
        actorUserId,
        action: 'DISPLAY_UPDATED',
        entityType: 'station_display',
        entityId: id,
        metadata: {
          stationId: row.stationId,
          name: row.name,
          ...(data.name ? { previousName: before.name } : {}),
          ...(data.config ? { config: flagsAfter } : {}),
        },
      });
    }
    return { row };
  }

  async regenerate(id: string, actorUserId: string | null) {
    const before = await this.prisma.stationDisplay.findUnique({ where: { id } });
    if (!before) return null;
    const accessToken = generateDisplayToken();
    const row = await this.prisma.stationDisplay.update({ where: { id }, data: { accessToken } });
    await this.audit.log({
      actorUserId,
      action: 'DISPLAY_ACCESS_REGENERATED',
      entityType: 'station_display',
      entityId: id,
      metadata: { stationId: row.stationId, name: row.name },
    });
    return row;
  }

  async remove(id: string, actorUserId: string | null) {
    const before = await this.prisma.stationDisplay.findUnique({ where: { id } });
    if (!before) return null;
    await this.prisma.stationDisplay.delete({ where: { id } });
    await this.audit.log({
      actorUserId,
      action: 'DISPLAY_DELETED',
      entityType: 'station_display',
      entityId: before.id,
      metadata: { stationId: before.stationId, name: before.name },
    });
    return before;
  }

  // ------------------------------------------------------------------
  // FLEET — «all stations» (owner order 2026-09-16, stage 2)
  // ------------------------------------------------------------------

  /**
   * Every station with its display state, PLUS the stations that have no
   * display yet (so the admin sees what is missing, not only what exists).
   * Tokens are NEVER returned here — an admin who needs the URL regenerates it
   * (the URL is the credential; the fleet view must not leak it).
   */
  async fleet() {
    const stations = await this.prisma.station.findMany({
      orderBy: [{ code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        department: true,
        status: true,
        zone: { select: { code: true } },
        assignedWorker: { select: { name: true, employeeCode: true } },
        displays: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true, name: true, enabled: true, displayType: true, lastSeenAt: true,
            createdAt: true, config: true,
          },
        },
      },
    });
    const now = Date.now();
    const rows = stations.map((s) => ({
      stationId: s.id,
      stationCode: s.code,
      stationName: s.name,
      department: s.department,
      status: s.status,
      zone: s.zone?.code ?? null,
      worker: s.assignedWorker ? { name: s.assignedWorker.name, code: s.assignedWorker.employeeCode } : null,
      displays: s.displays.map((d) => {
        const cfg = normalizeDisplayConfig(d.config);
        return {
          id: d.id,
          name: d.name,
          enabled: d.enabled,
          displayType: d.displayType,
          lastSeenAt: d.lastSeenAt,
          online: d.lastSeenAt ? now - +new Date(d.lastSeenAt) < DISPLAY_OFFLINE_AFTER_MS : false,
          interactive: cfg.interactive,
          actions: cfg.actions,
          printTransport: cfg.printTransport,
          visibility: Object.fromEntries(DISPLAY_CONFIG_FIELDS.map((k) => [k, cfg[k]])),
        };
      }),
    }));
    return {
      stations: rows,
      counters: {
        stations: rows.length,
        stationsWithDisplay: rows.filter((r) => r.displays.length > 0).length,
        stationsWithoutDisplay: rows.filter((r) => r.displays.length === 0).length,
        displays: rows.reduce((n, r) => n + r.displays.length, 0),
        online: rows.reduce((n, r) => n + r.displays.filter((d) => d.enabled && d.online).length, 0),
        offline: rows.reduce((n, r) => n + r.displays.filter((d) => d.enabled && !d.online).length, 0),
        disabled: rows.reduce((n, r) => n + r.displays.filter((d) => !d.enabled).length, 0),
        interactive: rows.reduce((n, r) => n + r.displays.filter((d) => d.interactive).length, 0),
      },
    };
  }

  /**
   * Bulk operations over the whole fleet (owner: «include all stations»).
   * Every bulk run is audited ONCE with the affected ids, and returns the URLs
   * of the displays it created (their tokens are shown exactly once).
   */
  async bulk(
    input: {
      action: 'CREATE_MISSING' | 'APPLY_CONFIG' | 'SET_ENABLED' | 'SET_INTERACTIVE';
      stationIds?: string[];
      config?: unknown;
      enabled?: boolean;
      interactive?: boolean;
    },
    actorUserId: string | null,
  ) {
    const stationFilter = input.stationIds?.length ? { id: { in: input.stationIds } } : {};

    if (input.action === 'CREATE_MISSING') {
      const stations = await this.prisma.station.findMany({
        where: { ...stationFilter, status: 'ACTIVE', displays: { none: {} } },
        orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true },
      });
      if (stations.length === 0) return { action: input.action, created: [] as Array<Record<string, unknown>>, applied: 0 };
      const created: Array<Record<string, unknown>> = [];
      for (const station of stations) {
        const row = await this.prisma.stationDisplay.create({
          data: {
            stationId: station.id,
            name: `${station.name} Display`,
            accessToken: generateDisplayToken(),
            config: normalizeDisplayConfig(input.config ?? undefined) as unknown as object,
          },
        });
        created.push({
          displayId: row.id,
          stationId: station.id,
          stationCode: station.code,
          name: row.name,
          urlPath: `/display/${row.accessToken}`,
        });
      }
      await this.audit.log({
        actorUserId,
        action: 'DISPLAY_BULK_CREATED',
        entityType: 'station_display',
        metadata: {
          count: created.length,
          stations: created.map((c) => c.stationCode),
          displayIds: created.map((c) => c.displayId),
        },
      });
      return { action: input.action, created, applied: created.length };
    }

    if (input.action === 'APPLY_CONFIG') {
      const rows = await this.prisma.stationDisplay.findMany({ where: { station: stationFilter }, select: { id: true, config: true } });
      const config = normalizeDisplayConfig(input.config ?? undefined) as unknown as object;
      await this.prisma.stationDisplay.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { config } });
      await this.audit.log({
        actorUserId,
        action: 'DISPLAY_BULK_CONFIGURED',
        entityType: 'station_display',
        metadata: { count: rows.length, displayIds: rows.map((r) => r.id), config: config as Record<string, unknown> },
      });
      return { action: input.action, applied: rows.length, created: [] };
    }

    if (input.action === 'SET_ENABLED' || input.action === 'SET_INTERACTIVE') {
      const enabled = input.action === 'SET_ENABLED' ? input.enabled === true : undefined;
      const rows = await this.prisma.stationDisplay.findMany({ where: { station: stationFilter }, select: { id: true, config: true } });
      if (input.action === 'SET_ENABLED') {
        await this.prisma.stationDisplay.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { enabled } });
      } else {
        // Per-row config merge (interactive lives inside the config JSON).
        for (const row of rows) {
          const cfg = normalizeDisplayConfig(row.config);
          cfg.interactive = input.interactive === true;
          await this.prisma.stationDisplay.update({
            where: { id: row.id },
            data: { config: cfg as unknown as object },
          });
        }
      }
      await this.audit.log({
        actorUserId,
        action: 'DISPLAY_BULK_ENABLED_CHANGED',
        entityType: 'station_display',
        metadata: {
          count: rows.length,
          displayIds: rows.map((r) => r.id),
          ...(input.action === 'SET_ENABLED' ? { enabled } : { interactive: input.interactive === true }),
        },
      });
      return { action: input.action, applied: rows.length, created: [] };
    }

    return { action: input.action, applied: 0, created: [] };
  }

  /** Admin → station message (shown full-width on the screen until seen). */
  async sendMessage(
    displayId: string,
    input: { body: string; severity?: string; requireAck?: boolean; expiresInMinutes?: number },
    actorUserId: string | null,
  ) {
    const display = await this.prisma.stationDisplay.findUnique({ where: { id: displayId }, include: { station: true } });
    if (!display) return null;
    const body = (input.body ?? '').trim();
    if (!body) return { error: 'EMPTY_MESSAGE' as const };
    const severity = ['INFO', 'WARNING', 'URGENT'].includes(String(input.severity ?? '').toUpperCase())
      ? String(input.severity).toUpperCase()
      : 'INFO';
    const expiresAt = input.expiresInMinutes && input.expiresInMinutes > 0
      ? new Date(Date.now() + input.expiresInMinutes * 60_000)
      : null;
    const row = await this.prisma.stationDisplayMessage.create({
      data: {
        displayId,
        stationId: display.stationId,
        body,
        severity,
        requireAck: input.requireAck !== false,
        createdBy: actorUserId,
        expiresAt,
      },
    });
    await this.recordAction(display, {
      kind: 'MESSAGE',
      summary: `${severity} message from admin: ${body.slice(0, 120)}`,
      refId: row.id,
      metadata: { severity, requireAck: row.requireAck, by: actorUserId },
    });
    await this.audit.log({
      actorUserId,
      action: 'DISPLAY_MESSAGE_SENT',
      entityType: 'station_display',
      entityId: displayId,
      metadata: { stationId: display.stationId, station: display.station.code, messageId: row.id, severity, body: body.slice(0, 200) },
    });
    this.publishActivity(display.stationId, 'MESSAGE');
    return { message: row };
  }

  // ------------------------------------------------------------------
  // Public display view (token = the only credential).
  // ------------------------------------------------------------------

  /** null → unknown token; { enabled: false } → disabled by admin (no data leaves). */
  async snapshotForToken(token: string) {
    const display = await this.prisma.stationDisplay.findUnique({
      where: { accessToken: token },
      include: { station: true },
    });
    if (!display) return null;
    if (!display.enabled) return { enabled: false as const, display: { name: display.name } };

    const cfg = normalizeDisplayConfig(display.config);
    const raw = await this.buildStationSnapshot(display.stationId);
    const [messages] = await Promise.all([this.activeMessages(display.id)]);
    return {
      enabled: true as const,
      display: { name: display.name, type: display.displayType },
      stationName: display.station.name,
      ...filterSnapshotByConfig(raw, cfg),
      // Stage 2: what this screen may DO (server-side truth) + operator notes.
      options: {
        interactive: cfg.interactive,
        sound: cfg.sound,
        printTransport: cfg.printTransport,
        actions: displayActionAvailability(cfg),
      },
      messages,
      lastUpdate: new Date().toISOString(),
    };
  }

  async touch(token: string) {
    try {
      await this.prisma.stationDisplay.updateMany({ where: { accessToken: token }, data: { lastSeenAt: new Date() } });
    } catch (e) {
      this.logger.warn(`display touch failed: ${e}`);
    }
  }

  /** Minimal metadata for liveness checks — no snapshot payload. */
  async listTokenMeta(token: string) {
    return this.prisma.stationDisplay.findUnique({
      where: { accessToken: token },
      select: { id: true, enabled: true, lastSeenAt: true },
    });
  }

  /** Unacknowledged, unexpired messages for a display (newest first). */
  private async activeMessages(displayId: string) {
    const rows = await this.prisma.stationDisplayMessage.findMany({
      where: {
        displayId,
        acknowledgedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    return rows.map((m) => ({
      id: m.id,
      body: m.body,
      severity: m.severity,
      requireAck: m.requireAck,
      at: m.createdAt,
    }));
  }

  // ------------------------------------------------------------------
  // STAGE 2 — actions triggered FROM a display.
  // ------------------------------------------------------------------

  /**
   * Resolve the display behind a token and enforce the stage-2 contract:
   * known token, enabled, interactive, action allowed, rate under control.
   * Everything else refuses BEFORE any write.
   */
  private async actorForAction(token: string, action: DisplayActionField) {
    const display = await this.prisma.stationDisplay.findUnique({
      where: { accessToken: token },
      include: { station: { select: { id: true, code: true, name: true } } },
    });
    if (!display) throw new HttpException('DISPLAY_NOT_FOUND', HttpStatus.NOT_FOUND);
    if (!display.enabled) throw new HttpException('DISPLAY_DISABLED', HttpStatus.FORBIDDEN);
    const cfg = normalizeDisplayConfig(display.config);
    if (!cfg.interactive) throw new HttpException('DISPLAY_READ_ONLY', HttpStatus.FORBIDDEN);
    if (!cfg.actions[action]) throw new HttpException(`DISPLAY_ACTION_NOT_ALLOWED:${action}`, HttpStatus.FORBIDDEN);
    this.assertRate(token);
    return {
      display,
      config: cfg,
      actor: {
        displayId: display.id,
        displayName: display.name,
        stationId: display.stationId,
        stationCode: display.station.code,
      } as DisplayActor,
    };
  }

  private assertRate(token: string) {
    const now = Date.now();
    const hits = (this.actionWindow.get(token) ?? []).filter((t) => now - t < DISPLAY_ACTION_RATE.windowMs);
    if (hits.length >= DISPLAY_ACTION_RATE.max) {
      throw new HttpException('DISPLAY_ACTION_RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
    }
    hits.push(now);
    this.actionWindow.set(token, hits);
  }

  /** One row in the display's own action log + a live push to every screen. */
  private async recordAction(
    display: { id: string; stationId: string },
    input: { kind: string; summary?: string; refId?: string | null; metadata?: Record<string, unknown> },
  ) {
    const row = await this.prisma.stationDisplayAction.create({
      data: {
        displayId: display.id,
        stationId: display.stationId,
        kind: input.kind,
        summary: input.summary ?? null,
        refId: input.refId ?? null,
        metadata: (input.metadata ?? null) as object | undefined,
      },
    });
    return row;
  }

  private publishActivity(stationId: string, kind: string) {
    try {
      this.events.emit('station.activity', { stationId, kind, t: Date.now() });
    } catch (e) {
      this.logger.warn(`station.activity emit failed: ${e}`);
    }
  }

  /** ACK — «a human at this station saw the alert». */
  async acknowledge(token: string, input: { note?: string; refId?: string }) {
    const { display, actor } = await this.actorForAction(token, 'ack');
    const note = (input.note ?? '').trim().slice(0, 300);
    const row = await this.recordAction(display, {
      kind: 'ACK',
      summary: note ? `Alert acknowledged: ${note}` : 'Alert acknowledged at the station',
      refId: input.refId ?? null,
      metadata: { note: note || null },
    });
    // A station acknowledgment also clears the pending operator messages when
    // the screen is the one asking for confirmation (same human, same moment).
    await this.audit.log({
      actorUserId: null,
      action: 'DISPLAY_ACTION_ACK',
      entityType: 'station_display',
      entityId: display.id,
      metadata: { stationId: actor.stationId, station: actor.stationCode, display: display.name, note: note || null, actionId: row.id },
    });
    this.publishActivity(actor.stationId, 'ACK');
    return { ok: true as const, at: row.createdAt, actionId: row.id };
  }

  /** HELP — call a supervisor to this station (push + audit + feed). */
  async requestHelp(token: string, input: { note?: string; urgent?: boolean }) {
    const { display, actor } = await this.actorForAction(token, 'help');
    const note = (input.note ?? '').trim().slice(0, 300);
    const urgent = input.urgent === true;
    const row = await this.recordAction(display, {
      kind: 'HELP',
      summary: `${urgent ? 'URGENT ' : ''}Supervisor requested at ${actor.stationCode}${note ? `: ${note}` : ''}`,
      metadata: { note: note || null, urgent },
    });
    await this.audit.log({
      actorUserId: null,
      action: 'DISPLAY_HELP_REQUESTED',
      entityType: 'station_display',
      entityId: display.id,
      metadata: { stationId: actor.stationId, station: actor.stationCode, display: display.name, note: note || null, urgent, actionId: row.id },
    });
    let notified = 0;
    try {
      notified = await this.notifyAdmins({
        title: `${urgent ? '🆘 URGENT' : '🙋 Assistance'} — ${actor.stationCode}`,
        body: note ? `${display.name}: ${note}` : `${display.name} is asking for a supervisor.`,
        route: '/admin/displays',
        event: 'DISPLAY_HELP_REQUESTED',
      });
    } catch (e) {
      this.logger.warn(`help push failed: ${e}`);
    }
    this.publishActivity(actor.stationId, 'HELP');
    return { ok: true as const, actionId: row.id, notified, at: row.createdAt };
  }

  /** EXCEPTION — a real OperationalException, same board as every other one. */
  async raiseException(token: string, input: { type?: string; reason?: string; code?: string }) {
    const { display, actor } = await this.actorForAction(token, 'exception');
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new HttpException('REASON_REQUIRED', HttpStatus.BAD_REQUEST);
    const type = (input.type ?? 'STATION_REPORT').trim().toUpperCase().slice(0, 40) || 'STATION_REPORT';
    const code = (input.code ?? '').trim().slice(0, 60) || null;
    const created = await this.prisma.$transaction(async (tx) => {
      const excCode = await this.genExceptionCode(tx);
      const exc = await tx.operationalException.create({
        data: {
          code: excCode,
          type,
          status: 'OPEN',
          entityType: 'station',
          entityId: actor.stationId,
          entityCode: code ?? actor.stationCode,
          reason: `DISPLAY ${display.name}: ${reason}`.slice(0, 500),
          reportedById: null,
          stationId: actor.stationId,
        },
      });
      const action = await tx.stationDisplayAction.create({
        data: {
          displayId: display.id,
          stationId: actor.stationId,
          kind: 'EXCEPTION',
          summary: `${type} — ${reason.slice(0, 140)}`,
          refId: exc.id,
          metadata: { exceptionCode: exc.code, type, ref: code } as object,
        },
      });
      return { exc, action };
    });
    await this.audit.log({
      actorUserId: null,
      action: 'DISPLAY_EXCEPTION_RAISED',
      entityType: 'operational_exception',
      entityId: created.exc.id,
      metadata: {
        exception: created.exc.code, type, stationId: actor.stationId, station: actor.stationCode,
        displayId: display.id, display: display.name, ref: code, reason: reason.slice(0, 200),
      },
    });
    try {
      await this.notifyAdmins({
        title: `⚠️ Exception ${created.exc.code} — ${actor.stationCode}`,
        body: `${type}: ${reason.slice(0, 140)}`,
        route: '/admin/exceptions',
        event: 'DISPLAY_EXCEPTION_RAISED',
      });
    } catch (e) {
      this.logger.warn(`exception push failed: ${e}`);
    }
    this.publishActivity(actor.stationId, 'EXCEPTION');
    return { ok: true as const, exceptionCode: created.exc.code, exceptionId: created.exc.id, at: created.action.createdAt };
  }

  /**
   * PRINT / REPRINT — the screen asks for a label. The job is a REAL row
   * (station_print_jobs) with the rendered payload; the transport decides who
   * prints it: the browser on the display PC (default), a local bridge, or the
   * worker's CT40 over Bluetooth. Nothing is printed silently.
   */
  async printLabel(
    token: string,
    input: { target?: 'SCAN' | 'CARTON' | 'UNIT' | 'STATION_SUMMARY'; refId?: string; reprintOf?: string; copies?: number },
  ) {
    const action: DisplayActionField = input.reprintOf ? 'reprint' : 'print';
    const { display, config, actor } = await this.actorForAction(token, action);
    const copies = Math.min(Math.max(Number(input.copies ?? 1) || 1, 1), 5);

    let payload: Record<string, unknown> | null = null;
    let target = (input.target ?? 'SCAN') as string;
    let targetRef: string | null = null;

    if (input.reprintOf) {
      const original = await this.prisma.stationPrintJob.findUnique({ where: { id: input.reprintOf } });
      if (!original || original.stationId !== actor.stationId) {
        throw new HttpException('PRINT_JOB_NOT_FOUND', HttpStatus.NOT_FOUND);
      }
      payload = original.payload as Record<string, unknown>;
      target = original.target;
      targetRef = original.targetRef;
    } else {
      const snapshot = await this.buildStationSnapshot(actor.stationId);
      if (target === 'STATION_SUMMARY') {
        payload = {
          title: 'STATION SUMMARY',
          station: snapshot.station,
          worker: snapshot.worker,
          operation: snapshot.operation,
          scanCount: snapshot.scanCount,
          progress: snapshot.progress,
          printedAt: new Date().toISOString(),
        } as Record<string, unknown>;
        targetRef = snapshot.station?.code ?? null;
      } else {
        const scan = snapshot.lastScan;
        if (!scan) throw new HttpException('NOTHING_TO_PRINT', HttpStatus.BAD_REQUEST);
        // The card the operator sees is the card that prints: same ids, same
        // codes as the CT40 wrote.
        target = input.target === 'CARTON' || scan.kind === 'CARTON' ? 'CARTON' : input.target === 'UNIT' || String(scan.kind).startsWith('BATCH') ? 'UNIT' : 'SCAN';
        targetRef = scan.code ?? null;
        payload = {
          title: target === 'CARTON' ? 'CARTON LABEL' : target === 'UNIT' ? 'UNIT LABEL' : 'SCAN LABEL',
          code: scan.code ?? null,
          kind: scan.kind,
          quantity: scan.quantity ?? 1,
          status: scan.status ?? null,
          customer: snapshot.customer ?? null,
          station: snapshot.station,
          worker: snapshot.worker,
          reference: scan.id,
          reprint: Boolean(input.reprintOf),
          printedAt: new Date().toISOString(),
        } as Record<string, unknown>;
      }
    }

    const job = await this.prisma.stationPrintJob.create({
      data: {
        displayId: display.id,
        stationId: actor.stationId,
        target,
        targetRef,
        payload: payload as object,
        transport: config.printTransport,
        status: 'QUEUED',
        copies,
        reprintOf: input.reprintOf ?? null,
      },
    });
    await this.recordAction(display, {
      kind: input.reprintOf ? 'REPRINT' : 'PRINT',
      summary: `${input.reprintOf ? 'Reprint' : 'Print'} ${target} ${targetRef ?? ''} (${config.printTransport})`.trim(),
      refId: job.id,
      metadata: { target, targetRef, copies, transport: config.printTransport, jobId: job.id },
    });
    await this.audit.log({
      actorUserId: null,
      action: 'DISPLAY_PRINT_REQUESTED',
      entityType: 'station_print_job',
      entityId: job.id,
      metadata: {
        stationId: actor.stationId, station: actor.stationCode, displayId: display.id, display: display.name,
        target, targetRef, copies, transport: config.printTransport, reprintOf: input.reprintOf ?? null,
      },
    });
    this.publishActivity(actor.stationId, 'PRINT');
    return { ok: true as const, job: { id: job.id, target, targetRef, copies, transport: job.transport, status: job.status, payload: job.payload } };
  }

  /** The client reports what physically happened to a job (printed / failed). */
  async printResult(token: string, jobId: string, input: { status: 'PRINTED' | 'FAILED'; error?: string }) {
    const { display, actor } = await this.actorForAction(token, 'print');
    const job = await this.prisma.stationPrintJob.findUnique({ where: { id: jobId } });
    if (!job || job.stationId !== actor.stationId) throw new HttpException('PRINT_JOB_NOT_FOUND', HttpStatus.NOT_FOUND);
    const printed = input.status === 'PRINTED';
    const row = await this.prisma.stationPrintJob.update({
      where: { id: jobId },
      data: {
        status: printed ? 'PRINTED' : 'FAILED',
        resultAt: new Date(),
        claimedBy: job.claimedBy ?? `${display.name} (${job.transport})`,
        error: printed ? null : (input.error ?? 'PRINT_ERROR').slice(0, 300),
      },
    });
    await this.audit.log({
      actorUserId: null,
      action: printed ? 'DISPLAY_PRINT_COMPLETED' : 'DISPLAY_PRINT_FAILED',
      entityType: 'station_print_job',
      entityId: jobId,
      metadata: {
        stationId: actor.stationId, station: actor.stationCode, displayId: display.id, display: display.name,
        target: job.target, targetRef: job.targetRef, transport: job.transport, error: row.error,
      },
    });
    this.publishActivity(actor.stationId, printed ? 'PRINTED' : 'PRINT_FAILED');
    return { ok: true as const, job: { id: row.id, status: row.status, error: row.error } };
  }

  /**
   * A bridge (local agent on the display PC, or the CT40 in the worker's hand)
   * claims the QUEUED jobs of its station and prints them. Same token, same
   * audit trail — the transport is a deployment choice, never a second truth.
   */
  async claimPrintJobs(token: string, input: { limit?: number; claimedBy?: string }) {
    const { display, actor } = await this.actorForAction(token, 'print');
    const limit = Math.min(Math.max(Number(input.limit ?? 5) || 5, 1), 20);
    const jobs = await this.prisma.stationPrintJob.findMany({
      where: { stationId: actor.stationId, status: 'QUEUED', transport: { in: ['BRIDGE', 'CT40'] } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    const claimed: Array<{ id: string; target: string; targetRef: string | null; copies: number; payload: unknown }> = [];
    for (const job of jobs) {
      const row = await this.prisma.stationPrintJob.update({
        where: { id: job.id },
        data: {
          status: 'CLAIMED',
          claimedBy: (input.claimedBy ?? `${display.name} bridge`).slice(0, 60),
          claimedAt: new Date(),
        },
      });
      claimed.push({ id: row.id, target: row.target, targetRef: row.targetRef, copies: row.copies, payload: row.payload });
    }
    return { ok: true as const, jobs: claimed, count: claimed.length };
  }

  /** The worker (or the supervisor) confirms they saw an operator message. */
  async acknowledgeMessage(token: string, messageId: string, input: { note?: string }) {
    const { display, actor } = await this.actorForAction(token, 'message');
    const message = await this.prisma.stationDisplayMessage.findUnique({ where: { id: messageId } });
    if (!message || message.displayId !== display.id) throw new HttpException('MESSAGE_NOT_FOUND', HttpStatus.NOT_FOUND);
    const note = (input.note ?? '').trim().slice(0, 200);
    const row = message.acknowledgedAt
      ? message
      : await this.prisma.stationDisplayMessage.update({
          where: { id: messageId },
          data: { acknowledgedAt: new Date(), acknowledgedNote: note || null },
        });
    await this.recordAction(display, {
      kind: 'MESSAGE_SEEN',
      summary: `Message seen${note ? `: ${note}` : ''}`,
      refId: messageId,
      metadata: { severity: message.severity, note: note || null },
    });
    await this.audit.log({
      actorUserId: null,
      action: 'DISPLAY_MESSAGE_ACK',
      entityType: 'station_display_message',
      entityId: messageId,
      metadata: { stationId: actor.stationId, station: actor.stationCode, displayId: display.id, display: display.name, note: note || null },
    });
    this.publishActivity(actor.stationId, 'MESSAGE_SEEN');
    return { ok: true as const, acknowledgedAt: row.acknowledgedAt };
  }

  /** The display's own recent action log (admin panel + screen). */
  async recentActionsForStation(stationId: string, take = 20) {
    return this.prisma.stationDisplayAction.findMany({
      where: { stationId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 100),
      include: { display: { select: { id: true, name: true } } },
    });
  }

  private async genExceptionCode(tx: { operationalException: { count: () => Promise<number>; findUnique: (a: { where: { code: string } }) => Promise<unknown> } }) {
    for (let i = 0; i < 5; i += 1) {
      const count = await tx.operationalException.count();
      const code = `EXC-${String(count + 1 + i).padStart(6, '0')}`;
      if (!(await tx.operationalException.findUnique({ where: { code } }))) return code;
    }
    return `EXC-R${Date.now().toString().slice(-6)}`;
  }

  private async notifyAdmins(payload: { title: string; body: string; route: string; event: string }) {
    if (!this.push) return 0;
    const admins = await this.prisma.user.findMany({
      where: { roles: { some: { role: { name: { in: ['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_MANAGER'] } } } } },
      select: { id: true },
    });
    if (admins.length === 0) return 0;
    return this.push.notifyUsers(admins.map((a) => a.id), {
      title: payload.title,
      body: payload.body,
      route: payload.route,
      data: { event: payload.event },
    });
  }

  // ------------------------------------------------------------------
  // Snapshot builder (read-only, same tables the CT40 writes).
  // ------------------------------------------------------------------

  /**
   * Build the raw station view from the SAME tables the worker transactions
   * write (receiving sessions/scan events/discrepancies, temporary-storage
   * items, task assignments, station assignment, batch unit/receive, station
   * moves) plus the display's own action log. Never mutates anything.
   */
  async buildStationSnapshot(stationId: string) {
    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      include: { assignedWorker: { select: { id: true, name: true, employeeCode: true } } },
    });
    if (!station) return { station: null };

    const sessionInclude = {
      _count: { select: { scanEvents: true } },
    } as const;

    const [activeSession, lastTsItem, openTask] = await Promise.all([
      this.prisma.receivingSession.findFirst({
        where: { stationId, status: { in: ['RECEIVING', 'PAUSED'] } },
        orderBy: { startedAt: 'desc' },
        include: sessionInclude,
      }),
      this.prisma.temporaryStorageItem.findFirst({
        where: { stationId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.workerTaskAssignment.findFirst({
        where: { stationId, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Fallback context when nothing is active right now: the most recent
    // session of the day keeps the "last scan" alive instead of blanking.
    const contextSession =
      activeSession ??
      (await this.prisma.receivingSession.findFirst({
        where: { stationId, startedAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
        orderBy: { startedAt: 'desc' },
        include: sessionInclude,
      }));

    // arrivalId is a convention reference (no Prisma relation) — load it apart.
    const arrival = contextSession
      ? await this.prisma.expectedArrival.findUnique({
          where: { id: contextSession.arrivalId },
          select: { code: true, customerName: true, customerSurname: true, storeName: true, arrivalReference: true },
        })
      : null;

    const [lastScanEvent, lastCartonEvent, openDiscrepancy, products] = await Promise.all([
      contextSession
        ? this.prisma.receivingScanEvent.findFirst({ where: { sessionId: contextSession.id }, orderBy: { createdAt: 'desc' } })
        : Promise.resolve(null),
      contextSession
        ? this.prisma.receivingCarton.findFirst({ where: { receivingSessionId: contextSession.id }, orderBy: { createdAt: 'desc' } })
        : Promise.resolve(null),
      contextSession
        ? this.prisma.receivingDiscrepancy.findFirst({ where: { receivingSessionId: contextSession.id, status: 'OPEN' }, orderBy: { createdAt: 'desc' } })
        : Promise.resolve(null),
      contextSession
        ? this.prisma.receivingProduct.findMany({ where: { receivingSessionId: contextSession.id }, select: { expectedQuantity: true, receivedQuantity: true } })
        : Promise.resolve([] as Array<{ expectedQuantity: number; receivedQuantity: number }>),
    ]);

    // ---- BATCH activity (owner report 2026-09-16: BATCH station displays
    // showed nothing). Batch writes carry NO stationId (addUnit/receiveUnit
    // only stamp the worker), so bind via the station's ASSIGNED WORKER —
    // the existing Worker+Device+Station assignment, never hard-coded ids.
    const workerId = station.assignedWorkerId;
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const [lastBatchUnit, lastReceivedItem, workerBatch] = workerId
      ? await Promise.all([
          this.prisma.ayroviUnit.findFirst({
            where: { createdByWorkerId: workerId, createdAt: { gte: dayAgo } },
            orderBy: { createdAt: 'desc' },
          }),
          this.prisma.batchItem.findFirst({
            where: { scannedByWorkerId: workerId, status: 'RECEIVED', batch: { updatedAt: { gte: dayAgo } } },
            include: { unit: true, batch: { include: { customer: true } } },
            orderBy: { createdAt: 'desc' },
          }),
          this.prisma.batch.findFirst({
            where: {
              OR: [{ createdById: workerId }, { items: { some: { scannedByWorkerId: workerId } } }],
              status: { in: ['CREATED', 'RECEIVING_IN_PROGRESS'] },
            },
            include: { customer: true },
            orderBy: { updatedAt: 'desc' },
          }),
        ])
      : ([null, null, null] as [null, null, null]);

    /** Display code for a batch unit: the ORIGINAL identity, AYP as fallback. */
    const unitCode = (u: { code: string; originalBarcode: string | null; originalSku: string | null; originalReference: string | null }) =>
      u.originalBarcode ?? u.originalSku ?? u.originalReference ?? u.code;

    /** Human name of a batch customer (display context for BATCH rows). */
    const customerNameOf = (c?: { name?: string | null } | null) => (c?.name ? c.name : null);

    // ---- Recent-actions feed (owner request 2026-09-16): ALL recent
    // actions at this station, newest first — receiving scans + cartons,
    // batch units (worker-bound), batch receives, TS puts, station moves,
    // batch lifecycle, AND the actions triggered from the display itself.
    const stationSessionIds = await this.prisma.receivingSession.findMany({
      where: { stationId, startedAt: { gte: dayAgo } },
      select: { id: true },
      take: 20,
    });
    const sessIds = stationSessionIds.map((r) => r.id);
    const [rxScans, rxCartons, batchUnits, batchReceives, tsItems, stationMoves, doneBatches, displayActions] = await Promise.all([
      sessIds.length
        ? this.prisma.receivingScanEvent.findMany({ where: { sessionId: { in: sessIds }, createdAt: { gte: dayAgo } }, orderBy: { createdAt: 'desc' }, take: 12 })
        : Promise.resolve([]),
      sessIds.length
        ? this.prisma.receivingCarton.findMany({ where: { receivingSessionId: { in: sessIds }, createdAt: { gte: dayAgo } }, orderBy: { createdAt: 'desc' }, take: 12 })
        : Promise.resolve([]),
      workerId
        ? this.prisma.ayroviUnit.findMany({ where: { createdByWorkerId: workerId, createdAt: { gte: dayAgo } }, orderBy: { createdAt: 'desc' }, take: 12 })
        : Promise.resolve([]),
      workerId
        ? this.prisma.batchItem.findMany({ where: { scannedByWorkerId: workerId, status: 'RECEIVED', receivedAt: { gte: dayAgo } }, include: { unit: true }, orderBy: { receivedAt: 'desc' }, take: 12 })
        : Promise.resolve([]),
      this.prisma.temporaryStorageItem.findMany({ where: { stationId, createdAt: { gte: dayAgo } }, orderBy: { createdAt: 'desc' }, take: 12 }),
      // TRANSFERS (owner 2026-09-16: the display shows ALL actions — entries,
      // exits, transfers — not only scans): goods handed out of this station
      // (OUT) or received into it (IN).
      this.prisma.productStationMove.findMany({
        where: { OR: [{ fromStationId: stationId }, { toStationId: stationId }], createdAt: { gte: dayAgo } },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
      // Batch lifecycle the worker drove: submitted to receiving / receiving
      // completed — bound to the station's assigned worker (batch writes
      // carry no stationId).
      workerId
        ? this.prisma.batch.findMany({
            where: {
              OR: [{ createdById: workerId }, { items: { some: { scannedByWorkerId: workerId } } }],
              status: { in: ['SENT_TO_RECEIVING', 'RECEIVING_COMPLETED'] },
              updatedAt: { gte: dayAgo },
            },
            orderBy: { updatedAt: 'desc' },
            take: 6,
          })
        : Promise.resolve([]),
      // STAGE 2: what humans did ON this station's screens (print / ack / help
      // / exception / message seen) — «show and record every action».
      this.prisma.stationDisplayAction.findMany({
        where: { stationId, createdAt: { gte: dayAgo } },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
    ]);
    type RecentAction = {
      id: string; kind: string; code: string | null; productName: string | null;
      customerName: string | null; quantity: number; status: string; at: Date;
    };
    const moveEvents: RecentAction[] = stationMoves.map((m) => ({
      id: m.id,
      kind: m.fromStationId === stationId ? 'OUT' : 'IN',
      code: m.sku ?? m.reference ?? m.productName ?? null,
      productName: m.productName ?? null,
      customerName: null,
      quantity: m.confirmedQuantity,
      status: m.result,
      at: m.createdAt,
    }));
    const batchEvents: RecentAction[] = doneBatches.map((b) => ({
      id: b.id,
      kind: b.status === 'SENT_TO_RECEIVING' ? 'BATCH SENT' : 'BATCH DONE',
      code: b.batchCode,
      productName: null,
      customerName: customerNameOf((b as { customer?: { name?: string | null } | null }).customer),
      quantity: b.status === 'RECEIVING_COMPLETED' ? b.totalScanned : b.totalExpected,
      status: b.status,
      at: b.updatedAt,
    }));
    const displayEvents: RecentAction[] = displayActions.map((a) => ({
      id: a.id,
      kind: DISPLAY_ACTION_LABELS[a.kind] ?? a.kind,
      code: a.summary ?? null,
      productName: null,
      customerName: null,
      quantity: 0,
      status: 'DISPLAY',
      at: a.createdAt,
    }));
    const recent: RecentAction[] = [
      ...rxScans.map((e) => ({ id: e.id, kind: e.kind === 'ARTICLE' ? 'ARTICLE' : 'SCAN', code: e.code ?? null, productName: null, customerName: null, quantity: e.quantity, status: 'CONFIRMED', at: e.createdAt })),
      ...rxCartons.map((c) => ({ id: c.id, kind: 'CARTON', code: c.scannedCode, productName: null, customerName: null, quantity: 1, status: c.status, at: c.receivedAt ?? c.createdAt })),
      ...batchUnits.map((u) => ({ id: u.id, kind: 'BATCH UNIT', code: unitCode(u), productName: null, customerName: null, quantity: 1, status: 'REGISTERED', at: u.createdAt })),
      ...batchReceives.map((bi) => ({ id: bi.id, kind: 'BATCH RECEIVE', code: unitCode(bi.unit), productName: null, customerName: null, quantity: 1, status: 'RECEIVED', at: bi.receivedAt ?? bi.createdAt })),
      ...tsItems.map((t) => ({ id: t.id, kind: 'STORAGE', code: t.sku ?? t.reference ?? null, productName: t.productName ?? null, customerName: t.customerName ?? null, quantity: t.quantity, status: t.status, at: t.createdAt })),
      ...moveEvents,
      ...batchEvents,
      ...displayEvents,
    ]
      .sort((a, b) => +new Date(b.at) - +new Date(a.at))
      .slice(0, 10);

    // The station's live operation = whichever moved most recently: a
    // receiving session or the worker's batch (build / receiving).
    const batchActive =
      workerBatch && (!activeSession || +new Date(workerBatch.updatedAt) > +new Date(activeSession.startedAt))
        ? workerBatch
        : null;

    const expectedTotal = products.reduce((n, p) => n + p.expectedQuantity, 0);
    const receivedTotal = products.reduce((n, p) => n + p.receivedQuantity, 0);

    // Prefer the newest of (receiving scan, batch unit, batch receive, TS
    // put, carton) as the "last scan" — one physical scan = one visible pop.
    const batchUnitCandidate = lastBatchUnit
      ? {
          id: lastBatchUnit.id,
          kind: 'BATCH UNIT' as const,
          code: unitCode(lastBatchUnit),
          productName: null as string | null,
          customerName: null as string | null,
          quantity: 1,
          status: 'REGISTERED',
          at: lastBatchUnit.createdAt,
        }
      : null;
    const batchReceiveCustomer = customerNameOf(
      (lastReceivedItem as { batch?: { customer?: { name?: string | null } | null } } | null)?.batch?.customer,
    );
    const batchReceiveCandidate = lastReceivedItem
      ? {
          id: lastReceivedItem.id,
          kind: 'BATCH RECEIVE' as const,
          code: unitCode(lastReceivedItem.unit),
          productName: null as string | null,
          customerName: batchReceiveCustomer,
          quantity: 1,
          status: 'RECEIVED',
          at: (lastReceivedItem as { receivedAt?: Date | null }).receivedAt ?? lastReceivedItem.batch.updatedAt,
        }
      : null;
    const tsCandidate = lastTsItem
      ? {
          id: lastTsItem.id,
          kind: 'STORAGE' as const,
          code: lastTsItem.sku ?? lastTsItem.reference ?? null,
          productName: lastTsItem.productName ?? null,
          customerName: lastTsItem.customerName ?? null,
          quantity: lastTsItem.quantity,
          status: lastTsItem.status,
          at: lastTsItem.createdAt,
        }
      : null;
    const rxCandidate = lastScanEvent
      ? {
          id: lastScanEvent.id,
          kind: lastScanEvent.kind as string,
          code: lastScanEvent.code,
          productName: null as string | null,
          customerName: null as string | null,
          quantity: lastScanEvent.quantity,
          status: 'CONFIRMED',
          at: lastScanEvent.createdAt,
        }
      : null;
    const lastCarton = lastCartonEvent
      ? {
          id: lastCartonEvent.id,
          kind: 'CARTON' as const,
          code: lastCartonEvent.scannedCode,
          productName: null as string | null,
          customerName: null as string | null,
          quantity: 1,
          status: lastCartonEvent.status,
          at: lastCartonEvent.receivedAt ?? lastCartonEvent.createdAt,
        }
      : null;
    const lastScan = [rxCandidate, batchUnitCandidate, batchReceiveCandidate, tsCandidate, lastCarton]
      .filter(Boolean)
      .sort((a, b) => +new Date(b!.at) - +new Date(a!.at))[0] ?? null;

    const batchProgress =
      batchActive && batchActive.status === 'RECEIVING_IN_PROGRESS' && batchActive.totalExpected > 0
        ? { done: batchActive.totalScanned, total: batchActive.totalExpected, label: 'units' }
        : null;

    return {
      station: {
        code: station.code,
        name: station.name,
        department: station.department,
        status: station.status,
      },
      worker: station.assignedWorker
        ? { code: station.assignedWorker.employeeCode, name: station.assignedWorker.name }
        : null,
      operation: batchActive
        ? {
            label: batchActive.status === 'CREATED' ? 'BATCH BUILD' : 'BATCH RECEIVING',
            sessionCode: batchActive.batchCode,
            sessionStatus: batchActive.status,
            arrivalReference: null,
          }
        : activeSession
          ? {
              label: 'RECEIVING',
              sessionCode: activeSession.code,
              sessionStatus: activeSession.status,
              arrivalReference: arrival?.arrivalReference ?? arrival?.code ?? null,
            }
          : lastTsItem
            ? { label: 'TEMPORARY_STORAGE', sessionCode: null, sessionStatus: null, arrivalReference: null }
            : null,
      task: openTask ? { title: openTask.title, status: openTask.status } : null,
      lastScan,
      error: openDiscrepancy
        ? { type: openDiscrepancy.type, reason: openDiscrepancy.reason, at: openDiscrepancy.createdAt }
        : null,
      customer: arrival
        ? [arrival.customerName, arrival.customerSurname].filter(Boolean).join(' ').trim() || null
        : lastTsItem?.customerName ?? batchReceiveCustomer ?? null,
      progress: batchProgress ?? (expectedTotal > 0 || receivedTotal > 0
        ? { done: receivedTotal, total: Math.max(expectedTotal, receivedTotal), label: 'units' }
        : null),
      recent,
      scanCount: batchActive && batchActive.status === 'CREATED' ? batchActive.totalExpected : activeSession?._count.scanEvents ?? 0,
    };
  }
}

/**
 * SERVER-side visibility enforcement (§4/§7): hidden fields never leave the
 * API, so the browser cannot reveal them by inspecting the payload.
 */
export function filterSnapshotByConfig(raw: any, config: unknown) {
  const cfg = normalizeDisplayConfig(config);
  const out: Record<string, unknown> = {};
  if (cfg.station && raw?.station) out.station = raw.station;
  if (cfg.worker) out.worker = raw?.worker ?? null;
  if (cfg.operation) out.operation = raw?.operation ?? null;
  if (cfg.task) out.task = raw?.task ?? null;
  if (cfg.progress) out.progress = raw?.progress ?? null;
  if (cfg.reports) out.reports = raw?.reports ?? null; // v1: off by default
  if (cfg.lastScan && raw?.lastScan) {
    const s = raw.lastScan;
    out.lastScan = {
      id: s.id,
      kind: s.kind,
      at: s.at,
      ...(cfg.product ? { code: s.code ?? null, productName: s.productName ?? null } : {}),
      ...(cfg.customer ? { customerName: s.customerName ?? null } : {}),
      ...(cfg.quantity ? { quantity: s.quantity } : {}),
      ...(cfg.status ? { status: s.status } : {}),
    };
  } else {
    out.lastScan = null;
  }
  if (cfg.status) out.error = raw?.error ?? null;
  if (cfg.recent && Array.isArray(raw?.recent)) {
    out.recent = (raw.recent as Array<Record<string, unknown>>).slice(0, 10).map((r) => ({
      id: r.id,
      kind: r.kind,
      at: r.at,
      ...(cfg.product ? { code: r.code ?? null, productName: r.productName ?? null } : {}),
      ...(cfg.customer ? { customerName: r.customerName ?? null } : {}),
      ...(cfg.quantity ? { quantity: r.quantity } : {}),
      ...(cfg.status ? { status: r.status } : {}),
    }));
  }
  out.customer = cfg.customer ? raw?.customer ?? null : null;
  return out;
}
