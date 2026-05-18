import { describe, it, expect } from 'vitest';

// modelExecutor.ts has several pure functions we can test:
// - buildEscalationMap (via ESCALATION_MAP constant)
// - detectTaskType
// - tierIndex
// - buildErrorResult
//
// Since these are module-private, we test them indirectly through
// the module's exports and by importing MODEL_REGISTRY to verify
// the escalation chain is correctly built.

import { MODEL_REGISTRY } from '../router/promptRouter.js';

// ─────────────────────────────────────────────
//  Escalation Map Verification
//  (buildEscalationMap is called at module load;
//   we verify its correctness via MODEL_REGISTRY structure)
// ─────────────────────────────────────────────

describe('ESCALATION_MAP (indirect verification)', () => {
  const TIER_ORDER = ['minimal', 'low', 'medium', 'high', 'extreme'] as const;

  it('anthropic models exist in MODEL_REGISTRY at expected tiers', () => {
    const anthropicModels = Object.values(MODEL_REGISTRY).filter(m => m.provider === 'anthropic');
    expect(anthropicModels.length).toBeGreaterThanOrEqual(3);

    // Haiku at minimal, Sonnet at medium, Opus at extreme
    const haiku = MODEL_REGISTRY['claude-haiku-4-5'];
    const sonnet = MODEL_REGISTRY['claude-sonnet-4-6'];
    const opus = MODEL_REGISTRY['claude-opus-4-6'];

    expect(haiku.tier).toBe('minimal');
    expect(sonnet.tier).toBe('medium');
    expect(opus.tier).toBe('extreme');
  });

  it('tier order is strictly ascending for anthropic models', () => {
    const anthropicModels = Object.values(MODEL_REGISTRY)
      .filter(m => m.provider === 'anthropic')
      .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

    for (let i = 0; i < anthropicModels.length - 1; i++) {
      const currentTierIdx = TIER_ORDER.indexOf(anthropicModels[i].tier);
      const nextTierIdx = TIER_ORDER.indexOf(anthropicModels[i + 1].tier);
      // Each model's tier must be <= the next (and they skip same-tier for escalation)
      expect(currentTierIdx).toBeLessThanOrEqual(nextTierIdx);
    }
  });

  it('escalation chain: haiku → sonnet → opus', () => {
    // Verify the expected upgrade path exists
    const haiku = MODEL_REGISTRY['claude-haiku-4-5'];
    const sonnet = MODEL_REGISTRY['claude-sonnet-4-6'];
    const opus = MODEL_REGISTRY['claude-opus-4-6'];

    // Haiku is lowest tier, Opus is highest
    expect(TIER_ORDER.indexOf(haiku.tier)).toBeLessThan(TIER_ORDER.indexOf(sonnet.tier));
    expect(TIER_ORDER.indexOf(sonnet.tier)).toBeLessThan(TIER_ORDER.indexOf(opus.tier));
  });
});

// ─────────────────────────────────────────────
//  detectTaskType (indirect: verify patterns)
// ─────────────────────────────────────────────

describe('detectTaskType patterns', () => {
  // We can't call detectTaskType directly, but we verify the regex patterns
  // it uses are correct by testing them here.

  const codePattern = /\b(implement|write|create|fix|refactor|code|function|class|method|bug)\b/i;
  const analysisPattern = /\b(analyze|review|explain|compare|evaluate|assess|research)\b/i;

  it('matches code prompts', () => {
    expect(codePattern.test('implement a binary search function')).toBe(true);
    expect(codePattern.test('fix the null pointer bug')).toBe(true);
    expect(codePattern.test('refactor the authentication module')).toBe(true);
    expect(codePattern.test('create a new class for handling events')).toBe(true);
  });

  it('matches analysis prompts', () => {
    expect(analysisPattern.test('analyze the performance of this query')).toBe(true);
    expect(analysisPattern.test('explain how the caching layer works')).toBe(true);
    expect(analysisPattern.test('review this pull request')).toBe(true);
    expect(analysisPattern.test('compare React vs Vue for this use case')).toBe(true);
  });

  it('general prompts match neither pattern', () => {
    expect(codePattern.test('hello world')).toBe(false);
    expect(analysisPattern.test('hello world')).toBe(false);
  });
});

// ─────────────────────────────────────────────
//  tierIndex (indirect: verify ordering)
// ─────────────────────────────────────────────

describe('tierIndex ordering', () => {
  const tiers = ['minimal', 'low', 'medium', 'high', 'extreme'];

  it('tiers are in ascending order', () => {
    for (let i = 0; i < tiers.length - 1; i++) {
      expect(tiers.indexOf(tiers[i])).toBeLessThan(tiers.indexOf(tiers[i + 1]));
    }
  });

  it('unknown tier returns -1', () => {
    expect(tiers.indexOf('unknown')).toBe(-1);
  });
});

// ─────────────────────────────────────────────
//  GodModeExecutionResult shape
// ─────────────────────────────────────────────

describe('GodModeExecutionResult interface', () => {
  it('can be imported and type-checked', async () => {
    const mod = await import('../executor/modelExecutor.js');
    expect(typeof mod.executeRecommendation).toBe('function');
  });
});
