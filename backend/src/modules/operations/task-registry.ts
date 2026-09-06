/**
 * The operational task catalog (single source of truth for task KEYS).
 *
 * This is the *implementation registry* of worker terminals: it maps a task
 * key -> label, terminal route, station department and the backend
 * permission that unlocks it. It is NOT a second task system: workflow
 * state lives in the workflow services (Receiving/Putaway/Fulfillment) and
 * assignments live in WorkerTaskAssignment (linked to real entities).
 *
 * `subtaskOf` marks worker-visible actions that belong to a parent workflow
 * (VERIFY CARTONS / VERIFY PRODUCTS / tote filling all execute the SAME
 * authoritative Receiving workflow). Routing must de-duplicate by PATH so
 * sub-tasks never change where a worker lands.
 */
export interface OperationalTask {
  key: string;
  label: string;
  path: string;
  department: string;
  /** Backend permission that unlocks this task — mirrored for UX only. */
  permission: string;
  /** False when the task exists in the framework but has no workflow yet. */
  ready: boolean;
  /** Parent task key when this is a worker-visible sub-action of one workflow. */
  subtaskOf?: string;
}

export const TASK_REGISTRY: OperationalTask[] = [
  {
    key: 'receiving',
    label: 'Receiving',
    path: '/terminal/receiving',
    department: 'RECEIVING',
    permission: 'receiving.execute',
    ready: true,
  },
  {
    key: 'receiving-container',
    label: 'Receiving Tote',
    path: '/terminal/receiving',
    department: 'RECEIVING',
    permission: 'receiving.execute',
    ready: true,
    subtaskOf: 'receiving',
  },
  {
    key: 'sorting',
    label: 'Sorting',
    path: '/terminal/sorting',
    department: 'SORTING',
    permission: 'stowing.execute',
    ready: true,
  },
  {
    key: 'putaway',
    label: 'Putaway',
    path: '/terminal/putaway',
    department: 'PUTAWAY',
    permission: 'stowing.execute',
    ready: true,
  },
  {
    key: 'order-sorting',
    label: 'Order Sorting',
    path: '/terminal/order-sorting',
    department: 'SORTING',
    permission: 'picking.execute',
    ready: true,
  },
  {
    key: 'packing',
    label: 'Packing',
    path: '/terminal/packing',
    department: 'PACKING',
    permission: 'packing.execute',
    ready: true,
  },
  {
    key: 'shipping',
    label: 'Shipping',
    path: '/terminal/shipping',
    department: 'DISPATCH',
    permission: 'shipping.execute',
    ready: true,
  },
];

export function taskByKey(key: string): OperationalTask | undefined {
  return TASK_REGISTRY.find((t) => t.key === key);
}

/** Worker-facing sub-actions of the Receiving workflow (§6 of the order). */
export const RECEIVING_SUBACTIONS = [
  { key: 'receiving.cartons', label: 'VERIFY CARTONS' },
  { key: 'receiving.products', label: 'VERIFY PRODUCTS' },
] as const;
