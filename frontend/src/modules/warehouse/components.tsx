import { useAuth } from '../../context/AuthContext';

export function statusTag(status: string) {
  const cls = status === 'ACTIVE' ? 'green' : status === 'BLOCKED' ? 'red' : 'yellow';
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
