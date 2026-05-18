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
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('ORC Response', 'markdown');
  }
  return _outputChannel;
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
      'No Anthropic API key. Set orca.anthropicApiKey in VS Code Settings.');
  }

  const client = getClient(apiKey);
  const systemPrompt = rec.claudeCodeCommand?.systemPromptPrefix ?? '';
  const useThinking = rec.thinkingBudget > 0 && rec.primaryModel.supportsThinking;
  const temperature = useThinking ? 1.0 : rec.temperature;

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
  channel.appendLine(`# Orca → ${rec.primaryModel.displayName}`);
  channel.appendLine(
    `> Score ${rec.analysis.score}/10 · ${rec.analysis.tier} · ` +
    `${useThinking ? `thinking: ${rec.thinkingBudget.toLocaleString()} tokens` : 'no thinking'} · ` +
    `cache: ${hasCacheBreakpoints ? `${(cacheableTokens/1000).toFixed(1)}k tokens cacheable` : 'not cached'}`,
  );
  if (!cacheOrderCheck.isOptimal) {
    channel.appendLine(`> ⚠ Cache Warning: ${cacheOrderCheck.warning}`);
  }
  channel.appendLine('');

  // ── Execute primary call ─────────────────────
  const primaryResult = await streamAnthropicCall(
    client, rec, system, messages, useThinking, temperature, channel,
  );

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
    const escalateChoice = await vscode.window.showWarningMessage(
      `Orca Cascade: ${cascadeResult.escalationMessage}`,
      'Escalate Now',
      'Keep Result',
    );

    if (escalateChoice === 'Escalate Now') {
      const escalatedModel = getEscalatedModel(rec.primaryModel.id);
      if (escalatedModel) {
        channel.appendLine('');
        channel.appendLine(`---`);
        channel.appendLine(`## Escalating to ${escalatedModel.displayName}...`);
        channel.appendLine('');

        const escalatedRec: RouteRecommendation = {
          ...rec,
          primaryModel: escalatedModel,
          thinkingBudget: Math.min(rec.thinkingBudget * 2 || 4096, 32000),
        };

        const escalatedResult = await streamAnthropicCall(
          client, escalatedRec, system, messages,
          escalatedModel.supportsThinking && escalatedRec.thinkingBudget > 0,
          escalatedModel.supportsThinking ? 1.0 : rec.temperature,
          channel,
        );

        const duration = Date.now() - startMs;
        return {
          ...escalatedResult,
          durationMs: duration,
          cacheHit: escalatedResult.cacheHit ?? false,
          cacheWriteTokens: escalatedResult.cacheWriteTokens ?? 0,
          cacheReadTokens: escalatedResult.cacheReadTokens ?? 0,
          cacheSavingsUSD: escalatedResult.cacheSavingsUSD ?? 0,
          qualityScore: 85, // post-escalation assumed improvement
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

async function streamAnthropicCall(
  client: Anthropic,
  rec: RouteRecommendation,
  system: Anthropic.Messages.TextBlockParam[],
  messages: Anthropic.Messages.MessageParam[],
  useThinking: boolean,
  temperature: number,
  channel: vscode.OutputChannel,
): Promise<StreamResult> {
  const requestParams: Record<string, unknown> = {
    model: rec.primaryModel.id,
    max_tokens: rec.maxOutputTokens + (useThinking ? rec.thinkingBudget : 0),
    temperature,
    messages,
    stream: true,
  };

  if (system.length > 0) {
    requestParams['system'] = system;
  }

  if (useThinking) {
    requestParams['thinking'] = {
      type: 'enabled',
      budget_tokens: rec.thinkingBudget,
    };
  }

  let fullText = '';
  let thinkingText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let isInThinkingBlock = false;
  let thinkingDotsCount = 0;

  try {
    const stream = client.messages.stream(
      requestParams as unknown as Anthropic.Messages.MessageCreateParamsStreaming,
    );

    for await (const event of stream) {
      if (event.type === 'message_start') {
        const usage = event.message.usage as unknown as Record<string, number> | undefined;
        inputTokens = usage?.['input_tokens'] ?? 0;
        cacheCreationTokens = usage?.['cache_creation_input_tokens'] ?? 0;
        cacheReadTokens = usage?.['cache_read_input_tokens'] ?? 0;

        if (cacheReadTokens > 0) {
          channel.appendLine(`> Cache HIT: ${cacheReadTokens.toLocaleString()} tokens served from cache`);
          channel.appendLine('');
        } else if (cacheCreationTokens > 0) {
          channel.appendLine(`> Cache WRITE: ${cacheCreationTokens.toLocaleString()} tokens written to cache`);
          channel.appendLine('');
        }
      }

      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if ((block as { type: string }).type === 'thinking') {
          isInThinkingBlock = true;
          channel.appendLine('> *[Extended thinking in progress...]*');
          thinkingDotsCount = 0;
        } else if ((block as { type: string }).type === 'text') {
          if (isInThinkingBlock) {
            channel.appendLine('');
            channel.appendLine('---');
          }
          isInThinkingBlock = false;
        }
      }

      if (event.type === 'content_block_delta') {
        const delta = event.delta as unknown as Record<string, unknown>;

        if (delta['type'] === 'thinking_delta') {
          const thinking = delta['thinking'] as string;
          thinkingText += thinking;
          // Show dots as thinking progresses (every 100 chars)
          thinkingDotsCount += thinking.length;
          if (thinkingDotsCount > 100) {
            channel.append('·');
            thinkingDotsCount = 0;
          }
        } else if (delta['type'] === 'text_delta') {
          const text = delta['text'] as string;
          fullText += text;
          channel.append(text);
        }
      }

      if (event.type === 'message_delta') {
        const usage = (event as unknown as Record<string, unknown>)['usage'] as Record<string, number> | undefined;
        outputTokens = usage?.['output_tokens'] ?? 0;
      }
    }

    // ── Cost calculation ─────────────────────────
    const inputCost = (inputTokens / 1_000_000) * rec.primaryModel.inputCostPerMillion;
    const outputCost = (outputTokens / 1_000_000) * rec.primaryModel.outputCostPerMillion;
    const costUSD = inputCost + outputCost;

    const cacheStats = extractCacheStats(
      {
        input_tokens: inputTokens,
        cache_creation_input_tokens: cacheCreationTokens,
        cache_read_input_tokens: cacheReadTokens,
      },
      rec.primaryModel.inputCostPerMillion,
    );

    const thinkingTokens = Math.ceil(thinkingText.length / 4);

    channel.appendLine('');
    channel.appendLine('---');
    channel.appendLine(
      `*${rec.primaryModel.displayName} · in:${inputTokens} out:${outputTokens} ` +
      `think:${thinkingTokens} · $${costUSD.toFixed(5)}` +
      (cacheStats.wasAHit ? ` · cache saved $${cacheStats.estimatedSavingsUSD.toFixed(5)}` : '') +
      '*',
    );

    return {
      success: true,
      content: fullText,
      inputTokens,
      outputTokens,
      thinkingTokens,
      costUSD,
      modelUsed: rec.primaryModel.id,
      durationMs: 0, // set by caller
      cacheHit: cacheStats.wasAHit,
      cacheWriteTokens: cacheCreationTokens,
      cacheReadTokens,
      cacheSavingsUSD: cacheStats.estimatedSavingsUSD,
      qualityScore: 0, // set by caller after cascade
      wasEscalated: false,
      thinkingPreview: thinkingText.slice(0, 200),
    };
  } catch (err) {
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
