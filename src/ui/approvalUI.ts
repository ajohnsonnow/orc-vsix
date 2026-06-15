/**
 * ORC — Approval UI
 *
 * Presents the routing recommendation to the user before any model call is made.
 * The user can:
 *   • Approve & Run     — accept recommendation and execute
 *   • Apply to Claude Code — write settings to ~/.claude/settings.json only (no API call)
 *   • Override Model    — pick a different model from a QuickPick list
 *   • Escalate          — bump to the next tier (e.g., Sonnet → Opus)
 *   • Downgrade         — drop to the previous tier (e.g., Sonnet → Haiku)
 *   • Cancel            — discard
 *
 * The UI is designed to be non-blocking: it shows all relevant information
 * (model, cost estimate, thinking budget, Claude Code CLI hint) in a single
 * QuickPick dialog without cluttering the workspace.
 */

import * as vscode from 'vscode';
import type {
  ApprovalResult,
  ModelSpec,
  RouteRecommendation,
  RoutingTier,
} from '../types/index.js';
import { MODEL_REGISTRY } from '../router/promptRouter.js';

// ─────────────────────────────────────────────
//  Tier Icons & Labels
// ─────────────────────────────────────────────

const TIER_ICON: Record<RoutingTier, string> = {
  minimal: '$(zap)',
  low:     '$(symbol-method)',
  medium:  '$(symbol-class)',
  high:    '$(circuit-board)',
  extreme: '$(flame)',
};

const TIER_LABEL: Record<RoutingTier, string> = {
  minimal: 'Minimal',
  low:     'Low',
  medium:  'Medium',
  high:    'High',
  extreme: 'Extreme',
};

// ─────────────────────────────────────────────
//  Primary Approval Dialog
// ─────────────────────────────────────────────

/**
 * Shows the main approval QuickPick.
 * Returns an ApprovalResult, or null if the user cancels.
 */
export async function showApprovalDialog(
  rec: RouteRecommendation,
  autoApply: boolean,
): Promise<ApprovalResult | null> {
  const { primaryModel, analysis, claudeCodeCommand } = rec;

  const tier = analysis.tier;
  const icon = TIER_ICON[tier];
  const tierLabel = TIER_LABEL[tier];
  const scoreLabel = `${analysis.score}/10`;
  const costLabel = `~$${rec.estimatedCostUSD.toFixed(4)}`;
  const latencyLabel = rec.estimatedLatencyMs >= 1000
    ? `~${(rec.estimatedLatencyMs / 1000).toFixed(1)}s`
    : `~${rec.estimatedLatencyMs}ms`;
  const thinkingLabel = rec.thinkingBudget > 0
    ? `${rec.thinkingBudget.toLocaleString()} thinking tokens`
    : 'no extended thinking';

  const title = `ORC Router ${icon}  Score ${scoreLabel} — ${tierLabel} Complexity`;

  // Build the primary items list
  interface ORCQuickPickItem extends vscode.QuickPickItem {
    action: 'approve' | 'apply-claude-code' | 'override' | 'escalate' | 'downgrade' | 'cancel';
  }

  const items: ORCQuickPickItem[] = [
    {
      label: '$(check) Approve & Run',
      description: `${primaryModel.displayName} · ${costLabel} · ${latencyLabel}`,
      detail: `${thinkingLabel} · ${rec.reasoning.slice(0, 100)}`,
      alwaysShow: true,
      action: 'approve',
    },
  ];

  // Claude Code apply button — only when primary is Claude
  if (claudeCodeCommand) {
    items.push({
      label: '$(settings-gear) Apply to Claude Code (no run)',
      description: `Write model to ~/.claude/settings.json`,
      detail: claudeCodeCommand.cliHint,
      alwaysShow: true,
      action: 'apply-claude-code',
    });
  }

  items.push(
    {
      label: '$(list-unordered) Override Model',
      description: 'Pick a different model manually',
      alwaysShow: true,
      action: 'override',
    },
    {
      label: '$(arrow-up) Escalate Tier',
      description: rec.fallbackModel ? `Upgrade to ${getNextTierModel(tier, 'up')?.displayName ?? '(max)'}` : '(already at max tier)',
      alwaysShow: true,
      action: 'escalate',
    },
    {
      label: '$(arrow-down) Downgrade Tier',
      description: (() => {
        const down = getNextTierModel(tier, 'down');
        return down ? `Downgrade to ${down.displayName}` : '(already at min tier)';
      })(),
      alwaysShow: true,
      action: 'downgrade',
    },
    {
      label: '$(x) Cancel',
      alwaysShow: true,
      action: 'cancel',
    },
  );

  // Cost warning banner
  if (rec.costWarning) {
    void vscode.window.showWarningMessage(
      `ORC: ${rec.costWarningMessage}`,
      { modal: false },
    );
  }

  const selected = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: `Analyzing with ${analysis.analyzerUsed} · ${analysis.confidence * 100 | 0}% confidence`,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected || selected.action === 'cancel') {
    return null;
  }

  if (selected.action === 'approve') {
    return {
      outcome: 'approved',
      finalRecommendation: rec,
      applyToClaudeCode: autoApply && claudeCodeCommand !== null,
    };
  }

  if (selected.action === 'apply-claude-code') {
    return {
      outcome: 'settings-only',
      finalRecommendation: rec,
      applyToClaudeCode: true,
    };
  }

  if (selected.action === 'override') {
    return showModelOverridePicker(rec, autoApply);
  }

  if (selected.action === 'escalate') {
    const escalated = escalateRecommendation(rec);
    if (!escalated) {
      void vscode.window.showInformationMessage('ORC: Already at maximum tier (Opus / Extreme).');
      return null;
    }
    return {
      outcome: 'escalated',
      finalRecommendation: escalated,
      applyToClaudeCode: autoApply && escalated.claudeCodeCommand !== null,
    };
  }

  if (selected.action === 'downgrade') {
    const downgraded = downgradeRecommendation(rec);
    if (!downgraded) {
      void vscode.window.showInformationMessage('ORC: Already at minimum tier (Haiku / Minimal).');
      return null;
    }
    return {
      outcome: 'downgraded',
      finalRecommendation: downgraded,
      applyToClaudeCode: autoApply && downgraded.claudeCodeCommand !== null,
    };
  }

  return null;
}

