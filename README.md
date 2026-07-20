# NannyCam

A private nanny cam between two of your phones. It's self-hosted on a Mac you
already own, requires no app install on either phone, never records or stores
footage, and is small enough that you (or anyone) can read the whole thing and
verify the privacy claims yourself.

## Trust model

| Attacker position | Can see | Cannot see |
|---|---|---|
| Signaling server operator | Room codes, connection times, IPs | Any media, any alert events |
| Device on the home Wi-Fi | That encrypted traffic exists | Stream contents (DTLS-SRTP); page requires tailnet/HTTPS |
| Someone with the URL, no room code | Landing page | Anything else — server rejects join |
| Tailscale (company) | Encrypted WireGuard packets, coordination metadata | Media — still e2e-encrypted inside the tunnel |
| Anyone on the public internet | Nothing — no public exposure | Everything |

## Verify, don't trust

Don't take the table above on faith. The privacy guarantee here is
**structural**, not a policy promise:

- **No STUN, no TURN.** The WebRTC peer connection is configured with
  `iceServers: []` — only host candidates (your LAN IP or your Tailscale
  `100.x` IP) are ever gathered. There is no third-party relay in the
  connection path even in principle, because none is ever contacted.
- **You run the only server.** The signaling server (a single Bun process)
  is the one you started, on hardware you control. It relays SDP/ICE
  metadata to set up the connection and is out of the loop the moment media
  starts flowing — it physically never sees video or audio.

Two cheap ways to check this yourself instead of trusting this paragraph:

1. **Network tab.** Open DevTools → Network on either phone (or a desktop
   browser pointed at the same origin) and confirm the only connections are
   to your own Mac/tailnet — the app makes zero requests to any third party,
   ever, at any point in a session.
2. **CSP header.** Read the `Content-Security-Policy` response header in
   DevTools. It forbids inline scripts and plaintext (`ws:`) egress in
   production — a mechanical guard against injected code and unencrypted
   signaling. (It is not a per-host allowlist; the "no third party" guarantee
   above comes from the `iceServers: []` config and self-hosting, not from
   the CSP.)
3. **Read the code.** This is a small, dependency-light codebase — two
   runtime dependencies total (`qrcode`, for rendering the pairing QR code).
   Everything else — signaling, room lifecycle, the watchdog, the
   noise/motion detectors — is first-party code in this repo.
4. **Run the tests yourself** — see below.

## Quickstart

Prerequisites: [Bun](https://bun.sh) (runs the server and the test suite;
also drives the Vite build for the client).

```sh
bun install
bun run build     # builds the client (Vite) into dist/
bun run serve     # starts the server; PORT env var, default 8080
```

Then open the app's landing page on both phones:

- On the phone that will watch the room: **This phone is the camera**.
- On the phone that will be watched: **This phone is the viewer**.

For this to work off your home Wi-Fi (or from a phone Safari/Chrome will
actually trust for camera access), you need HTTPS. Two options, in order of
recommendation:

- [`docs/setup-tailscale.md`](docs/setup-tailscale.md) — the primary path:
  one URL that works at home and remotely, no certs to install on phones.
- [`docs/setup-mkcert.md`](docs/setup-mkcert.md) — a LAN-only fallback for
  people who don't want to install Tailscale.

Also see [`docs/device-matrix.md`](docs/device-matrix.md) — a manual QA
checklist to run on real devices before you trust this with something that
matters.

## Running the tests yourself

```sh
bun test                    # unit suite: protocol, room lifecycle, watchdog, detectors
bun run e2e                 # Playwright e2e: pair → frames → kill camera → alarm → revive → auto-recover → talk-back
bunx tsc --noEmit           # type check
```

Notes:

- Bare `bun test` respects the e2e ignore automatically via `bunfig.toml`;
  the `bun run test` script additionally passes
  `--path-ignore-patterns 'e2e/**'` for the same effect when invoked another
  way.
- `bun run e2e` needs Chromium available to Playwright. If it's not already
  installed: `bunx playwright install chromium`.

## Setup guides

- [`docs/setup-tailscale.md`](docs/setup-tailscale.md) — remote access via
  Tailscale (primary path).
- [`docs/setup-mkcert.md`](docs/setup-mkcert.md) — LAN-only HTTPS via mkcert
  (fallback, no Tailscale account needed).
- [`docs/device-matrix.md`](docs/device-matrix.md) — manual device/drill
  checklist (iOS Safari / Android Chrome × LAN / remote).

## License

MIT — see [LICENSE](LICENSE).
