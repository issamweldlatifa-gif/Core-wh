import { useEffect, useState } from 'react';
import { apiErrorMessage } from '../../api/client';
import { api, Warehouse, StructureNode } from './api';

function TreeNode({ node, depth, prefix }: { node: StructureNode & { children?: StructureNode[] }; depth: number; prefix: string }) {
  const indent = '  '.repeat(depth);
  const sep = prefix ? `${prefix}/` : '';
  return (
    <>
      <div style={{ fontFamily: 'monospace', whiteSpace: 'pre' }}>{indent}├── {node.code} {node.status !== 'ACTIVE' ? `(${node.status})` : ''}</div>
      {(node.children ?? []).map((c) => <TreeNode key={c.id} node={c} depth={depth + 1} prefix={`${sep}${node.code}`} />)}
    </>
  );
}

/** Collapses the backend structure tree into a generic node shape for display. */
function toTree(zones: StructureNode[]): (StructureNode & { children: StructureNode[] })[] {
  return zones.map((z) => ({
    ...z,
    children: (z.aisles ?? []).map((a) => ({
      ...a,
      children: (a.racks ?? []).map((r) => ({
        ...r,
        children: (r.levels ?? []).map((l) => ({
          ...l,
          children: (l.locations ?? []).map((loc) => ({ ...loc })),
        })),
      })),
    })),
  }));
}

export default function StructureExplorer() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [whId, setWhId] = useState('');
  const [tree, setTree] = useState<StructureNode[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api.warehouses().then((w) => { setWarehouses(w); if (w[0]) setWhId(w[0].id); }); }, []);
  useEffect(() => { if (whId) api.warehouseStructure(whId).then(setTree).catch((e) => setErr(apiErrorMessage(e))); }, [whId]);

  return (
    <>
      <h1 className="page-title">Structure Explorer</h1>
      <p className="page-sub">Full physical hierarchy of the selected warehouse: Zone → Aisle → Rack → Level → Location.</p>
      <div className="card">
        <label>Warehouse</label>
        <select value={whId} onChange={(e) => setWhId(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select>
      </div>
      <div className="card">
        <h3>{warehouses.find((w) => w.id === whId)?.code ?? 'Warehouse'} structure</h3>
        {err && <div className="error-box">{err}</div>}
        {toTree(tree).map((z) => <TreeNode key={z.id} node={z} depth={0} prefix="" />)}
        {tree.length === 0 && !err && <p className="empty">No structure defined yet.</p>}
      </div>
    </>
  );
}
