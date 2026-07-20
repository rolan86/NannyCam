// NannyCam viewer page — thin Preact UI over ViewerSession (src/viewer/
// session.ts) and ViewerMonitor (src/viewer/monitor.ts). All logic lives in
// those two classes; this file only renders state and forwards user gestures
// (join, tap-to-unmute, silence).

import { render, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { SignalingClient } from '../lib/signaling.ts';
import { ViewerMonitor, type MonitorState } from './monitor.ts';
import { ViewerSession, type ViewerState } from './session.ts';
import './viewer.css';

/** A received {t:'alert'} event, as forwarded by ViewerMonitor.onAlert (Task 11). */
interface AlertEvent {
  kind: 'noise' | 'motion';
  at: number;
}

/** How long the alert banner stays up before auto-dismissing. */
const ALERT_BANNER_MS = 8000;

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const session = new ViewerSession({
  signaling: new SignalingClient({ url: wsUrl }),
  location: window.location,
});
const monitor = new ViewerMonitor({ session });

/**
 * Test hook (Task 9 e2e, still used by Task 10's monitor.spec.ts). Task 14:
 * narrowed from exposing the FULL session (broad, read-mostly, but still a
 * live window into private internals) to exactly the two read-only queries
 * e2e/monitor.spec.ts drives — getStats() for framesDecoded polling, and
 * micTrackState() for the PTT press/release assertions (previously reached
 * via a `.micTrack` private-field cast directly in the test file — see this
 * file's git history / the Task 12 e2e report). No method here can mutate
 * session state.
 */
interface NannycamViewerHook {
  getStats(): Promise<RTCStatsReport | null>;
  micTrackState(): { enabled: boolean; readyState: MediaStreamTrackState } | null;
}
(window as unknown as { __nannycam: NannycamViewerHook }).__nannycam = {
  getStats: () => session.getStats(),
  micTrackState: () => session.micTrackState(),
};

/** Human-readable status line: phase + camera presence (Task 9 asserts it). */
function statusText(state: ViewerState): string {
  const camera = state.cameraPresent ? 'camera present' : 'camera offline';
  switch (state.phase) {
    case 'idle':
      return 'idle';
    case 'joining':
      return `joining ${state.roomCode ?? ''}…`;
    case 'waiting-camera':
      return `waiting-camera · ${camera}`;
    case 'live':
      return `live · ${camera}`;
    case 'ended':
      return 'ended';
    case 'error':
      return 'error';
  }
}

/** data-state root attribute — the E2E hook for down/live/ended (Task 10). */
function rootDataState(phase: ViewerState['phase'], monitorState: MonitorState): string | undefined {
  if (phase === 'ended') return 'ended';
  if (!monitorState.active) return undefined; // monitoring hasn't started yet (never reached live)
  return monitorState.down ? 'down' : 'live';
}

function lastLiveText(lastLiveAt: number | null): string {
  if (lastLiveAt === null) return 'No live signal received yet';
  const seconds = Math.max(0, Math.round((Date.now() - lastLiveAt) / 1000));
  return `Last live: ${new Date(lastLiveAt).toLocaleTimeString()} (${seconds}s ago)`;
}

function alertText(alert: AlertEvent): string {
  const label = alert.kind === 'noise' ? 'Noise' : 'Motion';
  return `${label} detected ${new Date(alert.at).toLocaleTimeString()}`;
}

/**
 * Soft two-tone chime for noise/motion alerts — deliberately distinct from
 * the DOWN alarm's loud repeating square-wave siren (see DownOverlay below):
 * two short sine tones, quieter gain, plays ONCE per alert rather than
 * looping. Caller is responsible for the "DOWN outranks alerts" gate (an
 * alert arriving while the DOWN overlay is up stays silent) and the
 * audio-unlock gate (session.audioContext is null until unmute()).
 */
function playAlertChime(ctx: AudioContext): void {
  const t0 = ctx.currentTime;
  const tone = (freq: number, start: number, duration: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + start);
    gain.gain.exponentialRampToValueAtTime(0.15, t0 + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + start);
    osc.stop(t0 + start + duration + 0.05);
  };
  tone(660, 0, 0.12);
  tone(880, 0.14, 0.16);
}

/** Auto-dismissing notice for a noise/motion alert; hidden while DOWN is up (DOWN outranks alerts). */
function AlertBanner({ alert }: { alert: AlertEvent }) {
  return (
    <div class="alert-banner" data-testid="alert-banner">
      {alertText(alert)}
    </div>
  );
}

