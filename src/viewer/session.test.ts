// Tests for ViewerSession — mock signaling, mock peers, fake AudioContext.
// Fully deterministic; no browser APIs.

import { describe, expect, test } from 'bun:test';
import type { C2S, S2C } from '../../shared/protocol.ts';
import type { PeerOptions } from '../lib/peer.ts';
import {
  ViewerSession,
  normalizeCode,
  type AudioContextLike,
  type PeerLike,
  type SignalingLike,
  type TrackEventLike,
  type ViewerState,
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
  closed = false;
  /** Payloads whose handleSignal call has STARTED (chain-order probe). */
  started: unknown[] = [];
  /** Token report returned by getStats (identity-checked in tests). */
  statsResult = { peer: this } as unknown as RTCStatsReport;
  private resolvers: Array<() => void> = [];
  private trackCbs: Array<(ev: TrackEventLike) => void> = [];
  private dataCbs: Array<(text: string) => void> = [];
  private connCbs: Array<(s: RTCPeerConnectionState) => void> = [];

  constructor(opts: PeerOptions) {
    this.remotePeerId = opts.remotePeerId;
    this.sendSignal = opts.sendSignal;
  }

  handleSignal(payload: unknown): Promise<void> {
    this.started.push(payload);
    return new Promise((res) => this.resolvers.push(res));
  }
  close(): void {
    this.closed = true;
  }
  onTrack(cb: (ev: TrackEventLike) => void): () => void {
    this.trackCbs.push(cb);
    return () => {
      this.trackCbs = this.trackCbs.filter((f) => f !== cb);
    };
  }
  onDataMessage(cb: (text: string) => void): () => void {
    this.dataCbs.push(cb);
    return () => {
      this.dataCbs = this.dataCbs.filter((f) => f !== cb);
    };
  }
  onConnectionState(cb: (s: RTCPeerConnectionState) => void): () => void {
    this.connCbs.push(cb);
    return () => {
      this.connCbs = this.connCbs.filter((f) => f !== cb);
    };
  }
  getStats(): Promise<RTCStatsReport> {
    return Promise.resolve(this.statsResult);
  }

  // -- test drivers --
  emitTrack(stream: MediaStream): void {
    for (const cb of [...this.trackCbs]) cb({ streams: [stream] });
  }
  emitBareTrack(): void {
    for (const cb of [...this.trackCbs]) cb({ streams: [] });
  }
  setConnState(s: RTCPeerConnectionState): void {
    for (const cb of [...this.connCbs]) cb(s);
  }
  emitData(text: string): void {
    for (const cb of [...this.dataCbs]) cb(text);
  }
  finishOneSignal(): void {
    const res = this.resolvers.shift();
    if (res === undefined) throw new Error('no in-flight handleSignal');
    res();
  }
}

class FakeAudioContext implements AudioContextLike {
  state = 'suspended';
  resumeCalls = 0;
  resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
    return Promise.resolve();
  }
}

function fakeStream(id: string): MediaStream {
  return { id } as unknown as MediaStream;
}

function makeHarness(opts: { hash?: string } = {}) {
  const signaling = new MockSignaling();
  const location = { hash: opts.hash ?? '' };
  const peers: MockPeer[] = [];
  const audioContexts: FakeAudioContext[] = [];
  const states: ViewerState[] = [];
  const streams: Array<MediaStream | null> = [];
  const dataMessages: string[] = [];
  const session = new ViewerSession({
    signaling,
    location,
    createPeer: (o) => {
      const p = new MockPeer(o);
      peers.push(p);
      return p;
    },
    audioContextFactory: () => {
      const c = new FakeAudioContext();
      audioContexts.push(c);
      return c;
    },
  });
  session.onState((s) => states.push(s));
  session.onRemoteStream((s) => streams.push(s));
  session.onDataMessage((t) => dataMessages.push(t));
  const last = () => states[states.length - 1]!;
  const lastStream = () => streams[streams.length - 1]!;
  return {
    session, signaling, location, peers, audioContexts,
    states, streams, dataMessages, last, lastStream,
  };
}

const ROOM_JOINED: Extract<S2C, { type: 'room-joined' }> = {
  type: 'room-joined',
  peerId: 'me-1',
  cameraPresent: true,
};

/** Harness advanced to the in-room waiting state. */
function joined(opts: { cameraPresent?: boolean } = {}) {
  const h = makeHarness();
  h.session.join('ABCD2345');
  h.signaling.receive({ ...ROOM_JOINED, cameraPresent: opts.cameraPresent ?? true });
  return h;
}

