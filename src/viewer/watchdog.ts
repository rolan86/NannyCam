// NannyCam stream-health watchdog — pure, timer-free verdict engine for the
// viewer's DOWN state (Task 10, safety-critical: "a monitor that fails
// silently is worse than no monitor" — see
// docs/superpowers/specs/2026-07-19-nannycam-design.md, Failure Handling).
//
// No timers of its own: the caller (src/viewer/monitor.ts) feeds inputs as
// they happen and invokes tick() on its own ~1s cadence, which keeps this
// class trivially unit-testable with an injected clock — no fake timers, no
// real waits, no flakiness.
//
// Baseline choice (documented per the task spec): a Watchdog considers
// "monitoring started" at construction (or reset()) time. The
// missed-heartbeat grace window (missedBeats * heartbeatIntervalMs, default
// 3 * 2000 = 6000ms) is measured from EITHER the last real heartbeat OR, if
// none has arrived yet, from that start-of-monitoring instant. This means a
// viewer that never receives a single heartbeat still alarms once the grace
// window elapses — it does not wait forever for a heartbeat that will never
// come. The same grace period re-applies after reset() (e.g. a new/
// replacement peer was just adopted): rather than staying latched on stale
// data from the peer that was just replaced, monitoring restarts as if fresh
// — bounded optimism for up to one grace window, matching the same
// documented trade-off accepted at true start-of-monitoring.

export type WatchdogState = 'live' | 'down';

/** Reason attached to a state-change callback firing. */
export type WatchdogReason = 'heartbeats' | 'frames' | 'connection' | 'recovered';

export interface WatchdogOptions {
  /** Injected clock (ms), e.g. () => Date.now(). Never called by a timer here. */
  now: () => number;
  /** Camera heartbeat cadence; default matches src/camera/session.ts's 2000ms. */
  heartbeatIntervalMs?: number;
  /** Consecutive missed beats before alarming; default 3 (6s grace @ 2000ms). */
  missedBeats?: number;
  /** Max ms a sampled frame count may sit unchanged before alarming; default 5000. */
  frameStallMs?: number;
}

interface FrameBaseline {
  n: number;
  at: number;
}

export class Watchdog {
  private readonly clock: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly missedBeats: number;
  private readonly frameStallMs: number;

  private monitoringSince: number;
  private lastHeartbeatAt: number | null = null;
  private frameBaseline: FrameBaseline | null = null;
  private connState: RTCPeerConnectionState | null = null;

  private state: WatchdogState = 'live';
  private cbs: Array<(s: WatchdogState, reason: WatchdogReason) => void> = [];

  constructor(opts: WatchdogOptions) {
    this.clock = opts.now;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 2000;
    this.missedBeats = opts.missedBeats ?? 3;
    this.frameStallMs = opts.frameStallMs ?? 5000;
    this.monitoringSince = this.clock();
  }

  /** Record an inbound {t:'hb'} data-channel message. */
  onHeartbeat(): void {
    this.lastHeartbeatAt = this.clock();
  }

  /**
   * Feed a monotonically-sampled framesDecoded reading (from getStats()'s
   * inbound-rtp video report). Any change from the current baseline — up
   * (frames flowing normally) or DOWN (a fresh RTCStats counter after a peer
   * replacement resets the underlying connection's own counters) — counts as
   * "advancing" and resets the stall clock. Only an exact repeat accumulates
   * toward frameStallMs.
   */
  onFrameCount(n: number): void {
    const at = this.clock();
    if (this.frameBaseline === null || n !== this.frameBaseline.n) {
      this.frameBaseline = { n, at };
    }
  }

  /** Record the current camera Peer's RTCPeerConnectionState. */
  onConnectionState(s: RTCPeerConnectionState): void {
    this.connState = s;
  }

  /**
   * Grants a fresh grace period — call when a new/replacement peer is
   * adopted, so monitoring restarts as though freshly begun rather than
   * staying latched on the just-replaced peer's stale heartbeat/frame/
   * connection history.
   */
  reset(): void {
    this.monitoringSince = this.clock();
    this.lastHeartbeatAt = null;
    this.frameBaseline = null;
    this.connState = null;
  }

  /**
   * Caller invokes on its own ~1s cadence; computes and returns the current
   * verdict, firing onStateChange subscribers exactly when the verdict
   * actually flips.
   */
  tick(): WatchdogState {
    const t = this.clock();
    let reason: WatchdogReason | null = null;

    // (c) connection state: immediate DOWN, checked first since it overrides
    // otherwise-healthy heartbeat/frame signals.
    if (this.connState === 'failed' || this.connState === 'disconnected') {
      reason = 'connection';
    }

    // (a) missed heartbeats, measured from the last real heartbeat or (if
    // none yet) from start-of-monitoring — see the file-header baseline note.
    if (reason === null) {
      const baseline = this.lastHeartbeatAt ?? this.monitoringSince;
      if (t - baseline > this.missedBeats * this.heartbeatIntervalMs) {
        reason = 'heartbeats';
      }
    }

    // (b) frozen-frame-looks-live: framesDecoded unchanged too long. Inert
    // until a first onFrameCount call establishes a baseline — a stream that
    // never produces a frame is caught by (a) instead.
    if (reason === null && this.frameBaseline !== null) {
      if (t - this.frameBaseline.at > this.frameStallMs) {
        reason = 'frames';
      }
    }

    const next: WatchdogState = reason !== null ? 'down' : 'live';
    if (next !== this.state) {
      this.state = next;
      const firedReason = reason ?? 'recovered';
      for (const cb of [...this.cbs]) cb(next, firedReason);
    }
    return this.state;
  }

  /** Fires on transitions only. Returns an unsubscribe closure. */
  onStateChange(cb: (s: WatchdogState, reason: WatchdogReason) => void): () => void {
    this.cbs.push(cb);
    return () => {
      this.cbs = this.cbs.filter((f) => f !== cb);
    };
  }
}
