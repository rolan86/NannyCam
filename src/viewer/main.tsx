// NannyCam viewer page — thin Preact UI over ViewerSession (src/viewer/
// session.ts). All logic lives in the session; this file only renders state
// and forwards the two user gestures (join and tap-to-unmute).

import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { SignalingClient } from '../lib/signaling.ts';
import { ViewerSession, type ViewerState } from './session.ts';
import './viewer.css';

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const session = new ViewerSession({
  signaling: new SignalingClient({ url: wsUrl }),
  location: window.location,
});

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

function App() {
  const [state, setState] = useState<ViewerState>({
    phase: 'idle',
    cameraPresent: false,
    muted: true,
  });
  // Input pre-filled from the fragment (QR links land as /viewer.html#CODE).
  const [code, setCode] = useState(() =>
    window.location.hash.replace(/^#/, '').toUpperCase(),
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => session.onState(setState), []);
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

  switch (state.phase) {
    case 'idle':
    case 'error':
      return (
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
    case 'joining':
      return <main class="center">{status}</main>;
    case 'waiting-camera':
    case 'live':
      return (
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
    case 'ended':
      return (
        <main class="center">
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
  }
}

render(<App />, document.getElementById('app')!);
