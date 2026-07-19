// Tests for CameraSession — mock signaling, mock peers, fake storage, fake
// media, manual intervals. Fully deterministic; no browser APIs.

import { describe, expect, test } from 'bun:test';
import type { C2S, S2C } from '../../shared/protocol.ts';
import type { PeerOptions } from '../lib/peer.ts';
import type { AudioContextLike } from './detectors.ts';
import {
  CameraSession,
  HEARTBEAT_INTERVAL_MS,
  STORAGE_CODE_KEY,
  STORAGE_DETECT_MOTION_ENABLED_KEY,
  STORAGE_DETECT_MOTION_THRESHOLD_KEY,
  STORAGE_DETECT_NOISE_ENABLED_KEY,
  STORAGE_DETECT_NOISE_THRESHOLD_KEY,
  STORAGE_TOKEN_KEY,
  type CameraState,
  type DetectorSettings,
  type PeerLike,
  type RemoteAudioEntry,
  type SignalingLike,
  type TrackEventLike,
  type VisibilityLike,
  type WakeLockLike,
} from './session.ts';

// -- test doubles -----------------------------------------------------------

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
  reconnect(): void {
    for (const cb of [...this.reconnectedCbs]) cb();
  }
  /** Messages of one C2S type, in send order. */
  ofType<T extends C2S['type']>(type: T): Array<Extract<C2S, { type: T }>> {
    return this.sent.filter((m): m is Extract<C2S, { type: T }> => m.type === type);
  }
}

class MockPeer implements PeerLike {
  readonly remotePeerId: string;
  readonly sendSignal: (payload: unknown) => void;
  tracks: Array<{ track: MediaStreamTrack; stream: MediaStream }> = [];
  sentData: string[] = [];
  closed = false;
  /** Payloads whose handleSignal call has STARTED (chain-order probe). */
  started: unknown[] = [];
  private resolvers: Array<() => void> = [];
  private dataOpen = false;
  private openCbs: Array<() => void> = [];
  private stateCbs: Array<(s: RTCPeerConnectionState) => void> = [];
  private trackCbs: Array<(ev: TrackEventLike) => void> = [];

  constructor(opts: PeerOptions) {
    this.remotePeerId = opts.remotePeerId;
    this.sendSignal = opts.sendSignal;
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): unknown {
    this.tracks.push({ track, stream });
    return undefined;
  }
  handleSignal(payload: unknown): Promise<void> {
    this.started.push(payload);
    return new Promise((res) => this.resolvers.push(res));
  }
  sendData(text: string): boolean {
    if (!this.dataOpen) return false;
    this.sentData.push(text);
    return true;
  }
  close(): void {
    this.closed = true;
  }
  get isDataOpen(): boolean {
    return this.dataOpen;
  }
  onDataOpen(cb: () => void): () => void {
    this.openCbs.push(cb);
    return () => {};
  }
  onConnectionState(cb: (s: RTCPeerConnectionState) => void): () => void {
    this.stateCbs.push(cb);
    return () => {};
  }
  onTrack(cb: (ev: TrackEventLike) => void): () => void {
    this.trackCbs.push(cb);
    return () => {
      this.trackCbs = this.trackCbs.filter((f) => f !== cb);
    };
  }

  // -- test drivers --
  openData(): void {
    this.dataOpen = true;
    for (const cb of [...this.openCbs]) cb();
  }
  finishOneSignal(): void {
    const res = this.resolvers.shift();
    if (res === undefined) throw new Error('no in-flight handleSignal');
    res();
  }
  setConnState(s: RTCPeerConnectionState): void {
    for (const cb of [...this.stateCbs]) cb(s);
  }
  /** Task 12: simulate an inbound audio track (a viewer's PTT mic). */
  emitTrack(kind: 'audio' | 'video', stream: MediaStream): void {
    for (const cb of [...this.trackCbs]) cb({ track: { kind }, streams: [stream] });
  }
  /** Task 12: a track event with no associated stream (defensive edge case). */
  emitBareTrack(kind: 'audio' | 'video'): void {
    for (const cb of [...this.trackCbs]) cb({ track: { kind }, streams: [] });
  }
}

class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class ManualIntervals {
  private nextId = 1;
  private intervals = new Map<number, { fn: () => void; ms: number }>();

  set = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.intervals.set(id, { fn, ms });
    return id;
  };
  clear = (id: number): void => {
    this.intervals.delete(id);
  };
  get count(): number {
    return this.intervals.size;
  }
  delays(): number[] {
    return [...this.intervals.values()].map((i) => i.ms);
  }
  /** Fire every registered interval callback once (one simulated period). */
  tick(): void {
    for (const { fn } of [...this.intervals.values()]) fn();
  }
}

