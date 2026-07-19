# NannyCam — Design Spec

**Date:** 2026-07-19
**Status:** Validated with user, pending implementation planning

## Context

A browser-based nanny cam between any two phones with cameras. No iOS/Android app to install — both ends are web pages served from a Mac on the home network. Built for personal use first, released as open source. The project's core promise is a *verifiable* privacy model: no recording, no footage or events ever touching a third party, small enough to audit.

Origin: a prior design conversation (see `conversation.txt`) established WebRTC P2P with a self-hosted signaling server as the architecture. This spec deepens that design with the operational layer (phone-call interruptions, reconnection, failure visibility), the Tailscale-based remote story, and the trust model.

## Goals

- Live video + audio from a "camera" phone to a "viewer" phone, both running only a mobile browser.
- Works on home Wi-Fi and remotely, same URL, via the user's Tailscale tailnet.
- No media or alert data ever transits or persists on any server, first- or third-party.
- Safety-critical failure visibility: the viewer must never silently show a stale stream.
- Small, dependency-light, auditable open-source codebase.

## Non-Goals (v1)

- Recording or snapshots of any kind.
- Public-internet access without Tailscale (no TURN, no Funnel, no port-forwarding docs).
- Accounts, user management, analytics, or any persistence beyond room state in server memory.
- More than a handful of simultaneous viewers (2–3 is the design point).

## Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| Stack | Vite + TypeScript + Preact (client), Bun running TS natively (server) | User chose maintainability over zero-build purity; Bun keeps server build-free, one language everywhere |
| Remote access / TLS | Tailscale app on both phones; `tailscale serve` fronts the server at `https://mac.<tailnet>.ts.net` with a Let's Encrypt cert | Dissolves the LAN-HTTPS problem (no mkcert CA installs), one URL home + remote. mkcert documented as app-free LAN-only fallback for OSS users |
| NAT traversal | **No STUN, no TURN — host candidates only** (LAN IPs + Tailscale 100.x IPs) | Makes "no third party touches the connection" structural, not promised. Tailscale's WireGuard mesh replaces TURN's role |
| Camera device | Both dedicated-spare and daily-driver phones supported | Pre-flight checklist designed in from the start, skippable via persistent "dedicated device" toggle |
| v1 features | Audio, noise-level alerts, two-way talk-back, motion detection | All computed client-side; alerts travel only over the P2P data channel |

## Architecture

Four units:

### 1. Camera page (`/camera`)

- `getUserMedia` video+audio capture; publishes via one `RTCPeerConnection` per viewer.
- Pre-flight checklist before going live (see Operational Design).
- Wake Lock API; re-acquire on `visibilitychange`.
- Detectors (all client-side):
  - Noise: Web Audio `AnalyserNode` RMS level with threshold + hysteresis.
  - Motion: throttled canvas frame-diffing (low frame rate to bound CPU/heat).
- Plays incoming talk-back audio from viewer.
- Data channel per viewer: heartbeat sent camera → viewer every 2s, plus alert events (JSON).

### 2. Viewer page (`/viewer`)

- Plays remote stream. Tap-to-unmute gesture also unlocks alert/alarm audio playback (one gesture, two jobs — browsers block autoplaying audio).
- Push-to-talk: press-and-hold captures mic and sends an audio track to the camera (pre-negotiated transceiver, unmuted while held).
- Renders noise/motion alerts with local audible alert tone.
- **Stream-health watchdog** (safety-critical, see Failure Handling).

### 3. Signaling server (single Bun TS file on the Mac)

