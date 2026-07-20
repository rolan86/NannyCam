// NannyCam server — static files + WebSocket signaling relay.
//
// The relay wires the wire protocol (shared/protocol.ts) to the room state
// machine (server/rooms.ts). It never sees media: after SDP/ICE relay the
// peers talk P2P and the server is out of the loop.
//
// Exported as a port-parameterized factory so integration tests can start it
// on an ephemeral port (port: 0) with an injected clock. The returned handle
// exposes `sweep()` as a test hook; in production the same sweep runs every
// SWEEP_INTERVAL_MS via setInterval.

import { join, normalize, sep } from 'node:path';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import {
  MAX_MESSAGE_BYTES,
  parseMessage,
  type C2S,
  type ErrorReason,
  type S2C,
} from '../shared/protocol.ts';
import { RoomManager } from './rooms.ts';

/**
 * Grace-expiry sweep cadence. Kept at 1s so a camera reclaiming "just in
 * time" has at most 1s of slack past the spec's 10-minute grace period.
 */
export const SWEEP_INTERVAL_MS = 1000;

interface SocketData {
  /**
   * Server-generated peer id; doubles as the rate-limiter connection id
   * (RoomManager's joinRoom/recreateRoom/reclaimRoom/stopCamera all key their
   * sliding failure window on this string — see rooms.ts). Task 14 decision, worth
   * documenting explicitly: this is per-CONNECTION identity, not per-IP.
   * A reconnecting client gets a fresh peerId and therefore a fresh rate
   * limit window — an attacker who can freely reconnect (nothing here rate
   * limits raw TCP/WS connection attempts) resets their own budget for
   * free. Accepted for this app's actual deployment model: a private
   * tailnet exposed via tailscale serve, not the open internet. IP-level
   * limiting is deliberately out of scope, and not just as a "not yet"
   * shortcut — it would be actively misleading here, because Bun's `req`
   * sees whatever address tailscale serve's local reverse-proxy connects
   * from (typically loopback), not the tailnet peer's real IP. Getting a
   * real per-peer IP would need trusting a forwarded-for style header from
   * that proxy, which is its own can of worms for a single-binary app this
   * size. The 64 KB frame cap, the MAX_ROOMS cap, and one-room-per-socket
   * are the belt-and-suspenders layers that don't depend on IP identity.
   */
  peerId: string;
  /** Set while the socket is bound to a room. One room per socket, ever. */
  roomCode?: string;
  role?: 'camera' | 'viewer';
}

type Socket = ServerWebSocket<SocketData>;

export interface StartOptions {
  /** TCP port; 0 for an ephemeral port (tests read it back from `port`). */
  port: number;
  /** Injected clock for the RoomManager (tests); defaults to Date.now. */
  now?: () => number;
  /** Built client assets directory; defaults to <repo>/dist. */
  distDir?: string;
  /**
   * Adds `ws:` to the CSP `connect-src` so the e2e suite can run the relay
   * over plain http://localhost. MUST stay false in production — behind
   * `tailscale serve` the app is always https/wss. Defaults to false.
   */
  allowInsecureWs?: boolean;
}

export interface RelayHandle {
  server: Server<SocketData>;
  /** The actually bound port (resolves port: 0). */
  port: number;
  /** Run one grace-expiry sweep immediately (test hook; interval also runs). */
  sweep(): void;
  /** Stop the sweep interval and force-close the server and all sockets. */
  stop(): void;
}

const err = (reason: ErrorReason): S2C => ({ type: 'error', reason });

