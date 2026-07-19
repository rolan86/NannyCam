// NannyCam viewer session — ALL viewer-side logic, zero DOM/Preact.
//
// The UI (main.tsx) is a thin renderer over this class: it subscribes to
// onState/onRemoteStream and forwards the two user gestures (join/unmute).
// Everything else — code parsing, join flow, the single camera Peer, audio
// unlock, and reconnection (rung 2: re-join on a fresh socket) — lives here
// behind injectable seams so bun tests run with no browser at all.
//
// Camera-Peer discovery (design decision): the protocol has no camera-id
// announcement — room-joined tells us only whether a camera is present, not
// its peerId. The camera initiates offers, so the viewer learns the camera's
// peerId from the `from` of the FIRST inbound signal message and creates its
// (polite, role 'viewer') Peer lazily at that moment. If a later signal
// arrives from a DIFFERENT sender, that is the reclaimed/recreated camera
// under a fresh peerId: the prior Peer is closed and replaced. One Peer at a
// time, always the camera.

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  type C2S,
  type ErrorReason,
  type S2C,
} from '../../shared/protocol.ts';
import { Peer, type PeerOptions } from '../lib/peer.ts';

export type ViewerPhase =
  | 'idle'
  | 'joining'
  | 'waiting-camera'
  | 'live'
  | 'ended'
  | 'error';

export interface ViewerState {
  phase: ViewerPhase;
  roomCode?: string;
  /** Whether the relay reports a camera bound to the room. */
  cameraPresent: boolean;
  /** Starts true (autoplay policy); flipped by the unmute() gesture. */
  muted: boolean;
  error?: string;
}

/** The slice of SignalingClient the session uses (mockable in tests). */
export interface SignalingLike {
  connect(): void;
  send(msg: C2S): void;
  onMessage(cb: (msg: S2C) => void): () => void;
  onReconnected(cb: () => void): () => void;
}

/** The slice of RTCTrackEvent the session reads; the real event satisfies it. */
export interface TrackEventLike {
  readonly streams: ReadonlyArray<MediaStream>;
}

/** The slice of Peer the session uses; the real Peer satisfies it as-is. */
export interface PeerLike {
  readonly remotePeerId: string;
  handleSignal(payload: unknown): Promise<void>;
  close(): void;
  onTrack(cb: (ev: TrackEventLike) => void): () => void;
  onDataMessage(cb: (text: string) => void): () => void;
  onConnectionState(cb: (s: RTCPeerConnectionState) => void): () => void;
  getStats(): Promise<RTCStatsReport>;
}

/**
 * The slice of AudioContext the session uses. Held so Task 10 (alarm) and
 * Task 11 (chime) can play through a context that the unmute gesture already
 * unlocked — browsers only allow audio started from a user gesture.
 */
export interface AudioContextLike {
  readonly state: string;
  resume(): Promise<unknown>;
}

export interface ViewerSessionOptions {
  signaling: SignalingLike;
  /** window.location satisfies this; only the fragment is read (#CODE). */
  location: { hash: string };
  /** Peer factory seam; defaults to `new Peer(opts)` (role 'viewer'). */
  createPeer?: (opts: PeerOptions) => PeerLike;
  /** AudioContext seam; defaults to `new AudioContext()` (browser only). */
  audioContextFactory?: () => AudioContextLike;
}

/** Room codes: exactly CODE_LENGTH chars of the unambiguous alphabet. */
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/**
 * Normalize raw code input (input field or URL fragment): strip a leading
 * '#', trim whitespace, uppercase. Returns null for anything that is not a
 * valid room code.
 */
