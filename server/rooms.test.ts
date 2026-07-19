// Room lifecycle tests — each block mirrors a spec sentence from
// docs/superpowers/specs/2026-07-19-nannycam-design.md.
//
// RoomManager is pure logic with an injected clock; time only moves when the
// test advances it, and grace expiry only happens when sweep() is called
// (the real server calls sweep on a short interval).

import { describe, expect, test } from 'bun:test';
import { CODE_ALPHABET, CODE_LENGTH } from '../shared/protocol.ts';
import {
  GRACE_MS,
  MAX_VIEWERS,
  RATE_LIMIT_MAX_FAILURES,
  RATE_LIMIT_WINDOW_MS,
  RoomManager,
} from './rooms.ts';

/** RoomManager with a controllable clock. */
function setup(start = 1_000_000) {
  let t = start;
  const rm = new RoomManager(() => t);
  return {
    rm,
    advance(ms: number) {
      t += ms;
    },
  };
}

const codeRe = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
const tokenRe = /^[0-9a-f]{32}$/;

describe('constants', () => {
  test('grace period is 10 minutes, viewer cap is 3', () => {
    expect(GRACE_MS).toBe(10 * 60 * 1000);
    expect(MAX_VIEWERS).toBe(3);
  });
});

describe('createRoom', () => {
  test('returns a well-formed code and camera token; camera present', () => {
    const { rm } = setup();
    const { code, cameraToken } = rm.createRoom();
    expect(code).toMatch(codeRe);
    expect(cameraToken).toMatch(tokenRe);
    expect(rm.hasRoom(code)).toBe(true);
    expect(rm.cameraPresent(code)).toBe(true);
    expect(rm.isOrphaned(code)).toBe(false);
    expect(rm.viewers(code)).toEqual([]);
  });

  test('codes are unique across many rooms', () => {
    const { rm } = setup();
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) codes.add(rm.createRoom().code);
    expect(codes.size).toBe(50);
  });
});

describe('joinRoom', () => {
  test('viewer joins a live room and is listed', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    const res = rm.joinRoom(code, 'v1', 'conn-1');
    expect(res).toEqual({ ok: true, cameraPresent: true });
    expect(rm.viewers(code)).toEqual(['v1']);
  });

  test('unknown code → bad-code', () => {
    const { rm } = setup();
    expect(rm.joinRoom('ZZZZZZZZ', 'v1', 'conn-1')).toEqual({
      ok: false,
      reason: 'bad-code',
    });
  });

  test('hard cap 3 viewers: 4th join → room-full', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    for (let i = 1; i <= MAX_VIEWERS; i++) {
      expect(rm.joinRoom(code, `v${i}`, `conn-${i}`)).toEqual({
        ok: true,
        cameraPresent: true,
      });
    }
    expect(rm.joinRoom(code, 'v4', 'conn-4')).toEqual({
      ok: false,
      reason: 'room-full',
    });
    expect(rm.viewers(code)).toEqual(['v1', 'v2', 'v3']);
  });

  test('a viewer slot frees up when a viewer leaves', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    rm.joinRoom(code, 'v1', 'conn-1');
    rm.joinRoom(code, 'v2', 'conn-2');
    rm.joinRoom(code, 'v3', 'conn-3');
    expect(rm.viewerLeft(code, 'v2')).toBe(true);
    expect(rm.viewers(code)).toEqual(['v1', 'v3']);
    expect(rm.joinRoom(code, 'v4', 'conn-4')).toEqual({
      ok: true,
      cameraPresent: true,
    });
  });

  test('viewerLeft on unknown room or viewer → false, no throw', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    expect(rm.viewerLeft('ZZZZZZZZ', 'v1')).toBe(false);
    expect(rm.viewerLeft(code, 'ghost')).toBe(false);
  });

  test('new viewers MAY join an orphaned room (they see the DOWN state)', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    rm.cameraDisconnected(code);
    const res = rm.joinRoom(code, 'v1', 'conn-1');
    expect(res).toEqual({ ok: true, cameraPresent: false });
    expect(rm.viewers(code)).toEqual(['v1']);
  });
});

