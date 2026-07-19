// E2E pairing + frame-flow test — the one true end-to-end check that a real
// (fake-device) camera and a real (fake-device) viewer, running in two
// separate browser CONTEXTS (i.e. two separate "devices"), can pair over the
// relay and actually push decodable video frames peer-to-peer.
//
// Everything below it (unit/integration tests) mocks getUserMedia/RTCPeer
// Connection; this is the only test that exercises the real WebRTC stack
// end-to-end, so it is the pipeline's ultimate correctness gate.

import { expect, test, type Page } from '@playwright/test';

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

test('camera and viewer pair and video frames flow', async ({ browser }) => {
  // Two separate browser contexts == two separate "devices"; a single
  // context sharing cookies/storage would not exercise the real pairing
  // path the way an actual camera + viewer on different devices would.
  const cameraCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();

  try {
    const cameraPage = await cameraCtx.newPage();
    const consoleErrors: string[] = [];
    cameraPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[camera] ${msg.text()}`);
    });

    await cameraPage.goto('/camera.html');
    await cameraPage.getByRole('button', { name: 'Start camera' }).click();

    const roomCodeEl = cameraPage.getByTestId('room-code');
    await expect(roomCodeEl).toBeVisible({ timeout: 10_000 });
    const roomCode = (await roomCodeEl.textContent())?.trim() ?? '';
    expect(roomCode).toHaveLength(8);

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

    // Diagnostic only (not asserted): surfaces real-browser console errors
    // in the report without making the test brittle to benign warnings.
    if (consoleErrors.length > 0) {
      console.log('[e2e] console errors observed:\n' + consoleErrors.join('\n'));
    }
  } finally {
    await cameraCtx.close();
    await viewerCtx.close();
  }
});
