/**
 * BATCH PERMISSIONS — on the EXISTING RBAC system (no separate mechanism).
 * The Permission rows are upserted by the seed (opt-in, idempotent); the
 * keys are consumed by @RequirePermissions once the routes land (Phase 3+).
 */
export const BATCH_PERMISSIONS = [
  'batch.view',
  'batch.create',
  'batch.execute',
  'batch.accept',
  'batch.send',
  'batch.receive',
  'batch.void',
] as const;

export type BatchPermission = (typeof BATCH_PERMISSIONS)[number];
