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
  // ASSIST LAYER (owner order 2026-09-16: «the screens must show everything
  // about the station and HELP the worker») — each one is a real switch, so a
  // station can hide e.g. the shift totals without losing the guidance.
  'guidance',
  'queue',
  'alerts',
  'stats',
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
  // Assist layer — on by default: the point of the screen is to tell the
  // operator what to do next, not only what just happened.
  guidance: true,
  queue: true,
  alerts: true,
  stats: true,
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

/**
 * SCREEN ROLES (owner order 2026-09-16, v3): a station does not have «a big
 * screen» — it has a SET of screens, each with ONE job, like the andon boards
 * and pick-to-light faces of a real warehouse. The role decides what the server
 * is even allowed to send (see VIEW_PRESETS) — never just what the browser
 * hides.
 */
export const DISPLAY_VIEWS = ['BOARD', 'ACTION', 'QUEUE', 'ALERTS', 'PRINT', 'STATS'] as const;
export type DisplayView = (typeof DISPLAY_VIEWS)[number];
export const DEFAULT_DISPLAY_VIEW: DisplayView = 'BOARD';

export const VIEW_LABELS: Record<DisplayView, string> = {
  BOARD: 'Board — full station context',
  ACTION: 'Next action — one instruction only',
  QUEUE: 'Still expected — the work list',
  ALERTS: 'Andon — problems and calls only',
  PRINT: 'Print — labels only',
  STATS: 'Shift totals — numbers only',
};

/**
 * What each role may show. `BOARD` is today's behaviour (the admin's own
 * switches rule); every other role is a PRESET, enforced here so a screen can
 * never be configured into a role it is not meant to play.
 */
export const VIEW_PRESETS: Record<DisplayView, Partial<Record<DisplayConfigField, boolean>>> = {
  BOARD: {},
  ACTION: { guidance: true, queue: false, alerts: true, stats: false, recent: false, reports: false, task: true, operation: true, progress: true },
  QUEUE: { guidance: true, queue: true, alerts: false, stats: false, recent: false, reports: false },
  ALERTS: { guidance: false, queue: false, alerts: true, stats: false, recent: false, reports: false, lastScan: false },
  PRINT: { guidance: false, queue: false, alerts: false, stats: false, recent: false, reports: false, progress: false, task: false },
  STATS: { guidance: false, queue: false, alerts: false, stats: true, recent: false, reports: false, lastScan: false },
};

/** The standard screen set a station gets from one admin click. */
export const STANDARD_SCREEN_SET: Array<{ suffix: string; view: DisplayView }> = [
  { suffix: 'Board', view: 'BOARD' },
  { suffix: 'Next Action', view: 'ACTION' },
  { suffix: 'Andon', view: 'ALERTS' },
  { suffix: 'Print', view: 'PRINT' },
];

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
  view: DisplayView;
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
  // SCREEN ROLE first, then its preset: a role that is not the BOARD overrides
  // the block switches, so the server can only ever send what that role shows.
  const view = String(raw.view ?? '').toUpperCase() as DisplayView;
  out.view = (DISPLAY_VIEWS as readonly string[]).includes(view) ? view : DEFAULT_DISPLAY_VIEW;
  for (const [key, value] of Object.entries(VIEW_PRESETS[out.view])) {
    out[key as DisplayConfigField] = value === true;
  }
  // An interactive display with every action switched off would only render
  // dead buttons — treat it as non-interactive so the UI never lies.
  if (!Object.values(out.actions).some(Boolean)) out.interactive = false;
  return out;
}

/**
 * ASSIST LAYER (owner order 2026-09-16: «the screens must show everything about
 * the station and HELP the worker»).
 *
 * The NEXT ACTION is computed HERE, from the same rows the terminal writes —
 * never guessed by the browser — so a screen can only ever tell the operator
 * the step the backend believes is next. Pure function: no DB, no clock, so it
 * is unit tested directly and reused by the snapshot builder.
 */
