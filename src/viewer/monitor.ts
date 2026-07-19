// NannyCam viewer watchdog driver — bridges ViewerSession's data/stats/
// connection streams into the pure Watchdog (watchdog.ts) and republishes its
// verdict as UI-consumable state.
//
// Design choice (Task 10 says "your call, keep session.ts's single-
// responsibility intact"): this lives in its own file rather than inside
// session.ts. session.ts is documented as protocol/peer/join-flow state with
// zero DOM/timer concerns; this file owns the ONE thing session.ts
// deliberately doesn't (see its getStats/onDataMessage/onConnectionState doc
// comments, which say Task 10 "polls"/"consumes" them) — a real setInterval
// sampling loop plus JSON heartbeat parsing. Keeping it separate means
// session.test.ts stays about protocol/reconnection semantics, and this
// file's own tests (if any are added later) would be about sampling/timer
// wiring, not re-litigating join/reconnect logic.
//
// Lifecycle: monitoring starts the first time the session's phase reaches
// 'live' (a Watchdog is constructed at that moment — construction IS "start
// of monitoring" per watchdog.ts's baseline doc). It keeps running through
// 'waiting-camera' and 'joining' (a mid-session signaling reconnect must NOT
// silently cancel the alarm — see main.tsx's DOWN-overlay-is-global comment)
// and is torn down (timer stopped, Watchdog discarded) on 'ended' (calm,
// deliberate stop — must not alarm), 'idle', or 'error' (dead end requiring
// reload). A subsequent join() cycle starts a brand-new Watchdog at the next
// first-live, exactly like the very first join.

import type { ViewerPhase, ViewerSession } from './session.ts';
import { Watchdog, type WatchdogReason, type WatchdogState } from './watchdog.ts';

export interface MonitorState {
  /** True once monitoring has started (phase has reached 'live' at least once this session). */
  active: boolean;
  /** Current watchdog verdict; meaningless (ignore) while !active. */
  down: boolean;
  /** ms epoch of the last tick() that resolved 'live', or null before the first one. */
  lastLiveAt: number | null;
  /**
   * Increments on every live->down transition (including the very first).
   * NOT currently read by the UI: main.tsx's "Silence persists only until
   * the next DOWN transition" requirement falls out for free from
   * DownOverlay only ever being mounted while down is true — it fully
   * unmounts and remounts (fresh useState) between any two down episodes,
   * since a live period necessarily separates them. Kept as a diagnostic
   * counter (episode boundaries are useful for tests/telemetry) even though
   * nothing currently consumes it.
   */
  downEpisode: number;
}

export interface ViewerMonitorOptions {
  session: ViewerSession;
  /** Clock seam; defaults to Date.now. */
  now?: () => number;
  /** Real interval seam (sampling + tick cadence); defaults to setInterval/clearInterval. */
  setIntervalFn?: (fn: () => void, ms: number) => number;
  clearIntervalFn?: (id: number) => void;
  /** Sampling/tick cadence in ms; default 1000 (per spec: "every 1000ms"). */
  sampleIntervalMs?: number;
  /** Passed through to each Watchdog constructed. */
  heartbeatIntervalMs?: number;
  missedBeats?: number;
  frameStallMs?: number;
}

const INITIAL_STATE: MonitorState = {
  active: false,
  down: false,
  lastLiveAt: null,
  downEpisode: 0,
};

export class ViewerMonitor {
  private readonly session: ViewerSession;
  private readonly now: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => number;
  private readonly clearIntervalFn: (id: number) => void;
  private readonly sampleIntervalMs: number;
  private readonly watchdogOpts: {
    heartbeatIntervalMs?: number;
    missedBeats?: number;
    frameStallMs?: number;
  };

  private watchdog: Watchdog | null = null;
  private watchdogUnsub: (() => void) | null = null;
  private timer: number | null = null;
  private state: MonitorState = INITIAL_STATE;
  private stateCbs: Array<(s: MonitorState) => void> = [];

