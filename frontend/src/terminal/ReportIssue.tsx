import { useState } from 'react';
import { terminalApi, WORKER_ISSUE_TYPES } from './api';

/**
 * REPORT ISSUE (§41, fix C-16).
 *
 * Available on EVERY operational screen from the shell strip — a worker never
 * has to hunt for where to report a problem. The types are the operational
 * exception vocabulary; the report is ALWAYS audited server-side and, when a
 * receiving session is active, ALSO opens a discrepancy so the Admin
 * Exception Center sees it immediately.
 *
 * Honesty rules: no local "it worked" fiction — the verdict shown is the
 * backend's (ok + discrepancy id, or the server's error message).
 */
export default function ReportIssue({
  sessionCode,
  getSessionId,
  taskKey,
}: {
  /** Display only — the receiving session code, when known. */
  sessionCode?: string | null;
  /** Resolves the current session id lazily (screens keep it in local state). */
  getSessionId?: () => string | undefined;
  taskKey?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string>('SHORTAGE');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async () => {
    if (busy || description.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const res = await terminalApi.reportIssue({
        type,
        description: description.trim(),
        taskKey: taskKey ?? undefined,
        sessionId: getSessionId?.(),
      });
      setDone(
        res.discrepancyId
          ? 'REPORTED — exception opened for the supervisor'
          : 'REPORTED — recorded in the audit trail',
      );
      setDescription('');
      window.setTimeout(() => {
        setDone(null);
        setOpen(false);
      }, 2600);
    } catch (e: any) {
      const m = e?.response?.data?.message ?? e?.message ?? 'report failed';
      setError(typeof m === 'string' ? m : 'report failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="wt-issue-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        REPORT ISSUE
      </button>

      {open && (
        <div className="wt-issue-panel" role="dialog" aria-label="Report an issue">
          <div className="wt-issue-head">
            <span className="wt-issue-title">REPORT ISSUE</span>
            {sessionCode && <span className="os-tag os-tag--muted">{sessionCode}</span>}
            <button type="button" className="wt-issue-close" onClick={() => setOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>

          <label className="os-label" htmlFor="wt-issue-type">Type</label>
          <select
            id="wt-issue-type"
            className="os-input os-select"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {WORKER_ISSUE_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>

          <label className="os-label" htmlFor="wt-issue-desc">What happened?</label>
          <textarea
            id="wt-issue-desc"
            className="os-input"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="describe the problem (at least 3 characters)"
            disabled={!!done}
          />

          {error && <div className="wt-issue-error">{error}</div>}
          {done && <div className="wt-issue-ok">{done}</div>}

          <div className="wt-issue-actions">
            <button type="button" className="os-btn" onClick={() => setOpen(false)} disabled={busy || !!done}>
              CANCEL
            </button>
            <button
              type="button"
              className="os-btn os-btn--primary"
              onClick={() => void submit()}
              disabled={busy || description.trim().length < 3 || !!done}
            >
              {busy ? 'SENDING…' : 'SEND REPORT'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
