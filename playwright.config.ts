import { defineConfig } from '@playwright/test';

/**
 * Playwright config for ORC's end-to-end suite.
 *
 * These tests drive the *real* VS Code Electron app with the extension loaded
 * in development mode (see test/e2e/helpers/vscode-app.ts). They are slow and
 * stateful, so they run serially with a single worker.
 *
 * Specs use the `.e2e.ts` suffix so they never collide with the Vitest unit
 * suite (`*.test.ts` under src/test).
 */
export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.e2e.ts',
  // VS Code download + cold workbench boot can take a while on first run.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // One VS Code window at a time — Electron apps cannot be parallelised here.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
});
