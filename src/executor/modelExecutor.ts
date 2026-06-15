/**
 * Orca — Model Executor (God Mode Edition)
 *
 * Executes Anthropic API calls with full god mode features:
 *   • Prompt caching (cache_control breakpoints — 90% input cost reduction)
 *   • Extended thinking with streaming preview
 *   • Self-correction cascade (quality check → auto-escalate on failure)
 *   • Cache stats tracking (cache hits, write vs read tokens)
 *   • Real-time streaming to VS Code output channel
 *   • Full cost accounting (input + output + thinking + cache write/read)
 *
 * Extended thinking requires temperature=1.0 (Anthropic requirement).
 * Non-Anthropic providers: returns a CLI hint instead of executing.
 */

import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import type { ExecutionResult, RouteRecommendation } from '../types/index.js';
import { buildCacheAwarePayload, extractCacheStats, validateCacheOrdering } from '../cache/promptCache.js';
import { runQualityCascade } from '../cascade/selfCorrectionCascade.js';
import { MODEL_REGISTRY } from '../router/promptRouter.js';

// ─────────────────────────────────────────────
//  Extended ExecutionResult (with god mode fields)
// ─────────────────────────────────────────────

export interface GodModeExecutionResult extends ExecutionResult {
  cacheHit: boolean;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cacheSavingsUSD: number;
  qualityScore: number;          // 0–100
  wasEscalated: boolean;         // true if cascade triggered escalation
  escalatedToModel?: string;     // model used after escalation
  thinkingPreview: string;       // first 200 chars of thinking block
}

// ─────────────────────────────────────────────
//  Output Channel
// ─────────────────────────────────────────────

let _outputChannel: vscode.OutputChannel | null = null;

function getOutputChannel(): vscode.OutputChannel {
  _outputChannel ??= vscode.window.createOutputChannel('ORC Response', 'markdown');
  return _outputChannel;
}

export function disposeOutputChannel(): void {
  _outputChannel?.dispose();
  _outputChannel = null;
}

// ─────────────────────────────────────────────
//  Client Cache
// ─────────────────────────────────────────────

let _client: Anthropic | null = null;
let _cachedKey = '';

function getClient(apiKey: string): Anthropic {
  if (!_client || _cachedKey !== apiKey) {
    _client = new Anthropic({ apiKey });
    _cachedKey = apiKey;
  }
  return _client;
}

// ─────────────────────────────────────────────
//  God Mode Executor
// ─────────────────────────────────────────────

