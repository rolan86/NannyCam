// NannyCam camera page — thin Preact UI over CameraSession (src/camera/
// session.ts). All logic lives in the session; this file only renders state
// and forwards the two user gestures (start/stop).

import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { toCanvas } from 'qrcode';
import { SignalingClient } from '../lib/signaling.ts';
import { CameraSession, type CameraState } from './session.ts';

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const session = new CameraSession({
  signaling: new SignalingClient({ url: wsUrl }),
  storage: localStorage,
  location: window.location,
});

function App() {
  const [state, setState] = useState<CameraState>({ phase: 'idle', viewerCount: 0 });
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
