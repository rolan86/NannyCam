import { describe, expect, test } from 'bun:test';
import {
  CODE_ALPHABET,
  MAX_MESSAGE_BYTES,
  generateCode,
  generateToken,
  parseMessage,
} from './protocol.ts';

// -- helpers ----------------------------------------------------------------

const j = (v: unknown) => JSON.stringify(v);

// -- valid c2s messages -----------------------------------------------------

describe('parseMessage c2s accepts valid messages', () => {
  test('create-room', () => {
    expect(parseMessage(j({ type: 'create-room' }), 'c2s')).toEqual({
      type: 'create-room',
    });
  });

  test('recreate-room', () => {
    expect(
      parseMessage(j({ type: 'recreate-room', code: 'ABCD2345' }), 'c2s'),
    ).toEqual({ type: 'recreate-room', code: 'ABCD2345' });
  });

  test('reclaim-room', () => {
    expect(
      parseMessage(
        j({ type: 'reclaim-room', code: 'ABCD2345', cameraToken: 'deadbeef' }),
        'c2s',
      ),
    ).toEqual({ type: 'reclaim-room', code: 'ABCD2345', cameraToken: 'deadbeef' });
  });

  test('join-room', () => {
    expect(parseMessage(j({ type: 'join-room', code: 'ABCD2345' }), 'c2s')).toEqual(
      { type: 'join-room', code: 'ABCD2345' },
    );
  });

  test('stop-camera', () => {
    expect(
      parseMessage(
        j({ type: 'stop-camera', code: 'ABCD2345', cameraToken: 'deadbeef' }),
        'c2s',
      ),
    ).toEqual({ type: 'stop-camera', code: 'ABCD2345', cameraToken: 'deadbeef' });
  });

  test('signal with object payload', () => {
    expect(
      parseMessage(
        j({ type: 'signal', to: 'peer-1', payload: { sdp: 'v=0' } }),
        'c2s',
      ),
    ).toEqual({ type: 'signal', to: 'peer-1', payload: { sdp: 'v=0' } });
  });

  test('signal payload may be null', () => {
    expect(
      parseMessage(j({ type: 'signal', to: 'peer-1', payload: null }), 'c2s'),
    ).toEqual({ type: 'signal', to: 'peer-1', payload: null });
  });

  test('signal payload may be a primitive', () => {
    expect(
      parseMessage(j({ type: 'signal', to: 'peer-1', payload: 42 }), 'c2s'),
    ).toEqual({ type: 'signal', to: 'peer-1', payload: 42 });
  });
});

// -- valid s2c messages -----------------------------------------------------

describe('parseMessage s2c accepts valid messages', () => {
  test('room-created', () => {
    expect(
      parseMessage(
        j({
          type: 'room-created',
          code: 'ABCD2345',
          cameraToken: 'deadbeef',
          peerId: 'p1',
        }),
        's2c',
      ),
    ).toEqual({
      type: 'room-created',
      code: 'ABCD2345',
      cameraToken: 'deadbeef',
      peerId: 'p1',
    });
  });

  test('room-joined', () => {
    expect(
      parseMessage(
        j({ type: 'room-joined', peerId: 'p1', cameraPresent: true }),
        's2c',
      ),
    ).toEqual({ type: 'room-joined', peerId: 'p1', cameraPresent: true });
  });

  test('peer-joined', () => {
    expect(parseMessage(j({ type: 'peer-joined', peerId: 'p2' }), 's2c')).toEqual({
      type: 'peer-joined',
      peerId: 'p2',
    });
  });

  test('peer-left', () => {
    expect(parseMessage(j({ type: 'peer-left', peerId: 'p2' }), 's2c')).toEqual({
      type: 'peer-left',
      peerId: 'p2',
    });
  });

  test('camera-back', () => {
    expect(parseMessage(j({ type: 'camera-back' }), 's2c')).toEqual({
      type: 'camera-back',
    });
  });

  test('room-closed', () => {
    expect(parseMessage(j({ type: 'room-closed' }), 's2c')).toEqual({
      type: 'room-closed',
    });
  });

  test('signal with from', () => {
    expect(
      parseMessage(
        j({ type: 'signal', from: 'p1', payload: { candidate: 'c' } }),
        's2c',
      ),
    ).toEqual({ type: 'signal', from: 'p1', payload: { candidate: 'c' } });
  });

  test('error with each allowed reason', () => {
    for (const reason of [
      'bad-code',
      'room-full',
      'rate-limited',
      'bad-token',
      'invalid',
    ]) {
      expect(parseMessage(j({ type: 'error', reason }), 's2c')).toEqual({
        type: 'error',
        reason,
      } as never);
    }
  });
});

