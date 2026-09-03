import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { grayToPixels } from './pixels';
import {
  DEFAULT_SCAN_CONFIG,
  applyScannerProfile,
  mergeConfig,
  type DeepPartial,
  type RoiRatio,
  type ScanConfig,
  type ScannerProfileKey,
} from './scan-config';
import { assessQuality, quickGuidance, type GuidanceId } from './image-quality';
import { applyProfile, estimateSkewDeg, selectProfile, type ProfileId } from './preprocess';
import { extractFieldTokens, formatScoreForToken, type FieldToken } from './fields';
import { normaliseToken } from './normalize';
import { matchAgainstCorpus, type CorpusMatch } from './validate';
import { computeConfidence, type ConfidenceResult, type DetectionType } from './confidence';
import { createConsensus, type ConsensusAggregator } from './multiframe';
import { createTelemetry, exposeDebugHandle, type ScanAttempt, type TelemetrySink } from './telemetry';
import { exposeBenchmarkSnapshot } from './device-benchmark';
import { ocrBusy, recogniseRoi } from './ocr-client';
import { getLevel2OcrRuntime } from './pp-ocr/level2-runtime';
import { rankLevel2Lines } from './pp-ocr/select';
import { deriveScanProfile } from './scan-profile';
import { isBusy, next, stateLabel, type ScannerEvent, type ScannerState } from './scanner-state';
import { findDominantLine, lineCropBox, profileForLineSkew, type LineRegion } from './textlines';
import { EMPTY_DEDUPE, isDuplicate, noteSubmission, type DedupeState } from './dedupe';
import { receivingEngine } from './engine';
import type { ScanContext } from './scan-context';
import { openDemoScannerInput, openPhoneScannerInput, type ScannerInput } from './providers';
import './scanner.css';

/**
 * Continuous Receiving Scanner — Smart Direct Scanner (unified P0).
 *
 * The single decode loop runs the unified order's pipeline:
 *
 *   Input (PhoneCamera / Demo / future Industrial) → Scan Region / ROI
 *   → Fast path: QR/Barcode decode FIRST (a valid code always wins, §4)
 *   → Slow path (no code): DIRECT TARGET recognition (§5/§6/§8/§9)
 *        line detection → dynamic ROI (SKU / Reference line crop)
 *        → alignment/orientation check → profile → OCR on that line only
 *   → Field extraction → Normalisation → Corpus validation → Confidence
 *   → HIGH auto / MEDIUM worker-confirm / LOW retry+guidance
 *
 * Rules enforced here (regression-locked by scan-logic tests):
 *   - Barcode/QR first and always wins; a VALID barcode stops OCR (§4/§12).
 *   - OCR never runs on every frame (§19) — barcode-failure counter + cadence
 *     + quality gate + (PRODUCT) target-line requirement.
 *   - Image Quality gate runs before OCR; a bad frame never reaches Tesseract
 *     and the worker gets «Hold steady / Move closer / Improve lighting /
 *     Align label / Align target» (§12).
 *   - Corpus validation: EXACT→HIGH may auto-confirm; CANDIDATE/no-corpus →
 *     MEDIUM worker confirmation «Possible match»; LOW only retries (§10/§11).
 *   - Multi-frame quality-weighted consensus (§18) + identity/timestamp
 *     duplicate guard so one physical scan = one Receiving event (§26).
 *   - Camera enters through ScannerInput providers only (§22-§25): the loop
 *     never touches getUserMedia directly; a future Industrial/IR provider
 *     or a hardware trigger plugs into the same seam.
 *   - Telemetry records stages + rates (§28); no label images are stored.
 *   - The backend verdict (outcome) is the ONLY path to SUCCESS (§25).
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

/**
 * Industrial guidance phases (unified P0 §21) shown to the worker.
 * SEARCHING → TARGET FOUND → FOCUS/READING → VALIDATING → MATCHED.
 */
export type GuidePhase =
  | 'SEARCHING'
  | 'TARGET_FOUND'
  | 'READING'
  | 'VALIDATING'
  | 'MATCHED'
  | 'LOW_CONFIDENCE'
  | 'CONFIRM_NEEDED';

