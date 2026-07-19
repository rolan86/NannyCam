// NannyCam client-side detectors (Task 11) — noise (audio RMS) and motion
// (canvas frame-diff) alerts. Computed entirely on the camera device; the
// detector VALUES (RMS levels, diff fractions) never leave this process —
// only the resulting {t:'alert'} events cross the data channel (see
// src/camera/session.ts), and per spec no alert data ever transits or
// persists on any server (docs/superpowers/specs/2026-07-19-nannycam-
// design.md, Privacy section).
//
// ThresholdDetector below is pure and unit-tested (detectors.test.ts): fed
// synthetic values on an injected clock, no timers/DOM of its own. The two
// browser "sources" further down (createNoiseSource, createMotionSource) are
// deliberately thin and NOT unit tested — see their own doc comments for
// why — session.ts injects fakes for them in its own wiring tests instead.

// -- ThresholdDetector --------------------------------------------------------

export interface ThresholdDetectorOptions {
  /** Injected clock (ms), e.g. () => Date.now(). */
  now: () => number;
  /** Value must be >= this to count as "over threshold". */
  threshold: number;
  /**
   * Value must stay >= threshold continuously for this many ms before an
   * over-threshold run can fire. 0 means "fire on the first over-threshold
   * sample" (the motion config — see the design doc's config table).
   */
  sustainMs: number;
  /**
   * Re-fire eligibility bound: after firing, the value must drop below
   * `threshold * hysteresisRatio` at least once before the detector is
   * eligible to fire again (independent of the cooldown below).
   */
  hysteresisRatio: number;
  /** Minimum ms between two fires, regardless of hysteresis re-arming. */
  cooldownMs: number;
}

/**
 * Shared threshold/sustain/hysteresis/cooldown state machine for both the
 * noise and motion detectors — same shape, different numbers (see
 * NOISE_* / MOTION_* constants below).
 *
 * Semantics (see detectors.test.ts for the pinned cases):
 *   - `sample(value)` returns true exactly when an alert fires this call.
 *   - The value must be >= threshold for >= sustainMs CONTINUOUSLY: any
 *     sample below threshold resets the "over-threshold since" timestamp.
 *   - Re-fire ELIGIBILITY (independent of sustain) requires the value to
 *     have dropped below `threshold * hysteresisRatio` at least once since
 *     the last fire — hovering between the lower bound and the threshold
 *     itself never re-arms it.
 *   - Even once re-armed and sustained again, a fire is blocked until
 *     `cooldownMs` has elapsed since the last fire — cooldown and hysteresis
 *     are independent gates; both must be satisfied.
 *   - Initial state is armed (a fresh detector's first sustained run can
 *     fire without any prior drop).
 */
export class ThresholdDetector {
  private readonly now: () => number;
  private threshold: number;
  private readonly sustainMs: number;
  private readonly hysteresisRatio: number;
  private readonly cooldownMs: number;

  /** Timestamp the CURRENT over-threshold run began; null when not currently over. */
  private overSince: number | null = null;
  /** Timestamp of the last fire; null before the first one. */
  private lastFireAt: number | null = null;
  /** Re-fire eligibility; starts true (see class doc). */
  private armed = true;

  constructor(opts: ThresholdDetectorOptions) {
    this.now = opts.now;
    this.threshold = opts.threshold;
    this.sustainMs = opts.sustainMs;
    this.hysteresisRatio = opts.hysteresisRatio;
    this.cooldownMs = opts.cooldownMs;
  }

  /** Apply a new threshold live (e.g. a sensitivity slider change). */
  setThreshold(t: number): void {
    this.threshold = t;
  }

  /** Feed one synchronous sample; returns true exactly when an alert fires. */
  sample(value: number): boolean {
    const t = this.now();
    const lowerBound = this.threshold * this.hysteresisRatio;

    if (value < lowerBound) this.armed = true;

    if (value < this.threshold) {
      this.overSince = null;
      return false;
    }
    if (this.overSince === null) this.overSince = t;

    if (t - this.overSince < this.sustainMs) return false;
    if (!this.armed) return false;
    if (this.lastFireAt !== null && t - this.lastFireAt < this.cooldownMs) return false;

    this.lastFireAt = t;
    this.armed = false;
    return true;
  }
}

// -- shared config (spec defaults) --------------------------------------------

export const NOISE_SUSTAIN_MS = 500;
export const NOISE_HYSTERESIS_RATIO = 0.7;
export const NOISE_COOLDOWN_MS = 10_000;

export const MOTION_SUSTAIN_MS = 0;
export const MOTION_HYSTERESIS_RATIO = 0.7;
export const MOTION_COOLDOWN_MS = 10_000;

/**
 * Threshold ranges the camera UI's sensitivity sliders map into (see
 * sensitivityToThreshold below). Noise thresholds are RMS of
 * getFloatTimeDomainData samples (0..~1); motion thresholds are the
 * fraction of the 160x120 sample grid whose luma changed beyond the
 * per-pixel delta (0..1). These ranges are deliberately narrow bands
 * covering "quiet room / occasional loud talking" and "still room /
 * someone walking through frame" respectively — not the full 0..1 space.
 */
export const NOISE_THRESHOLD_RANGE = { min: 0.02, max: 0.3 } as const;
export const MOTION_THRESHOLD_RANGE = { min: 0.01, max: 0.2 } as const;

