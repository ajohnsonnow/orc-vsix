import { describe, it, expect, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { OrcStatusBar } from '../ui/statusBar.js';
import type { ExecutionResult } from '../types/index.js';

// ─────────────────────────────────────────────
//  Fake ExtensionContext
// ─────────────────────────────────────────────

function makeFakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [] as { dispose: () => void }[],
    extensionPath: '/fake',
    extensionUri: { fsPath: '/fake' },
    storageUri: undefined,
    globalStorageUri: { fsPath: '/fake/global' },
    logUri: { fsPath: '/fake/log' },
    extensionMode: 3,
    globalState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    workspaceState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve(), onDidChange: () => ({ dispose: () => {} }) },
    asAbsolutePath: (p: string) => p,
    extension: { id: 'orc', extensionUri: { fsPath: '/fake' }, extensionPath: '/fake', isActive: true, packageJSON: {}, exports: undefined, extensionKind: 1, activate: () => Promise.resolve() },
    environmentVariableCollection: { persistent: false, description: '', replace: () => {}, append: () => {}, prepend: () => {}, get: () => undefined, forEach: () => {}, delete: () => {}, clear: () => {}, getScoped: () => ({} as vscode.EnvironmentVariableCollection), [Symbol.iterator]: function* () {} },
    logPath: '/fake/log',
    storagePath: '/fake/storage',
    globalStoragePath: '/fake/global',
    languageModelAccessInformation: { onDidChange: () => ({ dispose: () => {} }), canSendRequest: () => true },
  } as unknown as vscode.ExtensionContext;
}

function makeExecResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    success: true,
    content: 'response text',
    inputTokens: 1000,
    outputTokens: 500,
    thinkingTokens: 200,
    costUSD: 0.012,
    modelUsed: 'claude-sonnet-4-6',
    durationMs: 1500,
    ...overrides,
  };
}

// ─────────────────────────────────────────────
//  OrcStatusBar
// ─────────────────────────────────────────────

describe('OrcStatusBar', () => {
  let bar: OrcStatusBar;

  beforeEach(() => {
    bar = new OrcStatusBar(makeFakeContext(), true);
  });

  it('starts with zero stats', () => {
    const stats = bar.getStats();
    expect(stats.totalPrompts).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.totalThinkingTokens).toBe(0);
    expect(stats.totalCostUSD).toBe(0);
  });

  it('accumulates stats from recorded executions', () => {
    bar.recordExecution(makeExecResult());
    bar.recordExecution(makeExecResult({ inputTokens: 2000, costUSD: 0.05 }));

    const stats = bar.getStats();
    expect(stats.totalPrompts).toBe(2);
    expect(stats.totalInputTokens).toBe(3000);
    expect(stats.totalOutputTokens).toBe(1000);
    expect(stats.totalCostUSD).toBeCloseTo(0.062);
  });

  it('tracks model usage counts', () => {
    bar.recordExecution(makeExecResult({ modelUsed: 'claude-sonnet-4-6' }));
    bar.recordExecution(makeExecResult({ modelUsed: 'claude-sonnet-4-6' }));
    bar.recordExecution(makeExecResult({ modelUsed: 'claude-opus-4-6' }));

    const stats = bar.getStats();
    expect(stats.modelsUsed['claude-sonnet-4-6']).toBe(2);
    expect(stats.modelsUsed['claude-opus-4-6']).toBe(1);
  });

  it('clears session resets all stats', () => {
    bar.recordExecution(makeExecResult());
    bar.clearSession();

    const stats = bar.getStats();
    expect(stats.totalPrompts).toBe(0);
    expect(stats.totalCostUSD).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
  });

  it('returns a copy of stats (not a reference)', () => {
    bar.recordExecution(makeExecResult());
    const stats1 = bar.getStats();
    bar.recordExecution(makeExecResult());
    const stats2 = bar.getStats();
    expect(stats1.totalPrompts).toBe(1);
    expect(stats2.totalPrompts).toBe(2);
  });

  it('setSessionBudget does not throw for unknown tier', () => {
    expect(() => bar.setSessionBudget('unknown_tier')).not.toThrow();
  });

  it('dispose does not throw', () => {
    expect(() => bar.dispose()).not.toThrow();
  });
});