/** Harness advanced to 'live': camera adopted via first signal, track flowing. */
function live() {
  const h = joined();
  h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'offer' });
  const stream = fakeStream('s1');
  h.peers[0]!.emitTrack(stream);
  return { ...h, stream };
}

// -- join -------------------------------------------------------------------

describe('join', () => {
  test('code from argument → join-room sent, phase joining', () => {
    const h = makeHarness();
    h.session.join('ABCD2345');
    expect(h.signaling.connectCalls).toBe(1);
    expect(h.signaling.sent).toEqual([{ type: 'join-room', code: 'ABCD2345' }]);
    expect(h.last()).toMatchObject({ phase: 'joining', roomCode: 'ABCD2345' });
  });

  test('code from URL fragment, uppercase-normalized', () => {
    const h = makeHarness({ hash: '#abcd2345' });
    h.session.join();
    expect(h.signaling.sent).toEqual([{ type: 'join-room', code: 'ABCD2345' }]);
  });

  test('argument takes precedence over the fragment', () => {
    const h = makeHarness({ hash: '#WXYZ2345' });
    h.session.join('abcd2345');
    expect(h.signaling.sent).toEqual([{ type: 'join-room', code: 'ABCD2345' }]);
  });

  test('invalid or absent code → stays idle with an error hint, no traffic', () => {
    for (const bad of [undefined, '', 'SHORT', 'ABCD234!', 'ABCD23450']) {
      const h = makeHarness();
      h.session.join(bad);
      expect(h.last().phase).toBe('idle');
      expect(h.last().error).toContain('8-character');
      expect(h.signaling.sent).toEqual([]);
    }
  });

  test('join while already joined is a no-op', () => {
    const h = joined();
    h.session.join('ABCD2345');
    expect(h.signaling.ofType('join-room')).toHaveLength(1);
  });

  test('room-joined with cameraPresent → waiting-camera', () => {
    const h = joined({ cameraPresent: true });
    expect(h.last()).toMatchObject({ phase: 'waiting-camera', cameraPresent: true });
  });

  test('room-joined without camera → waiting-camera, cameraPresent false', () => {
    const h = joined({ cameraPresent: false });
    expect(h.last()).toMatchObject({ phase: 'waiting-camera', cameraPresent: false });
  });
});

describe('normalizeCode', () => {
  test('strips #, trims, uppercases', () => {
    expect(normalizeCode('#abcd2345')).toBe('ABCD2345');
    expect(normalizeCode('  wxyz2345  ')).toBe('WXYZ2345');
  });
  test('rejects ambiguous-alphabet and wrong-length codes', () => {
    expect(normalizeCode('ABCD2340')).toBeNull(); // 0 not in alphabet
    expect(normalizeCode('ABCD234')).toBeNull();
    expect(normalizeCode('')).toBeNull();
  });
});

// -- lazy camera Peer -------------------------------------------------------

