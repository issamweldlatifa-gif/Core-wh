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

export type DetectionType = 'BARCODE' | 'QR' | 'OCR' | 'MANUAL';
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
  scannerType: 'native' | 'zxing' | 'tesseract' | 'manual' | 'external';
  detectionType: DetectionType;
  /** ms spent decoding/recognising this attempt. */
  processingMs: number;
  ocrConfidence?: number; // 0..1
  imageQuality?: number; // gate score 0..1
  validationResult: ValidationResult;
  finalResult: FinalResult;
  failureReason?: string;
  deviceType?: string;
  frames?: number; // consensus votes behind an OCR result
}

export interface TelemetrySummary {
  attempts: number;
  byDetection: Record<DetectionType, number>;
  barcodeOk: number;
  barcodeAttempts: number;
  barcodeSuccessRate: number; // 0..1
  ocrRuns: number;
  ocrUsable: number; // OCR that produced a stable candidate (>= MEDIUM or dropped by LOW gate)
  ocrUsableRate: number;
  ocrCorrections: number; // candidate-match read confirmed by the worker
  manualFallbacks: number;
  droppedLow: number;
  qualityBlocked: number;
  submitted: number;
  falsePositives: number;
  accepted: number;
  avgScanTimeMs: number;
  avgOcrMs: number;
  p95ScanMs: number;
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
  readonly count: number;
}

/** In-memory telemetry sink (ring of at most `maxAttempts` records). */
export function createTelemetry(maxAttempts = 500, scanSessionId?: string): TelemetrySink {
  const ring: ScanAttempt[] = [];
  let manualFallbacks = 0;

  const finalize = (): TelemetrySummary => {
    const byDetection: Record<DetectionType, number> = { BARCODE: 0, QR: 0, OCR: 0, MANUAL: 0 };
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
    for (const a of ring) {
      byDetection[a.detectionType] += 1;
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
    const p95 = (xs: number[]) => {
      if (!xs.length) return 0;
      const s = xs.slice().sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * 0.95) - 1))] ?? 0;
    };
    return {
      attempts: ring.length,
      byDetection,
      barcodeOk,
      barcodeAttempts,
      barcodeSuccessRate: barcodeAttempts ? barcodeOk / barcodeAttempts : 0,
      ocrRuns,
      ocrUsable,
      ocrUsableRate: ocrRuns ? ocrUsable / ocrRuns : 0,
      ocrCorrections,
      manualFallbacks,
      droppedLow,
      qualityBlocked,
      submitted,
      falsePositives,
      accepted,
      avgScanTimeMs: avg(scanTimes),
      avgOcrMs: avg(ocrTimes),
      p95ScanMs: p95(scanTimes),
      recent: ring.slice(-20),
    };
  };

  return {
    record(a) {
      ring.push({ scanSessionId, ...a });
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
      const head = 'ts,scannerType,detectionType,processingMs,ocrConfidence,imageQuality,validationResult,finalResult,failureReason,mode';
      const rows = ring.map((a) => [
        a.ts, a.scannerType, a.detectionType, a.processingMs,
        a.ocrConfidence ?? '', a.imageQuality ?? '', a.validationResult, a.finalResult,
        a.failureReason ?? '', a.mode ?? '',
      ].join(','));
      return [head, ...rows].join('\n');
    },
    get count() {
      return ring.length;
    },
  };
}

/** Read-only debug handle: console.table(window.__ayroviScanTelemetry.summary()). */
export function exposeDebugHandle(sink: TelemetrySink): void {
  if (typeof window === 'undefined') return;
  try {
    (window as any).__ayroviScanTelemetry = {
      summary: () => sink.summary(),
      csv: () => sink.toCSV(),
      clear: () => sink.clear(),
    };
  } catch { /* noop */ }
}
