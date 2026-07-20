# Remote access via Tailscale (primary path)

This is the recommended way to run NannyCam: it gives you one URL that works
identically at home and away, with a real HTTPS certificate, and no cert
installs on either phone.

## 1. Install Tailscale on all three devices

Install [Tailscale](https://tailscale.com/download) on:

- The Mac that will run the NannyCam server.
- The camera phone.
- The viewer phone.

Sign in to the **same tailnet** (the same Tailscale account/organization) on
all three. Once signed in, each device gets a stable `100.x.y.z` address and
a name on your tailnet.

## 2. Front the server with `tailscale serve`

With the NannyCam server running locally (`bun run serve`, default port
8080), run on the Mac:

```sh
tailscale serve --bg 8080
```

This tells Tailscale to terminate HTTPS for you and proxy requests through to
the local server on port 8080. You get:

- A stable URL of the form `https://<mac-name>.<tailnet>.ts.net`.
- A real Let's Encrypt certificate, issued and renewed automatically —
  nothing to install on either phone.
- The same URL works whether the phones are on your home Wi-Fi or on mobile
  data anywhere else, because Tailscale routes over its WireGuard mesh either
  way.

This is what dissolves the "LAN needs HTTPS but HTTPS needs a real
certificate" problem: instead of a locally-trusted CA you'd have to install
on every phone (see [`setup-mkcert.md`](setup-mkcert.md) for that fallback),
Tailscale gives you a certificate the phones' browsers already trust, for a
name that resolves correctly both on and off your home network.

## 3. Keep the Mac awake

The Mac needs to be reachable for the initial pairing handshake and for any
reconnect (Wi-Fi drop, camera phone locked/backgrounded, server restart).
Once a stream is already established, phone-to-phone media keeps flowing
even if the Mac sleeps — but a *reconnect* needs the signaling server to be
up. Keep the Mac from sleeping while NannyCam is in use:

```sh
caffeinate -s
```

Run this in a terminal alongside the server (or wrap both in one command),
or adjust the Mac's sleep settings for as long as you're relying on the
camera.

## Why the app only ever dials `wss://`

Because `tailscale serve` terminates TLS in front of the app, the app itself
always sees the connection as `https://` — it never runs in a plain-HTTP
mode when accessed this way. That's why the production Content-Security-Policy
only allows `wss:` (encrypted WebSocket) in `connect-src` and not `ws:`: in
this deployment, the app never needs the insecure scheme, so the policy
doesn't leave it available.