describe('camera peer', () => {
  test('created lazily on the first inbound signal, role viewer, correct wrap-up', () => {
    const h = joined();
    expect(h.peers).toHaveLength(0);
    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'offer' });
    expect(h.peers).toHaveLength(1);
    expect(h.peers[0]!.remotePeerId).toBe('cam-1');
    h.peers[0]!.sendSignal({ kind: 'candidate', candidate: null });
    expect(h.signaling.ofType('signal')).toEqual([
      { type: 'signal', to: 'cam-1', payload: { kind: 'candidate', candidate: null } },
    ]);
  });

  test('inbound signals are serial-awaited (single chain)', async () => {
    const h = joined();
    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'A' });
    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'B' });
    await Bun.sleep(0); // flush microtasks
    const peer = h.peers[0]!;
    // B must NOT start until A's handleSignal resolves (Peer contract).
    expect(peer.started).toEqual(['A']);
    peer.finishOneSignal();
    await Bun.sleep(0);
    expect(peer.started).toEqual(['A', 'B']);
  });

  test('signal from a NEW sender replaces the peer (reclaimed camera), clears stream', async () => {
    const h = live();
    expect(h.lastStream()).toBe(h.stream);
    h.signaling.receive({ type: 'signal', from: 'cam-2', payload: 'fresh-offer' });
    expect(h.peers).toHaveLength(2);
    expect(h.peers[0]!.closed).toBe(true);
    expect(h.peers[1]!.remotePeerId).toBe('cam-2');
    expect(h.lastStream()).toBeNull();
    expect(h.last()).toMatchObject({ phase: 'waiting-camera' });
    // New offer's track restores live.
    const s2 = fakeStream('s2');
    await Bun.sleep(0);
    h.peers[1]!.emitTrack(s2);
    expect(h.lastStream()).toBe(s2);
    expect(h.last()).toMatchObject({ phase: 'live', cameraPresent: true });
  });

  test('replacement resets the chain: new peer signals do not wait on the old peer', async () => {
    const h = joined();
    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'A' });
    await Bun.sleep(0); // A in flight, never finished
    h.signaling.receive({ type: 'signal', from: 'cam-2', payload: 'B' });
    await Bun.sleep(0);
    expect(h.peers[1]!.started).toEqual(['B']);
  });

  test('signal while not in the room is ignored', () => {
    const h = makeHarness();
    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'x' });
    expect(h.peers).toHaveLength(0);
    h.session.join('ABCD2345'); // joining, not yet room-joined
    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'x' });
    expect(h.peers).toHaveLength(0);
  });

  test('first track → phase live + stream delivered to onRemoteStream', () => {
    const h = joined({ cameraPresent: false });
    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'offer' });
    const stream = fakeStream('s1');
    h.peers[0]!.emitTrack(stream);
    expect(h.last()).toMatchObject({ phase: 'live', cameraPresent: true });
    expect(h.lastStream()).toBe(stream);
  });

  test('data-channel messages are forwarded to onDataMessage', () => {
    const h = live();
    h.peers[0]!.emitData('{"t":"hb","seq":0}');
    expect(h.dataMessages).toEqual(['{"t":"hb","seq":0}']);
  });

  test('a track event without streams is ignored (no phantom live)', () => {
    const h = joined();
    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'offer' });
    h.peers[0]!.emitBareTrack();
    expect(h.last().phase).toBe('waiting-camera');
    expect(h.lastStream()).toBeNull();
  });
});

// -- Task 10 consumer surface -----------------------------------------------

describe('connection state + stats (Task 10 surface)', () => {
  test('onConnectionState follows the current peer and survives replacement', () => {
    const h = live();
    const seen: RTCPeerConnectionState[] = [];
    h.session.onConnectionState((s) => seen.push(s));
    h.peers[0]!.setConnState('connected');

    // Replacement: the reclaimed camera's peer feeds the SAME subscription.
    h.signaling.receive({ type: 'signal', from: 'cam-2', payload: 'offer' });
    h.peers[1]!.setConnState('connecting');
    // The dead peer's late emissions no longer reach subscribers.
    h.peers[0]!.setConnState('failed');
    expect(seen).toEqual(['connected', 'connecting']);
  });

  test('getStats resolves null without a peer and delegates to the current one', async () => {
    const h = joined();
    expect(await h.session.getStats()).toBeNull();
    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'offer' });
    expect(await h.session.getStats()).toBe(h.peers[0]!.statsResult);

    h.signaling.receive({ type: 'signal', from: 'cam-2', payload: 'offer' });
    expect(await h.session.getStats()).toBe(h.peers[1]!.statsResult);

    h.session.leave();
    expect(await h.session.getStats()).toBeNull();
  });
});

// -- camera lifecycle -------------------------------------------------------

describe('camera lifecycle', () => {
  test('peer-left (camera dropped) → waiting-camera, peer closed, stream cleared', () => {
    const h = live();
    h.signaling.receive({ type: 'peer-left', peerId: 'cam-1' });
    expect(h.peers[0]!.closed).toBe(true);
    expect(h.lastStream()).toBeNull();
    expect(h.last()).toMatchObject({ phase: 'waiting-camera', cameraPresent: false });
  });

  test('peer-left for a different id than the tracked camera is ignored', () => {
    const h = live();
    h.signaling.receive({ type: 'peer-left', peerId: 'someone-else' });
    expect(h.peers[0]!.closed).toBe(false);
    expect(h.last().phase).toBe('live');
  });

  test('peer-left before any offer (no peer yet) still flips to camera-offline', () => {
    const h = joined({ cameraPresent: true });
    h.signaling.receive({ type: 'peer-left', peerId: 'cam-1' });
    expect(h.last()).toMatchObject({ phase: 'waiting-camera', cameraPresent: false });
  });

  test('camera-back → cameraPresent true, keeps waiting for the new offer', () => {
    const h = joined({ cameraPresent: false });
    h.signaling.receive({ type: 'camera-back' });
    expect(h.last()).toMatchObject({ phase: 'waiting-camera', cameraPresent: true });
    expect(h.signaling.ofType('signal')).toEqual([]); // camera initiates
  });

  test('room-closed → calm ended state, peer closed, stream cleared', () => {
    const h = live();
    h.signaling.receive({ type: 'room-closed' });
    expect(h.peers[0]!.closed).toBe(true);
    expect(h.lastStream()).toBeNull();
    expect(h.last()).toMatchObject({ phase: 'ended', cameraPresent: false });
  });

  test('room-joined outside joining (hostile relay) resets peer + stream first', () => {
    const h = live();
    h.signaling.receive(ROOM_JOINED);
    expect(h.peers[0]!.closed).toBe(true);
    expect(h.lastStream()).toBeNull();
    expect(h.last()).toMatchObject({ phase: 'waiting-camera', cameraPresent: true });
  });

  test('messages after ended are ignored', () => {
    const h = live();
    h.signaling.receive({ type: 'room-closed' });
    h.signaling.receive({ type: 'signal', from: 'cam-9', payload: 'x' });
    h.signaling.receive({ type: 'camera-back' });
    expect(h.peers).toHaveLength(1); // no new peer adopted
    expect(h.last().phase).toBe('ended');
  });
});