describe('spec: camera disconnect does NOT kill the room — orphaned grace state', () => {
  test('cameraDisconnected → orphaned; viewers stay joined', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    rm.joinRoom(code, 'v1', 'conn-1');
    rm.joinRoom(code, 'v2', 'conn-2');

    rm.cameraDisconnected(code);

    expect(rm.hasRoom(code)).toBe(true);
    expect(rm.isOrphaned(code)).toBe(true);
    expect(rm.cameraPresent(code)).toBe(false);
    expect(rm.viewers(code)).toEqual(['v1', 'v2']);
  });

  test('cameraDisconnected on unknown room is a no-op', () => {
    const { rm } = setup();
    expect(() => rm.cameraDisconnected('ZZZZZZZZ')).not.toThrow();
  });
});

describe('spec: camera re-claims its room by presenting code + camera token', () => {
  test('reclaim within 10 min → camera present again, orphan cleared, viewers untouched', () => {
    const { rm, advance } = setup();
    const { code, cameraToken } = rm.createRoom();
    rm.joinRoom(code, 'v1', 'conn-1');
    rm.cameraDisconnected(code);
    advance(GRACE_MS - 1);

    expect(rm.reclaimRoom(code, cameraToken)).toEqual({ ok: true });
    expect(rm.cameraPresent(code)).toBe(true);
    expect(rm.isOrphaned(code)).toBe(false);
    expect(rm.viewers(code)).toEqual(['v1']);
  });

  test('reclaim cancels the grace timer: room survives past 10 min after reclaim', () => {
    const { rm, advance } = setup();
    const { code, cameraToken } = rm.createRoom();
    rm.cameraDisconnected(code);
    advance(GRACE_MS - 1);
    rm.reclaimRoom(code, cameraToken);

    advance(GRACE_MS * 2);
    expect(rm.sweep()).toEqual([]);
    expect(rm.hasRoom(code)).toBe(true);
  });

  test('wrong token → bad-token; room stays orphaned', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    rm.cameraDisconnected(code);

    expect(rm.reclaimRoom(code, 'deadbeefdeadbeefdeadbeefdeadbeef')).toEqual({
      ok: false,
      reason: 'bad-token',
    });
    expect(rm.isOrphaned(code)).toBe(true);
  });

  test('unknown code → bad-code', () => {
    const { rm } = setup();
    expect(rm.reclaimRoom('ZZZZZZZZ', 'deadbeefdeadbeefdeadbeefdeadbeef')).toEqual({
      ok: false,
      reason: 'bad-code',
    });
  });
});

describe('spec: grace-period expiry destroys the room and its code', () => {
  test('sweep before expiry destroys nothing', () => {
    const { rm, advance } = setup();
    const { code } = rm.createRoom();
    rm.cameraDisconnected(code);
    advance(GRACE_MS - 1);

    expect(rm.sweep()).toEqual([]);
    expect(rm.hasRoom(code)).toBe(true);
  });

  test('advance 10 min + sweep → room destroyed; joinRoom now bad-code', () => {
    const { rm, advance } = setup();
    const { code } = rm.createRoom();
    rm.joinRoom(code, 'v1', 'conn-1');
    rm.cameraDisconnected(code);
    advance(GRACE_MS);

    expect(rm.sweep()).toEqual([code]);
    expect(rm.hasRoom(code)).toBe(false);
    expect(rm.joinRoom(code, 'v2', 'conn-2')).toEqual({
      ok: false,
      reason: 'bad-code',
    });
  });

  test('sweep only destroys orphaned rooms whose grace expired', () => {
    const { rm, advance } = setup();
    const live = rm.createRoom().code;
    const orphanFresh = rm.createRoom().code;
    const orphanStale = rm.createRoom().code;

    rm.cameraDisconnected(orphanStale);
    advance(GRACE_MS);
    rm.cameraDisconnected(orphanFresh); // just orphaned, grace not expired

    expect(rm.sweep()).toEqual([orphanStale]);
    expect(rm.hasRoom(live)).toBe(true);
    expect(rm.hasRoom(orphanFresh)).toBe(true);
    expect(rm.hasRoom(orphanStale)).toBe(false);
  });

  test('reclaim after expiry + sweep → bad-code', () => {
    const { rm, advance } = setup();
    const { code, cameraToken } = rm.createRoom();
    rm.cameraDisconnected(code);
    advance(GRACE_MS);
    rm.sweep();

    expect(rm.reclaimRoom(code, cameraToken)).toEqual({
      ok: false,
      reason: 'bad-code',
    });
  });
});

