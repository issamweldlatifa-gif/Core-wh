import { describe, expect, it } from 'vitest';
import {
  type DisplaySnapshot,
  DISPLAY_OFFLINE_AFTER_MS,
  displayUrl,
  isDisplayOnline,
  relativeTime,
  viewState,
} from './display-view';

const snap = (over: Partial<DisplaySnapshot> = {}): DisplaySnapshot => ({
  enabled: true,
  station: { code: 'RECV-01', name: 'Receiving', department: 'RECEIVING', status: 'ACTIVE' },
  lastUpdate: new Date().toISOString(),
  ...over,
});

describe('station display view model', () => {
  it('DISABLED beats everything (admin off = no data rendered)', () => {
    expect(viewState({ ...snap({ enabled: false }), error: { type: 'X', at: new Date().toISOString() } })).toBe('DISABLED');
    expect(viewState(null)).toBe('DISABLED');
  });

  it('ERROR when an open discrepancy exists, even with a fresh scan', () => {
    const now = Date.now();
    const s = snap({
      error: { type: 'SHORTAGE', reason: 'missing 2', at: new Date(now - 5_000).toISOString() },
      lastScan: { id: 't1', kind: 'PRODUCT', code: 'SA1', quantity: 3, status: 'CONFIRMED', at: new Date(now - 1_000).toISOString() },
    });
    expect(viewState(s, now)).toBe('ERROR');
  });

  it('SUCCESS inside the 2-minute scan window, PROCESSING on active operation, IDLE otherwise', () => {
    const now = Date.now();
    expect(viewState(snap({ lastScan: { id: 't1', kind: 'PRODUCT', at: new Date(now - 60_000).toISOString() } }), now)).toBe('SUCCESS');
    expect(viewState(snap({ operation: { label: 'RECEIVING', sessionCode: 'RCV-1' } }), now)).toBe('PROCESSING');
    expect(viewState(snap(), now)).toBe('IDLE');
  });

  it('a scan older than the window falls back to PROCESSING/IDLE, never stale SUCCESS', () => {
    const now = Date.now();
    const s = snap({ lastScan: { id: 't1', kind: 'PRODUCT', at: new Date(now - 10 * 60_000).toISOString() } });
    expect(viewState(s, now)).toBe('IDLE');
    expect(viewState({ ...s, operation: { label: 'RECEIVING' } }, now)).toBe('PROCESSING');
  });

  it('online = lastSeen within the 90s bound (same bound as backend)', () => {
    const now = Date.now();
    expect(isDisplayOnline(new Date(now - 10_000).toISOString(), now)).toBe(true);
    expect(isDisplayOnline(new Date(now - DISPLAY_OFFLINE_AFTER_MS - 1).toISOString(), now)).toBe(false);
    expect(isDisplayOnline(null, now)).toBe(false);
  });

  it('relativeTime buckets', () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 3_000).toISOString(), now)).toBe('just now');
    expect(relativeTime(new Date(now - 42_000).toISOString(), now)).toBe('42s ago');
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m ago');
    expect(relativeTime(null, now)).toBe('—');
  });

  it('display URL uses the token path, never the station name', () => {
    expect(displayUrl('abc123', 'https://wh.example.com')).toBe('https://wh.example.com/display/abc123');
  });
});