export const DEFAULT_SENSITIVITY = 50;

/**
 * Sensitivity (0-100, 100 = most sensitive i.e. fires most easily) → an
 * inverse-linear threshold across [range.min, range.max]. 100 maps to
 * range.min (easiest to trip), 0 maps to range.max (hardest to trip).
 * Documented mapping used by both the camera UI sliders (src/camera/
 * main.tsx) and the session's persisted-settings defaults, so both sides
 * agree on what a given slider position means.
 */
export function sensitivityToThreshold(
  sensitivity: number,
  range: { min: number; max: number },
): number {
  const s = Math.min(100, Math.max(0, sensitivity));
  return range.max - (s / 100) * (range.max - range.min);
}

/** Inverse of sensitivityToThreshold, for rendering a persisted threshold back onto a slider. */
export function thresholdToSensitivity(
  threshold: number,
  range: { min: number; max: number },
): number {
  const t = Math.min(range.max, Math.max(range.min, threshold));
  return ((range.max - t) / (range.max - range.min)) * 100;
}

export const DEFAULT_NOISE_THRESHOLD = sensitivityToThreshold(
  DEFAULT_SENSITIVITY,
  NOISE_THRESHOLD_RANGE,
);
export const DEFAULT_MOTION_THRESHOLD = sensitivityToThreshold(
  DEFAULT_SENSITIVITY,
  MOTION_THRESHOLD_RANGE,
);

// -- browser sources (thin, NOT unit tested) ----------------------------------
//
// Both of these wrap a real browser API on a plain setInterval/clearInterval
// and hand raw numbers to a callback — there is no branching logic worth
// pinning with a tests-with-fakes suite that jsdom/bun:test can't exercise
// faithfully anyway (AnalyserNode and canvas 2D pixel data have no bun-test
// shim). session.ts takes both as injectable factory options so ITS wiring
// (threshold feed → alert broadcast) is fully testable with fake sources;
// see session.test.ts's "detectors" describe block.

/** The slice of AudioContext createNoiseSource needs; the real AudioContext satisfies it. */
export interface AudioContextLike {
  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode;
  createAnalyser(): AnalyserNode;
}

/**
 * Noise source: an AnalyserNode fed by `stream`'s audio track(s), sampled
 * 4x/s (every 250ms). Each sample computes the RMS (root-mean-square) of
 * `getFloatTimeDomainData` — the standard "how loud is it right now" measure
 * — and reports it via onLevel. Returns {stop()} to tear the analyser +
 * interval down; safe to call once.
 */
export function createNoiseSource(
  stream: MediaStream,
  ctx: AudioContextLike,
  onLevel: (rms: number) => void,
): { stop(): void } {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const id = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sumSquares = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i]!;
      sumSquares += v * v;
    }
    onLevel(Math.sqrt(sumSquares / buf.length));
  }, 250); // 4x/s
  return {
    stop() {
      clearInterval(id);
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
    },
  };
}

const MOTION_SAMPLE_WIDTH = 160;
const MOTION_SAMPLE_HEIGHT = 120;
/** Per-pixel luma delta (0-255) above which a pixel counts as "changed". */
const MOTION_LUMA_DELTA_THRESHOLD = 25;

/**
 * Motion source: draws `videoEl`'s current frame into a hidden 160x120
 * canvas at 2fps (every 500ms — bounded CPU/heat per spec) and diffs it
 * against the previous frame's luma (perceptual brightness) per pixel.
 * Reports the fraction of the 160x120 grid whose luma changed by more than
 * MOTION_LUMA_DELTA_THRESHOLD via onFraction. The very first sample only
 * establishes a baseline (nothing to diff against yet) and reports nothing.
 * Returns {stop()}; safe to call once. No-ops (silently) if the canvas 2D
 * context is unavailable.
 */
export function createMotionSource(
  videoEl: HTMLVideoElement,
  onFraction: (fraction: number) => void,
): { stop(): void } {
  const canvas = document.createElement('canvas');
  canvas.width = MOTION_SAMPLE_WIDTH;
  canvas.height = MOTION_SAMPLE_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) return { stop() {} };

  let prev: Uint8ClampedArray | null = null;
  const id = setInterval(() => {
    // Not ready yet (e.g. preview element mounted before the first frame).
    if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return;
    ctx.drawImage(videoEl, 0, 0, MOTION_SAMPLE_WIDTH, MOTION_SAMPLE_HEIGHT);
    const frame = ctx.getImageData(0, 0, MOTION_SAMPLE_WIDTH, MOTION_SAMPLE_HEIGHT).data;
    if (prev !== null) {
      let changed = 0;
      const pixelCount = MOTION_SAMPLE_WIDTH * MOTION_SAMPLE_HEIGHT;
      for (let i = 0; i < frame.length; i += 4) {
        const lumaCur = 0.299 * frame[i]! + 0.587 * frame[i + 1]! + 0.114 * frame[i + 2]!;
        const lumaPrev = 0.299 * prev[i]! + 0.587 * prev[i + 1]! + 0.114 * prev[i + 2]!;
        if (Math.abs(lumaCur - lumaPrev) > MOTION_LUMA_DELTA_THRESHOLD) changed++;
      }
      onFraction(changed / pixelCount);
    }
    prev = frame;
  }, 500); // 2fps
  return {
    stop() {
      clearInterval(id);
    },
  };
}
