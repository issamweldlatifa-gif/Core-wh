import { useAuth } from '../context/AuthContext';

/**
 * PROFILE = Identity (UX rule: "Profile = Identity", "Permissions = Access Control").
 *
 * This page is the single home for the details that used to be duplicated in
 * dashboard user cards: full name, employee code, roles, and the COMPLETE
 * effective-permission list. Nothing here is duplicated in the global header,
 * which shows only `name · primary role`.
 *
 * Read-only: permissions are still resolved on the back-end and managed via
 * Roles & Permissions (/roles). No auth/authz behaviour changed.
 */
export default function Profile() {
  const { me } = useAuth();
  if (!me) return null;

  return (
    <div className="profile">
      <h1 className="page-title">Profile</h1>
      <p className="page-sub">Identity &amp; effective access for the signed-in account.</p>

      <div className="grid2">
        <div className="card">
          <h3>Identity</h3>
          <dl className="profile-facts">
            <div>
              <dt>Name</dt>
              <dd><strong>{me.user.name}</strong></dd>
            </div>
            <div>
              <dt>Employee code</dt>
              <dd className="mono">{me.user.employeeCode}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd className="mono">{me.user.email ?? '—'}</dd>
            </div>
            <div>
              <dt>Account status</dt>
              <dd>
                <span className={`tag ${me.user.status === 'ACTIVE' ? 'accent' : ''}`}>
                  {me.user.status}
                </span>
              </dd>
            </div>
            <div>
              <dt>Role(s)</dt>
              <dd>
                {me.roles.map((r) => (
                  <span key={r} className="tag accent" style={{ marginRight: 6 }}>{r}</span>
                ))}
              </dd>
            </div>
            <div>
              <dt>Last login</dt>
              <dd className="mono">
                {me.user.lastLoginAt ? new Date(me.user.lastLoginAt).toLocaleString() : '—'}
              </dd>
            </div>
          </dl>
        </div>

        <div className="card">
          <h3>
            Effective permissions
            <span className="tag" style={{ marginLeft: 8 }}>{me.permissions.length}</span>
          </h3>
          <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>
            Resolved on the back-end from your role(s). Managed under Roles &amp; Permissions.
          </p>
          <div>
            {me.permissions.map((p) => (
              <span key={p} className="tag" style={{ margin: 2 }}>{p}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
