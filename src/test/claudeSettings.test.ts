import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getClaudeSettingsPath, readClaudeSettings, applyClaudeCodeConfig } from '../settings/claudeSettings.js';

// ─────────────────────────────────────────────
//  getClaudeSettingsPath
// ─────────────────────────────────────────────

describe('getClaudeSettingsPath', () => {
  it('returns override path when provided', () => {
    expect(getClaudeSettingsPath('/custom/path/settings.json')).toBe('/custom/path/settings.json');
  });

  it('trims whitespace from override path', () => {
    expect(getClaudeSettingsPath('  /custom/path.json  ')).toBe('/custom/path.json');
  });

  it('falls back to ~/.claude/settings.json when no override', () => {
    const result = getClaudeSettingsPath();
    expect(result).toBe(path.join(os.homedir(), '.claude', 'settings.json'));
  });

  it('falls back when override is empty string', () => {
    const result = getClaudeSettingsPath('');
    expect(result).toBe(path.join(os.homedir(), '.claude', 'settings.json'));
  });

  it('falls back when override is whitespace only', () => {
    const result = getClaudeSettingsPath('   ');
    expect(result).toBe(path.join(os.homedir(), '.claude', 'settings.json'));
  });
});

// ─────────────────────────────────────────────
//  readClaudeSettings + applyClaudeCodeConfig
// ─────────────────────────────────────────────

describe('readClaudeSettings', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-test-'));
    tmpFile = path.join(tmpDir, 'settings.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when file does not exist', async () => {
    const result = await readClaudeSettings(path.join(tmpDir, 'nonexistent.json'));
    expect(result).toEqual({});
  });

  it('parses existing JSON file', async () => {
    await fs.writeFile(tmpFile, JSON.stringify({ model: 'claude-sonnet-4-6', foo: 'bar' }));
    const result = await readClaudeSettings(tmpFile);
    expect(result['model']).toBe('claude-sonnet-4-6');
    expect(result['foo']).toBe('bar');
  });
});

describe('applyClaudeCodeConfig', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-test-'));
    tmpFile = path.join(tmpDir, 'settings.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates settings file if it does not exist', async () => {
    const config = {
      model: 'claude-opus-4-6',
      thinkingBudget: 32000,
      useFastMode: false,
      systemPromptPrefix: '',
      cliHint: 'claude --model claude-opus-4-6 --thinking-budget 32000',
      settingsDelta: { model: 'claude-opus-4-6', thinking: { type: 'enabled', budget_tokens: 32000 } },
    };
    const { updated } = await applyClaudeCodeConfig(config, tmpFile);
    expect(updated['model']).toBe('claude-opus-4-6');

    // Verify file was actually written
    const raw = await fs.readFile(tmpFile, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['model']).toBe('claude-opus-4-6');
  });

  it('preserves existing keys during merge', async () => {
    await fs.writeFile(tmpFile, JSON.stringify({ model: 'claude-haiku-4-5', customKey: 'preserved' }));

    const config = {
      model: 'claude-opus-4-6',
      thinkingBudget: 10000,
      useFastMode: false,
      systemPromptPrefix: '',
      cliHint: '',
      settingsDelta: { model: 'claude-opus-4-6' },
    };

    const { previous, updated } = await applyClaudeCodeConfig(config, tmpFile);
    expect(previous['model']).toBe('claude-haiku-4-5');
    expect(updated['model']).toBe('claude-opus-4-6');
    expect(updated['customKey']).toBe('preserved');
  });

  it('returns previous state for diff display', async () => {
    await fs.writeFile(tmpFile, JSON.stringify({ model: 'old-model' }));

    const config = {
      model: 'new-model',
      thinkingBudget: 0,
      useFastMode: false,
      systemPromptPrefix: '',
      cliHint: '',
      settingsDelta: { model: 'new-model' },
    };

    const { previous } = await applyClaudeCodeConfig(config, tmpFile);
    expect(previous['model']).toBe('old-model');
  });
});
