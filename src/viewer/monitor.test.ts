// Tests for ViewerMonitor — the setInterval/JSON-parsing driver that bridges
// a real ViewerSession into the pure Watchdog. Uses the same session-level
// test doubles as session.test.ts (kept separate/self-contained per this
// codebase's convention — see camera/session.test.ts and viewer/session.test.ts
// each defining their own) plus a manual-interval seam for the monitor's own
// sampling timer, so every test is fully deterministic (no real waits).
//
// Added per the Task 10 review + Task 11: handleData was restructured to
// parse JSON to a discriminated {t} shape FIRST, then switch — 'hb' guarded
// on watchdog !== null INSIDE its branch (not a blanket early return), so
// 'alert' messages route through regardless of watchdog/monitoring state.

import { describe, expect, test } from 'bun:test';
import type { C2S, S2C } from '../../shared/protocol.ts';
import type { PeerOptions } from '../lib/peer.ts';
import { ViewerMonitor, type MonitorState } from './monitor.ts';
import {
  ViewerSession,
  type PeerLike,
  type RtpTransceiverLike,
  type SignalingLike,
  type TrackEventLike,
} from './session.ts';

// -- test doubles -------------------------------------------------------------

class MockSignaling implements SignalingLike {
  sent: C2S[] = [];
  connectCalls = 0;
  private messageCbs: Array<(msg: S2C) => void> = [];
  private reconnectedCbs: Array<() => void> = [];

  connect(): void {
    this.connectCalls++;
  }
  send(msg: C2S): void {
    this.sent.push(msg);
  }
  onMessage(cb: (msg: S2C) => void): () => void {
    this.messageCbs.push(cb);
    return () => {};
  }
  onReconnected(cb: () => void): () => void {
    this.reconnectedCbs.push(cb);
    return () => {};
  }

  // -- test drivers --
  receive(msg: S2C): void {
    for (const cb of [...this.messageCbs]) cb(msg);
  }
}

class MockPeer implements PeerLike {
  readonly remotePeerId: string;
  /** Empty-but-iterable (RTCStatsReport is Map-like); no frame-count assertions in this suite. */
  statsResult = new Map() as unknown as RTCStatsReport;
  private trackCbs: Array<(ev: TrackEventLike) => void> = [];
  private dataCbs: Array<(text: string) => void> = [];
  private connCbs: Array<(s: RTCPeerConnectionState) => void> = [];

  constructor(opts: PeerOptions) {
    this.remotePeerId = opts.remotePeerId;
  }

  handleSignal(_payload: unknown): Promise<void> {
    return Promise.resolve();
  }
  close(): void {}
  onTrack(cb: (ev: TrackEventLike) => void): () => void {
    this.trackCbs.push(cb);
    return () => {};
  }
  onDataMessage(cb: (text: string) => void): () => void {
    this.dataCbs.push(cb);
    return () => {};
  }
  onConnectionState(cb: (s: RTCPeerConnectionState) => void): () => void {
    this.connCbs.push(cb);
    return () => {};
  }
  getStats(): Promise<RTCStatsReport> {
    return Promise.resolve(this.statsResult);
  }
  // Task 12: this suite doesn't exercise talk-back; a bare stub satisfies
  // the interface (ViewerSession.adoptPeer calls it unconditionally).
  addTransceiver(): RtpTransceiverLike {
    return { sender: { replaceTrack: () => Promise.resolve() } };
  }

  // -- test drivers --
  emitTrack(stream: MediaStream): void {
    for (const cb of [...this.trackCbs]) cb({ streams: [stream] });
  }
  emitData(text: string): void {
    for (const cb of [...this.dataCbs]) cb(text);
  }
  setConnState(s: RTCPeerConnectionState): void {
    for (const cb of [...this.connCbs]) cb(s);
  }
}

/** Manually-driven interval seam — same pattern as camera/session.test.ts. */
class ManualIntervals {
  private nextId = 1;
  private intervals = new Map<number, () => void>();
  set = (fn: () => void, _ms: number): number => {
    const id = this.nextId++;
    this.intervals.set(id, fn);
    return id;
  };
  clear = (id: number): void => {
    this.intervals.delete(id);
  };
  get count(): number {
    return this.intervals.size;
  }
  /** Fire every registered interval callback once. */
  tick(): void {
    for (const fn of [...this.intervals.values()]) fn();
  }
}

function fakeStream(id: string): MediaStream {
  return { id } as unknown as MediaStream;
}

function makeHarness(opts: { now?: () => number } = {}) {
  const signaling = new MockSignaling();
  const location = { hash: '' };
  const peers: MockPeer[] = [];
  const session = new ViewerSession({
    signaling,
    location,
    createPeer: (o) => {
      const p = new MockPeer(o);
      peers.push(p);
      return p;
    },
  });
  const intervals = new ManualIntervals();
  const states: MonitorState[] = [];
  const alerts: Array<{ kind: 'noise' | 'motion'; at: number }> = [];
  const monitor = new ViewerMonitor({
    session,
    now: opts.now ?? (() => 0),
    setIntervalFn: intervals.set,
    clearIntervalFn: intervals.clear,
  });
  monitor.onState((s) => states.push(s));
  monitor.onAlert((kind, at) => alerts.push({ kind, at }));
  const last = () => states[states.length - 1]!;
  return { session, signaling, peers, intervals, states, alerts, monitor, last };
}

