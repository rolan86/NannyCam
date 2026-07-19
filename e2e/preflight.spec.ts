// E2E coverage for the Task 13 pre-flight checklist. Kept minimal/fast per
// the plan's brief: two small tests, neither pairs a viewer (that's already
// covered end-to-end by monitor.spec.ts, which preseeds the dedicated-device
// flag precisely so it doesn't have to go through this checklist). Both
// tests here only need the camera to reach 'live' (room-code visible) to
// prove the button/checklist actually calls session.start() — nothing more.

import { expect, test } from '@playwright/test';
import { CODE_LENGTH } from '../shared/protocol.ts';

test('dedicated device: checklist is skipped, "Start camera" goes straight live', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  // Preseeded BEFORE the page loads (addInitScript runs before any page
  // script) — this is the persisted flag preflight.tsx's loadDedicated()
  // reads on the very first render of the idle screen.
  await ctx.addInitScript(() => {
    window.localStorage.setItem('nannycam.dedicated', 'true');
  });
  const page = await ctx.newPage();

  try {
    await page.goto('/camera.html');

    // The checklist must never appear, and the button keeps its pre-Task-13 label.
    await expect(page.getByTestId('preflight-screen')).toHaveCount(0);
    const startBtn = page.getByRole('button', { name: 'Start camera' });
    await expect(startBtn).toBeVisible();

    await startBtn.click();
    const roomCodeEl = page.getByTestId('room-code');
    await expect(roomCodeEl).toBeVisible({ timeout: 10_000 });
    expect((await roomCodeEl.textContent())?.trim()).toHaveLength(CODE_LENGTH);
  } finally {
    await ctx.close();
  }
});

test('non-dedicated device: checklist walkthrough — checking both boxes enables Go live', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await page.goto('/camera.html');

    // Fresh device (no persisted flag): the idle screen offers "Set up
    // camera", not the direct-start button.
    await expect(page.getByRole('button', { name: 'Set up camera' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start camera' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Set up camera' }).click();

    const screen = page.getByTestId('preflight-screen');
    await expect(screen).toBeVisible();
    const goLive = page.getByTestId('preflight-golive');
    await expect(goLive).toBeDisabled();

    // Neither checkbox alone is enough — the gate is BOTH.
    await page.getByTestId('preflight-dnd').check();
    await expect(goLive).toBeDisabled();
    await page.getByTestId('preflight-ringer').check();
    await expect(goLive).toBeEnabled();

    await goLive.click();
    const roomCodeEl = page.getByTestId('room-code');
    await expect(roomCodeEl).toBeVisible({ timeout: 10_000 });
    expect((await roomCodeEl.textContent())?.trim()).toHaveLength(CODE_LENGTH);
  } finally {
    await ctx.close();
  }
});
