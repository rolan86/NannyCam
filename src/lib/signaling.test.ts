// Tests for SignalingClient — mock socket + manual timers, fully deterministic.
// One clearly-marked integration test at the bottom uses the real relay.

import { describe, expect, test } from 'bun:test';
import type { C2S, S2C } from '../../shared/protocol.ts';
import { SignalingClient, type WebSocketLike } from './signaling.ts';

// -- test doubles -----------------------------------------------------------

type Listener = (ev: { data?: unknown }) => void;

class MockSocket implements WebSocketLike {
  sent: string[] = [];
  closedByClient = false;
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
  }

  // -- test drivers (simulate the network) --
  fire(type: string, ev: { data?: unknown } = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  opens(): void {
    this.fire('open');
  }
  receives(data: unknown): void {
    this.fire('message', { data });
  }
  drops(): void {
    this.fire('close');
  }
  errors(): void {
    this.fire('error');
  }
}

class ManualTimers {
  private nextId = 1;
  private timers = new Map<number, { fn: () => void; ms: number }>();

  set = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { fn, ms });
    return id;
  };

  clear = (id: number): void => {
    this.timers.delete(id);
  };

  /** Scheduled delays, in scheduling order. */
  pendingDelays(): number[] {
    return [...this.timers.values()].map((t) => t.ms);
  }

  /** Fire the oldest pending timer. */
  fireNext(): void {
    const first = this.timers.entries().next();
    if (first.done) throw new Error('no pending timer');
    const [id, timer] = first.value;
    this.timers.delete(id);
    timer.fn();
  }
}

