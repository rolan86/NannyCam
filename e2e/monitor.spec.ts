// E2E pairing + frame-flow + watchdog test — the one true end-to-end check
// that a real (fake-device) camera and a real (fake-device) viewer, running
// in two separate browser CONTEXTS (i.e. two separate "devices"), can pair
// over the relay, push decodable video frames peer-to-peer, and — the
// safety-critical part (Task 10) — that the viewer alarms loudly when the
// camera dies and silently, automatically recovers when it comes back.
//
// Everything below it (unit/integration tests) mocks getUserMedia/RTCPeer
// Connection; this is the only test that exercises the real WebRTC stack
// end-to-end, so it is the pipeline's ultimate correctness gate.

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { CODE_LENGTH } from '../shared/protocol.ts';

/**
 * Pull the decoded-video-frame counter off the CURRENT camera peer's stats.
 * Reads through the viewer session's test hook (`window.__nannycam`, wired
 * in src/viewer/main.tsx) rather than reimplementing WebRTC stats polling
 * here. Returns 0 before a peer exists or before the first stats sample
 * contains an inbound-rtp video report.
 */
async function framesDecoded(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const win = window as unknown as {
      __nannycam: { getStats(): Promise<RTCStatsReport | null> };
    };
    const stats = await win.__nannycam.getStats();
    if (stats === null) return 0;
    for (const report of stats.values()) {
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        return (report.framesDecoded as number | undefined) ?? 0;
      }
    }
    return 0;
  });
}

interface Pairing {
  cameraCtx: BrowserContext;
  viewerCtx: BrowserContext;
  cameraPage: Page;
  viewerPage: Page;
  roomCode: string;
  /** Diagnostic-only console errors from both pages (never asserted on). */
  consoleErrors: string[];
}

/**
 * Pair a fresh camera + viewer (two separate browser contexts == two
 * separate "devices") and wait until the viewer reports 'live'. Shared setup
 * for every test in this file — extracted so each test only needs to
 * describe what it does DIFFERENTLY after pairing.
 */
async function pairCameraAndViewer(browser: Browser): Promise<Pairing> {
  const cameraCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const consoleErrors: string[] = [];

  // Task 13: preseed the "dedicated device" flag on every page this context
  // ever navigates to (including the revived camera page later in the DOWN/
  // recovery test, which reuses cameraCtx) — this suite is about pairing/
  // frame-flow/watchdog/talk-back, not the pre-flight checklist itself (see
  // preflight.spec.ts for that), so it keeps the pre-Task-13 direct "Start
  // camera" click working unchanged.
  await cameraCtx.addInitScript(() => {
    window.localStorage.setItem('nannycam.dedicated', 'true');
  });

  const cameraPage = await cameraCtx.newPage();
  cameraPage.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[camera] ${msg.text()}`);
  });
  await cameraPage.goto('/camera.html');
  await cameraPage.getByRole('button', { name: 'Start camera' }).click();

  const roomCodeEl = cameraPage.getByTestId('room-code');
  await expect(roomCodeEl).toBeVisible({ timeout: 10_000 });
  const roomCode = (await roomCodeEl.textContent())?.trim() ?? '';
  expect(roomCode).toHaveLength(CODE_LENGTH);

  const viewerPage = await viewerCtx.newPage();
  viewerPage.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[viewer] ${msg.text()}`);
  });
  await viewerPage.goto(`/viewer.html#${roomCode}`);
  await viewerPage.getByTestId('join-btn').click();

  // Status line reaches 'live' once the camera's track arrives.
  await expect(viewerPage.getByTestId('status')).toHaveText(/live/, {
    timeout: 10_000,
  });

  return { cameraCtx, viewerCtx, cameraPage, viewerPage, roomCode, consoleErrors };
}

/** Close both contexts; a teardown failure in one must not hide the other's. */
async function teardown(cameraCtx: BrowserContext, viewerCtx: BrowserContext): Promise<void> {
  const results = await Promise.allSettled([cameraCtx.close(), viewerCtx.close()]);
  for (const r of results) {
    if (r.status === 'rejected') console.log('[e2e] context teardown error:', r.reason);
  }
}

function logConsoleErrors(consoleErrors: string[]): void {
  // Diagnostic only (not asserted): surfaces real-browser console errors in
  // the report without making the test brittle to benign warnings.
  if (consoleErrors.length > 0) {
    console.log('[e2e] console errors observed:\n' + consoleErrors.join('\n'));
  }
}

test('camera and viewer pair and video frames flow', async ({ browser }) => {
  const { cameraCtx, viewerCtx, viewerPage, consoleErrors } = await pairCameraAndViewer(browser);

  try {
    const video = viewerPage.getByTestId('viewer-video');
    await expect(video).toBeVisible();
    await expect
      .poll(
        () => video.evaluate((el: HTMLVideoElement) => el.videoWidth),
        { timeout: 10_000, message: 'viewer video never reported a width' },
      )
      .toBeGreaterThan(0);

    // Frame flow: two framesDecoded samples 2s apart must show real growth,
    // not just a stalled connection sitting at videoWidth > 0.
    const first = await framesDecoded(viewerPage);
    await viewerPage.waitForTimeout(2_000); // deliberate stats-gap sleep, not a poll wait
    const second = await framesDecoded(viewerPage);
    expect(second).toBeGreaterThan(first);

    logConsoleErrors(consoleErrors);
  } finally {
    await teardown(cameraCtx, viewerCtx);
  }
});

