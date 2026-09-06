import { useEffect, useState } from 'react';
import client, { getAccessToken } from '../../api/client';
import { useAuth } from '../../context/AuthContext';

/**
 * LIVE WALLBOARD — big-format display for warehouse TV / manager desk.
 * Connects to SSE /v1/live/events and shows:
 *   - Online workers
 *   - Events observed in this view (not authoritative daily totals)
 *   - Live event ticker with tone (ok/warn/err)
 * Falls back to 5s polling if SSE is unavailable (defensive).
 */

type LiveEvent = {
  topic: string;
  ts: number;
  payload?: any;
};

const toneFor = (topic: string) => {
  if (topic === 'scan.rejected' || topic === 'exception.opened') return 'err';
  if (topic === 'scan.accepted' || topic === 'bin.ready' || topic === 'packed' || topic === 'shipped') return 'ok';
  return 'info';
};

const labelFor = (topic: string) =>
  ({
    'scan.accepted': 'ACCEPTED',
    'scan.rejected': 'REJECTED',
    'exception.opened': 'EXCEPTION',
    'bin.ready': 'BIN READY',
    'packed': 'PACKED',
    'shipped': 'SHIPPED',
    'worker.heartbeat': 'HEARTBEAT',
  }[topic] ?? topic.toUpperCase());

export default function LiveBoard() {
  const { me } = useAuth();

  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [counters, setCounters] = useState({ accepted: 0, rejected: 0, packed: 0, shipped: 0, ready: 0 });
  const online: number | null = null; // Live connection count is not worker-presence authority.
  useEffect(() => {
    if (!me || me.application !== 'ADMIN_WEB') return;
    const controller = new AbortController();
    const base = import.meta.env.VITE_API_BASE || '/api';
    let stopped = false;
    const consume = (data: string) => {
      try {
        const event: LiveEvent = JSON.parse(data);
        if (!event.topic) return;
        setEvents((previous) => [event, ...previous].slice(0, 60));
        setCounters((previous) => ({
          ...previous,
          accepted: previous.accepted + Number(event.topic === 'scan.accepted'),
          rejected: previous.rejected + Number(event.topic === 'scan.rejected'),
          packed: previous.packed + Number(event.topic === 'packed'),
          shipped: previous.shipped + Number(event.topic === 'shipped'),
          ready: previous.ready + Number(event.topic === 'bin.ready'),
        }));
      } catch { /* ignore malformed event, never execute payload */ }
    };
    const connect = async () => {
      while (!stopped) {
        try {
          // Shared auth client renews an expired session; the streaming request then uses a header.
          await client.get('/v1/auth/me', { signal: controller.signal });
          const token = getAccessToken();
          if (!token || stopped) return;
          const response = await fetch(`${base}/v1/live/events`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error('Live stream unavailable');
          setConnected(true);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            while (!stopped) {
              const part = await reader.read();
              if (part.done) break;
              buffer += decoder.decode(part.value, { stream: true }).replace(/\r/g, '');
              const frames = buffer.split('\n\n');
              buffer = frames.pop() ?? '';
              for (const frame of frames) for (const line of frame.split('\n')) if (line.startsWith('data: ')) consume(line.slice(6));
            }
          } finally { reader.releaseLock(); }
        } catch { if (stopped) return; }
        if (!stopped) { setConnected(false); await new Promise((resolve) => setTimeout(resolve, 3000)); }
      }
    };
    void connect();
    return () => { stopped = true; controller.abort(); };
  }, [me?.user.id, me?.application]);

  const bigNum = (label: string, val: number | string | null, color: string) => (
    <div className="live-metric" style={{ borderColor: color }}>
      <div className="live-metric-value" style={{ color }}>{val ?? '—'}</div>
      <div className="live-metric-label">{label}</div>
    </div>
  );

  return (
    <div className="live-board">
      <div className="live-header">
        <h1 style={{ margin: 0 }}>LIVE WAREHOUSE</h1>
        <div className={`live-dot ${connected ? 'live-ok' : 'live-err'}`}>
          {connected ? '● LIVE' : '○ RECONNECTING'}
        </div>
      </div>
      <div className="live-grid">
        {bigNum('Workers online', online, '#00D084')}
        {bigNum('Scans accepted', counters.accepted, '#00D084')}
        {bigNum('Rejected', counters.rejected, '#E74C3C')}
        {bigNum('Bins ready', counters.ready, '#F5A623')}
        {bigNum('Packed', counters.packed, '#00D084')}
        {bigNum('Shipped', counters.shipped, '#4A90E2')}
      </div>
      <h2 style={{ marginTop: 24 }}>Live event feed · counts observed in this view</h2>
      <div className="live-feed">
        {events.length === 0 && <div className="live-empty">Waiting for events… scans from the floor will appear here.</div>}
        {events.map((ev, i) => {
          const tone = toneFor(ev.topic);
          return (
            <div key={i} className={`live-row tone-${tone}`}>
              <span className="live-time">{new Date(ev.ts).toLocaleTimeString()}</span>
              <span className={`live-badge tone-${tone}`}>{labelFor(ev.topic)}</span>
              <span className="live-payload">{ev.payload ? JSON.stringify(ev.payload) : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
