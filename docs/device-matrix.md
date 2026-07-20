# Device matrix — manual QA checklist

The safety-critical path (viewer alarms when the stream actually dies) is
covered by automated e2e tests (`bun run e2e`), but automated headless
Chromium can't reproduce real-phone behavior like screen lock, incoming
calls, or actual Wi-Fi radio drops. Run this checklist by hand on real
devices before trusting NannyCam with something that matters, and after any
change that touches the camera page, the watchdog, or reconnection.

## Matrix

Run each drill below on each combination of:

**Platforms:** iOS Safari, Android Chrome
**Networks:** LAN (both phones on the same home Wi-Fi), Remote (both phones
away from home, connected via Tailscale — see
[`setup-tailscale.md`](setup-tailscale.md))

That's 2 platforms × 2 networks = 4 environments, × 3 drills below = 12 runs.

## Drills

For each environment, pair a camera phone and a viewer phone, confirm live
video is flowing, then run all three:

### 1. Screen-lock drill

Lock the camera phone's screen (power button / lock gesture).

- **Expected:** the viewer shows the full-screen red DOWN/ALARM state within
  roughly 8 seconds. It must **not** keep showing a frozen last frame as if
  the stream were still live.
- Unlock the camera phone and confirm the viewer recovers automatically
  (stream resumes, alarm stops) without any manual action on either phone.

### 2. Incoming-call drill

Call the camera phone (from another phone) so it receives an incoming call.

- **Expected:** same as the screen-lock drill — the viewer alarms within
  ~8 seconds of the call interrupting the camera page, and recovers
  automatically once the call ends and the camera page is foregrounded
  again.

### 3. Wi-Fi-drop drill

Toggle Wi-Fi off then back on on the camera phone (or physically walk it out
of range and back, for the LAN environment).

- **Expected:** the viewer alarms while the connection is down, and recovers
  via ICE restart / signaling reconnect once Wi-Fi is restored — again with
  no manual action required on either phone.

## Known platform landmines

These are expected behaviors, not bugs — keep them in mind while running the
drills above so a landmine doesn't get mistaken for a regression:

- **iOS backgrounding kills the camera.** Safari on iOS stops the camera
  feed entirely when backgrounded or when the screen locks — this is exactly
  what the screen-lock and incoming-call drills are testing for. The camera
  phone's screen must stay on during normal operation; Wake Lock (which
  keeps the screen from sleeping on its own) is only supported from Safari
  16.4 onward.
- **The camera phone runs warm.** Continuous camera + encoding + wake lock
  is power-hungry. Keep the camera phone plugged in during use (the
  pre-flight checklist on the camera page checks for this where the browser
  supports it).
- **mDNS can silently break LAN pairing.** Browsers normally hide phones'
  real LAN IPs behind `.local` mDNS hostnames for ICE candidates. If mDNS
  traffic is blocked on a given network, LAN peer-to-peer connection can
  fail silently (no clear error, it just never connects). If a LAN pairing
  won't connect and mkcert/certs aren't the issue, try the Tailscale path —
  its `100.x` addresses don't depend on mDNS at all.
- **Router AP/client isolation blocks phone↔phone LAN traffic.** Common on
  guest Wi-Fi networks. Same fallback as above: Tailscale.
- **The Mac must stay awake.** See
  [`setup-tailscale.md`](setup-tailscale.md)'s `caffeinate` note — an
  established stream survives the Mac sleeping, but any reconnect (which is
  exactly what these drills exercise) needs the signaling server reachable.

## Recovering from an accidental "dedicated device" toggle

The camera page's pre-flight checklist has a "This is a dedicated device —
skip this checklist next time" checkbox. Checking it persists a flag that
skips the checklist on future launches, so the idle screen shows a direct
**Start camera** button instead of **Set up camera**.

If this gets toggled on by accident and you want the checklist back:

1. On the camera page's idle screen, tap the small **Set up…** link
   (`data-testid="dedicated-setup-link"`) below the **Start camera** button.
   This reopens the checklist without needing to clear browser storage.
2. In the checklist, uncheck **This is a dedicated device — skip this
   checklist next time**.
3. Tap **Back**.
4. Reload the page — the idle screen now shows **Set up camera** again, and
   the checklist will appear on future launches as normal.

## The iOS Do Not Disturb automation tip

The camera page's pre-flight checklist includes an expandable "iOS tip" with
this exact wording (quoted here so there's a single source of truth — see
`src/camera/preflight.tsx` if this ever needs to be checked against the live
copy):

> Add this page to the Home Screen (Share → Add to Home Screen) so it opens
> full-screen. Then in the Shortcuts app, add a Personal Automation: "When
> NannyCam is opened → Set Focus to Do Not Disturb" (Automation tab → new
> Personal Automation → App). It runs every time you start the camera — no
> need to remember it.
