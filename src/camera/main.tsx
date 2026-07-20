// NannyCam camera page — thin Preact UI over CameraSession (src/camera/
// session.ts). All logic lives in the session; this file only renders state
// and forwards the two user gestures (start/stop).

import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { toCanvas } from 'qrcode';
import { SignalingClient } from '../lib/signaling.ts';
import {
  MOTION_THRESHOLD_RANGE,
  NOISE_THRESHOLD_RANGE,
  sensitivityToThreshold,
  thresholdToSensitivity,
} from './detectors.ts';
import { loadDedicated, Preflight } from './preflight.tsx';
import {
  CameraSession,
  type CameraState,
  type DetectorSettings,
  type RemoteAudioEntry,
} from './session.ts';
import './camera.css';

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const session = new CameraSession({
  signaling: new SignalingClient({ url: wsUrl }),
  storage: localStorage,
  location: window.location,
});

// Test hook (Task 12 e2e), mirroring the viewer hook (src/viewer/main.tsx,
// same comment style): exposes the full session so Playwright can assert
// talk-back wiring (onRemoteAudio / a viewer's inbound mic track) from the
// camera side without reimplementing WebRTC track inspection in the page.
// Same broad-surface trust-model caveat as the viewer hook — Task 14
// narrows both before the app reaches any less-trusted context.
(window as unknown as { __nannycam: CameraSession }).__nannycam = session;

/**
 * Collapsible "Alerts" panel (Task 11): two enable toggles + two sensitivity
 * sliders, persisted via the session (localStorage — see session.ts's
 * loadDetectorSettings). Sensitivity mapping (documented once here, shared
 * by both sliders): 0-100, where 100 = MOST sensitive (fires most easily,
 * mapped to the LOW end of the threshold range) and 0 = LEAST sensitive
 * (mapped to the HIGH end) — see detectors.ts's sensitivityToThreshold.
 */