export function normalizeCode(raw: string): string | null {
  const code = raw.replace(/^#/, '').trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export class ViewerSession {
  private readonly signaling: SignalingLike;
  private readonly location: { hash: string };
  private readonly createPeer: (opts: PeerOptions) => PeerLike;
  private readonly audioContextFactory: () => AudioContextLike;

  private state: ViewerState = { phase: 'idle', cameraPresent: false, muted: true };
  private stateCbs: Array<(s: ViewerState) => void> = [];
  private streamCbs: Array<(stream: MediaStream | null) => void> = [];
  private dataCbs: Array<(text: string) => void> = [];
  private connStateCbs: Array<(s: RTCPeerConnectionState) => void> = [];
  private peerAdoptedCbs: Array<() => void> = [];

  /** The single camera Peer (see the file-header discovery note). */
  private peer: PeerLike | null = null;
  private peerUnsubs: Array<() => void> = [];
  /**
   * Serial promise chain for inbound signal payloads. Peer docs: each
   * handleSignal call MUST be awaited before feeding the next payload from
   * the same peer — concurrent calls corrupt negotiation state. One peer at
   * a time means one chain; it is reset whenever the peer is replaced.
   */
  private chain: Promise<void> = Promise.resolve();

  private remoteStream: MediaStream | null = null;
  /** The code we are (re)joining with; null until join(), cleared by leave(). */
  private activeCode: string | null = null;
  /**
   * True while the current 'joining' phase is a rung-2 re-join (fresh socket
   * after a signaling reconnect) rather than a user-initiated join(). Gates
   * the error:invalid handling — see handleErrorReason.
   */
  private rejoining = false;
  private subscribed = false;
  private audioCtx: AudioContextLike | null = null;

  constructor(opts: ViewerSessionOptions) {
    this.signaling = opts.signaling;
    this.location = opts.location;
    this.createPeer = opts.createPeer ?? ((o) => new Peer(o));
    this.audioContextFactory =
      opts.audioContextFactory ?? (() => new AudioContext());
  }

  /**
   * The AudioContext created/resumed by the unmute() gesture, or null before
   * the first unmute. Task 10 (alarm) and Task 11 (chime) play through this
   * context because it is the one the user gesture unlocked.
   */
  get audioContext(): AudioContextLike | null {
    return this.audioCtx;
  }

  /**
   * Subscribe to state changes. The callback fires immediately with the
   * current state, then on every change. Returns an unsubscribe closure.
   */
  onState(cb: (s: ViewerState) => void): () => void {
    this.stateCbs.push(cb);
    cb(this.state);
    return () => {
      this.stateCbs = this.stateCbs.filter((f) => f !== cb);
    };
  }

  /**
   * Subscribe to the remote MediaStream (the UI assigns it to the <video>'s
   * srcObject). Fires immediately with the current stream (null when none),
   * then whenever it changes — including back to null when the camera drops.
   */
  onRemoteStream(cb: (stream: MediaStream | null) => void): () => void {
    this.streamCbs.push(cb);
    cb(this.remoteStream);
    return () => {
      this.streamCbs = this.streamCbs.filter((f) => f !== cb);
    };
  }

  /**
   * Text frames from the camera's data channel (heartbeats now; alerts
   * later). Task 10 (watchdog) and Task 11 (alert UI) consume these; the MVP
   * only exposes the stream. Returns an unsubscribe closure.
   */
  onDataMessage(cb: (text: string) => void): () => void {
    this.dataCbs.push(cb);
    return () => {
      this.dataCbs = this.dataCbs.filter((f) => f !== cb);
    };
  }

  /**
   * RTCPeerConnection state of the CURRENT camera Peer. The subscription is
   * session-level: it transparently survives peer replacement (each adopted
   * peer is re-wired to this stream), so Task 10's watchdog subscribes once
   * and keeps receiving states across camera reclaims/reconnects. Returns an
   * unsubscribe closure.
   */
  onConnectionState(cb: (s: RTCPeerConnectionState) => void): () => void {
    this.connStateCbs.push(cb);
    return () => {
      this.connStateCbs = this.connStateCbs.filter((f) => f !== cb);
    };
  }

  /**
   * Fires whenever a camera Peer is (re)created — the first one at initial
   * join, and again on every reclaim/reconnect replacement. Gap identified
   * while wiring Task 10: the watchdog needs to reset() (bump generation /
   * clear the frame high-water mark — NOT a fresh alarm grace period)
   * exactly at adoption time, BEFORE the new peer's track/heartbeats arrive,
   * and no existing hook signals that moment (onConnectionState/
   * onDataMessage are peer-content streams, not an adoption edge). Fires
   * synchronously from adoptPeer(), before that peer's other callbacks are
   * wired. Returns an unsubscribe closure.
   */
  onPeerAdopted(cb: () => void): () => void {
    this.peerAdoptedCbs.push(cb);
    return () => {
      this.peerAdoptedCbs = this.peerAdoptedCbs.filter((f) => f !== cb);
    };
  }

  /**
   * Stats snapshot of the CURRENT camera Peer (Task 10's framesDecoded
   * watchdog polls this). Resolves null when no peer exists (not joined, or
   * waiting for the camera's first offer) — callers treat null as "nothing
   * to measure", not an error. Delegation follows peer replacement
   * automatically.
   */
  getStats(): Promise<RTCStatsReport | null> {
    if (this.peer === null) return Promise.resolve(null);
    return this.peer.getStats();
  }

  /**
   * Join a room. The code comes from the argument (input field) or, when
   * absent, from the URL fragment (#CODE); both are uppercase-normalized.
   * Invalid/absent code → stays 'idle' with an error hint so the UI shows
   * the input screen. No-op while already joining/joined.
   *
   * Socket-binding hazard: the relay binds a socket to ONE room, ever, and
   * only unbinds it on room-closed or socket close — leave() is local (see
   * its doc). A join() on a socket the relay still considers bound is
   * answered with error:invalid, which handleErrorReason surfaces as a join
   * failure (reload to fix). The one legitimate live-socket re-join is the
   * signaling-reconnect path (rung 2), which runs on a FRESH, unbound socket.
   */
  join(code?: string): void {
    const phase = this.state.phase;
    if (phase === 'joining' || phase === 'waiting-camera' || phase === 'live') return;
    const normalized = normalizeCode(code ?? this.location.hash);
    if (normalized === null) {
      this.setState({
        phase: 'idle',
        error: 'Enter the 8-character room code shown on the camera.',
      });
      return;
    }
    this.activeCode = normalized;
    this.rejoining = false;
    this.ensureSubscribed();
    this.signaling.connect();
    this.setState({
      phase: 'joining',
      roomCode: normalized,
      cameraPresent: false,
      error: undefined,
    });
    this.signaling.send({ type: 'join-room', code: normalized });
  }

  /**
   * THE audio gesture: flips muted (the UI unmutes the <video>) AND
   * creates/resumes the shared AudioContext so alert sounds (Tasks 10/11)
   * are unlocked by the same tap. Safe to call repeatedly — one context is
   * created and re-resumed.
   */
  unmute(): void {
    try {
      if (this.audioCtx === null) this.audioCtx = this.audioContextFactory();
      void Promise.resolve(this.audioCtx.resume()).catch(() => {});
    } catch {
      // Audio unlock failure is non-fatal: the video still unmutes.
    }
    this.setState({ muted: false });
  }

  /**
   * Local teardown: close the Peer, drop the stream, back to 'idle'. The
   * protocol has no leave message — the relay only removes a viewer when its
   * socket closes, so closing the page is the REAL leave. The signaling
   * client is shared/owned by the caller and stays untouched; note that the
   * relay still counts this socket as a room member, so a join() afterwards
   * (same room or different) is refused with error:invalid until the socket
   * rebinds — the UI surfaces that as a join failure telling the user to
   * reload (see join()'s socket-binding hazard note).
   */
  leave(): void {
    this.closePeer();
    this.setRemoteStream(null);
    this.activeCode = null;
    this.setState({
      phase: 'idle',
      roomCode: undefined,
      cameraPresent: false,
      error: undefined,
    });
  }

  // -- signaling wiring -------------------------------------------------------

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.signaling.onMessage((msg) => this.handleMessage(msg));
    this.signaling.onReconnected(() => this.handleReconnected());
  }

  /** Defensive: every S2C dispatched via switch; nothing here may throw. */
  private handleMessage(msg: S2C): void {
    const phase = this.state.phase;
    // Only an active session ('joining' → ack expected, 'waiting-camera'/
    // 'live' → in the room) processes relay traffic; anything arriving while
    // idle/ended/error is stale noise.
    if (phase !== 'joining' && phase !== 'waiting-camera' && phase !== 'live') return;
    try {
      switch (msg.type) {
        case 'room-joined':
          // In the room. cameraPresent=false still shows the waiting screen,
          // labeled "camera offline" by the UI; the camera's arrival later
          // announces itself via camera-back (reclaim) or its first offer.
          //
          // Defensive gate: a room-joined OUTSIDE 'joining' never happens
          // with the real relay (it acks join-room exactly once), so treat
          // it as a reset — drop any live Peer/stream before re-entering
          // the waiting state rather than leaving them orphaned.
          if (phase !== 'joining') {
            this.closePeer();
            this.setRemoteStream(null);
          }
          this.setState({
            phase: 'waiting-camera',
            cameraPresent: msg.cameraPresent,
            error: undefined,
          });
          return;
        case 'signal': {
          if (phase === 'joining') return; // not in the room yet: stale noise
          // Lazy camera-Peer creation/replacement — see the file header.
          if (this.peer === null || this.peer.remotePeerId !== msg.from) {
            this.adoptPeer(msg.from);
          }
          const peer = this.peer!;
          // Serial-await (Peer contract): each payload chained behind the
          // previous. handleSignal never rejects, but the catch keeps a
          // surprise rejection from poisoning the chain.
          this.chain = this.chain
            .then(() => peer.handleSignal(msg.payload))
            .catch(() => {});
          return;
        }
        case 'peer-left': {
          // The relay only sends viewers a peer-left for the camera (it
          // dropped without stop-camera). If we track a Peer under a
          // different id, this is stale noise for a replaced camera: ignore.
          if (phase === 'joining') return;
          if (this.peer !== null && this.peer.remotePeerId !== msg.peerId) return;
          // Clear the Peer AND the stream — the frozen last frame must not
          // masquerade as live video. Task 10 owns the real DOWN UX; for now
          // the UI shows the waiting state.
          this.closePeer();
          this.setRemoteStream(null);
          this.setState({ phase: 'waiting-camera', cameraPresent: false });
          return;
        }
        case 'camera-back':
          // The camera reclaimed/recreated the room. Server-side roster
          // replay hands it our peerId, so IT re-offers to us — under a
          // fresh camera peerId, which adoptPeer picks up from the first
          // inbound signal. Nothing to send; just reflect presence and keep
          // waiting for the new offer.
          if (phase === 'joining') return;
          this.setState({ cameraPresent: true });
          return;
        case 'room-closed':
          // Camera pressed Stop (or grace expired). Calm end state — this is
          // deliberate teardown, NOT an alarm (Task 10 distinguishes DOWN).
          this.closePeer();
          this.setRemoteStream(null);
          this.setState({ phase: 'ended', cameraPresent: false });
          return;
        case 'error':
          return this.handleErrorReason(msg.reason);
        case 'room-created':
        case 'peer-joined':
          return; // camera-directed messages: not applicable to the viewer
        default: {
          const _exhaustive: never = msg;
          return _exhaustive;
        }
      }
    } catch (err) {
      console.warn('[viewer-session] handler error', err);
    }
  }

  private handleErrorReason(reason: ErrorReason): void {
    switch (reason) {
      case 'bad-code':
        // Only meaningful as the join-room refusal; otherwise stale noise.
        if (this.state.phase === 'joining') {
          this.fail('Room not found — check the code and try again.');
        }
        return;
      case 'room-full':
        if (this.state.phase === 'joining') {
          this.fail('Room is full — too many viewers are connected.');
        }
        return;
      case 'rate-limited':
        this.fail('Rate limited by the server — wait a moment and retry.');
        return;
      case 'invalid':
        // During a USER-initiated join, error:invalid can only be the relay
        // refusing OUR join-room — the socket sent nothing else in that
        // phase — which means it is still bound to a previous room (join()
        // after leave(); see the socket-binding hazard on join()).
        // Surfacing it beats the alternative: swallowing it wedges the
        // session in 'joining' forever.
        //
        // NOT during a rung-2 re-join, though: stale signals queued during
        // the outage flush BEFORE our join-room (SignalingClient contract)
        // and each draws error:invalid — arriving while we are 'joining'.
        // On the reconnect's fresh, unbound socket the join-room itself can
        // never be refused as invalid, so those are noise and failing here
        // would wedge the recovery instead. Outside 'joining' invalid is
        // always that same stale-signal noise.
        if (this.state.phase === 'joining' && !this.rejoining) {
          this.fail('Could not join on this connection — reload the page and try again.');
        }
        return;
      case 'bad-token':
        // Camera-directed; can't apply to a viewer.
        return;
      default: {
        const _exhaustive: never = reason;
        return _exhaustive;
      }
    }
  }

  /**
   * Signaling reconnected (rung 2): the socket is NEW and unbound, so re-join
   * with the same code. The server assigns us a NEW peerId; the camera gets a
   * peer-joined for it and builds a fresh Peer + offer, which our lazy
   * peer-on-first-signal adopts (the old camera Peer is closed here first —
   * its transport rode the previous pairing). Skipped after 'ended' (the
   * room is gone; the user re-joins explicitly) and when never joined.
   *
   * Server-restart race: when the relay itself restarted, our re-join races
   * the camera's recreate-room and can draw bad-code a few seconds before
   * the camera re-registers the code — landing us on the error screen even
   * though the room is about to exist again. Task 10 owns the retry policy
   * for that window; until then the error screen's Join button (same code
   * pre-filled) is the one-tap recovery.
   */
  private handleReconnected(): void {
    if (this.activeCode === null) return;
    const phase = this.state.phase;
    if (phase === 'idle' || phase === 'ended') return;
    this.closePeer();
    this.setRemoteStream(null);
    this.rejoining = true;
    this.setState({ phase: 'joining', cameraPresent: false, error: undefined });
    this.signaling.send({ type: 'join-room', code: this.activeCode });
  }

  // -- peer -------------------------------------------------------------------

  /**
   * Create the camera Peer, replacing (closing) any prior one.
   *
   * Task 12 (push-to-talk) note: the viewer's mic transceiver must be added
   * HERE, synchronously at adopt time — i.e. re-added on EVERY adoption, so
   * a replaced (reclaimed) camera gets it too, with the PTT enabled-state
   * carried across replacements. Adding it at adopt time pre-negotiates the
   * m-line: viewer-side addTransceiver fires negotiationneeded and drives a
   * polite renegotiation via perfect negotiation (the viewer yields if it
   * collides with the camera's initial offer).
   */
  private adoptPeer(remotePeerId: string): void {
    const replacing = this.peer !== null;
    this.closePeer();
    if (replacing) {
      // A different sender means the reclaimed camera under a fresh peerId:
      // the old stream's transport is dead. Drop it and fall back to the
      // waiting state until the new offer's tracks arrive.
      this.setRemoteStream(null);
      if (this.state.phase === 'live') this.setState({ phase: 'waiting-camera' });
    }
    const peer = this.createPeer({
      role: 'viewer', // polite side of perfect negotiation: always answers
      remotePeerId,
      sendSignal: (payload) =>
        this.signaling.send({ type: 'signal', to: remotePeerId, payload }),
    });
    this.peer = peer;
    // Adoption edge (Task 10): fire before the peer's own callbacks are
    // wired below, so a subscriber resetting a watchdog can't race the first
    // connection-state/track event from the peer it's about to reset for.
    for (const cb of [...this.peerAdoptedCbs]) cb();
    this.peerUnsubs.push(
      peer.onTrack((ev) => {
        const stream = ev.streams[0];
        if (stream === undefined) return;
        this.setRemoteStream(stream);
        this.setState({ phase: 'live', cameraPresent: true });
      }),
    );
    this.peerUnsubs.push(
      peer.onDataMessage((text) => {
        for (const cb of [...this.dataCbs]) cb(text);
      }),
    );
    // Session-level connection-state stream (Task 10): re-wired on every
    // adoption so subscribers transparently follow peer replacement.
    this.peerUnsubs.push(
      peer.onConnectionState((s) => {
        for (const cb of [...this.connStateCbs]) cb(s);
      }),
    );
  }

  private closePeer(): void {
    if (this.peer === null) return;
    for (const unsub of this.peerUnsubs) unsub();
    this.peerUnsubs = [];
    this.peer.close();
    this.peer = null;
    // Fresh chain for the next peer: its signals must not queue behind
    // whatever the dead peer still had in flight.
    this.chain = Promise.resolve();
  }

  // -- state ------------------------------------------------------------------

  private fail(message: string): void {
    this.closePeer();
    this.setRemoteStream(null);
    this.setState({ phase: 'error', error: message, cameraPresent: false });
  }

  private setRemoteStream(stream: MediaStream | null): void {
    if (this.remoteStream === stream) return;
    this.remoteStream = stream;
    for (const cb of [...this.streamCbs]) cb(stream);
  }

  private setState(patch: Partial<ViewerState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of [...this.stateCbs]) cb(this.state);
  }
}
