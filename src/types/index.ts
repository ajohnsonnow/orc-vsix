/**
 * Orca Cognitive Prompt Router — Shared Types
 *
 * Core data structures that flow through the analysis → routing → approval → execution pipeline.
 */

// ─────────────────────────────────────────────
//  Cognitive Load
// ─────────────────────────────────────────────

export type CognitiveLoadScore = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type RoutingTier = 'minimal' | 'low' | 'medium' | 'high' | 'extreme';

export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'max';

export type AnalyzerMode = 'llm' | 'heuristic' | 'auto';

export type RoutingBias = 'claude' | 'balanced' | 'cost';

// ─────────────────────────────────────────────
//  Models
// ─────────────────────────────────────────────

export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'deepseek';

export interface ModelSpec {
  id: string;
  displayName: string;
  provider: ModelProvider;
  contextWindow: number;        // tokens
  inputCostPerMillion: number;  // USD
  outputCostPerMillion: number; // USD
  supportsThinking: boolean;
  maxThinkingBudget: number;    // tokens (0 if not supported)
  tier: RoutingTier;
  strengths: string[];
}

// ─────────────────────────────────────────────
//  Analysis
// ─────────────────────────────────────────────

export interface PromptMetadata {
  prompt: string;
  estimatedPromptTokens: number;
  contextFileCount: number;
  contextFileTokens: number;
  totalContextTokens: number;
  hasCodeSelection: boolean;
  selectionLineCount: number;
}

export interface CognitiveAnalysis {
  score: CognitiveLoadScore;
  tier: RoutingTier;
  signals: AnalysisSignal[];
  effortLevel: EffortLevel;
  estimatedThinkingTokens: number;
  analyzerUsed: 'llm' | 'heuristic';
  confidence: number; // 0–1
  reasoning: string;
}

export interface AnalysisSignal {
  type: 'keyword' | 'length' | 'complexity' | 'context' | 'intent' | 'multifile';
  label: string;
  weight: number; // contribution to score
}

// ─────────────────────────────────────────────
//  Routing Recommendation
// ─────────────────────────────────────────────

export interface RouteRecommendation {
  primaryModel: ModelSpec;
  fallbackModel: ModelSpec | null;
  effortLevel: EffortLevel;
  thinkingBudget: number;        // tokens (0 = disabled)
  temperature: number;
  maxOutputTokens: number;
  estimatedCostUSD: number;
  estimatedLatencyMs: number;
  costWarning: boolean;
  costWarningMessage: string;
  reasoning: string;
  claudeCodeCommand: ClaudeCodeConfig | null; // null if Claude Code not applicable
  analysis: CognitiveAnalysis;
}

export interface ClaudeCodeConfig {
  /** The model flag value for claude CLI, e.g. claude-opus-4-6 */
  model: string;
  /** The --thinking-budget flag value (0 = omit flag) */
  thinkingBudget: number;
  /** Whether to suggest /fast mode */
  useFastMode: boolean;
  /** System prompt prefix to inject for token efficiency */
  systemPromptPrefix: string;
  /** Human-readable CLI hint shown in approval UI */
  cliHint: string;
  /** Settings that should be written to ~/.claude/settings.json */
  settingsDelta: Record<string, unknown>;
}

// ─────────────────────────────────────────────
//  Session Tracking
// ─────────────────────────────────────────────

export interface SessionStats {
  totalPrompts: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalCostUSD: number;
  sessionStartMs: number;
  lastPromptMs: number;
  modelsUsed: Record<string, number>; // modelId → count
}

// ─────────────────────────────────────────────
//  User Approval
// ─────────────────────────────────────────────

export type ApprovalOutcome =
  | 'approved'          // user accepted recommendation
  | 'overridden'        // user picked a different model
  | 'escalated'         // user upgraded to a higher tier
  | 'downgraded'        // user downgraded to a lower tier
  | 'cancelled';        // user dismissed

export interface ApprovalResult {
  outcome: ApprovalOutcome;
  finalRecommendation: RouteRecommendation;
  applyToClaudeCode: boolean;
}

// ─────────────────────────────────────────────
//  Execution Result
// ─────────────────────────────────────────────

export interface ExecutionResult {
  success: boolean;
  content: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  costUSD: number;
  modelUsed: string;
  durationMs: number;
  error?: string;
}

// ─────────────────────────────────────────────
//  Extension Config (mirrors contributes.configuration)
// ─────────────────────────────────────────────

export interface OrcConfig {
  anthropicApiKey: string;
  analyzerMode: AnalyzerMode;
  defaultBias: RoutingBias;
  showCostWarnings: boolean;
  costWarningThresholdUSD: number;
  autoApplyToClaudeCode: boolean;
  statusBarEnabled: boolean;
  claudeCodeSettingsPath: string;
}
