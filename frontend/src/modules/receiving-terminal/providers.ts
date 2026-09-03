/**
 * Hardware-agnostic scanner input (unified P0 §22-§25).
 *
 * Receiving must NOT depend on the Camera API directly. All input the decode
 * pipeline consumes arrives through a `ScannerInput` source. Today we ship:
 *
 *   PHONE   — the built-in / attached camera (getUserMedia + media tracks)
 *   DEMO    — a synthetic moving label (dev/demo + simulated hardware seam)
 *
 * The same seam is where a future IndustrialScannerProvider / IR-assisted
 * provider plugs in (§24): it only has to produce frames (or codes) through
 * this interface and the whole shared pipeline — target detection, decode,
 * OCR, normalisation, validation, matching, confidence, Receiving integration
 * — is untouched. A hardware trigger (§25) maps to the same `start/stop` +
 * debounce entry points that auto-scan already uses.
 *
 * All *decisions* (constraint building, capability planning) are pure and
 * unit-tested; only the DOM/media plumbing lives in the provider bodies.
 */

import type { CameraConfig } from './scan-config';

export type ScannerInputKind = 'PHONE' | 'DEMO' | 'INDUSTRIAL';

export interface CameraCapabilitySummary {
  torch: boolean;
  focusModes: string[];
  exposureModes: string[];
  whiteBalanceModes: string[];
  /** null = not reported */
  frameRateMax: number | null;
}

export const EMPTY_CAPABILITY_SUMMARY: CameraCapabilitySummary = {
  torch: false,
  focusModes: [],
  exposureModes: [],
  whiteBalanceModes: [],
  frameRateMax: null,
};

/**
 * Read-only digest of a MediaStreamTrack's capabilities. Pure: takes anything
 * shaped like `{ getCapabilities(): ... }` so it is testable without a camera.
 */
export function summarizeTrackCapabilities(
  trackLike: { getCapabilities?: () => any } | null | undefined,
): CameraCapabilitySummary {
  if (!trackLike || typeof trackLike.getCapabilities !== 'function') {
    return EMPTY_CAPABILITY_SUMMARY;
  }
  try {
    const c: any = trackLike.getCapabilities() ?? {};
    return {
      torch: c.torch === true,
      focusModes: Array.isArray(c.focusMode) ? c.focusMode.map(String) : [],
      exposureModes: Array.isArray(c.exposureMode) ? c.exposureMode.map(String) : [],
      whiteBalanceModes: Array.isArray(c.whiteBalanceMode) ? c.whiteBalanceMode.map(String) : [],
      frameRateMax: typeof c.frameRate?.max === 'number' ? c.frameRate.max : null,
    };
  } catch {
    return EMPTY_CAPABILITY_SUMMARY;
  }
}

/**
 * Build the getUserMedia video constraint for a device class + facing.
 * Device-aware resolution (never always-max — order §4 / unified P0 §10).
 */
export function buildVideoConstraints(
  camera: CameraConfig,
  deviceType: keyof CameraConfig['resolution'],
  facing: 'environment' | 'user',
): MediaTrackConstraints {
  const res = camera.resolution[deviceType] ?? camera.resolution.UNKNOWN;
  const fr = camera.desiredFrameRate;
  return {
    facingMode: { ideal: facing },
    width: { ideal: res.width },
    height: { ideal: res.height },
    frameRate: { ideal: fr.ideal, max: fr.max },
  };
}

/**
 * Which `advanced` constraints to apply for the camera configuration, given
 * what the device actually advertises. Pure & unit-tested — never pushes a
 * capability the platform does not report (§10/§23).
 */
export function planAdvancedConstraints(
  summary: CameraCapabilitySummary,
  camera: CameraConfig,
): any[] {
  const advanced: any[] = [];
  if (summary.focusModes.includes(camera.focusMode)) {
    advanced.push({ focusMode: camera.focusMode });
  }
  if (summary.exposureModes.includes(camera.exposureMode)) {
    advanced.push({ exposureMode: camera.exposureMode });
  }
  if (summary.whiteBalanceModes.includes(camera.whiteBalanceMode)) {
    advanced.push({ whiteBalanceMode: camera.whiteBalanceMode });
  }
  if (typeof summary.frameRateMax === 'number' && summary.frameRateMax > 0) {
    const ideal = Math.min(camera.desiredFrameRate.ideal, summary.frameRateMax);
    advanced.push({ frameRate: { ideal, max: summary.frameRateMax } });
  }
  return advanced;
}

