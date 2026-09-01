import { useEffect, useMemo, useRef, useState } from 'react';
import CameraScanner from './CameraScanner';
import { classifyKeyboardEntry, type ScanSource } from './scan-source';

/**
 * A single scanner input used across the terminal.
 *
 * Behaviour:
 *  - Always keeps focus during active scanning (auto-refocus after submit and
 *    on blur, so the worker does not have to click the field for every scan).
 *  - Accepts QR / barcode / keyboard-wedge scanner input and manual entry.
 *  - Classifies a fast keyboard burst (<=40ms/char) as an EXTERNAL_SCANNER
 *    read and a slow entry as MANUAL, so the same field serves both.
 *  - Offers an optional in-browser CAMERA scanner (native BarcodeDetector).
 */
export default function ScanField({
  label,
  placeholder,
  hint,
  disabled,
  cameraLabel,
  onSubmit,
  sourceLabel: sourceHint,
}: {
  label: string;
  placeholder: string;
  hint?: string;
  disabled?: boolean;
  cameraLabel?: string;
  /** Called with the captured value and classified source. */
  onSubmit: (value: string, source: ScanSource) => void;
  /** Optional explicit caption of the source that produced the last submit. */
  sourceLabel?: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  // Timestamp of each printable key in the current burst (for wedge detection).
  const stampsRef = useRef<number[]>([]);

  useEffect(() => {
    const supported = typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia
      && 'BarcodeDetector' in window;
    setShowCamera(supported);
  }, []);

  // Refocus on window focus / click while enabled (scanner-first behaviour).
  useEffect(() => {
    if (disabled) return;
    const focus = () => setTimeout(() => inputRef.current?.focus(), 40);
    window.addEventListener('focus', focus);
    const iv = setInterval(() => {
      // keep focus unless the user is using the camera overlay.
      if (!cameraOpen && document.activeElement !== inputRef.current) inputRef.current?.focus();
    }, 3000);
    return () => {
      window.removeEventListener('focus', focus);
      clearInterval(iv);
    };
  }, [disabled, cameraOpen]);

  const submit = (source?: ScanSource) => {
    const v = value.trim();
    if (!v) return;
    const now = Date.now();
    const s = source ?? classifyKeyboardEntry(stampsRef.current, v).source;
    stampsRef.current = [];
    onSubmit(v, s);
    setValue('');
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    // Record printable-char timestamps only (exclude modifiers / Enter).
    if (e.key.length === 1) {
      stampsRef.current.push(Date.now());
      // Keep the burst within reason (guard against runaway).
      if (stampsRef.current.length > 64) stampsRef.current.splice(0, stampsRef.current.length - 64);
    }
  };

  const sourceStyling = useMemo(() => {
    if (!sourceHint) return {};
    return { borderColor: sourceHint === 'CAMERA' ? 'var(--accent-2)' : sourceHint === 'EXTERNAL_SCANNER' ? 'var(--success)' : 'var(--border)' };
  }, [sourceHint]);

  return (
    <div className="scanfield">
      <div className="scanfield-label">
        <span className="scanfield-label-text">{label}</span>
        {sourceHint && <span className="scanfield-source">{sourceHint}</span>}
      </div>
      <div className="scanfield-row" style={sourceStyling}>
        <input
          ref={inputRef}
          className="scanfield-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
        />
        {showCamera && (
          <button
            type="button"
            className="rcv-btn rcv-btn--cam"
            disabled={disabled}
            onClick={() => setCameraOpen(true)}
          >
            <span className="rcv-badge--light">CAM</span>
          </button>
        )}
        <button
          type="button"
          className="rcv-btn rcv-btn--submit"
          disabled={disabled || !value.trim()}
          onClick={() => submit()}
        >
          ⌁ Enter
        </button>
      </div>
      {hint && <div className="scanfield-hint">{hint}</div>}

      {cameraOpen && (
        <CameraScanner
          title={cameraLabel ?? 'Scan label'}
          onDetected={(v) => {
            setCameraOpen(false);
            submitForCamera(v);
          }}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </div>
  );

  function submitForCamera(v: string) {
    stampsRef.current = [];
    onSubmit(v, 'CAMERA');
    setValue('');
    inputRef.current?.focus();
  }
}
