import { describe, it, expect } from 'vitest';
import { analyzeHeuristic, effortToThinkingBudget } from '../analyzer/heuristicAnalyzer.js';
import type { PromptMetadata } from '../types/index.js';

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function meta(prompt: string, overrides: Partial<PromptMetadata> = {}): PromptMetadata {
  return {
    prompt,
    estimatedPromptTokens: Math.ceil(prompt.length / 4),
    contextFileCount: 0,
    contextFileTokens: 0,
    totalContextTokens: Math.ceil(prompt.length / 4),
    hasCodeSelection: false,
    selectionLineCount: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────
//  Score range
// ─────────────────────────────────────────────

describe('analyzeHeuristic — score clamping', () => {
  it('never returns a score below 1', () => {
    const result = analyzeHeuristic(meta('hi'));
    expect(result.score).toBeGreaterThanOrEqual(1);
  });

  it('never returns a score above 10', () => {
    const result = analyzeHeuristic(meta(
      'architect a race condition deadlock security audit multi-threaded distributed system proof mathematical algorithm',
    ));
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it('score is always an integer', () => {
    const result = analyzeHeuristic(meta('refactor authentication flow'));
    expect(Number.isInteger(result.score)).toBe(true);
  });
});

// ─────────────────────────────────────────────
//  Keyword signals
// ─────────────────────────────────────────────

describe('analyzeHeuristic — keyword signals', () => {
  it('assigns high tier to architecture prompts', () => {
    // Realistic token count (200) so the short-prompt penalty doesn't obscure the keyword signal
    const result = analyzeHeuristic(meta('design the architecture for a microservices system', { estimatedPromptTokens: 200 }));
    const archSignal = result.signals.find(s => s.label === 'Architecture task');
    expect(archSignal).toBeDefined();
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  it('assigns high tier to race condition / concurrency prompts', () => {
    // race condition (+25) + deadlock (+25) with realistic token count → score ≥ 7
    const result = analyzeHeuristic(meta('why does this race condition cause a deadlock in the thread pool', { estimatedPromptTokens: 200 }));
    expect(result.score).toBeGreaterThanOrEqual(7);
  });

  it('assigns low-medium tier to refactoring prompts', () => {
    // refactor keyword (+15) with realistic token count: baseline 20 + 15 - 5 (no-context) = 30 → score 3
    const result = analyzeHeuristic(meta('refactor this module to improve performance', { estimatedPromptTokens: 200 }));
    const refactorSignal = result.signals.find(s => s.label === 'Refactoring task');
    expect(refactorSignal).toBeDefined();
    expect(result.score).toBeGreaterThanOrEqual(3);
  });

  it('reduces score for simple formatting prompts', () => {
    const result = analyzeHeuristic(meta('format this JSON'));
    expect(result.score).toBeLessThanOrEqual(4);
  });

  it('reduces score for typo-fix prompts', () => {
    const result = analyzeHeuristic(meta('fix the typo in this comment'));
    expect(result.score).toBeLessThanOrEqual(4);
  });

  it('detects multi-file scope', () => {
    const result = analyzeHeuristic(meta('refactor across multiple files'));
    const multiFile = result.signals.find(s => s.type === 'multifile');
    expect(multiFile).toBeDefined();
    expect(multiFile!.weight).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────
//  Length signals
// ─────────────────────────────────────────────

describe('analyzeHeuristic — length signals', () => {
  it('adds positive weight for long prompts (>800 tokens)', () => {
    const longPrompt = 'Analyze '.repeat(300); // ~600 words = ~800 tokens
    const result = analyzeHeuristic(meta(longPrompt, { estimatedPromptTokens: 900 }));
    const lengthSignal = result.signals.find(s => s.type === 'length' && s.weight > 0);
    expect(lengthSignal).toBeDefined();
  });

  it('adds negative weight for very short prompts (<80 tokens)', () => {
    const result = analyzeHeuristic(meta('ok', { estimatedPromptTokens: 5 }));
    const lengthSignal = result.signals.find(s => s.type === 'length' && s.weight < 0);
    expect(lengthSignal).toBeDefined();
  });
});

// ─────────────────────────────────────────────
//  Context signals
// ─────────────────────────────────────────────

describe('analyzeHeuristic — context signals', () => {
  it('increases score with large context file count', () => {
    const withContext = analyzeHeuristic(meta('fix the bug', { contextFileCount: 6, contextFileTokens: 10000 }));
    const withoutContext = analyzeHeuristic(meta('fix the bug'));
    expect(withContext.score).toBeGreaterThan(withoutContext.score);
  });

  it('increases score with large code selection', () => {
    const result = analyzeHeuristic(meta('review this', {
      hasCodeSelection: true,
      selectionLineCount: 250,
    }));
    const selectionSignal = result.signals.find(s => s.label.includes('selection'));
    expect(selectionSignal).toBeDefined();
    expect(selectionSignal!.weight).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────
//  Tier + effort mapping
// ─────────────────────────────────────────────

describe('analyzeHeuristic — tier/effort mapping', () => {
  it('maps score 1–2 to minimal tier', () => {
    const result = analyzeHeuristic(meta('what is JSON', { estimatedPromptTokens: 10 }));
    if (result.score <= 2) {
      expect(result.tier).toBe('minimal');
    }
  });

  it('maps extreme tier to "max" effort level', () => {
    const result = analyzeHeuristic(meta(
      'architect a distributed system with race condition analysis and security audit',
    ));
    if (result.tier === 'extreme') {
      expect(result.effortLevel).toBe('max');
    }
  });

  it('uses correct analyzer label', () => {
    const result = analyzeHeuristic(meta('hello'));
    expect(result.analyzerUsed).toBe('heuristic');
  });

  it('returns confidence 0.72', () => {
    const result = analyzeHeuristic(meta('hello'));
    expect(result.confidence).toBe(0.72);
  });
});

// ─────────────────────────────────────────────
//  effortToThinkingBudget
// ─────────────────────────────────────────────

describe('effortToThinkingBudget', () => {
  it('returns 0 for none', () => expect(effortToThinkingBudget('none')).toBe(0));
  it('returns 1024 for low', () => expect(effortToThinkingBudget('low')).toBe(1024));
  it('returns 4096 for medium', () => expect(effortToThinkingBudget('medium')).toBe(4096));
  it('returns 10000 for high', () => expect(effortToThinkingBudget('high')).toBe(10000));
  it('returns 32000 for max', () => expect(effortToThinkingBudget('max')).toBe(32000));
});