class FakeSentinel {
  released = false;
  release(): Promise<void> {
    this.released = true;
    return Promise.resolve();
  }
}

/**
 * Recording wake lock. In auto mode requests resolve immediately (next
 * microtask); in manual mode each request stays pending until its recorded
 * `resolve()` is called — for the acquire-vs-stop race tests.
 */
class ManualWakeLock implements WakeLockLike {
  requests: Array<{ sentinel: FakeSentinel; resolve: () => void }> = [];
  constructor(private auto: boolean) {}
  request(_type: 'screen'): Promise<FakeSentinel> {
    const sentinel = new FakeSentinel();
    if (this.auto) {
      this.requests.push({ sentinel, resolve: () => {} });
      return Promise.resolve(sentinel);
    }
    let resolveFn!: (s: FakeSentinel) => void;
    const promise = new Promise<FakeSentinel>((res) => {
      resolveFn = res;
    });
    this.requests.push({ sentinel, resolve: () => resolveFn(sentinel) });
    return promise;
  }
}

interface FakeTrack extends MediaStreamTrack {
  stopped: boolean;
}

function fakeTrack(kind: 'audio' | 'video'): FakeTrack {
  const t = {
    kind,
    stopped: false,
    stop() {
      t.stopped = true;
    },
  };
  return t as unknown as FakeTrack;
}

