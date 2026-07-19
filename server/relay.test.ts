// WebSocket relay integration tests — real Bun server on an ephemeral port,
// real WebSocket clients, injected clock.
//
// The factory (startServer) accepts `now?: () => number` so tests control
// time; grace expiry is driven either via the returned handle's `sweep()`
// test hook or by the real 1-second sweep interval (both are covered).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_MESSAGE_BYTES,
  type C2S,
  type S2C,
} from '../shared/protocol.ts';
import { GRACE_MS, MAX_VIEWERS, RATE_LIMIT_MAX_FAILURES } from './rooms.ts';
import { startServer, SWEEP_INTERVAL_MS, type RelayHandle } from './main.ts';

const codeRe = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
const tokenRe = /^[0-9a-f]{32}$/;

// -- harness ----------------------------------------------------------------

const handles: RelayHandle[] = [];
const sockets: WebSocket[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
  sockets.length = 0;
  for (const h of handles) h.stop();
  handles.length = 0;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function boot(opts: { now?: () => number; distDir?: string } = {}): RelayHandle {
  const h = startServer({ port: 0, ...opts });
  handles.push(h);
  return h;
}

interface TestClient {
  ws: WebSocket;
  send(msg: C2S): void;
  sendRaw(raw: string): void;
  /** Next S2C message (throws on timeout). */
  next(ms?: number): Promise<S2C>;
  /** Assert no message arrives within the window. */
  expectSilence(ms?: number): Promise<void>;
  /** Resolves when the socket closes. */
  closed(): Promise<void>;
}

async function connect(port: number): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const queue: S2C[] = [];
  const waiters: ((m: S2C) => void)[] = [];
  let isClosed = false;
  const closeWaiters: (() => void)[] = [];

  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as S2C;
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  ws.addEventListener('close', () => {
    isClosed = true;
    for (const f of closeWaiters.splice(0)) f();
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('WS connect failed')));
  });

  return {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    sendRaw: (raw) => ws.send(raw),
    next: (ms = 5000) => {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise<S2C>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('timed out waiting for S2C message'));
        }, ms);
        const waiter = (m: S2C) => {
          clearTimeout(timer);
          resolve(m);
        };
        waiters.push(waiter);
      });
    },
    expectSilence: async (ms = 150) => {
      await Bun.sleep(ms);
      expect(queue).toEqual([]);
    },
    closed: () =>
      isClosed ? Promise.resolve() : new Promise((resolve) => closeWaiters.push(resolve)),
  };
}

/** Camera connects and creates a room. */
async function createRoom(port: number) {
  const cam = await connect(port);
  cam.send({ type: 'create-room' });
  const created = await cam.next();
  if (created.type !== 'room-created') throw new Error(`expected room-created, got ${created.type}`);
  return { cam, code: created.code, token: created.cameraToken, camId: created.peerId };
}

/** Viewer connects and joins; returns the client plus its peerId. */
async function joinRoom(port: number, code: string) {
  const viewer = await connect(port);
  viewer.send({ type: 'join-room', code });
  const joined = await viewer.next();
  if (joined.type !== 'room-joined') throw new Error(`expected room-joined, got ${joined.type}`);
  return { viewer, viewerId: joined.peerId, cameraPresent: joined.cameraPresent };
}

// -- create / join ----------------------------------------------------------

