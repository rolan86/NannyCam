import { defineConfig, devices } from '@playwright/test';

const PORT = 8123;
const baseURL = `http://localhost:${PORT}`;

// NannyCam e2e config — chromium only, fake media devices so getUserMedia()
// resolves headlessly (no real camera/mic needed), autoplay unblocked so the
// viewer's <video> plays without a synthetic user gesture.
//
// Port: 8080 (the app's default) is occupied by an unrelated process on dev
// machines, so the e2e suite pins its own port (8123) via PORT and never
// touches 8080.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `bun run build && PORT=${PORT} bun run serve`,
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
