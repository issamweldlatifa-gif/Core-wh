import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarcodeFormat,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import type { ScanSource } from './scan-source';
import { detectCapabilities, type DeviceCapabilities } from './scan-source';
import { canvasFromGray, computeRoi, roiOverlayStyle } from './roi';
import {
  DEFAULT_SCAN_CONFIG,
  mergeConfig,
  type DeepPartial,
  type RoiRatio,
  type ScanConfig,
} from './scan-config';
import { assessQuality, quickGuidance, type GuidanceId } from './image-quality';
import { applyProfile, selectProfile, type ProfileId } from './preprocess';
import { extractFieldTokens, formatScoreForToken, type FieldToken } from './fields';
import { normaliseToken } from './normalize';
import { matchAgainstCorpus, type CorpusMatch } from './validate';
import { computeConfidence, type ConfidenceResult, type DetectionType } from './confidence';
import { createConsensus, type ConsensusAggregator } from './multiframe';
import { createTelemetry, exposeDebugHandle, type ScanAttempt, type TelemetrySink } from './telemetry';
import { ocrBusy, recogniseRoi, terminateOcr } from './ocr-client';
import { isBusy, next, stateLabel, type ScannerEvent, type ScannerState } from './scanner-state';
import './scanner.css';

/**
 * Continuous Receiving Scanner — guided scan + OCR (P0).
 *
 * The single decode loop runs the order's full pipeline:
 *
 *   Camera Frame → Scan Region / ROI → Image Quality Check → Preprocessing →
 *   Barcode/QR detection → (fallback) OCR → Normalization → Validation vs
 *   AYROVI corpus → Confidence → Result
 *
 * Rules enforced here:
 *   - Camera opens once and stays open across cartons.
 *   - Barcode/QR first and always wins; a VALID barcode stops OCR (§12).
 *   - The Image Quality gate runs before OCR; a bad frame never reaches
 *     Tesseract (§6). Worker gets «Hold steady / Improve lighting / …».
 *   - OCR is validated against the session corpus: EXACT→HIGH may
 *     auto-confirm; CANDIDATE / no-corpus→MEDIUM requires worker
 *     confirmation («Possible match: …»); LOW only retries (§10/§11).
 *   - Multi-frame consensus: a token must be seen across frames (§13).
 *   - Duplicate physical codes are suppressed in a debounce window (§15).
 *   - Telemetry records every meaningful attempt (§16); no images kept.
 *   - The backend verdict (outcome) is the ONLY path to SUCCESS (§25).
 *
 * Consumer contract unchanged: onDetected(value, source). Receiving passes
 * the session corpus; terminals that pass none degrade safely — with no
 * corpus an OCR read can never silently auto-submit.
 */

const ZXING_FORMATS: BarcodeFormat[] = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.CODABAR,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.ITF,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
];
const NATIVE_FORMATS = [
  'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'code_93',
  'code_128', 'itf', 'codabar', 'qr_code', 'data_matrix',
];

export interface ScanOutcome {
  kind: 'ok' | 'bad' | 'info';
  text: string;
  token: number;
}

/** Guidance phases shown to the worker (order §3). */
export type GuidePhase =
  | 'SEARCHING'
  | 'BARCODE_DETECTED'
  | 'OCR_DETECTED'
  | 'LOW_CONFIDENCE'
  | 'CONFIRM_NEEDED'
  | 'CONFIRMED';

export interface PendingConfirm {
  /** the code that would be submitted (canonical corpus value when candidate) */
  value: string;
  /** the value exactly as OCR read it */
  readValue: string;
  match: CorpusMatch;
  confidence: ConfidenceResult;
  detectedAt: number;
}

interface Props {
  title: string;
  hint?: string;
  /** Station capability gate: OCR only when the station offers it. */
  enableOcr?: boolean;
  /** Result of the last submission, owned by the parent (backend truth). */
  outcome?: ScanOutcome | null;
  /** What the scanner is submitting: cartons or product units. */
  mode?: 'CARTON' | 'PRODUCT';
  onModeChange?: (m: 'CARTON' | 'PRODUCT') => void;
  onDetected: (value: string, source: ScanSource) => void;
  onClose: () => void;
  /** Known AYROVI codes to validate OCR against (order §10). */
  corpus?: string[];
  /** Per-instance config overrides (threshold tuning / benchmarks). */
  scanConfig?: DeepPartial<ScanConfig>;
}