describe('create and join', () => {
  test('create-room → room-created with well-formed code, token, peerId', async () => {
    const h = boot();
    const cam = await connect(h.port);
    cam.send({ type: 'create-room' });
    const msg = await cam.next();
    expect(msg.type).toBe('room-created');
    if (msg.type !== 'room-created') return;
    expect(msg.code).toMatch(codeRe);
    expect(msg.cameraToken).toMatch(tokenRe);
    expect(msg.peerId.length).toBeGreaterThan(0);
  });

  test('join: viewer gets room-joined, camera gets peer-joined', async () => {
    const h = boot();
    const { cam, code, camId } = await createRoom(h.port);
    const { viewerId, cameraPresent } = await joinRoom(h.port, code);
    expect(cameraPresent).toBe(true);
    expect(viewerId).not.toBe(camId);
    const notice = await cam.next();
    expect(notice).toEqual({ type: 'peer-joined', peerId: viewerId });
  });

  test('room full: viewer past MAX_VIEWERS → error room-full', async () => {
    const h = boot();
    const { cam, code } = await createRoom(h.port);
    for (let i = 0; i < MAX_VIEWERS; i++) {
      await joinRoom(h.port, code);
      await cam.next(); // peer-joined
    }
    const extra = await connect(h.port);
    extra.send({ type: 'join-room', code });
    expect(await extra.next()).toEqual({ type: 'error', reason: 'room-full' });
    await cam.expectSilence();
  });

  test('join with unknown code → error bad-code', async () => {
    const h = boot();
    const viewer = await connect(h.port);
    viewer.send({ type: 'join-room', code: 'ZZZZZZZ2' });
    expect(await viewer.next()).toEqual({ type: 'error', reason: 'bad-code' });
  });

  test('repeated failed joins → rate-limited', async () => {
    const h = boot();
    const viewer = await connect(h.port);
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i++) {
      viewer.send({ type: 'join-room', code: 'ZZZZZZZ2' });
      expect(await viewer.next()).toEqual({ type: 'error', reason: 'bad-code' });
    }
    viewer.send({ type: 'join-room', code: 'ZZZZZZZ2' });
    expect(await viewer.next()).toEqual({ type: 'error', reason: 'rate-limited' });
  });
});

// -- one room per socket ----------------------------------------------------

describe('one room per socket', () => {
  test('second create-room from a room-owning socket → error invalid, room intact', async () => {
    const h = boot();
    const { cam, code } = await createRoom(h.port);
    cam.send({ type: 'create-room' });
    expect(await cam.next()).toEqual({ type: 'error', reason: 'invalid' });
    // Original room still alive and still bound to this camera.
    const { viewerId } = await joinRoom(h.port, code);
    expect(await cam.next()).toEqual({ type: 'peer-joined', peerId: viewerId });
  });

  test('recreate-room from a room-owning socket → error invalid', async () => {
    const h = boot();
    const { cam, code } = await createRoom(h.port);
    cam.send({ type: 'recreate-room', code: 'ABCDEFGH' });
    expect(await cam.next()).toEqual({ type: 'error', reason: 'invalid' });
    expect((await joinRoom(h.port, code)).cameraPresent).toBe(true);
  });

  test('join-room from a camera socket → error invalid', async () => {
    const h = boot();
    const { cam, code } = await createRoom(h.port);
    cam.send({ type: 'join-room', code });
    expect(await cam.next()).toEqual({ type: 'error', reason: 'invalid' });
  });

  test('create-room from a joined viewer socket → error invalid', async () => {
    const h = boot();
    const { code } = await createRoom(h.port);
    const { viewer } = await joinRoom(h.port, code);
    viewer.send({ type: 'create-room' });
    expect(await viewer.next()).toEqual({ type: 'error', reason: 'invalid' });
  });
});

// -- signal relay -----------------------------------------------------------

