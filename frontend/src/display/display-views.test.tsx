import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ActionView, AlertsView, AndonBar, PrintView, QueueView, StatsView, VIEW_TITLES,
} from './StationViews';
import {
  ANDON_STYLE, SCREEN_UNIT, VIEW_LABELS, snapshotView, u,
  type DisplaySnapshot, type DisplayView,
} from './display-view';

/**
 * SCREEN SET rendering (owner order v3): a station is NOT one big screen —
 * each physical screen plays ONE role, and the markup proves it. A worker
 * standing at the PRINT screen must not see the queue or the stats, even when
 * the snapshot is over-filled (defence in depth on top of the server filter).
 */

const snap = (over: Partial<DisplaySnapshot> = {}): DisplaySnapshot => ({
  enabled: true,
  station: { code: 'RECV-01', name: 'Receiving', department: 'RECEIVING', status: 'ACTIVE' },
  worker: { code: 'W-001', name: 'Worker One' },
  operation: { label: 'RECEIVING', sessionCode: 'RCV-000301' },
  progress: { done: 13, total: 50, label: 'units' },
  lastScan: { id: 's1', kind: 'SCAN', code: 'SA-4471', productName: 'Widget', quantity: 1, at: new Date().toISOString() },
  guidance: { code: 'SCAN_PRODUCT', instruction: 'SCAN_PRODUCT', detail: 'SA-4471 13 of 50', tone: 'SCAN' },
  waiting: null,
  queue: [{ code: 'SA-4471', productName: 'Widget', remaining: 13, expected: 50 }],
  alerts: [{ id: 'a1', kind: 'HELP', code: 'CALL', reason: 'Operator needs a supervisor', at: new Date().toISOString(), severity: 'HIGH' }],
  stats: { scans: 5, units: 9, cartons: 2, stored: 1, transfersOut: 3, actions: 3 },
  andon: { state: 'PROBLEM', code: 'HELP_UNANSWERED', since: new Date(Date.now() - 12 * 60_000).toISOString() },
  options: { interactive: true, actions: ['print', 'reprint', 'ack'], view: 'ACTION', printTransport: 'BROWSER' },
  messages: [],
  lastUpdate: new Date().toISOString(),
  ...over,
});

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const props = (over: Partial<DisplaySnapshot> = {}, extra: Record<string, unknown> = {}) => ({
  snap: snap(over), now: Date.now(), actions: ['print', 'reprint', 'ack'], busy: null,
  onAckAlert: () => undefined, onPrint: () => undefined, onReprint: () => undefined, ...extra,
});

describe('screen set — roles exist, are labelled, and are English-only (owner rule 16409e6)', () => {
  const ROLES: DisplayView[] = ['BOARD', 'ACTION', 'QUEUE', 'ALERTS', 'PRINT', 'STATS'];

  it('every role has a title and a one-line label, and no two labels collide', () => {
    for (const r of ROLES) {
      expect(VIEW_TITLES[r]).toBeTruthy();
      expect(VIEW_LABELS[r]).toBeTruthy();
    }
    expect(new Set(ROLES.map((r) => VIEW_LABELS[r])).size).toBe(ROLES.length);
  });

  it('the UI is English only — no Arabic anywhere in the screen-set copy', () => {
    const arabic = /[\u0600-\u06FF]/;
    for (const text of [...Object.values(VIEW_TITLES), ...Object.values(VIEW_LABELS)]) {
      expect(arabic.test(text)).toBe(false);
    }
  });

  it('snapshotView never guesses a role: unknown or missing → BOARD', () => {
    expect(snapshotView(null)).toBe('BOARD');
    expect(snapshotView(snap())).toBe('ACTION');
    expect(snapshotView(snap({ options: { view: 'NOPE' as unknown as DisplayView } }))).toBe('BOARD');
    expect(snapshotView(snap({ options: {} }))).toBe('BOARD');
  });

  it('andon colours are distinct and PROBLEM is the only red of the palette', () => {
    const colors = Object.values(ANDON_STYLE).map((s) => s.color);
    expect(new Set(colors).size).toBe(colors.length);
    expect(ANDON_STYLE.PROBLEM.color).toBe('#ff4d4d');
    expect(ANDON_STYLE.OK.label).toBe('RUNNING');
  });
});

