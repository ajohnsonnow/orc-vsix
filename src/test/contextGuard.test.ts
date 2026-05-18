import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runContextGuard,
  checkPeakHourWindow,
  analyzeTierFit,
  MAX_CONTEXT_TOKENS,
} from '../diagnostics/contextGuard.js';
import type { PromptMetadata } from '../types/index.js';

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function meta(overrides: Partial<PromptMetadata> = {}): PromptMetadata {
  return {
    prompt: 'fix the bug',
    estimatedPromptTokens: 100,
    contextFileCount: 0,
    contextFileTokens: 0,
    totalContextTokens: 100,
    hasCodeSelection: false,
    selectionLineCount: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────
//  MAX_CONTEXT_TOKENS
// ─────────────────────────────────────────────

describe('MAX_CONTEXT_TOKENS', () => {
  it('defines all 5 tiers', () => {
    const tiers = ['minimal', 'low', 'medium', 'high', 'extreme'] as const;
    for (const t of tiers) {
      expect(MAX_CONTEXT_TOKENS[t]).toBeGreaterThan(0);
    }
  });

  it('tokens increase with tier', () => {
    expect(MAX_CONTEXT_TOKENS.minimal).toBeLessThan(MAX_CONTEXT_TOKENS.low);
    expect(MAX_CONTEXT_TOKENS.low).toBeLessThan(MAX_CONTEXT_TOKENS.medium);
    expect(MAX_CONTEXT_TOKENS.medium).toBeLessThan(MAX_CONTEXT_TOKENS.high);
    expect(MAX_CONTEXT_TOKENS.high).toBeLessThan(MAX_CONTEXT_TOKENS.extreme);
  });
});

// ─────────────────────────────────────────────
//  runContextGuard — clean context
// ─────────────────────────────────────────────

describe('runContextGuard — clean context', () => {
  it('returns empty diagnostics for small well-proportioned context', () => {
    const report = runContextGuard(meta({ contextFileTokens: 500, estimatedPromptTokens: 200 }), 'medium');
    const nonPeak = report.diagnostics.filter(d => d.id !== 'peak-hour-throttle');
    expect(nonPeak).toHaveLength(0);
    expect(report.shouldProceed).toBe(true);
  });
});

// ─────────────────────────────────────────────
//  runContextGuard — attention dilution
// ─────────────────────────────────────────────

describe('runContextGuard — attention dilution', () => {
  it('fires critical warning when context is >2x max ratio for tier', () => {
    // minimal tier max ratio = 5; use 15x ratio → should fire critical
    const report = runContextGuard(meta({
      estimatedPromptTokens: 100,
      contextFileTokens: 1500,   // 15x the prompt — over 2× the minimal threshold (5×)
    }), 'minimal');
    const critical = report.diagnostics.filter(d => d.severity === 'critical');
    expect(critical.length).toBeGreaterThan(0);
    expect(report.hasCritical).toBe(true);
    expect(report.shouldProceed).toBe(false);
  });

  it('fires warning (not critical) when context is between 1x and 2x max ratio', () => {
    // minimal max ratio = 5; use 7x → warning
    const report = runContextGuard(meta({
      estimatedPromptTokens: 100,
      contextFileTokens: 700,    // 7x
    }), 'minimal');
    const warnings = report.diagnostics.filter(d => d.severity === 'warning' && d.id === 'context-ratio-warning');
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────
//  runContextGuard — absolute size
// ─────────────────────────────────────────────

describe('runContextGuard — absolute context size', () => {
  it('fires critical when context tokens exceed 2× tier limit', () => {
    // minimal max = 5000; 2× = 10000; use 12000
    const report = runContextGuard(meta({
      contextFileTokens: 12_000,
      estimatedPromptTokens: 100,
    }), 'minimal');
    const critical = report.diagnostics.filter(d => d.id === 'context-absolute-critical');
    expect(critical.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────
//  runContextGuard — lost in middle
// ─────────────────────────────────────────────

describe('runContextGuard — lost-in-middle', () => {
  it('fires when 4+ files and >20k total tokens', () => {
    const report = runContextGuard(meta({
      contextFileCount: 5,
      totalContextTokens: 25_000,
      contextFileTokens: 24_000,
      estimatedPromptTokens: 1_000,
    }), 'high');
    const litm = report.diagnostics.find(d => d.id === 'lost-in-middle');
    expect(litm).toBeDefined();
  });

  it('does not fire for fewer than 4 files', () => {
    const report = runContextGuard(meta({
      contextFileCount: 3,
      totalContextTokens: 25_000,
    }), 'high');
    const litm = report.diagnostics.find(d => d.id === 'lost-in-middle');
    expect(litm).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
//  checkPeakHourWindow
// ─────────────────────────────────────────────

describe('checkPeakHourWindow', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('returns null outside peak hours (e.g. 11 PM PT = 6 UTC off-peak)', () => {
    // 23:00 PT (7 AM PT next day is outside window)
    // Actually let's use UTC 7:00 = 23:00 PST (UTC-8) — well outside 5–11 AM
    vi.setSystemTime(new Date('2026-01-15T07:00:00Z')); // 11 PM PST
    const result = checkPeakHourWindow();
    expect(result).toBeNull();
  });

  it('returns diagnostic during peak hours (e.g. 8 AM PT = 16 UTC)', () => {
    // 16:00 UTC = 8:00 AM PST (UTC-8, Jan = winter = PST)
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z')); // 8 AM PST
    const result = checkPeakHourWindow();
    expect(result).not.toBeNull();
    expect(result!.id).toBe('peak-hour-throttle');
    expect(result!.severity).toBe('warning');
  });
});

// ─────────────────────────────────────────────
//  analyzeTierFit
// ─────────────────────────────────────────────

describe('analyzeTierFit', () => {
  // Build session at test-run time so Date.now() uses real system time
  // (avoids interference from vi.setSystemTime in the checkPeakHourWindow suite)
  function makeSession(overrides: Partial<{
    totalInputTokens: number;
    totalOutputTokens: number;
    totalThinkingTokens: number;
    totalPrompts: number;
    sessionStartMs: number;
  }> = {}) {
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalThinkingTokens: 0,
      totalPrompts: 5,
      sessionStartMs: Date.now() - 5 * 60_000, // 5 minutes ago
      ...overrides,
    };
  }

  it('recommends no upgrade at low burn rate', () => {
    const advice = analyzeTierFit(makeSession({ totalInputTokens: 500, totalOutputTokens: 500 }));
    expect(advice.shouldUpgrade).toBe(false);
  });

  it('recommends Max 5x upgrade at >1000 tok/min', () => {
    // 10k tokens / 5 min = 2000 tok/min
    const advice = analyzeTierFit(makeSession({ totalInputTokens: 8000, totalOutputTokens: 2000 }));
    expect(advice.shouldUpgrade).toBe(true);
    expect(advice.recommendedTier).toContain('5x');
  });

  it('recommends Max 20x upgrade at >5000 tok/min', () => {
    // 30k tokens / 5 min = 6000 tok/min
    const advice = analyzeTierFit(makeSession({ totalInputTokens: 25_000, totalOutputTokens: 5_000 }));
    expect(advice.shouldUpgrade).toBe(true);
    expect(advice.recommendedTier).toContain('20x');
  });
});
