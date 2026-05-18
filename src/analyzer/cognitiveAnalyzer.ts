/**
 * Orca — LLM Cognitive Analyzer
 *
 * Uses Claude Haiku 4.5 as the "fast router" — a cheap, sub-second classifier
 * that reads the user's prompt and emits a structured JSON scoring object.
 *
 * Cost: Haiku 4.5 at $1.00/MTok input + $5.00/MTok output.
 * A typical 300-token analysis prompt + 150-token JSON response costs ~$0.001.
 * That's roughly 1,000 routing decisions per dollar — negligible.
 *
 * The analyzer caches the Anthropic client to avoid re-initializing on every call.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  CognitiveAnalysis,
  CognitiveLoadScore,
  PromptMetadata,
  RoutingTier,
  EffortLevel,
} from '../types/index.js';
import { effortToThinkingBudget } from './heuristicAnalyzer.js';

// ─────────────────────────────────────────────
//  Analyzer System Prompt
//  (Strict, no conversational filler — token efficient)
// ─────────────────────────────────────────────

const ANALYZER_SYSTEM_PROMPT = `You are a cognitive load classifier for a developer tooling system.
Your ONLY job: analyze a developer's prompt and output a JSON object. No preamble. No explanation. JSON only.

Output schema (all fields required):
{
  "score": <integer 1-10>,
  "tier": <"minimal"|"low"|"medium"|"high"|"extreme">,
  "effortLevel": <"none"|"low"|"medium"|"high"|"max">,
  "signals": [{"type": <"keyword"|"length"|"complexity"|"context"|"intent"|"multifile">, "label": <string>, "weight": <integer>}],
  "confidence": <float 0-1>,
  "reasoning": <string, max 120 chars>
}

Scoring guide:
1-2 (minimal): simple formatting, typos, rename, docstring, JSON transform, one-liner fix
3-4 (low): standard chat, simple function, unit test, short explanation, lookup
5-6 (medium): feature implementation, code review, debugging, data analysis, iterative coding
7-8 (high): refactoring, architecture design, security review, multi-file changes, complex debugging
9-10 (extreme): race conditions, distributed system design, mathematical proofs, agentic multi-step pipelines, deep adversarial analysis

Effort levels map to thinking token budgets:
none=0, low=1024, medium=4096, high=10000, max=32000

Be precise. Underestimating costs the user money on bad output. Overestimating wastes compute.`;

// ─────────────────────────────────────────────
//  LLM Response Shape
// ─────────────────────────────────────────────

interface LLMAnalysisResponse {
  score: number;
  tier: string;
  effortLevel: string;
  signals: Array<{ type: string; label: string; weight: number }>;
  confidence: number;
  reasoning: string;
}

// ─────────────────────────────────────────────
//  Client Cache
// ─────────────────────────────────────────────

let _client: Anthropic | null = null;
let _cachedApiKey = '';

function getClient(apiKey: string): Anthropic {
  if (!_client || _cachedApiKey !== apiKey) {
    _client = new Anthropic({ apiKey });
    _cachedApiKey = apiKey;
  }
  return _client;
}

// ─────────────────────────────────────────────
//  Tier & Effort Validation
// ─────────────────────────────────────────────

const VALID_TIERS: ReadonlySet<string> = new Set(['minimal', 'low', 'medium', 'high', 'extreme']);
const VALID_EFFORTS: ReadonlySet<string> = new Set(['none', 'low', 'medium', 'high', 'max']);

function safeTier(raw: string): RoutingTier {
  return VALID_TIERS.has(raw) ? (raw as RoutingTier) : 'medium';
}

function safeEffort(raw: string): EffortLevel {
  return VALID_EFFORTS.has(raw) ? (raw as EffortLevel) : 'medium';
}

// ─────────────────────────────────────────────
//  Main LLM Analyzer
// ─────────────────────────────────────────────

/**
 * Calls Haiku 4.5 to classify prompt complexity.
 * Falls back to a synthetic medium-score response on any error.
 */
export async function analyzeLLM(
  meta: PromptMetadata,
  apiKey: string,
): Promise<CognitiveAnalysis> {
  const client = getClient(apiKey);

  // Build a compact representation of the prompt + context metadata
  const userMessage = buildAnalyzerPrompt(meta);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: ANALYZER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('');

    return parseAnalyzerResponse(rawText);
  } catch (err) {
    // Graceful degradation: return a safe "medium" estimate
    const message = err instanceof Error ? err.message : String(err);
    return {
      score: 5 as CognitiveLoadScore,
      tier: 'medium',
      signals: [{ type: 'intent', label: 'LLM analyzer failed — defaulting to medium', weight: 0 }],
      effortLevel: 'medium',
      estimatedThinkingTokens: 4096,
      analyzerUsed: 'llm',
      confidence: 0.3,
      reasoning: `LLM analysis failed (${message.slice(0, 60)}). Fallback: medium complexity assumed.`,
    };
  }
}

// ─────────────────────────────────────────────
//  Prompt Builder
// ─────────────────────────────────────────────

function buildAnalyzerPrompt(meta: PromptMetadata): string {
  const lines: string[] = [
    `PROMPT (~${meta.estimatedPromptTokens} tokens):`,
    meta.prompt.slice(0, 800), // cap to avoid analyzer itself blowing budget
  ];

  if (meta.prompt.length > 800) {
    lines.push('[...prompt truncated for analysis...]');
  }

  lines.push('');
  lines.push('METADATA:');
  lines.push(`- Context files attached: ${meta.contextFileCount}`);
  lines.push(`- Context file tokens: ${meta.contextFileTokens}`);
  lines.push(`- Has code selection: ${meta.hasCodeSelection}`);
  if (meta.hasCodeSelection) {
    lines.push(`- Selection lines: ${meta.selectionLineCount}`);
  }
  lines.push(`- Total context tokens: ${meta.totalContextTokens}`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────
//  Response Parser
// ─────────────────────────────────────────────

function parseAnalyzerResponse(rawText: string): CognitiveAnalysis {
  // Extract JSON block (model may wrap it in ```json ... ```)
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON object found in LLM analyzer response');
  }

  const parsed = JSON.parse(jsonMatch[0]) as unknown as LLMAnalysisResponse;

  const score = Math.max(1, Math.min(10, Math.round(parsed.score))) as CognitiveLoadScore;
  const tier = safeTier(parsed.tier);
  const effortLevel = safeEffort(parsed.effortLevel);
  const confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.85));

  return {
    score,
    tier,
    signals: (parsed.signals ?? []).map(s => ({
      type: s.type as CognitiveAnalysis['signals'][number]['type'],
      label: String(s.label),
      weight: Number(s.weight),
    })),
    effortLevel,
    estimatedThinkingTokens: effortToThinkingBudget(effortLevel),
    analyzerUsed: 'llm',
    confidence,
    reasoning: String(parsed.reasoning ?? '').slice(0, 200),
  };
}
