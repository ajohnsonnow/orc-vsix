/**
 * Orca — Heuristic Cognitive Analyzer
 *
 * Rule-based complexity scoring that requires no API key and runs in <1ms.
 * Used as the fallback when no Anthropic key is configured, or as the first
 * pass in "auto" mode to decide whether an LLM classifier is worth the cost.
 *
 * Scoring is additive: each signal contributes a weighted amount to a 0–100
 * raw score, which is then clamped to the 1–10 CognitiveLoadScore scale.
 */

import type {
  CognitiveAnalysis,
  CognitiveLoadScore,
  EffortLevel,
  PromptMetadata,
  RoutingTier,
  AnalysisSignal,
} from '../types/index.js';

// ─────────────────────────────────────────────
//  Keyword Signal Tables
// ─────────────────────────────────────────────

/** High-complexity keywords — architecture, security, deep reasoning */
const HIGH_COMPLEXITY_KEYWORDS: ReadonlyArray<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /\barchitect(ure|ing|ed)?\b/i,          label: 'Architecture task',        weight: 20 },
  { pattern: /\brefactor\b/i,                         label: 'Refactoring task',         weight: 15 },
  { pattern: /\brace\s+condition\b/i,                 label: 'Concurrency issue',        weight: 25 },
  { pattern: /\bdeadlock\b/i,                         label: 'Deadlock analysis',        weight: 25 },
  { pattern: /\bsecurity\s+(audit|review|flaw|gap)\b/i, label: 'Security review',       weight: 20 },
  { pattern: /\bvulnerab(ility|le)\b/i,               label: 'Vulnerability analysis',   weight: 20 },
  { pattern: /\bperformance\s+(bottleneck|profil|optim)\b/i, label: 'Perf analysis',     weight: 18 },
  { pattern: /\bmigrat(e|ion|ing)\b.*\bdat(a|abase)\b/i, label: 'Data migration',       weight: 18 },
  { pattern: /\bdesign\s+(pattern|system|trade.?off)\b/i, label: 'Design analysis',     weight: 15 },
  { pattern: /\bcomplex\b/i,                          label: 'Explicit complexity',      weight: 10 },
  { pattern: /\boptimiz(e|ation)\b/i,                 label: 'Optimization task',        weight: 15 },
  { pattern: /\bmulti.?(thread|process|worker)\b/i,   label: 'Concurrency design',       weight: 20 },
  { pattern: /\bauth(entication|orization)\s+flow\b/i, label: 'Auth flow',              weight: 15 },
  { pattern: /\bproof\b.*\b(math|algorithm|correct)\b/i, label: 'Mathematical proof',  weight: 25 },
  { pattern: /\bwhy\s+(is|does|did|should)\b.*\bfail\b/i, label: 'Root cause analysis', weight: 15 },
];

/** Medium-complexity keywords — standard development tasks */
const MEDIUM_COMPLEXITY_KEYWORDS: ReadonlyArray<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /\bimplement\b/i,        label: 'Implementation task',  weight: 8 },
  { pattern: /\bintegrat(e|ion)\b/i,  label: 'Integration task',     weight: 8 },
  { pattern: /\bunit\s+test\b/i,      label: 'Test writing',         weight: 6 },
  { pattern: /\bdebug\b/i,            label: 'Debugging task',        weight: 8 },
  { pattern: /\banalyze\b/i,          label: 'Analysis task',        weight: 8 },
  { pattern: /\breviewing?\b/i,       label: 'Code review',          weight: 7 },
  { pattern: /\bexplain\b/i,          label: 'Explanation task',     weight: 5 },
  { pattern: /\brefin(e|ing)\b/i,     label: 'Refinement task',      weight: 6 },
  { pattern: /\bapi\s+design\b/i,     label: 'API design',           weight: 8 },
  { pattern: /\bsql\b.*\boptim\b/i,   label: 'SQL optimization',     weight: 10 },
];

