/**
 * Smoke e2e — proves the extension actually activates inside VS Code:
 *   • the ORC status-bar item renders (activation + status bar wiring)
 *   • every contributed command is registered in the palette
 *   • the session-status webview opens
 *
 * No API key required — runs the extension in heuristic mode.
 */

import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { launchVSCode, closeVSCode, ARTIFACTS_DIR, type VSCodeSession } from './helpers/vscode-app';
import {
  openCommandPalette,
  typeIntoQuickInput,
  quickPickItems,
  resetQuickInput,
  waitForStatusBarText,
} from './helpers/workbench';

let session: VSCodeSession;

test.beforeAll(async () => {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  session = await launchVSCode({ userSettings: { 'orc.analyzerMode': 'heuristic' } });
});

test.afterAll(async () => {
  await closeVSCode(session);
});

test('extension activates and shows the ORC status-bar item', async () => {
  const { page } = session;
  await waitForStatusBarText(page, 'ORC');
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'smoke-statusbar.png') });
});

test('unconditional ORC commands are registered in the command palette', async () => {
  const { page } = session;
  await resetQuickInput(page);
  await openCommandPalette(page);
  await typeIntoQuickInput(page, 'ORC:');

  const items = (await quickPickItems(page)).join('\n');
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'smoke-palette.png') });

  // These appear regardless of editor state. `orc.analyzeSelection` is
  // intentionally gated by `when: editorHasSelection` (asserted separately).
  const expectedCommands = [
    'Route & Send Prompt',
    'Apply Last Recommendation to Claude Code',
    'Show Token & Cost Status',
    'Clear Session Token Count',
    'Open Settings',
    'Set Anthropic API Key',
    'Export Problems Panel to JSON',
  ];
  for (const title of expectedCommands) {
    expect(items, `command palette should list "${title}"`).toContain(title);
  }
  // The selection-gated command must NOT show without a selection.
  expect(items).not.toContain('Analyze Selected Text as Prompt');
  await resetQuickInput(page);
});

test('Analyze Selected Text appears only when the editor has a selection', async () => {
  const { page } = session;
  await resetQuickInput(page);

  // Open the fixture file via Quick Open, then select all so editorHasSelection is true.
  await page.keyboard.press('Control+P');
  await page.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 10_000 });
  await page.keyboard.type('sample.ts', { delay: 10 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.monaco-editor', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+A');
  await page.waitForTimeout(300);

  await openCommandPalette(page);
  await typeIntoQuickInput(page, 'ORC: Analyze');
  const items = (await quickPickItems(page)).join('\n');
  expect(items, 'selection-gated command should appear with a selection active').toContain(
    'Analyze Selected Text as Prompt',
  );
  await resetQuickInput(page);
});

test('Show Token & Cost Status opens the session webview', async () => {
  const { page } = session;
  await resetQuickInput(page);
  await openCommandPalette(page);
  await typeIntoQuickInput(page, 'ORC: Show Token');
  await page.keyboard.press('Enter');

  // The webview opens as an editor tab titled "ORC — Session Status".
  await expect(page.locator('.tab', { hasText: 'Session Status' })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'smoke-status-webview.png') });
});