export interface StationGuidanceInput {
  stationStatus: string;
  department: string;
  receiving: {
    active: boolean;
    sessionCode: string | null;
    startedAt: Date | null;
    hasDiscrepancy: boolean;
    products: Array<{ code: string | null; productName: string | null; expected: number; received: number }>;
  } | null;
  batch: { code: string; status: string; totalExpected: number; totalScanned: number } | null;
  task: { title: string; status: string } | null;
  storage: { code: string | null; section: string | null; status: string; needsReview: boolean } | null;
}

export interface StationGuidanceResult {
  guidance: { code: string; instruction: string; detail: string | null; tone: 'SCAN' | 'ALERT' | 'DONE' | 'WAIT' } | null;
  waiting: { reason: string; since: Date | null } | null;
  queue: Array<{ code: string | null; productName: string | null; remaining: number; expected: number; hint: string }>;
}

export function stationGuidance(input: StationGuidanceInput): StationGuidanceResult {
  const queue: StationGuidanceResult['queue'] = [];
  const say = (
    code: string,
    instruction: string,
    detail: string | null,
    tone: 'SCAN' | 'ALERT' | 'DONE' | 'WAIT',
  ): StationGuidanceResult => ({
    guidance: { code, instruction, detail, tone },
    waiting:
      tone === 'WAIT' || tone === 'ALERT'
        ? { reason: instruction, since: input.receiving?.startedAt ?? null }
        : null,
    queue,
  });

  if (input.stationStatus !== 'ACTIVE') {
    return say(
      'STATION_INACTIVE',
      'This station is not active',
      `Status ${input.stationStatus} — ask a supervisor before working here.`,
      'WAIT',
    );
  }

  const rx = input.receiving;
  if (rx && rx.active) {
    const pending = rx.products
      .map((p) => ({
        code: p.code,
        productName: p.productName,
        remaining: Math.max(0, p.expected - p.received),
        expected: p.expected,
      }))
      .filter((p) => p.remaining > 0)
      .sort((a, b) => b.remaining - a.remaining);
    for (const p of pending.slice(0, 5)) {
      queue.push({ ...p, hint: `${p.remaining} of ${p.expected} units left` });
    }
    const first = queue[0];
    if (first) {
      return say(
        'SCAN_PRODUCT',
        'Scan the next product',
        `${first.code ?? 'Product'}${first.productName ? ` — ${first.productName}` : ''}: ${first.hint}.`,
        'SCAN',
      );
    }
    if (rx.products.length > 0) {
      if (rx.hasDiscrepancy) {
        return say(
          'RESOLVE_DISCREPANCY',
          'Resolve the open discrepancy',
          'This session can not be closed while a discrepancy is open.',
          'ALERT',
        );
      }
      return say(
        'CLOSE_SESSION',
        'Every expected product is complete',
        `Close session ${rx.sessionCode ?? ''} and send the report.`.trim(),
        'DONE',
      );
    }
    return say('SCAN_FIRST', 'Start scanning this arrival', 'Nothing has been scanned on this session yet.', 'SCAN');
  }

  const batch = input.batch;
  if (batch) {
    const remaining = Math.max(0, batch.totalExpected - batch.totalScanned);
    if (batch.totalExpected > 0) {
      queue.push({
        code: batch.code,
        productName: null,
        remaining,
        expected: batch.totalExpected,
        hint: remaining > 0 ? `${batch.totalScanned} of ${batch.totalExpected} units` : 'complete',
      });
    }
    if (batch.status === 'CREATED') {
      if (batch.totalExpected > 0 && remaining === 0) {
        return say('SEND_BATCH', 'Every unit is registered', `Send batch ${batch.code} to receiving.`, 'DONE');
      }
      return say(
        'BUILD_UNIT',
        'Register the next unit',
        `Batch ${batch.code}: ${batch.totalScanned} of ${batch.totalExpected} units.`,
        'SCAN',
      );
    }
    if (batch.totalExpected > 0 && remaining === 0) {
      return say('BATCH_DONE', 'This batch is complete', `Finish the receiving of ${batch.code}.`, 'DONE');
    }
    return say(
      'RECEIVE_UNIT',
      'Receive the next unit',
      `Batch ${batch.code}: ${batch.totalScanned} of ${batch.totalExpected} units.`,
      'SCAN',
    );
  }

  if (input.department === 'STAGING') {
    const storage = input.storage;
    if (storage?.needsReview) {
      return say(
        'STORAGE_REVIEW',
        'A stored product needs review',
        `${storage.code ?? 'Product'} — check the review screen on the CT40.`,
        'ALERT',
      );
    }
    return say(
      'STORE_PRODUCT',
      'Scan the next product to store it',
      storage?.code
        ? `Last stored: ${storage.code}${storage.section ? ` (section ${storage.section})` : ''}.`
        : 'Pick the first free section on the CT40.',
      'SCAN',
    );
  }

  if (input.task) return say('TASK', input.task.title, `Open task · ${input.task.status}`, 'SCAN');

  return say(
    'WAITING',
    'Waiting for the next operation',
    'Nothing is open at this station yet — scan an arrival or open a task.',
    'WAIT',
  );
}

