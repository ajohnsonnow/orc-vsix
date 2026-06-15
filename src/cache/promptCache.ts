/**
 * Orca — Prompt Caching Module
 *
 * Implements Anthropic's prompt caching (cache_control breakpoints) —
 * the single highest-ROI optimization from the 2026 economics research.
 * Cache reads cost ~10x less than fresh input tokens (90% discount).
 *
 * Strategy (matches Anthropic's ordering requirement):
 *   1. Static system prompt   → cache_control: { type: "ephemeral" }
 *   2. Large document context → cache_control: { type: "ephemeral" }
 *   3. Dynamic user prompt    → no cache (changes every request)
 *
 * Cache hit detection: Anthropic returns cache_creation_input_tokens
 * and cache_read_input_tokens in usage — we track both for reporting.
 *
 * Cost model (Anthropic):
 *   Cache write:  ~25% more than standard input (one-time cost)
 *   Cache read:   ~10% of standard input (every subsequent hit)
 *   Break-even:   2+ identical calls to the same static prefix
 *
 * Important: Cached content must be ≥ 1024 tokens to qualify.
 * The first 1024 tokens of any block are never cached.
 */

import type Anthropic from '@anthropic-ai/sdk';

// ─────────────────────────────────────────────
//  Cache-Aware Message Builder
// ─────────────────────────────────────────────

export interface CacheAwarePayload {
  system: Anthropic.Messages.TextBlockParam[];
  messages: Anthropic.Messages.MessageParam[];
  /** True if at least one cache_control breakpoint was injected */
  hasCacheBreakpoints: boolean;
  /** Estimated tokens in the cacheable prefix */
  cacheableTokens: number;
}

/**
 * Builds an Anthropic message payload with cache_control breakpoints
 * placed at the optimal positions per Anthropic's ordering rules.
 *
 * @param systemPrompt    The static behavioral instruction (stable across calls)
 * @param contextDocument Large reference doc / code file (stable per session)
 * @param userPrompt      The dynamic user query (never cached)
 * @param estimateTokens  Token estimator function
 */
export function buildCacheAwarePayload(
  systemPrompt: string,
  contextDocument: string,
  userPrompt: string,
  estimateTokens: (text: string) => number,
): CacheAwarePayload {
  // Anthropic minimum: 1024 tokens for Haiku/Sonnet/Opus 4.8; 512 for Fable 5.
  // We use 1024 here — the correct standard-model floor from Anthropic's docs.
  const MIN_CACHEABLE_TOKENS = 1024;

  const systemTokens = estimateTokens(systemPrompt);
  const contextTokens = estimateTokens(contextDocument);
  let hasCacheBreakpoints = false;
  let cacheableTokens = 0;

  // ── System blocks ────────────────────────────
  // Anthropic requires system to be an array of TextBlockParam when using cache_control
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [];

  if (systemPrompt.trim()) {
    const block: Anthropic.Messages.TextBlockParam = { type: 'text', text: systemPrompt };
    if (systemTokens >= MIN_CACHEABLE_TOKENS) {
      // Cast to any to attach cache_control (not yet in SDK types for all versions)
      (block as unknown as Record<string, unknown>)['cache_control'] = { type: 'ephemeral' };
      hasCacheBreakpoints = true;
      cacheableTokens += systemTokens;
    }
    systemBlocks.push(block);
  }

  // ── User message: context document + query ───
  // Documents go first (stable prefix), query goes last (dynamic suffix)
  const userContentParts: Anthropic.Messages.ContentBlockParam[] = [];

  if (contextDocument.trim() && contextTokens >= MIN_CACHEABLE_TOKENS) {
    const docBlock: Anthropic.Messages.TextBlockParam = {
      type: 'text',
      text: `<editor_context>\n${contextDocument}\n</editor_context>`,
    };
    (docBlock as unknown as Record<string, unknown>)['cache_control'] = { type: 'ephemeral' };
    userContentParts.push(docBlock);
    hasCacheBreakpoints = true;
    cacheableTokens += contextTokens;
  } else if (contextDocument.trim()) {
    // Context too small to cache — still include it, just without breakpoint
    userContentParts.push({ type: 'text', text: `<editor_context>\n${contextDocument}\n</editor_context>` });
  }

  // Dynamic user prompt — always last, never cached
  userContentParts.push({ type: 'text', text: userPrompt });

  const singleTextPart = userContentParts.length === 1 && userContentParts[0].type === 'text'
    ? userContentParts[0].text
    : null;
  const userContent = singleTextPart ?? userContentParts;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userContent },
  ];

  return { system: systemBlocks, messages, hasCacheBreakpoints, cacheableTokens };
}

// ─────────────────────────────────────────────
//  Cache Stats Extractor
// ─────────────────────────────────────────────

export interface CacheStats {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  regularInputTokens: number;
  /** Savings vs. paying full price for all input tokens */
  estimatedSavingsUSD: number;
  wasAHit: boolean;
}

/**
 * Extracts cache usage from an Anthropic API response's usage object.
 * Calculates savings vs. paying fresh for all input tokens.
 */
export function extractCacheStats(
  usage: {
    input_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  inputCostPerMillion: number,
): CacheStats {
  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
  const regularInputTokens = usage.input_tokens;

  // Cache reads cost 10% of normal; cache writes cost 125% of normal
  const writeMultiplier = 1.25;
  const readMultiplier = 0.10;

  const actualCost =
    (regularInputTokens / 1_000_000) * inputCostPerMillion +
    (cacheCreationInputTokens / 1_000_000) * inputCostPerMillion * writeMultiplier +
    (cacheReadInputTokens / 1_000_000) * inputCostPerMillion * readMultiplier;

  const fullPriceCost =
    ((regularInputTokens + cacheCreationInputTokens + cacheReadInputTokens) / 1_000_000) * inputCostPerMillion;

  const estimatedSavingsUSD = Math.max(0, fullPriceCost - actualCost);

  return {
    cacheCreationInputTokens,
    cacheReadInputTokens,
    regularInputTokens,
    estimatedSavingsUSD,
    wasAHit: cacheReadInputTokens > 0,
  };
}

// ─────────────────────────────────────────────
//  Context Ordering Enforcer
// ─────────────────────────────────────────────

/**
 * Validates that the user's context is ordered correctly for cache maximization.
 * Returns a warning if dynamic content appears before static content.
 *
 * Google's rule (also best practice for Anthropic):
 *   STABLE content (system prompt, docs, tools) → FIRST
 *   DYNAMIC content (user query, timestamps)    → LAST
 */
export function validateCacheOrdering(
  systemPrompt: string,
  contextDocument: string,
  userPrompt: string,
): { isOptimal: boolean; warning: string } {
  // Check if dynamic markers (timestamps, random IDs) appear in system prompt
  const dynamicPattern = /\b(timestamp|date|time|uuid|random|nonce)\b/i;
  if (dynamicPattern.test(systemPrompt)) {
    return {
      isOptimal: false,
      warning: 'System prompt contains dynamic content (timestamps/IDs). ' +
        'Move these to the user message to maximize cache hits.',
    };
  }

  // If context is shorter than prompt — ordering might be suboptimal
  const estimateLen = (s: string) => s.length;
  if (contextDocument.length > 0 && estimateLen(contextDocument) < estimateLen(userPrompt) * 0.5) {
    return {
      isOptimal: false,
      warning: 'Context document is shorter than the prompt. ' +
        'Consider placing all stable reference material in the context for better cache efficiency.',
    };
  }

  return { isOptimal: true, warning: '' };
}
