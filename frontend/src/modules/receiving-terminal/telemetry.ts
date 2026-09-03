/**
 * Scan telemetry / audit trail — order §16.
 *
 * Every meaningful scanner/OCR attempt is recorded in-memory so operations are
 * traceable and so success / correction / manual-fallback / false-positive
 * rates can be measured — WITHOUT storing label images or sensitive data.
 *
 * Per attempt: scan session, scanner type, detection type, processing time,
 * OCR confidence, image quality, validation result, final result, failure
 * reason, device/performance metadata. `summary()` aggregates the rates the
 * order asks for. The debug handle (`window.__ayroviScanTelemetry`) lets an
 * operator dump a CSV from a terminal for the real-device §17 benchmark.
 */

export type DetectionType = 'BARCODE' | 'QR' | 'OCR' | 'MANUAL' | 'SCANNER';
export type ValidationResult = 'exact' | 'candidate' | 'none' | 'no_corpus' | 'na';
export type FinalResult =
  | 'accepted' // submitted → backend accepted
  | 'rejected' // submitted → backend rejected (false positive)
  | 'auto_submitted' // HIGH-confidence, auto-fired, verdict pending
  | 'worker_confirmed' // MEDIUM → worker confirmed, verdict pending
  | 'dropped_low_confidence' // LOW → never submitted
  | 'quality_gate_blocked' // OCR refused by the image-quality gate
  | 'no_candidate' // OCR ran but produced no usable candidate
  | 'cancelled';

export interface ScanAttempt {
  ts: number;
  scanSessionId?: string;
  mode?: 'CARTON' | 'PRODUCT';
  scannerType: 'native' | 'zxing' | 'tesseract' | 'ppocr' | 'manual' | 'external';
  detectionType: DetectionType;
  /** Dual-scanner order §12 — which scanner method produced this attempt. */
  scanMethod?: 'software' | 'hardware';
  /** Provider label (SoftwareScannerProvider / USB HID wedge / Bluetooth …). */
  provider?: string;
  /** Monotonic attempt counter inside this scan session (dual order §12). */
  attemptNumber?: number;
  /** What the station expects (CARTON | SKU | REFERENCE) — final order §32. */
  targetType?: string;
  /** ms spent decoding/recognising this attempt. */
  processingMs: number;
  ocrConfidence?: number; // 0..1
  imageQuality?: number; // gate score 0..1
  validationResult: ValidationResult;
  finalResult: FinalResult;
  failureReason?: string;
  deviceType?: string;
  frames?: number; // consensus votes behind an OCR result
  /**
   * Stage timings (unified P0 §28) — where the worker's time goes:
   * target detection / barcode decode / OCR / validation / match / total.
   * Measured per attempt; aggregated in summary().
   */
  stages?: {
    targetDetectionMs?: number;
    barcodeDecodeMs?: number;
    ocrMs?: number;
    validationMs?: number;
    matchMs?: number;
    totalMs?: number;
  };
}

export interface StageAverages {
  targetDetectionMs: number;
  barcodeDecodeMs: number;
  ocrMs: number;
  validationMs: number;
  matchMs: number;
}

export interface TelemetrySummary {
  attempts: number;
  /** Dual-scanner order §13 — attempts split by software / hardware. */
  byMethod: { software: number; hardware: number };
  byDetection: Record<DetectionType, number>;
  barcodeOk: number;
  barcodeAttempts: number;
  barcodeSuccessRate: number; // 0..1
  ocrRuns: number;
  ocrUsable: number; // OCR that produced a stable candidate (>= MEDIUM or dropped by LOW gate)
  ocrUsableRate: number;
  ocrCorrections: number; // candidate-match read confirmed by the worker
  manualFallbacks: number;
  manualFallbackRate: number; // 0..1 over attempts
  droppedLow: number;
  retries: number; // droppedLow + qualityBlocked → worker asked to retry
  retryRate: number; // 0..1 over attempts
  qualityBlocked: number;
  submitted: number;
  falsePositives: number;
  falsePositiveRate: number; // 0..1 over submitted
  accepted: number;
  avgScanTimeMs: number;
  avgOcrMs: number;
  p95ScanMs: number;
  /** End-to-end latency distribution over attempts (final order §27/§38). */
  latency: { p50: number; p90: number; p95: number; p99: number; max: number };
  /** Averages of stage timings across attempts that measured them (§28). */
  avgStages: StageAverages;
  recent: ScanAttempt[];
}

