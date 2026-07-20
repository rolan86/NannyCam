# LAN-only HTTPS via mkcert (fallback, no Tailscale)

If you don't want to install Tailscale and only need NannyCam to work while
both phones are on the same home Wi-Fi, you can serve the app over HTTPS
using a locally-trusted certificate authority via
[mkcert](https://github.com/FiloSottile/mkcert). This is entirely local —
no accounts, no cloud service — but it does require a one-time certificate
install on each phone (see step 4), and it will not work remotely or on
networks with client isolation (see the note at the bottom).

HTTPS is required here because camera/microphone access (`getUserMedia`) is
only permitted by mobile browsers on a secure origin.

## 1. Install mkcert on the Mac

```sh
brew install mkcert
mkcert -install
```

`mkcert -install` creates a local certificate authority (CA) and installs it
into your Mac's trust store.

## 2. Generate a certificate for the Mac's LAN name or IP

Find the Mac's LAN IP (System Settings → Network, or `ipconfig getifaddr
en0`), then generate a cert covering it:

```sh
mkcert 192.168.1.23 mac.local localhost 127.0.0.1
```

Replace `192.168.1.23` with your Mac's actual LAN IP, and add any `.local`
hostname you use. This produces two files in the current directory, e.g.
`192.168.1.23+3.pem` (certificate) and `192.168.1.23+3-key.pem` (private
key).

## 3. Serve the app over HTTPS with that certificate

NannyCam's own server (`server/main.ts`) is plain HTTP; put a TLS-terminating
reverse proxy (or an HTTPS-capable static server) in front of it using the
generated cert/key, pointed at the running `bun run serve` process. The exact
command depends on what you have available — any tool that can terminate TLS
with an arbitrary cert/key pair and proxy to `localhost:8080` works.

## 4. Install the mkcert root CA on each phone

This is the step people miss, and without it the phone's browser will
silently refuse to trust the certificate.

**iOS:**

1. Get the CA file onto the phone (AirDrop, email, or serve it as a
   downloadable file) — it's at `$(mkcert -CAROOT)/rootCA.pem`.
2. Open it on the phone; iOS will offer to install it as a configuration
   profile. Install it.
3. **Critical extra step:** go to Settings → General → About → Certificate
   Trust Settings, and toggle **full trust** on for the mkcert CA. iOS
   installs the profile in step 2 but does *not* trust it for websites until
   this toggle is flipped — Safari will just fail quietly, with no clear
   error pointing at the cause.

**Android:**

1. Get `rootCA.pem` onto the phone.
2. Settings → Security → Encryption & credentials → Install a certificate →
   **CA certificate**, and select the file.

## A note on guest/isolated networks

Some routers — especially guest networks — enable "AP isolation" or "client
isolation," which blocks devices on the same Wi-Fi from talking to each
other directly. If phone-to-phone pairing silently fails to connect on a
network like this, that's very likely why, and mkcert can't fix it: the
underlying Wi-Fi traffic between the two phones is being blocked at the
router, not at the TLS layer. In that situation, the
[Tailscale path](setup-tailscale.md) is the fallback — traffic routes over
Tailscale's `100.x` addresses instead of raw LAN IPs, which sidesteps AP
isolation entirely.