/** Uniform source consumed by the decode pipeline. */
export interface ScannerInput {
  readonly kind: ScannerInputKind;
  /** Current frame geometry; 0×0 until the first frame is available. */
  width(): number;
  height(): number;
  /** Start producing frames (camera = playing, demo = animating). */
  start(): Promise<void>;
  /** Stop producing frames and release anything held. */
  stop(): void;
  /** Draw the current frame into ctx at width×height. False = none yet. */
  drawTo(ctx: CanvasRenderingContext2D, width: number, height: number): boolean;
  readonly torchSupported: boolean;
  setTorch(on: boolean): Promise<boolean>;
  /** Native BarcodeDetector only makes sense for real camera frames. */
  allowNativeDetector(): boolean;
}

// ---------------------------------------------------------------------------
// PHONE — real camera behind the ScannerInput seam.
// ---------------------------------------------------------------------------

export interface PhoneInputDeps {
  mediaDevices: Pick<MediaDevices, 'getUserMedia'>;
  /** The <video> element that will display the feed. */
  video: HTMLVideoElement;
}

export interface PhoneOpenOptions {
  camera: CameraConfig;
  deviceType: keyof CameraConfig['resolution'];
  facing: 'environment' | 'user';
}

/** Open the real camera. Rejects with a user-actionable message on failure. */
export async function openPhoneScannerInput(
  deps: PhoneInputDeps,
  opts: PhoneOpenOptions,
): Promise<ScannerInput> {
  const { mediaDevices, video } = deps;
  let stream: MediaStream | null = null;
  let track: MediaStreamTrack | null = null;
  let stopped = false;
  let torchSupported = false;

  const constraints: MediaStreamConstraints = {
    audio: false,
    video: buildVideoConstraints(opts.camera, opts.deviceType, opts.facing),
  };

  try {
    stream = await mediaDevices.getUserMedia(constraints);
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? '');
    if (/NotAllowed|Permission|denied/i.test(msg)) {
      throw new Error('camera-permission-denied');
    }
    if (/NotFound|Requested device|Overconstrained/i.test(msg)) {
      throw new Error('no-camera-found');
    }
    throw new Error('camera-failed');
  }

  track = stream.getVideoTracks()[0] ?? null;
  const summary = summarizeTrackCapabilities(track as any);
  torchSupported = summary.torch;

  // Device capability layer (§23): apply ONLY what the device advertises —
  // continuous autofocus/exposure/white-balance and a capped frame rate.
  const advanced = planAdvancedConstraints(summary, opts.camera);
  if (track && advanced.length) {
    try {
      await track.applyConstraints({ advanced } as any);
    } catch { /* best-effort — a device may reject part of the tuning */ }
  }

  video.srcObject = stream;
  try {
    await video.play();
  } catch (playErr: any) {
    const soft = /abort|interrupt/i.test(
      String(playErr?.name ?? '') + String(playErr?.message ?? ''),
    );
    if (!soft) throw playErr;
    // Autoplay was interrupted (very common on phones): wait for a user
    // gesture-driven play or a real frame before giving up.
    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= 2) return resolve();
      const ok = () => resolve();
      const fail = () => reject(new Error('camera-failed'));
      video.addEventListener('playing', ok, { once: true });
      window.setTimeout(fail, 2500);
      video.play().catch(fail);
    });
  }

  return {
    kind: 'PHONE',
    width: () => (stopped ? 0 : video.videoWidth),
    height: () => (stopped ? 0 : video.videoHeight),
    async start() { /* already started by open */ },
    stop() {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      if (video) video.srcObject = null;
    },
    drawTo(ctx, w, h) {
      if (stopped || video.readyState < 2) return false;
      ctx.drawImage(video, 0, 0, w, h);
      return true;
    },
    get torchSupported() {
      return torchSupported;
    },
    async setTorch(on: boolean) {
      if (!track || !torchSupported) return false;
      try {
        await track.applyConstraints({ advanced: [{ torch: on }] as any });
        return true;
      } catch {
        return false;
      }
    },
    allowNativeDetector() {
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// DEMO — synthetic moving label (offline verification + hardware seam demo).
// ---------------------------------------------------------------------------
// Rendering a label with the SAME shape as the synthetic benchmark labels lets
// the full pipeline (line target → OCR → validate → match → dedupe → UI) run
// without a physical label, and doubles as the §25 simulated-trigger demo.

/** Codes the demo cycles through. A page may override with its own corpus. */
export const DEMO_CODES = [
  'SKU-100200300',
  'SO-88231-K',
  'ABO-123456',
  'CTN-000123',
];

export interface DemoInputDeps {
  /** Canvas the demo is drawn to AND displayed from. */
  canvas: HTMLCanvasElement;
  /** Override codes to show (should match the corpus for real matches). */
  codes?: string[];
  /** base scene width/height (canvas is sized to this on start). */
  frameWidth?: number;
  frameHeight?: number;
}

export function openDemoScannerInput(deps: DemoInputDeps): ScannerInput {
  const codes = (deps.codes && deps.codes.length ? deps.codes : DEMO_CODES).slice();
  const fw = deps.frameWidth ?? 1280;
  const fh = deps.frameHeight ?? 720;
  const canvas = deps.canvas;
  let running = false;
  let startedAt = 0;

  const draw = (now: number) => {
    if (!running) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const t = now - startedAt;
    const code = codes[(t > 0 ? Math.floor(t / 3200) % codes.length : 0)];

    // Scene background.
    ctx.fillStyle = '#23262c';
    ctx.fillRect(0, 0, fw, fh);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i < 14; i += 1) {
      const y = (i * 97 + Math.sin(t / 900 + i) * 30) % fh;
      ctx.fillRect(0, y, fw, 1);
    }

    // Label drifts gently side-to-side and breathes — like an unsteady hand.
    const dx = Math.sin(t / 1400) * 60;
    const breath = 1 + Math.sin(t / 500) * 0.008;
    const lw = 560 * breath;
    const lh = 150 * breath;
    const lx = (fw - lw) / 2 + dx;
    const ly = (fh - lh) / 2 + 20;

    ctx.save();
    ctx.translate(fw / 2, fh / 2);
    ctx.rotate(Math.sin(t / 2200) * 0.012);
    ctx.translate(-fw / 2, -fh / 2);

    ctx.fillStyle = '#f4f2ec';
    ctx.fillRect(lx, ly, lw, lh);
    ctx.strokeStyle = '#b9b4a6';
    ctx.lineWidth = 2;
    ctx.strokeRect(lx, ly, lw, lh);

    ctx.fillStyle = '#8a8577';
    ctx.font = '22px monospace';
    ctx.fillText('MADE IN TUNISIA · HAZ 3 · BOX 1/12', lx + 24, ly + 40);

    ctx.fillStyle = '#101014';
    ctx.font = 'bold 64px monospace';
    const codeX = lx + 24;
    ctx.fillText(code, codeX, ly + 118);
    ctx.restore();
  };

  return {
    kind: 'DEMO',
    width: () => (running ? fw : 0),
    height: () => (running ? fh : 0),
    async start() {
      canvas.width = fw;
      canvas.height = fh;
      running = true;
      startedAt = performance.now();

    },
    stop() {
      running = false;
    },
    drawTo(ctx, w, h) {
      if (!running) return false;
      const now = performance.now();
      draw(now);
      ctx.drawImage(canvas, 0, 0, w, h);
      return true;
    },
    get torchSupported() {
      return false;
    },
    async setTorch() {
      return false;
    },
    allowNativeDetector() {
      return false;
    },
  };
}
