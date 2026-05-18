import { describe, it, expect } from 'vitest';
import { shouldCompress } from '../compression/contextCompressor.js';

// ─────────────────────────────────────────────
//  shouldCompress — decision logic
// ─────────────────────────────────────────────

describe('shouldCompress', () => {
  it('returns false for small contexts (<5k tokens)', () => {
    expect(shouldCompress(3_000, 2_000, 5.00)).toBe(false);
  });

  it('returns false for cheap primary models (<$1.5/MTok)', () => {
    // Even if context is large, compression is not worth it on Haiku ($1/MTok)
    expect(shouldCompress(50_000, 10_000, 1.00)).toBe(false);
  });

  it('returns false when overage fraction < 40%', () => {
    // context = 12k, budget = 10k → overage = 2k/12k = 16.7% < 40%
    expect(shouldCompress(12_000, 10_000, 5.00)).toBe(false);
  });

  it('returns true when Haiku savings exceed Haiku cost', () => {
    // context = 80k tokens, budget = 20k, primary cost = $5/MTok
    // Haiku cost: 80k/1M * $1 = $0.08
    // Expected saving: 80k * 0.6 / 1M * $5 = $0.24 > $0.08 ✓
    expect(shouldCompress(80_000, 20_000, 5.00)).toBe(true);
  });

  it('returns false when Haiku cost exceeds expected savings', () => {
    // context = 6k tokens, budget = 1k, primary cost = $2/MTok
    // Haiku cost: 6k/1M * $1 = $0.006
    // Expected saving: 6k * 0.6 / 1M * $2 = $0.0072 > $0.006 → borderline true
    // Let's use a case that clearly fails:
    // context = 6k, budget = 1k, primary cost = $1.5/MTok
    // Haiku cost: $0.006
    // Expected saving: 6k * 0.6 / 1M * $1.5 = $0.0054 < $0.006 ✓
    expect(shouldCompress(6_000, 1_000, 1.5)).toBe(false);
  });

  it('returns false when context equals budget (no overage)', () => {
    expect(shouldCompress(10_000, 10_000, 5.00)).toBe(false);
  });
});
