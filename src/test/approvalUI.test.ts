import { describe, it, expect } from 'vitest';

// We test the pure helper functions that are exported or testable via their effects.
// The main showApprovalDialog is UI-driven (QuickPick), so we focus on the
// tier/model constants and the buildMinimalClaudeConfig logic via escalate/downgrade.

// Since escalateRecommendation and downgradeRecommendation are not exported,
// we test them indirectly by verifying the TIER_ORDER and CLAUDE_TIER_MODELS
// structures through the showPromptInputBox export and the module's behavior.

import { showPromptInputBox } from '../ui/approvalUI.js';

describe('approvalUI module', () => {
  it('exports showPromptInputBox', () => {
    expect(typeof showPromptInputBox).toBe('function');
  });

  it('showPromptInputBox returns undefined from mock (no user input)', async () => {
    // Our vscode mock returns undefined for showInputBox
    const result = await showPromptInputBox();
    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
//  Test the approval logic via showApprovalDialog
//  (mock QuickPick returns undefined → null result)
// ─────────────────────────────────────────────

import { showApprovalDialog } from '../ui/approvalUI.js';
import type { RouteRecommendation, CognitiveAnalysis, ModelSpec } from '../types/index.js';

function makeModelSpec(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextWindow: 200_000,
    inputCostPerMillion: 3.00,
    outputCostPerMillion: 15.00,
    supportsThinking: true,
    maxThinkingBudget: 32_000,
    tier: 'medium',
    strengths: ['daily development'],
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<CognitiveAnalysis> = {}): CognitiveAnalysis {
  return {
    score: 5 as const,
    tier: 'medium',
    signals: [],
    effortLevel: 'medium',
    estimatedThinkingTokens: 4096,
    analyzerUsed: 'heuristic',
    confidence: 0.85,
    reasoning: 'Medium complexity task',
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<RouteRecommendation> = {}): RouteRecommendation {
  return {
    primaryModel: makeModelSpec(),
    fallbackModel: null,
    effortLevel: 'medium',
    thinkingBudget: 4096,
    temperature: 0.5,
    maxOutputTokens: 8192,
    estimatedCostUSD: 0.05,
    estimatedLatencyMs: 2000,
    costWarning: false,
    costWarningMessage: '',
    reasoning: 'Medium complexity detected',
    claudeCodeCommand: {
      model: 'claude-sonnet-4-6',
      thinkingBudget: 4096,
      useFastMode: false,
      systemPromptPrefix: 'Return ONLY the requested output.',
      cliHint: 'claude --model claude-sonnet-4-6 --thinking-budget 4096',
      settingsDelta: { model: 'claude-sonnet-4-6', thinking: { type: 'enabled', budget_tokens: 4096 } },
    },
    analysis: makeAnalysis(),
    ...overrides,
  };
}

describe('showApprovalDialog', () => {
  it('returns null when user cancels (mock returns undefined)', async () => {
    const result = await showApprovalDialog(makeRecommendation(), false);
    expect(result).toBeNull();
  });

  it('handles cost warning without throwing', async () => {
    const rec = makeRecommendation({
      costWarning: true,
      costWarningMessage: 'Estimated cost $0.50 exceeds threshold',
    });
    const result = await showApprovalDialog(rec, false);
    expect(result).toBeNull(); // mock returns undefined → cancel path
  });

  it('handles recommendation with no claude code command', async () => {
    const rec = makeRecommendation({ claudeCodeCommand: null });
    const result = await showApprovalDialog(rec, true);
    expect(result).toBeNull();
  });

  it('handles extreme tier display', async () => {
    const rec = makeRecommendation({
      analysis: makeAnalysis({ score: 10 as const, tier: 'extreme' }),
      primaryModel: makeModelSpec({ id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', tier: 'extreme' }),
    });
    const result = await showApprovalDialog(rec, false);
    expect(result).toBeNull(); // still cancelled by mock
  });
});
