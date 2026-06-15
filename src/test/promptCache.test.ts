import { describe, it, expect } from 'vitest';
import { buildCacheAwarePayload, extractCacheStats, validateCacheOrdering } from '../cache/promptCache.js';

const estimate = (t: string) => Math.ceil(t.length / 4);

// ─────────────────────────────────────────────
//  buildCacheAwarePayload
// ─────────────────────────────────────────────

describe('buildCacheAwarePayload', () => {
  it('does not add cache breakpoint when system prompt < 4096 tokens', () => {
    const { hasCacheBreakpoints, cacheableTokens } = buildCacheAwarePayload(
      'Short system prompt.',
      '',
      'user query',
      estimate,
    );
    expect(hasCacheBreakpoints).toBe(false);
    expect(cacheableTokens).toBe(0);
  });

  it('adds cache breakpoint when system prompt >= 4096 tokens', () => {
    const largeSystem = 'x'.repeat(4096 * 4); // ~4096 tokens
    const { hasCacheBreakpoints, cacheableTokens } = buildCacheAwarePayload(
      largeSystem,
      '',
      'user query',
      estimate,
    );
    expect(hasCacheBreakpoints).toBe(true);
    expect(cacheableTokens).toBeGreaterThanOrEqual(4096);
  });

  it('adds cache breakpoint on context document when >= 4096 tokens', () => {
    const largeContext = 'function foo() { '.repeat(1000); // ~4250 tokens via char/4
    const { hasCacheBreakpoints, cacheableTokens } = buildCacheAwarePayload(
      'Small system.',
      largeContext,
      'user query',
      estimate,
    );
    // Only context gets a breakpoint; system is too small
    expect(cacheableTokens).toBeGreaterThan(0);
    if (estimate(largeContext) >= 4096) {
      expect(hasCacheBreakpoints).toBe(true);
    }
  });

  it('always includes the user prompt in messages', () => {
    const { messages } = buildCacheAwarePayload('sys', '', 'hello world', estimate);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe('user');
    const content = messages[0].content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    expect(text).toContain('hello world');
  });

  it('returns empty system array when system prompt is empty', () => {
    const { system } = buildCacheAwarePayload('', '', 'query', estimate);
    expect(system).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
//  extractCacheStats
// ─────────────────────────────────────────────

describe('extractCacheStats', () => {
  it('reports wasAHit = false when no cache read tokens', () => {
    const stats = extractCacheStats(
      { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      3.0,
    );
    expect(stats.wasAHit).toBe(false);
  });

  it('reports wasAHit = true when cache read tokens > 0', () => {
    const stats = extractCacheStats(
      { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 },
      3.0,
    );
    expect(stats.wasAHit).toBe(true);
  });

  it('calculates positive savings on cache hit', () => {
    // 10k tokens read from cache at 10% cost vs paying full price
    const stats = extractCacheStats(
      { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 10000 },
      3.0,
    );
    expect(stats.estimatedSavingsUSD).toBeGreaterThan(0);
  });

  it('cache write costs 1.25x normal input', () => {
    // Write 1M tokens: cost = 1M/1M * 3.0 * 1.25 = $3.75
    const stats = extractCacheStats(
      { input_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 0 },
      3.0,
    );
    // Full price would be $3.00; actual is $3.75 → savings = -$0.75 → clamped to 0
    expect(stats.estimatedSavingsUSD).toBe(0);
  });

  it('savings are never negative', () => {
    const stats = extractCacheStats(
      { input_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 0 },
      3.0,
    );
    expect(stats.estimatedSavingsUSD).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────
//  validateCacheOrdering
// ─────────────────────────────────────────────

describe('validateCacheOrdering', () => {
  it('flags dynamic content (timestamp) in system prompt', () => {
    const result = validateCacheOrdering(
      'System created at timestamp 2026-01-01.',
      'context doc',
      'user query',
    );
    expect(result.isOptimal).toBe(false);
    expect(result.warning.length).toBeGreaterThan(0);
  });

  it('returns isOptimal = true for clean static system prompt', () => {
    const result = validateCacheOrdering(
      'You are a code assistant.',
      'function foo() {}',
      'fix the bug',
    );
    expect(result.isOptimal).toBe(true);
    expect(result.warning).toBe('');
  });

  it('warns when context is much shorter than prompt', () => {
    const result = validateCacheOrdering(
      'System.',
      'small',
      'This is a very long user prompt that contains a lot of text and information ' +
      'that the model needs to process carefully.',
    );
    expect(result.isOptimal).toBe(false);
  });
});
