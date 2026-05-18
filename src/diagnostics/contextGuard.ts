/**
 * ORC — Context Guard
 *
 * Detects and warns about "Context Rot" and "Attention Dilution" —
 * the dangerous anti-patterns described in the 2026 economics research:
 *
 *   "Loading massive tool definitions alongside tens of thousands of tokens
 *    of file history causes severe degradation in model reasoning...
 *    The model successfully comprehends the beginning and end of the prompt
 *    but completely ignores critical project definitions located in the middle.
 *    This failure forces the user to regenerate the query or engage in
 *    corrective prompting, thereby doubling or tripling the total token
 *    expenditure for a single task."
 *
 * Additionally implements the "Peak-Hour Throttle Awareness" from the research:
 *   "In late March 2026, Anthropic silently instituted aggressive peak-hour
 *    multipliers... During peak US business hours (5 AM to 11 AM Pacific),
 *    usage limits began to drain at an accelerated rate."
 *
 * Guards:
 *   1. Context-to-Task Ratio — too much context for tier = dilution risk
 *   2. Lost-in-the-Middle Risk — critical info buried in middle of large context
 *   3. Context Compounding — session context growing exponentially
 *   4. Peak Hour Throttle Warning — alert during high-multiplier windows
 *   5. Subscription Tier Advisor — recommend tier upgrade based on usage pattern
 */

import * as vscode from 'vscode';
import type { PromptMetadata, RoutingTier } from '../types/index.js';

// ─────────────────────────────────────────────
//  Diagnostic Types
// ─────────────────────────────────────────────

export type DiagnosticSeverity = 'info' | 'warning' | 'critical';

export interface ContextDiagnostic {
  id: string;
  severity: DiagnosticSeverity;
  title: string;
  detail: string;
  recommendation: string;
  tokenImpact: number; // estimated wasted tokens
}

export interface ContextGuardReport {
  diagnostics: ContextDiagnostic[];
  hasCritical: boolean;
  hasWarnings: boolean;
  totalWastedTokenEstimate: number;
  shouldProceed: boolean; // false = strongly recommend context reduction first
}

// ─────────────────────────────────────────────
//  Context-to-Task Ratio Thresholds
// ─────────────────────────────────────────────

// Max context-to-prompt ratio before dilution risk fires per tier
const MAX_CONTEXT_RATIO: Record<RoutingTier, number> = {
  minimal: 5,   // Simple task: context should be ≤ 5x the prompt size
  low:     10,
  medium:  20,
  high:    50,
  extreme: 100, // Long agentic run: large context expected
};

/** Absolute max context tokens per tier before hard warning. Also used as the
 *  compression target budget in the God Mode pipeline. Exported so callers can
 *  derive a meaningful target instead of an arbitrary fraction of current size. */
export const MAX_CONTEXT_TOKENS: Record<RoutingTier, number> = {
  minimal: 5_000,
  low:     20_000,
  medium:  50_000,
  high:    100_000,
  extreme: 500_000,
};

// ─────────────────────────────────────────────
//  Guard 1: Context-to-Task Ratio
// ─────────────────────────────────────────────

function checkContextRatio(
  meta: PromptMetadata,
  tier: RoutingTier,
): ContextDiagnostic | null {
  if (meta.contextFileTokens === 0 || meta.estimatedPromptTokens === 0) { return null; }

  const ratio = meta.contextFileTokens / meta.estimatedPromptTokens;
  const maxRatio = MAX_CONTEXT_RATIO[tier];

  if (ratio > maxRatio * 2) {
    return {
      id: 'context-ratio-critical',
      severity: 'critical',
      title: 'Extreme Attention Dilution Risk',
      detail: `Context is ${ratio.toFixed(0)}x larger than your prompt. ` +
        `For a ${tier}-complexity task, the model's attention will be overwhelmed by irrelevant tokens. ` +
        `The "Lost in the Middle" effect will likely cause the model to ignore your core instruction.`,
      recommendation: 'Generate a concise markdown schema of the relevant code instead of including full files. ' +
        'Or use ORC to run a Haiku summarization pass first.',
      tokenImpact: Math.round(meta.contextFileTokens * 0.6),
    };
  }

  if (ratio > maxRatio) {
    return {
      id: 'context-ratio-warning',
      severity: 'warning',
      title: 'Attention Dilution Warning',
      detail: `Context is ${ratio.toFixed(0)}x your prompt size (threshold for ${tier} tier: ${maxRatio}x). ` +
        `Model may lose focus on the actual task.`,
      recommendation: 'Trim the context to only the directly relevant code sections.',
      tokenImpact: Math.round(meta.contextFileTokens * 0.3),
    };
  }

  return null;
}

