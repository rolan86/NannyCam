// Room lifecycle state machine — encodes the spec's room-lifecycle policy.
//
// Pure logic: no I/O, no timers, no Date.now(). The clock is injected
// (`now: () => number`, milliseconds) and grace expiry happens only inside
// sweep(), which the server must call on a short interval. sweep() returns
// the codes of rooms destroyed by grace expiry so the caller can broadcast
// room-closed to any remaining viewers.
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
// Rate limiting: per connection id, sliding 60-second window over FAILED join
// attempts only (bad-code and room-full both count; successes never count).
// Once RATE_LIMIT_MAX_FAILURES failures sit inside the window, further joins
// from that connection get 'rate-limited'. Rate-limited responses themselves
// are not recorded, so retrying while limited does not extend the window.
// Limiter state is pruned lazily on each check and globally in sweep().

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

  /** Camera opens a brand-new room. Codes are unique among live rooms. */
  createRoom(): { code: string; cameraToken: string } {
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
    return { code, cameraToken };
  }

  /**
   * Camera re-creates a room after a server restart, presenting its
   * previously issued code. Refused while any room with that code exists
   * (live or orphaned-in-grace) — a live room cannot be hijacked. Issues a
   * FRESH camera token; the code's entropy is the authentication.
   */
  recreateRoom(code: string): Result<{ cameraToken: string }> {
    if (!isValidCode(code) || this.rooms.has(code)) {
      return { ok: false, reason: 'bad-code' };
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
    if (!room) return this.failJoin(connectionId, 'bad-code');
    if (room.viewers.size >= MAX_VIEWERS) return this.failJoin(connectionId, 'room-full');
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
   * viewers are untouched.
   */
  reclaimRoom(code: string, cameraToken: string): Result {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, reason: 'bad-code' };
    if (cameraToken !== room.cameraToken) return { ok: false, reason: 'bad-token' };
    room.cameraPresent = true;
    room.orphanedAt = null;
    return { ok: true };
  }

  /** Explicit "Stop camera": immediate destroy of the room and its code. */
  stopCamera(code: string, cameraToken: string): Result {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, reason: 'bad-code' };
    if (cameraToken !== room.cameraToken) return { ok: false, reason: 'bad-token' };
    this.rooms.delete(code);
    return { ok: true };
  }

  /**
   * Destroy rooms whose grace period expired (now - orphanedAt >= GRACE_MS)
   * and prune stale rate-limiter state. Returns the codes of destroyed rooms
   * so the server can broadcast room-closed to their viewers. The server must
   * call this on a short interval.
   */
  sweep(): string[] {
    const t = this.now();
    const destroyed: string[] = [];
    for (const [code, room] of this.rooms) {
      if (room.orphanedAt !== null && t - room.orphanedAt >= GRACE_MS) {
        this.rooms.delete(code);
        destroyed.push(code);
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

  // -- rate limiter internals -----------------------------------------------

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

  private failJoin(connectionId: string, reason: ErrorReason): { ok: false; reason: ErrorReason } {
    let times = this.failedJoins.get(connectionId);
    if (!times) {
      times = [];
      this.failedJoins.set(connectionId, times);
    }
    times.push(this.now());
    return { ok: false, reason };
  }
}