/**
 * Full-screen red DOWN overlay + repeating alarm. Alarm plays through the
 * session's shared AudioContext IF the tap-to-unmute gesture has already
 * unlocked it (state.muted === false implies session.audioContext !== null
 * — unmute() always creates/resumes the context before flipping muted).
 * Muted-and-never-tapped viewers get visual-only DOWN — the tap-to-unmute
 * overlay is already nagging them for sound, so this is not a silent
 * failure, just a degraded (documented) one.
 */
function DownOverlay({
  monitorState,
  audioUnlocked,
}: {
  monitorState: MonitorState;
  audioUnlocked: boolean;
}) {
  // "Silence persists until the next DOWN transition" (spec requirement) is
  // satisfied for free: this component is only ever mounted while down is
  // true, and monitor.ts only increments downEpisode on a live->down
  // transition — which necessarily unmounts (live in between) and remounts
  // this component, giving silenced a fresh `false` via useState's initial
  // value. No explicit reset-on-downEpisode-change effect needed.
  const [silenced, setSilenced] = useState(false);
  const [, forceTick] = useState(0);

  // Re-render every second so the "Ns ago" countdown in lastLiveText stays live.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (silenced || !audioUnlocked) return undefined;
    const ctx = session.audioContext as unknown as AudioContext | null;
    if (ctx === null) return undefined;
    let stopped = false;
    const beep = () => {
      if (stopped) return;
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 880;
        const t0 = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.3);
      } catch {
        // Non-fatal: the visual overlay is the primary DOWN signal.
      }
    };
    beep();
    const id = setInterval(beep, 700);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [silenced, audioUnlocked]);

  return (
    <div class="down-overlay" data-testid="down-overlay">
      <h1>STREAM DOWN</h1>
      <p class="down-lastlive" data-testid="down-lastlive">
        {lastLiveText(monitorState.lastLiveAt)}
      </p>
      {!silenced && (
        <button class="silence" data-testid="silence-btn" onClick={() => setSilenced(true)}>
          Silence
        </button>
      )}
    </div>
  );
}

