// NannyCam camera session — ALL camera-side logic, zero DOM/Preact.
//
// The UI (main.tsx) is a thin renderer over this class: it subscribes to
// onState and calls start()/stop(). Everything else — media acquisition, the
// room-entry decision ladder, per-viewer Peer management, heartbeats, wake
// lock, and the reconnection ladder — lives here behind injectable seams so
// bun tests run with no browser at all.
//
// Room-entry decision ladder (spec):
//   no persisted code+token  → create-room
//   persisted                → reclaim-room
//     error bad-code  (server restarted, room gone) → recreate-room, same code
//     error bad-token (token mismatch)              → clear token, create-room
//   room-created is the success ack for ALL of create/reclaim/recreate — for
//   reclaim it carries our NEW peerId and echoes the code/token.

import type { C2S, S2C, ErrorReason } from '../../shared/protocol.ts';
import { Peer, type PeerOptions } from '../lib/peer.ts';
import { DetectorController, type AudioContextLike, type DetectorSettings } from './detectors.ts';

export const STORAGE_CODE_KEY = 'nannycam.code';
export const STORAGE_TOKEN_KEY = 'nannycam.token';
// Re-exported for backward compatibility — the detect.* storage keys and the
// DetectorSettings type now live in detectors.ts (DetectorController owns
// them); session.ts no longer reads/writes them directly.
export {
  STORAGE_DETECT_NOISE_ENABLED_KEY,
  STORAGE_DETECT_MOTION_ENABLED_KEY,
  STORAGE_DETECT_NOISE_THRESHOLD_KEY,
  STORAGE_DETECT_MOTION_THRESHOLD_KEY,
} from './detectors.ts';
export type { DetectorSettings } from './detectors.ts';
export const HEARTBEAT_INTERVAL_MS = 2000;

export type CameraPhase =
  | 'idle'
  | 'acquiring-media'
  | 'connecting'
  | 'live'
  | 'stopped'
  | 'error';

export interface CameraState {
  phase: CameraPhase;
  roomCode?: string;
  /** Full viewer URL (encoded into the QR): `<origin>/viewer.html#<code>`. */
  viewerUrl?: string;
  viewerCount: number;
  error?: string;
}

/**
 * Task 12 (talk-back): one connected viewer's inbound PTT mic stream. Multiple
 * viewers may hold PTT concurrently — onRemoteAudio hands the UI the full
 * current list (keyed by peerId) rather than a single stream, so it can mix
 * by playing every entry's hidden `<audio autoplay>` element at once.
 */
export interface RemoteAudioEntry {
  peerId: string;
  stream: MediaStream;
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
  readonly track: MediaStreamTrack;
  readonly streams: ReadonlyArray<MediaStream>;
}

/** The slice of Peer the session uses; the real Peer satisfies it as-is. */
export interface PeerLike {
  readonly remotePeerId: string;
  addTrack(track: MediaStreamTrack, stream: MediaStream): unknown;
  handleSignal(payload: unknown): Promise<void>;
  sendData(text: string): boolean;
  close(): void;
  readonly isDataOpen: boolean;
  onDataOpen(cb: () => void): () => void;
  onConnectionState(cb: (s: RTCPeerConnectionState) => void): () => void;
  /** Task 12 (talk-back): inbound tracks from a viewer's PTT mic. */
  onTrack(cb: (ev: TrackEventLike) => void): () => void;
}

/** The slice of localStorage the session uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Wake-lock sentinel/API slices (navigator.wakeLock where available). */
export interface WakeLockSentinelLike {
  release(): Promise<void>;
}
export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** Visibility source (document where available). */
export interface VisibilityLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', cb: () => void): void;
}