// -- rejection: malformed input ---------------------------------------------

describe('parseMessage rejects malformed input', () => {
  test('non-JSON', () => {
    expect(parseMessage('not json {', 'c2s')).toBeNull();
    expect(parseMessage('not json {', 's2c')).toBeNull();
  });

  test('empty string', () => {
    expect(parseMessage('', 'c2s')).toBeNull();
    expect(parseMessage('', 's2c')).toBeNull();
  });

  test('JSON but not an object', () => {
    for (const raw of ['42', '"signal"', 'null', 'true', '[]', '[{"type":"create-room"}]']) {
      expect(parseMessage(raw, 'c2s')).toBeNull();
      expect(parseMessage(raw, 's2c')).toBeNull();
    }
  });

  test('unknown type', () => {
    expect(parseMessage(j({ type: 'destroy-all' }), 'c2s')).toBeNull();
    expect(parseMessage(j({ type: 'destroy-all' }), 's2c')).toBeNull();
  });

  test('missing type', () => {
    expect(parseMessage(j({ code: 'ABCD2345' }), 'c2s')).toBeNull();
  });

  test('non-string type', () => {
    expect(parseMessage(j({ type: 42 }), 'c2s')).toBeNull();
    expect(parseMessage(j({ type: null }), 's2c')).toBeNull();
  });
});

// -- rejection: missing / wrong-typed fields --------------------------------

describe('parseMessage rejects missing or wrong-typed fields', () => {
  test('join-room missing code', () => {
    expect(parseMessage(j({ type: 'join-room' }), 'c2s')).toBeNull();
  });

  test('join-room with non-string code', () => {
    expect(parseMessage(j({ type: 'join-room', code: 12345678 }), 'c2s')).toBeNull();
    expect(parseMessage(j({ type: 'join-room', code: null }), 'c2s')).toBeNull();
  });

  test('reclaim-room missing cameraToken', () => {
    expect(
      parseMessage(j({ type: 'reclaim-room', code: 'ABCD2345' }), 'c2s'),
    ).toBeNull();
  });

  test('signal missing payload', () => {
    expect(parseMessage(j({ type: 'signal', to: 'p1' }), 'c2s')).toBeNull();
    expect(parseMessage(j({ type: 'signal', from: 'p1' }), 's2c')).toBeNull();
  });

  test('signal with non-string to', () => {
    expect(
      parseMessage(j({ type: 'signal', to: 7, payload: {} }), 'c2s'),
    ).toBeNull();
  });

  test('room-created missing cameraToken', () => {
    expect(
      parseMessage(j({ type: 'room-created', code: 'ABCD2345', peerId: 'p1' }), 's2c'),
    ).toBeNull();
  });

  test('room-joined with non-boolean cameraPresent', () => {
    expect(
      parseMessage(
        j({ type: 'room-joined', peerId: 'p1', cameraPresent: 'yes' }),
        's2c',
      ),
    ).toBeNull();
  });

  test('error with unknown reason', () => {
    expect(parseMessage(j({ type: 'error', reason: 'kaboom' }), 's2c')).toBeNull();
    expect(parseMessage(j({ type: 'error', reason: 7 }), 's2c')).toBeNull();
  });
});

// -- rejection: direction awareness -----------------------------------------

describe('parseMessage is direction-aware', () => {
  test('c2s-only messages rejected as s2c', () => {
    expect(parseMessage(j({ type: 'create-room' }), 's2c')).toBeNull();
    expect(parseMessage(j({ type: 'join-room', code: 'ABCD2345' }), 's2c')).toBeNull();
  });

  test('s2c-only messages rejected as c2s', () => {
    expect(parseMessage(j({ type: 'room-closed' }), 'c2s')).toBeNull();
    expect(parseMessage(j({ type: 'error', reason: 'invalid' }), 'c2s')).toBeNull();
  });

  test('signal fields are direction-specific', () => {
    // c2s signal carries `to`; a `from` signal is not valid c2s
    expect(
      parseMessage(j({ type: 'signal', from: 'p1', payload: {} }), 'c2s'),
    ).toBeNull();
    // s2c signal carries `from`; a `to` signal is not valid s2c
    expect(
      parseMessage(j({ type: 'signal', to: 'p1', payload: {} }), 's2c'),
    ).toBeNull();
  });
});