- Serves Vite-built static assets.
- WebSocket relay for SDP offers/answers and ICE candidates. Sees metadata only, never media.
- Room model: camera creates room → server issues short code (shown as text + QR) plus a private **camera token** (random secret, held in the camera page's localStorage). One camera per room; viewers hard-capped at 3 by the server.
- **Room lifecycle:** a camera disconnect does NOT kill the room — it enters an *orphaned* grace state (10 minutes) during which viewers stay joined (and alarm). The camera re-claims its room by presenting code + camera token. Only an explicit "Stop camera" action — or grace-period expiry — destroys the room and its code.
- **Server-restart recovery:** state is in-memory, so after a restart no rooms exist. A camera page reconnecting may then *re-create* a room with its previously issued code (client-supplied on recreation only). The code's entropy (≥ 8 random chars, known only to the paired devices) is the authentication for this path; a fresh camera token is issued on re-creation.
- Join attempts rate-limited; all WS messages schema-validated (hostile tailnet guest must not crash or hijack the relay).
- State is in-memory only; server restart is a tolerated failure (see Room lifecycle above and the reconnection ladder).

### 4. Network/TLS layer (no app code)

- `tailscale serve` provides HTTPS termination and the stable name.
- On LAN, ICE host candidates over Wi-Fi win (direct phone↔phone). Remote, the 100.x candidates carry media through WireGuard. Media is DTLS-SRTP end-to-end encrypted in both cases.

### Data flow

camera page → checklist → create room → code/QR → viewer joins with code → WS relays SDP/ICE → direct P2P media + data channel. Server out of the loop after handshake.

## Operational Design (the phone-is-a-phone problem)

A web page cannot block or silence calls/notifications — no such API exists. Design response:

1. **Golden path (docs):** dedicated spare phone, no SIM or airplane mode + Wi-Fi, permanently plugged in.
2. **Daily-driver path (product):** pre-flight checklist on the camera page:
   - Wake lock acquired — detected.
   - Charger connected — detected (Battery API where available).
   - DND / Focus enabled, ringer muted — user-confirmed checkbox (undetectable from web).
   - Documented iOS nicety: install as home-screen PWA + Shortcuts automation to auto-enable a "Nanny Cam" Focus when the app opens.
   - Checklist skippable via persistent "this is a dedicated device" toggle.
3. **The app's real job is loud failure, not prevention** (see below).

## Failure Handling

**Watchdog (viewer):** alarm when any of —
- 3 consecutive heartbeats missed (data channel),
- `getStats()` `framesDecoded` stalled > 5s (catches frozen-frame-looks-live even if data channel survives),
- peer connection state `failed`/`disconnected`.

DOWN state is unmissable: full-screen red + repeating alarm tone. A monitor that fails silently is worse than no monitor.

**Reconnection ladder** — cheapest recovery that handles each failure:
1. Wi-Fi blip → automatic ICE restart on `connectionState: failed`.
2. Signaling loss (Mac rebooted / WS dropped) → both pages reconnect WS with exponential backoff and re-join the same room; room code persisted in URL fragment + localStorage so re-pairing needs zero taps.
3. Camera tab suspended (incoming call, screen lock) → on `visibilitychange` to visible: re-acquire wake lock, rebuild peer connection, re-offer. Viewer has been alarming since ~6s after the interruption.

**Known platform landmines (document + test):**
- iOS: camera dies when Safari is backgrounded or screen locks; screen must stay on (Wake Lock supported Safari 16.4+). Phone runs warm; must be plugged in.
- mDNS ICE obfuscation: browsers mask LAN IPs as `.local` hostnames; if mDNS is blocked on the network, LAN P2P silently fails (Tailscale 100.x candidates are the fallback path).
- Router AP/client isolation blocks phone↔phone LAN traffic (guest networks).
- Mac must stay awake for handshake/reconnects (`caffeinate`); established streams survive Mac sleep, reconnects don't.

## Security & Trust Model

| Attacker position | Can see | Cannot see |
|---|---|---|
| Signaling server operator | Room codes, connection times, IPs | Any media, any alert events |
| Device on the home Wi-Fi | That encrypted traffic exists | Stream contents (DTLS-SRTP); page requires tailnet/HTTPS |
| Someone with the URL, no room code | Landing page | Anything else — server rejects join |
| Tailscale (company) | Encrypted WireGuard packets, coordination metadata | Media — still e2e-encrypted inside the tunnel |
| Anyone on the public internet | Nothing — no public exposure | Everything |

Enforcement:
- Room codes: ≥ 8 chars of real entropy (crypto.getRandomValues), single camera per room, expire with the room.
- Known limitation, accepted: after a server restart, possession of the room code alone grants the camera role on re-creation — any code-holder (including a viewer device) could claim it. This is within the trusted-pair assumption; devices outside the pair never learn the code.
- Rate-limited joins; schema-validated WS messages.
- No accounts, cookies, analytics, or external requests of any kind. **CSP header mechanically enforces the no-external-requests claim** so users can verify it in DevTools.

## Testing

- **Unit** (`bun test`): room lifecycle, code generation/validation, message schemas, expiry, rate limiting.
- **E2E** (Playwright, fake media devices): two Chromium contexts pair via room code → assert frames flow → kill camera page → assert viewer alarms within deadline → revive → assert auto-reconnect. The safety-critical path is regression-tested, not hand-checked.
- **Manual device matrix** (documented checklist): iOS Safari + Android Chrome × LAN + remote (Tailscale) × screen-lock drill + incoming-call drill + Wi-Fi-drop drill.

## Open Source Packaging

- README leads with the trust-model table and the "verify, don't trust" audit pitch.
- Setup docs: Tailscale path (primary), mkcert LAN-only path (fallback), dedicated-phone golden path.
- License: to be chosen at implementation time (MIT vs AGPL — decision deferred, does not affect design).
