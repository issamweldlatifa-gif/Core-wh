import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { terminalApi, type TerminalContext } from './api';

/**
 * Worker Operating System shell (spec §4/§5).
 *
 * This is NOT the admin dashboard with fewer buttons. It is a dedicated
 * operational workspace: a thin identity/status frame around a full-bleed
 * work area, optimised for speed, few clicks and large feedback (§4).
 *
 * The shell also enforces the product's first rule: a worker never lands in
 * the Admin Control Center (§2).
 */

interface TerminalUi {
  ctx: TerminalContext | null;
  reload: () => Promise<void>;
  /** Terminal-wide status line shown in the footer (§5). */
  setStatus: (s: { text: string; kind?: 'ok' | 'bad' | 'info' } | null) => void;
  setLastAction: (s: string | null) => void;
}

const TerminalUiContext = createContext<TerminalUi | null>(null);

export function useTerminalUi(): TerminalUi {
  const v = useContext(TerminalUiContext);
  if (!v) throw new Error('useTerminalUi must be used inside the Worker Terminal shell.');
  return v;
}

export default function WorkerShell() {
  const { me, loading, logoutFn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [ctx, setCtx] = useState<TerminalContext | null>(null);
  const [ctxLoading, setCtxLoading] = useState(true);
  const [status, setStatus] = useState<{ text: string; kind?: 'ok' | 'bad' | 'info' } | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [clock, setClock] = useState(() => new Date());

  const reload = useCallback(async () => {
    try {
      setCtx(await terminalApi.context());
    } catch {
      // A context failure must not strand the worker on a blank screen; the
      // terminal degrades to "no tasks" rather than crashing.
      setCtx(null);
    } finally {
      setCtxLoading(false);
    }
  }, []);

  useEffect(() => {
    if (me) void reload();
  }, [me, reload]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const t = window.setInterval(() => setClock(new Date()), 30_000);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      window.clearInterval(t);
    };
  }, []);

  const ui = useMemo<TerminalUi>(
    () => ({ ctx, reload, setStatus, setLastAction }),
    [ctx, reload],
  );

  if (loading || ctxLoading) {
    return (
      <div className="os-root theme-worker wt-boot">
        <div className="wt-boot-inner">
          <div className="wt-boot-brand">AYROVI</div>
          <div className="os-muted">starting worker terminal…</div>
        </div>
      </div>
    );
  }

  if (!me) return <Navigate to="/login" replace />;

  const task = ctx?.tasks.find((t) => location.pathname.startsWith(t.path));

  return (
    <TerminalUiContext.Provider value={ui}>
      <div className="os-root theme-worker wt">
        {/* Identity strip: who am I, where am I, what am I doing (§5). */}
        <header className="wt-top">
          <div className="wt-top-left">
            <span className="wt-brand">AYROVI</span>
            <span className="wt-task">{task?.label ?? 'TERMINAL'}</span>
          </div>
          <div className="wt-top-right">
            <span className="wt-worker" title="Signed-in worker">
              {me.user.name}
            </span>
            <span className="os-tag os-tag--muted">
              {ctx?.station ? ctx.station.code : 'NO STATION'}
            </span>
            <span className={`os-tag ${online ? 'os-tag--ok' : 'os-tag--err'}`}>
              {online ? 'ONLINE' : 'OFFLINE'}
            </span>
            <button
              type="button"
              className="os-btn os-btn--ghost wt-top-btn"
              onClick={() => navigate('/terminal')}
            >
              TASKS
            </button>
            <button
              type="button"
              className="os-btn os-btn--danger wt-top-btn"
              onClick={() => void logoutFn()}
            >
              LOG OUT
            </button>
          </div>
        </header>

        {/* Full-bleed operational work area (§5). */}
        <main className="wt-body">
          <Outlet />
        </main>

        {/* Persistent operational status: state, last action, session (§5). */}
        <footer className="wt-foot">
          <span className={`wt-foot-state ${status?.kind ?? 'info'}`}>
            {status?.text ?? 'READY'}
          </span>
          <span className="wt-foot-last">{lastAction ?? '—'}</span>
          <span className="wt-foot-meta">
            {ctx?.station?.name ?? 'unassigned'} ·{' '}
            {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </footer>
      </div>
    </TerminalUiContext.Provider>
  );
}
