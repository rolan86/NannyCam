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
// Baseline choice (documented per the task spec): the missed-heartbeat grace
// window (missedBeats * heartbeatIntervalMs, default 3 * 2000 = 6000ms) is
// measured from EITHER the last real heartbeat OR, if none has arrived yet,
// from construction time (`startedAt`). This means a viewer that never
// receives a single heartbeat still alarms once the grace window elapses —
// it does not wait forever for a heartbeat that will never come.
//
// reset() semantics (revised after an adversarial fuzz review found a
// false-LIVE hole in the original design — see git history for the CVE-style
// writeup): reset() is called on every peer adoption/replacement
// (src/viewer/session.ts's onPeerAdopted, wired in monitor.ts). It ONLY
// bumps `generation` (see onFrameCount below) and clears the frame
// high-water mark. It deliberately does NOT touch lastHeartbeatAt or
// startedAt (the heartbeat-grace baseline), and does NOT touch connState.
// Earlier versions forced a fresh `now()` baseline on every reset() ("bounded
// optimism ~6s"), which turned out to be exploitable two ways:
//   1. False-LIVE via down-state reset: resetting the heartbeat baseline
//      while ALREADY down (e.g. a crash-looping camera keeps getting
//      re-adopted before it ever sends a heartbeat) silenced an active alarm
//      on every adoption, even though no real evidence of life ever arrived.
//   2. Unbounded grace via chained resets: even gating the reset to
//      "only while live" doesn't close this — a resetter firing faster than
//      the grace window (e.g. every 5s against a 6s window) always lands
//      while still live (the previous fresh window hasn't expired yet), so
//      each reset re-arms a brand new window forever and the verdict never
//      reaches DOWN at all.
// Leaving the heartbeat/connection baseline untouched fixes both: the total
// "benefit of the doubt" is bounded to the ORIGINAL missedBeats *
// heartbeatIntervalMs window from true start (or the last REAL heartbeat),
// no matter how many peer replacements occur in between, and an existing
// DOWN verdict can only be cleared by genuine new evidence — a fresh
// onHeartbeat() call and/or the new peer's own onConnectionState updates
// (peer.ts fires onconnectionstatechange as soon as the new
// RTCPeerConnection starts negotiating, typically well before its first
// heartbeat, so a stale 'failed'/'disconnected' from the replaced peer
// self-corrects quickly without reset() needing to clear it). Clearing
// frameBaseline IS still safe and necessary on every reset regardless of
// live/down state: an empty baseline can never by itself force a 'live'
// verdict (see tick()'s three-condition OR below) — it just makes the
// frame-stall check inert until the new peer's own first tagged sample
// arrives, which onFrameCount's generation check is what actually protects.

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
  /** High-water mark: the largest count observed so far THIS generation. */
  n: number;
  /** When the high-water mark was last raised (i.e. genuine new frames). */
  at: number;
}

export class Watchdog {
  private readonly clock: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly missedBeats: number;
  private readonly frameStallMs: number;

  private readonly startedAt: number;
  private lastHeartbeatAt: number | null = null;
  private frameBaseline: FrameBaseline | null = null;
  private connState: RTCPeerConnectionState | null = null;
  /**
   * Bumped by reset() on every peer adoption/replacement. onFrameCount
   * samples are tagged with the generation in effect when the sample was
   * DISPATCHED (see monitor.ts's sample()); a sample that resolves after a
   * later reset() carries a stale generation number and is discarded — this
   * closes both a false-DOWN (a slow in-flight sample from the OLD peer
   * arriving just after a healthy replacement, wrongly extending a stall
   * clock that should have restarted) and a false-LIVE (a stale sample's
   * count — which can be arbitrarily larger OR smaller than the new
   * generation's real counts — must never be read as "frames advancing").
   */
  private generation = 0;

  private state: WatchdogState = 'live';
  private cbs: Array<(s: WatchdogState, reason: WatchdogReason) => void> = [];

  constructor(opts: WatchdogOptions) {
    this.clock = opts.now;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 2000;
    this.missedBeats = opts.missedBeats ?? 3;
    this.frameStallMs = opts.frameStallMs ?? 5000;
    this.startedAt = this.clock();
  }

  /** The generation in effect right now — tag async samples with this at dispatch time. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** Record an inbound {t:'hb'} data-channel message. */
  onHeartbeat(): void {
    this.lastHeartbeatAt = this.clock();
  }

  /**
   * Feed a monotonically-sampled framesDecoded reading (summed across all
   * inbound-rtp video reports — see monitor.ts). `generation` should be
   * whatever `currentGeneration` read at the moment the underlying
   * getStats() call was DISPATCHED, not when it resolves — that's what lets
   * a sample that resolves after an intervening reset() be recognized as
   * stale and discarded (see the generation field's doc above). Defaults to
   * the CURRENT generation, which is always "fresh" — convenient for tests
   * and any caller that doesn't care about generation tagging.
   *
   * Within one generation, only a count STRICTLY GREATER than the existing
   * high-water mark counts as "frames advancing" and moves the stall clock
   * forward. framesDecoded is monotonically non-decreasing per SSRC for the
   * lifetime of one RTCPeerConnection, so within a single generation a
   * decrease (or an oscillating/flapping read caused by e.g. unstable
   * RTCStats report iteration order) is never genuine evidence of new
   * frames and must never reset the stall clock — only an actual new high
   * counts.
   */
  onFrameCount(n: number, generation: number = this.generation): void {
    if (generation !== this.generation) return; // stale sample: discard
    const at = this.clock();
    if (this.frameBaseline === null || n > this.frameBaseline.n) {
      this.frameBaseline = { n, at };
    }
    // n <= high-water mark: not an advance. Leave frameBaseline untouched —
    // the stall clock keeps counting from the last genuine high.
  }

  /** Record the current camera Peer's RTCPeerConnectionState. */
  onConnectionState(s: RTCPeerConnectionState): void {
    this.connState = s;
  }

  /**
   * Call on every peer adoption/replacement. Bumps the generation (so stale
   * in-flight frame samples from the replaced peer get discarded) and clears
   * the frame high-water mark (the new peer's own RTCStats counter starts
   * its own series). Deliberately does NOT touch the heartbeat baseline or
   * connState — see the file-header design note for why extending those on
   * reset() is exactly what created the fuzzer-found false-LIVE holes. If
   * the watchdog is currently DOWN, it stays DOWN: only a genuine fresh
   * onHeartbeat() (combined with frames advancing/no baseline yet and a
   * non-failed connection — the normal recovery rule tick() already
   * evaluates) can clear an active alarm.
   */
  reset(): void {
    this.generation++;
    this.frameBaseline = null;
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
    // none yet) from construction — see the file-header baseline note. This
    // baseline is NEVER shifted forward by reset(), so the total grace is
    // bounded regardless of how many peer replacements occur.
    if (reason === null) {
      const baseline = this.lastHeartbeatAt ?? this.startedAt;
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