function makeClient() {
  const sockets: MockSocket[] = [];
  const timers = new ManualTimers();
  const statuses: string[] = [];
  const client = new SignalingClient({
    url: 'ws://test.invalid/ws',
    createSocket: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  client.onStatusChange((s) => statuses.push(s));
  return { client, sockets, timers, statuses };
}

const joinMsg: C2S = { type: 'join-room', code: 'ABCDEFGH' };
const createMsg: C2S = { type: 'create-room' };

// -- unit tests -------------------------------------------------------------

describe('SignalingClient send/queue', () => {
  test('send before open queues, flushes FIFO on open', () => {
    const { client, sockets } = makeClient();
    client.connect();
    client.send(createMsg);
    client.send(joinMsg);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toHaveLength(0);
    sockets[0]!.opens();
    expect(sockets[0]!.sent).toEqual([JSON.stringify(createMsg), JSON.stringify(joinMsg)]);
  });

  test('send while open goes straight to the socket', () => {
    const { client, sockets } = makeClient();
    client.connect();
    sockets[0]!.opens();
    client.send(joinMsg);
    expect(sockets[0]!.sent).toEqual([JSON.stringify(joinMsg)]);
  });

  test('sends queued while disconnected flush on the reconnect socket', () => {
    const { client, sockets, timers } = makeClient();
    client.connect();
    sockets[0]!.opens();
    sockets[0]!.drops();
    client.send(joinMsg);
    timers.fireNext();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sent).toHaveLength(0);
    sockets[1]!.opens();
    expect(sockets[1]!.sent).toEqual([JSON.stringify(joinMsg)]);
  });

  test('send after close() is a no-op', () => {
    const { client, sockets } = makeClient();
    client.connect();
    sockets[0]!.opens();
    client.close();
    expect(() => client.send(joinMsg)).not.toThrow();
    expect(sockets[0]!.sent).toHaveLength(0);
    // A later reconnect must not replay the dropped message either.
    client.connect();
    sockets[1]!.opens();
    expect(sockets[1]!.sent).toHaveLength(0);
  });

  test('close() clears the pending queue', () => {
    const { client, sockets } = makeClient();
    client.connect();
    client.send(joinMsg); // queued, never flushed
    client.close();
    client.connect();
    sockets[1]!.opens();
    expect(sockets[1]!.sent).toHaveLength(0);
  });
});

describe('SignalingClient inbound messages', () => {
  test('valid s2c frame reaches onMessage as a typed message', () => {
    const { client, sockets } = makeClient();
    const seen: S2C[] = [];
    client.onMessage((m) => seen.push(m));
    client.connect();
    sockets[0]!.opens();
    const frame: S2C = { type: 'room-joined', peerId: 'p1', cameraPresent: true };
    sockets[0]!.receives(JSON.stringify(frame));
    expect(seen).toEqual([frame]);
  });

  test('malformed, invalid, c2s-direction, and non-string frames are dropped silently', () => {
    const { client, sockets } = makeClient();
    const seen: S2C[] = [];
    client.onMessage((m) => seen.push(m));
    client.connect();
    sockets[0]!.opens();
    const sock = sockets[0]!;
    expect(() => {
      sock.receives('not json');
      sock.receives('{"type":"nope"}');
      sock.receives(JSON.stringify({ type: 'join-room', code: 'ABCDEFGH' })); // c2s direction
      sock.receives(JSON.stringify({ type: 'camera-back', extra: 1 })); // extra field
      sock.receives(new ArrayBuffer(4)); // binary frame
      sock.receives(undefined);
    }).not.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe('SignalingClient reconnect + backoff', () => {
  test('close schedules a reconnect at 1s', () => {
    const { client, sockets, timers } = makeClient();
    client.connect();
    sockets[0]!.opens();
    sockets[0]!.drops();
    expect(timers.pendingDelays()).toEqual([1000]);
    timers.fireNext();
    expect(sockets).toHaveLength(2);
  });

  test('repeated failures back off 1s, 2s, 4s, 8s, 16s then cap at 30s', () => {
    const { client, sockets, timers } = makeClient();
    client.connect();
    const observed: number[] = [];
    for (const _ of [0, 1, 2, 3, 4, 5, 6]) {
      sockets[sockets.length - 1]!.drops();
      const delays = timers.pendingDelays();
      expect(delays).toHaveLength(1);
      observed.push(delays[0]!);
      timers.fireNext();
    }
    expect(observed).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test('successful open resets backoff to 1s', () => {
    const { client, sockets, timers } = makeClient();
    client.connect();
    sockets[0]!.drops();
    timers.fireNext(); // 1s
    sockets[1]!.drops();
    timers.fireNext(); // 2s
    sockets[2]!.opens();
    sockets[2]!.drops();
    expect(timers.pendingDelays()).toEqual([1000]);
  });

  test('error followed by close schedules exactly one reconnect', () => {
    const { client, sockets, timers } = makeClient();
    client.connect();
    sockets[0]!.opens();
    sockets[0]!.errors();
    sockets[0]!.drops();
    expect(timers.pendingDelays()).toHaveLength(1);
  });

  test('close() during a pending reconnect cancels it', () => {
    const { client, sockets, timers } = makeClient();
    client.connect();
    sockets[0]!.drops();
    expect(timers.pendingDelays()).toHaveLength(1);
    client.close();
    expect(timers.pendingDelays()).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });

  test('close() stops reconnecting even if the socket later closes', () => {
    const { client, sockets, timers } = makeClient();
    client.connect();
    sockets[0]!.opens();
    client.close();
    expect(sockets[0]!.closedByClient).toBe(true);
    sockets[0]!.drops(); // close event arrives after intentional close
    expect(timers.pendingDelays()).toHaveLength(0);
  });

  test('connect() is idempotent', () => {
    const { client, sockets, timers } = makeClient();
    client.connect();
    client.connect();
    expect(sockets).toHaveLength(1);
    sockets[0]!.drops();
    client.connect(); // reconnect already scheduled — must not double up
    expect(sockets).toHaveLength(1);
    expect(timers.pendingDelays()).toHaveLength(1);
  });
});

describe('SignalingClient callbacks', () => {
  test('onReconnected fires on re-open, not on first open', () => {
    const { client, sockets, timers } = makeClient();
    let fired = 0;
    client.onReconnected(() => fired++);
    client.connect();
    sockets[0]!.opens();
    expect(fired).toBe(0);
    sockets[0]!.drops();
    timers.fireNext();
    sockets[1]!.opens();
    expect(fired).toBe(1);
    sockets[1]!.drops();
    timers.fireNext();
    sockets[2]!.opens();
    expect(fired).toBe(2);
  });

  test('status transitions are observable', () => {
    const { client, sockets, timers, statuses } = makeClient();
    client.connect();
    expect(statuses).toEqual(['connecting']);
    sockets[0]!.opens();
    expect(statuses).toEqual(['connecting', 'open']);
    sockets[0]!.drops();
    expect(statuses).toEqual(['connecting', 'open', 'closed']);
    timers.fireNext();
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting']);
    sockets[1]!.opens();
    client.close();
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting', 'open', 'closed']);
  });
});

// -- integration ------------------------------------------------------------

describe('SignalingClient integration (real WebSocket + real relay)', () => {
  test('connects to the relay, creates a room, receives room-created', async () => {
    const { startServer } = await import('../../server/main.ts');
    const handle = startServer({ port: 0 });
    const client = new SignalingClient({ url: `ws://localhost:${handle.port}/ws` });
    try {
      const reply = new Promise<S2C>((resolve, reject) => {
        const bail = setTimeout(() => reject(new Error('timed out waiting for room-created')), 5000);
        client.onMessage((msg) => {
          clearTimeout(bail);
          resolve(msg);
        });
      });
      client.connect();
      client.send({ type: 'create-room' }); // queued until the socket opens
      const msg = await reply;
      expect(msg.type).toBe('room-created');
      if (msg.type === 'room-created') {
        expect(msg.code).toHaveLength(8);
        expect(msg.cameraToken).toHaveLength(32);
        expect(msg.peerId.length).toBeGreaterThan(0);
      }
    } finally {
      client.close();
      handle.stop();
    }
  });
});