// ─────────────────────────────────────────────
//  Model Override Picker
// ─────────────────────────────────────────────

async function showModelOverridePicker(
  rec: RouteRecommendation,
  autoApply: boolean,
): Promise<ApprovalResult | null> {
  const models = Object.values(MODEL_REGISTRY);

  interface ModelQuickPickItem extends vscode.QuickPickItem {
    model: ModelSpec;
  }

  const modelItems: ModelQuickPickItem[] = models.map(m => ({
    label: `$(symbol-class) ${m.displayName}`,
    description: `${m.provider} · $${m.inputCostPerMillion}/MTok in · $${m.outputCostPerMillion}/MTok out`,
    detail: m.strengths.join(', '),
    model: m,
  }));

  const picked = await vscode.window.showQuickPick(modelItems, {
    title: 'ORC: Select Model Override',
    placeHolder: 'Choose the model to use for this prompt',
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) { return null; }

  const overrideRec: RouteRecommendation = {
    ...rec,
    primaryModel: picked.model,
    claudeCodeCommand: picked.model.provider === 'anthropic'
      ? buildMinimalClaudeConfig(picked.model, rec.thinkingBudget)
      : null,
  };

  return {
    outcome: 'overridden',
    finalRecommendation: overrideRec,
    applyToClaudeCode: autoApply && overrideRec.claudeCodeCommand !== null,
  };
}

// ─────────────────────────────────────────────
//  Tier Escalation / Downgrade
// ─────────────────────────────────────────────

const TIER_ORDER: RoutingTier[] = ['minimal', 'low', 'medium', 'high', 'extreme'];

const CLAUDE_TIER_MODELS: Record<RoutingTier, string> = {
  minimal: 'claude-haiku-4-5',
  low:     'claude-haiku-4-5',
  medium:  'claude-sonnet-4-6',
  high:    'claude-opus-4-8',
  extreme: 'claude-fable-5',
};

function getNextTierModel(tier: RoutingTier, direction: 'up' | 'down'): ModelSpec | null {
  const idx = TIER_ORDER.indexOf(tier);
  const nextIdx = direction === 'up' ? idx + 1 : idx - 1;
  if (nextIdx < 0 || nextIdx >= TIER_ORDER.length) { return null; }
  const nextTier = TIER_ORDER[nextIdx];
  const key = CLAUDE_TIER_MODELS[nextTier];
  return MODEL_REGISTRY[key] ?? null;
}

function escalateRecommendation(rec: RouteRecommendation): RouteRecommendation | null {
  const nextModel = getNextTierModel(rec.analysis.tier, 'up');
  if (!nextModel) { return null; }
  const nextThinking = rec.thinkingBudget > 0 ? Math.min(rec.thinkingBudget * 2, 32000) : 0;
  return {
    ...rec,
    primaryModel: nextModel,
    thinkingBudget: nextThinking,
    claudeCodeCommand: nextModel.provider === 'anthropic'
      ? buildMinimalClaudeConfig(nextModel, nextThinking)
      : null,
  };
}

function downgradeRecommendation(rec: RouteRecommendation): RouteRecommendation | null {
  const prevModel = getNextTierModel(rec.analysis.tier, 'down');
  if (!prevModel) { return null; }
  const prevThinking = Math.max(0, Math.floor(rec.thinkingBudget / 2));
  return {
    ...rec,
    primaryModel: prevModel,
    thinkingBudget: prevThinking,
    claudeCodeCommand: prevModel.provider === 'anthropic'
      ? buildMinimalClaudeConfig(prevModel, prevThinking)
      : null,
  };
}

// ─────────────────────────────────────────────
//  Minimal Claude Code Config Builder (for overrides)
// ─────────────────────────────────────────────

function buildMinimalClaudeConfig(model: ModelSpec, thinkingBudget: number) {
  const thinkingFlag = thinkingBudget > 0 ? `--thinking-budget ${thinkingBudget}` : '';
  return {
    model: model.id,
    thinkingBudget,
    useFastMode: false,
    systemPromptPrefix: 'Return ONLY the requested output. No preamble. No trailing summaries.',
    cliHint: `claude --model ${model.id} ${thinkingFlag}`.trim(),
    settingsDelta: {
      model: model.id,
      thinking: thinkingBudget > 0
        ? { type: 'enabled', budget_tokens: thinkingBudget }
        : { type: 'disabled' },
    },
  };
}

// ─────────────────────────────────────────────
//  Input Dialog: Get User Prompt
// ─────────────────────────────────────────────

/**
 * Shows an InputBox for the user to type a prompt directly.
 * @param prefill Optional text pre-filled from clipboard. Selected on open so typing replaces it.
 */
export async function showPromptInputBox(prefill?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'ORC: Route a Prompt',
    placeHolder: 'Describe what you want Claude to do...',
    prompt: prefill
      ? 'Pre-filled from clipboard — edit or press Enter to confirm.'
      : 'ORC will analyze the complexity and recommend the best model + effort level.',
    value: prefill,
    valueSelection: prefill ? [0, prefill.length] : undefined,
    ignoreFocusOut: true,
    validateInput: value => (value.trim().length < 3 ? 'Prompt must be at least 3 characters.' : null),
  });
}