describe('signal relay', () => {
  test('relays only to the addressed peer within the room', async () => {
    const h = boot();
    const { cam, code, camId } = await createRoom(h.port);
    const a = await joinRoom(h.port, code);
    await cam.next(); // peer-joined a
    const b = await joinRoom(h.port, code);
    await cam.next(); // peer-joined b

    cam.send({ type: 'signal', to: a.viewerId, payload: { sdp: 'offer' } });
    expect(await a.viewer.next()).toEqual({ type: 'signal', from: camId, payload: { sdp: 'offer' } });
    await b.viewer.expectSilence();

    a.viewer.send({ type: 'signal', to: camId, payload: null });
    expect(await cam.next()).toEqual({ type: 'signal', from: a.viewerId, payload: null });
  });

  test('signal across rooms → error invalid, target gets nothing', async () => {
    const h = boot();
    const roomA = await createRoom(h.port);
    const roomB = await createRoom(h.port);
    roomA.cam.send({ type: 'signal', to: roomB.camId, payload: 'x' });
    expect(await roomA.cam.next()).toEqual({ type: 'error', reason: 'invalid' });
    await roomB.cam.expectSilence();
  });

  test('signal to unknown peer → error invalid', async () => {
    const h = boot();
    const { cam } = await createRoom(h.port);
    cam.send({ type: 'signal', to: 'nobody', payload: 'x' });
    expect(await cam.next()).toEqual({ type: 'error', reason: 'invalid' });
  });

  test('signal before joining any room → error invalid', async () => {
    const h = boot();
    const { camId } = await createRoom(h.port);
    const stranger = await connect(h.port);
    stranger.send({ type: 'signal', to: camId, payload: 'x' });
    expect(await stranger.next()).toEqual({ type: 'error', reason: 'invalid' });
  });
});

// -- malformed input --------------------------------------------------------

describe('malformed input', () => {
  test('malformed frame → single error invalid, connection survives', async () => {
    const h = boot();
    const c = await connect(h.port);
    c.sendRaw('this is not json');
    expect(await c.next()).toEqual({ type: 'error', reason: 'invalid' });
    await c.expectSilence();
    c.send({ type: 'create-room' });
    expect((await c.next()).type).toBe('room-created');
  });

  test('schema-invalid message (extra field) → error invalid', async () => {
    const h = boot();
    const c = await connect(h.port);
    c.sendRaw(JSON.stringify({ type: 'create-room', extra: 1 }));
    expect(await c.next()).toEqual({ type: 'error', reason: 'invalid' });
  });

  test('s2c-typed message from client → error invalid', async () => {
    const h = boot();
    const c = await connect(h.port);
    c.sendRaw(JSON.stringify({ type: 'room-closed' }));
    expect(await c.next()).toEqual({ type: 'error', reason: 'invalid' });
  });

  test('binary frame → error invalid, connection survives', async () => {
    const h = boot();
    const c = await connect(h.port);
    c.ws.send(new Uint8Array([1, 2, 3]));
    expect(await c.next()).toEqual({ type: 'error', reason: 'invalid' });
    await c.expectSilence();
    c.send({ type: 'create-room' });
    expect((await c.next()).type).toBe('room-created');
  });

  test('oversize frame → connection closed (maxPayloadLength)', async () => {
    const h = boot();
    const c = await connect(h.port);
    c.sendRaw('a'.repeat(MAX_MESSAGE_BYTES + 1));
    await c.closed();
  });
});

// -- camera disconnect, orphan, reclaim -------------------------------------