export const PHASE_LABEL: Record<GuidePhase, string> = {
  SEARCHING: 'SEARCHING',
  TARGET_FOUND: 'TARGET FOUND',
  READING: 'READING',
  VALIDATING: 'VALIDATING',
  MATCHED: 'MATCHED',
  LOW_CONFIDENCE: 'LOW CONFIDENCE',
  CONFIRM_NEEDED: 'CONFIRM',
};

export interface PendingConfirm {
  /** the code that would be submitted (canonical corpus value when candidate) */
  value: string;
  /** the value exactly as OCR read it */
  readValue: string;
  match: CorpusMatch;
  confidence: ConfidenceResult;
  detectedAt: number;
}

interface GuideState {
  phase: GuidePhase;
  advice: string[];
  /** 0..1 — vertical position of the detected target line inside the ROI. */
  line: number;
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
  /** Prefetched expected-value context (final order §5–§7/§11): overrides corpus
   *  with the locally-normalised expected set when provided. */
  scanContext?: ScanContext | null;
  /** Per-instance config overrides (threshold tuning / benchmarks). */
  scanConfig?: DeepPartial<ScanConfig>;
  /** Named scanner operating envelope (§27). Defaults to BALANCED. */
  scannerProfile?: ScannerProfileKey;
  /** OCR runtime for the text fallback. 'tesseract' is the product default;
   *  'ppocr' opts into the level-2 engine (experimental until on-device data). */
  ocrEngine?: 'tesseract' | 'ppocr';
  /** DEMO: simulate a moving label (no camera) through the same pipeline. */
  demoMode?: boolean;
  /** DEMO: codes the simulated labels cycle through. */
  demoCodes?: string[];
  /** Optional node rendered in the header (e.g. dual-scanner method tabs). */
  headerExtra?: ReactNode;
}