describe('spec: only an explicit "Stop camera" action destroys the room immediately', () => {
  test('stopCamera with the right token → immediate destroy, even with viewers', () => {
    const { rm } = setup();
    const { code, cameraToken } = rm.createRoom();
    rm.joinRoom(code, 'v1', 'conn-1');

    expect(rm.stopCamera(code, cameraToken)).toEqual({ ok: true });
    expect(rm.hasRoom(code)).toBe(false);
    expect(rm.joinRoom(code, 'v2', 'conn-2')).toEqual({
      ok: false,
      reason: 'bad-code',
    });
  });

  test('wrong token → bad-token; room survives', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    expect(rm.stopCamera(code, 'deadbeefdeadbeefdeadbeefdeadbeef')).toEqual({
      ok: false,
      reason: 'bad-token',
    });
    expect(rm.hasRoom(code)).toBe(true);
  });

  test('unknown code → bad-code', () => {
    const { rm } = setup();
    expect(rm.stopCamera('ZZZZZZZZ', 'deadbeefdeadbeefdeadbeefdeadbeef')).toEqual({
      ok: false,
      reason: 'bad-code',
    });
  });
});

describe('spec: after a restart, a camera may re-create a room with its previous code', () => {
  test('recreateRoom when room does not exist → new room, fresh token', () => {
    const { rm } = setup();
    // Simulate "previously issued code" from before a restart.
    const code = 'ABCDEFGH';
    const res = rm.recreateRoom(code);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.cameraToken).toMatch(tokenRe);
    expect(rm.hasRoom(code)).toBe(true);
    expect(rm.cameraPresent(code)).toBe(true);
    expect(rm.isOrphaned(code)).toBe(false);
  });

  test('recreateRoom issues a token different from the one issued before', () => {
    const { rm } = setup();
    const a = new RoomManager(() => 0);
    const { code, cameraToken: oldToken } = a.createRoom(); // "before restart"
    const res = rm.recreateRoom(code); // fresh manager = restarted server
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.cameraToken).not.toBe(oldToken);
  });

  test('recreateRoom when the room exists (live) → bad-code: cannot hijack', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    expect(rm.recreateRoom(code)).toEqual({ ok: false, reason: 'bad-code' });
  });

  test('recreateRoom when the room exists (orphaned, in grace) → bad-code', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    rm.cameraDisconnected(code);
    // During grace only the token holder may take the room back.
    expect(rm.recreateRoom(code)).toEqual({ ok: false, reason: 'bad-code' });
    expect(rm.isOrphaned(code)).toBe(true);
  });

  test('malformed code → bad-code (the code\'s entropy is the authentication)', () => {
    const { rm } = setup();
    expect(rm.recreateRoom('short')).toEqual({ ok: false, reason: 'bad-code' });
    expect(rm.recreateRoom('abcdefgh')).toEqual({ ok: false, reason: 'bad-code' }); // lowercase not in alphabet
    expect(rm.recreateRoom('ABCDEFG0')).toEqual({ ok: false, reason: 'bad-code' }); // 0 not in alphabet
    expect(rm.recreateRoom('')).toEqual({ ok: false, reason: 'bad-code' });
  });
});

