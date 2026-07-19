// NannyCam wire protocol — single source of truth for the WS message format.
// Environment-neutral: imported by both the Bun server and the browser client.
// Only web-standard APIs (crypto.getRandomValues, TextEncoder) are used.

// -- message types ----------------------------------------------------------

// Client → Server
export type C2S =
  | { type: 'create-room' }                                        // camera, new room
  | { type: 'recreate-room'; code: string }                        // camera, after server restart
  | { type: 'reclaim-room'; code: string; cameraToken: string }    // camera, after own disconnect
  | { type: 'join-room'; code: string }                            // viewer
  | { type: 'stop-camera'; code: string; cameraToken: string }     // explicit teardown
  | { type: 'signal'; to: string; payload: unknown };              // SDP/ICE relay, opaque

// Server → Client
export type S2C =
  | { type: 'room-created'; code: string; cameraToken: string; peerId: string }
  | { type: 'room-joined'; peerId: string; cameraPresent: boolean }
  | { type: 'peer-joined'; peerId: string }        // to camera, per viewer
  | { type: 'peer-left'; peerId: string }
  | { type: 'camera-back' }                        // to viewers on re-claim/re-create
  | { type: 'room-closed' }
  | { type: 'signal'; from: string; payload: unknown }
  | { type: 'error'; reason: ErrorReason };

export type ErrorReason =
  | 'bad-code'
  | 'room-full'
  | 'rate-limited'
  | 'bad-token'
  | 'invalid';

export type Direction = 'c2s' | 's2c';

// -- validation -------------------------------------------------------------

/** Maximum accepted raw message size in bytes (UTF-8 encoded). */
export const MAX_MESSAGE_BYTES = 64 * 1024;

const ERROR_REASONS: ReadonlySet<string> = new Set([
  'bad-code',
  'room-full',
  'rate-limited',
  'bad-token',
  'invalid',
]);

type FieldCheck = (v: unknown) => boolean;

const isString: FieldCheck = (v) => typeof v === 'string';
const isBoolean: FieldCheck = (v) => typeof v === 'boolean';
const isErrorReason: FieldCheck = (v) => typeof v === 'string' && ERROR_REASONS.has(v);
// `payload` is opaque; any JSON value (including null) is fine. Presence of
// the key is enforced separately — JSON cannot encode `undefined`.
const anyJson: FieldCheck = () => true;

// Per-direction spec: message type -> required fields and their checks.
// Extra fields beyond the spec are rejected (strict relay: an otherwise-valid
// message carrying unknown fields is treated as invalid).
// Keyed against the unions so a missing, extra, or misspelled type key is a
// compile error — the table cannot drift from C2S/S2C.
const SPECS: {
  c2s: Record<C2S['type'], Record<string, FieldCheck>>;
  s2c: Record<S2C['type'], Record<string, FieldCheck>>;
} = {
  c2s: {
    'create-room': {},
    'recreate-room': { code: isString },
    'reclaim-room': { code: isString, cameraToken: isString },
    'join-room': { code: isString },
    'stop-camera': { code: isString, cameraToken: isString },
    signal: { to: isString, payload: anyJson },
  },
  s2c: {
    'room-created': { code: isString, cameraToken: isString, peerId: isString },
    'room-joined': { peerId: isString, cameraPresent: isBoolean },
    'peer-joined': { peerId: isString },
    'peer-left': { peerId: isString },
    'camera-back': {},
    'room-closed': {},
    signal: { from: isString, payload: anyJson },
    error: { reason: isErrorReason },
  },
};

const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const utf8 = new TextEncoder();

/**
 * Validate a raw wire string against the protocol for the given direction.
 * Returns the typed message, or `null` for anything invalid. Never throws —
 * hostile input must not crash the relay.
 */
export function parseMessage(raw: string, direction: 'c2s'): C2S | null;
export function parseMessage(raw: string, direction: 's2c'): S2C | null;
export function parseMessage(raw: string, direction: Direction): C2S | S2C | null;
export function parseMessage(raw: string, direction: Direction): C2S | S2C | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // Fast path: UTF-8 byte length is always >= UTF-16 code-unit length.
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  if (utf8.encode(raw).byteLength > MAX_MESSAGE_BYTES) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;

  const obj = data as Record<string, unknown>;
  if (!hasOwn(obj, 'type')) return null;
  const type = obj.type;
  if (typeof type !== 'string') return null;

  // Widened view for string-keyed lookup; the SPECS declaration above keeps
  // the table itself compile-time linked to the unions.
  const directionSpecs: Record<string, Record<string, FieldCheck>> = SPECS[direction];
  // hasOwn guard: a hostile `type` like "__proto__" or "constructor" must not
  // resolve through the spec object's prototype chain.
  if (!hasOwn(directionSpecs, type)) return null;
  const spec = directionSpecs[type]!;

  const expectedKeys = Object.keys(spec);
  for (const key of expectedKeys) {
    if (!hasOwn(obj, key)) return null;
    if (!spec[key]!(obj[key])) return null;
  }
  // Reject extra fields (strict).
  for (const key of Object.keys(obj)) {
    if (key !== 'type' && !hasOwn(spec, key)) return null;
  }

  return obj as unknown as C2S | S2C;
}

// -- generators -------------------------------------------------------------

/** Room-code alphabet: 31 unambiguous chars (no I, L, O, 0, 1). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const CODE_LENGTH = 8;

/**
 * Generate an 8-char room code from the unambiguous alphabet.
 * Uses rejection sampling over crypto.getRandomValues — no modulo bias.
 */
export function generateCode(): string {
  const n = CODE_ALPHABET.length; // 31
  // Largest multiple of n that fits in a byte; bytes >= limit are re-drawn.
  const limit = 256 - (256 % n); // 248
  let code = '';
  const buf = new Uint8Array(CODE_LENGTH * 2);
  while (code.length < CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte < limit) {
        code += CODE_ALPHABET[byte % n]!;
        if (code.length === CODE_LENGTH) break;
      }
    }
  }
  return code;
}

/** Generate a 32-char lowercase-hex camera token (128 bits of entropy). */
export function generateToken(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let token = '';
  for (const byte of buf) token += byte.toString(16).padStart(2, '0');
  return token;
}
