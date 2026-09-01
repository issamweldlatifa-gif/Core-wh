import { useMemo } from 'react';
import { useAuth } from '../context/AuthContext';

/**
 * PROFILE = IDENTITY, PERMISSIONS = ACCESS CONTROL (§ UX rules).
 *
 * The full identity block and the effective-permissions dump that used to
 * live on the Dashboard live HERE now. Nothing was deleted — access was
 * moved to its correct place (account menu -> Profile & Permissions).
 * Data comes straight from /auth/me; no new backend surface is required.
 */
export default function Profile() {
  const { me } = useAuth();

  const grouped = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of me?.permissions ?? []) {
      const [resource] = p.split('.');
      if (!map.has(resource)) map.set(resource, []);
      map.get(resource)!.push(p);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [me]);

  return (
    <>
      <h1 className="page-title">Profile &amp; Permissions</h1>
      <p className="page-sub">Identity and effective access resolved from the back-end.</p>

      <div className="grid2">
        <div className="card">
          <h3>Identity</h3>
          <p><strong>{me?.user.name}</strong></p>
          <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>
            Employee code: {me?.user.employeeCode}
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>
            {me?.user.email ?? '—'}
          </p>
          <div style={{ marginTop: 8 }}>
            {me?.roles.map((r) => (
              <span key={r} className="tag accent" style={{ marginRight: 6 }}>{r}</span>
            ))}
          </div>
        </div>
        <div className="card">
          <h3>Effective permissions</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>
            <strong>{me?.permissions.length}</strong> granular permission(s), grouped by resource.
          </p>
          {grouped.map(([resource, perms]) => (
            <div key={resource} style={{ margin: '10px 0 6px' }}>
              <div className="field-label">{resource}</div>
              {perms.map((p) => (
                <span key={p} className="tag" style={{ margin: 2 }}>{p}</span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
