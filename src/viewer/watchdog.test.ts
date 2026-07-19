// Tests for Watchdog — pure stream-health verdict engine, no timers of its
// own. Every test drives a fake clock explicitly and calls tick() itself, so
// this suite is fully deterministic (no fake-timer flakiness, no real waits).

import { describe, expect, test } from 'bun:test';
import { Watchdog, type WatchdogReason, type WatchdogState } from './watchdog.ts';

/** Simple mutable fake clock: `now()` reads `t.ms`; tests advance it directly. */
function makeClock(startAt = 0) {
  const t = { ms: startAt };
  return { t, now: () => t.ms };
}

describe('Watchdog — heartbeat grace window', () => {
  test('never receiving a heartbeat still alarms after the grace window (3 x 2000ms)', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });

    t.ms = 5999;
    expect(wd.tick()).toBe('live'); // just under the 6000ms grace window

    t.ms = 6001;
    expect(wd.tick()).toBe('down');
  });

  test('grace window is measured from start-of-monitoring, not from epoch 0', () => {
    const { t, now } = makeClock(100_000); // arbitrary non-zero construction time
    const wd = new Watchdog({ now });

    t.ms = 100_000 + 5_999;
    expect(wd.tick()).toBe('live');

    t.ms = 100_000 + 6_001;
    expect(wd.tick()).toBe('down');
  });

  test('a healthy stream that stops sending heartbeats alarms 6000ms after the LAST one', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });

    wd.onHeartbeat(); // t=0
    t.ms = 2000;
    wd.onHeartbeat();
    t.ms = 4000;
    wd.onHeartbeat();
    expect(wd.tick()).toBe('live');

    // Heartbeats stop. Just under 6000ms since the last one (t=4000): still live.
    t.ms = 4000 + 5_999;
    expect(wd.tick()).toBe('live');

    // Just over: down.
    t.ms = 4000 + 6_001;
    expect(wd.tick()).toBe('down');
  });

  test('normal jitter (1.9s/2.1s cadence) never trips the alarm', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });

    const deltas = [1900, 2100, 1900, 2100, 1900, 2100, 2000, 1950, 2050];
    for (const d of deltas) {
      t.ms += d;
      wd.onHeartbeat();
      expect(wd.tick()).toBe('live');
    }
  });
});

describe('Watchdog — frame-stall detection', () => {
  test('framesDecoded unchanged for >5000ms alarms, even with healthy heartbeats', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });

    wd.onHeartbeat();
    wd.onFrameCount(10); // baseline set, t=0
    t.ms = 1000;
    wd.onHeartbeat();
    wd.onFrameCount(20); // advancing, baseline resets to t=1000
    expect(wd.tick()).toBe('live');

    // Frame count freezes at 20 (frozen-frame-looks-live case) while
    // heartbeats keep arriving on schedule.
    t.ms = 1000 + 4_999;
    wd.onHeartbeat();
    wd.onFrameCount(20);
    expect(wd.tick()).toBe('live');

    t.ms = 1000 + 5_001;
    wd.onHeartbeat();
    wd.onFrameCount(20);
    expect(wd.tick()).toBe('down');
  });

  test('a stream that never produces a frame is caught by the heartbeat check, not the frame check', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });
    // onFrameCount is never called: frame baseline stays null, so (b) never
    // fires on its own — but (a) still trips at the grace window.
    t.ms = 5999;
    expect(wd.tick()).toBe('live');
    t.ms = 6001;
    expect(wd.tick()).toBe('down');
  });

  test('first onFrameCount call only sets the baseline; it never alarms by itself', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });
    wd.onHeartbeat();
    wd.onFrameCount(0);
    t.ms = 100;
    wd.onHeartbeat();
    expect(wd.tick()).toBe('live');
  });

  test('a frame count that goes DOWN (peer replaced, fresh RTCStats counter) resets the stall clock', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });
    wd.onHeartbeat();
    wd.onFrameCount(500); // old peer's high count
    t.ms = 4000;
    wd.onHeartbeat();
    wd.onFrameCount(0); // new peer's fresh counter — lower, but it's a change
    expect(wd.tick()).toBe('live'); // must not be treated as "unchanged for 4000ms"

    // Now genuinely stalls at 0 for >5000ms.
    t.ms = 4000 + 5_001;
    wd.onHeartbeat();
    wd.onFrameCount(0);
    expect(wd.tick()).toBe('down');
  });
});

