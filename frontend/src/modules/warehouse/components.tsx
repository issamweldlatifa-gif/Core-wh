import { useAuth } from '../../context/AuthContext';
import { toneForStatus } from '../../ui';

/** Status presentation for warehouse entities (statuses come from the backend). */
export function statusTag(status: string) {
  const tone = toneForStatus(status);
  // Legacy tag classes map 1:1 to the new semantic tones.
  const cls = tone === 'ok' ? 'green'
    : tone === 'err' ? 'red'
    : tone === 'warn' ? 'yellow'
    : tone === 'info' || tone === 'teal' ? 'accent'
    : 'gray';
  return <span className={`tag ${cls}`}>{status}</span>;
}

/** Renders activate/deactivate/block controls gated by the passed permission. */
export function StatusActions({
  status,
  perm,
  onActivate,
  onDeactivate,
  onBlock,
  onUnblock,
  busy,
}: {
  status: string;
  perm: string;
  onActivate: () => void;
  onDeactivate: () => void;
  onBlock?: () => void;
  onUnblock?: () => void;
  busy?: boolean;
}) {
  const { hasPermission } = useAuth();
  const canActivate = hasPermission(perm.replace(/\.\w+$/, '.activate'));
  const canDeactivate = hasPermission(perm.replace(/\.\w+$/, '.deactivate'));
  return (
    <div style={{ display: 'inline-flex', gap: 6 }}>
      {status !== 'ACTIVE' && canActivate && (
        <button className="btn ghost" disabled={busy} onClick={onActivate}>Activate</button>
      )}
      {status === 'ACTIVE' && canDeactivate && (
        <button className="btn ghost" disabled={busy} onClick={onDeactivate}>Deactivate</button>
      )}
      {onBlock && status === 'ACTIVE' && canDeactivate && (
        <button className="btn ghost" disabled={busy} onClick={onBlock}>Block</button>
      )}
      {onUnblock && status === 'BLOCKED' && canActivate && (
        <button className="btn ghost" disabled={busy} onClick={onUnblock}>Unblock</button>
      )}
    </div>
  );
}
