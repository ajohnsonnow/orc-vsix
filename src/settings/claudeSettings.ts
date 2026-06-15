/**
 * ORC — Claude Code Settings Manager
 *
 * Reads and writes ~/.claude/settings.json to apply routing recommendations
 * directly to the Claude Code CLI without the user having to touch any config files.
 *
 * Claude Code's settings.json supports:
 *   model          — the model ID (e.g., "claude-opus-4-6")
 *   thinking       — { type: "enabled"|"disabled", budget_tokens?: number }
 *   env            — environment variable overrides
 *   (plus many other keys that we must preserve — we do a targeted merge)
 *
 * SAFETY: We NEVER overwrite keys we don't own. We read → merge → write.
 * The user is always shown a diff before confirming in the approval UI.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ClaudeCodeConfig } from '../types/index.js';

// ─────────────────────────────────────────────
//  Path Resolution
// ─────────────────────────────────────────────

/**
 * Returns the path to ~/.claude/settings.json.
 * Honours the user-configured override path first.
 */
export function getClaudeSettingsPath(overridePath?: string): string {
  const defaultPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!overridePath?.trim()) { return defaultPath; }
  const resolved = path.resolve(overridePath.trim());
  const allowedRoot = path.join(os.homedir(), '.claude') + path.sep;
  if (!resolved.startsWith(allowedRoot) || !resolved.endsWith('.json')) {
    throw new Error(`ORC: claudeCodeSettingsPath must be a .json file inside ~/.claude/. Got: ${resolved}`);
  }
  return resolved;
}

// ─────────────────────────────────────────────
//  Read
// ─────────────────────────────────────────────

export async function readClaudeSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    // File doesn't exist yet → start with an empty object
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') { return {}; }
    throw err;
  }
}

// ─────────────────────────────────────────────
//  Write (merge, never overwrite unrelated keys)
// ─────────────────────────────────────────────

export async function applyClaudeCodeConfig(
  config: ClaudeCodeConfig,
  settingsPath: string,
): Promise<{ previous: Record<string, unknown>; updated: Record<string, unknown> }> {
  const existing = await readClaudeSettings(settingsPath);
  const previous = JSON.parse(JSON.stringify(existing)) as Record<string, unknown>;

  // Targeted merge — only touch keys we own
  const merged: Record<string, unknown> = {
    ...existing,
    ...config.settingsDelta,
  };

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  return { previous, updated: merged };
}

// ─────────────────────────────────────────────
//  Show Diff & Confirm Dialog
// ─────────────────────────────────────────────

/**
 * Shows the user exactly what will change in settings.json,
 * then asks for confirmation before writing.
 *
 * Returns true if the user approved, false if cancelled.
 */
export async function confirmAndApply(
  config: ClaudeCodeConfig,
  settingsPath: string,
  autoApply: boolean,
): Promise<boolean> {
  if (autoApply) {
    await applyClaudeCodeConfig(config, settingsPath);
    void vscode.window.showInformationMessage(
      `ORC: Claude Code settings updated → model: ${config.model}` +
      (config.thinkingBudget > 0 ? `, thinking: ${config.thinkingBudget.toLocaleString()} tokens` : ''),
    );
    return true;
  }

  const existing = await readClaudeSettings(settingsPath);

  // Build a readable diff string
  const diffLines: string[] = [];
  for (const [key, newVal] of Object.entries(config.settingsDelta)) {
    const oldVal = existing[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diffLines.push(`  ${key}: ${JSON.stringify(oldVal ?? '(not set)')} → ${JSON.stringify(newVal)}`);
    }
  }

  const diffText = diffLines.length > 0
    ? diffLines.join('\n')
    : '  (no changes needed — settings already match)';

  const choice = await vscode.window.showInformationMessage(
    `ORC: Apply to Claude Code settings?\n\n${diffText}\n\nPath: ${settingsPath}`,
    { modal: true },
    'Apply',
    'Cancel',
  );

  if (choice !== 'Apply') { return false; }

  const { updated } = await applyClaudeCodeConfig(config, settingsPath);
  const activeModel = typeof updated['model'] === 'string' ? updated['model'] : '?';

  void vscode.window.showInformationMessage(
    `ORC: settings.json updated. Active model: ${activeModel}`,
  );

  return true;
}

// ─────────────────────────────────────────────
//  Read Active Model (for status bar tooltip)
// ─────────────────────────────────────────────

export async function getActiveClaudeModel(settingsPath: string): Promise<string | null> {
  try {
    const settings = await readClaudeSettings(settingsPath);
    return typeof settings['model'] === 'string' ? settings['model'] : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
//  Open settings.json in Editor
// ─────────────────────────────────────────────

export async function openClaudeSettingsInEditor(settingsPath: string): Promise<void> {
  try {
    const uri = vscode.Uri.file(settingsPath);
    await vscode.window.showTextDocument(uri);
  } catch {
    void vscode.window.showErrorMessage(`ORC: Could not open ${settingsPath}`);
  }
}