function App() {
  const [state, setState] = useState<ViewerState>({
    phase: 'idle',
    cameraPresent: false,
    muted: true,
    talk: 'idle',
  });
  const [monitorState, setMonitorState] = useState<MonitorState>({
    active: false,
    down: false,
    lastLiveAt: null,
    downEpisode: 0,
  });
  // Input pre-filled from the fragment (QR links land as /viewer.html#CODE).
  const [code, setCode] = useState(() =>
    window.location.hash.replace(/^#/, '').toUpperCase(),
  );
  const [alert, setAlert] = useState<AlertEvent | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Read inside the onAlert callback below to get the CURRENT down/muted
  // state at the moment an alert arrives (the subscription itself is
  // mount-once; a plain closure over state.muted/showDown would go stale).
  const downRef = useRef(false);
  const mutedRef = useRef(true);

  useEffect(() => session.onState(setState), []);
  useEffect(() => monitor.onState(setMonitorState), []);
  // Task 12 review fold-in: the PTT button only renders while phase ===
  // 'live' (see the switch below), so a peer death or teardown that yanks
  // the phase out from under a held press unmounts the button WITHOUT ever
  // firing pointerup/pointercancel/pointerleave — session.stopTalk() never
  // gets called, leaving talk stuck at 'talking' cosmetically (the mic track
  // itself is fine; session.leave()/handleReconnected already release/
  // disable it independently). This effect's cleanup covers exactly that
  // gap: it fires whenever phase leaves 'live' (button unmounts) or the
  // whole page unmounts, same as a release would.
  useEffect(() => {
    if (state.phase !== 'live') return undefined;
    return () => session.stopTalk();
  }, [state.phase]);
  useEffect(
    () =>
      session.onRemoteStream((stream) => {
        streamRef.current = stream;
        if (videoRef.current !== null) videoRef.current.srcObject = stream;
      }),
    [],
  );
  // Alert banner + chime (Task 11). DOWN outranks alerts: an alert arriving
  // while the DOWN overlay is up is recorded (so it can still show once DOWN
  // clears, if within its window) but plays no sound. Muted (audio not yet
  // unlocked by the tap-to-unmute gesture) is visual-only, same as the DOWN
  // alarm's degraded-but-documented behavior.
  useEffect(
    () =>
      monitor.onAlert((kind, at) => {
        setAlert({ kind, at });
        if (downRef.current || mutedRef.current) return;
        const ctx = session.audioContext as unknown as AudioContext | null;
        if (ctx === null) return;
        try {
          playAlertChime(ctx);
        } catch {
          // Non-fatal: the banner is the primary alert signal.
        }
      }),
    [],
  );
  // Auto-dismiss: each new alert (even while suppressed by DOWN) gets its
  // own fresh 8s window.
  useEffect(() => {
    if (alert === null) return undefined;
    const id = setTimeout(() => setAlert(null), ALERT_BANNER_MS);
    return () => clearTimeout(id);
  }, [alert]);
  // The <video> mounts/unmounts across screens: re-attach the current stream
  // whenever the phase changes and the element's srcObject is stale.
  useEffect(() => {
    const video = videoRef.current;
    if (video !== null && video.srcObject !== streamRef.current) {
      video.srcObject = streamRef.current;
    }
  }, [state.phase]);

  const status = (
    <p class="status" data-testid="status">
      {statusText(state)}
    </p>
  );

  // DOWN territory: full-screen overlay is rendered ABOVE whichever
  // phase-driven screen below is currently showing (including 'joining' — a
  // mid-session signaling reconnect must not silently cancel the alarm; see
  // monitor.ts's handlePhase doc). It is NEVER shown once phase is 'ended'
  // (calm, intentional stop) — the monitor itself stops ticking at that
  // point (see monitor.ts), so monitorState.down cannot be stale-true there,
  // but the phase check is kept as a second, cheap belt-and-braces guard.
  const showDown = state.phase !== 'ended' && monitorState.active && monitorState.down;
  downRef.current = showDown;
  mutedRef.current = state.muted;

  let screen: VNode;
  switch (state.phase) {
    case 'idle':
    case 'error':
      screen = (
        <main class="center">
          <h1>NannyCam</h1>
          <input
            class="code-input"
            data-testid="code-input"
            value={code}
            maxLength={8}
            autocapitalize="characters"
            autocomplete="off"
            spellcheck={false}
            placeholder="ROOMCODE"
            onInput={(e) => setCode(e.currentTarget.value.toUpperCase())}
          />
          <button
            class="primary"
            data-testid="join-btn"
            onClick={() => session.join(code)}
          >
            Join
          </button>
          {state.error !== undefined && <p class="error">{state.error}</p>}
          {status}
        </main>
      );
      break;
    case 'joining':
      screen = <main class="center">{status}</main>;
      break;
    case 'waiting-camera':
    case 'live':
      screen = (
        <main class="watch">
          <video
            ref={videoRef}
            class="remote"
            data-testid="viewer-video"
            autoPlay
            playsInline
            muted={state.muted}
          />
          {state.phase === 'waiting-camera' && (
            <p class="waiting">
              {state.cameraPresent ? 'Waiting for video…' : 'Camera offline'}
            </p>
          )}
          {state.muted && (
            // THE gesture: unmutes the video AND unlocks alert audio
            // (creates/resumes the session's shared AudioContext).
            <button
              class="unmute"
              data-testid="unmute"
              onClick={() => session.unmute()}
            >
              Tap for sound
            </button>
          )}
          {state.phase === 'live' && (
            // Press-and-hold PTT (Task 12): visible only while live — a
            // pre-negotiated mic transceiver already exists by this point
            // (added synchronously at adoptPeer, before track events can
            // flip the phase to 'live'). No mute-state gating: sending mic
            // audio doesn't touch the shared AudioContext the tap-to-sound
            // gesture unlocks, so PTT works even before that first tap.
            // pointerleave is handled too (not just up/cancel) so a finger
            // sliding off the button can't leave the mic hot.
            <button
              class={`ptt-btn${state.talk === 'talking' ? ' pressed' : ''}${
                state.talk === 'mic-denied' ? ' denied' : ''
              }`}
              data-testid="ptt-btn"
              onPointerDown={() => void session.startTalk()}
              onPointerUp={() => session.stopTalk()}
              onPointerCancel={() => session.stopTalk()}
              onPointerLeave={() => session.stopTalk()}
            >
              {state.talk === 'mic-denied' ? 'Mic blocked — tap and allow access' : 'Hold to talk'}
            </button>
          )}
          {status}
        </main>
      );
      break;
    case 'ended':
      screen = (
        <main class="center" data-testid="ended-screen">
          <h1>Session ended</h1>
          <p class="calm">The camera stopped sharing.</p>
          <button
            class="primary"
            data-testid="rejoin-btn"
            onClick={() => session.join(state.roomCode)}
          >
            Join again
          </button>
          {status}
        </main>
      );
      break;
  }

  return (
    <div class="app-root" data-state={rootDataState(state.phase, monitorState)}>
      {showDown && <DownOverlay monitorState={monitorState} audioUnlocked={!state.muted} />}
      {!showDown && alert !== null && <AlertBanner alert={alert} />}
      {screen}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
