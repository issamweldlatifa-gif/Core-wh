/**
 * Receiving — device-benchmark snapshot (final order §27/§38, ANNEX).
 *
 * Turns the in-memory telemetry attempts into the exact ANNEX columns the
 * order asks the developer to report per real device:
 *   p50/p90/p95/p99/max latency · success / retry / low-confidence /
 *   false-acceptance rates · per-decode-type latency & success
 *   (QR / Barcode / SKU-OCR / Reference-OCR) · avg fps / resolution /
 *   cpu cores / device memory probes (supplied by the caller, DOM-safe).
 *
 * Pure module: aggregation maths are unit-tested. Device-specific numbers
 * (fps, CPU %, RAM MB, network req/scan, frames/success) are measured on the
 * device with the runbook's DevTools steps — this module never fabricates them.
 */

import type { ScanAttempt } from './telemetry';

export interface DeviceProbes {
  method: 'software' | 'hardware';
  deviceType?: string;
  provider?: string;
  fpsAvg?: number;
  resolution?: string;
  cpuCores?: number;
  deviceMemoryGb?: number;
}

export interface DecodeSlice {
  /** attempts of that decode type with a measured processingMs */
  n: number;
  ok: number; // submitted (accepted|auto_submitted|worker_confirmed)
  /** measured processing times for this decode type */
  latencyMs: number[];
  p50: number;
  p95: number;
  p99: number;
  max: number;
  successRate: number; // ok / n (0 when n=0)
}

export interface DeviceSnapshot {
  capturedAt: number;
  method: DeviceProbes['method'];
  deviceType?: string;
  provider?: string;
  fpsAvg?: number;
  resolution?: string;
  cpuCores?: number;
  deviceMemoryGb?: number;
  attempts: number;
  /** overall latency distribution (ms) across all measured attempts */
  latency: { p50: number; p90: number; p95: number; p99: number; max: number };
  successRate: number;
  retryRate: number;
  lowConfidenceRate: number;
  falseAcceptRate: number;
  accepted: number;
  rejected: number;
  byDecode: Record<string, DecodeSlice>;
}

const SUBMIT_OK: string[] = ['accepted', 'auto_submitted', 'worker_confirmed'];
const PERCENTILES = [0.5, 0.9, 0.95, 0.99] as const;

function pct(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * q) - 1))] ?? 0;
}

function decodeLabel(a: ScanAttempt): string {
  const d = a.detectionType;
  if (d === 'QR' || d === 'BARCODE') return d;
  if (d === 'OCR') return a.targetType === 'REFERENCE' ? 'REFERENCE-OCR' : 'SKU-OCR';
  if (d === 'SCANNER') return 'SCANNER';
  return d;
}

/** Group per-attempt latency data by decode type + overall. */
export function buildDeviceSnapshot(attempts: ScanAttempt[], probes: DeviceProbes): DeviceSnapshot {
  const times = attempts.map((a) => a.processingMs).filter((x) => Number.isFinite(x) && x >= 0);
  const lat = (arr: number[]) => ({
    p50: pct(arr, 0.5), p90: pct(arr, 0.9), p95: pct(arr, 0.95), p99: pct(arr, 0.99),
    max: arr.length ? Math.max(...arr) : 0,
  });

  const byDecode: Record<string, DecodeSlice> = {};
  let accepted = 0;
  let rejected = 0;
  let retries = 0;
  let lowConf = 0;
  for (const a of attempts) {
    const key = decodeLabel(a);
    let slice = byDecode[key];
    if (!slice) {
      slice = byDecode[key] = { n: 0, ok: 0, latencyMs: [], p50: 0, p95: 0, p99: 0, max: 0, successRate: 0 };
    }
    slice.n += 1;
    const ok = SUBMIT_OK.includes(a.finalResult);
    if (ok) slice.ok += 1;
    if (Number.isFinite(a.processingMs) && a.processingMs >= 0) slice.latencyMs.push(a.processingMs);

    if (a.finalResult === 'accepted') accepted += 1;
    else if (a.finalResult === 'rejected') rejected += 1;
    if (a.finalResult === 'dropped_low_confidence' || a.finalResult === 'quality_gate_blocked') retries += 1;
    if (a.finalResult === 'dropped_low_confidence') lowConf += 1;
  }
  for (const slice of Object.values(byDecode)) {
    const l = lat(slice.latencyMs);
    slice.p50 = l.p50; slice.p95 = l.p95; slice.p99 = l.p99; slice.max = l.max;
    slice.successRate = slice.n ? slice.ok / slice.n : 0;
  }

  const n = attempts.length;
  return {
    capturedAt: Date.now(),
    method: probes.method,
    deviceType: probes.deviceType,
    provider: probes.provider,
    fpsAvg: probes.fpsAvg,
    resolution: probes.resolution,
    cpuCores: probes.cpuCores,
    deviceMemoryGb: probes.deviceMemoryGb,
    attempts: n,
    latency: lat(times),
    successRate: n ? accepted / n : 0,
    retryRate: n ? retries / n : 0,
    lowConfidenceRate: n ? lowConf / n : 0,
    falseAcceptRate: n ? rejected / n : 0,
    accepted,
    rejected,
    byDecode,
  };
}