function AlertsPanel({
  detectors,
  onChange,
}: {
  detectors: DetectorSettings;
  onChange: (next: DetectorSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const noiseSensitivity = Math.round(
    thresholdToSensitivity(detectors.noiseThreshold, NOISE_THRESHOLD_RANGE),
  );
  const motionSensitivity = Math.round(
    thresholdToSensitivity(detectors.motionThreshold, MOTION_THRESHOLD_RANGE),
  );

  return (
    <div class="alerts-panel" data-testid="alerts-panel">
      <button
        type="button"
        class="alerts-toggle"
        data-testid="alerts-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Alerts {open ? '▾' : '▸'}
      </button>
      {open && (
        <div class="alerts-body">
          <label class="alerts-row">
            <input
              type="checkbox"
              data-testid="noise-enabled"
              checked={detectors.noiseEnabled}
              onChange={(e) => {
                const enabled = e.currentTarget.checked;
                session.setNoiseEnabled(enabled);
                onChange({ ...detectors, noiseEnabled: enabled });
              }}
            />
            Noise alerts
          </label>
          <label class="alerts-row slider-row">
            Sensitivity
            <input
              type="range"
              min={0}
              max={100}
              data-testid="noise-sensitivity"
              value={noiseSensitivity}
              disabled={!detectors.noiseEnabled}
              onInput={(e) => {
                const threshold = sensitivityToThreshold(
                  Number(e.currentTarget.value),
                  NOISE_THRESHOLD_RANGE,
                );
                session.setNoiseThreshold(threshold);
                onChange({ ...detectors, noiseThreshold: threshold });
              }}
            />
          </label>
          <label class="alerts-row">
            <input
              type="checkbox"
              data-testid="motion-enabled"
              checked={detectors.motionEnabled}
              onChange={(e) => {
                const enabled = e.currentTarget.checked;
                session.setMotionEnabled(enabled);
                onChange({ ...detectors, motionEnabled: enabled });
              }}
            />
            Motion alerts
          </label>
          <label class="alerts-row slider-row">
            Sensitivity
            <input
              type="range"
              min={0}
              max={100}
              data-testid="motion-sensitivity"
              value={motionSensitivity}
              disabled={!detectors.motionEnabled}
              onInput={(e) => {
                const threshold = sensitivityToThreshold(
                  Number(e.currentTarget.value),
                  MOTION_THRESHOLD_RANGE,
                );
                session.setMotionThreshold(threshold);
                onChange({ ...detectors, motionThreshold: threshold });
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * Task 12 (talk-back) hidden audio sinks: one per current onRemoteAudio
 * entry, keyed by peerId so Preact reconciles by identity rather than
 * position. No `controls` attribute and CSS `display: none` (see
 * camera.css) — these exist purely to play PTT audio, never to be seen.
 */
function RemoteAudioSinks({ entries }: { entries: RemoteAudioEntry[] }) {
  return (
    <>
      {entries.map((e) => (
        <audio
          key={e.peerId}
          class="remote-audio"
          autoPlay
          data-testid="remote-audio"
          data-peer-id={e.peerId}
          ref={(el) => {
            if (el !== null && el.srcObject !== e.stream) el.srcObject = e.stream;
          }}
        />
      ))}
    </>
  );
}

function App() {
  const [state, setState] = useState<CameraState>({ phase: 'idle', viewerCount: 0 });
  const [detectors, setDetectors] = useState<DetectorSettings>(() =>
    session.getDetectorSettings(),
  );
  const [remoteAudio, setRemoteAudio] = useState<RemoteAudioEntry[]>([]);
  // Task 13: whether the pre-flight checklist is currently showing, entered
  // via the idle screen's "Set up camera" button (below) and left either by
  // "Go live" (→ session.start()) or "Back". Purely a main.tsx UI concern —
  // CameraSession's own phase machine knows nothing about this screen.
  const [preflightOpen, setPreflightOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const qrRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => session.onState(setState), []);
  useEffect(() => session.onRemoteAudio(setRemoteAudio), []);

  // Attach the local preview stream whenever the phase changes (the stream
  // exists from 'connecting' onward and is dropped on stop).
  useEffect(() => {
    const video = videoRef.current;
    if (video !== null && video.srcObject !== session.localStream) {
      video.srcObject = session.localStream;
    }
  }, [state.phase]);

  // Motion source lifecycle (Task 11): the preview <video> only exists while
  // 'live', so wire attach/detach to that same lifecycle. Enable/disable
  // itself is handled inside session.setMotionEnabled (see syncMotionSource);
  // this effect only owns the "is there a preview element right now" half.
  useEffect(() => {
    session.attachMotionSource(state.phase === 'live' ? videoRef.current : null);
  }, [state.phase]);

  useEffect(() => {
    const canvas = qrRef.current;
    if (canvas !== null && state.viewerUrl !== undefined) {
      toCanvas(canvas, state.viewerUrl, { width: 220, margin: 1 }).catch((err) =>
        console.warn('[camera] QR render failed', err),
      );
    }
  }, [state.viewerUrl]);

  const onStop = () => {
    if (confirm('Stop the camera? Viewers will be disconnected.')) session.stop();
  };

  switch (state.phase) {
    case 'idle': {
      // Task 13 flow: dedicated devices (persisted nannycam.dedicated —
      // see preflight.tsx's loadDedicated) keep the pre-Task-13 direct-Start
      // path unchanged, including the button label. Everyone else goes
      // through the checklist first; "Go live" there is what actually calls
      // session.start(). Read fresh on every 'idle' render (cheap
      // synchronous localStorage read) rather than cached in state, so
      // toggling "dedicated device" mid-checklist and backing out
      // immediately reflects on the idle screen without a reload.
      const dedicated = loadDedicated(localStorage);
      // Checked BEFORE the dedicated branch below: a dedicated device must
      // still be able to reach the checklist (opening move (a), Task 13
      // review fold-in) — Preflight itself already renders the dedicated
      // checkbox pre-checked (loadDedicated on mount) plus a "Back" button,
      // so this is the one-way door's escape hatch, not a new screen.
      if (preflightOpen) {
        return (
          <Preflight
            storage={localStorage}
            onGoLive={() => {
              setPreflightOpen(false);
              void session.start();
            }}
            onCancel={() => setPreflightOpen(false)}
          />
        );
      }
      if (dedicated) {
        return (
          <main class="center">
            <h1>NannyCam</h1>
            <button class="primary" onClick={() => void session.start()}>
              Start camera
            </button>
            <button
              type="button"
              class="setup-link"
              data-testid="dedicated-setup-link"
              onClick={() => setPreflightOpen(true)}
            >
              Set up…
            </button>
          </main>
        );
      }
      return (
        <main class="center">
          <h1>NannyCam</h1>
          <button class="primary" onClick={() => setPreflightOpen(true)}>
            Set up camera
          </button>
        </main>
      );
    }
    case 'acquiring-media':
      return (
        <main class="center">
          <p class="status">Requesting camera & microphone…</p>
        </main>
      );
    case 'connecting':
      return (
        <main class="center">
          <p class="status">Connecting…</p>
        </main>
      );
    case 'live':
      return (
        <main class="live" data-state="live">
          <video ref={videoRef} class="preview" autoPlay muted playsInline />
          <div class="code" data-testid="room-code">
            {state.roomCode}
          </div>
          <canvas ref={qrRef} class="qr" />
          <p class="status" data-testid="viewer-count">
            {state.viewerCount} viewer{state.viewerCount === 1 ? '' : 's'} connected
          </p>
          <AlertsPanel detectors={detectors} onChange={setDetectors} />
          <button class="danger" onClick={onStop}>
            Stop camera
          </button>
          <RemoteAudioSinks entries={remoteAudio} />
        </main>
      );
    case 'stopped':
      return (
        <main class="center">
          <p class="status">Camera stopped.</p>
          <button class="primary" onClick={() => void session.start()}>
            Start again
          </button>
        </main>
      );
    case 'error':
      return (
        <main class="center">
          <p class="error">{state.error}</p>
          <button class="primary" onClick={() => void session.start()}>
            Retry
          </button>
        </main>
      );
  }
}

render(<App />, document.getElementById('app')!);