describe('edge: camera that lost its token cannot reclaim; must wait out grace then recreate', () => {
  test('full sequence: bad-token → recreate blocked during grace → expiry → recreate with fresh token', () => {
    const { rm, advance } = setup();
    const { code, cameraToken } = rm.createRoom();
    rm.joinRoom(code, 'v1', 'conn-1');
    rm.cameraDisconnected(code);

    // Lost token: reclaim fails.
    expect(rm.reclaimRoom(code, 'deadbeefdeadbeefdeadbeefdeadbeef')).toEqual({
      ok: false,
      reason: 'bad-token',
    });
    // Cannot shortcut via recreate while the room still exists.
    expect(rm.recreateRoom(code)).toEqual({ ok: false, reason: 'bad-code' });

    // Wait out the grace period.
    advance(GRACE_MS);
    expect(rm.sweep()).toEqual([code]);

    // Now recreation succeeds with a FRESH token.
    const res = rm.recreateRoom(code);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.cameraToken).not.toBe(cameraToken);
    expect(rm.cameraPresent(code)).toBe(true);
    // Old viewers were dropped with the destroyed room; new joins work.
    expect(rm.viewers(code)).toEqual([]);
    expect(rm.joinRoom(code, 'v2', 'conn-2')).toEqual({
      ok: true,
      cameraPresent: true,
    });
  });
});

describe('rate limiting: failed joins per connection id (sliding 60 s window)', () => {
  test('more than 10 failed joins within 60 s → rate-limited', () => {
    const { rm } = setup();
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i++) {
      expect(rm.joinRoom('ZZZZZZZZ', `v${i}`, 'conn-1')).toEqual({
        ok: false,
        reason: 'bad-code',
      });
    }
    expect(rm.joinRoom('ZZZZZZZZ', 'vX', 'conn-1')).toEqual({
      ok: false,
      reason: 'rate-limited',
    });
  });

  test('a rate-limited connection cannot join even with a valid code', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i++) {
      rm.joinRoom('ZZZZZZZZ', `v${i}`, 'conn-1');
    }
    expect(rm.joinRoom(code, 'vX', 'conn-1')).toEqual({
      ok: false,
      reason: 'rate-limited',
    });
    expect(rm.viewers(code)).toEqual([]);
  });

  test('limit is per connection id: other connections are unaffected', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES + 1; i++) {
      rm.joinRoom('ZZZZZZZZ', `v${i}`, 'conn-1');
    }
    expect(rm.joinRoom(code, 'vY', 'conn-2')).toEqual({
      ok: true,
      cameraPresent: true,
    });
  });

  test('window slides: after 60 s the connection may try again', () => {
    const { rm, advance } = setup();
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES + 1; i++) {
      rm.joinRoom('ZZZZZZZZ', `v${i}`, 'conn-1');
    }
    advance(RATE_LIMIT_WINDOW_MS);
    expect(rm.joinRoom('ZZZZZZZZ', 'vX', 'conn-1')).toEqual({
      ok: false,
      reason: 'bad-code',
    });
  });

  test('successful joins are not counted as failures', () => {
    const { rm } = setup();
    const { code } = rm.createRoom();
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i++) {
      const res = rm.joinRoom(code, `v${i}`, 'conn-1');
      expect(res.ok).toBe(true);
      rm.viewerLeft(code, `v${i}`);
    }
    // Still not rate-limited after 10 successes.
    expect(rm.joinRoom(code, 'vX', 'conn-1')).toEqual({
      ok: true,
      cameraPresent: true,
    });
  });

  test('sweep prunes stale limiter state so it does not grow unboundedly', () => {
    const { rm, advance } = setup();
    for (let c = 0; c < 5; c++) {
      rm.joinRoom('ZZZZZZZZ', 'v', `conn-${c}`);
    }
    expect(rm.trackedConnections()).toBe(5);
    advance(RATE_LIMIT_WINDOW_MS);
    rm.sweep();
    expect(rm.trackedConnections()).toBe(0);
  });
});