// -- rejection: strictness --------------------------------------------------

describe('parseMessage is strict about extra fields', () => {
  test('extra unknown fields on otherwise-valid message are rejected', () => {
    expect(
      parseMessage(j({ type: 'create-room', extra: 1 }), 'c2s'),
    ).toBeNull();
    expect(
      parseMessage(j({ type: 'join-room', code: 'ABCD2345', admin: true }), 'c2s'),
    ).toBeNull();
    expect(
      parseMessage(j({ type: 'room-closed', because: 'reasons' }), 's2c'),
    ).toBeNull();
  });
});

// -- rejection: oversized payloads ------------------------------------------

describe('parseMessage enforces the 64 KB limit', () => {
  test('raw input over 64 KB is rejected', () => {
    const big = j({
      type: 'signal',
      to: 'p1',
      payload: 'x'.repeat(64 * 1024 + 1),
    });
    expect(big.length).toBeGreaterThan(64 * 1024);
    expect(parseMessage(big, 'c2s')).toBeNull();
  });

  test('multi-byte characters count by encoded size, not string length', () => {
    // 30000 three-byte chars -> ~90 KB encoded but only 30000 UTF-16 units
    const big = j({ type: 'signal', to: 'p1', payload: '€'.repeat(30000) });
    expect(big.length).toBeLessThan(64 * 1024);
    expect(parseMessage(big, 'c2s')).toBeNull();
  });

  test('message of exactly MAX_MESSAGE_BYTES bytes is accepted', () => {
    const overhead = j({ type: 'signal', to: 'p1', payload: '' }).length;
    const payload = 'x'.repeat(MAX_MESSAGE_BYTES - overhead);
    const raw = j({ type: 'signal', to: 'p1', payload });
    expect(raw.length).toBe(MAX_MESSAGE_BYTES);
    expect(new TextEncoder().encode(raw).byteLength).toBe(MAX_MESSAGE_BYTES);
    expect(parseMessage(raw, 'c2s')).toEqual({ type: 'signal', to: 'p1', payload });
  });

  test('large-but-under-limit message is accepted', () => {
    const payload = 'x'.repeat(60 * 1024);
    const raw = j({ type: 'signal', to: 'p1', payload });
    expect(raw.length).toBeLessThanOrEqual(64 * 1024);
    expect(parseMessage(raw, 'c2s')).toEqual({ type: 'signal', to: 'p1', payload });
  });
});

// -- hostile input ----------------------------------------------------------

describe('parseMessage never throws on hostile input', () => {
  test('non-string raw input returns null instead of throwing', () => {
    expect(parseMessage(undefined as never, 'c2s')).toBeNull();
    expect(parseMessage(null as never, 's2c')).toBeNull();
    expect(parseMessage(42 as never, 'c2s')).toBeNull();
  });

  test('prototype-pollution-style type', () => {
    expect(parseMessage(j({ type: '__proto__' }), 'c2s')).toBeNull();
    expect(parseMessage(j({ type: 'constructor' }), 'c2s')).toBeNull();
    expect(parseMessage(j({ type: 'hasOwnProperty' }), 's2c')).toBeNull();
  });

  test('__proto__ key does not pollute and is rejected as extra field', () => {
    const raw = '{"type":"create-room","__proto__":{"polluted":true}}';
    expect(parseMessage(raw, 'c2s')).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('deeply nested JSON does not throw', () => {
    const raw = '['.repeat(5000) + ']'.repeat(5000);
    expect(parseMessage(raw, 'c2s')).toBeNull();
  });
});

// -- generators -------------------------------------------------------------

describe('generateCode', () => {
  test('returns 8 chars from the unambiguous alphabet', () => {
    expect(CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789');
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  test('never contains ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCode()).not.toMatch(/[ILO01]/);
    }
  });

  test('codes are random (no duplicates across 100 draws)', () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateCode()));
    expect(codes.size).toBe(100);
  });
});

describe('generateToken', () => {
  test('returns 32 lowercase hex chars', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateToken()).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  test('tokens are random (no duplicates across 100 draws)', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(tokens.size).toBe(100);
  });
});
