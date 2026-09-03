/**
 * Receiving terminal — DUAL SCANNER host (dual-scanner order).
 *
 * One scanner entry for the Receiving station that presents the correct scan
 * method per device (§1/§15):
 *   Desktop        → Hardware Scan PRIMARY (no webcam, no permission)
 *   Smartphone     → Software Scan PRIMARY
 *   Tablet         → both, Software first
 *
 * Both methods deliver values through the SAME props the station already uses
 * (`onDetected(value, source)` → one receiving submit pipeline). This host
 * adds NO business logic of its own. Non-Receiving stations keep using
 * `ContinuousScanner` (software) directly — untouched by this order.
 */

import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ScanOutcome } from './ContinuousScanner';
import type { ScanSource } from './scan-source';
import { detectCapabilities } from './scan-source';
import { chooseScanMethods, type ScanMethod } from './scan-method';
import { deviceClassOf } from './scan-method';
import { beepInfo } from './feedback';
import HardwareScannerPanel from './HardwareScannerPanel';

const SoftwareScanner = lazy(() => import('./ContinuousScanner'));

export interface ReceivingScannerProps {
  title: string;
  hint?: string;
  enableOcr?: boolean;
  outcome?: ScanOutcome | null;
  mode?: 'CARTON' | 'PRODUCT';
  onModeChange?: (m: 'CARTON' | 'PRODUCT') => void;
  onDetected: (value: string, source: ScanSource) => void;
  onClose: () => void;
  corpus?: string[];
  demoMode?: boolean;
  demoCodes?: string[];
}

const METHOD_KEY = 'ayrovi.scanMethod';

function storedMethod(available: ScanMethod[], fallback: ScanMethod): ScanMethod {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const v = localStorage.getItem(METHOD_KEY) as ScanMethod | null;
    if (v && (v === 'software' || v === 'hardware') && available.includes(v)) return v;
  } catch { /* ignore */ }
  return fallback;
}

export default function ReceivingScanner(props: ReceivingScannerProps) {
  const caps = useMemo(() => detectCapabilities(), []);
  const choice = useMemo(() => chooseScanMethods(caps), [caps]);
  const cls = deviceClassOf(caps);
  const [method, setMethod] = useState<ScanMethod>(() => storedMethod(choice.available, choice.default));

  // Keep selection in sync when capabilities change (e.g. permission state).
  useEffect(() => {
    if (!choice.available.includes(method)) setMethod(choice.default);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice.default]);

  const pick = (m: ScanMethod) => {
    if (choice.available.includes(m) && m !== method) {
      setMethod(m);
      try { localStorage.setItem(METHOD_KEY, m); } catch { /* ignore */ }
      beepInfo();
    }
  };

  const many = choice.available.length > 1;

  const switchToSoftware = () => pick('software');

  // Method tabs live inside each panel's header (no overlay / no collision).
  const methodTabs = many ? (
    <div className="cs-modes" role="tablist" aria-label="Scanner method" title={`${cls} — ${method === 'software' ? 'camera' : 'external device'}`}>
      {choice.ordered.map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={method === m}
          className={`cs-mode${method === m ? ' is-active' : ''}`}
          onClick={() => pick(m)}
        >
          {m === 'software' ? 'SOFTWARE' : 'HARDWARE'}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <Suspense fallback={<div className="cs-loading-fallback">STARTING SCANNER…</div>}>
      {method === 'hardware' ? (
        <HardwareScannerPanel
          title={props.title}
          outcome={props.outcome}
          onDetected={props.onDetected}
          onClose={props.onClose}
          canSwitchToSoftware={cls !== 'DESKTOP'}
          onSwitchToSoftware={switchToSoftware}
          methodTabs={methodTabs}
        />
      ) : (
        <SoftwareScanner
          title={props.title}
          hint={props.hint}
          enableOcr={props.enableOcr}
          outcome={props.outcome}
          mode={props.mode}
          onModeChange={props.onModeChange}
          onDetected={props.onDetected}
          onClose={props.onClose}
          corpus={props.corpus}
          demoMode={props.demoMode}
          demoCodes={props.demoCodes}
          headerExtra={methodTabs}
        />
      )}
    </Suspense>
  );
}
