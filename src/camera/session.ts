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

export const STORAGE_CODE_KEY = 'nannycam.code';
export const STORAGE_TOKEN_KEY = 'nannycam.token';
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

/** The slice of SignalingClient the session uses (mockable in tests). */
export interface SignalingLike {
  connect(): void;
  send(msg: C2S): void;
  onMessage(cb: (msg: S2C) => void): () => void;
  onReconnected(cb: () => void): () => void;
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
  }

  /** Current local media stream, for the (muted) preview element. */
  get localStream(): MediaStream | null {
    return this.stream;
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
   */
  private handleReconnected(): void {
    if (!this.running) return;
    for (const id of [...this.peers.keys()]) this.removePeer(id);
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
