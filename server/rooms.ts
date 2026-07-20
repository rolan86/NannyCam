// Room lifecycle state machine — encodes the spec's room-lifecycle policy.
//
// Pure logic: no I/O, no timers, no Date.now(). The clock is injected
// (`now: () => number`, milliseconds) and grace expiry happens only inside
// sweep(), which the server must call on a short interval. sweep() returns
// each destroyed room's code plus a snapshot of its viewer ids so the caller
// can broadcast room-closed without a destroy-then-enumerate ordering trap.
//
// Spec (docs/superpowers/specs/2026-07-19-nannycam-design.md):
// - Camera disconnect does NOT kill the room — it enters an orphaned grace
//   state (GRACE_MS = 10 minutes) during which viewers stay joined, and new
//   viewers may still join (they see the DOWN state).
// - The camera re-claims its room with code + camera token. Only an explicit
//   "Stop camera" — or grace expiry — destroys the room and its code.
// - After a server restart no rooms exist; a camera may re-create a room with
//   its previously issued code. The code's entropy is the authentication for
//   that path, and a FRESH camera token is issued. Recreation is refused while
//   a room with that code exists (live or in grace) — no hijacking.
// - Hard cap of MAX_VIEWERS viewers, server-enforced.
//
// Rate limiting: per connection id, sliding 60-second window over FAILED
// join, recreate, reclaim, and stop-camera attempts (bad-code, bad-token,
// and room-full all count; successes never count). recreate/reclaim/
// stop-camera share the limiter because each one's failure reveals room
// existence (and, for reclaim/stop-camera, is also a token-guessing attempt)
// — unthrottled, any of them would be a room-existence oracle. Once
// RATE_LIMIT_MAX_FAILURES failures sit inside the window,
// further attempts from that connection get 'rate-limited'. Rate-limited
// responses themselves are not recorded, so retrying while limited does not
// extend the window. Limiter state is pruned lazily on each check and
// globally in sweep().

import { timingSafeEqual } from 'node:crypto';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  generateCode,
  generateToken,
  type ErrorReason,
} from '../shared/protocol.ts';

export const GRACE_MS = 10 * 60 * 1000;
export const MAX_VIEWERS = 3;
export const RATE_LIMIT_MAX_FAILURES = 10;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
/**
 * Task 14: global cap on simultaneously live-or-orphaned rooms — a second
 * belt-and-suspenders limit on top of one-room-per-socket (server/main.ts),
 * which only bounds hostile room-minting by CONNECTION count, not by total
 * server memory. Reusing the 'invalid' reason rather than adding an eighth
 * ErrorReason variant: a dedicated reason (e.g. 'server-full') would widen
 * the wire protocol for a condition that should essentially never fire in
 * normal operation (100 concurrent rooms on a tailnet-scale deployment), and
 * the client has no different recovery to offer either way.
 */
export const MAX_ROOMS = 100;

export type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: ErrorReason };

interface Room {
  code: string;
  cameraToken: string;
  cameraPresent: boolean;
  /** Clock time when the camera disconnected; null while the camera is present. */
  orphanedAt: number | null;
  /** viewerId -> connectionId (insertion-ordered). */
  viewers: Map<string, string>;
}

const CODE_CHARS: ReadonlySet<string> = new Set(CODE_ALPHABET);

