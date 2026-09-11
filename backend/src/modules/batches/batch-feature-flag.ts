/**
 * BATCH FEATURE FLAG — `batch.enabled` in SystemSetting. OFF by default:
 * an absent key is OFF. While OFF, Batch routes/features must refuse (the
 * legacy flows keep working untouched). Pure helpers only.
 */
export const BATCH_FEATURE_FLAG = 'batch.enabled';

/** True only for an explicit true/"true"/true-string payload. */
export function flagEnabled(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  if (typeof raw === 'object' && raw !== null) {
    const v = (raw as { value?: unknown }).value;
    return flagEnabled(v);
  }
  return false;
}

/** Resolve the flag from SystemSetting-shaped rows (key/value pairs). */
export function isBatchEnabled(rows: Array<{ key: string; value: unknown }>): boolean {
  const row = rows.find((r) => r.key === BATCH_FEATURE_FLAG);
  return row ? flagEnabled(row.value) : false;
}