/**
 * Task 14 (review fix: environment-conditional CSP): every HTTP response
 * carries this CSP — the mechanical enforcement of the spec's "no external
 * requests" rule. `connect-src` is `wss:`-only by default, exactly matching
 * the implementation plan's canonical string: production always sits behind
 * `tailscale serve`, which terminates TLS in front of this process, so the
 * app always sees itself as https:// and SignalingClient's
 * `location.protocol === 'https:' ? 'wss' : 'ws'` dials wss:// only. Shipping
 * `ws:` to production would be an unnecessary loosening of the policy for a
 * transport the app never actually uses there.
 *
 * `opts.allowInsecureWs` (see StartOptions) is the ONLY way to add `ws:` to
 * `connect-src`, and it must stay false in production. It exists purely for
 * the e2e suite, which boots the bare Bun server on plain http://localhost —
 * there `location.protocol` is `http:`, so SignalingClient dials `ws://`,
 * and without this opt-in the whole e2e suite would fail closed under its
 * own CSP.
 *
 * `img-src 'self' data:` covers qrcode's `toCanvas`, which draws directly to
 * a <canvas> (no data: URI actually crosses the wire) — kept anyway as
 * harmless slack matching the spec string exactly. `media-src 'self' blob:`
 * covers the <video>/<audio> elements' MediaStream srcObject assignments
 * (WebRTC-internal, not a network fetch, but some engines still gate
 * srcObject through media-src). No `script-src` override: default-src 'self'
 * already blocks inline/external scripts, and Vite emits only external,
 * hashed, same-origin module scripts — no nonce needed.
 */
function buildCsp(allowInsecureWs: boolean): string {
  const connectSrc = allowInsecureWs ? "'self' wss: ws:" : "'self' wss:";
  return `default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src ${connectSrc}`;
}

