import { useEffect, useState } from 'react';
import { apiErrorMessage } from '../../api/client';
import { api, Warehouse, StructureNode } from './api';
import { toneForStatus } from '../../ui';
import { EmptyState, LoadingState } from '../../ui';

const LEVEL_LABEL = ['Zone', 'Aisle', 'Rack', 'Level', 'Location'];

function TreeNode({
  node,
  depth,
  prefix,
}: {
  node: StructureNode & { children?: StructureNode[] };
  depth: number;
  prefix: string;
}) {
  const sep = prefix ? `${prefix}/` : '';
  const path = `${sep}${node.code}`;
  const tone = toneForStatus(node.status);
  const toneCls = tone === 'ok' ? 'green' : tone === 'err' ? 'red' : tone === 'warn' ? 'yellow' : 'gray';
  return (
    <>
      <div className="tree-node" style={{ paddingLeft: 10 + depth * 22 }}>
        <span className="tree-sep">{depth === 0 ? '' : '└'}</span>
        <span className="tree-code">{node.code}</span>
        <span className="tree-name">{LEVEL_LABEL[depth] ?? ''}</span>
        {node.status !== 'ACTIVE' && <span className={`tag ${toneCls}`}>{node.status}</span>}
      </div>
      {(node.children ?? []).map((c) => (
        <TreeNode key={c.id} node={c} depth={depth + 1} prefix={path} />
      ))}
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
        <label htmlFor="structure-warehouse">Warehouse</label>
        <select id="structure-warehouse" value={whId} onChange={(e) => setWhId(e.target.value)}>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
        </select>
      </div>
      <div className="card">
        <h3>{warehouses.find((w) => w.id === whId)?.code ?? 'Warehouse'} structure</h3>
        {err && <div className="error-box">{err}</div>}
        {tree.length === 0 && !err && (
          <EmptyState
            icon="layers"
            title="No structure defined yet"
            hint="Create zones, aisles, racks, levels and locations to map the physical warehouse."
          />
        )}
        <div className="tree">
          {toTree(tree).map((z) => <TreeNode key={z.id} node={z} depth={0} prefix="" />)}
        </div>
      </div>
    </>
  );
}