  constructor(opts: ViewerMonitorOptions) {
    this.session = opts.session;
    this.now = opts.now ?? Date.now;
    this.setIntervalFn =
      opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms) as unknown as number);
    this.clearIntervalFn =
      opts.clearIntervalFn ??
      ((id) => clearInterval(id as unknown as ReturnType<typeof setInterval>));
    this.sampleIntervalMs = opts.sampleIntervalMs ?? 1000;
    this.watchdogOpts = {
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      missedBeats: opts.missedBeats,
      frameStallMs: opts.frameStallMs,
    };

    this.session.onState((s) => this.handlePhase(s.phase));
    // Session-level streams (survive peer replacement); safe to wire before
    // a Watchdog exists — each handler no-ops via optional chaining until
    // handlePhase() constructs one at first-live.
    this.session.onPeerAdopted(() => this.watchdog?.reset());
    this.session.onConnectionState((s) => this.watchdog?.onConnectionState(s));
    this.session.onDataMessage((text) => this.handleData(text));
  }

  /** Subscribe to monitor state. Fires immediately, then on every change. */
  onState(cb: (s: MonitorState) => void): () => void {
    this.stateCbs.push(cb);
    cb(this.state);
    return () => {
      this.stateCbs = this.stateCbs.filter((f) => f !== cb);
    };
  }

  // -- wiring -------------------------------------------------------------

  private handlePhase(phase: ViewerPhase): void {
    if (phase === 'live' && this.watchdog === null) {
      this.startMonitoring();
      return;
    }
    if (phase === 'ended' || phase === 'idle' || phase === 'error') {
      this.stopMonitoring();
    }
    // 'joining' / 'waiting-camera' while already monitoring: no-op here —
    // the timer keeps sampling and ticking; missed heartbeats/connection
    // loss will trip DOWN naturally within the grace window regardless of
    // which of these two phases the session is currently showing. This is
    // the "one code path, no instant-DOWN special-case" the task calls for.
  }

  private handleData(text: string): void {
    if (this.watchdog === null) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // non-JSON: not a heartbeat (Task 11 alerts arrive here too)
    }
    if (
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { t?: unknown }).t === 'hb'
    ) {
      this.watchdog.onHeartbeat();
    }
    // Any other shape (future alert JSON): ignored here — Task 11's concern.
  }

  private startMonitoring(): void {
    const wd = new Watchdog({ now: this.now, ...this.watchdogOpts });
    this.watchdog = wd;
    this.watchdogUnsub = wd.onStateChange((s, reason) => this.publishVerdict(s, reason));
    this.setState({ active: true, down: false, lastLiveAt: this.now(), downEpisode: 0 });
    this.timer = this.setIntervalFn(() => this.sample(), this.sampleIntervalMs);
  }

  private stopMonitoring(): void {
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    this.watchdogUnsub?.();
    this.watchdogUnsub = null;
    this.watchdog = null;
    this.setState(INITIAL_STATE);
  }

  private sample(): void {
    const wd = this.watchdog;
    if (wd === null) return;
    // Read the generation NOW, at dispatch time — not when the promise
    // resolves. That's what lets a sample that resolves after an
    // intervening reset() (peer replaced mid-flight) be recognized by
    // Watchdog.onFrameCount as stale and discarded, rather than being read
    // against the NEW generation's fresh (much smaller) counter.
    const generation = wd.currentGeneration;
    void this.session
      .getStats()
      // Safety-critical: a rejected getStats() (e.g. the peer closed mid-
      // call) must not freeze the sampler at a stale verdict. Treat it as
      // "no sample this round" and fall through to the unconditional tick()
      // below, same as a resolved-but-empty (null) result.
      .catch(() => null)
      .then((stats) => {
        // Re-check: stopMonitoring() may have run while getStats() was in flight.
        if (this.watchdog !== wd) return;
        if (stats !== null) {
          // Sum across ALL inbound-rtp video reports rather than trusting
          // the first one encountered — RTCStatsReport iteration order is
          // not guaranteed stable across samples, so "take the first" can
          // flap between reports (e.g. simulcast/multiple m-lines) and look
          // like the count oscillating even on a healthy stream.
          let total = 0;
          let sawVideoReport = false;
          for (const report of stats.values()) {
            if (report.type === 'inbound-rtp' && (report as { kind?: string }).kind === 'video') {
              sawVideoReport = true;
              total += (report as { framesDecoded?: number }).framesDecoded ?? 0;
            }
          }
          if (sawVideoReport) wd.onFrameCount(total, generation);
        }
        const verdict = wd.tick();
        if (verdict === 'live') this.setState({ lastLiveAt: this.now() });
      });
  }

  private publishVerdict(s: WatchdogState, reason: WatchdogReason): void {
    if (s === 'down') {
      this.setState({ down: true, downEpisode: this.state.downEpisode + 1 });
    } else {
      this.setState({ down: false, lastLiveAt: this.now() });
    }
    void reason; // logged nowhere yet; kept in the signature for future use (Task 11 telemetry?)
  }

  private setState(patch: Partial<MonitorState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of [...this.stateCbs]) cb(this.state);
  }
}
