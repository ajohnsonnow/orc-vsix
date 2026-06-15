/**
 * VS Code launcher for Playwright end-to-end tests.
 *
 * Launches the real VS Code Electron app with THIS repo loaded as a development
 * extension, then hands back the Monaco workbench window as a Playwright `Page`
 * so specs can drive it exactly as a user would.
 *
 * Isolation: each launch gets a throwaway `--user-data-dir` and `--extensions-dir`,
 * so no other installed extension loads and the developer's real VS Code profile
 * is never read or mutated.
 *
 * VS Code binary: downloaded once and cached under `.vscode-test/` (pinned version,
 * reproducible in CI). Overrides:
 *   ORC_E2E_VSCODE         — absolute path to an installed Code executable to reuse
 *   ORC_E2E_VSCODE_VERSION — pin a specific release instead of 'stable'
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

/** Repo root = three levels up from test/e2e/helpers/. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const FIXTURE_WORKSPACE = path.join(REPO_ROOT, 'test', 'e2e', 'fixtures', 'workspace');
export const ARTIFACTS_DIR = path.join(REPO_ROOT, 'test', 'e2e', '.artifacts');

export interface VSCodeSession {
  app: ElectronApplication;
  /** The Monaco workbench window. */
  page: Page;
  /** Isolated sandbox root (profile + extensions). Deleted on close. */
  sandbox: string;
}

export interface LaunchOptions {
  /**
   * User-level settings.json contents. Machine-scoped keys (e.g.
   * `orc.claudeCodeSettingsPath`) can ONLY be set here, not in workspace settings.
   */
  userSettings?: Record<string, unknown>;
}

/**
 * Launches VS Code with the extension under test loaded in dev mode.
 * Resolves once the workbench is rendered and notifications are cleared.
 */
export async function launchVSCode(opts: LaunchOptions = {}): Promise<VSCodeSession> {
  const executablePath =
    process.env.ORC_E2E_VSCODE?.trim() ||
    (await downloadAndUnzipVSCode(process.env.ORC_E2E_VSCODE_VERSION || 'stable'));

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-e2e-'));
  const userDataDir = path.join(sandbox, 'user-data');
  const extensionsDir = path.join(sandbox, 'extensions');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });

  if (opts.userSettings) {
    const userDir = path.join(userDataDir, 'User');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'settings.json'),
      JSON.stringify(opts.userSettings, null, 2),
      'utf8',
    );
  }

  const app = await _electron.launch({
    executablePath,
    // CRITICAL: if these tests run from inside a VS Code terminal / extension
    // host, the inherited env has ELECTRON_RUN_AS_NODE=1 (+ VSCODE_* vars), which
    // makes the child Code.exe boot as a plain Node interpreter — it then rejects
    // every VS Code flag with "bad option: ...". Scrub them so it boots as the GUI.
    env: scrubbedEnv(),
    args: [
      `--extensionDevelopmentPath=${REPO_ROOT}`,
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--disable-gpu',
      '--no-sandbox',
      FIXTURE_WORKSPACE,
    ],
    timeout: 120_000,
  });

  const page = await app.firstWindow();
  // Workbench shell — present once the renderer has booted.
  await page.waitForSelector('.monaco-workbench', { timeout: 120_000 });
  // Extensions activate on onStartupFinished; give the host a beat, then clear
  // the welcome / peak-hour toasts so they don't overlay later interactions.
  await page.waitForTimeout(2_000);
  await clearNotifications(page);

  return { app, page, sandbox };
}

export async function closeVSCode(session: VSCodeSession | undefined): Promise<void> {
  if (!session) { return; }
  await session.app.close().catch(() => { /* already gone */ });
  try {
    fs.rmSync(session.sandbox, { recursive: true, force: true });
  } catch {
    /* sandbox may be locked briefly on Windows — harmless to leave for the OS temp sweep */
  }
}

/**
 * Returns process.env minus the VS Code extension-host markers that would make
 * a child Code.exe run as Node instead of launching the workbench.
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') { continue; }
    if (key.startsWith('VSCODE_')) { continue; }
    env[key] = value;
  }
  return env;
}

/** Best-effort dismissal of any startup notification toasts. */
async function clearNotifications(page: Page): Promise<void> {
  try {
    await page.keyboard.press('Control+Shift+P');
    await page.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 5_000 });
    await page.keyboard.type('Notifications: Clear All Notifications', { delay: 5 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
  } catch {
    /* no notifications, or palette unavailable — fine */
  }
}
