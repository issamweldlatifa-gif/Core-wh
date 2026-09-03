/**
 * Single configuration source for the guided scanner + OCR pipeline (P0).
 *
 * Order §11: “confidence … قابل للضبط من Configuration وليس hard-coded”.
 * Everything tunable — camera policy, OCR cadence, quality gate, consensus,
 * validation distance, confidence weights and level thresholds — lives here.
 * The initial numeric values are deliberately CONSERVATIVE and flagged
 * `tune:` so they can be re-set from the real-label benchmark (§17) without
 * touching pipeline code.
 */

export interface RoiRatio {
  w: number;
  h: number;
}

export interface CameraConfig {
  /** Resolution request per device class (never “always max” — §4). */
  resolution: {
    SMARTPHONE: { width: number; height: number };
    TABLET: { width: number; height: number };
    DESKTOP: { width: number; height: number };
    UNKNOWN: { width: number; height: number };
  };
  /** applyConstraints capability list we try (only supported members are used). */
  focusMode: string;
  exposureMode: string;
  whiteBalanceMode: string;
  desiredFrameRate: { ideal: number; max: number };
  /** ROI (as fractions of the frame) per scan mode (§5 — adjustable per label type). */
  roi: {
    CARTON: RoiRatio; // wide band: shipping/carton labels
    PRODUCT: RoiRatio; // taller band: small product / SKU labels
  };
}

export interface OcrConfig {
  /** Frames of pure-barcode failure before OCR is allowed to start (§17). */
  framesBeforeOcr: number;
  /** Only 1 of N frames may trigger OCR while barcode keeps failing. */
  ocrCadence: number;
  /** Downscale/large ROI before OCR to bound Tesseract latency. */
  ocrMaxWidth: number;
  /** Upscale factor used by the “small text” profile (capped by ocrMaxWidth). */
  smallTextUpscale: number;
  /** Gate: DO NOT run OCR when the quality check reports worse than this. */
  qualityGateLevel: 'GOOD' | 'MARGINAL' | 'BAD';
  /** Whether the image-quality gate is enabled at all (§6). */
  qualityGateEnabled: boolean;
}

export interface ConsensusConfig {
  /** Votes (weighted frames) required before an OCR token is stable. */
  votesRequired: number;
  /** Sliding window in frames — a lone old vote cannot accumulate forever. */
  windowFrames: number;
}

export interface DuplicateConfig {
  /** Same value is not resubmitted inside this window. */
  repeatWindowMs: number;
  /** Pause after an accepted read before decoding resumes. */
  resumeDelayMs: number;
}

export interface ValidationConfig {
  /** Nearest-corpus lookup distance threshold for a “candidate match” (§10). */
  maxCandidateDistance: number;
  /** Confusable glyph substitutions cost this much (0.5 < full edit = 1). */
  confusableSubstitutionCost: number;
  /** Max “possible match” entries shown/kept. */
  maxCandidates: number;
  /** When no corpus is supplied, database factor stays neutral (this value). */
  noCorpusNeutralScore: number;
  /** Exact DB hit is always this score. */
  exactMatchScore: number;
}

export interface ConfidenceWeights {
  /** Weight of the image-quality score (0..1). */
  quality: number;
  /** Weight of the OCR engine confidence (0..1). */
  ocr: number;
  /** Weight of field-format plausibility (0..1). */
  format: number;
  /** Weight of the corpus/database match (0..1). */
  database: number;
}

export interface ConfidenceConfig {
  weights: ConfidenceWeights;
  /** Multi-frame consensus bonus (0..1 added after the weighted mean). */
  consensusBonusMax: number;
  /** Composite thresholds — level mapping (§11). tune: real benchmark. */
  thresholds: { high: number; medium: number };
}

export interface TelemetryConfig {
  /** Max in-memory attempt records kept (ring). */
  maxAttempts: number;
}

export interface ScanConfig {
  camera: CameraConfig;
  ocr: OcrConfig;
  consensus: ConsensusConfig;
  duplicate: DuplicateConfig;
  validation: ValidationConfig;
  confidence: ConfidenceConfig;
  telemetry: TelemetryConfig;
}

/** Default configuration — production-conservative. Override per-deployment or
 *  per-benchmark via `mergeConfig`. tune: values to revisit after real labels. */
export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  camera: {
    resolution: {
      SMARTPHONE: { width: 1280, height: 720 },
      TABLET: { width: 1280, height: 720 },
      DESKTOP: { width: 1920, height: 1080 },
      UNKNOWN: { width: 1280, height: 720 },
    },
    focusMode: 'continuous',
    exposureMode: 'continuous',
    whiteBalanceMode: 'continuous',
    desiredFrameRate: { ideal: 30, max: 60 },
    roi: {
      CARTON: { w: 0.82, h: 0.3 },
      PRODUCT: { w: 0.64, h: 0.42 },
    },
  },
  ocr: {
    framesBeforeOcr: 18,
    ocrCadence: 8,
    ocrMaxWidth: 960, // tune after real-device latency benchmark
    smallTextUpscale: 2,
    qualityGateLevel: 'MARGINAL', // MARGINAL passes; BAD is refused
    qualityGateEnabled: true,
  },
  consensus: {
    votesRequired: 3,
    windowFrames: 12,
  },
  duplicate: {
    repeatWindowMs: 2500,
    resumeDelayMs: 900,
  },
  validation: {
    maxCandidateDistance: 1.2,
    confusableSubstitutionCost: 0.5,
    maxCandidates: 3,
    noCorpusNeutralScore: 0.5,
    exactMatchScore: 1,
  },
  confidence: {
    weights: { quality: 0.2, ocr: 0.3, format: 0.2, database: 0.3 },
    consensusBonusMax: 0.08,
    // tune: conservative until the §17 benchmark gives real numbers.
    thresholds: { high: 82, medium: 58 },
  },
  telemetry: {
    maxAttempts: 500,
  },
};

export type DeepPartial<T> = { [K in keyof T]?: DeepPartial<T[K]> };

/** Merge a partial override over the defaults (deep, for nested config). */
export function mergeConfig(base: ScanConfig, patch: DeepPartial<ScanConfig>): ScanConfig {
  const out: any = { ...base };
  for (const key of Object.keys(patch) as (keyof ScanConfig)[]) {
    const pv = patch[key];
    const bv = base[key];
    if (pv === undefined) continue;
    if (bv && typeof bv === 'object' && pv && typeof pv === 'object') {
      out[key] = mergeConfig(bv as any, pv as any);
    } else {
      out[key] = pv;
    }
  }
  return out as ScanConfig;
}
