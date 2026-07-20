// E2E coverage for the Task 15 landing page (src/index.html). The one thing
// worth regression-testing here that unit tests can't: the page has NO
// style-src/script-src override in the production CSP (default-src 'self'
// blocks inline <style>/<script> outright), so an accidental inline style or
// script would render broken/unstyled in real deployment while looking fine
// in a plain file:// open. Listening for console/page errors during load
// catches exactly that regression.

import { expect, test } from '@playwright/test';

test('landing page: shows the trust statement, links to camera/viewer, and loads with no CSP violations', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'NannyCam' })).toBeVisible();
  // Plain-string getByText normalizes internal whitespace (collapsing the
  // source's line-wrapped paragraph into single spaces); a RegExp match does
  // not, so this is intentionally a string, not a regex.
  await expect(page.getByText('No app, no cloud, no recording')).toBeVisible();

  const cameraLink = page.getByRole('link', { name: 'This phone is the camera' });
  const viewerLink = page.getByRole('link', { name: 'This phone is the viewer' });
  await expect(cameraLink).toHaveAttribute('href', '/camera.html');
  await expect(viewerLink).toHaveAttribute('href', '/viewer.html');

  // No inline-style/script CSP violation surfaced as a console error, and no
  // uncaught page error, during load.
  const cspViolations = consoleErrors.filter((e) => /content security policy|csp/i.test(e));
  expect(cspViolations).toEqual([]);
  expect(pageErrors).toEqual([]);

  // Click through and confirm the camera page actually loads (not a 404).
  await cameraLink.click();
  await expect(page).toHaveURL(/\/camera\.html$/);
  await expect(page.getByRole('heading', { name: 'NannyCam' })).toBeVisible();
});