function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_CHARS.has(ch)) return false;
  return true;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** connectionId -> timestamps of failed join attempts (oldest first). */
  private readonly failedJoins = new Map<string, number[]>();

  constructor(private readonly now: () => number) {}

  /**
   * Camera opens a brand-new room. Codes are unique among live rooms.
   * Refused once MAX_ROOMS rooms are live-or-orphaned (see its doc) — the
   * server-side caller (server/main.ts) already refuses a second room per
   * socket, so this is the global backstop, not the primary defense.
   */
  createRoom(): Result<{ code: string; cameraToken: string }> {
    if (this.rooms.size >= MAX_ROOMS) return { ok: false, reason: 'invalid' };
    let code = generateCode();
    while (this.rooms.has(code)) code = generateCode(); // collision: re-draw
    const cameraToken = generateToken();
    this.rooms.set(code, {
      code,
      cameraToken,
      cameraPresent: true,
      orphanedAt: null,
      viewers: new Map(),
    });
    return { ok: true, code, cameraToken };
  }

  /**
   * Camera re-creates a room after a server restart, presenting its
   * previously issued code. Refused while any room with that code exists
   * (live or orphaned-in-grace) — a live room cannot be hijacked. Issues a
   * FRESH camera token; the code's entropy is the authentication. Failed
   * attempts count toward the same per-connection rate limit as joins —
   * otherwise this path would be an unthrottled room-existence oracle.
   */
  recreateRoom(code: string, connectionId: string): Result<{ cameraToken: string }> {
    if (this.isRateLimited(connectionId)) {
      return { ok: false, reason: 'rate-limited' };
    }
    // Cap check BEFORE code validity/existence: at capacity every recreate
    // is refused the same way regardless of the code presented, so a
    // full server leaks nothing about whether any particular code exists
    // (same room-existence-oracle concern the rate limiter itself guards).
    // Deliberately NOT routed through recordFailure — this is a capacity
    // condition, not a guessing attempt, and must not tighten the caller's
    // rate-limit window for a class of failure entirely outside its control.
    if (this.rooms.size >= MAX_ROOMS) return { ok: false, reason: 'invalid' };
    if (!isValidCode(code) || this.rooms.has(code)) {
      return this.recordFailure(connectionId, 'bad-code');
    }
    const cameraToken = generateToken();
    this.rooms.set(code, {
      code,
      cameraToken,
      cameraPresent: true,
      orphanedAt: null,
      viewers: new Map(),
    });
    return { ok: true, cameraToken };
  }

  /**
   * Viewer joins. `viewerId` and `connectionId` are caller-supplied (the
   * server owns peer-id generation). Failed attempts count toward the
   * per-connection rate limit.
   */
  joinRoom(code: string, viewerId: string, connectionId: string): Result<{ cameraPresent: boolean }> {
    if (this.isRateLimited(connectionId)) {
      return { ok: false, reason: 'rate-limited' };
    }
    const room = this.rooms.get(code);
    if (!room) return this.recordFailure(connectionId, 'bad-code');
    if (room.viewers.size >= MAX_VIEWERS) return this.recordFailure(connectionId, 'room-full');
    room.viewers.set(viewerId, connectionId);
    return { ok: true, cameraPresent: room.cameraPresent };
  }

  /** Viewer disconnected or left. Returns whether the viewer was removed. */
  viewerLeft(code: string, viewerId: string): boolean {
    return this.rooms.get(code)?.viewers.delete(viewerId) ?? false;
  }

  /**
   * Camera's connection dropped. The room enters the orphaned grace state;
   * viewers stay joined. No-op for unknown or already-orphaned rooms.
   */
  cameraDisconnected(code: string): void {
    const room = this.rooms.get(code);
    if (!room || room.orphanedAt !== null) return;
    room.cameraPresent = false;
    room.orphanedAt = this.now();
  }

  /**
   * Camera re-claims its room with code + token. On success the camera is
   * present again, the orphan state is cleared and the grace timer cancelled;
   * viewers are untouched. Allowed even while the camera is still marked
   * present (its disconnect may not have been observed yet); the server
   * replaces the stale camera socket (Task 4).
   *
   * Task 14: failed attempts (bad-code AND bad-token) share the same
   * per-connection rate limit as join/recreate. Before this, reclaim was an
   * unthrottled oracle for two things an attacker could otherwise only
   * guess at a limited rate: room existence (bad-code) AND, for a room known
   * to exist, the camera token itself (bad-token) — a 128-bit token is safe
   * against brute force only because guesses cost something. Successes are
   * never recorded, same convention as joinRoom/recreateRoom.
   */
  reclaimRoom(code: string, cameraToken: string, connectionId: string): Result {
    if (this.isRateLimited(connectionId)) {
      return { ok: false, reason: 'rate-limited' };
    }
    const room = this.rooms.get(code);
    if (!room) return this.recordFailure(connectionId, 'bad-code');
    if (!this.tokenMatches(room, cameraToken)) {
      return this.recordFailure(connectionId, 'bad-token');
    }
    room.cameraPresent = true;
    room.orphanedAt = null;
    return { ok: true };
  }

  /**
   * Explicit "Stop camera": immediate destroy of the room and its code.
   * The ok payload carries the evicted viewer ids so the server can
   * broadcast room-closed to them.
   *
   * Review fix (post-Task 14): shares the same per-connection rate limiter
   * as join/recreate/reclaim. stopCamera has the identical two-outcome
   * shape as reclaimRoom (bad-code vs bad-token) — an unbound socket calling
   * stop-camera with guessed codes could otherwise enumerate which room
   * codes are live by reading the error reason, exactly the room-existence
   * + token-guessing oracle reclaimRoom's doc warns about. Failed attempts
   * (bad-code AND bad-token) are recorded; the rate limiter, not collapsing
   * the two reasons into one, is what closes the oracle. Successes are
   * never recorded, same convention as the other three methods.
   */
  stopCamera(code: string, cameraToken: string, connectionId: string): Result<{ viewers: string[] }> {
    if (this.isRateLimited(connectionId)) {
      return { ok: false, reason: 'rate-limited' };
    }
    const room = this.rooms.get(code);
    if (!room) return this.recordFailure(connectionId, 'bad-code');
    if (!this.tokenMatches(room, cameraToken)) {
      return this.recordFailure(connectionId, 'bad-token');
    }
    this.rooms.delete(code);
    return { ok: true, viewers: [...room.viewers.keys()] };
  }

  /**
   * Destroy rooms whose grace period expired (now - orphanedAt >= GRACE_MS)
   * and prune stale rate-limiter state. Returns each destroyed room's code
   * with a snapshot of its viewer ids (taken before destruction) so the
   * server can broadcast room-closed to them. The server must call this on
   * a short interval; expiry happens ONLY here, never lazily per call.
   */
  sweep(): { code: string; viewers: string[] }[] {
    const t = this.now();
    const destroyed: { code: string; viewers: string[] }[] = [];
    for (const [code, room] of this.rooms) {
      if (room.orphanedAt !== null && t - room.orphanedAt >= GRACE_MS) {
        destroyed.push({ code, viewers: [...room.viewers.keys()] });
        this.rooms.delete(code);
      }
    }
    for (const [connectionId, times] of this.failedJoins) {
      this.pruneFailures(times, t);
      if (times.length === 0) this.failedJoins.delete(connectionId);
    }
    return destroyed;
  }

  // -- queries (for the server / Task 4) ------------------------------------

  hasRoom(code: string): boolean {
    return this.rooms.has(code);
  }

  isOrphaned(code: string): boolean {
    const room = this.rooms.get(code);
    return room !== undefined && room.orphanedAt !== null;
  }

  cameraPresent(code: string): boolean {
    return this.rooms.get(code)?.cameraPresent ?? false;
  }

  /** Viewer ids in join order. Empty for unknown rooms. */
  viewers(code: string): string[] {
    const room = this.rooms.get(code);
    return room ? [...room.viewers.keys()] : [];
  }

  /** Number of connection ids currently tracked by the rate limiter. */
  trackedConnections(): number {
    return this.failedJoins.size;
  }

  // -- internals ------------------------------------------------------------

  /**
   * Single comparison site for camera-token checks (reclaimRoom, stopCamera).
   * Constant-time (crypto.timingSafeEqual, available in Bun via node:crypto)
   * so a network attacker who can measure response latency can't use a
   * naive `===` short-circuit to recover the token byte-by-byte. Buffer
   * lengths must match before calling timingSafeEqual (it throws on a
   * mismatch) — the expected length (32 hex chars, generateToken's fixed
   * output) is already public per the wire protocol, so a length-mismatch
   * short-circuit here leaks nothing an attacker doesn't already know.
   */
  private tokenMatches(room: Room, cameraToken: string): boolean {
    const expected = Buffer.from(room.cameraToken, 'utf8');
    const actual = Buffer.from(cameraToken, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  /** Drop failure timestamps that fell out of the sliding window. */
  private pruneFailures(times: number[], t: number): void {
    let drop = 0;
    while (drop < times.length && t - times[drop]! >= RATE_LIMIT_WINDOW_MS) drop++;
    if (drop > 0) times.splice(0, drop);
  }

  private isRateLimited(connectionId: string): boolean {
    const times = this.failedJoins.get(connectionId);
    if (!times) return false;
    this.pruneFailures(times, this.now());
    if (times.length === 0) {
      this.failedJoins.delete(connectionId);
      return false;
    }
    return times.length >= RATE_LIMIT_MAX_FAILURES;
  }

  /** Record a failed join/recreate attempt against the connection's window. */
  private recordFailure(connectionId: string, reason: ErrorReason): { ok: false; reason: ErrorReason } {
    let times = this.failedJoins.get(connectionId);
    if (!times) {
      times = [];
      this.failedJoins.set(connectionId, times);
    }
    times.push(this.now());
    return { ok: false, reason };
  }
}