export default function ContinuousScanner({
  title,
  hint,
  enableOcr = true,
  outcome = null,
  mode,
  onModeChange,
  onDetected,
  onClose,
  corpus,
  scanConfig,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const teardownRef = useRef<() => void>(() => {});

  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const facingRef = useRef<'environment' | 'user'>('environment');

  const [state, setState] = useState<ScannerState>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const [detector, setDetector] = useState<'native' | 'zxing' | null>(null);
  const [ocrActive, setOcrActive] = useState(false);
  const [torch, setTorch] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [scanCount, setScanCount] = useState(0);
  const [fps, setFps] = useState(0);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [guide, setGuide] = useState<{ phase: GuidePhase; advice: string[] }>({ phase: 'SEARCHING', advice: [] });

  const stateRef = useRef<ScannerState>('IDLE');
  const cfgRef = useRef<ScanConfig>(DEFAULT_SCAN_CONFIG);
  const corpusRef = useRef<string[]>([]);
  const pendingRef = useRef<PendingConfirm | null>(null);
  const telemetryRef = useRef<TelemetrySink | null>(null);
  const capsRef = useRef<DeviceCapabilities | null>(null);
  const modeRef = useRef<'CARTON' | 'PRODUCT'>('CARTON');
  modeRef.current = mode ?? 'CARTON';

  // Live guide mirror — the loop writes here without a re-render per frame.
  const guideRef = useRef<{ phase: GuidePhase; advice: string[] }>({ phase: 'SEARCHING', advice: [] });
  const setGuideSafe = useCallback((g: { phase: GuidePhase; advice?: string[] }) => {
    const prev = guideRef.current;
    const advice = g.advice ?? prev.advice;
    if (g.phase === prev.phase && advice === prev.advice) return;
    guideRef.current = { phase: g.phase, advice };
    setGuide({ phase: g.phase, advice });
  }, []);

  const setPendingSafe = useCallback((p: PendingConfirm | null) => {
    pendingRef.current = p;
    setPending(p);
  }, []);

  const send = useCallback((event: ScannerEvent): ScannerState | null => {
    const target = next(stateRef.current, event);
    if (!target) return null;
    stateRef.current = target;
    setState(target);
    return target;
  }, []);

  // Effective config & corpus (kept fresh for the loop).
  useEffect(() => {
    cfgRef.current = mergeConfig(DEFAULT_SCAN_CONFIG, scanConfig ?? {});
    modeRef.current = mode ?? 'CARTON';
  }, [scanConfig, mode]);
  useEffect(() => {
    corpusRef.current = (corpus ?? []).map((c) => (c || '').trim().toUpperCase()).filter(Boolean);
  }, [corpus]);

  /** Backend verdict → SUBMITTING → SUCCESS/ERROR, then back to scanning. */
  useEffect(() => {
    if (!outcome) return;
    if (outcome.kind === 'ok') {
      send('ACCEPTED');
      setGuideSafe({ phase: 'CONFIRMED' });
      telemetryRef.current?.markBackendVerdict(true);
    } else if (outcome.kind === 'bad') {
      send('REJECTED');
      setGuideSafe({ phase: 'SEARCHING' });
      telemetryRef.current?.markBackendVerdict(false);
    }
    const t = window.setTimeout(() => send('RESUME'), cfgRef.current.duplicate.resumeDelayMs);
    return () => window.clearTimeout(t);
  }, [outcome, send, setGuideSafe]);

  // -------------------------------------------------------------------------
  // the decode loop
  // -------------------------------------------------------------------------
  const start = useCallback(() => {
    teardownRef.current();
    setError(null);
    setTorch(false);
    setHasTorch(false);
    stateRef.current = 'IDLE';
    setState('IDLE');
    setPendingSafe(null);
    guideRef.current = { phase: 'SEARCHING', advice: [] };
    setGuide({ phase: 'SEARCHING', advice: [] });
    send('OPEN');

    const el = videoRef.current;
    if (!el) return;

    let running = true;
    let raf = 0;
    let timer = 0;
    let stream: MediaStream | null = null;
    let nativeDetector: any = null;
    let frame = 0;
    let framesSinceBarcode = 0;
    let lastValue = '';
    let lastAt = 0;
    let fpsFrames = 0;
    let fpsSince = performance.now();

    const full = document.createElement('canvas');
    const fullCtx = full.getContext('2d', { willReadFrequently: true });
    const roiCanvas = document.createElement('canvas');
    const roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });

    const zxing = new MultiFormatReader();
    const hints = new Map();
    hints.set(DecodeHintType.TRY_HARDER, true);
    hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS);
    zxing.setHints(hints);

    const consensus: ConsensusAggregator = createConsensus(cfgRef.current.consensus);
    const telemetry: TelemetrySink = createTelemetry(cfgRef.current.telemetry.maxAttempts);
    telemetryRef.current = telemetry;
    exposeDebugHandle(telemetry);

    const teardown = () => {
      running = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      if (el) el.srcObject = null;
      consensus.reset();
      telemetryRef.current = null;
      void terminateOcr();
    };
    teardownRef.current = teardown;

    const roiRatioNow = (): RoiRatio =>
      cfgRef.current.camera.roi[modeRef.current === 'PRODUCT' ? 'PRODUCT' : 'CARTON'];

    /** Record one attempt (startedAt → now) with sensible defaults. */
    const record = (
      detection: DetectionType,
      startedAt: number,
      patch: Partial<Omit<ScanAttempt, 'ts' | 'scanSessionId'>>,
    ) => {
      const processingMs = Math.max(0, performance.now() - startedAt);
      void telemetry.record({
        ts: Date.now(),
        mode: modeRef.current,
        scannerType: detection === 'OCR' ? 'tesseract' : nativeDetector ? 'native' : 'zxing',
        detectionType: detection,
        processingMs,
        validationResult: 'na',
        finalResult: 'no_candidate',
        deviceType: capsRef.current?.deviceType ?? 'UNKNOWN',
        ...patch,
      } as ScanAttempt);
    };

    /** Hand a value to the parent exactly once per physical code (§15). */
    const submit = (
      value: string,
      source: ScanSource,
      detection: DetectionType,
      startedAt?: number,
      extra?: Partial<Omit<ScanAttempt, 'ts' | 'scanSessionId'>>,
    ): boolean => {
      const now = Date.now();
      if (value === lastValue && now - lastAt < cfgRef.current.duplicate.repeatWindowMs) {
        lastAt = now;
        return false;
      }
      lastValue = value;
      lastAt = now;
      setLastCode(value);
      setScanCount((n) => n + 1);
      consensus.reset();

      send('CANDIDATE');
      send('VALIDATE');
      send('SUBMIT');
      onDetectedRef.current(value, source);
      if (startedAt) {
        record(detection, startedAt, {
          finalResult: 'auto_submitted',
          ...extra,
        });
      }
      return true;
    };

    // ------------------------------------------------------------------
    // decode helpers
    // ------------------------------------------------------------------
    async function readBarcode(vw: number, vh: number): Promise<string | null> {
      if (!fullCtx || !roiCtx) return null;
      const roi = computeRoi(vw, vh, roiRatioNow());
      if (nativeDetector) {
        try {
          const res = await nativeDetector.detect(roiCanvas);
          if (res?.length && res[0]?.rawValue) return String(res[0].rawValue).trim();
        } catch { /* fall through */ }
        return null;
      }
      try {
        const img = roiCtx.getImageData(0, 0, roi.width, roi.height);
        const lum = new Uint8ClampedArray(roi.width * roi.height);
        for (let i = 0; i < lum.length; i += 1) {
          const p = i * 4;
          lum[i] = (img.data[p] * 0.299 + img.data[p + 1] * 0.587 + img.data[p + 2] * 0.114) | 0;
        }
        const src = new RGBLuminanceSource(lum, roi.width, roi.height);
        const r = zxing.decode(new HybridBinarizer(src) as any);
        return r?.getText?.().trim() || null;
      } catch {
        return null;
      }
    }

    /** One OCR attempt: quality gate → profile → OCR → fields → consensus →
     *  corpus validation → confidence → submit / confirm / drop. */
    async function runOcr(vw: number, vh: number): Promise<boolean> {
      if (!roiCtx) return false;
      const c = cfgRef.current;
      const roi = computeRoi(vw, vh, roiRatioNow());
      const started = performance.now();

      // Image quality gate first (§6): refuse OCR on a bad frame.
      const { img, gray } = readRoiGray();
      const q = assessQuality(gray, roi.width, roi.height);
      setOcrActive(true);
      try {
        if (c.ocr.qualityGateEnabled && !q.pass) {
          setGuideSafe({ phase: 'LOW_CONFIDENCE', advice: q.advice });
          record('OCR', started, {
            finalResult: 'quality_gate_blocked',
            failureReason: q.reasons.join(','),
            imageQuality: q.score,
          });
          return true;
        }

        // Preprocessing profile selected from the measured quality (§7).
        const profile: ProfileId = selectProfile(q);
        const prepped = applyProfile(img, profile, {
          smallTextUpscale: c.ocr.smallTextUpscale,
          maxWidth: c.ocr.ocrMaxWidth,
        });
        const ocrCanvas = canvasFromGray(prepped.gray, prepped.width, prepped.height);

        const res = await recogniseRoi(ocrCanvas, { psm: profile === 'C_SMALL_TEXT' ? '7' : '6' });
        const conf01 = res ? Math.max(0, Math.min(1, res.confidence / 100)) : 0;
        if (!res || !res.text) {
          setGuideSafe({ phase: 'OCR_DETECTED' });
          record('OCR', started, {
            ocrConfidence: conf01,
            imageQuality: q.score,
            finalResult: 'no_candidate',
            failureReason: res ? 'empty_ocr' : 'ocr_error',
          });
          return true;
        }

        // Field-aware extraction (§8), then weighted multi-frame votes (§13).
        const tokens: FieldToken[] = extractFieldTokens(res.text);
        const weight = Math.max(0.3, Math.min(1, q.score));
        const stableTokens: string[] = tokens.length
          ? consensus.pushFrame(tokens.map((t) => ({ token: t.token, weight })))
          : [];

        if (stableTokens.length === 0) {
          setGuideSafe({ phase: 'OCR_DETECTED' });
          record('OCR', started, {
            ocrConfidence: conf01,
            imageQuality: q.score,
            finalResult: 'no_candidate',
            failureReason: tokens.length === 0 ? 'no_fields' : 'awaiting_consensus',
          });
          return true;
        }

        // Rank stable tokens by composite confidence; corpus-exact first.
        const ranked = rankStable(stableTokens, conf01, q.score);
        const best = ranked[0];
        if (!best) {
          record('OCR', started, {
            ocrConfidence: conf01,
            imageQuality: q.score,
            finalResult: 'no_candidate',
            failureReason: 'unrankable',
          });
          return true;
        }
        const { value, readValue, match, confidence } = best;

        if (confidence.level === 'HIGH') {
          // EXACT + strong engine/quality → auto-confirm (§11).
          setGuideSafe({ phase: 'CONFIRMED' });
          submit(value, 'CAMERA', 'OCR', started, {
            ocrConfidence: conf01,
            imageQuality: q.score,
            validationResult: match.kind,
            frames: cfgRef.current.consensus.votesRequired,
          });
          return true;
        }
        if (confidence.level === 'MEDIUM') {
          // Worker confirmation required — hold scanning and ask (§10/§11).
          record('OCR', started, {
            ocrConfidence: conf01,
            imageQuality: q.score,
            validationResult: match.kind,
            finalResult: 'worker_confirmed',
            frames: cfgRef.current.consensus.votesRequired,
          });
          send('CANDIDATE');
          send('VALIDATE');
          setGuideSafe({ phase: 'CONFIRM_NEEDED' });
          setPendingSafe({ value, readValue, match, confidence, detectedAt: Date.now() });
          return true;
        }
        // LOW → retry scan with guidance; never submit.
        record('OCR', started, {
          ocrConfidence: conf01,
          imageQuality: q.score,
          validationResult: match.kind,
          finalResult: 'dropped_low_confidence',
          failureReason: match.kind === 'none' ? 'no_corpus_match' : 'low_composite',
          frames: cfgRef.current.consensus.votesRequired,
        });
        setGuideSafe({
          phase: 'LOW_CONFIDENCE',
          advice: match.kind === 'none'
            ? ['No matching Article found — rescan or use manual entry']
            : (q.advice.length ? q.advice : undefined),
        });
        return true;
      } finally {
        setOcrActive(false);
        if (stateRef.current === 'OCR_PROCESSING') send('RESUME');
      }

      function readRoiGray(): { img: { data: Uint8ClampedArray; width: number; height: number }; gray: Uint8ClampedArray } {
        const imageData = roiCtx!.getImageData(0, 0, roi.width, roi.height);
        const gray = new Uint8ClampedArray(roi.width * roi.height);
        const d = imageData.data;
        for (let i = 0, p = 0; i < d.length; i += 4, p += 1) {
          gray[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
        }
        return { img: { data: imageData.data, width: roi.width, height: roi.height }, gray };
      }
    }

    /** Composite score for stable tokens → pick the best submission. */
    function rankStable(
      stableTokens: string[],
      ocrConf01: number,
      qScore: number,
    ): Array<{ value: string; readValue: string; match: CorpusMatch; confidence: ConfidenceResult }> {
      const known = corpusRef.current;
      const c = cfgRef.current;
      const results: Array<{ value: string; readValue: string; match: CorpusMatch; confidence: ConfidenceResult }> = [];
      for (const token of stableTokens) {
        const clean = normaliseToken(token);
        const match = matchAgainstCorpus(clean, known, c.validation);
        const fmt = formatScoreForToken(clean, modeRef.current === 'PRODUCT' ? 'PRODUCT' : 'CARTON');
        const confidence = computeConfidence(
          {
            detection: 'OCR',
            ocrConfidence: ocrConf01,
            qualityScore: qScore,
            formatScore: fmt,
            dbScore: match.dbScore,
            corpusPresent: known.length > 0,
            matchKind: match.kind,
            votes: c.consensus.votesRequired,
          },
          c,
        );
        const value = match.kind === 'candidate' && match.matched ? match.matched : clean;
        results.push({ value, readValue: clean, match, confidence });
      }
      return results.sort((a, b) => {
        const aExact = a.match.kind === 'exact' ? 1 : 0;
        const bExact = b.match.kind === 'exact' ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        return b.confidence.score - a.confidence.score;
      });
    }

    async function tick() {
      if (!running) return;
      const s = stateRef.current;
      if (isBusy(s) || s === 'SUCCESS' || s === 'ERROR') {
        raf = requestAnimationFrame(tick);
        return;
      }

      fpsFrames += 1;
      const nowMs = performance.now();
      if (nowMs - fpsSince >= 1000) {
        setFps(Math.round((fpsFrames * 1000) / (nowMs - fpsSince)));
        fpsFrames = 0;
        fpsSince = nowMs;
      }

      const vw = el!.videoWidth;
      const vh = el!.videoHeight;
      if (vw && vh && fullCtx && roiCtx) {
        frame += 1;
        full.width = vw;
        full.height = vh;
        fullCtx.drawImage(el!, 0, 0, vw, vh);

        const roi = computeRoi(vw, vh, roiRatioNow());
        roiCanvas.width = roi.width;
        roiCanvas.height = roi.height;
        roiCtx.drawImage(full, roi.x, roi.y, roi.width, roi.height, 0, 0, roi.width, roi.height);

        // ---- PRIORITY 1: barcode / QR (§12) — unchanged priority ----
        send('BARCODE_SCAN');
        const barcodeStart = performance.now();
        const code = await readBarcode(vw, vh);
        if (code) {
          framesSinceBarcode = 0;
          setGuideSafe({ phase: 'BARCODE_DETECTED' });
          const detection: DetectionType = 'BARCODE';
          const submitted = submit(code, 'CAMERA', detection, barcodeStart);
          if (submitted) {
            raf = requestAnimationFrame(tick);
            return;
          }
          send('RESUME');
        } else {
          framesSinceBarcode += 1;
          send('RESUME');
          setGuideSafe({ phase: 'SEARCHING' });

          // Cheap always-on guidance (light / glare) while searching.
          if (framesSinceBarcode % 6 === 0 && stateRef.current === 'SCANNING' && !pendingRef.current) {
            const qg = readRoiQuick();
            if (qg) {
              const quick = quickGuidance(qg.gray, qg.w, qg.h);
              if (quick.hint.length) {
                guideRef.current = { phase: 'SEARCHING', advice: quick.hint.map(guidanceWord) };
                setGuide({ phase: 'SEARCHING', advice: guideRef.current.advice });
              }
            }
          }

          // ---- PRIORITY 2: OCR fallback — only after barcode keeps failing ----
          const c = cfgRef.current;
          const shouldOcr =
            enableOcr &&
            framesSinceBarcode >= c.ocr.framesBeforeOcr &&
            frame % c.ocr.ocrCadence === 0 &&
            !ocrBusy() &&
            !pendingRef.current;

          if (shouldOcr) {
            send('OCR_SCAN');
            await runOcr(vw, vh);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }

    function readRoiQuick(): { gray: Uint8ClampedArray; w: number; h: number } | null {
      if (!roiCtx) return null;
      const roi = computeRoi(el!.videoWidth, el!.videoHeight, roiRatioNow());
      try {
        const d = roiCtx.getImageData(0, 0, roi.width, roi.height).data;
        const gray = new Uint8ClampedArray(roi.width * roi.height);
        for (let i = 0, p = 0; i < d.length; i += 4, p += 1) {
          gray[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
        }
        return { gray, w: roi.width, h: roi.height };
      } catch {
        return null;
      }
    }

    async function begin() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera is not supported on this device. Use an external scanner or manual entry.');
        send('CAMERA_FAILED');
        return;
      }
      const caps = capsRef.current ?? detectCapabilities();
      capsRef.current = caps;
      const res = cfgRef.current.camera.resolution[caps.deviceType] ?? cfgRef.current.camera.resolution.UNKNOWN;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facingRef.current },
            width: { ideal: res.width },
            height: { ideal: res.height },
          },
        });
        const track = stream.getVideoTracks()[0];
        const caps2: any = track?.getCapabilities ? track.getCapabilities() : {};
        if (caps2?.torch === true) setHasTorch(true);

        // Order §4: continuous autofocus/exposure where supported; never push
        // a constraint the platform does not advertise.
        tuneCamera(track, cfgRef.current.camera);

        el!.srcObject = stream;
        try {
          await el!.play();
        } catch (playErr: any) {
          const soft = /abort|interrupt/i.test(String(playErr?.name ?? '') + String(playErr?.message ?? ''));
          if (!soft) throw playErr;
          await new Promise<void>((resolve) => {
            if (el!.readyState >= 2) return resolve();
            const ok = () => resolve();
            el!.addEventListener('playing', ok, { once: true });
            window.setTimeout(ok, 1500);
          });
        }

        const B = (window as any).BarcodeDetector;
        if (B) {
          try {
            const formats = typeof B.getSupportedFormats === 'function'
              ? await B.getSupportedFormats()
              : NATIVE_FORMATS;
            nativeDetector = formats?.length ? new B({ formats }) : null;
          } catch { nativeDetector = null; }
        }
        setDetector(nativeDetector ? 'native' : 'zxing');
        send('CAMERA_READY');
        setGuideSafe({ phase: 'SEARCHING', advice: [] });
        raf = requestAnimationFrame(tick);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/NotAllowed|Permission|denied/i.test(msg)) {
          setError('Camera permission denied. Allow access, or use an external scanner / manual entry.');
        } else if (/NotFound|Requested device|Overconstrained/i.test(msg)) {
          setError('No usable camera found. Use an external scanner or manual entry.');
        } else {
          setError('Could not start the camera. Use an external scanner or manual entry.');
        }
        send('CAMERA_FAILED');
      }
    }

    void begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, setGuideSafe, setPendingSafe]);

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------
  useEffect(() => {
    capsRef.current = detectCapabilities();
    start();
    return () => {
      teardownRef.current();
      try {
        if (typeof window !== 'undefined') (window as any).__ayroviScanTelemetry = undefined;
      } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exit = useCallback(() => {
    send('EXIT');
    teardownRef.current();
    send('CLOSED');
    onClose();
  }, [onClose, send]);

  const toggleTorch = useCallback(async () => {
    const el = videoRef.current;
    const track = (el?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
    if (!track || !hasTorch) return;
    const nextTorch = !torch;
    try {
      await track.applyConstraints({ advanced: [{ torch: nextTorch }] as any });
      setTorch(nextTorch);
    } catch { /* unsupported at runtime */ }
  }, [hasTorch, torch]);

  const flipCamera = useCallback(() => {
    facingRef.current = facingRef.current === 'environment' ? 'user' : 'environment';
    setTorch(false);
    setHasTorch(false);
    teardownRef.current();
    start();
  }, [start]);

  const confirmPending = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    if (!send('CONFIRM')) return; // illegal from current state — ignore
    setPendingSafe(null);
    setGuideSafe({ phase: 'CONFIRMED' });
    setLastCode(p.value);
    setScanCount((n) => n + 1);
    onDetectedRef.current(p.value, 'CAMERA');
  }, [send, setPendingSafe, setGuideSafe]);

  const rescanPending = useCallback(() => {
    setPendingSafe(null);
    send('RESUME');
    setGuideSafe({ phase: 'SEARCHING' });
  }, [send, setPendingSafe, setGuideSafe]);

  const banner = state === 'SUCCESS' ? 'ok' : state === 'ERROR' ? 'bad' : null;
  const roiStyle = roiOverlayStyle(
    (mode ?? 'CARTON') === 'PRODUCT'
      ? cfgRef.current.camera.roi.PRODUCT
      : cfgRef.current.camera.roi.CARTON,
  );
  const isProductMode = (mode ?? 'CARTON') === 'PRODUCT';
  const stageLabel = isProductMode ? 'ALIGN SKU / PRODUCT LABEL' : 'ALIGN CARTON LABEL';

  return (
    <div className="cs-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="cs-frame">
        <header className="cs-head">
          <div className="cs-title">
            <span className="cs-dot" data-state={state} />
            {title}
          </div>
          <div className="cs-head-meta">
            {mode && onModeChange && (
              <div className="cs-modes" role="tablist" aria-label="Scan mode">
                {(['CARTON', 'PRODUCT'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={mode === m}
                    className={`cs-mode${mode === m ? ' is-active' : ''}`}
                    onClick={() => onModeChange(m)}
                  >
                    {m === 'CARTON' ? 'CARTONS' : 'PRODUCTS'}
                  </button>
                ))}
              </div>
            )}
            <span className="os-tag os-tag--muted">{scanCount} scanned</span>
            <button type="button" className="os-btn os-btn--danger" onClick={exit}>
              EXIT
            </button>
          </div>
        </header>

        <div className="cs-stage">
          <video ref={videoRef} className="cs-video" muted playsInline />

          {/* ROI the worker aligns the label into — matches the analysed region */}
          <div className="cs-roi" style={roiStyle} aria-hidden="true">
            <span className="cs-corner tl" />
            <span className="cs-corner tr" />
            <span className="cs-corner bl" />
            <span className="cs-corner br" />
            <div className="cs-roi-hint">{stageLabel}</div>
          </div>

          <div className="cs-status" data-state={state}>
            {stateLabel(state)}
            {ocrActive && <span className="cs-sub"> · OCR</span>}
            {detector && !ocrActive && <span className="cs-sub"> · {detector === 'native' ? 'FAST' : 'ZXING'}</span>}
            {fps > 0 && <span className="cs-sub"> · {fps}fps</span>}
          </div>

          {/* Guided feedback (§3/§6) */}
          {!pending && !error && (guide.phase === 'LOW_CONFIDENCE' || guide.advice.length > 0) && (
            <div className={`cs-guide${guide.phase === 'LOW_CONFIDENCE' ? ' cs-guide--warn' : ''}`}>
              {guide.advice.length ? guide.advice.join(' · ') : 'Keep the label still…'}
            </div>
          )}

          {lastCode && <div className="cs-lastcode os-mono">{lastCode}</div>}

          {outcome && banner && (
            <div key={outcome.token} className={`cs-result cs-result--${outcome.kind}`}>
              <strong>{outcome.kind === 'ok' ? '✓ RECEIVED' : '✕ NOT ACCEPTED'}</strong>
              <span>{outcome.text}</span>
            </div>
          )}

          {error && (
            <div className="cs-result cs-result--bad">
              <strong>✕ CAMERA</strong>
              <span>{error}</span>
              <button type="button" className="os-btn" onClick={start}>RETRY</button>
            </div>
          )}

          {/* Confirmation gate — MEDIUM-confidence OCR result (§10/§11) */}
          {pending && !error && (
            <div className="cs-confirm" role="alertdialog" aria-label="Confirm scan">
              <div className="cs-confirm-title">
                {pending.match.kind === 'none'
                  ? 'NO MATCHING ARTICLE'
                  : pending.match.kind === 'candidate'
                    ? 'POSSIBLE MATCH'
                    : 'CONFIRM SCAN'}
              </div>
              <div className="cs-confirm-code os-mono">{pending.value}</div>
              {pending.readValue !== pending.value && (
                <div className="os-muted">
                  OCR read: <span className="os-mono">{pending.readValue}</span>
                </div>
              )}
              {pending.match.kind === 'candidate' && pending.match.candidates.length > 1 && (
                <div className="cs-confirm-opts">
                  {pending.match.candidates.map((cd) => (
                    <button
                      key={cd.value}
                      type="button"
                      className={`os-btn${cd.value === pending.value ? ' is-active' : ''}`}
                      onClick={() => {
                        const cur = pendingRef.current;
                        if (!cur) return;
                        const upd = { ...cur, value: cd.value };
                        pendingRef.current = upd;
                        setPending(upd);
                      }}
                    >
                      {cd.value}
                    </button>
                  ))}
                </div>
              )}
              {pending.match.kind === 'none' && (
                <div className="cs-confirm-none">
                  No Article in the expected data matches this read. Re-scan the
                  label or use manual entry.
                </div>
              )}
              <div className="cs-confirm-row">
                <button type="button" className="os-btn" onClick={rescanPending}>RESCAN</button>
                <button
                  type="button"
                  className="os-btn os-btn--primary"
                  disabled={pending.match.kind === 'none'}
                  onClick={confirmPending}
                >
                  CONFIRM
                </button>
              </div>
              {pending.match.kind === 'none' && (
                <button type="button" className="os-btn" onClick={exit}>
                  EXIT TO MANUAL ENTRY
                </button>
              )}
            </div>
          )}
        </div>

        <footer className="cs-foot">
          <div className="cs-foot-hint">
            {hint ?? 'Scanner stays open — keep passing cartons. Barcode/QR first, text (OCR) as fallback.'}
          </div>
          <div className="os-row">
            <button type="button" className="os-btn" disabled={!hasTorch || !!error} onClick={toggleTorch}>
              {torch ? 'TORCH ON' : 'TORCH'}
            </button>
            <button type="button" className="os-btn" disabled={!!error} onClick={flipCamera}>
              FLIP CAMERA
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Short worker copy for guidance ids (§6). */
function guidanceWord(id: GuidanceId): string {
  switch (id) {
    case 'low_light': return 'Improve lighting';
    case 'glare': return 'Tilt away from glare';
    case 'no_label':
    case 'label_cropped': return 'Align label in the frame';
    case 'blurred':
    case 'motion_blur': return 'Hold steady';
    case 'small_text': return 'Move closer';
    default: return '';
  }
}

/** Capability-safe camera tuning (order §4): only advertise-supported
 *  constraints are applied; errors are ignored (progressive enhancement). */
function tuneCamera(track: MediaStreamTrack, cameraCfg: ScanConfig['camera']): void {
  if (!track || typeof track.getCapabilities !== 'function') return;
  try {
    const caps: any = track.getCapabilities();
    const advanced: any[] = [];
    if (Array.isArray(caps?.focusMode) && caps.focusMode.includes(cameraCfg.focusMode)) {
      advanced.push({ focusMode: cameraCfg.focusMode });
    }
    if (Array.isArray(caps?.exposureMode) && caps.exposureMode.includes(cameraCfg.exposureMode)) {
      advanced.push({ exposureMode: cameraCfg.exposureMode });
    }
    if (Array.isArray(caps?.whiteBalanceMode) && caps.whiteBalanceMode.includes(cameraCfg.whiteBalanceMode)) {
      advanced.push({ whiteBalanceMode: cameraCfg.whiteBalanceMode });
    }
    if (caps?.frameRate?.max) {
      const ideal = cameraCfg.desiredFrameRate.ideal;
      const max = Math.min(cameraCfg.desiredFrameRate.max, caps.frameRate.max);
      const min = Math.max(1, caps.frameRate.min ?? 1);
      advanced.push({ frameRate: { ideal: Math.min(max, Math.max(min, ideal)), max } });
    }
    if (advanced.length) void track.applyConstraints({ advanced });
  } catch { /* best-effort */ }
}
