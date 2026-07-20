// NannyCam pre-flight checklist (Task 13) — shown before a non-dedicated
// camera goes live for the first time in a page load. Self-contained: the
// pure model at the top (types, the dedicated-device storage helpers, and
// the required-items gate) has no DOM dependency and is unit-tested
// directly (preflight.test.ts); the Preact view below wires that model to
// two injectable browser seams (wakeLock, getBattery) plus two
// user-confirmed checkboxes that can never be detected from a web page.
//
// Design (docs/superpowers/specs/2026-07-19-nannycam-design.md, Operational
// Design section): a web page cannot block or silence calls/notifications —
// no such API exists — so the app's real job is loud failure (the watchdog,
// Task 10), not prevention. This checklist is a best-effort nudge, not a
// guarantee. Accordingly the "Go live" gate (isPreflightReady below) is
// exactly the two checkboxes that genuinely can't be detected any other
// way; wake lock and charger status are surfaced but never block — some
// browsers deny wake lock outside fullscreen, and the Battery API is
// unsupported entirely on iOS Safari (the platform this app cares most
// about — see the design doc's platform landmines list).

import { useEffect, useState } from 'preact/hooks';
import type { StorageLike, WakeLockLike } from './session.ts';

// -- pure model (no DOM; unit-tested directly) --------------------------

export const STORAGE_DEDICATED_KEY = 'nannycam.dedicated';

export type WakeLockStatus = 'checking' | 'detected' | 'unavailable';
export type ChargerStatus = 'checking' | 'charging' | 'not-charging' | 'unknown';

/** The two REQUIRED items — neither is detectable from a web page. */
export interface PreflightRequiredState {
  dnd: boolean;
  ringer: boolean;
}

/**
 * "This is a dedicated device" — persisted; when true, main.tsx skips
 * rendering this checklist on later launches (the button stays "Start
 * camera" and goes straight to session.start(), same as before Task 13).
 */
export function loadDedicated(storage: StorageLike): boolean {
  return storage.getItem(STORAGE_DEDICATED_KEY) === 'true';
}

export function saveDedicated(storage: StorageLike, dedicated: boolean): void {
  if (dedicated) storage.setItem(STORAGE_DEDICATED_KEY, 'true');
  else storage.removeItem(STORAGE_DEDICATED_KEY);
}

/**
 * The "Go live" gate: both user-confirmed checkboxes, and ONLY those — wake
 * lock and charger status are advisory (see the file header) and
 * deliberately excluded. A browser that denies wake lock outside
 * fullscreen, or an iOS Safari that can't report charging state, must never
 * block a caregiver from going live.
 */
export function isPreflightReady(state: PreflightRequiredState): boolean {
  return state.dnd && state.ringer;
}

// -- battery seam ---------------------------------------------------------
//
// The Battery Status API (navigator.getBattery) is non-standard and has no
// lib.dom.d.ts types — Chrome/Android support it, iOS Safari does not (it
// reports 'unknown', a WARNING per the file header, not a blocker). This is
// the slice the view below needs; the real BatteryManager satisfies it
// structurally.
export interface BatteryManagerLike {
  readonly charging: boolean;
  addEventListener(type: 'chargingchange', cb: () => void): void;
  removeEventListener(type: 'chargingchange', cb: () => void): void;
}

/** navigator.getBattery(), feature-detected; undefined where unsupported. */
function defaultGetBattery(): (() => Promise<BatteryManagerLike>) | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
  return typeof nav.getBattery === 'function' ? () => nav.getBattery!() : undefined;
}

function wakeLockStatusText(status: WakeLockStatus): string {
  switch (status) {
    case 'checking':
      return 'Checking…';
    case 'detected':
      return 'Supported on this browser';
    case 'unavailable':
      return "Unavailable here — some browsers deny it outside fullscreen. Keep the screen-lock timeout long as a backup.";
  }
}

function chargerStatusText(status: ChargerStatus): string {
  switch (status) {
    case 'checking':
      return 'Checking…';
    case 'charging':
      return 'Charging';
    case 'not-charging':
      return 'Not charging — plug it in';
    case 'unknown':
      return "Unknown on this browser — make sure it's plugged in";
  }
}

// -- view -------------------------------------------------------------------

export interface PreflightProps {
  /** localStorage (or a test double) — reads/writes the dedicated-device flag. */
  storage: StorageLike;
  /** Both required boxes are checked and the user tapped "Go live". */
  onGoLive: () => void;
  /** The user backed out without going live. */
  onCancel: () => void;
  /** Wake-lock seam — same WakeLockLike shape CameraSession itself uses (session.ts); defaults to navigator.wakeLock. */
  wakeLock?: WakeLockLike;
  /** Battery seam; defaults to navigator.getBattery() where supported. */
  getBattery?: () => Promise<BatteryManagerLike>;
}

