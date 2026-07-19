// NannyCam client signaling library — browser-side WebSocket wrapper around
// the wire protocol (shared/protocol.ts) with automatic reconnection.
//
// Runs in the BROWSER (and in bun tests): only web-standard APIs. The socket
// and timers are injectable so tests run with no real network and no real
// timers; the defaults use the global WebSocket and setTimeout/clearTimeout.

import { parseMessage, type C2S, type S2C } from '../../shared/protocol.ts';

/**
 * The slice of the WebSocket API the client uses (event-listener style, so
 * the real browser `WebSocket` satisfies it as-is). Mock sockets in tests
 * implement exactly this surface. Listener registration only — the client
 * never removes listeners; it instead ignores events from sockets it has
 * already replaced.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (ev: { data?: unknown }) => void,
  ): void;
}

export type SignalingStatus = 'connecting' | 'open' | 'closed';

export interface SignalingClientOptions {
  /** Relay endpoint, e.g. wss://host/ws. */
  url: string;
  /** Socket factory; injectable for tests. Defaults to `new WebSocket(url)`. */
  createSocket?: (url: string) => WebSocketLike;
  /** Timer scheduling; injectable for tests. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => number;
  /** Timer cancellation; injectable for tests. Defaults to clearTimeout. */
  clearTimer?: (id: number) => void;
}

/** First reconnect delay; doubles per consecutive failure. */
export const INITIAL_BACKOFF_MS = 1000;
/** Backoff ceiling. */
export const MAX_BACKOFF_MS = 30000;

/**
 * Typed signaling channel to the relay with queue-while-disconnected sends
 * and exponential-backoff reconnection (1s, 2s, 4s, ... capped at 30s;
 * reset to 1s on a successful open).
 *
 * Lifecycle: `connect()` starts the connection and the auto-reconnect loop;
 * `close()` is the intentional shutdown — it stops the loop, drops the send
 * queue, and makes further `send()` calls no-ops (until a new `connect()`).
 */
export class SignalingClient {
  private readonly url: string;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  /** The live socket. Events from any other (stale) socket are ignored. */
  private socket: WebSocketLike | null = null;
  private currentStatus: SignalingStatus = 'closed';
  private queue: C2S[] = [];
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: number | null = null;
  /** Intentionally closed via close(); suppresses reconnects and sends. */
  private stopped = true;
  /**
   * True once any socket has opened; gates onReconnected vs first open.
   * Deliberately survives close(): after close()+connect(), the next open
   * fires onReconnected (see the onReconnected doc).
   */
  private everOpened = false;

  private messageCbs: Array<(msg: S2C) => void> = [];
  private reconnectedCbs: Array<() => void> = [];
  private statusCbs: Array<(s: SignalingStatus) => void> = [];

