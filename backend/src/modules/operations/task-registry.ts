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
  /**
   * Station-department gate (STATION ↔ DEPARTMENT POLICY §22 mirror): when
   * present, the task only appears for workers bound to an ACTIVE station of
   * one of these departments. Server write paths enforce their own station
   * policy regardless; this only keeps the terminal picker honest.
   */
  stationDepartments?: string[];
  /**
   * True when the task NEEDS its station to exist at all (it cannot run from
   * an unassigned device). Temporary Storage is station-bound: without an
   * ACTIVE STAGING station the backend refuses every write.
   */
  stationRequired?: boolean;
  /** Admin/terminal display: the OPERATION this task belongs to (§ reference workflow). */
  operation?: string;
  /** Admin/terminal display: the WORK executed inside the operation. */
  work?: string;
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
    operation: 'Receiving',
    work: 'Verify SQ + products',
    stationDepartments: ['RECEIVING'],
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
    operation: 'Receiving',
    work: 'Verify cartons / totes',
    stationDepartments: ['RECEIVING'],
  },
  {
    key: 'temporary-storage',
    label: 'Temporary Storage',
    path: '/terminal/temporary-storage',
    department: 'STAGING',
    permission: 'receiving.execute',
    ready: true,
    operation: 'Temporary Storage',
    work: 'Répartition et rangement temporaire (Produit → Container)',
    // STAGING-station workers staff Temporary Storage (ST-STG-01). Receiving
    // workers with the same permission never see this task on their picker.
    stationDepartments: ['STAGING'],
    stationRequired: true,
  },
  {
    key: 'sorting',
    label: 'Sorting',
    path: '/terminal/sorting',
    department: 'SORTING',
    permission: 'stowing.execute',
    ready: true,
    operation: 'Sorting',
    work: 'Mise en zone de stockage (produit → emplacement)',
    stationDepartments: ['SORTING'],
  },
  {
    key: 'putaway',
    label: 'Putaway',
    path: '/terminal/putaway',
    department: 'PUTAWAY',
    permission: 'stowing.execute',
    ready: true,
    operation: 'Putaway',
    work: 'Rangement cartons (legacy inbound lane)',
    stationDepartments: ['PUTAWAY'],
  },
  {
    key: 'order-sorting',
    label: 'Order Sorting',
    path: '/terminal/order-sorting',
    department: 'SORTING',
    permission: 'picking.execute',
    ready: true,
    operation: 'Sorting',
    // Reference operation: TRI PAR CLIENT — the products stored by the
    // Temporary Storage agent are placed in their CUSTOMER container.
    work: 'Tri par client (Customer Container → Produits)',
    stationDepartments: ['SORTING'],
  },
  {
    key: 'packing',
    label: 'Packing',
    path: '/terminal/packing',
    department: 'PACKING',
    permission: 'packing.execute',
    ready: true,
    operation: 'Packing',
    work: 'Préparation de commande (Customer Container → Colis)',
    stationDepartments: ['PACKING'],
  },
  {
    key: 'shipping',
    label: 'Shipping',
    path: '/terminal/shipping',
    department: 'DISPATCH',
    permission: 'shipping.execute',
    ready: true,
    operation: 'Shipping',
    work: 'Contrôle et expédition (Colis → Expédition)',
    stationDepartments: ['DISPATCH'],
  },
  {
    // AYROVI BATCH (Phase 2): the worker BUILDS batches in the app (create
    // customer -> scan units -> print labels -> submit). NOT a station task:
    // no stationDepartments/stationRequired — every worker holding
    // batch.execute sees it, station-bound or not. The RECEIVING side of
    // batches must reuse DISPATCH (command rule) — decided in its own slice.
    key: 'batch',
    label: 'Batch',
    path: '/terminal/batch',
    department: 'RECEIVING',
    permission: 'batch.execute',
    ready: true,
    operation: 'Batch',
    work: 'بناء الدفعات (عميل جديد → وحدات AYP → ملصقات → إرسال)',
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
