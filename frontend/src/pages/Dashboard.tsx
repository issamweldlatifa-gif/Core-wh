import { useAuth } from '../context/AuthContext';

export default function Dashboard() {
  const { me } = useAuth();
  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Welcome to AYROVI Warehouse Core.</p>

      <div className="grid2">
        <div className="card">
          <h3>Signed in as</h3>
          <p>
            <strong>{me?.user.name}</strong> ({me?.user.employeeCode})
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>
            {me?.roles.map((r) => <span key={r} className="tag accent" style={{ marginRight: 6 }}>{r}</span>)}
          </p>
        </div>
        <div className="card">
          <h3>Effective permissions</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>
            You currently hold <strong>{me?.permissions.length}</strong> granular
            permission(s) resolved on the back-end.
          </p>
          <div>
            {me?.permissions.map((p) => (
              <span key={p} className="tag" style={{ margin: 2 }}>{p}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Phase 0 status</h3>
        <p style={{ color: 'var(--text-dim)' }}>
          This is the <strong>AYROVI Warehouse Core Foundation</strong>. The system is
          authenticated, permission-aware, audit-ready, and modular. Operational
          warehouse workflows (receiving, picking, packing, shipping) are intentionally
          NOT enabled in this phase.
        </p>
      </div>
    </>
  );
}