/** DOM-safe device probes that a panel can fill in at capture time. */
export function readDeviceProbes(): { cpuCores?: number; deviceMemoryGb?: number } {
  if (typeof navigator === 'undefined') return {};
  const out: { cpuCores?: number; deviceMemoryGb?: number } = {};
  try {
    const cc = (navigator as any).hardwareConcurrency;
    if (typeof cc === 'number' && cc > 0) out.cpuCores = cc;
    const dm = (navigator as any).deviceMemory;
    if (typeof dm === 'number' && dm > 0) out.deviceMemoryGb = dm;
  } catch { /* ignore */ }
  return out;
}

/** Render a snapshot as one CSV row (append per device per method). */
export function deviceSnapshotRow(s: DeviceSnapshot): string {
  const d = s.byDecode;
  const cell = (x?: number | string) => (x === undefined || x === '' ? '' : x);
  const dl = (k: string) => d[k] ?? { n: 0, ok: 0, successRate: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const qr = dl('QR'); const bc = dl('BARCODE'); const sku = dl('SKU-OCR'); const ref = dl('REFERENCE-OCR');
  return [
    cell(s.capturedAt), cell(s.method), cell(s.deviceType), cell(s.provider),
    cell(s.cpuCores), cell(s.deviceMemoryGb), cell(s.fpsAvg), cell(s.resolution),
    cell(s.attempts),
    s.latency.p50, s.latency.p90, s.latency.p95, s.latency.p99, s.latency.max,
    s.accepted, s.rejected, s.retryRate, s.lowConfidenceRate, s.falseAcceptRate,
    qr.n, qr.ok, qr.successRate, qr.p50, qr.p95, qr.p99, qr.max,
    bc.n, bc.ok, bc.successRate, bc.p50, bc.p95, bc.p99, bc.max,
    sku.n, sku.ok, sku.successRate, sku.p50, sku.p95, sku.p99, sku.max,
    ref.n, ref.ok, ref.successRate, ref.p50, ref.p95, ref.p99, ref.max,
  ].join(',');
}

export const DEVICE_SNAPSHOT_HEADER =
  'capturedAt,method,deviceType,provider,cpuCores,deviceMemoryGb,fpsAvg,resolution,' +
  'attempts,p50,p90,p95,p99,max,accepted,rejected,retryRate,lowConfRate,falseAcceptRate,' +
  'qrN,qrOk,qrRate,qrP50,qrP95,qrP99,qrMax,' +
  'bcN,bcOk,bcRate,bcP50,bcP95,bcP99,bcMax,' +
  'skuN,skuOk,skuRate,skuP50,skuP95,skuP99,skuMax,' +
  'refN,refOk,refRate,refP50,refP95,refP99,refMax';

/**
 * Augment an existing debug handle (exposeDebugHandle) with a live `.snapshot()`
 * / `.snapshotCsv()` that the developer calls on-device (runbook §…):
 *   copy(window.__ayroviScanTelemetry.snapshotCsv())
 * Fills in cpuCores/deviceMemory from the browser at call time; fps/resolution
 * come from the panel probe provider. Pure device numbers are never guessed.
 */
export function exposeBenchmarkSnapshot(
  sink: { dump(): ScanAttempt[] },
  key: string,
  probes: () => DeviceProbes,
): void {
  if (typeof window === 'undefined') return;
  try {
    const handle: any = (window as any)[key] ?? {};
    handle.snapshot = () => buildDeviceSnapshot(sink.dump(), { ...probes(), ...readDeviceProbes() });
    handle.snapshotCsv = () => {
      const s = handle.snapshot();
      return `${DEVICE_SNAPSHOT_HEADER}\n${deviceSnapshotRow(s)}`;
    };
    (window as any)[key] = handle;
  } catch { /* noop */ }
}
