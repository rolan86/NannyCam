// Tests for ThresholdDetector — pure threshold/sustain/hysteresis/cooldown
// state machine shared by the noise and motion detectors (Task 11). Every
// test drives a fake clock explicitly and calls sample() itself, so this
// suite is fully deterministic (no fake-timer flakiness, no real waits) —
// same style as watchdog.test.ts.
//
// createNoiseSource/createMotionSource (the thin browser-API sources) are
// deliberately NOT unit tested here — see the doc comment on each in
// detectors.ts for why, and src/camera/session.test.ts for the wiring tests
// that exercise them via injected fakes.

import { describe, expect, test } from 'bun:test';
import { ThresholdDetector } from './detectors.ts';

/** Simple mutable fake clock: `now()` reads `t.ms`; tests advance it directly. */
function makeClock(startAt = 0) {
  const t = { ms: startAt };
  return { t, now: () => t.ms };
}

/** Noise-shaped config per spec: sustain 500ms, hysteresis 0.7, cooldown 10s. */
function noiseDetector(now: () => number, threshold = 0.2) {
  return new ThresholdDetector({
    now,
    threshold,
    sustainMs: 500,
    hysteresisRatio: 0.7,
    cooldownMs: 10_000,
  });
}

describe('ThresholdDetector — sustain (noise config: 500ms)', () => {
  test('does not fire on a single instantaneous over-threshold sample', () => {
    const { now } = makeClock();
    const d = noiseDetector(now);
    expect(d.sample(0.5)).toBe(false);
  });

  test('fires exactly once once the value has stayed >= threshold for >= sustainMs', () => {
    const { t, now } = makeClock();
    const d = noiseDetector(now);
    expect(d.sample(0.5)).toBe(false); // t=0: over-threshold run begins
    t.ms = 499;
    expect(d.sample(0.5)).toBe(false); // not sustained yet
    t.ms = 500;
    expect(d.sample(0.5)).toBe(true); // sustained: fires
    t.ms = 501;
    expect(d.sample(0.5)).toBe(false); // no immediate re-fire
  });

  test('a sample dropping below threshold resets the sustain timer', () => {
    const { t, now } = makeClock();
    const d = noiseDetector(now);
    d.sample(0.5); // t=0: over-threshold run begins
    t.ms = 400;
    expect(d.sample(0.1)).toBe(false); // drops below threshold: resets the run
    t.ms = 800; // 400ms since the reset — even though 800ms since the ORIGINAL start
    expect(d.sample(0.5)).toBe(false); // not yet sustained
    t.ms = 900; // 100ms since the restart at t=800
    expect(d.sample(0.5)).toBe(false);
    t.ms = 1300; // 500ms since the restart at t=800: sustained
    expect(d.sample(0.5)).toBe(true);
  });
});

describe('ThresholdDetector — hysteresis (lower bound = threshold * ratio)', () => {
  test('a value that never drops below the lower bound cannot re-fire, even long after cooldown elapses', () => {
    const { t, now } = makeClock();
    const threshold = 0.2; // lower bound = 0.14
    const d = noiseDetector(now, threshold);
    d.sample(threshold); // t=0
    t.ms = 500;
    expect(d.sample(threshold)).toBe(true); // first fire

    // Value sits exactly at threshold forever after — never dips below 0.14.
    t.ms = 11_000; // cooldown (10s) long elapsed
    expect(d.sample(threshold)).toBe(false); // hysteresis never re-armed: blocked
  });

  test('hovering between the lower bound and threshold after a fire never re-arms', () => {
    const { t, now } = makeClock();
    const threshold = 0.2; // lower bound = 0.14
    const d = noiseDetector(now, threshold);
    d.sample(threshold); // t=0
    t.ms = 500;
    expect(d.sample(threshold)).toBe(true); // first fire

    t.ms = 600;
    expect(d.sample(0.15)).toBe(false); // dips below threshold but NOT below 0.14 lower bound
    t.ms = 1100;
    expect(d.sample(threshold)).toBe(false); // over-threshold run restarts here
    t.ms = 1600; // 500ms sustained again
    expect(d.sample(threshold)).toBe(false); // sustained, but still never re-armed
    t.ms = 20_000; // long past cooldown too
    expect(d.sample(threshold)).toBe(false); // still blocked — 0.15 never re-arms it
  });
});

