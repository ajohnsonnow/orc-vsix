import { describe, it, expect } from 'vitest';
import { buildRecommendation, MODEL_REGISTRY, resolveLocalCoder } from '../router/promptRouter.js';
import type { CognitiveAnalysis, RoutingTier } from '../types/index.js';

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function fakeAnalysis(tier: RoutingTier, score: number = 5): CognitiveAnalysis {
  const effortMap = { minimal: 'none', low: 'low', medium: 'medium', high: 'high', extreme: 'max' } as const;
  const thinkingMap = { none: 0, low: 1024, medium: 4096, high: 10000, max: 32000 } as const;
  const effort = effortMap[tier];
  return {
    score: score as CognitiveAnalysis['score'],
    tier,
    signals: [],
    effortLevel: effort,
    estimatedThinkingTokens: thinkingMap[effort],
    analyzerUsed: 'heuristic',
    confidence: 0.72,
    reasoning: 'test',
  };
}

const meta = { totalContextTokens: 1000 };

// ─────────────────────────────────────────────
//  MODEL_REGISTRY
// ─────────────────────────────────────────────

describe('MODEL_REGISTRY', () => {
  it('contains at least 9 models', () => {
    expect(Object.keys(MODEL_REGISTRY).length).toBeGreaterThanOrEqual(9);
  });

  it('all Anthropic models have supportsThinking correctly set', () => {
    const haiku = MODEL_REGISTRY['claude-haiku-4-5'];
    const sonnet = MODEL_REGISTRY['claude-sonnet-4-6'];
    const opus = MODEL_REGISTRY['claude-opus-4-8'];
    expect(haiku.supportsThinking).toBe(false);
    expect(sonnet.supportsThinking).toBe(true);
    expect(opus.supportsThinking).toBe(true);
    expect(MODEL_REGISTRY['claude-fable-5'].supportsThinking).toBe(true);
    expect(MODEL_REGISTRY['claude-fable-5'].alwaysThinking).toBe(true);
  });

  it('flagship models have 1M context window', () => {
    expect(MODEL_REGISTRY['claude-opus-4-8'].contextWindow).toBe(1_000_000);
    expect(MODEL_REGISTRY['claude-fable-5'].contextWindow).toBe(1_000_000);
  });

  it('every model has a valid provider', () => {
    const validProviders = new Set(['anthropic', 'openai', 'google', 'deepseek', 'local']);
    for (const m of Object.values(MODEL_REGISTRY)) {
      expect(validProviders.has(m.provider)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────
//  Claude bias routing
// ─────────────────────────────────────────────

describe('buildRecommendation — claude bias', () => {
  it('routes minimal tier to Haiku', () => {
    const rec = buildRecommendation(fakeAnalysis('minimal'), meta, 'claude', 0.10);
    expect(rec.primaryModel.provider).toBe('anthropic');
    expect(rec.primaryModel.id).toContain('haiku');
  });

  it('routes medium tier to Sonnet', () => {
    const rec = buildRecommendation(fakeAnalysis('medium'), meta, 'claude', 0.10);
    expect(rec.primaryModel.id).toContain('sonnet');
  });

  it('routes high tier to Opus 4.8', () => {
    const rec = buildRecommendation(fakeAnalysis('high'), meta, 'claude', 0.10);
    expect(rec.primaryModel.id).toBe('claude-opus-4-8');
  });

  it('routes extreme tier to Fable 5', () => {
    const rec = buildRecommendation(fakeAnalysis('extreme'), meta, 'claude', 0.10);
    expect(rec.primaryModel.id).toBe('claude-fable-5');
  });

  it('always returns an Anthropic model for claude bias', () => {
    for (const tier of ['minimal', 'low', 'medium', 'high', 'extreme'] as RoutingTier[]) {
      const rec = buildRecommendation(fakeAnalysis(tier), meta, 'claude', 0.10);
      expect(rec.primaryModel.provider).toBe('anthropic');
    }
  });
});

// ─────────────────────────────────────────────
//  Thinking budget
// ─────────────────────────────────────────────

describe('buildRecommendation — thinking budget', () => {
  it('sets thinking budget to 0 for Haiku (no thinking support)', () => {
    const rec = buildRecommendation(fakeAnalysis('minimal'), meta, 'claude', 0.10);
    expect(rec.thinkingBudget).toBe(0);
  });

  it('sets positive thinking budget for Sonnet (medium+)', () => {
    const rec = buildRecommendation(fakeAnalysis('medium'), meta, 'claude', 0.10);
    expect(rec.thinkingBudget).toBeGreaterThan(0);
    expect(rec.thinkingBudget).toBeLessThanOrEqual(32_000);
  });

  it('never exceeds model.maxThinkingBudget', () => {
    for (const tier of ['medium', 'high', 'extreme'] as RoutingTier[]) {
      const rec = buildRecommendation(fakeAnalysis(tier, 9), meta, 'claude', 0.10);
      expect(rec.thinkingBudget).toBeLessThanOrEqual(rec.primaryModel.maxThinkingBudget);
    }
  });
});

// ─────────────────────────────────────────────
//  Temperature
// ─────────────────────────────────────────────

describe('buildRecommendation — temperature', () => {
  it('sets temperature 0.0 for minimal tier', () => {
    const rec = buildRecommendation(fakeAnalysis('minimal'), meta, 'claude', 0.10);
    expect(rec.temperature).toBe(0.0);
  });

  it('sets temperature 1.0 for extreme tier', () => {
    const rec = buildRecommendation(fakeAnalysis('extreme'), meta, 'claude', 0.10);
    expect(rec.temperature).toBe(1.0);
  });
});

// ─────────────────────────────────────────────
//  Cost warning
// ─────────────────────────────────────────────

describe('buildRecommendation — cost warning', () => {
  it('triggers costWarning when estimated cost exceeds threshold', () => {
    // Force a large context to push cost over threshold
    const bigMeta = { totalContextTokens: 500_000 };
    const rec = buildRecommendation(fakeAnalysis('extreme'), bigMeta, 'claude', 0.01);
    expect(rec.costWarning).toBe(true);
    expect(rec.costWarningMessage.length).toBeGreaterThan(0);
  });

  it('does not trigger costWarning for cheap prompts', () => {
    const rec = buildRecommendation(fakeAnalysis('minimal'), meta, 'claude', 10.00);
    expect(rec.costWarning).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  ClaudeCodeConfig
// ─────────────────────────────────────────────

describe('buildRecommendation — claudeCodeCommand', () => {
  it('generates claudeCodeCommand for Anthropic models', () => {
    const rec = buildRecommendation(fakeAnalysis('medium'), meta, 'claude', 0.10);
    expect(rec.claudeCodeCommand).not.toBeNull();
    expect(rec.claudeCodeCommand!.model).toContain('sonnet');
  });

  it('returns null claudeCodeCommand for non-Anthropic models', () => {
    const rec = buildRecommendation(fakeAnalysis('medium'), meta, 'cost', 0.10);
    // Cost bias at medium tier may pick a non-Anthropic model
    if (rec.primaryModel.provider !== 'anthropic') {
      expect(rec.claudeCodeCommand).toBeNull();
    }
  });

  it('settingsDelta always contains model key', () => {
    const rec = buildRecommendation(fakeAnalysis('high'), meta, 'claude', 0.10);
    expect(rec.claudeCodeCommand!.settingsDelta['model']).toBeDefined();
  });
});

// ─────────────────────────────────────────────
//  Hybrid routing (local code, Claude plan)
// ─────────────────────────────────────────────

describe('hybrid bias routing', () => {
  it('routes code tasks to a free local model', () => {
    const rec = buildRecommendation(fakeAnalysis('high'), meta, 'hybrid', 0.10, 'code');
    expect(rec.primaryModel.provider).toBe('local');
    expect(rec.estimatedCostUSD).toBe(0);
    expect(rec.claudeCodeCommand).toBeNull();
  });

  it('uses the configured local coder when provided', () => {
    const coder = resolveLocalCoder('my-custom-coder-7b');
    const rec = buildRecommendation(fakeAnalysis('high'), meta, 'hybrid', 0.10, 'code', coder);
    expect(rec.primaryModel.id).toBe('my-custom-coder-7b');
    expect(rec.primaryModel.provider).toBe('local');
  });

  it('falls back to a Claude model for code tasks (fallbackModel)', () => {
    const rec = buildRecommendation(fakeAnalysis('high'), meta, 'hybrid', 0.10, 'code');
    expect(rec.fallbackModel?.provider).toBe('anthropic');
  });

  it('routes non-code (plan/analysis) tasks to Claude', () => {
    const rec = buildRecommendation(fakeAnalysis('high'), meta, 'hybrid', 0.10, 'analysis');
    expect(rec.primaryModel.provider).toBe('anthropic');
    expect(rec.primaryModel.id).toContain('opus');
  });

  it('defaults a known local coder model id', () => {
    expect(resolveLocalCoder().id).toBe('qwen2.5-coder-32b-instruct');
    expect(resolveLocalCoder().provider).toBe('local');
  });
});