export async function executeRecommendation(
  prompt: string,
  rec: RouteRecommendation,
  apiKey: string,
  contextText?: string,
): Promise<GodModeExecutionResult> {
  const startMs = Date.now();
  const channel = getOutputChannel();

  if (rec.primaryModel.provider !== 'anthropic') {
    return buildErrorResult(rec, 0,
      `Provider "${rec.primaryModel.provider}" execution not yet supported. ` +
      `Use CLI hint: ${rec.claudeCodeCommand?.cliHint ?? 'N/A'}`);
  }

  if (!apiKey) {
    return buildErrorResult(rec, 0,
      "No Anthropic API key. Run 'ORC: Set Anthropic API Key' from the Command Palette.");
  }

  const client = getClient(apiKey);
  const systemPrompt = rec.claudeCodeCommand?.systemPromptPrefix ?? '';
  const useThinking = rec.thinkingBudget > 0 && rec.primaryModel.supportsThinking
    || (rec.primaryModel.alwaysThinking ?? false);

  // ── Prompt caching payload ───────────────────
  const cacheOrderCheck = validateCacheOrdering(systemPrompt, contextText ?? '', prompt);

  const { system, messages, hasCacheBreakpoints, cacheableTokens } = buildCacheAwarePayload(
    systemPrompt,
    contextText ?? '',
    prompt,
    (text) => Math.ceil(text.length / 4),
  );

  // ── Output channel header ────────────────────
  channel.clear();
  channel.show(true);
  const thinkingInfo = useThinking ? `thinking: ${rec.thinkingBudget.toLocaleString()} tokens` : 'no thinking';
  const cacheInfo = hasCacheBreakpoints ? `${(cacheableTokens / 1000).toFixed(1)}k tokens cacheable` : 'not cached';
  channel.appendLine(`# Orca → ${rec.primaryModel.displayName}`);
  channel.appendLine(`> Score ${rec.analysis.score}/10 · ${rec.analysis.tier} · ${thinkingInfo} · cache: ${cacheInfo}`);
  if (!cacheOrderCheck.isOptimal) {
    channel.appendLine(`> ⚠ Cache Warning: ${cacheOrderCheck.warning}`);
  }
  channel.appendLine('');

  // ── Execute primary call ─────────────────────
  const primaryResult = await streamAnthropicCall(client, rec, system, messages, channel);

  if (!primaryResult.success) {
    return { ...primaryResult, cacheHit: false, cacheWriteTokens: 0, cacheReadTokens: 0, cacheSavingsUSD: 0, qualityScore: 0, wasEscalated: false, thinkingPreview: '' };
  }

  // ── Quality cascade check ────────────────────
  const taskType = detectTaskType(prompt);
  const cascadeResult = await runQualityCascade(
    prompt,
    primaryResult.content,
    {
      enableHeuristicCheck: true,
      enableStructuralCheck: taskType === 'code',
      enableLLMEvaluation: true,
      taskType,
      maxTierIndex: tierIndex(rec.analysis.tier),
    },
    apiKey,
  );

  // ── Auto-escalate if cascade failed ──────────
  if (cascadeResult.needsEscalation) {
    const escalatedModel = getEscalatedModel(rec.primaryModel.id);
    const maxAllowed = tierIndex(rec.analysis.tier);
    const canEscalate = escalatedModel !== null && tierIndex(escalatedModel.tier) <= maxAllowed;

    if (canEscalate && escalatedModel) {
      const estCost = ((rec.maxOutputTokens + rec.thinkingBudget) / 1_000_000) * escalatedModel.inputCostPerMillion;
      const escalateLabel = `Escalate to ${escalatedModel.displayName} (~$${estCost.toFixed(4)})`;
      const escalateChoice = await vscode.window.showWarningMessage(
        `Orca Cascade: ${cascadeResult.escalationMessage}`,
        escalateLabel,
        'Keep Result',
      );

      if (escalateChoice === escalateLabel) {
        channel.appendLine('');
        channel.appendLine(`---`);
        channel.appendLine(`## Escalating to ${escalatedModel.displayName}...`);
        channel.appendLine('');

        const escalatedRec: RouteRecommendation = {
          ...rec,
          primaryModel: escalatedModel,
          thinkingBudget: rec.thinkingBudget > 0
            ? Math.min(rec.thinkingBudget * 2, escalatedModel.maxThinkingBudget || 32000)
            : 0,
        };

        const escalatedResult = await streamAnthropicCall(client, escalatedRec, system, messages, channel);

        const duration = Date.now() - startMs;
        return {
          ...escalatedResult,
          durationMs: duration,
          cacheHit: escalatedResult.cacheHit ?? false,
          cacheWriteTokens: escalatedResult.cacheWriteTokens ?? 0,
          cacheReadTokens: escalatedResult.cacheReadTokens ?? 0,
          cacheSavingsUSD: escalatedResult.cacheSavingsUSD ?? 0,
          qualityScore: 85,
          wasEscalated: true,
          escalatedToModel: escalatedModel.id,
          thinkingPreview: escalatedResult.thinkingPreview ?? '',
        };
      }
    }
  }

  const duration = Date.now() - startMs;
  return {
    ...primaryResult,
    durationMs: duration,
    qualityScore: cascadeResult.quality.score,
    wasEscalated: false,
    thinkingPreview: primaryResult.thinkingPreview ?? '',
  };
}

// ─────────────────────────────────────────────
//  Core Streaming Call
// ─────────────────────────────────────────────

interface StreamResult extends GodModeExecutionResult {}

interface StreamState {
  fullText: string;
  thinkingText: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  isInThinkingBlock: boolean;
  thinkingDotsCount: number;
}

function applyContentDelta(
  delta: Record<string, unknown>,
  state: StreamState,
  channel: vscode.OutputChannel,
): void {
  if (delta['type'] === 'thinking_delta') {
    const thinking = (delta['thinking'] as string) ?? '';
    state.thinkingText += thinking;
    state.thinkingDotsCount += thinking.length;
    if (state.thinkingDotsCount > 100) {
      channel.append('·');
      state.thinkingDotsCount = 0;
    }
  } else if (delta['type'] === 'text_delta') {
    const text = (delta['text'] as string) ?? '';
    state.fullText += text;
    channel.append(text);
  }
}