  constructor(opts: SignalingClientOptions) {
    this.url = opts.url;
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url));
    // Browser setTimeout returns number; bun returns a Timer object. Both are
    // opaque handles round-tripped to the matching clear function, so the
    // cast is safe for the default pairing.
    this.setTimer =
      opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
    this.clearTimer =
      opts.clearTimer ?? ((id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
  }

  /** Current connection status (same value the onStatusChange stream reports). */
  get status(): SignalingStatus {
    return this.currentStatus;
  }

  /** Idempotent: starts the connection + auto-reconnect loop. */
  connect(): void {
    if (this.socket !== null || this.reconnectTimer !== null) return;
    this.stopped = false;
    this.openSocket();
  }

  /** Intentional close: stops the reconnect loop and clears the send queue. */
  close(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.queue = [];
    const sock = this.socket;
    this.socket = null;
    if (sock !== null) {
      try {
        sock.close();
      } catch {
        // Already closing/closed.
      }
    }
    this.setStatus('closed');
  }

  /**
   * Send a message; queued FIFO while not open and flushed on (re)open.
   * After close() this is a documented no-op until connect() is called again.
   *
   * The queue is UNBOUNDED during outages: sessions that emit time-sensitive
   * traffic (e.g. ICE candidates) should clear or re-think stale queued
   * signals in their onReconnected handler rather than rely on the backlog.
   */
  send(msg: C2S): void {
    if (this.stopped) return;
    if (this.currentStatus === 'open' && this.socket !== null) {
      try {
        this.socket.send(JSON.stringify(msg));
      } catch {
        // Socket died between 'open' and the close event: keep the message
        // for the reconnect flush.
        this.queue.push(msg);
      }
    } else {
      this.queue.push(msg);
    }
  }

  /**
   * Inbound frames that pass parseMessage(raw, 's2c'); invalid frames are
   * dropped silently. Returns an unsubscribe closure; without calling it the
   * registration lasts the client's lifetime.
   */
  onMessage(cb: (msg: S2C) => void): () => void {
    this.messageCbs.push(cb);
    return () => {
      this.messageCbs = this.messageCbs.filter((f) => f !== cb);
    };
  }

  /**
   * Fires on every successful (re)open EXCEPT the very first open of the
   * client's lifetime — for session re-claim/re-join. Two nuances:
   *
   * 1. It fires AFTER the queued backlog has flushed, so messages queued
   *    while disconnected reach the server BEFORE anything sent from this
   *    callback (e.g. queued signals land before your re-claim).
   * 2. "First open" is per client lifetime, not per connect(): after
   *    close() followed by connect(), the next open DOES fire onReconnected,
   *    since the session may still need to re-claim/re-join.
   *
   * Returns an unsubscribe closure; without calling it the registration
   * lasts the client's lifetime.
   */
  onReconnected(cb: () => void): () => void {
    this.reconnectedCbs.push(cb);
    return () => {
      this.reconnectedCbs = this.reconnectedCbs.filter((f) => f !== cb);
    };
  }

  /**
   * Status stream for UI badges; fires only on transitions. Returns an
   * unsubscribe closure; without calling it the registration lasts the
   * client's lifetime.
   */
  onStatusChange(cb: (s: SignalingStatus) => void): () => void {
    this.statusCbs.push(cb);
    return () => {
      this.statusCbs = this.statusCbs.filter((f) => f !== cb);
    };
  }

  // -- internals ------------------------------------------------------------

  private openSocket(): void {
    const sock = this.createSocket(this.url);
    this.socket = sock;
    this.setStatus('connecting');

    sock.addEventListener('open', () => {
      if (sock !== this.socket || this.stopped) return;
      const isReconnect = this.everOpened;
      this.everOpened = true;
      this.backoffMs = INITIAL_BACKOFF_MS;
      // Flush BEFORE announcing 'open': a send() issued from inside a status
      // callback must not jump ahead of the queued FIFO backlog.
      this.flushQueue(sock);
      this.setStatus('open');
      if (isReconnect) {
        for (const cb of this.reconnectedCbs) cb();
      }
    });

    sock.addEventListener('message', (ev) => {
      if (sock !== this.socket) return;
      if (typeof ev.data !== 'string') return; // binary frames are not protocol
      const msg = parseMessage(ev.data, 's2c');
      if (msg === null) return; // dropped silently
      for (const cb of this.messageCbs) cb(msg);
    });

    // 'error' and 'close' share one handler: whichever arrives first tears
    // the socket down and schedules the reconnect; the stale-socket guard
    // makes the second event a no-op (no double-scheduling on error+close).
    const onDown = () => {
      if (sock !== this.socket) return;
      this.socket = null;
      try {
        sock.close(); // ensure teardown when 'error' fires without 'close'
      } catch {
        // Already closing/closed.
      }
      // Schedule the reconnect BEFORE announcing 'closed': a consumer calling
      // connect() from inside its onStatusChange callback must hit the
      // pending-timer guard instead of racing the reconnect loop with a
      // second socket.
      if (!this.stopped) this.scheduleReconnect();
      this.setStatus('closed');
    };
    sock.addEventListener('close', onDown);
    sock.addEventListener('error', onDown);
  }

  private flushQueue(sock: WebSocketLike): void {
    const pending = this.queue;
    this.queue = [];
    for (let i = 0; i < pending.length; i++) {
      try {
        sock.send(JSON.stringify(pending[i]!));
      } catch {
        // Socket died mid-flush: keep this and the rest, in order, for the
        // next open.
        this.queue = pending.slice(i).concat(this.queue);
        return;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      // A reentrant connect() (or any other path) may already have opened a
      // socket; never replace a live one from the reconnect loop.
      if (this.socket !== null) return;
      this.openSocket();
    }, delay);
  }

  private setStatus(s: SignalingStatus): void {
    if (s === this.currentStatus) return;
    this.currentStatus = s;
    for (const cb of this.statusCbs) cb(s);
  }
}