export interface CameraSessionOptions {
  signaling: SignalingLike;
  storage: StorageLike;
  /** window.location satisfies this; `hash` is assigned to reflect the code. */
  location: { origin: string; hash: string };
  /** Media seam; defaults to getUserMedia (rear camera + mic). */
  getMedia?: () => Promise<MediaStream>;
  /** Peer factory seam; defaults to `new Peer(opts)`. */
  createPeer?: (opts: PeerOptions) => PeerLike;
  /** Timer seams for deterministic heartbeat tests. */
  setIntervalFn?: (fn: () => void, ms: number) => number;
  clearIntervalFn?: (id: number) => void;
  /** Wake-lock seam; defaults to navigator.wakeLock where present. */
  wakeLock?: WakeLockLike;
  /** Visibility seam; defaults to document where present. */
  visibility?: VisibilityLike;
  /** Clock seam for the detector thresholds; defaults to Date.now. */
  now?: () => number;
  /**
   * AudioContext factory for noise detection; defaults to `new AudioContext()`
   * (browser only). The camera side creates its OWN context (no gesture
   * issue — the getUserMedia gesture already happened before 'live'), guarded
   * in a try/catch since construction can still fail (unsupported browser).
   * Forwarded to DetectorController as-is.
   */
  audioContextFactory?: () => AudioContextLike;
  /** Noise source factory seam; forwarded to DetectorController. */
  createNoiseSource?: (
    stream: MediaStream,
    ctx: AudioContextLike,
    onLevel: (rms: number) => void,
  ) => { stop(): void };
  /** Motion source factory seam; forwarded to DetectorController. */
  createMotionSource?: (
    videoEl: HTMLVideoElement,
    onFraction: (fraction: number) => void,
  ) => { stop(): void };
  /**
   * Initial detector settings, used only as the fallback when nothing is yet
   * persisted in storage. Mainly a test seam; forwarded to DetectorController.
   */
  detectors?: Partial<DetectorSettings>;
  /**
   * MediaStream constructor seam (Task 12 talk-back); defaults to
   * `new MediaStream(tracks)`. The viewer's PTT transceiver is added
   * up-front with no associated stream (see viewer/session.ts's adoptPeer —
   * there is no MediaStream to associate at addTransceiver time, only a
   * bare track attached later via replaceTrack), so the inbound
   * RTCTrackEvent's `streams` array is empty; this synthesizes a one-track
   * MediaStream from `ev.track` so onRemoteAudio always hands the UI a
   * playable stream. Also lets bun tests avoid the real (DOM-only)
   * MediaStream constructor.
   */
  createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}

interface PeerRecord {
  peer: PeerLike;
  /** Heartbeat sequence number, incremented per send. */
  seq: number;
  hbTimer: number | null;
  /**
   * Per-peer serial promise chain for inbound signal payloads. Peer docs:
   * each handleSignal call MUST be awaited before feeding the next payload
   * from the same peer — concurrent calls corrupt negotiation state.
   */
  chain: Promise<void>;
  /** Last connection state reported by the peer (for the rung-3 sweep). */
  connState: RTCPeerConnectionState;
  unsubs: Array<() => void>;
}

export class CameraSession {
  private readonly signaling: SignalingLike;
  private readonly storage: StorageLike;
  private readonly location: { origin: string; hash: string };
  private readonly getMedia: () => Promise<MediaStream>;
  private readonly createPeer: (opts: PeerOptions) => PeerLike;
  private readonly setIntervalFn: (fn: () => void, ms: number) => number;
  private readonly clearIntervalFn: (id: number) => void;
  private readonly wakeLockApi: WakeLockLike | undefined;
  private readonly visibility: VisibilityLike | undefined;
  private readonly now: () => number;
  private readonly createMediaStream: (tracks: MediaStreamTrack[]) => MediaStream;

  private state: CameraState = { phase: 'idle', viewerCount: 0 };
  private stateCbs: Array<(s: CameraState) => void> = [];

  private stream: MediaStream | null = null;
  private peers = new Map<string, PeerRecord>();
  /** Which entry-ladder request is awaiting its ack; null when settled. */
  private attempt: 'create' | 'reclaim' | 'recreate' | null = null;
  private roomCode: string | null = null;
  private cameraToken: string | null = null;
  private running = false;
  private subscribed = false;
  private wakeSentinel: WakeLockSentinelLike | null = null;
  /** True while a wakeLock.request() is in flight (single-acquire guard). */
  private wakeAcquiring = false;