describe('camera disconnect and reclaim', () => {
  test('camera close → viewers get peer-left, room orphans, joins still allowed', async () => {
    const h = boot();
    const { cam, code, camId } = await createRoom(h.port);
    const { viewer } = await joinRoom(h.port, code);
    await cam.next(); // peer-joined
    cam.ws.close();
    expect(await viewer.next()).toEqual({ type: 'peer-left', peerId: camId });
    // Room orphaned, not destroyed: new viewer joins and sees DOWN state.
    const late = await joinRoom(h.port, code);
    expect(late.cameraPresent).toBe(false);
  });

  test('reclaim → camera re-bound (room-created ack), viewers get camera-back', async () => {
    const h = boot();
    const { cam, code, token, camId } = await createRoom(h.port);
    const { viewer, viewerId: existingViewerId } = await joinRoom(h.port, code);
    await cam.next(); // peer-joined
    cam.ws.close();
    await viewer.next(); // peer-left

    const cam2 = await connect(h.port);
    cam2.send({ type: 'reclaim-room', code, cameraToken: token });
    const ack = await cam2.next();
    expect(ack.type).toBe('room-created');
    if (ack.type !== 'room-created') return;
    expect(ack.code).toBe(code);
    expect(ack.cameraToken).toBe(token);
    expect(ack.peerId).not.toBe(camId);
    // Roster replay: the pre-existing viewer is announced to the new socket.
    expect(await cam2.next()).toEqual({ type: 'peer-joined', peerId: existingViewerId });
    expect(await viewer.next()).toEqual({ type: 'camera-back' });
    // New camera socket is bound: it gets peer-joined for the next viewer.
    const { viewerId } = await joinRoom(h.port, code);
    expect(await cam2.next()).toEqual({ type: 'peer-joined', peerId: viewerId });
  });

  test('reclaim replays one peer-joined per pre-existing viewer', async () => {
    const h = boot();
    const { cam, code, token } = await createRoom(h.port);
    const a = await joinRoom(h.port, code);
    await cam.next(); // peer-joined a
    const b = await joinRoom(h.port, code);
    await cam.next(); // peer-joined b
    cam.ws.close();
    await a.viewer.next(); // peer-left
    await b.viewer.next(); // peer-left

    const cam2 = await connect(h.port);
    cam2.send({ type: 'reclaim-room', code, cameraToken: token });
    expect((await cam2.next()).type).toBe('room-created');
    // Exactly one peer-joined per current viewer, in join order.
    expect(await cam2.next()).toEqual({ type: 'peer-joined', peerId: a.viewerId });
    expect(await cam2.next()).toEqual({ type: 'peer-joined', peerId: b.viewerId });
    await cam2.expectSilence();
    expect(await a.viewer.next()).toEqual({ type: 'camera-back' });
    expect(await b.viewer.next()).toEqual({ type: 'camera-back' });
  });

  test('signal round-trip after reclaim using only replayed/relayed peerIds', async () => {
    const h = boot();
    const { cam, code, token } = await createRoom(h.port);
    const { viewer } = await joinRoom(h.port, code);
    await cam.next(); // peer-joined
    cam.ws.close();
    await viewer.next(); // peer-left

    const cam2 = await connect(h.port);
    cam2.send({ type: 'reclaim-room', code, cameraToken: token });
    await cam2.next(); // room-created ack
    const replayed = await cam2.next();
    expect(replayed.type).toBe('peer-joined');
    if (replayed.type !== 'peer-joined') return;
    await viewer.next(); // camera-back

    // Camera re-offers using ONLY the replayed viewer peerId...
    cam2.send({ type: 'signal', to: replayed.peerId, payload: { sdp: 'offer' } });
    const offer = await viewer.next();
    expect(offer.type).toBe('signal');
    if (offer.type !== 'signal') return;
    expect(offer.payload).toEqual({ sdp: 'offer' });
    // ...and the viewer answers using ONLY the relayed `from` field — rung 3
    // is wireable with zero viewer-side prior knowledge of the new camera id.
    viewer.send({ type: 'signal', to: offer.from, payload: { sdp: 'answer' } });
    const answer = await cam2.next();
    expect(answer).toEqual({ type: 'signal', from: replayed.peerId, payload: { sdp: 'answer' } });
  });

  test('reclaim with wrong token → error bad-token', async () => {
    const h = boot();
    const { cam, code } = await createRoom(h.port);
    cam.ws.close();
    const cam2 = await connect(h.port);
    cam2.send({ type: 'reclaim-room', code, cameraToken: 'f'.repeat(32) });
    expect(await cam2.next()).toEqual({ type: 'error', reason: 'bad-token' });
  });

  test('reclaim while stale camera socket still attached → stale closed, no peer-left', async () => {
    const h = boot();
    const { cam, code, token } = await createRoom(h.port);
    const { viewer, viewerId: existingViewerId } = await joinRoom(h.port, code);
    await cam.next(); // peer-joined

    const cam2 = await connect(h.port);
    cam2.send({ type: 'reclaim-room', code, cameraToken: token });
    const ack = await cam2.next();
    expect(ack.type).toBe('room-created');
    expect(await cam2.next()).toEqual({ type: 'peer-joined', peerId: existingViewerId });
    expect(await viewer.next()).toEqual({ type: 'camera-back' });
    // The stale camera socket is closed by the server...
    await cam.closed();
    // ...WITHOUT orphaning the room or leaking a peer-left to viewers.
    await viewer.expectSilence();
    // The new socket owns the camera role.
    const { viewerId } = await joinRoom(h.port, code);
    expect(await cam2.next()).toEqual({ type: 'peer-joined', peerId: viewerId });
  });
});