function processStreamEvent(
  event: Record<string, unknown>,
  state: StreamState,
  channel: vscode.OutputChannel,
): void {
  const type = event['type'];

  if (type === 'message_start') {
    const usage = (event['message'] as Record<string, unknown>)?.['usage'] as Record<string, number> | undefined;
    state.inputTokens = usage?.['input_tokens'] ?? 0;
    state.cacheCreationTokens = usage?.['cache_creation_input_tokens'] ?? 0;
    state.cacheReadTokens = usage?.['cache_read_input_tokens'] ?? 0;
    if (state.cacheReadTokens > 0) {
      channel.appendLine(`> Cache HIT: ${state.cacheReadTokens.toLocaleString()} tokens served from cache`);
      channel.appendLine('');
    } else if (state.cacheCreationTokens > 0) {
      channel.appendLine(`> Cache WRITE: ${state.cacheCreationTokens.toLocaleString()} tokens written to cache`);
      channel.appendLine('');
    }
    return;
  }

  if (type === 'content_block_start') {
    const blockType = ((event['content_block'] as Record<string, unknown>)?.['type'] as string) ?? '';
    if (blockType === 'thinking') {
      state.isInThinkingBlock = true;
      channel.appendLine('> *[Extended thinking in progress...]*');
      state.thinkingDotsCount = 0;
    } else if (blockType === 'text' && state.isInThinkingBlock) {
      channel.appendLine('');
      channel.appendLine('---');
      state.isInThinkingBlock = false;
    }
    return;
  }

  if (type === 'content_block_delta') {
    const delta = event['delta'] as Record<string, unknown> | undefined;
    if (delta) { applyContentDelta(delta, state, channel); }
    return;
  }

  if (type === 'message_delta') {
    const usage = event['usage'] as Record<string, number> | undefined;
    state.outputTokens = usage?.['output_tokens'] ?? 0;
  }
}

const MODEL_MAX_OUTPUT: Record<string, number> = {
  'claude-fable-5':            128_000,
  'claude-opus-4-8':            32_000,
  'claude-sonnet-4-6':          16_000,
  'claude-haiku-4-5':            8_000,
  'claude-haiku-4-5-20251001':   8_000,
};

function buildRequestParams(
  rec: RouteRecommendation,
  system: Anthropic.Messages.TextBlockParam[],
  messages: Anthropic.Messages.MessageParam[],
): Record<string, unknown> {
  const model = rec.primaryModel;
  const useThinking = (rec.thinkingBudget > 0 && model.supportsThinking) || (model.alwaysThinking ?? false);
  const modelMax = MODEL_MAX_OUTPUT[model.id] ?? 16_000;

  const params: Record<string, unknown> = {
    model: model.id,
    max_tokens: Math.min(rec.maxOutputTokens + (useThinking ? rec.thinkingBudget : 0), modelMax),
    messages,
    stream: true,
  };

  if (system.length > 0) {
    params['system'] = system;
  }

  // Temperature: Opus 4.8+ and Fable 5 return 400 if temperature is sent
  if (model.supportsTemperature !== false) {
    params['temperature'] = useThinking ? 1 : rec.temperature;
  }

  // Thinking: Fable 5/Opus 4.8+ use adaptive format (no budget_tokens)
  if (useThinking) {
    if (model.alwaysThinking || model.supportsTemperature === false) {
      params['thinking'] = { type: 'adaptive' };
    } else {
      params['thinking'] = { type: 'enabled', budget_tokens: rec.thinkingBudget };
    }
  }

  return params;
}