/** Low-complexity keywords — simple transformations and lookups */
const LOW_COMPLEXITY_KEYWORDS: ReadonlyArray<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /\bformat\b/i,           label: 'Formatting task',      weight: -5 },
  { pattern: /\brename\b/i,           label: 'Rename task',          weight: -5 },
  { pattern: /\btypo\b/i,             label: 'Typo fix',             weight: -8 },
  { pattern: /\bdocstring\b/i,        label: 'Docstring task',       weight: -5 },
  { pattern: /\bcomment\b/i,          label: 'Comment task',         weight: -3 },
  { pattern: /\bconvert\b/i,          label: 'Simple conversion',    weight: -3 },
  { pattern: /\bsummariz(e|ation)\b/i, label: 'Summarization',       weight: -5 },
  { pattern: /\bextract\b/i,          label: 'Data extraction',      weight: -5 },
  { pattern: /\bjson\b.*\bformat\b/i, label: 'JSON formatting',      weight: -8 },
  { pattern: /\bwhat\s+is\b/i,        label: 'Simple lookup',        weight: -3 },
];

// ─────────────────────────────────────────────
//  Token Estimation
// ─────────────────────────────────────────────

/**
 * Rough token estimator: 1 token ≈ 4 characters for English text.
 * Good enough for heuristic scoring without importing tiktoken.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────
//  Score → Tier Mapping
// ─────────────────────────────────────────────

export function scoreToTier(score: CognitiveLoadScore): RoutingTier {
  if (score <= 2) { return 'minimal'; }
  if (score <= 4) { return 'low'; }
  if (score <= 6) { return 'medium'; }
  if (score <= 8) { return 'high'; }
  return 'extreme';
}

export function tierToEffort(tier: RoutingTier): EffortLevel {
  switch (tier) {
    case 'minimal': return 'none';
    case 'low':     return 'low';
    case 'medium':  return 'medium';
    case 'high':    return 'high';
    case 'extreme': return 'max';
  }
}

export function effortToThinkingBudget(effort: EffortLevel): number {
  switch (effort) {
    case 'none':   return 0;
    case 'low':    return 1024;
    case 'medium': return 4096;
    case 'high':   return 10000;
    case 'max':    return 32000;
  }
}

// ─────────────────────────────────────────────
//  Main Analyzer
// ─────────────────────────────────────────────

/**
 * Analyzes a prompt using deterministic heuristics.
 * Returns a CognitiveAnalysis with full signal breakdown.
 */
