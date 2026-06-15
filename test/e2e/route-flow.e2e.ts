/**
 * Route-flow e2e — drives the full God Mode pipeline end to end, with no API key:
 *   command palette → ORC: Route & Send Prompt
 *     → prompt InputBox (typed prompt replaces clipboard prefill)
 *     → heuristic analysis → approval QuickPick
 *     → "Apply to Claude Code (no run)"
 *     → settings.json write
 *
 * The write target is sandboxed to a clearly-named file inside ~/.claude so the
 * developer's real settings.json is never touched (the extension's path guard
 * requires the target to live under ~/.claude and end in .json).
 *
 * `autoApplyToClaudeCode: true` makes confirmAndApply write immediately, skipping
 * the modal confirm; `showCostWarnings: false` skips the Context Guard dialogs.
 */

import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { launchVSCode, closeVSCode, ARTIFACTS_DIR, type VSCodeSession } from './helpers/vscode-app';
import {
  openCommandPalette,
  typeIntoQuickInput,
  quickInputTitle,
  resetQuickInput,
} from './helpers/workbench';

const E2E_SETTINGS = path.join(os.homedir(), '.claude', 'orc-e2e-settings.json');

let session: VSCodeSession;

test.beforeAll(async () => {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.rmSync(E2E_SETTINGS, { force: true });
  session = await launchVSCode({
    userSettings: {
      'orc.analyzerMode': 'heuristic',
      'orc.autoApplyToClaudeCode': true,
      'orc.showCostWarnings': false,
      'orc.claudeCodeSettingsPath': E2E_SETTINGS,
    },
  });
});

test.afterAll(async () => {
  await closeVSCode(session);
  fs.rmSync(E2E_SETTINGS, { force: true });
});

test('Route & Send → Apply to Claude Code writes a valid model config', async () => {
  const { page } = session;
  await resetQuickInput(page);

  // 1. Launch the route command.
  await openCommandPalette(page);
  await typeIntoQuickInput(page, 'ORC: Route & Send');
  await page.keyboard.press('Enter');

  // 2. Prompt InputBox. The typed text replaces any pre-selected clipboard
  //    prefill. Architecture + multi-file keywords → "high" tier → Opus.
  await expect(async () => {
    expect(await quickInputTitle(page)).toContain('Route a Prompt');
  }).toPass({ timeout: 15_000 });
  await page.keyboard.type(
    'Refactor the authentication architecture across multiple services',
    { delay: 10 },
  );
  await page.keyboard.press('Enter');

  // 3. Approval QuickPick. Filter to the "Apply to Claude Code" action and accept.
  await expect(async () => {
    expect(await quickInputTitle(page)).toContain('ORC Router');
  }).toPass({ timeout: 25_000 });
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'route-approval.png') });
  await page.keyboard.type('Apply to Claude Code', { delay: 10 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');

  // 4. autoApply=true → confirmAndApply writes immediately. Assert the file.
  await expect(() => {
    expect(fs.existsSync(E2E_SETTINGS), 'settings file should be written').toBe(true);
  }).toPass({ timeout: 15_000 });

  const written = JSON.parse(fs.readFileSync(E2E_SETTINGS, 'utf8')) as Record<string, unknown>;
  expect(typeof written.model).toBe('string');
  expect(written.model as string).toMatch(/^claude-/);
  // Opus 4.8 uses adaptive thinking; assert the key is present and well-formed.
  expect(written.thinking).toBeTruthy();
});