/**
 * ANDON STATE (owner order 2026-09-16, v3) — the colour the line sees from the
 * aisle: GREEN (running), AMBER (attention), RED (problem), GREY (nothing
 * open). Deliberately carries the CODE only, never the operator's free text:
 * the colour may be shown on a screen whose `alerts` block is switched off
 * without leaking anything hidden (the reason text lives in that block).
 */
export type AndonState = 'OK' | 'ATTENTION' | 'PROBLEM' | 'IDLE';
export interface AndonResult {
  state: AndonState;
  /** Machine-readable cause (never free text). */
  code: string;
  /** How long the station has been in this situation. */
  since: Date | null;
}

/** A stuck station gets LOUDER with time, like an andon cord being pulled. */
export const ANDON_ATTENTION_AFTER_MS = 10 * 60_000;
export const ANDON_PROBLEM_AFTER_MS = 25 * 60_000;

export function andonState(input: {
  stationStatus: string;
  operationOpen: boolean;
  hasDiscrepancy: boolean;
  openExceptions: number;
  helpOpen: boolean;
  needsReview: boolean;
  lastActivityAt: Date | null;
  now?: number;
}): AndonResult {
  const now = input.now ?? Date.now();
  if (input.helpOpen) return { state: 'PROBLEM', code: 'HELP_UNANSWERED', since: input.lastActivityAt };
  if (input.openExceptions > 0) return { state: 'PROBLEM', code: 'EXCEPTION_OPEN', since: input.lastActivityAt };
  if (input.hasDiscrepancy) return { state: 'PROBLEM', code: 'DISCREPANCY_OPEN', since: input.lastActivityAt };
  if (input.stationStatus !== 'ACTIVE') return { state: 'ATTENTION', code: 'STATION_NOT_ACTIVE', since: null };
  if (input.needsReview) return { state: 'ATTENTION', code: 'STORAGE_REVIEW', since: null };
  if (!input.operationOpen) return { state: 'IDLE', code: 'NOTHING_OPEN', since: null };
  // Aging: an open operation that has not moved gets louder.
  const idleMs = input.lastActivityAt ? now - +new Date(input.lastActivityAt) : 0;
  if (idleMs >= ANDON_PROBLEM_AFTER_MS) return { state: 'PROBLEM', code: 'STALLED', since: input.lastActivityAt };
  if (idleMs >= ANDON_ATTENTION_AFTER_MS) return { state: 'ATTENTION', code: 'NO_ACTIVITY', since: input.lastActivityAt };
  return { state: 'OK', code: 'RUNNING', since: input.lastActivityAt };
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
    if (input.config !== undefined) {
      // A partial config that does not mention `view` must NOT silently demote a
      // single-purpose screen back to BOARD: the role is a physical property of
      // the screen (which layout the operator is standing in front of), so it
      // only changes when the caller asks for it.
      const raw = (input.config && typeof input.config === 'object' && !Array.isArray(input.config)
        ? (input.config as Record<string, unknown>)
        : {});
      const currentView = normalizeDisplayConfig(before.config).view;
      data.config = normalizeDisplayConfig(
        'view' in raw ? raw : { ...raw, view: currentView },
      ) as unknown as object;
    }
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
          view: cfg.view,
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
  /**
   * SCREEN SET (owner order v3): give one station its standard set of
   * single-purpose screens in ONE call — Board / Next Action / Andon / Print —
   * skipping the roles it already has. Tokens are returned exactly once, as
   * everywhere else in this module.
   */
  async createScreenSet(
    stationId: string,
    input: { views?: DisplayView[]; config?: unknown },
    actorUserId: string | null,
  ) {
    const station = await this.prisma.station.findUnique({ where: { id: stationId } });
    if (!station) return null;
    const wanted = (input.views?.length
      ? STANDARD_SCREEN_SET.filter((s) => input.views!.includes(s.view))
      : STANDARD_SCREEN_SET);
    const existing = await this.prisma.stationDisplay.findMany({
      where: { stationId },
      select: { id: true, config: true, name: true },
    });
    const haveViews = new Set(existing.map((d) => normalizeDisplayConfig(d.config).view));
    const created: Array<Record<string, unknown>> = [];
    const skipped: DisplayView[] = [];
    for (const entry of wanted) {
      if (haveViews.has(entry.view)) {
        skipped.push(entry.view);
        continue;
      }
      const cfg = normalizeDisplayConfig({ ...(input.config as object ?? {}), view: entry.view });
      const row = await this.prisma.stationDisplay.create({
        data: {
          stationId,
          name: `${station.name} ${entry.suffix}`,
          accessToken: generateDisplayToken(),
          config: cfg as unknown as object,
        },
      });
      created.push({ displayId: row.id, view: entry.view, name: row.name, urlPath: `/display/${row.accessToken}` });
    }
    await this.audit.log({
      actorUserId,
      action: 'DISPLAY_SCREEN_SET_CREATED',
      entityType: 'station_display',
      metadata: {
        stationId,
        station: station.code,
        views: created.map((c) => c.view),
        skipped: skipped as unknown as string[],
        displayIds: created.map((c) => c.displayId),
      },
    });
    return { stationId, stationCode: station.code, created, skipped, applied: created.length };
  }

  async bulk(
    input: {
      action: 'CREATE_MISSING' | 'CREATE_SET' | 'APPLY_CONFIG' | 'SET_ENABLED' | 'SET_INTERACTIVE';
      stationIds?: string[];
      config?: unknown;
      enabled?: boolean;
      interactive?: boolean;
      /** `CREATE_SET`: restrict the build to these roles. */
      views?: DisplayView[];
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

    // A whole warehouse equipped in one click: every active station gets the
    // standard screen set, and only the roles it does not have yet.
    if (input.action === 'CREATE_SET') {
      const stations = await this.prisma.station.findMany({
        where: { ...stationFilter, status: 'ACTIVE' },
        orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true },
      });
      const created: Array<Record<string, unknown>> = [];
      for (const station of stations) {
        const res = await this.createScreenSet(
          station.id,
          { config: input.config, views: input.views },
          actorUserId,
        );
        for (const c of res?.created ?? []) created.push({ ...c, stationId: station.id, stationCode: station.code });
      }
      return { action: input.action, created, applied: created.length, stations: stations.length };
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
        // SCREEN ROLE (v3): what this screen IS. It already shaped which blocks
        // the server sent; the page uses it to pick the layout.
        view: cfg.view,
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
    // Admins AND the station's own worker (open item): the person standing at
    // the screen must be able to see that the call went out.
    const notified = await this.notifyStationAudience(actor.stationId, {
      title: `${urgent ? '🆘 URGENT' : '🙋 Assistance'} — ${actor.stationCode}`,
      body: note ? `${display.name}: ${note}` : `${display.name} is asking for a supervisor.`,
      route: '/admin/displays',
      event: 'DISPLAY_HELP_REQUESTED',
    });
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
    await this.notifyStationAudience(actor.stationId, {
      title: `⚠️ Exception ${created.exc.code} — ${actor.stationCode}`,
      body: `${type}: ${reason.slice(0, 140)}`,
      route: '/admin/exceptions',
      event: 'DISPLAY_EXCEPTION_RAISED',
    });
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

  /**
   * WHO GETS TOLD (open item 2026-09-16): the admins in the office AND the
   * worker assigned to the station — a call for help that only reaches a
   * dashboard is not help. Returns the number of devices reached; never throws
   * (a push failure must never break the station's action).
   */
  private async notifyStationAudience(
    stationId: string,
    payload: { title: string; body: string; route: string; event: string },
  ): Promise<number> {
    if (!this.push) return 0;
    let notified = 0;
    try {
      notified += await this.notifyAdmins(payload);
    } catch (e) {
      this.logger.warn(`admin push failed: ${e}`);
    }
    try {
      const station = await this.prisma.station.findUnique({
        where: { id: stationId },
        select: { assignedWorkerId: true },
      });
      if (station?.assignedWorkerId) {
        notified += await this.push.notifyUsers([station.assignedWorkerId], {
          title: payload.title,
          body: payload.body,
          // The handheld opens the terminal it can act in; the payload carries
          // the station so a future worker screen can deep-link precisely.
          route: '/terminal/receiving',
          data: { event: payload.event, stationId },
        });
      }
    } catch (e) {
      this.logger.warn(`station worker push failed: ${e}`);
    }
    return notified;
  }

  // ------------------------------------------------------------------
  // Worker print queue (open item 2026-09-16): a label queued for a station's
  // Bluetooth printer is claimed by the WORKER's own handheld — no shared
  // secret, no display token on a phone: the CT40 agent authenticates as the
  // worker, and only sees jobs of the stations assigned to that worker.
  // ------------------------------------------------------------------

  /** Stations this worker is responsible for (the existing assignment). */
  private async stationsOfWorker(workerId: string) {
    return this.prisma.station.findMany({
      where: { assignedWorkerId: workerId, status: 'ACTIVE' },
      select: { id: true, code: true, name: true },
    });
  }

  /** QUEUED jobs destined for a handheld/bridge printer at this worker's stations. */
  async pendingPrintJobsForWorker(workerId: string, input: { limit?: number }) {
    const stations = await this.stationsOfWorker(workerId);
    if (stations.length === 0) return { jobs: [], stations: [] };
    const jobs = await this.prisma.stationPrintJob.findMany({
      where: {
        stationId: { in: stations.map((s) => s.id) },
        status: 'QUEUED',
        transport: { in: ['CT40', 'BRIDGE'] },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(input.limit ?? 5, 1), 20),
      include: { display: { select: { id: true, name: true } } },
    });
    return {
      stations: stations.map((s) => ({ id: s.id, code: s.code, name: s.name })),
      jobs: jobs.map((j) => ({
        id: j.id,
        stationId: j.stationId,
        target: j.target,
        targetRef: j.targetRef,
        copies: j.copies,
        transport: j.transport,
        display: j.display ? { id: j.display.id, name: j.display.name } : null,
        requestedAt: j.createdAt,
        payload: j.payload,
      })),
    };
  }

  /**
   * The handheld reports the outcome. Same guarantees as the display-side
   * reporting path: a job can only be resolved once, and only by the station's
   * own worker.
   */
  async printJobResultForWorker(
    workerId: string,
    jobId: string,
    input: { status: 'PRINTED' | 'FAILED'; error?: string },
  ) {
    const stations = await this.stationsOfWorker(workerId);
    const job = await this.prisma.stationPrintJob.findUnique({ where: { id: jobId } });
    if (!job || !stations.some((s) => s.id === job.stationId)) {
      throw new HttpException('PRINT_JOB_NOT_FOUND', HttpStatus.NOT_FOUND);
    }
    if (job.status === 'PRINTED' || job.status === 'FAILED') {
      return { ok: true as const, duplicate: true, status: job.status };
    }
    const row = await this.prisma.stationPrintJob.update({
      where: { id: jobId },
      data: {
        status: input.status,
        resultAt: new Date(),
        error: input.status === 'FAILED' ? (input.error ?? 'Printer failed').slice(0, 300) : null,
        claimedBy: job.claimedBy ?? `worker:${workerId}`,
      },
    });
    await this.audit.log({
      actorUserId: workerId,
      action: input.status === 'PRINTED' ? 'DISPLAY_PRINT_COMPLETED' : 'DISPLAY_PRINT_FAILED',
      entityType: 'station_print_job',
      entityId: jobId,
      metadata: {
        via: 'WORKER_AGENT',
        stationId: job.stationId,
        target: job.target,
        targetRef: job.targetRef,
        transport: job.transport,
        error: input.status === 'FAILED' ? input.error ?? null : null,
      },
    });
    this.publishActivity(job.stationId, input.status === 'PRINTED' ? 'PRINTED' : 'PRINT_FAILED');
    return { ok: true as const, duplicate: false, status: row.status };
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
        ? this.prisma.receivingProduct.findMany({
            where: { receivingSessionId: contextSession.id },
            // Identity included: the screen must be able to say WHICH product is
            // still expected (assist layer), not only how many units are left.
            select: {
              sku: true, reference: true, productName: true,
              expectedQuantity: true, receivedQuantity: true, status: true,
            },
          })
        : Promise.resolve([] as Array<{
            sku: string | null; reference: string | null; productName: string | null;
            expectedQuantity: number; receivedQuantity: number; status: string;
          }>),
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

    // ---- ASSIST LAYER: the extra rows the guidance block needs (all indexed
    // counts, fetched in parallel — one snapshot is built per screen per tick).
    const [openExceptions, lastHelp, lastAck, scanTotals, cartonToday, storedToday, transfersOutToday, actionsToday] =
      await Promise.all([
        this.prisma.operationalException.findMany({
          where: { stationId, status: 'OPEN' },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, code: true, type: true, reason: true, createdAt: true },
        }),
        this.prisma.stationDisplayAction.findFirst({
          where: { stationId, kind: 'HELP' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, metadata: true },
        }),
        this.prisma.stationDisplayAction.findFirst({
          where: { stationId, kind: 'ACK' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        sessIds.length
          ? this.prisma.receivingScanEvent.aggregate({
              where: { sessionId: { in: sessIds } },
              _count: { _all: true },
              _sum: { quantity: true },
            })
          : Promise.resolve(null),
        sessIds.length
          ? this.prisma.receivingCarton.count({ where: { receivingSessionId: { in: sessIds } } })
          : Promise.resolve(0),
        this.prisma.temporaryStorageItem.count({ where: { stationId, createdAt: { gte: dayAgo } } }),
        this.prisma.productStationMove.count({ where: { fromStationId: stationId, createdAt: { gte: dayAgo } } }),
        this.prisma.stationDisplayAction.count({ where: { stationId, createdAt: { gte: dayAgo } } }),
      ]);

    // A HELP challenge stays open until the station acknowledges it (or 2h pass).
    const helpIsOpen =
      !!lastHelp &&
      !(lastAck && lastAck.createdAt > lastHelp.createdAt) &&
      Date.now() - +new Date(lastHelp.createdAt) < 2 * 3600_000;

    const assist = stationGuidance({
      stationStatus: station.status,
      department: station.department,
      receiving: contextSession
        ? {
            active: !!activeSession,
            sessionCode: contextSession.code,
            startedAt: contextSession.startedAt,
            hasDiscrepancy: !!openDiscrepancy,
            products: products.map((p) => ({
              code: p.sku ?? p.reference ?? null,
              productName: p.productName ?? null,
              expected: p.expectedQuantity,
              received: p.receivedQuantity,
            })),
          }
        : null,
      batch: batchActive
        ? {
            code: batchActive.batchCode,
            status: batchActive.status,
            totalExpected: batchActive.totalExpected,
            totalScanned: batchActive.totalScanned,
          }
        : null,
      task: openTask ? { title: openTask.title, status: openTask.status } : null,
      storage: lastTsItem
        ? {
            code: lastTsItem.sku ?? lastTsItem.reference ?? null,
            section: lastTsItem.sectionLetter ?? null,
            status: lastTsItem.status,
            needsReview: lastTsItem.status === 'REVIEW',
          }
        : null,
    });

    // Everything that is WRONG or WAITING at this station, in one strip: an open
    // discrepancy on the running session, open exceptions raised here (including
    // the ones raised from this very screen), and an unanswered supervisor call.
    const alerts: Array<{ id: string; kind: string; code: string | null; reason: string; at: Date; severity: string }> = [];
    if (openDiscrepancy) {
      alerts.push({
        id: openDiscrepancy.id,
        kind: 'DISCREPANCY',
        code: openDiscrepancy.type,
        reason: openDiscrepancy.reason ?? 'Discrepancy open on the current session',
        at: openDiscrepancy.createdAt,
        severity: 'HIGH',
      });
    }
    for (const exc of openExceptions) {
      alerts.push({
        id: exc.id,
        kind: 'EXCEPTION',
        code: exc.code,
        reason: exc.reason ?? exc.type,
        at: exc.createdAt,
        severity: exc.type === 'BLOCKED' || exc.type === 'DAMAGED' ? 'HIGH' : 'MEDIUM',
      });
    }
    if (helpIsOpen && lastHelp) {
      alerts.push({
        id: 'help',
        kind: 'HELP',
        code: null,
        reason: 'A supervisor was called from this screen and has not confirmed it yet',
        at: lastHelp.createdAt,
        severity: (lastHelp.metadata as { urgent?: boolean } | null)?.urgent ? 'HIGH' : 'MEDIUM',
      });
    }

    // Shift totals (today) — the operator sees what the station has done, not
    // only the last scan.
    const stats = {
      since: dayAgo.toISOString(),
      scans: scanTotals?._count ? (scanTotals._count as { _all: number })._all : 0,
      units: scanTotals?._sum?.quantity ?? 0,
      cartons: cartonToday,
      stored: storedToday,
      transfersOut: transfersOutToday,
      actions: actionsToday,
    };
    const help = { open: helpIsOpen, at: lastHelp?.createdAt ?? null };

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

    // ANDON (owner order v3): one colour for the whole line, aged with time.
    const lastActivityAt = [lastScan?.at ?? null, recent[0]?.at ?? null, openTask?.createdAt ?? null]
      .filter((d): d is Date => !!d)
      .sort((a, b) => +new Date(b) - +new Date(a))[0] ?? null;
    const andon = andonState({
      stationStatus: station.status,
      operationOpen: !!(activeSession || (batchActive && batchActive.status !== 'RECEIVING_COMPLETED')),
      hasDiscrepancy: !!openDiscrepancy,
      openExceptions: openExceptions.length,
      helpOpen: helpIsOpen,
      needsReview: lastTsItem?.status === 'REVIEW',
      lastActivityAt,
    });

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
            startedAt: batchActive.createdAt,
          }
        : activeSession
          ? {
              label: 'RECEIVING',
              sessionCode: activeSession.code,
              sessionStatus: activeSession.status,
              arrivalReference: arrival?.arrivalReference ?? arrival?.code ?? null,
              // Handover context: how long this station has been on this operation.
              startedAt: activeSession.startedAt,
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
      // ANDON — the line colour (code + age only; see AndonResult).
      andon,
      // ASSIST LAYER — what to do now, what is waiting, what is wrong, and what
      // the station has done today (each section has its own admin switch).
      guidance: assist.guidance,
      waiting: assist.waiting,
      queue: assist.queue,
      alerts,
      stats,
      help,
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
  // ANDON is the screen's own colour signal: code + state + age, never the
  // operator's free text — safe to send to every role (a PRINT-only screen
  // still needs to show that the line is red).
  out.andon = raw?.andon ?? null;
  // ASSIST LAYER — same invariant: a switch that is off means the section never
  // leaves the API (the browser cannot reveal it by inspecting the payload).
  if (cfg.guidance) {
    out.guidance = raw?.guidance ?? null;
    out.waiting = raw?.waiting ?? null;
  }
  if (cfg.queue) out.queue = raw?.queue ?? [];
  if (cfg.alerts) {
    out.alerts = raw?.alerts ?? [];
    out.help = raw?.help ?? null;
  }
  if (cfg.stats) out.stats = raw?.stats ?? null;
  out.customer = cfg.customer ? raw?.customer ?? null : null;
  return out;
}