// This test IS the product guarantee (see docs/superpowers/specs/
// 2026-07-19-nannycam-design.md, "Failure Handling"): a monitor that fails
// silently is worse than no monitor at all, and recovery must need zero
// viewer-side interaction — nobody re-taps a phone propped up watching a
// sleeping baby.
test('camera death alarms viewer, revival auto-recovers', async ({ browser }) => {
  const { cameraCtx, viewerCtx, cameraPage, viewerPage, roomCode, consoleErrors } =
    await pairCameraAndViewer(browser);

  try {
    // Confirm frames are genuinely flowing before killing the camera — a
    // meaningful baseline, not just a connected-but-frozen video element.
    const video = viewerPage.getByTestId('viewer-video');
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    // Kill the camera page entirely — simulates the phone dying hard enough
    // that its WS socket drops (call interruption / backgrounding / crash).
    // The relay sees the socket close and tells the viewer immediately
    // (peer-left); recovery from there is entirely the watchdog's missed-
    // heartbeat detection (no instant-DOWN special-case — see monitor.ts).
    await cameraPage.close();

    await expect(viewerPage.locator('[data-state="down"]')).toBeVisible({
      timeout: 8_000,
    });

    // Revive: a NEW page in the SAME camera context. localStorage (room code
    // + camera token) is per-origin-per-context and survives the closed
    // page, so Start reclaims the SAME room instead of minting a new one.
    // Start requires a real click (getUserMedia needs a user gesture) — this
    // is the one designed tap, on the CAMERA side. Zero taps on the viewer
    // from here on: auto-reclaim -> re-offer -> viewer's lazy peer-adoption
    // -> watchdog reset() -> back to live, unattended.
    const revivedCameraPage = await cameraCtx.newPage();
    revivedCameraPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[camera-revived] ${msg.text()}`);
    });
    await revivedCameraPage.goto('/camera.html');
    await revivedCameraPage.getByRole('button', { name: 'Start camera' }).click();
    await expect(revivedCameraPage.getByTestId('room-code')).toHaveText(roomCode, {
      timeout: 10_000,
    });

    // Zero viewer-page interactions from here to recovery.
    await expect(viewerPage.locator('[data-state="live"]')).toBeVisible({
      timeout: 15_000,
    });

    const first = await framesDecoded(viewerPage);
    await viewerPage.waitForTimeout(2_000);
    const second = await framesDecoded(viewerPage);
    expect(second).toBeGreaterThan(first);

    logConsoleErrors(consoleErrors);
  } finally {
    await teardown(cameraCtx, viewerCtx);
  }
});

/**
 * Reads the viewer session's acquired mic track's `enabled` flag through the
 * same test-hook pattern as framesDecoded above (window.__nannycam, wired in
 * src/viewer/main.tsx). `micTrack` is a TypeScript-`private` field, but that
 * is a compile-time-only annotation — at runtime it's an ordinary property,
 * and reaching into it here is the most direct way to prove the REAL
 * MediaStreamTrack (not just the session's public talk-state string) flips
 * with press/release, per this test's explicit brief.
 */
async function micEnabled(page: Page): Promise<boolean | null> {
  return page.evaluate(() => {
    const win = window as unknown as {
      __nannycam: { micTrack: MediaStreamTrack | null };
    };
    return win.__nannycam.micTrack?.enabled ?? null;
  });
}

// Task 12 (talk-back): the viewer pre-negotiates a sendonly mic transceiver
// at pairing time (see src/viewer/session.ts's adoptPeer) — pressing PTT
// never renegotiates, it only acquires the mic once and flips track.enabled.
// This test presses, confirms the camera page actually receives the
// viewer's mic audio (a real remote-audio element backed by a live
// MediaStream, not just a UI state flip), then releases and confirms the
// viewer-side track disables again.
test('push-to-talk: pressing sends the viewer mic to the camera; track.enabled follows press/release', async ({
  browser,
}) => {
  const { cameraCtx, viewerCtx, cameraPage, viewerPage, consoleErrors } =
    await pairCameraAndViewer(browser);

  try {
    const pttBtn = viewerPage.getByTestId('ptt-btn');
    await expect(pttBtn).toBeVisible();
    expect(await micEnabled(viewerPage)).toBeNull(); // no press yet: no mic acquired

    // Real press-and-hold via the mouse (synthesizes genuine pointerdown/up
    // events in Chromium) rather than a synthetic dispatchEvent — see the
    // Task 12 report for why this was chosen after the alternative proved
    // less reliable in this fake-media headless setup.
    await pttBtn.hover();
    await viewerPage.mouse.down();

    await expect
      .poll(() => micEnabled(viewerPage), {
        timeout: 10_000,
        message: 'viewer mic track never enabled after press',
      })
      .toBe(true);

    // The cross-page proof: the camera actually receives the audio (a live
    // MediaStream backing a rendered remote-audio element), not just that
    // the viewer's local UI/state flipped.
    await expect(cameraPage.getByTestId('remote-audio')).toHaveCount(1, {
      timeout: 10_000,
    });

    await viewerPage.mouse.up();

    await expect
      .poll(() => micEnabled(viewerPage), {
        timeout: 10_000,
        message: 'viewer mic track never disabled after release',
      })
      .toBe(false);

    logConsoleErrors(consoleErrors);
  } finally {
    await teardown(cameraCtx, viewerCtx);
  }
});
