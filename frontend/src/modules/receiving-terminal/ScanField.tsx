import { useEffect, useMemo, useRef, useState } from 'react';
import CameraScanner, { type ScanFeedback } from './CameraScanner';
import { classifyKeyboardEntry, type ScanSource } from './scan-source';

/**
 * A single scanner input used across the terminal (terminal-emulator style).
 *
 * Reliability notes:
 *  - Keeps focus on the field after every submit and after window focus, but
 *    does NOT run an aggressive interval that steals focus mid-entry (that
 *    caused "scan instability"). Focus is only restored on submit/blur so a
 *    keyboard-wedge scanner burst is never interrupted.
 *  - Accepts QR / barcode / keyboard-wedge scanner input and manual entry.
 *    A fast burst (<=40ms/char) is classified as an EXTERNAL_SCANNER read.
 *  - Offers an always-available CAMERA tool (ZXing decode, cross-browser);
 *    shown whenever getUserMedia is present.
 */
export default function ScanField({
  label,
  placeholder,
  hint,
  disabled,
  cameraLabel,
  onSubmit,
  sourceLabel: sourceHint,
  cameraFeedback = null,
}: {
  label: string;
  placeholder: string;
  hint?: string;
  disabled?: boolean;
  cameraLabel?: string;
  onSubmit: (value: string, source: ScanSource) => void;
  sourceLabel?: string | null;
  /** Last backend outcome, surfaced inside the open camera overlay. */
  cameraFeedback?: ScanFeedback | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const stampsRef = useRef<number[]>([]);

  useEffect(() => {
    const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
    setShowCamera(supported);
  }, []);

  // Focus restore: on window focus and right after a submit. We deliberately
  // do not poll; a wedge scanner must not have its stream interrupted.
  useEffect(() => {
    if (disabled) return;
    const focus = () => setTimeout(() => { if (!cameraOpen) inputRef.current?.focus(); }, 40);
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [disabled, cameraOpen]);

  const submit = (source?: ScanSource) => {
    const v = value.trim();
    if (!v) return;
    const s = source ?? classifyKeyboardEntry(stampsRef.current, v).source;
    stampsRef.current = [];
    onSubmit(v, s);
    setValue('');
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (e.key.length === 1) {
      stampsRef.current.push(Date.now());
      if (stampsRef.current.length > 96) stampsRef.current.splice(0, stampsRef.current.length - 96);
    }
  };

  const sourceStyling = useMemo(() => {
    if (!sourceHint) return {};
    return { color: sourceHint === 'CAMERA' ? 'var(--t-cyan)' : sourceHint === 'EXTERNAL_SCANNER' ? 'var(--t-green)' : 'var(--t-dim)' };
  }, [sourceHint]);

  return (
    <div className="term-field">
      <div className="term-field-label">
        <span className="prompt">&gt; {label}</span>
        {sourceHint && <span className="term-source" style={sourceStyling}>[{sourceHint}]</span>}
      </div>
      <div className="term-field-row">
        <span className="term-caret">$</span>
        <input
          ref={inputRef}
          className="term-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="send"
        />
        {showCamera && (
          <button type="button" className="term-btn term-btn--cam" disabled={disabled} onClick={() => setCameraOpen(true)}>
            [ CAM ]
          </button>
        )}
        <button type="button" className="term-btn term-btn--action" disabled={disabled || !value.trim()} onClick={() => submit()}>
          [ENTER]
        </button>
      </div>
      {hint && <div className="term-hint">{hint}</div>}
      {cameraOpen && (
        <CameraScanner
          title={cameraLabel ?? 'SCAN LABEL'}
          onDetected={(v) => submitForCamera(v)}
          onClose={() => { setCameraOpen(false); inputRef.current?.focus(); }}
          feedback={cameraFeedback}
        />
      )}
    </div>
  );

  function submitForCamera(v: string) {
    // The camera overlay stays mounted (continuous scanning), so we must not
    // pull focus back to the hidden text input mid-session.
    stampsRef.current = [];
    onSubmit(v, 'CAMERA');
    setValue('');
  }
}