export function startServer(opts: StartOptions): RelayHandle {
  const distDir = normalize(opts.distDir ?? join(import.meta.dir, '..', 'dist'));
  const csp = buildCsp(opts.allowInsecureWs ?? false);
  function withCsp(res: Response): Response {
    res.headers.set('Content-Security-Policy', csp);
    return res;
  }
  const rooms = new RoomManager(opts.now ?? Date.now);
  /** peerId -> live socket. */
  const peers = new Map<string, Socket>();
  /** room code -> peerId of the socket currently bound as that room's camera. */
  const cameraByRoom = new Map<string, string>();

  // -- outbound helpers -----------------------------------------------------

  function send(ws: Socket, msg: S2C): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket died mid-send; its close handler does the cleanup.
    }
  }

  function sendTo(peerId: string, msg: S2C): void {
    const ws = peers.get(peerId);
    if (ws) send(ws, msg);
  }

  function broadcastToViewers(code: string, msg: S2C): void {
    for (const viewerId of rooms.viewers(code)) sendTo(viewerId, msg);
  }

  function unbind(peerId: string): void {
    const ws = peers.get(peerId);
    if (ws) {
      ws.data.roomCode = undefined;
      ws.data.role = undefined;
    }
  }

  function bindCamera(ws: Socket, code: string): void {
    ws.data.roomCode = code;
    ws.data.role = 'camera';
    cameraByRoom.set(code, ws.data.peerId);
  }

  /**
   * Replay the room's current viewer roster to a (re)binding camera socket
   * as one peer-joined per viewer. A camera reconnecting on a fresh socket
   * otherwise knows no viewer peerIds (and viewers don't know its new one),
   * so reconnection-ladder rung 3 could never re-offer.
   */
  function replayRoster(ws: Socket, code: string): void {
    for (const viewerId of rooms.viewers(code)) {
      send(ws, { type: 'peer-joined', peerId: viewerId });
    }
  }

  // -- inbound message handling ---------------------------------------------

  function handleMessage(ws: Socket, msg: C2S): void {
    switch (msg.type) {
      case 'create-room': {
        // One room per socket: a socket already bound to a live room may not
        // mint or enter another (caps hostile room-minting at connection
        // count). RoomManager.createRoom also enforces the global MAX_ROOMS
        // cap (Task 14) as a belt-and-suspenders backstop over this.
        if (ws.data.roomCode !== undefined) return send(ws, err('invalid'));
        const res = rooms.createRoom();
        if (!res.ok) return send(ws, err(res.reason));
        bindCamera(ws, res.code);
        return send(ws, {
          type: 'room-created',
          code: res.code,
          cameraToken: res.cameraToken,
          peerId: ws.data.peerId,
        });
      }

      case 'recreate-room': {
        if (ws.data.roomCode !== undefined) return send(ws, err('invalid'));
        const res = rooms.recreateRoom(msg.code, ws.data.peerId);
        if (!res.ok) return send(ws, err(res.reason));
        bindCamera(ws, msg.code);
        send(ws, {
          type: 'room-created',
          code: msg.code,
          cameraToken: res.cameraToken,
          peerId: ws.data.peerId,
        });
        // Recreation only succeeds when no room with this code exists, so the
        // roster replay and viewer broadcast are no-ops today; kept for
        // symmetry with reclaim.
        replayRoster(ws, msg.code);
        return broadcastToViewers(msg.code, { type: 'camera-back' });
      }

      case 'reclaim-room': {
        if (ws.data.roomCode !== undefined) return send(ws, err('invalid'));
        // connectionId: Task 14 routes reclaim failures through the same
        // per-connection rate limiter as join/recreate (see reclaimRoom's
        // doc) — peerId doubles as the connection id (SocketData's doc).
        const res = rooms.reclaimRoom(msg.code, msg.cameraToken, ws.data.peerId);
        if (!res.ok) return send(ws, err(res.reason));
        // Spec: reclaim is allowed while the camera is still marked present
        // (its disconnect may not have been observed yet). Detach the stale
        // socket BEFORE closing it so its close handler neither orphans the
        // room nor broadcasts peer-left.
        const staleId = cameraByRoom.get(msg.code);
        if (staleId !== undefined && staleId !== ws.data.peerId) {
          unbind(staleId);
          const stale = peers.get(staleId);
          if (stale) {
            try {
              stale.close();
            } catch {
              // already closing
            }
          }
        }
        bindCamera(ws, msg.code);
        // Ack with room-created: the reclaiming socket needs its fresh peerId
        // (and the echoed code/token) to resume signaling.
        send(ws, {
          type: 'room-created',
          code: msg.code,
          cameraToken: msg.cameraToken,
          peerId: ws.data.peerId,
        });
        // Replay the current viewer roster to the reclaiming socket: without
        // it, neither side knows the other's peerId after a camera reconnect
        // and reconnection-ladder rung 3 (rebuild + re-offer) would deadlock.
        replayRoster(ws, msg.code);
        return broadcastToViewers(msg.code, { type: 'camera-back' });
      }

      case 'join-room': {
        if (ws.data.roomCode !== undefined) return send(ws, err('invalid'));
        const res = rooms.joinRoom(msg.code, ws.data.peerId, ws.data.peerId);
        if (!res.ok) return send(ws, err(res.reason));
        ws.data.roomCode = msg.code;
        ws.data.role = 'viewer';
        send(ws, { type: 'room-joined', peerId: ws.data.peerId, cameraPresent: res.cameraPresent });
        const camId = cameraByRoom.get(msg.code);
        if (camId !== undefined) sendTo(camId, { type: 'peer-joined', peerId: ws.data.peerId });
        return;
      }

      case 'stop-camera': {
        // The token is the real authentication; the role checks are
        // defense-in-depth (a viewer could always open a second, unbound
        // socket). Unbound senders with a valid token are deliberately
        // accepted — a reconnected camera may stop without reclaiming first,
        // which is exactly why this path is reachable unauthenticated and
        // needs its own rate limiting: peerId doubles as the connection id
        // (SocketData's doc), routed through the same per-connection limiter
        // reclaimRoom uses (rooms.ts stopCamera's doc) since stopCamera has
        // the identical bad-code/bad-token oracle shape.
        if (ws.data.role === 'viewer') return send(ws, err('invalid'));
        if (ws.data.role === 'camera' && ws.data.roomCode !== msg.code) {
          return send(ws, err('invalid'));
        }
        const res = rooms.stopCamera(msg.code, msg.cameraToken, ws.data.peerId);
        if (!res.ok) return send(ws, err(res.reason));
        // Evicted viewers learn the room is gone; their sockets stay open
        // with bindings cleared so they may join another room.
        for (const viewerId of res.viewers) {
          sendTo(viewerId, { type: 'room-closed' });
          unbind(viewerId);
        }
        const camId = cameraByRoom.get(msg.code);
        if (camId !== undefined) {
          // Task 14: a DIFFERENT socket than the one issuing this stop-camera
          // may still be bound as the room's camera — e.g. a reconnected
          // camera stops the room from a fresh socket (see the doc above)
          // while its stale prior socket is still bound. That stale socket
          // previously went silently unbound with no signal at all; tell it
          // room-closed too, same courtesy as evicted viewers, before
          // clearing its binding. The socket issuing the stop already knows
          // (it just asked for this) and needs no self-notification.
          if (camId !== ws.data.peerId) sendTo(camId, { type: 'room-closed' });
          unbind(camId);
          cameraByRoom.delete(msg.code);
        }
        return;
      }

      case 'signal': {
        const code = ws.data.roomCode;
        if (code === undefined) return send(ws, err('invalid'));
        const target = peers.get(msg.to);
        // Relay only within the sender's room, only to the addressed peer.
        if (!target || target.data.roomCode !== code) return send(ws, err('invalid'));
        return send(target, { type: 'signal', from: ws.data.peerId, payload: msg.payload });
      }

      default: {
        // Compile-time exhaustiveness: adding a seventh C2S variant without
        // handling it here is a type error, not a silently dropped message.
        const _exhaustive: never = msg;
        return _exhaustive;
      }
    }
  }

  function handleClose(ws: Socket): void {
    peers.delete(ws.data.peerId);
    const { peerId, roomCode: code, role } = ws.data;
    ws.data.roomCode = undefined;
    ws.data.role = undefined;
    if (code === undefined) return;
    if (role === 'viewer') {
      if (rooms.viewerLeft(code, peerId)) {
        const camId = cameraByRoom.get(code);
        if (camId !== undefined) sendTo(camId, { type: 'peer-left', peerId });
      }
    } else if (role === 'camera' && cameraByRoom.get(code) === peerId) {
      // Camera vanished without stop-camera: room orphans into grace; viewers
      // keep their sockets and are told the camera is gone.
      cameraByRoom.delete(code);
      rooms.cameraDisconnected(code);
      broadcastToViewers(code, { type: 'peer-left', peerId });
    }
  }

  // -- grace-expiry sweep ---------------------------------------------------

  function runSweep(): void {
    for (const { code, viewers } of rooms.sweep()) {
      for (const viewerId of viewers) {
        sendTo(viewerId, { type: 'room-closed' });
        unbind(viewerId);
      }
      cameraByRoom.delete(code);
    }
  }

  const sweepTimer = setInterval(() => {
    try {
      runSweep();
    } catch {
      // Sweep must never take the process down.
    }
  }, SWEEP_INTERVAL_MS);

  // -- HTTP + WS server -----------------------------------------------------

  async function serveStatic(pathname: string): Promise<Response> {
    // "/" serves index.html; every other miss is a hard 404 — this is a
    // multi-page app, and an index fallback would mask missing assets.
    const rel = pathname === '/' ? '/index.html' : pathname;
    let path: string;
    try {
      path = normalize(join(distDir, decodeURIComponent(rel)));
    } catch {
      return new Response('not found', { status: 404 });
    }
    if (!path.startsWith(distDir + sep)) return new Response('not found', { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response('not found', { status: 404 });
    return new Response(file);
  }

  const websocket: WebSocketHandler<SocketData> = {
    // Frames over the protocol cap are terminated by Bun itself.
    maxPayloadLength: MAX_MESSAGE_BYTES,
    open(ws) {
      peers.set(ws.data.peerId, ws);
    },
    message(ws, raw) {
      try {
        // Everything inbound goes through parseMessage; binary frames are
        // not part of the protocol and fall through as invalid.
        const msg = typeof raw === 'string' ? parseMessage(raw, 'c2s') : null;
        if (msg === null) return send(ws, err('invalid'));
        handleMessage(ws, msg);
      } catch {
        // Hostile input must not crash the relay.
        send(ws, err('invalid'));
      }
    },
    close(ws) {
      try {
        handleClose(ws);
      } catch {
        // Cleanup failure must not crash the relay.
      }
    },
  };

  const server = Bun.serve({
    port: opts.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        const upgraded = srv.upgrade(req, { data: { peerId: crypto.randomUUID() } });
        if (upgraded) return undefined;
        return withCsp(new Response('websocket upgrade required', { status: 400 }));
      }
      if (url.pathname === '/healthz') return withCsp(new Response('ok'));
      return serveStatic(url.pathname).then(withCsp);
    },
    websocket,
  });

  return {
    server,
    port: server.port ?? opts.port,
    sweep: runSweep,
    stop() {
      clearInterval(sweepTimer);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const { port } = startServer({
    port: Number(Bun.env.PORT ?? 8080),
    allowInsecureWs: Bun.env.NANNYCAM_ALLOW_INSECURE_WS === '1',
  });
  console.log(`Listening on http://localhost:${port}`);
}