// -- errors -----------------------------------------------------------------

describe('errors', () => {
  test('bad-code while joining → error "room not found"', () => {
    const h = makeHarness();
    h.session.join('ABCD2345');
    h.signaling.receive({ type: 'error', reason: 'bad-code' });
    expect(h.last().phase).toBe('error');
    expect(h.last().error).toContain('not found');
  });

  test('room-full while joining → error', () => {
    const h = makeHarness();
    h.session.join('ABCD2345');
    h.signaling.receive({ type: 'error', reason: 'room-full' });
    expect(h.last().phase).toBe('error');
    expect(h.last().error).toContain('full');
  });

  test('rate-limited → error with a retry-later message', () => {
    const h = joined();
    h.signaling.receive({ type: 'error', reason: 'rate-limited' });
    expect(h.last().phase).toBe('error');
    expect(h.last().error).toContain('Rate limited');
  });

  test('error:invalid is ignored while in the room (stale-queued-signal noise)', () => {
    const h = live();
    h.signaling.receive({ type: 'error', reason: 'invalid' });
    expect(h.last().phase).toBe('live');
  });

  test('leave→join wedge: error:invalid during a user join fails clearly (no forever-joining)', () => {
    const h = live();
    h.session.leave();
    // The relay still has this socket bound to the old room, so the re-join
    // is refused with error:invalid.
    h.session.join('ABCD2345');
    expect(h.last().phase).toBe('joining');
    h.signaling.receive({ type: 'error', reason: 'invalid' });
    expect(h.last().phase).toBe('error');
    expect(h.last().error).toContain('reload');
  });

  test('join again after error works', () => {
    const h = makeHarness();
    h.session.join('ABCD2345');
    h.signaling.receive({ type: 'error', reason: 'bad-code' });
    h.session.join('WXYZ2345');
    expect(h.last()).toMatchObject({ phase: 'joining', roomCode: 'WXYZ2345' });
    expect(h.signaling.ofType('join-room')).toHaveLength(2);
  });
});

// -- reconnect (rung 2) -----------------------------------------------------

describe('signaling reconnect', () => {
  test('re-joins the same code; old peer closed, stream cleared', () => {
    const h = live();
    h.signaling.reconnect();
    expect(h.peers[0]!.closed).toBe(true);
    expect(h.lastStream()).toBeNull();
    expect(h.last()).toMatchObject({ phase: 'joining', roomCode: 'ABCD2345' });
    expect(h.signaling.sent[h.signaling.sent.length - 1]).toEqual({
      type: 'join-room',
      code: 'ABCD2345',
    });

    // Fresh join ack + the (new-peerId) camera's fresh offer rebuild live.
    h.signaling.receive(ROOM_JOINED);
    h.signaling.receive({ type: 'signal', from: 'cam-2', payload: 'offer' });
    const s2 = fakeStream('s2');
    h.peers[1]!.emitTrack(s2);
    expect(h.last()).toMatchObject({ phase: 'live', cameraPresent: true });
    expect(h.lastStream()).toBe(s2);
  });

  test('error:invalid during a rung-2 re-join is stale-flush noise, not a failure', () => {
    const h = live();
    h.signaling.reconnect();
    expect(h.last().phase).toBe('joining');
    // Stale signals queued during the outage flushed BEFORE our join-room;
    // the relay answers each with error:invalid. Must not fail the re-join —
    // the fresh socket's join-room cannot itself be refused as invalid.
    h.signaling.receive({ type: 'error', reason: 'invalid' });
    h.signaling.receive({ type: 'error', reason: 'invalid' });
    expect(h.last().phase).toBe('joining');
    h.signaling.receive(ROOM_JOINED);
    expect(h.last()).toMatchObject({ phase: 'waiting-camera', cameraPresent: true });
  });

  test('no re-join when never joined, after ended, or after leave', () => {
    const h1 = makeHarness();
    h1.signaling.reconnect();
    expect(h1.signaling.sent).toEqual([]);

    const h2 = live();
    h2.signaling.receive({ type: 'room-closed' });
    h2.signaling.reconnect();
    expect(h2.signaling.ofType('join-room')).toHaveLength(1);
    expect(h2.last().phase).toBe('ended');

    const h3 = live();
    h3.session.leave();
    h3.signaling.reconnect();
    expect(h3.signaling.ofType('join-room')).toHaveLength(1);
  });
});

