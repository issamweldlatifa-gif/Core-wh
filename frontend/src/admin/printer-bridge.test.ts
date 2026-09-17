import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** node has no localStorage — a tiny spec-compliant shim. */
function memoryLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, v); },
  } as Storage;
}
import {
  BRIDGE_SELF_TEST_URL,
  BridgeError,
  flushPrinterAudit,
  newJobId,
  printerBridge,
  queuePrinterAudit,
  setBridgeToken,
} from './printer-bridge';

describe('printer bridge client', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports BRIDGE_DOWN when the local bridge is not running (S1-S3)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network error'); }));
    await expect(printerBridge.status()).rejects.toMatchObject({ code: 'BRIDGE_DOWN' });
  });

  it('connects and returns the bridge state (S5)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('http://127.0.0.1:8787/connect');
      expect(String(init?.headers && (init.headers as Record<string, string>)['Content-Type'])).toBe('application/json');
      return new Response(JSON.stringify({ ok: true, state: 'CONNECTED' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await printerBridge.connect('E9:BD:F6:4B:95:40', 'PM-241-BT');
    expect(r.ok).toBe(true);
    expect(r.state).toBe('CONNECTED');
  });

  it('printer errors surface their simple user sentence (S13, §20)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'LINK_LOST', detail: 'Printer connection lost.' }), { status: 409 })));
    await expect(printerBridge.printTest('job-1')).rejects.toMatchObject({
      code: 'LINK_LOST',
      message: 'Printer connection lost.',
    });
  });

  it('sends the optional shared token header (§ security)', async () => {
    setBridgeToken('sekret');
    let seen: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen = (init?.headers as Record<string, string>)['X-Print-Token'];
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    await printerBridge.disconnect();
    expect(seen).toBe('sekret');
  });

  it('does NOT send an empty token header — the status check stays a simple request', async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      headers = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ bridge: true }), { status: 200 });
    }));
    await printerBridge.status();
    expect('X-Print-Token' in headers).toBe(false);
  });

  it('names WHY the bridge could not be reached: blocked vs timeout', async () => {
    // The browser refusing the request (CORS / private-network / local-network
    // permission) and the bridge being too slow need opposite fixes, so the
    // reason has to survive both hosts.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(printerBridge.status()).rejects.toMatchObject({ code: 'BRIDGE_DOWN', cause: 'BLOCKED' });

    vi.stubGlobal('fetch', vi.fn(async () => {
      const e = new DOMException('aborted', 'AbortError');
      throw e;
    }));
    await expect(printerBridge.status()).rejects.toMatchObject({ code: 'BRIDGE_DOWN', cause: 'TIMEOUT' });
  });

  it('offers the in-browser self test on the CT40', () => {
    expect(BRIDGE_SELF_TEST_URL).toBe('http://127.0.0.1:8787/status');
  });

  it('generates unique job ids (duplicate protection input)', () => {
    const a = new Set(Array.from({ length: 500 }, () => newJobId()));
    expect(a.size).toBe(500);
  });
});

describe('printer audit outbox (offline §24 → audit §22)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queues while offline and flushes everything when the API returns', async () => {
    queuePrinterAudit({ event: 'PRINTER_TEST_PRINTED', printerName: 'PM-241-BT' });
    queuePrinterAudit({ event: 'PRINT_FAILED', printerName: 'PM-241-BT', detail: 'link lost' });
    let attempts = 0;
    const sent = await flushPrinterAudit(async (p) => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      expect(p.event).toBeTruthy();
    });
    expect(sent).toBe(1);
    const sent2 = await flushPrinterAudit(async () => undefined);
    expect(sent2).toBe(1);
    const sent3 = await flushPrinterAudit(async () => undefined);
    expect(sent3).toBe(0);
  });

  it('caps the outbox so a long offline stretch cannot grow it unbounded', async () => {
    for (let i = 0; i < 150; i += 1) queuePrinterAudit({ event: 'PRINT_FAILED', printerName: 'P' });
    const box = JSON.parse(localStorage.getItem('printer_audit_outbox') ?? '[]');
    expect(box.length).toBeLessThanOrEqual(100);
  });
});