async function streamAnthropicCall(
  client: Anthropic,
  rec: RouteRecommendation,
  system: Anthropic.Messages.TextBlockParam[],
  messages: Anthropic.Messages.MessageParam[],
  channel: vscode.OutputChannel,
): Promise<StreamResult> {
  const requestParams = buildRequestParams(rec, system, messages);

  const state: StreamState = {
    fullText: '',
    thinkingText: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    isInThinkingBlock: false,
    thinkingDotsCount: 0,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);

  try {
    const stream = client.messages.stream(
      requestParams as unknown as Anthropic.Messages.MessageCreateParamsStreaming,
      { signal: controller.signal },
    );

    for await (const event of stream) {
      processStreamEvent(event as unknown as Record<string, unknown>, state, channel);
    }

    const inputCost = (state.inputTokens / 1_000_000) * rec.primaryModel.inputCostPerMillion;
    const outputCost = (state.outputTokens / 1_000_000) * rec.primaryModel.outputCostPerMillion;
    const cacheWriteCost = (state.cacheCreationTokens / 1_000_000) * rec.primaryModel.inputCostPerMillion * 1.25;
    const cacheReadCost = (state.cacheReadTokens / 1_000_000) * rec.primaryModel.inputCostPerMillion * 0.1;
    const costUSD = inputCost + outputCost + cacheWriteCost + cacheReadCost;
    const cacheStats = extractCacheStats(
      {
        input_tokens: state.inputTokens,
        cache_creation_input_tokens: state.cacheCreationTokens,
        cache_read_input_tokens: state.cacheReadTokens,
      },
      rec.primaryModel.inputCostPerMillion,
    );
    const thinkingTokens = Math.ceil(state.thinkingText.length / 4);
    const cacheSavedStr = cacheStats.wasAHit
      ? ` · cache saved $${cacheStats.estimatedSavingsUSD.toFixed(5)}`
      : '';

    channel.appendLine('');
    channel.appendLine('---');
    channel.appendLine(
      `*${rec.primaryModel.displayName} · in:${state.inputTokens} out:${state.outputTokens} ` +
      `think:${thinkingTokens} · $${costUSD.toFixed(5)}${cacheSavedStr}*`,
    );

    clearTimeout(timeoutId);
    return {
      success: true,
      content: state.fullText,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      thinkingTokens,
      costUSD,
      modelUsed: rec.primaryModel.id,
      durationMs: 0,
      cacheHit: cacheStats.wasAHit,
      cacheWriteTokens: state.cacheCreationTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheSavingsUSD: cacheStats.estimatedSavingsUSD,
      qualityScore: 0,
      wasEscalated: false,
      thinkingPreview: state.thinkingText.slice(0, 200),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    channel.appendLine(`\n**Error:** ${message}`);
    return buildErrorResult(rec, 0, message);
  }
}

// ─────────────────────────────────────────────
//  Escalation Model Lookup (derived from MODEL_REGISTRY)
// ─────────────────────────────────────────────

/**
 * Builds the escalation chain dynamically from MODEL_REGISTRY so it never
 * drifts out of sync with model ID changes.
 *
 * Chain: Anthropic models only, ordered by tier (minimal → extreme).
 * Each model maps to the next Anthropic model up in the tier ladder.
 */
function buildEscalationMap(): Record<string, string> {
  const TIER_ORDER = ['minimal', 'low', 'medium', 'high', 'extreme'] as const;
  const anthropicModels = Object.values(MODEL_REGISTRY)
    .filter(m => m.provider === 'anthropic')
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

  const map: Record<string, string> = {};
  for (let i = 0; i < anthropicModels.length - 1; i++) {
    const current = anthropicModels[i];
    const next = anthropicModels[i + 1];
    // Only map if the next model is a distinct upgrade (skip same-tier models)
    if (current.tier !== next.tier) {
      map[current.id] = next.id;
    }
  }
  return map;
}

const ESCALATION_MAP = buildEscalationMap();

function getEscalatedModel(currentModelId: string) {
  const nextId = ESCALATION_MAP[currentModelId];
  if (!nextId) { return null; }
  return Object.values(MODEL_REGISTRY).find(m => m.id === nextId) ?? null;
}

// ─────────────────────────────────────────────
//  Task Type Detection
// ─────────────────────────────────────────────

function detectTaskType(prompt: string): 'code' | 'analysis' | 'general' {
  if (/\b(implement|write|create|fix|refactor|code|function|class|method|bug)\b/i.test(prompt)) {
    return 'code';
  }
  if (/\b(analyze|review|explain|compare|evaluate|assess|research)\b/i.test(prompt)) {
    return 'analysis';
  }
  return 'general';
}

// ─────────────────────────────────────────────
//  Tier Index
// ─────────────────────────────────────────────

function tierIndex(tier: string): number {
  const tiers = ['minimal', 'low', 'medium', 'high', 'extreme'];
  return tiers.indexOf(tier);
}

// ─────────────────────────────────────────────
//  Error Result Builder
// ─────────────────────────────────────────────

function buildErrorResult(rec: RouteRecommendation, durationMs: number, error: string): GodModeExecutionResult {
  return {
    success: false,
    content: '',
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUSD: 0,
    modelUsed: rec.primaryModel.id,
    durationMs,
    error,
    cacheHit: false,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    cacheSavingsUSD: 0,
    qualityScore: 0,
    wasEscalated: false,
    thinkingPreview: '',
  };
}