describe('Watchdog — connection state', () => {
  test('connectionState "failed" is an immediate DOWN regardless of heartbeats/frames', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });
    wd.onHeartbeat();
    wd.onFrameCount(10);
    wd.onConnectionState('failed');
    expect(wd.tick()).toBe('down');
  });

  test('connectionState "disconnected" is an immediate DOWN', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });
    wd.onHeartbeat();
    wd.onConnectionState('disconnected');
    expect(wd.tick()).toBe('down');
  });

  test('healthy connection states do not trip the alarm on their own', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });
    wd.onHeartbeat();
    for (const s of ['new', 'connecting', 'connected'] as const) {
      wd.onConnectionState(s);
      t.ms += 100;
      wd.onHeartbeat();
      expect(wd.tick()).toBe('live');
    }
  });
});

describe('Watchdog — recovery', () => {
  test('fresh heartbeats + advancing frames + healthy connection clear a heartbeat-caused alarm', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });
    t.ms = 6001;
    expect(wd.tick()).toBe('down');

    wd.onHeartbeat();
    wd.onFrameCount(1);
    expect(wd.tick()).toBe('live');
  });

  test('recovery from a connection-state DOWN requires the state to move off failed/disconnected', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });
    wd.onHeartbeat();
    wd.onConnectionState('failed');
    expect(wd.tick()).toBe('down');

    // Heartbeats alone don't recover it while connState is still 'failed'.
    wd.onHeartbeat();
    expect(wd.tick()).toBe('down');

    wd.onConnectionState('connected');
    wd.onHeartbeat();
    expect(wd.tick()).toBe('live');
  });

  test('reset() grants a fresh grace period (e.g. on peer adoption/replacement)', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });
    t.ms = 6001;
    expect(wd.tick()).toBe('down');

    wd.reset();
    // No heartbeat yet post-reset, but we are back inside a fresh grace window.
    expect(wd.tick()).toBe('live');

    // And the fresh window still expires on schedule if nothing else arrives.
    t.ms += 6001;
    expect(wd.tick()).toBe('down');
  });
});

describe('Watchdog — onStateChange', () => {
  test('fires only on transitions, with the tripping reason', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });
    const seen: Array<[WatchdogState, WatchdogReason]> = [];
    wd.onStateChange((s, reason) => seen.push([s, reason]));

    t.ms = 1000;
    expect(wd.tick()).toBe('live'); // no transition: no callback
    t.ms = 2000;
    expect(wd.tick()).toBe('live'); // still no transition
    expect(seen).toEqual([]);

    t.ms = 6001;
    wd.tick(); // live -> down
    t.ms = 6100;
    wd.tick(); // still down: no additional callback

    wd.onHeartbeat();
    wd.tick(); // down -> live

    expect(seen).toEqual([
      ['down', 'heartbeats'],
      ['live', 'recovered'],
    ]);
  });

  test('unsubscribe stops delivery', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({ now });
    const seen: WatchdogState[] = [];
    const unsub = wd.onStateChange((s) => seen.push(s));
    unsub();

    t.ms = 6001;
    wd.tick();
    expect(seen).toEqual([]);
  });

  test('connection-caused and frame-caused transitions report the matching reason', () => {
    const { now } = makeClock();
    const wd1 = new Watchdog({ now });
    const seen1: WatchdogReason[] = [];
    wd1.onStateChange((_s, r) => seen1.push(r));
    wd1.onConnectionState('failed');
    wd1.tick();
    expect(seen1).toEqual(['connection']);

    const { t: t2, now: now2 } = makeClock();
    const wd2 = new Watchdog({ now: now2 });
    const seen2: WatchdogReason[] = [];
    wd2.onStateChange((_s, r) => seen2.push(r));
    wd2.onHeartbeat();
    wd2.onFrameCount(1);
    wd2.tick();
    t2.ms = 5001;
    wd2.onHeartbeat(); // keep heartbeats healthy so only the frame check trips
    wd2.tick();
    expect(seen2).toEqual(['frames']);
  });
});

describe('Watchdog — configurable thresholds', () => {
  test('custom heartbeatIntervalMs/missedBeats/frameStallMs are honored', () => {
    const { t, now } = makeClock();
    const wd = new Watchdog({
      now,
      heartbeatIntervalMs: 1000,
      missedBeats: 2,
      frameStallMs: 3000,
    });
    // grace window = 2000ms now
    t.ms = 1999;
    expect(wd.tick()).toBe('live');
    t.ms = 2001;
    expect(wd.tick()).toBe('down');
  });
});