describe('screen set — each role renders ONE job and nothing else', () => {
  it('ACTION: the instruction is big, the queue/stats never appear', () => {
    const out = html(<ActionView {...props()} />);
    expect(out).toContain('SCAN_PRODUCT');
    expect(out).toContain('data-testid="action-instruction"');
    expect(out).toContain('SA-4471 13 of 50'); // the detail line
    expect(out).not.toContain('data-testid="queue-rows"');
    expect(out).not.toContain('data-testid="stats-grid"');
    // a problem at the station is still visible on the action screen
    expect(out).toContain('data-testid="action-alert"');
  });

  it('QUEUE: the work list and the progress bar, no instruction and no numbers board', () => {
    const out = html(<QueueView {...props()} />);
    expect(out).toContain('data-testid="queue-rows"');
    expect(out).toContain('13 / 50');
    expect(out).not.toContain('data-testid="action-instruction"');
    expect(out).not.toContain('data-testid="stats-grid"');
    const empty = html(<QueueView {...props({ queue: [] })} />);
    expect(empty).toContain('data-testid="queue-empty"');
    expect(empty).toContain('Nothing expected right now');
  });

  it('ALERTS: the andon state + the open problems, aged', () => {
    const out = html(<AlertsView {...props()} />);
    expect(out).toContain('data-testid="andon-state"');
    expect(out).toContain('PROBLEM');
    expect(out).toContain('HELP_UNANSWERED');
    expect(out).toContain('data-testid="andon-alerts"');
    expect(out).toContain('Operator needs a supervisor');
    expect(out).not.toContain('data-testid="queue-rows"');
    const calm = html(<AlertsView {...props({ alerts: [], andon: { state: 'OK', code: 'RUNNING' } })} />);
    expect(calm).toContain('No open problem at this station');
  });

  it('ALERTS: a HELP call is not acknowledgeable from the andon screen (supervisor confirms it, not the worker)', () => {
    const helpOnly = html(<AlertsView {...props()} />);
    expect(helpOnly).not.toContain('✓ SEEN'); // only alert present is the HELP call
    const exception = html(<AlertsView {...props({
      alerts: [{ id: 'e1', kind: 'EXCEPTION', code: 'DAMAGED', reason: 'Pallet damaged', at: new Date().toISOString(), severity: 'HIGH' }],
    })} />);
    expect(exception).toContain('✓ SEEN');
  });

  it('PRINT: the label target and two giant buttons — nothing else on the screen', () => {
    const out = html(<PrintView {...props()} lastJob={{ id: 'job-1234', ref: 'SA-4471' }} />);
    expect(out).toContain('data-testid="print-target"');
    expect(out).toContain('SA-4471');
    expect(out).toContain('🖨 PRINT');
    expect(out).toContain('↻ REPRINT');
    expect(out).toContain('data-testid="print-last-job"');
    expect(out).not.toContain('data-testid="action-instruction"');
    expect(out).not.toContain('data-testid="queue-rows"');
    // a display that may not print shows a disabled button, never a lie
    const readOnly = html(<PrintView {...props({}, { actions: [] })} />);
    expect(readOnly).toContain('disabled');
    expect(readOnly).toContain('not allowed to print');
    // nothing scanned yet → nothing to print
    const nothing = html(<PrintView {...props({ lastScan: null })} />);
    expect(nothing).toContain('data-testid="print-empty"');
    // nothing printed yet → reprint stays disabled (never a dead button)
    expect(nothing).not.toContain('REPRINT');
  });

  it('STATS: six tiles, the shift totals, no instruction and no queue', () => {
    const out = html(<StatsView {...props()} />);
    expect(out).toContain('data-testid="stats-grid"');
    for (const label of ['SCANS', 'UNITS', 'CARTONS', 'STORED', 'TRANSFERS OUT', 'SCREEN ACTIONS']) {
      expect(out).toContain(label);
    }
    expect(out).toContain('TODAY — RECV-01');
    expect(out).not.toContain('data-testid="action-instruction"');
    expect(out).not.toContain('data-testid="queue-rows"');
  });

  it('the andon bar rides on EVERY role — a print screen still shows a red line', () => {
    for (const [state, color] of [['PROBLEM', '#ff4d4d'], ['ATTENTION', '#f2c15c'], ['OK', '#39d98a'], ['IDLE', '#5b6b7a']] as const) {
      const out = html(<AndonBar snap={snap({ andon: { state, code: 'X' } })} now={Date.now()} />);
      expect(out).toContain(`data-andon="${state}"`);
      expect(out).toContain(`background:${color}`);
    }
    // a snapshot without andon (old server) falls back to IDLE, never to green
    expect(html(<AndonBar snap={snap({ andon: null })} now={Date.now()} />)).toContain('data-andon="IDLE"');
  });
});

/**
 * SCREEN FIT (owner report 2026-09-16, live site): «half the page is not
 * visible, the buttons never show». The live board used fixed pixel sizes, so
 * on a 1568×787 window the giant scan code pushed the action bar and the
 * footer off the glass. Every size now comes from ONE viewport unit, and the
 * middle section is the only thing allowed to shrink. These tests are the
 * guard so a fixed `fontSize: 120` can never come back.
 */
describe('screen fit — nothing may be pushed off the glass', () => {
  it('the unit is derived from the viewport, never a raw pixel', () => {
    expect(SCREEN_UNIT['--px']).toContain('vw');
    expect(SCREEN_UNIT['--px']).toContain('vh');
    expect(u(120)).toBe('calc(var(--px) * 120)');
    expect(u(28)).toBe('calc(var(--px) * 28)');
  });

  it('every display component sizes text in units (source guard)', async () => {
    const [board, views] = await Promise.all([
      import('./StationDisplay.tsx?raw').then((m) => (m as { default: string }).default),
      import('./StationViews.tsx?raw').then((m) => (m as { default: string }).default),
    ]);
    for (const [name, src] of [['StationDisplay', board], ['StationViews', views]] as const) {
      const raw = src.match(/fontSize: \d+/g) ?? [];
      expect(raw, `${name} has fixed pixel font sizes: ${raw.join(', ')}`).toEqual([]);
      expect(src).toContain('u('); // …and it really uses the viewport unit
    }
  });

  it('the root is exactly the viewport and only the middle may shrink', async () => {
    const board = (await import('./StationDisplay.tsx?raw')).default as string;
    expect(board).toContain("'100dvh'");
    expect(board).toContain('overflow: \'hidden\'');
    expect(board).toContain('minHeight: 0');           // the shrinking section
    expect(board.match(/flexShrink: 0/g)?.length ?? 0).toBeGreaterThanOrEqual(3); // header, bar, footer
    expect(board).toContain('data-testid="action-bar"');
  });
});