// ─────────────────────────────────────────────
//  Guard 2: Absolute Context Size
// ─────────────────────────────────────────────

function checkAbsoluteContextSize(
  meta: PromptMetadata,
  tier: RoutingTier,
): ContextDiagnostic | null {
  const maxTokens = MAX_CONTEXT_TOKENS[tier];

  if (meta.contextFileTokens > maxTokens * 2) {
    return {
      id: 'context-absolute-critical',
      severity: 'critical',
      title: 'Massive Context Payload',
      detail: `${(meta.contextFileTokens / 1000).toFixed(0)}k context tokens for a ${tier} task. ` +
        `This will cost significantly more than necessary and degrade output quality.`,
      recommendation: 'Use a Haiku preprocessing pass to summarize and compress the context first. ' +
        `Expected compression: ${Math.round(maxTokens / 1000)}k tokens (${Math.round((maxTokens / meta.contextFileTokens) * 100)}% of current).`,
      tokenImpact: meta.contextFileTokens - maxTokens,
    };
  }

  if (meta.contextFileTokens > maxTokens) {
    return {
      id: 'context-absolute-warning',
      severity: 'warning',
      title: 'Large Context for Task Tier',
      detail: `${(meta.contextFileTokens / 1000).toFixed(0)}k context tokens exceeds the recommended ` +
        `${(maxTokens / 1000).toFixed(0)}k for ${tier}-tier tasks.`,
      recommendation: 'Consider reducing context size or escalating to a higher tier model.',
      tokenImpact: meta.contextFileTokens - maxTokens,
    };
  }

  return null;
}

// ─────────────────────────────────────────────
//  Guard 3: Lost-in-the-Middle Risk
// ─────────────────────────────────────────────

function checkLostInMiddle(meta: PromptMetadata): ContextDiagnostic | null {
  // Risk fires when: many files AND large total context
  if (meta.contextFileCount >= 4 && meta.totalContextTokens > 20_000) {
    return {
      id: 'lost-in-middle',
      severity: 'warning',
      title: 'Lost-in-the-Middle Risk',
      detail: `${meta.contextFileCount} files × ${(meta.totalContextTokens / 1000).toFixed(0)}k tokens. ` +
        `Empirical research shows models reliably attend to content at the START and END of context, ` +
        `but frequently miss content in the MIDDLE of large payloads.`,
      recommendation: 'Place the most critical reference files at the top and bottom of your context. ' +
        'Use a markdown table of contents to direct model attention.',
      tokenImpact: 0, // no direct waste, but quality risk
    };
  }
  return null;
}

// ─────────────────────────────────────────────
//  Guard 4: Peak-Hour Throttle Warning
// ─────────────────────────────────────────────

/**
 * Warns during Anthropic's known peak-hour multiplier windows.
 * Peak: 5 AM – 11 AM Pacific Time (UTC-7/8 depending on DST)
 * During these windows, usage limits drain 4–5x faster than expected.
 */
export function checkPeakHourWindow(): ContextDiagnostic | null {
  const now = new Date();
  // Convert current time to Pacific Time (approximate)
  const utcHour = now.getUTCHours();
  // Pacific Standard Time = UTC-8, Pacific Daylight Time = UTC-7
  // DST in US: second Sunday March → first Sunday November
  const month = now.getUTCMonth(); // 0-indexed
  const isDST = month >= 2 && month <= 9; // rough approximation
  const ptOffset = isDST ? 7 : 8;
  const ptHour = (utcHour - ptOffset + 24) % 24;

  // Peak window: 5 AM to 11 AM PT
  if (ptHour >= 5 && ptHour < 11) {
    const remaining = 11 - ptHour;
    return {
      id: 'peak-hour-throttle',
      severity: 'warning',
      title: `Peak-Hour Throttle Active (${ptHour}:00 PT)`,
      detail: `Anthropic's peak-hour multiplier is currently active (5–11 AM Pacific). ` +
        `Your subscription limits may drain 4–5x faster than usual. ` +
        `Peak window ends in ~${remaining} hour${remaining !== 1 ? 's' : ''}.`,
      recommendation: 'Consider scheduling intensive agentic runs outside peak hours, ' +
        'or use direct API calls with your own key to bypass subscription throttling.',
      tokenImpact: 0,
    };
  }

  return null;
}

// ─────────────────────────────────────────────
//  Guard 5: Subscription Tier Advisor
// ─────────────────────────────────────────────

