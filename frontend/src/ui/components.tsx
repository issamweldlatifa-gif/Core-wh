/**
 * Shared foundation components: Button, Card, PageHeader, Dialog, Kpi.
 *
 * These wrap the design-system classes so pages stop hand-rolling buttons,
 * headers and modals. Same classes as the CSS system — the component is the
 * recommended entry point for new screens.
 */
import {
  ButtonHTMLAttributes,
  ReactNode,
  useEffect,
  useRef,
} from 'react';
import { Icon, type IconName } from './Icon';

/* ---- Button -------------------------------------------------------------- */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'info';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: IconName;
  block?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'os-btn os-btn--primary',
  secondary: 'os-btn',
  ghost: 'os-btn os-btn--ghost',
  danger: 'os-btn os-btn--danger',
  success: 'os-btn os-btn--success',
  info: 'os-btn os-btn--info',
};

export function Button({ variant = 'secondary', icon, block, children, className = '', ...rest }: ButtonProps) {
  return (
    <button type="button" className={`${VARIANT_CLASS[variant]}${block ? ' os-btn--block' : ''} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  );
}

/* ---- Card ----------------------------------------------------------------- */
export function Card({
  title,
  actions,
  elevated,
  children,
  style,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  elevated?: boolean;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section className={`os-card${elevated ? ' os-card--elevated' : ''}`} style={style}>
      {(title || actions) && (
        <div className="os-spread" style={{ marginBottom: 12 }}>
          {title !== undefined && <h2 className="os-card-title" style={{ marginBottom: 0 }}>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/* ---- PageHeader ------------------------------------------------------------- */
export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="ac-head os-spread">
      <div>
        <h1 className="ac-title">{title}</h1>
        {sub && <p className="ac-sub">{sub}</p>}
      </div>
      {actions && <div className="os-row">{actions}</div>}
    </header>
  );
}

/* ---- Dialog ----------------------------------------------------------------- */
/**
 * Shared dialog foundation: overlay, surface, title, body, actions, close
 * button, Escape/overlay dismiss and basic focus containment.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
  danger,
  width,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  danger?: boolean;
  width?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog so keyboard users are not left behind.
    boxRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="ac-modal"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        className="ac-modal-box"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        style={{ width: width ? `min(${width}px, 100%)` : undefined, borderColor: danger ? 'var(--error)' : undefined, outline: 'none' }}
      >
        <div className="os-spread">
          <h3 className="ac-modal-title" style={{ color: danger ? 'var(--error-text)' : undefined }}>{title}</h3>
          <button type="button" className="os-btn os-btn--ghost" aria-label="Close dialog" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {children}
        {actions && <div className="ac-modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

/* ---- Kpi ---------------------------------------------------------------------- */
export function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'ok' | 'bad' | 'alert';
}) {
  return (
    <div className={`ac-kpi${tone ? ` ac-kpi--${tone}` : ''}`}>
      <div className="ac-kpi-value">{value}</div>
      <div className="ac-kpi-label">{label}</div>
    </div>
  );
}
