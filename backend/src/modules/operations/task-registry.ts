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
  /**
   * SHARED QUEUE task: authorization is decided by PERMISSION alone, never by
   * who holds the WorkerTaskAssignment row.
   *
   * Receiving is staffed by several workers at one station simultaneously, so
   * treating the auto-dispatched assignment as an authorization gate limited
   * every arrival to a single account. For a shared task the assignment is
   * retained as OPTIONAL data (audit, workload balancing, routing hints) but
   * it must not gate visibility, opening, scanning, verification or approval.
   * Concurrency is handled per-unit at the write path instead.
   */
  shared?: boolean;
}

export const TASK_REGISTRY: OperationalTask[] = [
  {
    key: 'receiving',
    label: 'Receiving',
    path: '/terminal/receiving',
    department: 'RECEIVING',
    permission: 'receiving.execute',
    ready: true,
    shared: true,
  },
  {
    key: 'receiving-container',
    label: 'Receiving Tote',
    path: '/terminal/receiving',
    department: 'RECEIVING',
    permission: 'receiving.execute',
    ready: true,
    shared: true,
    subtaskOf: 'receiving',
  },
  {
    // ORDER 04 — standalone RAPPORT tile: the verification report is its own
    // task beside Receiving, never nested inside the Produit/Carton pages.
    // It shares receiving.execute so every receiving worker sees it, and it
    // is NOT a subtaskOf anything so routing never folds it into Receiving.
    key: 'receiving-report',
    label: 'Rapport',
    path: '/terminal/receiving/report',
    department: 'RECEIVING',
    permission: 'receiving.execute',
    ready: true,
    shared: true,
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

/**
 * True when a task is a shared, permission-gated queue: any worker holding
 * the task permission may execute it regardless of who the assignment names.
 */
export function isSharedTask(key: string): boolean {
  return taskByKey(key)?.shared === true;
}

/** Worker-facing sub-actions of the Receiving workflow (§6 of the order). */
export const RECEIVING_SUBACTIONS = [
  { key: 'receiving.cartons', label: 'VERIFY CARTONS' },
  { key: 'receiving.products', label: 'VERIFY PRODUCTS' },
] as const;