export interface TierAdvisory {
  shouldUpgrade: boolean;
  currentTier: string;
  recommendedTier: string;
  reason: string;
}

/**
 * Analyzes session usage patterns to recommend subscription tier upgrades.
 * Based on the research: "users universally report exhausting standard $20 daily
 * limits within minutes of initiating a project."
 */
export function analyzeTierFit(sessionStats: {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalPrompts: number;
  sessionStartMs: number;
}): TierAdvisory {
  const sessionMinutes = (Date.now() - sessionStats.sessionStartMs) / 60_000;
  const totalTokens = sessionStats.totalInputTokens + sessionStats.totalOutputTokens + sessionStats.totalThinkingTokens;
  const tokensPerMinute = sessionMinutes > 1 ? totalTokens / sessionMinutes : 0;

  // Pro limit: ~100k tokens per session (rough)
  // Max 5x limit: ~500k tokens per session
  // Max 20x limit: ~2M tokens per session

  if (tokensPerMinute > 5000) {
    // Burning >5k tokens/min → Max 20x territory
    return {
      shouldUpgrade: true,
      currentTier: 'unknown',
      recommendedTier: 'Claude Max 20x ($200/mo)',
      reason: `Current usage rate (${Math.round(tokensPerMinute).toLocaleString()} tok/min) ` +
        `will exhaust Pro limits in under 20 minutes and Max 5x in under 2 hours. ` +
        `Max 20x provides 20x the Pro capacity.`,
    };
  }

  if (tokensPerMinute > 1000) {
    return {
      shouldUpgrade: true,
      currentTier: 'Claude Pro',
      recommendedTier: 'Claude Max 5x ($100/mo)',
      reason: `Current usage rate (${Math.round(tokensPerMinute).toLocaleString()} tok/min) ` +
        `will exhaust Pro limits within ~1.5 hours. Max 5x is the optimal sweet spot ` +
        `for intensive agentic coding sessions.`,
    };
  }

  return {
    shouldUpgrade: false,
    currentTier: 'Claude Pro',
    recommendedTier: 'Claude Pro',
    reason: 'Current usage rate is within Pro tier capacity.',
  };
}

// ─────────────────────────────────────────────
//  Main: runContextGuard
// ─────────────────────────────────────────────

/**
 * Runs all context guards and returns a unified report.
 * The pipeline calls this before showing the approval dialog.
 */
export function runContextGuard(
  meta: PromptMetadata,
  tier: RoutingTier,
): ContextGuardReport {
  const diagnostics: ContextDiagnostic[] = [];

  const checks = [
    checkContextRatio(meta, tier),
    checkAbsoluteContextSize(meta, tier),
    checkLostInMiddle(meta),
    checkPeakHourWindow(),
  ];

  for (const d of checks) {
    if (d !== null) { diagnostics.push(d); }
  }

  const hasCritical = diagnostics.some(d => d.severity === 'critical');
  const hasWarnings = diagnostics.some(d => d.severity === 'warning');
  const totalWastedTokenEstimate = diagnostics.reduce((sum, d) => sum + d.tokenImpact, 0);

  return {
    diagnostics,
    hasCritical,
    hasWarnings,
    totalWastedTokenEstimate,
    shouldProceed: !hasCritical,
  };
}

// ─────────────────────────────────────────────
//  VS Code Notification Helper
// ─────────────────────────────────────────────

/**
 * Shows context guard diagnostics as VS Code notifications.
 * Returns false if user chose to abort due to critical warnings.
 */
export async function showContextGuardDiagnostics(
  report: ContextGuardReport,
): Promise<boolean> {
  if (report.diagnostics.length === 0) { return true; }

  for (const diag of report.diagnostics) {
    if (diag.severity === 'critical') {
      const choice = await vscode.window.showWarningMessage(
        `ORC Context Guard: ${diag.title}\n${diag.detail}`,
        { modal: false },
        'Proceed Anyway',
        'Abort',
        'See Recommendation',
      );

      if (choice === 'Abort') { return false; }
      if (choice === 'See Recommendation') {
        void vscode.window.showInformationMessage(`ORC: ${diag.recommendation}`);
        return false;
      }
    } else if (diag.severity === 'warning') {
      void vscode.window.showWarningMessage(
        `ORC: ${diag.title} — ${diag.recommendation}`,
      );
    } else {
      void vscode.window.showInformationMessage(
        `ORC: ${diag.title} — ${diag.recommendation}`,
      );
    }
  }

  return true;
}
