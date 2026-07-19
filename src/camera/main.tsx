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
import { CameraSession, type CameraState, type DetectorSettings } from './session.ts';
import './camera.css';

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const session = new CameraSession({
  signaling: new SignalingClient({ url: wsUrl }),
  storage: localStorage,
  location: window.location,
});

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

function App() {
  const [state, setState] = useState<CameraState>({ phase: 'idle', viewerCount: 0 });
  const [detectors, setDetectors] = useState<DetectorSettings>(() =>
    session.getDetectorSettings(),
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const qrRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => session.onState(setState), []);

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
    case 'idle':
      return (
        <main class="center">
          <h1>NannyCam</h1>
          <button class="primary" onClick={() => void session.start()}>
            Start camera
          </button>
        </main>
      );
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
