/**
 * StatusBadge — the ONE status presentation component.
 *
 * Status strings come from the backend and are NEVER invented or renamed
 * here; this component only maps their PRESENTATION to the semantic system
 * (neutral / info / success / warning / danger).
 */
import type { ReactNode } from 'react';

export type StatusTone = 'ok' | 'warn' | 'err' | 'info' | 'muted' | 'teal';

const TONE_BY_STATUS: Record<string, StatusTone> = {
  // arrivals / shipments
  EXPECTED: 'warn',
  ARRIVED: 'info',
  RECEIVING: 'info',
  RECEIVED: 'ok',
  STORED: 'ok',
  AWAITING_PUTAWAY: 'info',
  // sessions / tasks
  ACTIVE: 'ok',
  IN_PROGRESS: 'info',
  PAUSED: 'warn',
  PENDING: 'warn',
  COMPLETED: 'ok',
  DONE: 'ok',
  CANCELLED: 'muted',
  // entities / accounts / stations
  INACTIVE: 'muted',
  BLOCKED: 'err',
  ERROR: 'err',
  FAILED: 'err',
  REJECTED: 'err',
  REVERSED: 'warn',
  // scanner states
  SUCCESS: 'ok',
  SCANNING: 'teal',
};

export function toneForStatus(status: string): StatusTone {
  return TONE_BY_STATUS[status.toUpperCase()] ?? 'muted';
}

export function StatusBadge({
  children,
  status,
  tone,
}: {
  children?: ReactNode;
  /** Backend status string — presentation is derived from it. */
  status?: string;
  tone?: StatusTone;
}) {
  const t = tone ?? (status !== undefined ? toneForStatus(status) : 'muted');
  return <span className={`os-tag os-tag--${t}`}>{children ?? status}</span>;
}
