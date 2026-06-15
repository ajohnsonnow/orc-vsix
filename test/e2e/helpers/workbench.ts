/**
 * VS Code workbench interaction helpers.
 *
 * These wrap the stable Monaco workbench DOM (command palette / quick input,
 * status bar) so specs read as user actions rather than CSS selectors. The
 * selectors below have been stable across VS Code releases for years; if a
 * future version renames them, fix it here once.
 */

import { expect, type Page } from '@playwright/test';

const QUICK_INPUT = '.quick-input-widget';
const QUICK_INPUT_TITLE = '.quick-input-widget .quick-input-title';
const QUICK_INPUT_ROW = '.quick-input-widget .quick-input-list .monaco-list-row';
const STATUS_BAR_ITEM = '.statusbar-item';

/** Closes any open quick input so the next action starts from a clean state. */
export async function resetQuickInput(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

/** Opens the command palette (Show All Commands) and waits for it to render. */
export async function openCommandPalette(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+P');
  await page.waitForSelector(QUICK_INPUT, { state: 'visible', timeout: 15_000 });
}

/** Types into the focused quick input, then lets the filtered list settle. */
export async function typeIntoQuickInput(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 10 });
  await page.waitForTimeout(250);
}

/** Returns the visible quick-pick row labels (innerText). */
export async function quickPickItems(page: Page): Promise<string[]> {
  await page.waitForSelector(QUICK_INPUT_ROW, { timeout: 10_000 }).catch(() => { /* empty list */ });
  return page.locator(QUICK_INPUT_ROW).allInnerTexts();
}

/** Reads the quick-input title-bar text (codicons render as icons, not text). */
export async function quickInputTitle(page: Page): Promise<string> {
  const raw = await page.locator(QUICK_INPUT_TITLE).first().innerText().catch(() => '');
  return raw.trim();
}

/** Runs a command by (partial) title via the palette and accepts the top match. */
export async function runCommand(page: Page, title: string): Promise<void> {
  await openCommandPalette(page);
  await typeIntoQuickInput(page, title);
  await page.keyboard.press('Enter');
}

/** All status-bar item texts. */
export async function statusBarTexts(page: Page): Promise<string[]> {
  return page.locator(STATUS_BAR_ITEM).allInnerTexts();
}

/** Polls until a status-bar item contains `needle` (handles async activation). */
export async function waitForStatusBarText(page: Page, needle: string, timeout = 30_000): Promise<void> {
  await expect(async () => {
    const texts = await statusBarTexts(page);
    expect(texts.join(' | ')).toContain(needle);
  }).toPass({ timeout });
}