// -- recreate after server restart ------------------------------------------

describe('recreate-room', () => {
  test('unknown code → room created with that code and a fresh token', async () => {
    const h = boot(); // fresh server: no rooms, as after a restart
    const cam = await connect(h.port);
    cam.send({ type: 'recreate-room', code: 'ABCDEFGH' });
    const msg = await cam.next();
    expect(msg.type).toBe('room-created');
    if (msg.type !== 'room-created') return;
    expect(msg.code).toBe('ABCDEFGH');
    expect(msg.cameraToken).toMatch(tokenRe);
    // Room is live and bound to this socket.
    const { viewerId } = await joinRoom(h.port, 'ABCDEFGH');
    expect(await cam.next()).toEqual({ type: 'peer-joined', peerId: viewerId });
  });

  test('existing live code → error bad-code, room untouched', async () => {
    const h = boot();
    const { code } = await createRoom(h.port);
    const hijacker = await connect(h.port);
    hijacker.send({ type: 'recreate-room', code });
    expect(await hijacker.next()).toEqual({ type: 'error', reason: 'bad-code' });
    expect((await joinRoom(h.port, code)).cameraPresent).toBe(true);
  });
});

// -- viewer leave -----------------------------------------------------------

describe('viewer disconnect', () => {
  test('viewer close → camera gets peer-left', async () => {
    const h = boot();
    const { cam, code } = await createRoom(h.port);
    const { viewer, viewerId } = await joinRoom(h.port, code);
    await cam.next(); // peer-joined
    viewer.ws.close();
    expect(await cam.next()).toEqual({ type: 'peer-left', peerId: viewerId });
  });
});

// -- stop-camera ------------------------------------------------------------

describe('stop-camera', () => {
  test('viewers get room-closed and may join another room; camera may create again', async () => {
    const h = boot();
    const room1 = await createRoom(h.port);
    const { viewer, viewerId } = await joinRoom(h.port, room1.code);
    await room1.cam.next(); // peer-joined
    const room2 = await createRoom(h.port);

    room1.cam.send({ type: 'stop-camera', code: room1.code, cameraToken: room1.token });
    expect(await viewer.next()).toEqual({ type: 'room-closed' });
    // Destroyed room's code is gone.
    const probe = await connect(h.port);
    probe.send({ type: 'join-room', code: room1.code });
    expect(await probe.next()).toEqual({ type: 'error', reason: 'bad-code' });
    // Evicted viewer's socket survived with its binding cleared: same socket
    // joins another room, keeping its peerId.
    viewer.send({ type: 'join-room', code: room2.code });
    const rejoined = await viewer.next();
    expect(rejoined).toEqual({ type: 'room-joined', peerId: viewerId, cameraPresent: true });
    expect(await room2.cam.next()).toEqual({ type: 'peer-joined', peerId: viewerId });
    // The stopping camera's binding is cleared too: it can open a new room.
    room1.cam.send({ type: 'create-room' });
    expect((await room1.cam.next()).type).toBe('room-created');
  });

  test('wrong token → error bad-token, room intact', async () => {
    const h = boot();
    const { cam, code } = await createRoom(h.port);
    cam.send({ type: 'stop-camera', code, cameraToken: 'f'.repeat(32) });
    expect(await cam.next()).toEqual({ type: 'error', reason: 'bad-token' });
    expect((await joinRoom(h.port, code)).cameraPresent).toBe(true);
  });

  test('unbound socket with valid token may stop (reconnected camera path)', async () => {
    const h = boot();
    const { cam, code, token } = await createRoom(h.port);
    const { viewer } = await joinRoom(h.port, code);
    await cam.next(); // peer-joined
    // A fresh, unbound socket holding the token — the token is the auth.
    const fresh = await connect(h.port);
    fresh.send({ type: 'stop-camera', code, cameraToken: token });
    expect(await viewer.next()).toEqual({ type: 'room-closed' });
    // Room and code are gone; the old camera binding was cleared.
    const probe = await connect(h.port);
    probe.send({ type: 'join-room', code });
    expect(await probe.next()).toEqual({ type: 'error', reason: 'bad-code' });
    cam.send({ type: 'create-room' });
    expect((await cam.next()).type).toBe('room-created');
  });

  test('from a viewer socket → error invalid even with the right token', async () => {
    const h = boot();
    const { cam, code, token } = await createRoom(h.port);
    const { viewer } = await joinRoom(h.port, code);
    await cam.next(); // peer-joined
    viewer.send({ type: 'stop-camera', code, cameraToken: token });
    expect(await viewer.next()).toEqual({ type: 'error', reason: 'invalid' });
    await cam.expectSilence();
  });
});

