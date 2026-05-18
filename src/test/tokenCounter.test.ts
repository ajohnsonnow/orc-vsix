import { describe, it, expect } from 'vitest';
import {
  countTokensHeuristic,
  estimateImageTokens,
  estimateVideoTokens,
  getContextWindowStatus,
  MULTIMODAL_TOKEN_RATES,
} from '../diagnostics/tokenCounter.js';

// ─────────────────────────────────────────────
//  countTokensHeuristic
// ─────────────────────────────────────────────

describe('countTokensHeuristic', () => {
  it('returns 0 tokens for empty string', () => {
    const result = countTokensHeuristic('');
    expect(result.tokens).toBe(0);
    expect(result.method).toBe('heuristic');
    expect(result.confidence).toBe('high');
  });

  it('estimates English prose at ~4 chars/token', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
    const result = countTokensHeuristic(prose);
    // 450 chars / 4.0 = 113 tokens
    expect(result.tokens).toBe(Math.ceil(prose.length / 4.0));
    expect(result.method).toBe('heuristic');
    expect(result.confidence).toBe('medium');
  });

  it('estimates code at ~3.2 chars/token', () => {
    const code = 'import { foo } from "bar";\nconst x = foo();\nexport default x;';
    const result = countTokensHeuristic(code);
    expect(result.tokens).toBe(Math.ceil(code.length / 3.2));
  });

  it('detects code blocks and adjusts rate', () => {
    // Over 40% code block ratio triggers code rate
    const codeBlock = '```\nfunction foo() { return 42; }\n```';
    const padding = 'a'.repeat(10); // short padding so code ratio > 40%
    const text = padding + codeBlock;
    const result = countTokensHeuristic(text);
    expect(result.tokens).toBe(Math.ceil(text.length / 3.2));
  });

  it('detects JSON structure and adjusts rate', () => {
    const json = '{ "key": "value", "num": 42, "arr": [1, 2, 3] }';
    const result = countTokensHeuristic(json);
    expect(result.tokens).toBe(Math.ceil(json.length / 3.5));
  });

  it('uses prose rate for plain text', () => {
    const text = 'This is a simple paragraph of English text with no special formatting.';
    const result = countTokensHeuristic(text);
    expect(result.tokens).toBe(Math.ceil(text.length / 4.0));
  });
});

// ─────────────────────────────────────────────
//  estimateImageTokens
// ─────────────────────────────────────────────

describe('estimateImageTokens', () => {
  it('returns flat 258 tokens for small images (<=384px)', () => {
    expect(estimateImageTokens(200, 200, 'gemini')).toBe(258);
    expect(estimateImageTokens(384, 384, 'gemini')).toBe(258);
  });

  it('tiles large images at 768px increments', () => {
    // 1536x768 = 2 tiles x 1 tile = 2 * 258 = 516
    expect(estimateImageTokens(1536, 768, 'gemini')).toBe(2 * 258);
    // 769x769: ceil(769/768)=2 per axis → 2*2*258 = 1032
    expect(estimateImageTokens(769, 769, 'gemini')).toBe(4 * 258);
    // 1537x1537: ceil(1537/768)=3 per axis → 3*3*258 = 2322
    expect(estimateImageTokens(1537, 1537, 'gemini')).toBe(9 * 258);
  });
});

// ─────────────────────────────────────────────
//  estimateVideoTokens
// ─────────────────────────────────────────────

describe('estimateVideoTokens', () => {
  it('calculates tokens from duration and rate', () => {
    expect(estimateVideoTokens(10, 'gemini')).toBe(
      Math.ceil(10 * MULTIMODAL_TOKEN_RATES.gemini.videoTokensPerSecond),
    );
  });

  it('rounds up fractional tokens', () => {
    // 1.5s * 263 = 394.5 → 395
    expect(estimateVideoTokens(1.5, 'gemini')).toBe(395);
  });
});

// ─────────────────────────────────────────────
//  getContextWindowStatus
// ─────────────────────────────────────────────

describe('getContextWindowStatus', () => {
  it('returns correct percentages', () => {
    const status = getContextWindowStatus(50_000, 200_000);
    expect(status.usedPercent).toBe(25);
    expect(status.remainingTokens).toBe(150_000);
    expect(status.maxTokens).toBe(200_000);
    expect(status.recommendation).toBe('');
  });

  it('warns at 50% usage', () => {
    const status = getContextWindowStatus(110_000, 200_000);
    expect(status.usedPercent).toBeCloseTo(55);
    expect(status.recommendation).toContain('half full');
  });

  it('warns at 70% usage', () => {
    const status = getContextWindowStatus(150_000, 200_000);
    expect(status.usedPercent).toBe(75);
    expect(status.recommendation).toContain('70%');
  });

  it('critical at 90% usage', () => {
    const status = getContextWindowStatus(185_000, 200_000);
    expect(status.usedPercent).toBe(92.5);
    expect(status.recommendation).toContain('CRITICAL');
  });

  it('no recommendation below 50%', () => {
    const status = getContextWindowStatus(10_000, 200_000);
    expect(status.recommendation).toBe('');
  });
});
