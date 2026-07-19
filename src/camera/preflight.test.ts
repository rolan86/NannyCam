// Tests for preflight.tsx's pure model (Task 13) — the dedicated-device
// storage helpers and the "Go live" gate. No DOM/Preact here on purpose
// (see preflight.tsx's file header): the view itself is only exercised by
// e2e/preflight.spec.ts, same division of labor as detectors.ts's
// ThresholdDetector (unit-tested) vs createNoiseSource/createMotionSource
// (not — DOM-only, no branching logic worth pinning).

import { describe, expect, test } from 'bun:test';
import {
  isPreflightReady,
  loadDedicated,
  saveDedicated,
  STORAGE_DEDICATED_KEY,
} from './preflight.tsx';

/** Same minimal StorageLike fake used across the other test suites. */
class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe('isPreflightReady — the Go-live gate', () => {
  test('false with neither checkbox checked', () => {
    expect(isPreflightReady({ dnd: false, ringer: false })).toBe(false);
  });

  test('false with only dnd checked', () => {
    expect(isPreflightReady({ dnd: true, ringer: false })).toBe(false);
  });

  test('false with only ringer checked', () => {
    expect(isPreflightReady({ dnd: false, ringer: true })).toBe(false);
  });

  test('true with both checked', () => {
    expect(isPreflightReady({ dnd: true, ringer: true })).toBe(true);
  });
});

describe('loadDedicated / saveDedicated — the persisted skip-checklist flag', () => {
  test('defaults to false when nothing is persisted', () => {
    const storage = new FakeStorage();
    expect(loadDedicated(storage)).toBe(false);
  });

  test('saveDedicated(true) persists under STORAGE_DEDICATED_KEY, readable via loadDedicated', () => {
    const storage = new FakeStorage();
    saveDedicated(storage, true);
    expect(storage.getItem(STORAGE_DEDICATED_KEY)).toBe('true');
    expect(loadDedicated(storage)).toBe(true);
  });

  test('saveDedicated(false) removes the key rather than writing a falsy string', () => {
    const storage = new FakeStorage();
    saveDedicated(storage, true);
    saveDedicated(storage, false);
    expect(storage.getItem(STORAGE_DEDICATED_KEY)).toBeNull();
    expect(loadDedicated(storage)).toBe(false);
  });

  test('loadDedicated treats any non-"true" persisted value as false (defensive against hand-edited storage)', () => {
    const storage = new FakeStorage();
    storage.setItem(STORAGE_DEDICATED_KEY, 'yes');
    expect(loadDedicated(storage)).toBe(false);
  });
});