// -- grace expiry (sweep) ---------------------------------------------------

describe('grace expiry', () => {
  test('expired room → viewers get room-closed, code dies, bindings cleared (sweep hook)', async () => {
    let t = 1_000_000;
    const h = boot({ now: () => t });
    const { cam, code } = await createRoom(h.port);
    const { viewer } = await joinRoom(h.port, code);
    await cam.next(); // peer-joined
    cam.ws.close();
    await viewer.next(); // peer-left → room now orphaned

    t += GRACE_MS;
    h.sweep();
    expect(await viewer.next()).toEqual({ type: 'room-closed' });
    // Code is dead.
    const probe = await connect(h.port);
    probe.send({ type: 'join-room', code });
    expect(await probe.next()).toEqual({ type: 'error', reason: 'bad-code' });
    // Evicted viewer's binding is cleared: it can join a fresh room.
    const room2 = await createRoom(h.port);
    viewer.send({ type: 'join-room', code: room2.code });
    expect((await viewer.next()).type).toBe('room-joined');
  });

  test('sweep also runs on the real 1-second interval', async () => {
    let t = 1_000_000;
    const h = boot({ now: () => t });
    const { cam, code } = await createRoom(h.port);
    const { viewer } = await joinRoom(h.port, code);
    await cam.next(); // peer-joined
    cam.ws.close();
    await viewer.next(); // peer-left

    t += GRACE_MS;
    // No manual sweep: the interval must pick it up within ~SWEEP_INTERVAL_MS.
    expect(await viewer.next(SWEEP_INTERVAL_MS + 1000)).toEqual({ type: 'room-closed' });
  });
});

// -- HTTP layer -------------------------------------------------------------

describe('static file serving', () => {
  function bootWithDist(): RelayHandle {
    const dir = mkdtempSync(join(tmpdir(), 'nannycam-dist-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<h1>nannycam home</h1>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")');
    return boot({ distDir: dir });
  }

  test('/ serves index.html', async () => {
    const h = bootWithDist();
    const res = await fetch(`http://127.0.0.1:${h.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('nannycam home');
  });

  test('existing asset is served', async () => {
    const h = bootWithDist();
    const res = await fetch(`http://127.0.0.1:${h.port}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('console.log');
  });

  test('miss → 404, NOT an index.html fallback', async () => {
    const h = bootWithDist();
    const res = await fetch(`http://127.0.0.1:${h.port}/missing.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('nannycam home');
  });

  test('/healthz → ok', async () => {
    const h = boot();
    const res = await fetch(`http://127.0.0.1:${h.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  test('plain GET /ws (no upgrade) → 400', async () => {
    const h = boot();
    const res = await fetch(`http://127.0.0.1:${h.port}/ws`);
    expect(res.status).toBe(400);
  });
});
