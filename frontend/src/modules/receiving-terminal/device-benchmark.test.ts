import { describe, expect, it } from 'vitest';
import {
  buildDeviceSnapshot, deviceSnapshotRow, DEVICE_SNAPSHOT_HEADER,
} from './device-benchmark';
import type { ScanAttempt } from './telemetry';

function att(over: Partial<ScanAttempt>): ScanAttempt {
  return {
    ts: 1, scannerType: 'zxing', detectionType: 'BARCODE', processingMs: 10,
    validationResult: 'na', finalResult: 'accepted', ...over,
  } as ScanAttempt;
}

describe('device-benchmark snapshot (final order §27/§38)', () => {
  it('groups by decode type with per-type latency percentiles', () => {
    const attempts: ScanAttempt[] = [
      att({ detectionType: 'QR', processingMs: 30, finalResult: 'accepted' }),
      att({ detectionType: 'QR', processingMs: 60, finalResult: 'accepted' }),
      att({ detectionType: 'QR', processingMs: 300, finalResult: 'accepted' }),
      att({ detectionType: 'BARCODE', processingMs: 5, finalResult: 'accepted' }),
      att({ detectionType: 'BARCODE', processingMs: 7, finalResult: 'accepted' }),
      att({ detectionType: 'OCR', targetType: 'SKU', processingMs: 220, finalResult: 'auto_submitted' }),
      att({ detectionType: 'OCR', targetType: 'REFERENCE', processingMs: 240, finalResult: 'dropped_low_confidence' }),
    ];
    const s = buildDeviceSnapshot(attempts, { method: 'software' });
    expect(s.attempts).toBe(7);
    // accepted = backend-accepted only; auto_submitted awaits verdict, the
    // REFERENCE OCR low-confidence drop never submits.
    expect(s.accepted).toBe(5);
    expect(s.byDecode.QR.n).toBe(3);
    expect(s.byDecode.QR.ok).toBe(3);
    expect(s.byDecode.QR.p50).toBe(60);
    expect(s.byDecode.QR.p95).toBe(300);
    expect(s.byDecode.QR.max).toBe(300);
    expect(s.byDecode['SKU-OCR'].n).toBe(1);
    expect(s.byDecode['SKU-OCR'].ok).toBe(1);
    expect(s.byDecode['REFERENCE-OCR'].n).toBe(1);
    expect(s.byDecode['REFERENCE-OCR'].ok).toBe(0); // low-confidence → retry
    expect(s.retryRate).toBeCloseTo(1 / 7, 5);
    expect(s.lowConfidenceRate).toBeCloseTo(1 / 7, 5);
  });

  it('percentiles are monotonic and max is >= p99', () => {
    const attempts = Array.from({ length: 200 }, (_, i) => att({ detectionType: 'QR', processingMs: 40 + (i % 97) }));
    const s = buildDeviceSnapshot(attempts, { method: 'software' });
    expect(s.latency.p50).toBeLessThanOrEqual(s.latency.p90);
    expect(s.latency.p90).toBeLessThanOrEqual(s.latency.p95);
    expect(s.latency.p95).toBeLessThanOrEqual(s.latency.p99);
    expect(s.latency.max).toBeGreaterThanOrEqual(s.latency.p99);
  });

  it('hardware SCANNER rows land in their own decode slice', () => {
    const attempts: ScanAttempt[] = [
      att({ detectionType: 'SCANNER', scanMethod: 'hardware', processingMs: 0.02, finalResult: 'accepted' }),
      att({ detectionType: 'SCANNER', scanMethod: 'hardware', processingMs: 0.03, finalResult: 'rejected' }),
    ];
    const s = buildDeviceSnapshot(attempts, { method: 'hardware' });
    expect(s.byDecode.SCANNER.n).toBe(2);
    expect(s.byDecode.SCANNER.ok).toBe(1);
    expect(s.accepted).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.falseAcceptRate).toBeCloseTo(1 / 2, 5);
  });

  it('csv row length matches the header', () => {
    const attempts = [att({ detectionType: 'QR', processingMs: 30 })];
    const s = buildDeviceSnapshot(attempts, { method: 'software', fpsAvg: 30, resolution: '1280x720' });
    const row = deviceSnapshotRow(s);
    expect(row.split(',').length).toBe(DEVICE_SNAPSHOT_HEADER.split(',').length);
    expect(row).toContain('30'); // fps
    expect(row).toContain('software');
  });
});
