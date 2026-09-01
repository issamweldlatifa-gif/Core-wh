/**
 * Shared state components — EmptyState / ErrorState / LoadingState.
 *
 * One pattern for every screen so "loading…", "nothing here" and failures
 * never look like three different products. ErrorState distinguishes the
 * four failure registers: info, warning, operational rejection, system error.
 */
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function LoadingState({ label = 'Loading…', block = false }: { label?: string; block?: boolean }) {
  return (
    <div className={`os-empty${block ? ' os-state-block' : ''}`} role="status" aria-live="polite">
      <span className="os-spinner" style={{ marginRight: 10, verticalAlign: '-3px' }} />
      {label}
    </div>
  );
}

export function EmptyState({
  icon = 'inbox',
  title,
  hint,
  action,
}: {
  icon?: IconName;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="os-state os-state--empty">
      <span className="os-state-icon"><Icon name={icon} size={26} /></span>
      <div className="os-state-title">{title}</div>
      {hint && <div className="os-state-hint">{hint}</div>}
      {action && <div className="os-state-action">{action}</div>}
    </div>
  );
}

export type ErrorKind = 'info' | 'warning' | 'rejection' | 'system';

/** Maps an error register to icon + tone. Never hides rejection detail. */
const ERROR_STYLE: Record<ErrorKind, { icon: IconName; cls: string }> = {
  info: { icon: 'info', cls: 'os-state--info' },
  warning: { icon: 'alert', cls: 'os-state--warning' },
  rejection: { icon: 'x', cls: 'os-state--rejection' },
  system: { icon: 'alert', cls: 'os-state--system' },
};

export function ErrorState({
  kind = 'system',
  title,
  detail,
  action,
}: {
  kind?: ErrorKind;
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  const s = ERROR_STYLE[kind];
  return (
    <div className={`os-state ${s.cls}`} role="alert">
      <span className="os-state-icon"><Icon name={s.icon} size={26} /></span>
      <div className="os-state-title">{title}</div>
      {detail && <div className="os-state-hint">{detail}</div>}
      {action && <div className="os-state-action">{action}</div>}
    </div>
  );
}