// -- unmute -----------------------------------------------------------------

describe('unmute', () => {
  test('starts muted; unmute flips the flag and creates+resumes the AudioContext', () => {
    const h = live();
    expect(h.last().muted).toBe(true);
    expect(h.session.audioContext).toBeNull();

    h.session.unmute();
    expect(h.last().muted).toBe(false);
    expect(h.audioContexts).toHaveLength(1);
    expect(h.audioContexts[0]!.resumeCalls).toBe(1);
    expect(h.audioContexts[0]!.state).toBe('running');
    // Exposed for Task 10 (alarm) / Task 11 (chime).
    expect(h.session.audioContext).toBe(h.audioContexts[0]!);
  });

  test('repeat unmute re-resumes the SAME context (no second creation)', () => {
    const h = live();
    h.session.unmute();
    h.session.unmute();
    expect(h.audioContexts).toHaveLength(1);
    expect(h.audioContexts[0]!.resumeCalls).toBe(2);
  });

  test('a throwing AudioContext factory still unmutes the video', () => {
    const signaling = new MockSignaling();
    const session = new ViewerSession({
      signaling,
      location: { hash: '' },
      createPeer: (o) => new MockPeer(o),
      audioContextFactory: () => {
        throw new Error('no audio');
      },
    });
    const states: ViewerState[] = [];
    session.onState((s) => states.push(s));
    session.unmute();
    expect(states[states.length - 1]!.muted).toBe(false);
    expect(session.audioContext).toBeNull();
  });
});

// -- leave ------------------------------------------------------------------

describe('leave', () => {
  test('closes the peer, clears stream + state back to idle', () => {
    const h = live();
    h.session.leave();
    expect(h.peers[0]!.closed).toBe(true);
    expect(h.lastStream()).toBeNull();
    expect(h.last()).toMatchObject({ phase: 'idle', cameraPresent: false });
    expect(h.last().roomCode).toBeUndefined();
  });

  test('messages after leave are ignored', () => {
    const h = live();
    h.session.leave();
    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'x' });
    h.signaling.receive({ type: 'camera-back' });
    expect(h.peers).toHaveLength(1);
    expect(h.last().phase).toBe('idle');
  });
});

// -- subscriptions ----------------------------------------------------------

describe('unsubscribe closures', () => {
  test('onState / onRemoteStream / onDataMessage / onConnectionState stop delivering', () => {
    const h = joined();
    const states: ViewerState[] = [];
    const streams: Array<MediaStream | null> = [];
    const data: string[] = [];
    const conns: RTCPeerConnectionState[] = [];
    const unsubState = h.session.onState((s) => states.push(s));
    const unsubStream = h.session.onRemoteStream((s) => streams.push(s));
    const unsubData = h.session.onDataMessage((t) => data.push(t));
    const unsubConn = h.session.onConnectionState((s) => conns.push(s));
    const baseline = { states: states.length, streams: streams.length };

    unsubState();
    unsubStream();
    unsubData();
    unsubConn();

    h.signaling.receive({ type: 'signal', from: 'cam-1', payload: 'offer' });
    h.peers[0]!.emitTrack(fakeStream('s1'));
    h.peers[0]!.emitData('hb');
    h.peers[0]!.setConnState('connected');
    expect(states.length).toBe(baseline.states);
    expect(streams.length).toBe(baseline.streams);
    expect(data).toEqual([]);
    expect(conns).toEqual([]);
  });
});