/** Drives a harness all the way to 'live' (first camera peer + track). */
function toLive(h: ReturnType<typeof makeHarness>, peerId = 'cam-1', streamId = 's1') {
  h.session.join('ABCD2345');
  h.signaling.receive({ type: 'room-joined', peerId: 'me-1', cameraPresent: true });
  h.signaling.receive({ type: 'signal', from: peerId, payload: 'offer' });
  h.peers[h.peers.length - 1]!.emitTrack(fakeStream(streamId));
}

// -- lifecycle ----------------------------------------------------------------

describe('lifecycle', () => {
  test('reaching live starts sampling: a Watchdog is constructed and the timer starts', () => {
    const h = makeHarness();
    toLive(h);
    expect(h.last()).toMatchObject({ active: true, down: false, downEpisode: 0 });
    expect(h.intervals.count).toBe(1);
  });

  test('ended stops sampling and resets state', () => {
    const h = makeHarness();
    toLive(h);
    h.signaling.receive({ type: 'room-closed' });
    expect(h.last()).toEqual({ active: false, down: false, lastLiveAt: null, downEpisode: 0 });
    expect(h.intervals.count).toBe(0);
  });

  test('rejoin after ended starts a fresh watchdog — no stale DOWN carries over', async () => {
    const t = { ms: 0 };
    const now = () => t.ms;
    const h = makeHarness({ now });
    toLive(h, 'cam-1', 's1');

    // Starve heartbeats past the default 6s grace window to trip DOWN.
    t.ms = 6001;
    h.intervals.tick();
    await Bun.sleep(0);
    expect(h.last().down).toBe(true);

    // Camera stops sharing: calm end, not an alarm.
    h.signaling.receive({ type: 'room-closed' });
    expect(h.last().active).toBe(false);

    // Rejoin: a brand-new Watchdog gets its OWN full grace window — it does
    // not inherit the previous episode's DOWN verdict or downEpisode count.
    toLive(h, 'cam-2', 's2');
    expect(h.last()).toMatchObject({ active: true, down: false, downEpisode: 0 });

    // And it takes a full fresh 6s window to alarm again (not an instant
    // re-trip from leftover state).
    t.ms = 6001 + 5_999;
    h.intervals.tick();
    await Bun.sleep(0);
    expect(h.last().down).toBe(false);

    t.ms = 6001 + 6_001;
    h.intervals.tick();
    await Bun.sleep(0);
    expect(h.last().down).toBe(true);
  });
});

// -- data-channel routing -------------------------------------------------------

describe('handleData routing', () => {
  test('hb messages route to the watchdog — regular heartbeats keep the verdict live', async () => {
    const t = { ms: 0 };
    const now = () => t.ms;
    const h = makeHarness({ now });
    toLive(h);

    for (let i = 0; i < 5; i++) {
      t.ms += 2000;
      h.peers[0]!.emitData(JSON.stringify({ t: 'hb', seq: i }));
      h.intervals.tick();
      await Bun.sleep(0);
    }
    expect(h.last().down).toBe(false);
  });

  test('alert messages route to onAlert with validated kind + at', () => {
    const h = makeHarness();
    toLive(h);

    h.peers[0]!.emitData(JSON.stringify({ t: 'alert', kind: 'noise', at: 12_345 }));
    h.peers[0]!.emitData(JSON.stringify({ t: 'alert', kind: 'motion', at: 6_789 }));
    expect(h.alerts).toEqual([
      { kind: 'noise', at: 12_345 },
      { kind: 'motion', at: 6_789 },
    ]);
  });

  test('alerts route to onAlert even before the watchdog exists (pre-live)', () => {
    const h = makeHarness();
    h.session.join('ABCD2345');
    h.signaling.receive({ type: 'room-joined', peerId: 'me-1', cameraPresent: true });
    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'offer' });
    // No track emitted yet: still 'waiting-camera' — no Watchdog constructed.
    h.peers[0]!.emitData(JSON.stringify({ t: 'alert', kind: 'motion', at: 1 }));
    expect(h.alerts).toEqual([{ kind: 'motion', at: 1 }]);
  });

  test('an alert with an invalid kind, missing/non-numeric at, or unrecognized shape is ignored', () => {
    const h = makeHarness();
    toLive(h);

    h.peers[0]!.emitData(JSON.stringify({ t: 'alert', kind: 'explosion', at: 1 }));
    h.peers[0]!.emitData(JSON.stringify({ t: 'alert', kind: 'noise', at: 'now' }));
    h.peers[0]!.emitData(JSON.stringify({ t: 'alert', kind: 'noise' }));
    h.peers[0]!.emitData(JSON.stringify({ t: 'alert' }));
    expect(h.alerts).toEqual([]);
  });

  test('garbage/non-JSON data messages are ignored without throwing', () => {
    const h = makeHarness();
    toLive(h);

    expect(() => h.peers[0]!.emitData('not json{{{')).not.toThrow();
    expect(() => h.peers[0]!.emitData('null')).not.toThrow(); // valid JSON, not an object
    expect(() => h.peers[0]!.emitData('42')).not.toThrow();
    expect(() => h.peers[0]!.emitData('"a string"')).not.toThrow();
    expect(() => h.peers[0]!.emitData(JSON.stringify({ t: 'mystery' }))).not.toThrow();
    expect(h.alerts).toEqual([]);
    expect(h.last().down).toBe(false);
  });
});