export function analyzeHeuristic(meta: PromptMetadata): CognitiveAnalysis {
  const signals: AnalysisSignal[] = [];
  let rawScore = 20; // baseline: everything starts at "medium-low"

  const { prompt } = meta;

  // ── Keyword signals ──────────────────────────────
  for (const kw of HIGH_COMPLEXITY_KEYWORDS) {
    if (kw.pattern.test(prompt)) {
      signals.push({ type: 'keyword', label: kw.label, weight: kw.weight });
      rawScore += kw.weight;
    }
  }
  for (const kw of MEDIUM_COMPLEXITY_KEYWORDS) {
    if (kw.pattern.test(prompt)) {
      signals.push({ type: 'keyword', label: kw.label, weight: kw.weight });
      rawScore += kw.weight;
    }
  }
  for (const kw of LOW_COMPLEXITY_KEYWORDS) {
    if (kw.pattern.test(prompt)) {
      signals.push({ type: 'keyword', label: kw.label, weight: kw.weight });
      rawScore += kw.weight;
    }
  }

  // ── Prompt length signals ────────────────────────
  if (meta.estimatedPromptTokens > 2000) {
    const w = 15;
    signals.push({ type: 'length', label: 'Long prompt (>2k tokens)', weight: w });
    rawScore += w;
  } else if (meta.estimatedPromptTokens > 800) {
    const w = 8;
    signals.push({ type: 'length', label: 'Medium prompt (>800 tokens)', weight: w });
    rawScore += w;
  } else if (meta.estimatedPromptTokens < 80) {
    const w = -8;
    signals.push({ type: 'length', label: 'Very short prompt (<80 tokens)', weight: w });
    rawScore += w;
  }

  // ── Context file signals ─────────────────────────
  if (meta.contextFileCount > 5) {
    const w = 20;
    signals.push({ type: 'context', label: `Many context files (${meta.contextFileCount})`, weight: w });
    rawScore += w;
  } else if (meta.contextFileCount > 2) {
    const w = 10;
    signals.push({ type: 'context', label: `Multiple context files (${meta.contextFileCount})`, weight: w });
    rawScore += w;
  } else if (meta.contextFileCount === 0 && !meta.hasCodeSelection) {
    const w = -5;
    signals.push({ type: 'context', label: 'No context files attached', weight: w });
    rawScore += w;
  }

  // ── Context token volume ─────────────────────────
  if (meta.contextFileTokens > 50000) {
    const w = 15;
    signals.push({ type: 'context', label: `Large context payload (${Math.round(meta.contextFileTokens / 1000)}k tokens)`, weight: w });
    rawScore += w;
  } else if (meta.contextFileTokens > 10000) {
    const w = 8;
    signals.push({ type: 'context', label: `Medium context payload (${Math.round(meta.contextFileTokens / 1000)}k tokens)`, weight: w });
    rawScore += w;
  }

  // ── Code selection ───────────────────────────────
  if (meta.hasCodeSelection) {
    if (meta.selectionLineCount > 200) {
      const w = 12;
      signals.push({ type: 'context', label: `Large code selection (${meta.selectionLineCount} lines)`, weight: w });
      rawScore += w;
    } else if (meta.selectionLineCount > 50) {
      const w = 6;
      signals.push({ type: 'context', label: `Code selection (${meta.selectionLineCount} lines)`, weight: w });
      rawScore += w;
    }
  }

  // ── Multi-file indicator in text ─────────────────
  const multiFilePattern = /\b(across|multiple|all|several)\s+(files?|modules?|services?)\b/i;
  if (multiFilePattern.test(prompt)) {
    const w = 12;
    signals.push({ type: 'multifile', label: 'Multi-file scope detected', weight: w });
    rawScore += w;
  }

  // ── Agentic/autonomous indicators ───────────────
  const agenticPattern = /\b(autonomous|agentic|autonomously|step.?by.?step|pipeline)\b/i;
  if (agenticPattern.test(prompt)) {
    const w = 15;
    signals.push({ type: 'intent', label: 'Agentic/autonomous task', weight: w });
    rawScore += w;
  }

  // ── Question vs. instruction ─────────────────────
  const isQuestion = /^(what|why|how|when|where|is|are|can|could|should|would)\b/i.test(prompt.trim());
  if (isQuestion && meta.estimatedPromptTokens < 200) {
    const w = -5;
    signals.push({ type: 'intent', label: 'Simple question', weight: w });
    rawScore += w;
  }

  // ── Clamp raw score to 1–10 ──────────────────────
  const clampedRaw = Math.max(0, Math.min(100, rawScore));
  const score = Math.max(1, Math.min(10, Math.round(clampedRaw / 10))) as CognitiveLoadScore;

  const tier = scoreToTier(score);
  const effortLevel = tierToEffort(tier);
  const estimatedThinkingTokens = effortToThinkingBudget(effortLevel);

  const signalSummary = signals
    .filter(s => s.weight > 0)
    .map(s => s.label)
    .slice(0, 3)
    .join(', ');

  const reasoning = signalSummary
    ? `Heuristic signals: ${signalSummary}. Raw score ${rawScore} → ${score}/10.`
    : `No strong complexity signals. Baseline score: ${score}/10.`;

  return {
    score,
    tier,
    signals,
    effortLevel,
    estimatedThinkingTokens,
    analyzerUsed: 'heuristic',
    confidence: 0.72,
    reasoning,
  };
}