const GUIDE_START: GuideState = { phase: 'SEARCHING', advice: [], line: 0.5 };

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
  scanContext = null,
  scanConfig,
  scannerProfile = 'BALANCED',
  ocrEngine = 'tesseract',
  demoMode = false,
  demoCodes,
  headerExtra,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const demoRef = useRef<HTMLCanvasElement>(null);
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
  const fpsRef = useRef(0);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [guide, setGuide] = useState<GuideState>(GUIDE_START);

  const stateRef = useRef<ScannerState>('IDLE');
  const cfgRef = useRef<ScanConfig>(DEFAULT_SCAN_CONFIG);
  const corpusRef = useRef<string[]>([]);
  const scanContextRef = useRef<ScanContext | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  const telemetryRef = useRef<TelemetrySink | null>(null);
  const capsRef = useRef<DeviceCapabilities | null>(null);
  const inputRef = useRef<ScannerInput | null>(null);
  const modeRef = useRef<'CARTON' | 'PRODUCT'>('CARTON');
  modeRef.current = mode ?? 'CARTON';
  const demoModeRef = useRef<boolean>(demoMode);
  const enableOcrRef = useRef<boolean>(enableOcr);
  enableOcrRef.current = enableOcr;
  demoModeRef.current = demoMode;
  const ocrEngineRef = useRef<'tesseract' | 'ppocr'>(ocrEngine);
  ocrEngineRef.current = ocrEngine;

  // Live guide mirror — the loop writes here without a re-render per frame.
  const guideRef = useRef<GuideState>(GUIDE_START);
  const setGuideSafe = useCallback((g: Partial<GuideState> & { phase: GuidePhase }) => {
    const prev = guideRef.current;
    const nextGuide: GuideState = {
      phase: g.phase,
      advice: g.advice ?? prev.advice,
      line: typeof g.line === 'number' ? g.line : prev.line,
    };
    if (
      nextGuide.phase === prev.phase &&
      nextGuide.advice === prev.advice &&
      nextGuide.line === prev.line
    ) return;
    guideRef.current = nextGuide;
    setGuide(nextGuide);
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
    const profiled = applyScannerProfile(DEFAULT_SCAN_CONFIG, scannerProfile);
    const withOverrides = mergeConfig(profiled, scanConfig ?? {});
    // The explicit ocrEngine prop wins over scanConfig (opt-in level-2 engine).
    cfgRef.current = mergeConfig(withOverrides, { ocr: { engine: ocrEngine } });
    modeRef.current = mode ?? 'CARTON';
  }, [scanConfig, mode, scannerProfile, ocrEngine]);
  useEffect(() => {
    scanContextRef.current = scanContext ?? null;
    // Expected-value matching (§11/§30): when a prefetched ScanContext exists we
    // validate against ITS normalised expected set (local, pre-built) only.
    corpusRef.current = scanContext
      ? scanContext.values
      : (corpus ?? []).map((c) => (c || '').trim().toUpperCase()).filter(Boolean);
  }, [scanContext, corpus]);

  /** Backend verdict → SUBMITTING → SUCCESS/ERROR, then back to scanning. */
  useEffect(() => {
    if (!outcome) return;
    if (outcome.kind === 'ok') {
      send('ACCEPTED');
      setGuideSafe({ phase: 'MATCHED' });
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
    guideRef.current = { ...GUIDE_START };
    setGuide({ ...GUIDE_START });
    send('OPEN');

    const isDemo = demoModeRef.current;
    const el: HTMLVideoElement | HTMLCanvasElement | null = isDemo ? demoRef.current : videoRef.current;
    if (!el) return;

    let running = true;
    let raf = 0;
    let timer = 0;
    let provider: ScannerInput | null = null;
    let nativeDetector: any = null;
    let frame = 0;
    let framesSinceBarcode = 0;
    let fpsFrames = 0;
    let fpsSince = performance.now();
    let lineStreak = 0;

    // identity + timestamp + session duplicate guard (§26)
    const dup: DedupeState = { ...EMPTY_DEDUPE };

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
    exposeBenchmarkSnapshot(
      telemetry,
      '__ayroviScanTelemetry',
      () => ({
        method: 'software',
        provider: isDemo ? 'demo-camera' : 'software-camera',
        deviceType: capsRef.current?.deviceType,
        fpsAvg: fpsRef.current,
      }),
    );

    const teardown = () => {
      running = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      provider?.stop();
      provider = null;
      inputRef.current = null;
      consensus.reset();
      telemetryRef.current = null;
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
        targetType: modeRef.current === 'PRODUCT'
          ? (scanContextRef.current?.targetType ?? 'SKU')
          : 'CARTON',
        scanMethod: 'software',
        provider: isDemo ? 'demo-camera' : 'software-camera',
        scannerType: detection === 'OCR' ? ocrEngineRef.current : nativeDetector ? 'native' : 'zxing',
        detectionType: detection,
        processingMs,
        validationResult: 'na',
        finalResult: 'no_candidate',
        deviceType: capsRef.current?.deviceType ?? 'UNKNOWN',
        ...patch,
      } as ScanAttempt);
    };

    /** Hand a value to the parent exactly once per physical code (§26). */
    const submit = (
      value: string,
      source: ScanSource,
      detection: DetectionType,
      startedAt?: number,
      extra?: Partial<Omit<ScanAttempt, 'ts' | 'scanSessionId'>>,
    ): boolean => {
      const now = Date.now();
      const c = cfgRef.current;
      if (isDuplicate(dup, value, now, c.duplicate.repeatWindowMs)) return false;
      noteSubmission(dup, value, now);
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

    /** Read the current ROI as gray (+ RGBA copy) for quality/target/OCR. */
    function readRoiGray(w: number, h: number): { img: { data: Uint8ClampedArray; width: number; height: number }; gray: Uint8ClampedArray } {
      const imageData = roiCtx!.getImageData(0, 0, w, h);
      const gray = new Uint8ClampedArray(w * h);
      const d = imageData.data;
      for (let i = 0, p = 0; i < d.length; i += 4, p += 1) {
        gray[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      }
      return { img: { data: imageData.data, width: w, height: h }, gray };
    }

    /** Detect the dominant text line (dynamic ROI) + its deskew decision. */
    function detectTargetLine(gray: Uint8ClampedArray, w: number, h: number):
      { line: LineRegion | null; ms: number } {
      const t0 = performance.now();
      const line = findDominantLine(gray, w, h, {
        maxWidth: cfgRef.current.targeting.analysisMaxWidth,
        preferLowest: modeRef.current === 'PRODUCT',
      });
      return { line, ms: performance.now() - t0 };
    }

    /**
     * One OCR attempt: (target line for PRODUCT) → quality gate → profile →
     * OCR on the dynamic line ROI (or the band) → fields → consensus → corpus
     * validation → confidence → auto / confirm / drop.
     */
    async function runOcr(vw: number, vh: number): Promise<boolean> {
      if (!roiCtx) return false;
      const c = cfgRef.current;
      const roi = computeRoi(vw, vh, roiRatioNow());
      const started = performance.now();
      const stg: NonNullable<ScanAttempt['stages']> = { totalMs: 0 };

      // ---- DIRECT TARGET: find the line we are going to OCR (§5/§6/§8) ----
      const { img, gray } = readRoiGray(roi.width, roi.height);
      const isProduct = modeRef.current === 'PRODUCT';
      const wantsLine = c.targeting.enabled && (isProduct || !c.targeting.productOnly);
      let line: LineRegion | null = null;
      if (wantsLine) {
        const dl = detectTargetLine(gray, roi.width, roi.height);
        stg.targetDetectionMs = dl.ms;
        line = dl.line;
        const strong = line && line.score >= c.targeting.minScore;
        if (strong) {
          lineStreak = Math.min(20, lineStreak + 1);
          const frac = (line!.y0 + line!.y1) / 2 / Math.max(1, roi.height);
          setGuideSafe({ phase: 'TARGET_FOUND', line: Math.max(0, Math.min(1, frac)) });
        } else {
          lineStreak = 0;
          if (isProduct) {
            // No legible single line in PRODUCT mode → coach, don't burn OCR.
            setGuideSafe({
              phase: 'SEARCHING',
              advice: ['Align target label in the frame'],
              line: 0.5,
            });
          }
        }
      }

      // ---- IMAGE QUALITY GATE first (§12) — refuse OCR on a bad frame. ----
      const qT0 = performance.now();
      const q = assessQuality(gray, roi.width, roi.height);
      stg.totalMs = performance.now() - started;
      setOcrActive(true);
      try {
        if (c.ocr.qualityGateEnabled && !q.pass) {
          setGuideSafe({ phase: 'LOW_CONFIDENCE', advice: q.advice });
          record('OCR', started, {
            finalResult: 'quality_gate_blocked',
            failureReason: q.reasons.join(','),
            imageQuality: q.score,
            stages: stg,
          });
          return true;
        }
        // PRODUCT direct mode: require the target line before spending OCR.
        if (isProduct && wantsLine && !line) {
          setGuideSafe({
            phase: 'SEARCHING',
            advice: ['Align target label in the frame'],
            line: 0.5,
          });
          record('OCR', started, {
            finalResult: 'no_candidate',
            failureReason: 'no_target_line',
            imageQuality: q.score,
            stages: stg,
          });
          return true;
        }

        // ---- Preprocessing profile from measured quality (§13) ----
        let profile: ProfileId = selectProfile(q);
        let ocrGray = gray;
        let ocrW = roi.width;
        let ocrH = roi.height;
        let psm = profile === 'C_SMALL_TEXT' ? '7' : '6';

        if (wantsLine && line) {
          const box = lineCropBox(line, roi.width, roi.height, c.targeting.margin);
          if (box && box.height >= 8 && box.width >= 12) {
            // Deskew the cropped line when tilted (§9), then OCR that line only.
            const crop = new Uint8ClampedArray(box.width * box.height);
            for (let yy = 0; yy < box.height; yy += 1) {
              for (let xx = 0; xx < box.width; xx += 1) {
                crop[yy * box.width + xx] = gray[(box.y + yy) * roi.width + (box.x + xx)];
              }
            }
            const skew = estimateSkewDeg(crop, box.width, box.height);
            profile = profileForLineSkew(skew, profile) as ProfileId;
            ocrGray = crop;
            ocrW = box.width;
            ocrH = box.height;
            psm = '7'; // single-line read of the SKU / Reference line
          }
        }

        setGuideSafe({ phase: 'READING' });
        const pT0 = performance.now();
        // applyProfile expects RGBA Pixels (it converts internally via toGray);
        // the ROI/line buffers are luma, so widen first.
        const rgba = grayToPixels(ocrGray, ocrW, ocrH);
        const prepped = applyProfile(
          { data: rgba.data.slice() as Uint8ClampedArray, width: ocrW, height: ocrH },
          profile,
          {
            smallTextUpscale: c.ocr.smallTextUpscale,
            maxWidth: c.ocr.ocrMaxWidth,
          },
        );
        const ocrCanvas = canvasFromGray(prepped.gray, prepped.width, prepped.height);
        const tOcr0 = performance.now();
        const res = await recogniseRoi(ocrCanvas, { psm });
        const ocrMs = performance.now() - tOcr0;
        const conf01 = res ? Math.max(0, Math.min(1, res.confidence / 100)) : 0;
        if (!res || !res.text) {
          setGuideSafe({ phase: 'TARGET_FOUND' });
          record('OCR', started, {
            ocrConfidence: conf01,
            imageQuality: q.score,
            finalResult: 'no_candidate',
            failureReason: res ? 'empty_ocr' : 'ocr_error',
            stages: { ...stg, ocrMs, totalMs: performance.now() - started },
          });
          return true;
        }
        setGuideSafe({ phase: 'VALIDATING' });

        // ---- Field-aware extraction (§14) + weighted multi-frame votes ----
        const tokens: FieldToken[] = extractFieldTokens(res.text);
        const weight = Math.max(0.3, Math.min(1, q.score));
        const stableTokens: string[] = tokens.length
          ? consensus.pushFrame(tokens.map((t) => ({ token: t.token, weight })))
          : [];

        if (stableTokens.length === 0) {
          setGuideSafe({ phase: 'TARGET_FOUND' });
          record('OCR', started, {
            ocrConfidence: conf01,
            imageQuality: q.score,
            finalResult: 'no_candidate',
            failureReason: tokens.length === 0 ? 'no_fields' : 'awaiting_consensus',
            stages: { ...stg, ocrMs, totalMs: performance.now() - started },
          });
          return true;
        }

        // ---- Rank stable tokens by composite confidence; corpus-exact first.
        const vT0 = performance.now();
        const ranked = rankStable(stableTokens, conf01, q.score);
        const validationMs = performance.now() - vT0;
        const best = ranked[0];
        if (!best) {
          record('OCR', started, {
            ocrConfidence: conf01,
            imageQuality: q.score,
            finalResult: 'no_candidate',
            failureReason: 'unrankable',
            stages: { ...stg, ocrMs, validationMs, totalMs: performance.now() - started },
          });
          return true;
        }
        const { value, readValue, match, confidence } = best;
        const doneStages = { ...stg, ocrMs, validationMs, totalMs: performance.now() - started };

        if (confidence.level === 'HIGH') {
          // EXACT + strong engine/quality → auto-confirm (§11).
          setGuideSafe({ phase: 'MATCHED', line: guideRef.current.line });
          submit(value, 'CAMERA', 'OCR', started, {
            ocrConfidence: conf01,
            imageQuality: q.score,
            validationResult: match.kind,
            frames: cfgRef.current.consensus.votesRequired,
            stages: doneStages,
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
            stages: doneStages,
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
          stages: doneStages,
        });
        setGuideSafe({
          phase: 'LOW_CONFIDENCE',
          advice: match.kind === 'none'
            ? ['No matching Article found — rescan or use manual entry']
            : (q.advice.length ? q.advice : ['Hold steady — rescan']),
        });
        return true;
      } finally {
        setOcrActive(false);
        if (stateRef.current === 'OCR_PROCESSING') send('RESUME');
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

    /**
     * Level-2 OCR attempt (P2 — opt-in via ocrEngine='ppocr').
     *
     * PP-OCR detects and reads the text lines itself, so the tesseract-era
     * single-line targeting + quality gate are skipped: the whole ROI is handed
     * to the engine and its lines are filtered/ranked by the scan-profile
     * prefix filter (derived from the card) + corpus/expected matching. All
     * downstream rules stay identical: HIGH auto-submit / MEDIUM confirm /
     * LOW retry, dedupe, identity + telemetry.
     */
    async function runOcrLevel2(vw: number, vh: number): Promise<boolean> {
      if (!roiCtx) return false;
      const c = cfgRef.current;
      const roi = computeRoi(vw, vh, roiRatioNow());
      const started = performance.now();
      const stg: NonNullable<ScanAttempt['stages']> = { totalMs: 0 };
      setOcrActive(true);
      try {
        const rt = getLevel2OcrRuntime();
        if (!rt.isWarm()) {
          // Models still downloading/initialising — keep the camera live and
          // let the next OCR cadence retry; never block the loop.
          setGuideSafe({ phase: 'SEARCHING' });
          record('OCR', started, {
            finalResult: 'no_candidate',
            failureReason: 'level2_engine_warming',
            stages: { ...stg, totalMs: performance.now() - started },
          });
          return true;
        }
        const { img, gray } = readRoiGray(roi.width, roi.height);
        // Quality still feeds the composite score (never a hard gate here).
        const q = assessQuality(gray, roi.width, roi.height);
        const res = await rt.recognise({
          data: img.data,
          width: roi.width,
          height: roi.height,
          order: 'rgba',
        });
        const lines = res?.lines ?? [];
        const ocrMs = res ? res.timings.totalMs : 0;
        if (lines.length === 0) {
          setGuideSafe({ phase: 'SEARCHING' });
          record('OCR', started, {
            ocrConfidence: 0,
            imageQuality: q.score,
            finalResult: 'no_candidate',
            failureReason: 'no_text_lines',
            stages: { ...stg, ocrMs, totalMs: performance.now() - started },
          });
          return true;
        }
        setGuideSafe({ phase: 'VALIDATING' });
        const ctx = scanContextRef.current;
        const ranked = rankLevel2Lines(lines, {
          mode: modeRef.current === 'PRODUCT' ? 'PRODUCT' : 'CARTON',
          cfg: c,
          known: corpusRef.current,
          qualityScore: q.score,
          profile: ctx ? deriveScanProfile(ctx) : undefined,
        });
        const best = ranked[0];
        if (!best) {
          setGuideSafe({ phase: 'SEARCHING' });
          record('OCR', started, {
            ocrConfidence: 0,
            imageQuality: q.score,
            finalResult: 'no_candidate',
            failureReason: 'no_plausible_line',
            stages: { ...stg, ocrMs, totalMs: performance.now() - started },
          });
          return true;
        }
        const doneStages = { ...stg, ocrMs, totalMs: performance.now() - started };

        if (best.confidence.level === 'HIGH') {
          setGuideSafe({ phase: 'MATCHED', line: guideRef.current.line });
          submit(best.value, 'CAMERA', 'OCR', started, {
            ocrConfidence: best.lineConfidence,
            imageQuality: q.score,
            validationResult: best.match.kind,
            frames: 1,
            stages: doneStages,
          });
          return true;
        }
        if (best.confidence.level === 'MEDIUM') {
          record('OCR', started, {
            ocrConfidence: best.lineConfidence,
            imageQuality: q.score,
            validationResult: best.match.kind,
            finalResult: 'worker_confirmed',
            frames: 1,
            stages: doneStages,
          });
          send('CANDIDATE');
          send('VALIDATE');
          setGuideSafe({ phase: 'CONFIRM_NEEDED' });
          setPendingSafe({
            value: best.value,
            readValue: best.readValue,
            match: best.match,
            confidence: best.confidence,
            detectedAt: Date.now(),
          });
          return true;
        }
        record('OCR', started, {
          ocrConfidence: best.lineConfidence,
          imageQuality: q.score,
          validationResult: best.match.kind,
          finalResult: 'dropped_low_confidence',
          failureReason: best.match.kind === 'none' ? 'no_corpus_match' : 'low_composite',
          frames: 1,
          stages: doneStages,
        });
        setGuideSafe({
          phase: 'LOW_CONFIDENCE',
          advice: best.match.kind === 'none'
            ? ['No matching Article found — rescan or use manual entry']
            : ['Hold steady — rescan'],
        });
        return true;
      } finally {
        setOcrActive(false);
        if (stateRef.current === 'OCR_PROCESSING') send('RESUME');
      }
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
        const nextFps = Math.round((fpsFrames * 1000) / (nowMs - fpsSince));
        fpsRef.current = nextFps;
        setFps(nextFps);
        fpsFrames = 0;
        fpsSince = nowMs;
      }

      const vw = provider?.width() ?? 0;
      const vh = provider?.height() ?? 0;
      if (vw && vh && fullCtx && roiCtx && provider) {
        frame += 1;
        full.width = vw;
        full.height = vh;
        if (!provider.drawTo(fullCtx, vw, vh)) {
          raf = requestAnimationFrame(tick);
          return;
        }

        const roi = computeRoi(vw, vh, roiRatioNow());
        roiCanvas.width = roi.width;
        roiCanvas.height = roi.height;
        roiCtx.drawImage(full, roi.x, roi.y, roi.width, roi.height, 0, 0, roi.width, roi.height);

        // ---- PRIORITY 1: barcode / QR (§4/§12) — unchanged priority ----
        send('BARCODE_SCAN');
        const barcodeStart = performance.now();
        const code = await readBarcode(vw, vh);
        if (code) {
          framesSinceBarcode = 0;
          setGuideSafe({ phase: 'MATCHED' });
          const detection: DetectionType = 'BARCODE';
          const submitted = submit(code, 'CAMERA', detection, barcodeStart, {
            stages: {
              barcodeDecodeMs: performance.now() - barcodeStart,
              totalMs: performance.now() - barcodeStart,
            },
          });
          if (submitted) {
            raf = requestAnimationFrame(tick);
            return;
          }
          send('RESUME');
        } else {
          framesSinceBarcode += 1;
          send('RESUME');
          if (!pendingRef.current) setGuideSafe({ phase: 'SEARCHING' });

          // Cheap always-on guidance (light / glare / target) while searching.
          const c = cfgRef.current;
          if (framesSinceBarcode % c.targeting.alignCheckCadence === 0 && stateRef.current === 'SCANNING' && !pendingRef.current) {
            const qg = readRoiQuick();
            if (qg) {
              const quick = quickGuidance(qg.gray, qg.w, qg.h);
              if (quick.hint.length) {
                const advice = quick.hint.map(guidanceWord).filter(Boolean);
                if (advice.length) {
                  setGuideSafe({ phase: 'SEARCHING', advice });
                }
              }
            }
          }

          // ---- PRIORITY 2: OCR fallback — only after barcode keeps failing ----
          const shouldOcr =
            enableOcr &&
            framesSinceBarcode >= c.ocr.framesBeforeOcr &&
            frame % c.ocr.ocrCadence === 0 &&
            !ocrBusy() &&
            !pendingRef.current;

          if (shouldOcr) {
            send('OCR_SCAN');
            if (cfgRef.current.ocr.engine === 'ppocr') {
              await runOcrLevel2(vw, vh);
            } else {
              await runOcr(vw, vh);
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }

    function readRoiQuick(): { gray: Uint8ClampedArray; w: number; h: number } | null {
      if (!roiCtx) return null;
      const vw = provider?.width() ?? 0;
      const vh = provider?.height() ?? 0;
      if (!vw || !vh) return null;
      const roi = computeRoi(vw, vh, roiRatioNow());
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
      if (isDemo) {
        const canvas = demoRef.current;
        if (!canvas) {
          setError('Demo canvas unavailable.');
          send('CAMERA_FAILED');
          return;
        }
        provider = openDemoScannerInput({
          canvas,
          codes: demoCodes,
          frameWidth: 1280,
          frameHeight: 720,
        });
      } else {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError('Camera is not supported on this device. Use an external scanner or manual entry.');
          send('CAMERA_FAILED');
          return;
        }
        const caps = capsRef.current ?? detectCapabilities();
        capsRef.current = caps;
        const c = cfgRef.current;
        try {
          const video = videoRef.current!;
          provider = await openPhoneScannerInput(
            { mediaDevices: navigator.mediaDevices, video },
            {
              camera: c.camera,
              deviceType: caps.deviceType as any,
              facing: facingRef.current,
            },
          );
        } catch (e: any) {
          const msg = String(e?.message ?? e ?? '');
          if (msg === 'camera-permission-denied') {
            setError('Camera permission denied. Allow access, or use an external scanner / manual entry.');
          } else if (msg === 'no-camera-found') {
            setError('No usable camera found. Use an external scanner or manual entry.');
          } else {
            setError('Could not start the camera. Use an external scanner or manual entry.');
          }
          send('CAMERA_FAILED');
          return;
        }
      }

      inputRef.current = provider;
      try {
        await provider.start();
      } catch {
        setError('Could not start the scanner feed.');
        send('CAMERA_FAILED');
        return;
      }
      setHasTorch(provider.torchSupported);
      setTorch(false);

      // Native BarcodeDetector only for real camera frames.
      const B = (window as any).BarcodeDetector;
      if (B && provider.allowNativeDetector()) {
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
    }

    void begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, setGuideSafe, setPendingSafe]);

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------
  useEffect(() => {
    capsRef.current = detectCapabilities();
    // §18/§20: warm the reusable scanner engine while this scanner is open. The
    // engine is NOT shut down on unmount — it idles warm for the next session.
    const engine = receivingEngine();
    const wantsOcr = enableOcrRef.current;
    const usePp = ocrEngineRef.current === 'ppocr';
    if (wantsOcr) {
      if (usePp) {
        // Level-2 runtime: load models once in the background (idempotent).
        // Kept warm across sessions by design; nothing to release per session.
        void getLevel2OcrRuntime().warm().catch(() => { /* transient: retried on demand */ });
      } else {
        engine.acquire({ warm: true });
      }
    }
    start();
    return () => {
      teardownRef.current();
      // §19 “clean, don't shut down”: release leaves the engine warm (idle
      // grace), so the next Receiving session reuses OCR/decoder instantly.
      if (wantsOcr && !usePp) engine.release();
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
    const src = inputRef.current;
    if (!src || !src.torchSupported) return;
    const nextTorch = !torch;
    const ok = await src.setTorch(nextTorch);
    if (ok) setTorch(nextTorch);
  }, [torch]);

  const flipCamera = useCallback(() => {
    if (demoModeRef.current) return;
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
    setGuideSafe({ phase: 'MATCHED' });
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
  // P3: when a card context is prefetched, its scan profile tells the operator
  // exactly what to aim at (e.g. 'SKU · starts with SB') — derived, not typed.
  const cardProfile = scanContext ? deriveScanProfile(scanContext) : null;
  const profileLabel =
    cardProfile && (cardProfile.mode === 'SKU' || cardProfile.mode === 'REFERENCE') && isProductMode
      ? cardProfile.prefix
        ? `ALIGN ${cardProfile.mode} · ${cardProfile.prefix}`
        : `ALIGN ${cardProfile.mode}`
      : null;
  const stageLabel = profileLabel ?? (isProductMode ? 'ALIGN SKU / REFERENCE' : 'ALIGN CARTON LABEL');
  const linePct = `${Math.max(0, Math.min(1, guide.line)) * 100}%`;

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
            {headerExtra}
            <span className="os-tag os-tag--muted">{scanCount} scanned</span>
            <button type="button" className="os-btn os-btn--danger" onClick={exit}>
              EXIT
            </button>
          </div>
        </header>

        <div className="cs-stage">
          {demoMode ? (
            <canvas ref={demoRef} className="cs-video" width={1280} height={720} />
          ) : (
            <video ref={videoRef} className="cs-video" muted playsInline />
          )}

          {/* ROI the worker aligns the label into — matches the analysed region */}
          <div className="cs-roi" style={roiStyle} aria-hidden="true" data-frame={cardProfile?.frame ?? 'band'}>
            <span className="cs-corner tl" />
            <span className="cs-corner tr" />
            <span className="cs-corner bl" />
            <span className="cs-corner br" />
            <span className="cs-scanline" style={{ top: linePct }} />
            <div className="cs-roi-hint">{stageLabel}</div>
          </div>

          {/* Industrial phase + engine chip */}
          <div className="cs-status" data-state={state}>
            <span className={`cs-phase cs-phase--${guide.phase}`} data-phase={guide.phase}>
              {PHASE_LABEL[guide.phase]}
            </span>
            {ocrActive && <span className="cs-sub"> · OCR</span>}
            {detector && !ocrActive && <span className="cs-sub"> · {detector === 'native' ? 'FAST' : 'ZXING'}</span>}
            {fps > 0 && <span className="cs-sub"> · {fps}fps</span>}
          </div>

          {/* Guided feedback (§12/§21) */}
          {!pending && !error && (guide.advice.length > 0) && (
            <div className={`cs-guide${guide.phase === 'LOW_CONFIDENCE' ? ' cs-guide--warn' : ''}`}>
              {guide.advice.join(' · ')}
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
            <button type="button" className="os-btn" disabled={!!error || demoMode} onClick={flipCamera}>
              FLIP CAMERA
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Short worker copy for guidance ids (§12). */
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
