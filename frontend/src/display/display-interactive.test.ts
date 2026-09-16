import { describe, expect, it } from 'vitest';
import {
  ACTION_LABELS,
  type DisplaySnapshot,
  availableActions,
  soundCueFor,
  topMessage,
} from './display-view';
import { labelDocument } from './display-print';

const snap = (over: Partial<DisplaySnapshot> = {}): DisplaySnapshot => ({
  enabled: true,
  station: { code: 'RECV-01', name: 'Receiving', department: 'RECEIVING', status: 'ACTIVE' },
  lastUpdate: new Date().toISOString(),
  ...over,
});

describe('station display — interactive stage (owner order 2026-09-16)', () => {
  it('a read-only display (default) renders NO action button at all', () => {
    expect(availableActions(snap(), { hasPrintable: true, hasReprintable: true })).toEqual([]);
    expect(availableActions(snap({ options: { interactive: false, actions: ['print'] } }), { hasPrintable: true, hasReprintable: true })).toEqual([]);
  });

  it('the action bar is a rendering of the SERVER answer, not a client rule', () => {
    const s = snap({ options: { interactive: true, actions: ['print', 'ack', 'help'] } });
    expect(availableActions(s, { hasPrintable: true, hasReprintable: false }))
      .toEqual(['print', 'ack', 'help']);
  });

  it('print/reprint never show as dead buttons (nothing to print / nothing printed yet)', () => {
    const s = snap({ options: { interactive: true, actions: ['print', 'reprint', 'ack'] } });
    expect(availableActions(s, { hasPrintable: false, hasReprintable: false })).toEqual(['ack']);
    expect(availableActions(s, { hasPrintable: true, hasReprintable: true })).toEqual(['print', 'reprint', 'ack']);
  });

  it('every action has a human label (never a raw key on a wall screen)', () => {
    for (const key of ['print', 'reprint', 'ack', 'help', 'exception'] as const) {
      expect(ACTION_LABELS[key]).toBeTruthy();
    }
  });

  it('operator message: highest severity wins, oldest first inside the same severity', () => {
    const s = snap({
      messages: [
        { id: 'm1', body: 'info later', severity: 'INFO', requireAck: true, at: new Date(2000).toISOString() },
        { id: 'm2', body: 'urgent', severity: 'URGENT', requireAck: true, at: new Date(5000).toISOString() },
        { id: 'm3', body: 'urgent older', severity: 'URGENT', requireAck: true, at: new Date(1000).toISOString() },
      ],
    });
    expect(topMessage(s)?.id).toBe('m3');
    expect(topMessage(snap())).toBeNull();
  });

  it('sound cues: new scan, new error and new message each beep once — never twice for the same event', () => {
    const scanSnap = snap({ lastScan: { id: 'TX-1', kind: 'PRODUCT', at: new Date().toISOString() } });
    expect(soundCueFor(scanSnap, { lastScanId: null, errorType: null, messageId: null })).toBe('SCAN_OK');
    expect(soundCueFor(scanSnap, { lastScanId: 'TX-1', errorType: null, messageId: null })).toBeNull();

    const errSnap = snap({ error: { type: 'SHORTAGE', at: new Date().toISOString() } });
    expect(soundCueFor(errSnap, { lastScanId: null, errorType: null, messageId: null })).toBe('ERROR');

    const msgSnap = snap({ messages: [{ id: 'm9', body: 'stop', severity: 'URGENT', requireAck: true, at: new Date().toISOString() }] });
    expect(soundCueFor(msgSnap, { lastScanId: null, errorType: null, messageId: null })).toBe('MESSAGE');
    expect(soundCueFor(msgSnap, { lastScanId: null, errorType: null, messageId: 'm9' })).toBeNull();

    expect(soundCueFor({ ...scanSnap, enabled: false }, { lastScanId: null, errorType: null, messageId: null })).toBeNull();
  });

  it('the printed label carries the SAME identity the operator sees (+ one page per copy)', () => {
    const doc = labelDocument({
      title: 'SCAN LABEL', code: 'SA12345', kind: 'PRODUCT', quantity: 3,
      customer: 'Ahmed S.', station: { code: 'RECV-01' }, worker: { code: 'W024' },
    }, 2);
    expect(doc).toContain('SA12345');
    expect(doc).toContain('RECV-01');
    expect(doc).toContain('W024');
    expect(doc.match(/class="lbl"/g)).toHaveLength(2);
    // copies are bounded server- and client-side (a wall screen is not a printer farm)
    expect(labelDocument({ code: 'X' }, 99).match(/class="lbl"/g)).toHaveLength(5);
  });
});