describe('ThresholdDetector — re-fire after drop below lower bound + cooldown', () => {
  test('re-fires once the value drops below the lower bound AND the cooldown has elapsed', () => {
    const { t, now } = makeClock();
    const threshold = 0.2; // lower bound = 0.14
    const d = noiseDetector(now, threshold);
    d.sample(threshold); // t=0
    t.ms = 500;
    expect(d.sample(threshold)).toBe(true); // first fire

    t.ms = 600;
    expect(d.sample(0.1)).toBe(false); // drops below the lower bound: re-armed

    t.ms = 10_600; // over-threshold run restarts here; cooldown (elapses at t=10_500) is over
    expect(d.sample(threshold)).toBe(false); // sustain not met yet (0ms since restart)
    t.ms = 11_100; // 500ms since restart
    expect(d.sample(threshold)).toBe(true); // sustained, armed, cooldown elapsed: fires
  });
});

describe('ThresholdDetector — cooldown dominates even when re-armed', () => {
  test('cooldown blocks a re-fire even though hysteresis has already re-armed', () => {
    const { t, now } = makeClock();
    const threshold = 0.2;
    const d = noiseDetector(now, threshold);
    d.sample(threshold); // t=0
    t.ms = 500;
    expect(d.sample(threshold)).toBe(true); // first fire

    t.ms = 600;
    expect(d.sample(0.05)).toBe(false); // well below the lower bound: re-armed immediately

    t.ms = 1100; // over-threshold run restarts here
    expect(d.sample(threshold)).toBe(false); // sustain not met yet
    t.ms = 1600; // sustained 500ms, armed — but cooldown (elapses at t=10_500) is not
    expect(d.sample(threshold)).toBe(false);
    t.ms = 10_499; // just before cooldown elapses
    expect(d.sample(threshold)).toBe(false);
    t.ms = 10_600; // cooldown elapsed
    expect(d.sample(threshold)).toBe(true);
  });
});

describe('ThresholdDetector — motion config (sustainMs: 0)', () => {
  test('fires on the first over-threshold sample — no sustain required', () => {
    const { now } = makeClock();
    const d = new ThresholdDetector({
      now,
      threshold: 0.1,
      sustainMs: 0,
      hysteresisRatio: 0.7,
      cooldownMs: 10_000,
    });
    expect(d.sample(0.1)).toBe(true);
  });

  test('still respects hysteresis + cooldown on subsequent samples', () => {
    const { t, now } = makeClock();
    const d = new ThresholdDetector({
      now,
      threshold: 0.1,
      sustainMs: 0,
      hysteresisRatio: 0.7,
      cooldownMs: 10_000,
    });
    expect(d.sample(0.1)).toBe(true); // t=0: immediate fire
    t.ms = 1;
    expect(d.sample(0.1)).toBe(false); // never dropped below the lower bound: blocked
    t.ms = 2;
    expect(d.sample(0.05)).toBe(false); // drops below lower bound (0.07): re-armed
    t.ms = 3; // cooldown not elapsed
    expect(d.sample(0.1)).toBe(false);
    t.ms = 10_001; // cooldown elapsed
    expect(d.sample(0.1)).toBe(true);
  });
});

describe('ThresholdDetector — setThreshold', () => {
  test('changes the active threshold (and its derived lower bound) for subsequent samples', () => {
    const { now } = makeClock();
    const d = new ThresholdDetector({
      now,
      threshold: 0.5,
      sustainMs: 0,
      hysteresisRatio: 0.7,
      cooldownMs: 10_000,
    });
    expect(d.sample(0.3)).toBe(false); // below the original threshold
    d.setThreshold(0.2);
    expect(d.sample(0.3)).toBe(true); // now above the lowered threshold
  });
});
