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

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const session = new ViewerSession({
  signaling: new SignalingClient({ url: wsUrl }),
  location: window.location,
});
const monitor = new ViewerMonitor({ session });

// Test hook (Task 9 e2e, still used by Task 10's monitor.spec.ts): exposes
// the full session so Playwright can drive getStats() (framesDecoded)
// without reimplementing WebRTC stats polling in the page. This is the FULL
// session for now — a broad, read-mostly surface acceptable for the current
// trust model where only local Playwright tests reach it; Task 14 (security
// hardening) narrows this to a purpose-built stats facade before the app is
// exposed to any less-trusted context.
(window as unknown as { __nannycam: ViewerSession }).__nannycam = session;

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => session.onState(setState), []);
  useEffect(() => monitor.onState(setMonitorState), []);
  useEffect(
    () =>
      session.onRemoteStream((stream) => {
        streamRef.current = stream;
        if (videoRef.current !== null) videoRef.current.srcObject = stream;
      }),
    [],
  );
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
      {screen}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
