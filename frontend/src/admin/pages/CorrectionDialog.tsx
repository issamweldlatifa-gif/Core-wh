import { useState } from 'react';
import { apiErrorMessage } from '../../api/client';
import { Dialog } from '../../ui';

/**
 * Correction dialog (§8/§39).
 *
 * Every correction in the system funnels through this component so the rules
 * are impossible to bypass in the UI: a reason is mandatory, the original
 * state is shown before confirming, and the operator is told explicitly that
 * history is preserved rather than overwritten.
 */
export default function CorrectionDialog({
  title,
  description,
  original,
  extra,
  confirmLabel = 'Apply correction',
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  original: unknown;
  /** Optional extra field (e.g. the new quantity). */
  extra?: { label: string; value: string; onChange: (v: string) => void; type?: string };
  confirmLabel?: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = reason.trim().length < 8;

  async function submit() {
    if (tooShort || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={title}>
        <p className="ac-sub" style={{ margin: 0 }}>{description}</p>

        <div className="ac-modal-warn">
          History is never overwritten. This records a new, audited correction
          with the original and resulting state, your identity and a timestamp.
        </div>

        <div>
          <span className="os-label">Original state</span>
          <div className="ac-snapshot">{JSON.stringify(original, null, 2)}</div>
        </div>

        {extra && (
          <div>
            <label className="os-label" htmlFor="cd-extra">{extra.label}</label>
            <input
              id="cd-extra"
              className="os-input"
              type={extra.type ?? 'text'}
              value={extra.value}
              onChange={(e) => extra.onChange(e.target.value)}
            />
          </div>
        )}

        <div>
          <label className="os-label" htmlFor="cd-reason">Reason (required)</label>
          <input
            id="cd-reason"
            className="os-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. worker scanned the wrong carton"
            autoFocus
          />
        </div>

        {error && <div className="ac-error">{error}</div>}

        <div className="ac-modal-actions">
          <button type="button" className="os-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="os-btn os-btn--primary"
            onClick={submit}
            disabled={tooShort || busy}
            title={tooShort ? 'A reason of at least 8 characters is required' : undefined}
          >
            {busy ? 'Applying…' : confirmLabel}
          </button>
        </div>
    </Dialog>
  );
}