  // -- detectors (Task 11 logic, owned by DetectorController since Task 12) --
  private readonly detectors: DetectorController;
  // -- talk-back (Task 12): map peerId -> that viewer's inbound mic stream. --
  private readonly remoteAudio = new Map<string, MediaStream>();
  private remoteAudioCbs: Array<(entries: RemoteAudioEntry[]) => void> = [];

  constructor(opts: CameraSessionOptions) {
    this.signaling = opts.signaling;
    this.storage = opts.storage;
    this.location = opts.location;
    this.getMedia =
      opts.getMedia ??
      (() =>
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: true,
        }));
    this.createPeer = opts.createPeer ?? ((o) => new Peer(o));
    this.setIntervalFn =
      opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms) as unknown as number);
    this.clearIntervalFn =
      opts.clearIntervalFn ??
      ((id) => clearInterval(id as unknown as ReturnType<typeof setInterval>));
    this.wakeLockApi =
      opts.wakeLock ??
      (typeof navigator !== 'undefined' ? navigator.wakeLock : undefined);
    this.visibility =
      opts.visibility ?? (typeof document !== 'undefined' ? document : undefined);
    this.now = opts.now ?? Date.now;
    this.createMediaStream = opts.createMediaStream ?? ((tracks) => new MediaStream(tracks));
    this.detectors = new DetectorController({
      storage: this.storage,
      getStream: () => this.stream,
      onAlert: (kind) => this.broadcastAlert(kind),
      now: this.now,
      audioContextFactory: opts.audioContextFactory,
      createNoiseSource: opts.createNoiseSource,
      createMotionSource: opts.createMotionSource,
      detectors: opts.detectors,
    });
  }

  /** Current local media stream, for the (muted) preview element. */
  get localStream(): MediaStream | null {
    return this.stream;
  }

  /** Current detector settings (enabled flags + thresholds), for the Alerts panel UI. */
  getDetectorSettings(): DetectorSettings {
    return this.detectors.getSettings();
  }

  setNoiseEnabled(enabled: boolean): void {
    this.detectors.setNoiseEnabled(enabled);
  }

  setMotionEnabled(enabled: boolean): void {
    this.detectors.setMotionEnabled(enabled);
  }

  setNoiseThreshold(threshold: number): void {
    this.detectors.setNoiseThreshold(threshold);
  }

  setMotionThreshold(threshold: number): void {
    this.detectors.setMotionThreshold(threshold);
  }

  /**
   * Motion detection needs the local video element to draw frames from, but
   * this class is deliberately DOM-free otherwise — the UI (main.tsx) calls
   * this with the live preview element once it mounts, and with null when it
   * unmounts/the session stops. Motion detection only runs while a preview
   * element is attached (acceptable v1 limitation — see the Task 11 design
   * doc). Safe to call repeatedly (e.g. every render); a no-op re-attach of
   * the same element leaves the running source untouched.
   */
  attachMotionSource(videoEl: HTMLVideoElement | null): void {
    this.detectors.attachMotionSource(videoEl);
  }

  /**
   * Subscribe to state changes. The callback fires immediately with the
   * current state, then on every change. Returns an unsubscribe closure.
   */
  onState(cb: (s: CameraState) => void): () => void {
    this.stateCbs.push(cb);
    cb(this.state);
    return () => {
      this.stateCbs = this.stateCbs.filter((f) => f !== cb);
    };
  }

  /**
   * Subscribe to talk-back (Task 12) audio from connected viewers. Fires
   * immediately with the current list (same convention as onState), then on
   * every change — a viewer starting/stopping a PTT press doesn't itself
   * change this list (see the design note on CameraSession.PeerLike.onTrack:
   * the transceiver/track exists once negotiated regardless of press state),
   * but a viewer's Peer being adopted or leaving does. Kept deliberately
   * simple (whole-list callback) rather than a per-peerId callback — the UI
   * only needs to render "one hidden <audio> per current entry".
   */
  onRemoteAudio(cb: (entries: RemoteAudioEntry[]) => void): () => void {
    this.remoteAudioCbs.push(cb);
    cb(this.remoteAudioEntries());
    return () => {
      this.remoteAudioCbs = this.remoteAudioCbs.filter((f) => f !== cb);
    };
  }

  /** Gesture-triggered (getUserMedia requires one). Idempotent while running. */
  async start(): Promise<void> {
    if (this.running || this.state.phase === 'acquiring-media') return;
    this.setState({ phase: 'acquiring-media', error: undefined });
    let stream: MediaStream;
    try {
      stream = await this.getMedia();
    } catch (err) {
      this.setState({
        phase: 'error',
        error: `Camera access failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    this.running = true;
    this.stream = stream;
    this.detectors.setRunning(true);
    this.setState({ phase: 'connecting' });
    this.ensureSubscribed();
    this.signaling.connect();
    void this.acquireWakeLock();
    this.runEntryLadder();
  }

  /**
   * Explicit teardown: stop-camera to the relay, close peers, release media
   * and wake lock, clear persistence + fragment. Phase → 'stopped'.
   */
  stop(): void {
    if (this.roomCode !== null && this.cameraToken !== null) {
      this.signaling.send({
        type: 'stop-camera',
        code: this.roomCode,
        cameraToken: this.cameraToken,
      });
    }
    // Order matters for the wake-lock race guard: running=false BEFORE the
    // releases, so an in-flight acquireWakeLock() discards its sentinel.
    this.running = false;
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.releaseMedia();
    this.releaseWakeLock();
    this.detectors.attachMotionSource(null);
    this.detectors.setRunning(false); // tears down both the noise (+ its AudioContext) and motion sources
    // Review fix (adversarial fuzz / extraction divergence): without this,
    // DetectorController's cached `live` flag stays true across stop(), so a
    // later start() (setRunning(true), while `stream` is already set) would
    // start the noise analyser immediately during 'acquiring-media'/
    // 'connecting' — before phase ever reaches 'live' again. Pre-extraction
    // behavior gated strictly on phase === 'live'; this restores it.
    this.detectors.setLive(false);
    this.storage.removeItem(STORAGE_CODE_KEY);
    this.storage.removeItem(STORAGE_TOKEN_KEY);
    this.location.hash = '';
    this.roomCode = null;
    this.cameraToken = null;
    this.attempt = null;
    this.setState({
      phase: 'stopped',
      roomCode: undefined,
      viewerUrl: undefined,
      viewerCount: 0,
    });
  }

  // -- signaling wiring -------------------------------------------------------

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.signaling.onMessage((msg) => this.handleMessage(msg));
    this.signaling.onReconnected(() => this.handleReconnected());
    this.visibility?.addEventListener('visibilitychange', () => {
      if (this.visibility?.visibilityState === 'visible') this.handleVisible();
    });
  }

  /** Entry decision ladder: persisted code+token → reclaim; else → create. */
  private runEntryLadder(): void {
    const code = this.storage.getItem(STORAGE_CODE_KEY);
    const token = this.storage.getItem(STORAGE_TOKEN_KEY);
    if (code !== null && token !== null) {
      this.attempt = 'reclaim';
      this.signaling.send({ type: 'reclaim-room', code, cameraToken: token });
    } else {
      this.attempt = 'create';
      this.signaling.send({ type: 'create-room' });
    }
  }

  /** Defensive: every S2C dispatched via switch; nothing here may throw. */
  private handleMessage(msg: S2C): void {
    if (!this.running) return;
    try {
      switch (msg.type) {
        case 'room-created': {
          // Success ack for create/reclaim/recreate alike; for reclaim it
          // carries our NEW peerId and echoes the code/token, so persisting
          // both is correct in all three cases (reclaim rewrites identical
          // values — the "keep existing" semantics fall out for free).
          this.attempt = null;
          this.roomCode = msg.code;
          this.cameraToken = msg.cameraToken;
          this.storage.setItem(STORAGE_CODE_KEY, msg.code);
          this.storage.setItem(STORAGE_TOKEN_KEY, msg.cameraToken);
          // Reflect the code into the fragment so a reload can reclaim.
          this.location.hash = `#${msg.code}`;
          this.setState({
            phase: 'live',
            roomCode: msg.code,
            viewerUrl: `${this.location.origin}/viewer.html#${msg.code}`,
            error: undefined,
          });
          // Noise detection needs phase 'live' (see DetectorController.
          // syncNoiseSource); motion is re-synced too in case
          // attachMotionSource() ran before this point.
          this.detectors.setLive(true);
          return;
        }
        case 'peer-joined':
          return this.addPeer(msg.peerId);
        case 'peer-left':
          return this.removePeer(msg.peerId);
        case 'signal': {
          const rec = this.peers.get(msg.from);
          if (rec === undefined) return; // unknown sender: ignore
          // Serial-await per peer (Peer contract): each payload is chained
          // behind the previous one. handleSignal never rejects, but the
          // catch keeps a surprise rejection from poisoning the chain.
          rec.chain = rec.chain
            .then(() => rec.peer.handleSignal(msg.payload))
            .catch(() => {});
          return;
        }
        case 'error':
          return this.handleErrorReason(msg.reason);
        case 'room-joined':
        case 'camera-back':
        case 'room-closed':
          return; // viewer-directed messages: not applicable to the camera
        default: {
          const _exhaustive: never = msg;
          return _exhaustive;
        }
      }
    } catch (err) {
      console.warn('[camera-session] handler error', err);
    }
  }

  private handleErrorReason(reason: ErrorReason): void {
    switch (reason) {
      case 'bad-code': {
        if (this.attempt === 'reclaim') {
          // Server restarted (room gone): recreate under the SAME code so
          // printed/scanned viewer links keep working.
          const code = this.storage.getItem(STORAGE_CODE_KEY);
          if (code !== null) {
            this.attempt = 'recreate';
            this.signaling.send({ type: 'recreate-room', code });
            return;
          }
        }
        if (this.attempt === 'recreate') {
          // Recreate refused (e.g. the code is live again under another
          // socket). Last rung: give up on the old identity, mint fresh.
          this.storage.removeItem(STORAGE_CODE_KEY);
          this.storage.removeItem(STORAGE_TOKEN_KEY);
          this.attempt = 'create';
          this.signaling.send({ type: 'create-room' });
        }
        return;
      }
      case 'bad-token': {
        if (this.attempt === 'reclaim') {
          // Token mismatch: fall back to a FRESH room. The old room's viewers
          // see DOWN until its grace expiry — acceptable; they re-pair via
          // the new code/QR.
          this.storage.removeItem(STORAGE_TOKEN_KEY);
          this.attempt = 'create';
          this.signaling.send({ type: 'create-room' });
        }
        return;
      }
      case 'rate-limited': {
        if (this.attempt !== null) {
          this.attempt = null;
          // Full failure teardown: without it the session would sit in
          // phase 'error' with running=true (Retry dead), the camera LED on,
          // and the wake lock held — no escape but a reload.
          this.failSession('Rate limited by the server — wait a moment and retry.');
        }
        return;
      }
      case 'invalid':
      case 'room-full':
        // 'invalid' is expected noise: stale signals queued during an outage
        // flush before our reclaim rebinds the socket, and the relay answers
        // each with error:invalid (see SignalingClient.send docs).
        return;
      default: {
        const _exhaustive: never = reason;
        return _exhaustive;
      }
    }
  }

  /**
   * Signaling reconnected: the socket is NEW and unbound, so re-run the entry
   * ladder (reclaim with persisted code+token). On success the server replays
   * one peer-joined per current viewer, which recreates Peers and re-offers.
   * Old Peer objects are closed first: media may briefly still flow P2P, but
   * the roster replay is about to rebuild every pairing under our new peerId,
   * so a clean rebuild beats reconciling stale state. Note: signals queued
   * during the outage flush BEFORE onReconnected fires (SignalingClient
   * contract) — the relay answers those with error:invalid; acceptable noise.
   *
   * Also pauses noise detection for the reconnect window (phase leaves
   * 'live') — Task 12 review fix: previously nothing re-evaluated
   * DetectorController's run condition here, so a noise source kept
   * sampling/firing through a reconnect despite the "avoids spurious
   * pre-pairing alerts" doc promise on syncNoiseSource. It resumes
   * automatically once the reclaim's room-created lands (setLive(true)).
   */
  private handleReconnected(): void {
    if (!this.running) return;
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.detectors.setLive(false);
    this.setState({ phase: 'connecting', viewerCount: 0 });
    this.runEntryLadder();
  }

  /**
   * Reconnection-ladder rung 3 (tab suspended → visible): re-acquire the wake
   * lock, then sweep peers. Division of labor: if a peer's data channel and
   * connection survived suspension there is nothing to do; if its connection
   * died ('failed'/'closed'/'disconnected') we only CLEAN UP here — the
   * VIEWER side watchdog (Tasks 8/10) drives its own re-join, which produces
   * a fresh peer-joined for us and a clean re-offer. The viewer re-join path
   * is the designed recovery; the camera never guesses at the roster.
   */
  private handleVisible(): void {
    if (!this.running) return;
    void this.acquireWakeLock();
    for (const [id, rec] of [...this.peers]) {
      if (
        rec.connState === 'failed' ||
        rec.connState === 'closed' ||
        rec.connState === 'disconnected'
      ) {
        this.removePeer(id);
      }
    }
  }

  // -- peers ------------------------------------------------------------------

  private addPeer(remotePeerId: string): void {
    // A replayed roster (reclaim) may re-announce an id we already track:
    // rebuild cleanly rather than double-wire.
    if (this.peers.has(remotePeerId)) this.removePeer(remotePeerId);
    const peer = this.createPeer({
      role: 'camera',
      remotePeerId,
      sendSignal: (payload) =>
        this.signaling.send({ type: 'signal', to: remotePeerId, payload }),
    });
    const rec: PeerRecord = {
      peer,
      seq: 0,
      hbTimer: null,
      chain: Promise.resolve(),
      connState: 'new',
      unsubs: [],
    };
    rec.unsubs.push(peer.onDataOpen(() => this.startHeartbeat(rec)));
    rec.unsubs.push(
      peer.onConnectionState((s) => {
        rec.connState = s;
      }),
    );
    // Task 12 (talk-back): the viewer pre-negotiates a sendonly audio
    // transceiver at its own adopt time (see viewer/session.ts's adoptPeer),
    // so this fires once that negotiation lands here — independent of
    // whether the viewer has actually pressed PTT yet (see onRemoteAudio's
    // doc). Filter to 'audio': this app never negotiates any other inbound
    // kind on the camera side.
    //
    // ev.streams is normally EMPTY here, not populated: the viewer's
    // addTransceiver() call has no MediaStream to associate at adopt time
    // (only a bare track, attached later via replaceTrack on first press —
    // see adoptPeer's doc), so the negotiated m-line carries no msid.
    // Synthesize a one-track MediaStream from ev.track so onRemoteAudio
    // always hands the UI something playable (confirmed against a real
    // browser during Task 12's e2e run — the naive `ev.streams[0] ??
    // return` version silently dropped every remote-audio entry).
    rec.unsubs.push(
      peer.onTrack((ev) => {
        if (ev.track.kind !== 'audio') return;
        const stream = ev.streams[0] ?? this.createMediaStream([ev.track]);
        this.setRemoteAudio(remotePeerId, stream);
      }),
    );
    // onDataOpen is edge-triggered; cover an already-open channel (defensive —
    // for role 'camera' the channel is created pre-offer and can't be open yet).
    if (peer.isDataOpen) this.startHeartbeat(rec);
    // Adding tracks fires negotiationneeded inside Peer → offer to the viewer.
    if (this.stream !== null) {
      for (const track of this.stream.getTracks()) peer.addTrack(track, this.stream);
    }
    this.peers.set(remotePeerId, rec);
    this.setState({ viewerCount: this.peers.size });
  }

  private removePeer(remotePeerId: string): void {
    const rec = this.peers.get(remotePeerId);
    if (rec === undefined) return;
    this.peers.delete(remotePeerId);
    if (rec.hbTimer !== null) this.clearIntervalFn(rec.hbTimer);
    rec.hbTimer = null;
    for (const unsub of rec.unsubs) unsub();
    rec.peer.close();
    this.setRemoteAudio(remotePeerId, null); // that viewer's PTT audio (if any) is gone with it
    this.setState({ viewerCount: this.peers.size });
  }

  /** Heartbeat {t:'hb', seq} every 2 s while the data channel is open. */
  private startHeartbeat(rec: PeerRecord): void {
    if (rec.hbTimer !== null) return;
    rec.hbTimer = this.setIntervalFn(() => {
      rec.peer.sendData(JSON.stringify({ t: 'hb', seq: rec.seq }));
      rec.seq++;
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Failure-path teardown (e.g. rate-limited): release everything a live
   * session holds — peers, media, wake lock — and stop running so start()
   * can retry cleanly. Persistence is deliberately KEPT (unlike stop()):
   * a retry should still reclaim the same room.
   */
  private failSession(message: string): void {
    this.running = false; // before the releases: see the wake-lock race guard
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.releaseMedia();
    this.releaseWakeLock();
    this.detectors.attachMotionSource(null);
    this.detectors.setRunning(false);
    // Review fix — same divergence as stop(): the cached `live` flag must
    // not survive a failure teardown either, or a Retry (start() again)
    // would start the noise analyser before phase reaches 'live'.
    this.detectors.setLive(false);
    this.setState({ phase: 'error', error: message, viewerCount: 0 });
  }

  private releaseMedia(): void {
    if (this.stream === null) return;
    for (const track of this.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Already stopped.
      }
    }
    this.stream = null;
  }

  // -- detectors (Task 11 logic; see DetectorController in detectors.ts) -----

  /**
   * Broadcast an alert event to ALL connected peers over the existing
   * heartbeat data channel — fire-and-forget (Peer.sendData no-ops and
   * returns false on a dead/not-yet-open channel; nothing here checks the
   * return value, same as the heartbeat sender above). Passed to
   * DetectorController as its onAlert callback; this is the one piece of
   * detector-adjacent logic that stays here since it's pure data-channel
   * transport, not detection logic.
   */
  private broadcastAlert(kind: 'noise' | 'motion'): void {
    const msg = JSON.stringify({ t: 'alert', kind, at: this.now() });
    for (const rec of this.peers.values()) rec.peer.sendData(msg);
  }

  // -- talk-back (Task 12) -----------------------------------------------

  private remoteAudioEntries(): RemoteAudioEntry[] {
    return [...this.remoteAudio.entries()].map(([peerId, stream]) => ({ peerId, stream }));
  }

  private setRemoteAudio(peerId: string, stream: MediaStream | null): void {
    if (stream === null) {
      if (!this.remoteAudio.has(peerId)) return; // no-op: nothing to clear
      this.remoteAudio.delete(peerId);
    } else {
      this.remoteAudio.set(peerId, stream);
    }
    const entries = this.remoteAudioEntries();
    for (const cb of [...this.remoteAudioCbs]) cb(entries);
  }

  // -- wake lock --------------------------------------------------------------

  private async acquireWakeLock(): Promise<void> {
    // Single-acquire guard: repeated visibilitychange events must not pile
    // up concurrent request() calls (each resolution would orphan a sentinel).
    if (this.wakeLockApi === undefined || this.wakeAcquiring) return;
    this.wakeAcquiring = true;
    try {
      const sentinel = await this.wakeLockApi.request('screen');
      // Race: stop() (or a failure teardown) may have run while request()
      // was in flight — it released this.wakeSentinel, but THIS sentinel
      // resolved after. Discard it instead of holding the screen awake on
      // the stopped screen.
      if (!this.running) {
        void sentinel.release().catch(() => {});
        return;
      }
      // Release any previous sentinel before replacing it (re-acquire on a
      // later visibilitychange while the old one is still held).
      if (this.wakeSentinel !== null && this.wakeSentinel !== sentinel) {
        void this.wakeSentinel.release().catch(() => {});
      }
      this.wakeSentinel = sentinel;
    } catch {
      // Denied (battery saver, not visible, unsupported): non-fatal — the
      // pre-flight checklist (Task 13) surfaces wake-lock status to the user.
    } finally {
      this.wakeAcquiring = false;
    }
  }

  private releaseWakeLock(): void {
    if (this.wakeSentinel !== null) {
      void this.wakeSentinel.release().catch(() => {});
      this.wakeSentinel = null;
    }
  }

  // -- state ------------------------------------------------------------------

  private setState(patch: Partial<CameraState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of [...this.stateCbs]) cb(this.state);
  }
}