export function Preflight({ storage, onGoLive, onCancel, wakeLock, getBattery }: PreflightProps) {
  const [wakeLockStatus, setWakeLockStatus] = useState<WakeLockStatus>('checking');
  const [charger, setCharger] = useState<ChargerStatus>('checking');
  const [dnd, setDnd] = useState(false);
  const [ringer, setRinger] = useState(false);
  const [dedicated, setDedicated] = useState(() => loadDedicated(storage));
  const [tonePlayed, setTonePlayed] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);

  // Item 1 — wake lock: acquire a PROBE lock on mount, release it right
  // after — the REAL one is acquired by session.start() once live. A denial
  // here is a WARNING, not a blocker (see isPreflightReady's doc): some
  // browsers refuse wake lock outside fullscreen/foreground, which this
  // checklist screen may itself be.
  useEffect(() => {
    let cancelled = false;
    const api = wakeLock ?? (typeof navigator !== 'undefined' ? navigator.wakeLock : undefined);
    if (api === undefined) {
      setWakeLockStatus('unavailable');
      return undefined;
    }
    api.request('screen').then(
      (sentinel) => {
        void sentinel.release().catch(() => {});
        if (!cancelled) setWakeLockStatus('detected');
      },
      () => {
        if (!cancelled) setWakeLockStatus('unavailable');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [wakeLock]);

  // Item 2 — charger: navigator.getBattery() where supported, with live
  // updates via chargingchange for the whole time the checklist is open.
  // Unsupported (e.g. iOS Safari) → 'unknown', a warning, not a blocker.
  useEffect(() => {
    let cancelled = false;
    let battery: BatteryManagerLike | null = null;
    const onChange = () => {
      if (battery !== null) setCharger(battery.charging ? 'charging' : 'not-charging');
    };
    const fn = getBattery ?? defaultGetBattery();
    if (fn === undefined) {
      setCharger('unknown');
      return undefined;
    }
    fn().then(
      (b) => {
        if (cancelled) return;
        battery = b;
        setCharger(b.charging ? 'charging' : 'not-charging');
        battery.addEventListener('chargingchange', onChange);
      },
      () => {
        if (!cancelled) setCharger('unknown');
      },
    );
    return () => {
      cancelled = true;
      if (battery !== null) battery.removeEventListener('chargingchange', onChange);
    };
  }, [getBattery]);

  const ready = isPreflightReady({ dnd, ringer });

  const playTestTone = () => {
    // Gesture-safe: the AudioContext is created HERE, inside the click
    // handler, not on mount — browsers only allow audio to start from a
    // user gesture. Informational only, no seam/unit test — same reasoning
    // as detectors.ts's createNoiseSource/createMotionSource: a real Web
    // Audio call with no branching logic worth pinning.
    try {
      const ctx = new AudioContext();
      // iOS Safari (and some other browsers) can construct a context already
      // in 'suspended' state even from a genuine user gesture; resume() is
      // itself gesture-safe to call here (we're still inside the click
      // handler) and a no-op if the context is already running. Failure is
      // non-fatal — same as everything else in this informational test tone.
      void ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      const t0 = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.55);
      setTimeout(() => void ctx.close().catch(() => {}), 700);
    } catch {
      // Non-fatal: this is an informational test, not a required item.
    }
    setTonePlayed(true);
  };

  return (
    <main class="center preflight-screen" data-testid="preflight-screen">
      <h1>Pre-flight checklist</h1>
      <p class="status">Confirm these before this phone starts watching.</p>

      <div class="preflight-item" data-testid="preflight-wakelock">
        <span class="preflight-label">Wake lock</span>
        <span class={`preflight-badge preflight-badge-${wakeLockStatus}`}>
          {wakeLockStatusText(wakeLockStatus)}
        </span>
      </div>

      <div class="preflight-item" data-testid="preflight-charger">
        <span class="preflight-label">Charger</span>
        <span class={`preflight-badge preflight-badge-${charger}`}>
          {chargerStatusText(charger)}
        </span>
      </div>

      <label class="preflight-row">
        <input
          type="checkbox"
          data-testid="preflight-dnd"
          checked={dnd}
          onChange={(e) => setDnd(e.currentTarget.checked)}
        />
        Do Not Disturb / Focus is turned on
      </label>

      <label class="preflight-row">
        <input
          type="checkbox"
          data-testid="preflight-ringer"
          checked={ringer}
          onChange={(e) => setRinger(e.currentTarget.checked)}
        />
        Ringer is muted
      </label>

      <div class="preflight-row preflight-tone-row">
        <button
          type="button"
          class="preflight-tone-btn"
          data-testid="preflight-test-tone"
          onClick={playTestTone}
        >
          Play test tone
        </button>
        {tonePlayed && <span class="preflight-tone-hint">Played — could you hear it?</span>}
      </div>

      <div class="preflight-tip">
        <button
          type="button"
          class="preflight-tip-toggle"
          data-testid="preflight-ios-tip"
          aria-expanded={tipOpen}
          onClick={() => setTipOpen((o) => !o)}
        >
          iOS tip {tipOpen ? '▾' : '▸'}
        </button>
        {tipOpen && (
          <p class="preflight-tip-body">
            Add this page to the Home Screen (Share → Add to Home Screen) so
            it opens full-screen. Then in the Shortcuts app, add a Personal
            Automation: "When NannyCam is opened → Set Focus to Do Not
            Disturb" (Automation tab → new Personal Automation → App). It
            runs every time you start the camera — no need to remember it.
          </p>
        )}
      </div>

      <label class="preflight-row preflight-dedicated">
        <input
          type="checkbox"
          data-testid="preflight-dedicated"
          checked={dedicated}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            setDedicated(next);
            saveDedicated(storage, next);
          }}
        />
        This is a dedicated device — skip this checklist next time
      </label>

      <div class="preflight-actions">
        <button type="button" class="preflight-cancel" onClick={onCancel}>
          Back
        </button>
        <div class="preflight-golive-wrap">
          <button
            type="button"
            class="primary"
            data-testid="preflight-golive"
            disabled={!ready}
            aria-describedby={ready ? undefined : 'preflight-golive-hint'}
            onClick={onGoLive}
          >
            Go live
          </button>
          {!ready && (
            <p
              class="preflight-golive-hint"
              id="preflight-golive-hint"
              data-testid="preflight-golive-hint"
            >
              Check both boxes above to enable Go live.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