function fakeStream(tracks: FakeTrack[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

/** Records every noise/motion source the fake factory creates, drivable from tests. */
function makeFakeNoiseSourceFactory() {
  const created: Array<{ fire: (rms: number) => void; stopped: boolean }> = [];
  const factory = (
    _stream: MediaStream,
    _ctx: AudioContextLike,
    onLevel: (rms: number) => void,
  ) => {
    const rec = { fire: onLevel, stopped: false };
    created.push(rec);
    return {
      stop() {
        rec.stopped = true;
      },
    };
  };
  return { factory, created };
}

function makeFakeMotionSourceFactory() {
  const created: Array<{ fire: (fraction: number) => void; stopped: boolean }> = [];
  const factory = (_videoEl: HTMLVideoElement, onFraction: (fraction: number) => void) => {
    const rec = { fire: onFraction, stopped: false };
    created.push(rec);
    return {
      stop() {
        rec.stopped = true;
      },
    };
  };
  return { factory, created };
}

function makeHarness(
  opts: {
    persisted?: { code: string; token: string };
    manualWakeLock?: boolean;
    /** Clock seam for detector tests (sustain/cooldown windows); defaults to Date.now. */
    now?: () => number;
    /** Initial detector settings (test seam — see loadDetectorSettings's doc). */
    detectors?: Partial<DetectorSettings>;
  } = {},
) {
  const signaling = new MockSignaling();
  const storage = new FakeStorage();
  if (opts.persisted) {
    storage.setItem(STORAGE_CODE_KEY, opts.persisted.code);
    storage.setItem(STORAGE_TOKEN_KEY, opts.persisted.token);
  }
  const location = { origin: 'https://cam.test', hash: '' };
  const tracks = [fakeTrack('video'), fakeTrack('audio')];
  const stream = fakeStream(tracks);
  const peers: MockPeer[] = [];
  const intervals = new ManualIntervals();
  const wake = new ManualWakeLock(!(opts.manualWakeLock ?? false));
  let visibilityState = 'visible';
  const visibilityCbs: Array<() => void> = [];
  const visibility: VisibilityLike = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(_type, cb) {
      visibilityCbs.push(cb);
    },
  };
  const states: CameraState[] = [];
  const noiseSources = makeFakeNoiseSourceFactory();
  const motionSources = makeFakeMotionSourceFactory();
  const session = new CameraSession({
    signaling,
    storage,
    location,
    getMedia: () => Promise.resolve(stream),
    createPeer: (o) => {
      const p = new MockPeer(o);
      peers.push(p);
      return p;
    },
    setIntervalFn: intervals.set,
    clearIntervalFn: intervals.clear,
    wakeLock: wake,
    visibility,
    now: opts.now,
    // The real default (`new AudioContext()`) doesn't exist under bun test;
    // the fake noise-source factory below never touches this value anyway.
    audioContextFactory: () => ({}) as unknown as AudioContextLike,
    createNoiseSource: noiseSources.factory,
    createMotionSource: motionSources.factory,
    detectors: opts.detectors,
  });
  session.onState((s) => states.push(s));
  const fireVisibility = (state: string) => {
    visibilityState = state;
    for (const cb of [...visibilityCbs]) cb();
  };
  const last = () => states[states.length - 1]!;
  return {
    session, signaling, storage, location, stream, tracks, peers,
    intervals, wake, states, last, fireVisibility, noiseSources, motionSources,
  };
}

const fakeVideoEl = {} as unknown as HTMLVideoElement;

function fakeRemoteStream(id: string): MediaStream {
  return { id } as unknown as MediaStream;
}

const ROOM_CREATED: S2C = {
  type: 'room-created',
  code: 'ABCD2345',
  cameraToken: 'tok-fresh',
  peerId: 'cam-1',
};

// -- entry ladder -----------------------------------------------------------

describe('entry ladder', () => {
  test('no persisted code+token → create-room; room-created → live + persisted', async () => {
    const h = makeHarness();
    await h.session.start();
    expect(h.signaling.connectCalls).toBe(1);
    expect(h.signaling.sent).toEqual([{ type: 'create-room' }]);
    expect(h.last().phase).toBe('connecting');

    h.signaling.receive(ROOM_CREATED);
    expect(h.last()).toMatchObject({
      phase: 'live',
      roomCode: 'ABCD2345',
      viewerUrl: 'https://cam.test/viewer.html#ABCD2345',
      viewerCount: 0,
    });
    expect(h.storage.getItem(STORAGE_CODE_KEY)).toBe('ABCD2345');
    expect(h.storage.getItem(STORAGE_TOKEN_KEY)).toBe('tok-fresh');
    expect(h.location.hash).toBe('#ABCD2345');
  });

  test('persisted code+token → reclaim-room; ack keeps identity', async () => {
    const h = makeHarness({ persisted: { code: 'ABCD2345', token: 'tok-old' } });
    await h.session.start();
    expect(h.signaling.sent).toEqual([
      { type: 'reclaim-room', code: 'ABCD2345', cameraToken: 'tok-old' },
    ]);
    // Reclaim ack is room-created echoing code+token with a NEW peerId.
    h.signaling.receive({ ...ROOM_CREATED, cameraToken: 'tok-old' });
    expect(h.last().phase).toBe('live');
    expect(h.storage.getItem(STORAGE_TOKEN_KEY)).toBe('tok-old');
  });

  test('reclaim → bad-code → recreate-room with the same code, fresh token stored', async () => {
    const h = makeHarness({ persisted: { code: 'ABCD2345', token: 'tok-old' } });
    await h.session.start();
    h.signaling.receive({ type: 'error', reason: 'bad-code' });
    expect(h.signaling.sent[1]).toEqual({ type: 'recreate-room', code: 'ABCD2345' });

    h.signaling.receive(ROOM_CREATED); // fresh token in the ack
    expect(h.last().phase).toBe('live');
    expect(h.storage.getItem(STORAGE_TOKEN_KEY)).toBe('tok-fresh');
  });

  test('reclaim → bad-token → token cleared, fall back to create-room', async () => {
    const h = makeHarness({ persisted: { code: 'ABCD2345', token: 'tok-wrong' } });
    await h.session.start();
    h.signaling.receive({ type: 'error', reason: 'bad-token' });
    expect(h.storage.getItem(STORAGE_TOKEN_KEY)).toBeNull();
    expect(h.signaling.sent[1]).toEqual({ type: 'create-room' });

    h.signaling.receive({ ...ROOM_CREATED, code: 'FRESH234', cameraToken: 'tok-new' });
    expect(h.last().roomCode).toBe('FRESH234');
    expect(h.storage.getItem(STORAGE_CODE_KEY)).toBe('FRESH234');
    expect(h.storage.getItem(STORAGE_TOKEN_KEY)).toBe('tok-new');
  });

  test('rate-limited during the ladder → phase error', async () => {
    const h = makeHarness();
    await h.session.start();
    h.signaling.receive({ type: 'error', reason: 'rate-limited' });
    expect(h.last().phase).toBe('error');
    expect(h.last().error).toContain('Rate limited');
  });

  test('error:invalid is ignored (stale-queued-signal noise)', async () => {
    const h = makeHarness();
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.signaling.receive({ type: 'error', reason: 'invalid' });
    expect(h.last().phase).toBe('live');
  });

  test('reclaim → bad-code → recreate → bad-code → identity cleared, create-room (final rung)', async () => {
    const h = makeHarness({ persisted: { code: 'ABCD2345', token: 'tok-old' } });
    await h.session.start();
    h.signaling.receive({ type: 'error', reason: 'bad-code' }); // reclaim refused
    h.signaling.receive({ type: 'error', reason: 'bad-code' }); // recreate refused
    expect(h.storage.getItem(STORAGE_CODE_KEY)).toBeNull();
    expect(h.storage.getItem(STORAGE_TOKEN_KEY)).toBeNull();
    expect(h.signaling.sent).toEqual([
      { type: 'reclaim-room', code: 'ABCD2345', cameraToken: 'tok-old' },
      { type: 'recreate-room', code: 'ABCD2345' },
      { type: 'create-room' },
    ]);
    h.signaling.receive({ ...ROOM_CREATED, code: 'FRESH234' });
    expect(h.last()).toMatchObject({ phase: 'live', roomCode: 'FRESH234' });
  });

  test('rate-limited tears down fully and Retry works', async () => {
    const h = makeHarness();
    await h.session.start();
    await Bun.sleep(0); // wake acquisition settles
    h.signaling.receive({ type: 'error', reason: 'rate-limited' });
    expect(h.last().phase).toBe('error');
    // Nothing left hot: camera released, wake lock released.
    expect(h.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.session.localStream).toBeNull();
    expect(h.wake.requests[0]!.sentinel.released).toBe(true);

    // Retry: start() must run again, not bounce off a stale running flag.
    await h.session.start();
    expect(h.last().phase).toBe('connecting');
    expect(h.signaling.ofType('create-room')).toHaveLength(2);
    h.signaling.receive(ROOM_CREATED);
    expect(h.last().phase).toBe('live');
  });

  test('getMedia failure → phase error, no signaling traffic', async () => {
    const signaling = new MockSignaling();
    const session = new CameraSession({
      signaling,
      storage: new FakeStorage(),
      location: { origin: 'https://cam.test', hash: '' },
      getMedia: () => Promise.reject(new Error('NotAllowedError')),
    });
    const states: CameraState[] = [];
    session.onState((s) => states.push(s));
    await session.start();
    expect(states[states.length - 1]!.phase).toBe('error');
    expect(signaling.sent).toEqual([]);
  });
});

// -- peers ------------------------------------------------------------------

describe('peers', () => {
  async function live(opts: Parameters<typeof makeHarness>[0] = {}) {
    const h = makeHarness(opts);
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    return h;
  }

  test('peer-joined → Peer created with all local tracks, viewerCount up', async () => {
    const h = await live();
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    expect(h.peers).toHaveLength(1);
    const peer = h.peers[0]!;
    expect(peer.remotePeerId).toBe('viewer-1');
    expect(peer.tracks.map((t) => t.track)).toEqual(h.tracks);
    expect(peer.tracks.every((t) => t.stream === h.stream)).toBe(true);
    expect(h.last().viewerCount).toBe(1);
  });

  test('outbound signals are wrapped with the viewer peerId', async () => {
    const h = await live();
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    h.peers[0]!.sendSignal({ kind: 'candidate', candidate: null });
    expect(h.signaling.ofType('signal')).toEqual([
      { type: 'signal', to: 'viewer-1', payload: { kind: 'candidate', candidate: null } },
    ]);
  });

  test('inbound signals are serial-awaited per peer', async () => {
    const h = await live();
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    const peer = h.peers[0]!;
    h.signaling.receive({ type: 'signal', from: 'viewer-1', payload: 'A' });
    h.signaling.receive({ type: 'signal', from: 'viewer-1', payload: 'B' });
    await Bun.sleep(0); // flush microtasks
    // B must NOT start until A's handleSignal resolves (Peer contract).
    expect(peer.started).toEqual(['A']);
    peer.finishOneSignal();
    await Bun.sleep(0);
    expect(peer.started).toEqual(['A', 'B']);
  });

  test('signal from an unknown peer is ignored', async () => {
    const h = await live();
    h.signaling.receive({ type: 'signal', from: 'stranger', payload: 'x' });
    expect(h.peers).toHaveLength(0);
  });

  test('peer-left → peer closed, heartbeat cleared, count down', async () => {
    const h = await live();
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    h.peers[0]!.openData();
    expect(h.intervals.count).toBe(1);
    h.signaling.receive({ type: 'peer-left', peerId: 'viewer-1' });
    expect(h.peers[0]!.closed).toBe(true);
    expect(h.intervals.count).toBe(0);
    expect(h.last().viewerCount).toBe(0);
  });

  test('duplicate peer-joined (roster replay) rebuilds the peer cleanly', async () => {
    const h = await live();
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    expect(h.peers).toHaveLength(2);
    expect(h.peers[0]!.closed).toBe(true);
    expect(h.peers[1]!.closed).toBe(false);
    expect(h.last().viewerCount).toBe(1);
  });
});

// -- heartbeat ---------------------------------------------------------------

describe('heartbeat', () => {
  test('starts on data-channel open at 2 s; seq increments per send', async () => {
    const h = makeHarness();
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    const peer = h.peers[0]!;
    expect(h.intervals.count).toBe(0); // not before the channel opens

    peer.openData();
    expect(h.intervals.delays()).toEqual([HEARTBEAT_INTERVAL_MS]);
    h.intervals.tick();
    h.intervals.tick();
    h.intervals.tick();
    expect(peer.sentData).toEqual([
      JSON.stringify({ t: 'hb', seq: 0 }),
      JSON.stringify({ t: 'hb', seq: 1 }),
      JSON.stringify({ t: 'hb', seq: 2 }),
    ]);
  });

  test('per-peer sequences are independent', async () => {
    const h = makeHarness();
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.signaling.receive({ type: 'peer-joined', peerId: 'v1' });
    h.signaling.receive({ type: 'peer-joined', peerId: 'v2' });
    h.peers[0]!.openData();
    h.intervals.tick(); // only v1's heartbeat runs
    h.peers[1]!.openData();
    h.intervals.tick(); // both run
    expect(h.peers[0]!.sentData).toEqual([
      JSON.stringify({ t: 'hb', seq: 0 }),
      JSON.stringify({ t: 'hb', seq: 1 }),
    ]);
    expect(h.peers[1]!.sentData).toEqual([JSON.stringify({ t: 'hb', seq: 0 })]);
  });
});

// -- reconnect (rung 2) ------------------------------------------------------

describe('signaling reconnect', () => {
  test('rebuilds cleanly: peers closed, ladder re-run, roster replay recreates', async () => {
    const h = makeHarness();
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    h.peers[0]!.openData();

    h.signaling.reconnect();
    expect(h.peers[0]!.closed).toBe(true);
    expect(h.intervals.count).toBe(0);
    expect(h.last()).toMatchObject({ phase: 'connecting', viewerCount: 0 });
    // Ladder re-runs with the persisted identity → reclaim.
    expect(h.signaling.sent[h.signaling.sent.length - 1]).toEqual({
      type: 'reclaim-room',
      code: 'ABCD2345',
      cameraToken: 'tok-fresh',
    });

    // Server ack (new peerId) + roster replay.
    h.signaling.receive({ ...ROOM_CREATED, peerId: 'cam-2' });
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    expect(h.last()).toMatchObject({ phase: 'live', viewerCount: 1 });
    expect(h.peers).toHaveLength(2);
    expect(h.peers[1]!.closed).toBe(false);
  });

  test('reconnect while not running is a no-op', () => {
    const h = makeHarness();
    h.signaling.reconnect();
    expect(h.signaling.sent).toEqual([]);
    expect(h.last().phase).toBe('idle');
  });
});

// -- visibility (rung 3) -----------------------------------------------------

describe('visibilitychange → visible', () => {
  test('re-acquires wake lock; closes only dead peers', async () => {
    const h = makeHarness();
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.signaling.receive({ type: 'peer-joined', peerId: 'v1' });
    h.signaling.receive({ type: 'peer-joined', peerId: 'v2' });
    h.peers[0]!.setConnState('failed');
    h.peers[1]!.setConnState('connected');
    await Bun.sleep(0); // let start()'s wake acquisition settle
    const wakeBefore = h.wake.requests.length;

    h.fireVisibility('hidden'); // no sweep while hidden
    expect(h.peers[0]!.closed).toBe(false);

    h.fireVisibility('visible');
    expect(h.wake.requests.length).toBe(wakeBefore + 1);
    expect(h.peers[0]!.closed).toBe(true); // dead → cleaned up
    expect(h.peers[1]!.closed).toBe(false); // healthy → untouched
    expect(h.last().viewerCount).toBe(1);
  });
});

// -- wake lock ---------------------------------------------------------------

describe('wake lock', () => {
  test('stop() releases the held sentinel', async () => {
    const h = makeHarness();
    await h.session.start();
    await Bun.sleep(0); // acquisition settles
    h.signaling.receive(ROOM_CREATED);
    expect(h.wake.requests).toHaveLength(1);
    expect(h.wake.requests[0]!.sentinel.released).toBe(false);

    h.session.stop();
    expect(h.wake.requests[0]!.sentinel.released).toBe(true);
  });

  test('request resolving AFTER stop() is released, not re-held', async () => {
    const h = makeHarness({ manualWakeLock: true });
    await h.session.start(); // request now in flight, unresolved
    h.signaling.receive(ROOM_CREATED);
    h.session.stop(); // nothing held yet — nothing to release

    h.wake.requests[0]!.resolve(); // the race: resolution lands post-stop
    await Bun.sleep(0);
    expect(h.wake.requests[0]!.sentinel.released).toBe(true);
  });

  test('single acquire in flight; re-acquire on visible releases the old sentinel', async () => {
    const h = makeHarness({ manualWakeLock: true });
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    expect(h.wake.requests).toHaveLength(1);

    // While the first request is still pending, visible events must not
    // stack a second request.
    h.fireVisibility('visible');
    expect(h.wake.requests).toHaveLength(1);

    h.wake.requests[0]!.resolve();
    await Bun.sleep(0);
    h.fireVisibility('visible'); // genuine re-acquire
    expect(h.wake.requests).toHaveLength(2);
    h.wake.requests[1]!.resolve();
    await Bun.sleep(0);
    expect(h.wake.requests[0]!.sentinel.released).toBe(true); // old: released
    expect(h.wake.requests[1]!.sentinel.released).toBe(false); // new: held
  });
});

// -- stop --------------------------------------------------------------------

describe('stop', () => {
  test('sends stop-camera, closes peers, clears persistence + fragment + media', async () => {
    const h = makeHarness();
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    h.peers[0]!.openData();

    h.session.stop();
    expect(h.signaling.ofType('stop-camera')).toEqual([
      { type: 'stop-camera', code: 'ABCD2345', cameraToken: 'tok-fresh' },
    ]);
    expect(h.peers[0]!.closed).toBe(true);
    expect(h.intervals.count).toBe(0);
    expect(h.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.session.localStream).toBeNull();
    expect(h.storage.getItem(STORAGE_CODE_KEY)).toBeNull();
    expect(h.storage.getItem(STORAGE_TOKEN_KEY)).toBeNull();
    expect(h.location.hash).toBe('');
    expect(h.last()).toMatchObject({ phase: 'stopped', viewerCount: 0 });
    expect(h.last().roomCode).toBeUndefined();
  });

  test('messages after stop are ignored; start again mints a fresh room', async () => {
    const h = makeHarness();
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.session.stop();

    h.signaling.receive({ type: 'peer-joined', peerId: 'ghost' });
    expect(h.peers).toHaveLength(0);
    expect(h.last().phase).toBe('stopped');

    await h.session.start();
    expect(h.signaling.sent[h.signaling.sent.length - 1]).toEqual({ type: 'create-room' });
  });
});

// -- detectors (Task 11) ------------------------------------------------------

describe('detectors', () => {
  test('noise/motion detection is OFF by default — nothing created on reaching live', async () => {
    const h = makeHarness();
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    expect(h.noiseSources.created).toHaveLength(0);
    expect(h.motionSources.created).toHaveLength(0);
    expect(h.session.getDetectorSettings()).toMatchObject({
      noiseEnabled: false,
      motionEnabled: false,
    });
  });

  test('setNoiseEnabled(true) while live creates a noise source; a sustained over-threshold sample broadcasts an alert to ALL peers', async () => {
    const t = { ms: 0 };
    const now = () => t.ms;
    const h = makeHarness({ now, detectors: { noiseThreshold: 0.3 } });
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.signaling.receive({ type: 'peer-joined', peerId: 'v1' });
    h.signaling.receive({ type: 'peer-joined', peerId: 'v2' });
    h.peers[0]!.openData();
    h.peers[1]!.openData();

    h.session.setNoiseEnabled(true);
    expect(h.noiseSources.created).toHaveLength(1);
    const src = h.noiseSources.created[0]!;

    src.fire(0.5); // t=0: over-threshold run begins
    t.ms = 499;
    src.fire(0.5);
    expect(h.peers[0]!.sentData).toEqual([]); // not sustained yet (500ms)
    t.ms = 500;
    src.fire(0.5); // sustained: fires
    const expected = JSON.stringify({ t: 'alert', kind: 'noise', at: 500 });
    expect(h.peers[0]!.sentData).toEqual([expected]);
    expect(h.peers[1]!.sentData).toEqual([expected]); // broadcast to every peer
  });

  test('setNoiseEnabled(false) stops the running noise source', async () => {
    const h = makeHarness({ detectors: { noiseEnabled: true } });
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    expect(h.noiseSources.created).toHaveLength(1);
    expect(h.noiseSources.created[0]!.stopped).toBe(false);

    h.session.setNoiseEnabled(false);
    expect(h.noiseSources.created[0]!.stopped).toBe(true);
  });

  test('setNoiseThreshold applies live to the already-running detector', async () => {
    const t = { ms: 0 };
    const now = () => t.ms;
    const h = makeHarness({ now, detectors: { noiseEnabled: true, noiseThreshold: 0.5 } });
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.signaling.receive({ type: 'peer-joined', peerId: 'v1' });
    h.peers[0]!.openData();
    const src = h.noiseSources.created[0]!;

    src.fire(0.3); // below the 0.5 threshold: never sustains
    t.ms = 500;
    src.fire(0.3);
    expect(h.peers[0]!.sentData).toEqual([]);

    h.session.setNoiseThreshold(0.2); // lower it below the current 0.3 level
    t.ms = 600;
    src.fire(0.3); // now over-threshold: sustain run begins
    t.ms = 1100; // sustained 500ms
    src.fire(0.3);
    expect(h.peers[0]!.sentData).toEqual([JSON.stringify({ t: 'alert', kind: 'noise', at: 1100 })]);
  });

  test('a not-yet-open data channel is a fire-and-forget no-op — never throws', async () => {
    const t = { ms: 0 };
    const now = () => t.ms;
    const h = makeHarness({ now, detectors: { noiseEnabled: true, noiseThreshold: 0.3 } });
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.signaling.receive({ type: 'peer-joined', peerId: 'v1' }); // data channel NOT opened
    const src = h.noiseSources.created[0]!;

    src.fire(0.5);
    t.ms = 500;
    expect(() => src.fire(0.5)).not.toThrow();
    expect(h.peers[0]!.sentData).toEqual([]); // sendData no-ops on a closed channel
  });

  test('motion: attachMotionSource + setMotionEnabled(true) creates a source; an over-threshold sample fires immediately (sustainMs 0)', async () => {
    const t = { ms: 0 };
    const now = () => t.ms;
    const h = makeHarness({ now, detectors: { motionThreshold: 0.1 } });
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.signaling.receive({ type: 'peer-joined', peerId: 'v1' });
    h.peers[0]!.openData();

    h.session.attachMotionSource(fakeVideoEl);
    expect(h.motionSources.created).toHaveLength(0); // motionEnabled is still false

    h.session.setMotionEnabled(true);
    expect(h.motionSources.created).toHaveLength(1);
    const src = h.motionSources.created[0]!;

    src.fire(0.2); // over the 0.1 threshold: fires immediately, no sustain needed
    expect(h.peers[0]!.sentData).toEqual([JSON.stringify({ t: 'alert', kind: 'motion', at: 0 })]);
  });

  test('attachMotionSource(null) stops the running motion source', async () => {
    const h = makeHarness({ detectors: { motionEnabled: true } });
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.session.attachMotionSource(fakeVideoEl);
    expect(h.motionSources.created).toHaveLength(1);
    expect(h.motionSources.created[0]!.stopped).toBe(false);

    h.session.attachMotionSource(null);
    expect(h.motionSources.created[0]!.stopped).toBe(true);
  });

  test('stop() tears down running noise and motion sources', async () => {
    const h = makeHarness({ detectors: { noiseEnabled: true, motionEnabled: true } });
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    h.session.attachMotionSource(fakeVideoEl);
    expect(h.noiseSources.created).toHaveLength(1);
    expect(h.motionSources.created).toHaveLength(1);

    h.session.stop();
    expect(h.noiseSources.created[0]!.stopped).toBe(true);
    expect(h.motionSources.created[0]!.stopped).toBe(true);
  });

  test('settings persist to storage and are reloaded by a fresh session sharing that storage', () => {
    const h = makeHarness();
    h.session.setNoiseThreshold(0.42);
    h.session.setMotionThreshold(0.07);
    h.session.setNoiseEnabled(true);
    h.session.setMotionEnabled(true);
    expect(h.storage.getItem(STORAGE_DETECT_NOISE_THRESHOLD_KEY)).toBe('0.42');
    expect(h.storage.getItem(STORAGE_DETECT_MOTION_THRESHOLD_KEY)).toBe('0.07');
    expect(h.storage.getItem(STORAGE_DETECT_NOISE_ENABLED_KEY)).toBe('true');
    expect(h.storage.getItem(STORAGE_DETECT_MOTION_ENABLED_KEY)).toBe('true');

    // A fresh session sharing the same storage reloads the PERSISTED values,
    // not the spec defaults (storage always wins — see loadDetectorSettings).
    const session2 = new CameraSession({
      signaling: new MockSignaling(),
      storage: h.storage,
      location: { origin: 'https://cam.test', hash: '' },
    });
    expect(session2.getDetectorSettings()).toEqual({
      noiseEnabled: true,
      motionEnabled: true,
      noiseThreshold: 0.42,
      motionThreshold: 0.07,
    });
  });
});

// -- talk-back (Task 12) ------------------------------------------------------

describe('talk-back: onRemoteAudio', () => {
  async function live() {
    const h = makeHarness();
    await h.session.start();
    h.signaling.receive(ROOM_CREATED);
    return h;
  }

  test('fires immediately with an empty list, then on every peer-track change', async () => {
    const h = await live();
    const seen: RemoteAudioEntry[][] = [];
    h.session.onRemoteAudio((entries) => seen.push(entries));
    expect(seen).toEqual([[]]); // fires immediately, current value is empty

    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    const s1 = fakeRemoteStream('s1');
    h.peers[0]!.emitTrack('audio', s1);
    expect(seen[seen.length - 1]).toEqual([{ peerId: 'viewer-1', stream: s1 }]);
  });

  test('a non-audio track is ignored', async () => {
    const h = await live();
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    const seen: RemoteAudioEntry[][] = [];
    h.session.onRemoteAudio((entries) => seen.push(entries));
    h.peers[0]!.emitTrack('video', fakeRemoteStream('s1'));
    expect(seen[seen.length - 1]).toEqual([]);
  });

  test('a track event without streams is ignored (no phantom entry)', async () => {
    const h = await live();
    h.signaling.receive({ type: 'peer-joined', peerId: 'viewer-1' });
    const seen: RemoteAudioEntry[][] = [];
    h.session.onRemoteAudio((entries) => seen.push(entries));
    const baseline = seen.length;
    h.peers[0]!.emitBareTrack('audio');
    expect(seen.length).toBe(baseline); // setRemoteAudio(id, null) no-ops: nothing was set
  });

  test('multiple viewers can each contribute an entry', async () => {
    const h = await live();
    h.signaling.receive({ type: 'peer-joined', peerId: 'v1' });
    h.signaling.receive({ type: 'peer-joined', peerId: 'v2' });
    const seen: RemoteAudioEntry[][] = [];
    h.session.onRemoteAudio((entries) => seen.push(entries));

    const s1 = fakeRemoteStream('s1');
    const s2 = fakeRemoteStream('s2');
    h.peers[0]!.emitTrack('audio', s1);
    h.peers[1]!.emitTrack('audio', s2);
    expect(seen[seen.length - 1]).toEqual([
      { peerId: 'v1', stream: s1 },
      { peerId: 'v2', stream: s2 },
    ]);
  });

  test('peer-left removes that viewer entry (mic LED for THAT stream goes away)', async () => {
    const h = await live();
    h.signaling.receive({ type: 'peer-joined', peerId: 'v1' });
    h.signaling.receive({ type: 'peer-joined', peerId: 'v2' });
    h.peers[0]!.emitTrack('audio', fakeRemoteStream('s1'));
    const s2 = fakeRemoteStream('s2');
    h.peers[1]!.emitTrack('audio', s2);

    const seen: RemoteAudioEntry[][] = [];
    h.session.onRemoteAudio((entries) => seen.push(entries));
    h.signaling.receive({ type: 'peer-left', peerId: 'v1' });
    expect(seen[seen.length - 1]).toEqual([{ peerId: 'v2', stream: s2 }]);
  });

  test('peer-left for a viewer with no audio entry is a harmless no-op (no spurious callback)', async () => {
    const h = await live();
    h.signaling.receive({ type: 'peer-joined', peerId: 'v1' });
    const seen: RemoteAudioEntry[][] = [];
    h.session.onRemoteAudio((entries) => seen.push(entries));
    const baseline = seen.length;
    h.signaling.receive({ type: 'peer-left', peerId: 'v1' }); // never emitted a track
    expect(seen.length).toBe(baseline); // setRemoteAudio no-ops; no extra callback
  });

  test('stop() clears everything; a subsequent onRemoteAudio subscriber sees an empty list', async () => {
    const h = await live();
    h.signaling.receive({ type: 'peer-joined', peerId: 'v1' });
    h.peers[0]!.emitTrack('audio', fakeRemoteStream('s1'));

    h.session.stop();
    const seen: RemoteAudioEntry[][] = [];
    h.session.onRemoteAudio((entries) => seen.push(entries));
    expect(seen).toEqual([[]]);
  });
});
