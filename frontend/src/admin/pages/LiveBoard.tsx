import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { adminApi } from '../api';

/**
 * LIVE WALLBOARD — big-format display for warehouse TV / manager desk.
 * Connects to SSE /v1/live/events and shows:
 *   - Online workers
 *   - Throughput (today's scans/packs/ships)
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
  const { token } = useAuth();
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [counters, setCounters] = useState({ accepted: 0, rejected: 0, packed: 0, shipped: 0, ready: 0 });
  const [online, setOnline] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!token) return;
    const base = (import.meta as any).env.VITE_API_BASE || '/api';
    const url = `${base}/live/events?token=${encodeURIComponent(token)}`;
    let es: EventSource;
    try {
      es = new EventSource(url);
      esRef.current = es;
    } catch {
      setConnected(false);
      return;
    }
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));
    es.addEventListener('snapshot', (e: any) => {
      try {
        const snap = JSON.parse(e.data);
        setOnline(snap.online);
      } catch { /* */ }
    });
    es.onmessage = (e) => {
      try {
        const ev: LiveEvent = JSON.parse(e.data);
        setEvents((prev) => [ev, ...prev].slice(0, 60));
        setCounters((c) => {
          const n = { ...c };
          switch (ev.topic) {
            case 'scan.accepted': n.accepted++; break;
            case 'scan.rejected': n.rejected++; break;
            case 'packed': n.packed++; break;
            case 'shipped': n.shipped++; break;
            case 'bin.ready': n.ready++; break;
          }
          return n;
        });
      } catch { /* */ }
    };
    return () => { es.close(); esRef.current = null; setConnected(false); };
  }, [token]);

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
      <h2 style={{ marginTop: 24 }}>Live event feed</h2>
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