const SUBMIT_RESULTS: FinalResult[] = ['auto_submitted', 'worker_confirmed', 'accepted', 'rejected'];

export interface TelemetrySink {
  record(a: ScanAttempt): void;
  /** Tag the most recent submitted attempt with the backend verdict. */
  markBackendVerdict(accepted: boolean): void;
  manualFallback(count?: number): void;
  summary(): TelemetrySummary;
  clear(): void;
  toCSV(): string;
  /** Copy of all retained attempts (for device-benchmark snapshots). */
  dump(): ScanAttempt[];
  readonly count: number;
}

/** In-memory telemetry sink (ring of at most `maxAttempts` records). */
export function createTelemetry(maxAttempts = 500, scanSessionId?: string): TelemetrySink {
  const ring: ScanAttempt[] = [];
  let manualFallbacks = 0;
  let nextAttempt = 0;

  const finalize = (): TelemetrySummary => {
    const byMethod = { software: 0, hardware: 0 };
    const byDetection: Record<DetectionType, number> = { BARCODE: 0, QR: 0, OCR: 0, MANUAL: 0, SCANNER: 0 };
    for (const a of ring) {
      if (a.scanMethod === 'hardware') byMethod.hardware += 1;
      else byMethod.software += 1;
      byDetection[a.detectionType] += 1;
    }
    let barcodeOk = 0;
    let barcodeAttempts = 0;
    let ocrRuns = 0;
    let ocrUsable = 0;
    let ocrCorrections = 0;
    let droppedLow = 0;
    let qualityBlocked = 0;
    let submitted = 0;
    let falsePositives = 0;
    let accepted = 0;
    const scanTimes: number[] = [];
    const ocrTimes: number[] = [];
    const stageSums: Record<keyof StageAverages, number> = {
      targetDetectionMs: 0, barcodeDecodeMs: 0, ocrMs: 0, validationMs: 0, matchMs: 0,
    };
    const stageCounts: Record<keyof StageAverages, number> = {
      targetDetectionMs: 0, barcodeDecodeMs: 0, ocrMs: 0, validationMs: 0, matchMs: 0,
    };
    for (const a of ring) {
      if (a.stages) {
        for (const k of Object.keys(stageSums) as (keyof StageAverages)[]) {
          const v = a.stages[k];
          if (typeof v === 'number' && Number.isFinite(v)) {
            stageSums[k] += v;
            stageCounts[k] += 1;
          }
        }
      }
    }
    for (const a of ring) {
      scanTimes.push(a.processingMs);
      if (a.detectionType === 'OCR') {
        ocrRuns += 1;
        ocrTimes.push(a.processingMs);
        if (a.finalResult === 'dropped_low_confidence' || a.finalResult === 'auto_submitted' || a.finalResult === 'worker_confirmed') {
          ocrUsable += 1; // recognised text — policy then decided the action
        }
        if (a.finalResult === 'worker_confirmed') ocrCorrections += 1;
      }
      if (a.detectionType === 'BARCODE' || a.detectionType === 'QR') {
        barcodeAttempts += 1;
        if (a.finalResult === 'accepted' || a.finalResult === 'auto_submitted' || a.finalResult === 'worker_confirmed') barcodeOk += 1;
      }
      if (a.finalResult === 'dropped_low_confidence') droppedLow += 1;
      if (a.finalResult === 'quality_gate_blocked') qualityBlocked += 1;
      if (SUBMIT_RESULTS.includes(a.finalResult)) submitted += 1;
      if (a.finalResult === 'accepted') accepted += 1;
      if (a.finalResult === 'rejected') falsePositives += 1;
    }
    const avg = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
    const pct = (xs: number[], q: number) => {
      if (!xs.length) return 0;
      const s = xs.slice().sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * q) - 1))] ?? 0;
    };
    const p95 = (xs: number[]) => pct(xs, 0.95);
    const retries = droppedLow + qualityBlocked;
    return {
      attempts: ring.length,
      byMethod,
      byDetection,
      barcodeOk,
      barcodeAttempts,
      barcodeSuccessRate: barcodeAttempts ? barcodeOk / barcodeAttempts : 0,
      ocrRuns,
      ocrUsable,
      ocrUsableRate: ocrRuns ? ocrUsable / ocrRuns : 0,
      ocrCorrections,
      manualFallbacks,
      manualFallbackRate: ring.length ? manualFallbacks / ring.length : 0,
      droppedLow,
      retries,
      retryRate: ring.length ? retries / ring.length : 0,
      qualityBlocked,
      submitted,
      falsePositives,
      falsePositiveRate: submitted ? falsePositives / submitted : 0,
      accepted,
      avgScanTimeMs: avg(scanTimes),
      avgOcrMs: avg(ocrTimes),
      p95ScanMs: p95(scanTimes),
      latency: {
        p50: pct(scanTimes, 0.5),
        p90: pct(scanTimes, 0.9),
        p95: pct(scanTimes, 0.95),
        p99: pct(scanTimes, 0.99),
        max: scanTimes.length ? Math.max(...scanTimes) : 0,
      },
      avgStages: {
        targetDetectionMs: stageCounts.targetDetectionMs ? stageSums.targetDetectionMs / stageCounts.targetDetectionMs : 0,
        barcodeDecodeMs: stageCounts.barcodeDecodeMs ? stageSums.barcodeDecodeMs / stageCounts.barcodeDecodeMs : 0,
        ocrMs: stageCounts.ocrMs ? stageSums.ocrMs / stageCounts.ocrMs : 0,
        validationMs: stageCounts.validationMs ? stageSums.validationMs / stageCounts.validationMs : 0,
        matchMs: stageCounts.matchMs ? stageSums.matchMs / stageCounts.matchMs : 0,
      },
      recent: ring.slice(-20),
    };
  };

  return {
    record(a) {
      nextAttempt += 1;
      ring.push({ scanSessionId, attemptNumber: nextAttempt, ...a });
      if (ring.length > maxAttempts) ring.shift();
    },
    markBackendVerdict(acceptedVerdict) {
      for (let i = ring.length - 1; i >= 0; i -= 1) {
        const a = ring[i];
        if (a.finalResult === 'auto_submitted' || a.finalResult === 'worker_confirmed') {
          ring[i] = { ...a, finalResult: acceptedVerdict ? 'accepted' : 'rejected' };
          return;
        }
      }
    },
    manualFallback(count = 1) {
      manualFallbacks += Math.max(0, count);
    },
    summary: finalize,
    clear() {
      ring.length = 0;
      manualFallbacks = 0;
    },
    toCSV() {
      const head = 'ts,attemptNumber,scanMethod,provider,scannerType,detectionType,processingMs,ocrConfidence,imageQuality,validationResult,finalResult,failureReason,mode';
      const rows = ring.map((a) => [
        a.ts, a.attemptNumber ?? '', a.scanMethod ?? '', a.provider ?? '',
        a.scannerType, a.detectionType, a.processingMs,
        a.ocrConfidence ?? '', a.imageQuality ?? '', a.validationResult, a.finalResult,
        a.failureReason ?? '', a.mode ?? '',
      ].join(','));
      return [head, ...rows].join('\n');
    },
    get count() {
      return ring.length;
    },
    dump() {
      return ring.slice();
    },
  };
}

/** Read-only debug handle: console.table(window.__ayroviScanTelemetry.summary()). */
export function exposeDebugHandle(sink: TelemetrySink, key = '__ayroviScanTelemetry'): void {
  if (typeof window === 'undefined') return;
  try {
    (window as any)[key] = {
      summary: () => sink.summary(),
      csv: () => sink.toCSV(),
      clear: () => sink.clear(),
    };
  } catch { /* noop */ }
}
