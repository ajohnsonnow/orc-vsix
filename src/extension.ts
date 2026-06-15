/**
 * ORC — Cognitive Prompt Router (God Mode Edition)
 * VS Code Extension Entry Point
 *
 * Commands:
 *   orc.routePrompt          — Input box → analyze → approve → execute
 *   orc.analyzeSelection     — Use editor selection as prompt or context
 *   orc.applyRecommendation  — Re-apply last recommendation to Claude Code settings
 *   orc.showStatus           — Session stats webview
 *   orc.clearSession         — Reset token/cost counters
 *   orc.openSettings         — Open ORC VS Code settings
 *   orc.setApiKey            — Store Anthropic API key in VS Code SecretStorage
 *
 * God Mode Pipeline (per invocation — actual execution order):
 *   1.  Precision token counting   (Anthropic count_tokens API or heuristic)
 *   2.  Cognitive load analysis    (heuristic or Haiku LLM classifier → score 1–10)
 *   3.  Route recommendation       (model + thinking budget + Claude Code config)
 *   4.  Context Guard              (rot, dilution, lost-in-middle, peak-hour)
 *   5.  Context Compression        (Haiku preprocessing if context > tier budget, 65% savings)
 *   6.  Approval UI                (Approve / Override / Escalate / Downgrade / Cancel)
 *   7.  On approve:
 *       a. Apply to ~/.claude/settings.json (Claude Code integration)
 *       b. Inject hardened system prompt (anti-extraction + filler suppression)
 *       c. Execute with prompt caching + extended thinking streaming
 *       d. Self-correction quality cascade (auto-escalate on failure)
 *       e. Record stats + cache savings + subscription tier advisory
 */

import * as vscode from 'vscode';
import { analyzeHeuristic } from './analyzer/heuristicAnalyzer.js';
import { analyzeLLM } from './analyzer/cognitiveAnalyzer.js';
import { buildRecommendation } from './router/promptRouter.js';
import { showApprovalDialog, showPromptInputBox } from './ui/approvalUI.js';
import { OrcStatusBar } from './ui/statusBar.js';
import { confirmAndApply, getClaudeSettingsPath } from './settings/claudeSettings.js';
import { executeRecommendation, disposeOutputChannel } from './executor/modelExecutor.js';
import { runContextGuard, showContextGuardDiagnostics, checkPeakHourWindow, analyzeTierFit, MAX_CONTEXT_TOKENS } from './diagnostics/contextGuard.js';
import { countTokensViaAPI, countTokensHeuristic } from './diagnostics/tokenCounter.js';
import { compressContext, shouldCompress } from './compression/contextCompressor.js';
import { buildHardenedSystemPrompt } from './security/systemPromptHardening.js';
import { exportDiagnosticsCommand } from './diagnostics/exportDiagnostics.js';
import type {
  AnalyzerMode,
  OrcConfig,
  PromptMetadata,
  RouteRecommendation,
  RoutingBias,
} from './types/index.js';

// ─────────────────────────────────────────────
//  Extension State
// ─────────────────────────────────────────────

let statusBar: OrcStatusBar;
let lastRecommendation: RouteRecommendation | null = null;

/** API key resolved at activation. Resolution order:
 *  1. ANTHROPIC_API_KEY environment variable (shared with Claude Code / CLI)
 *  2. ORC's own VS Code SecretStorage
 *  3. Empty string (heuristic-only mode; execution delegates to Claude Code) */
let _apiKey = '';

/** Tracks where the active API key came from, for UI messaging. */
let _apiKeySource: 'env' | 'secret' | 'none' = 'none';
let _pipelineRunning = false;

// ─────────────────────────────────────────────
//  Activate
// ─────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Load API key securely from SecretStorage (migrates from old plaintext setting)
  _apiKey = await loadApiKey(context);

  // Re-sync _apiKey whenever the secret changes (e.g. user runs orc.setApiKey)
  context.subscriptions.push(
    context.secrets.onDidChange(async e => {
      if (e.key === SECRET_KEY) {
        const k = await context.secrets.get(SECRET_KEY);
        _apiKey = k ?? '';
        _apiKeySource = k ? 'secret' : 'none';
      }
    }),
  );

  const statusBarEnabled = vscode.workspace.getConfiguration('orc').get<boolean>('statusBarEnabled', true);
  statusBar = new OrcStatusBar(context, statusBarEnabled);

  context.subscriptions.push(
    vscode.commands.registerCommand('orc.routePrompt',         () => routePromptCommand(context)),
    vscode.commands.registerCommand('orc.analyzeSelection',    () => analyzeSelectionCommand(context)),
    vscode.commands.registerCommand('orc.applyRecommendation', () => applyLastRecommendation()),
    vscode.commands.registerCommand('orc.showStatus',          () => statusBar.showDetailPanel(context)),
    vscode.commands.registerCommand('orc.clearSession',        () => {
      statusBar.clearSession();
      void vscode.window.showInformationMessage('ORC: Session counter cleared.');
    }),
    vscode.commands.registerCommand('orc.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'orc'),
    ),
    vscode.commands.registerCommand('orc.setApiKey', () => setApiKeyCommand(context)),
    vscode.commands.registerCommand('orc.exportDiagnostics', () => exportDiagnosticsCommand()),
  );

  // Peak-hour startup warning
  const peakHour = checkPeakHourWindow();
  if (peakHour) {
    void vscode.window.showWarningMessage(`ORC: ${peakHour.title} — ${peakHour.detail}`);
  }

  // First-install welcome
  const installed = context.globalState.get<boolean>('orc.installed');
  if (!installed) {
    void context.globalState.update('orc.installed', true);
    const keyMsg = _apiKeySource === 'env'
      ? 'API key detected from ANTHROPIC_API_KEY env var (shared with Claude Code).'
      : _apiKeySource === 'secret'
        ? 'API key loaded from SecretStorage.'
        : 'No API key found. ORC will delegate execution to Claude Code extension.';
    void vscode.window.showInformationMessage(
      `ORC Cognitive Router active. ${keyMsg}`,
      'Open Settings',
    ).then(choice => {
      if (choice === 'Open Settings') { void vscode.commands.executeCommand('orc.openSettings'); }
    });
  }
}

// ─────────────────────────────────────────────
//  SecretStorage: API Key Management
// ─────────────────────────────────────────────

const SECRET_KEY = 'orc.anthropicApiKey';
const LEGACY_CONFIG_KEY = 'anthropicApiKey'; // old plaintext setting to migrate

/**
 * Resolves the Anthropic API key from multiple sources (in priority order):
 *   1. ANTHROPIC_API_KEY environment variable — shared with Claude Code CLI
 *   2. ORC's own VS Code SecretStorage
 *   3. Legacy plaintext setting (migrated to SecretStorage on first read)
 *
 * Using the env var means ORC piggybacks on Claude Code's auth — no separate
 * key management required.
 */
async function loadApiKey(context: vscode.ExtensionContext): Promise<string> {
  // 1. Environment variable (shared with Claude Code CLI)
  const envKey = process.env['ANTHROPIC_API_KEY'];
  if (envKey) {
    _apiKeySource = 'env';
    return envKey;
  }

  // 2. ORC's own SecretStorage
  const stored = await context.secrets.get(SECRET_KEY);
  if (stored) {
    _apiKeySource = 'secret';
    return stored;
  }

  // 3. One-time migration: if user had the old plaintext setting, move it to SecretStorage
  const legacy = vscode.workspace.getConfiguration('orc').get<string>(LEGACY_CONFIG_KEY, '');
  if (legacy) {
    await context.secrets.store(SECRET_KEY, legacy);
    await vscode.workspace.getConfiguration('orc').update(
      LEGACY_CONFIG_KEY, '', vscode.ConfigurationTarget.Global,
    );
    _apiKeySource = 'secret';
    return legacy;
  }

  _apiKeySource = 'none';
  return '';
}

/** Command: prompts for an API key and stores it in VS Code SecretStorage. */
async function setApiKeyCommand(context: vscode.ExtensionContext): Promise<void> {
  const current = await context.secrets.get(SECRET_KEY);
  const sourceHint = _apiKeySource === 'env'
    ? '(currently using ANTHROPIC_API_KEY env var — this will override it)'
    : current ? '(key already set — enter new value to replace)' : 'sk-ant-...';
  const key = await vscode.window.showInputBox({
    title: 'ORC: Set Anthropic API Key',
    prompt: 'Stored in VS Code SecretStorage — never written to settings.json. ' +
      'Leave empty to use ANTHROPIC_API_KEY env var or delegate to Claude Code.',
    placeHolder: sourceHint,
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) { return; } // user cancelled

  const trimmed = key.trim();
  if (trimmed) {
    await context.secrets.store(SECRET_KEY, trimmed);
    _apiKey = trimmed;
    void vscode.window.showInformationMessage('ORC: API key saved securely in SecretStorage.');
  } else {
    await context.secrets.delete(SECRET_KEY);
    const envFallback = process.env['ANTHROPIC_API_KEY'] ?? '';
    _apiKey = envFallback;
    _apiKeySource = envFallback ? 'env' : 'none';
    void vscode.window.showInformationMessage(
      envFallback ? 'ORC: API key cleared — falling back to ANTHROPIC_API_KEY env var.' : 'ORC: API key cleared.',
    );
  }
}

// ─────────────────────────────────────────────
//  Command: orc.routePrompt
// ─────────────────────────────────────────────

async function routePromptCommand(context: vscode.ExtensionContext): Promise<void> {
  // Pre-fill from clipboard — lets users copy from Claude Code chat (or anywhere) then Ctrl+Shift+O R
  const clipboardText = (await vscode.env.clipboard.readText()).trim();
  const prefill = clipboardText.length >= 3 && clipboardText.length <= MAX_PROMPT_CHARS
    ? clipboardText
    : undefined;

  const prompt = await showPromptInputBox(prefill);
  if (!prompt) { return; }

  const editor = vscode.window.activeTextEditor;
  const contextText = editor?.selection && !editor.selection.isEmpty
    ? editor.document.getText(editor.selection)
    : '';

  await runGodModePipeline(prompt, contextText, context);
}

// ─────────────────────────────────────────────
//  Command: orc.analyzeSelection
// ─────────────────────────────────────────────

async function analyzeSelectionCommand(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showWarningMessage('ORC: No text selected.');
    return;
  }

  const selectedText = editor.document.getText(editor.selection);

  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(symbol-event) This selection IS my prompt', value: 'prompt' },
      { label: '$(file-code) This selection is context — I\'ll type my prompt', value: 'context' },
    ],
    { title: 'ORC: How should I use this selection?', ignoreFocusOut: true },
  );

  if (!choice) { return; }

  if (choice.value === 'prompt') {
    await runGodModePipeline(selectedText, '', context);
  } else {
    const prompt = await showPromptInputBox();
    if (!prompt) { return; }
    await runGodModePipeline(prompt, selectedText, context);
  }
}

// ─────────────────────────────────────────────
//  Command: orc.applyRecommendation
// ─────────────────────────────────────────────

async function applyLastRecommendation(): Promise<void> {
  if (!lastRecommendation) {
    void vscode.window.showInformationMessage('ORC: No recommendation yet. Run a prompt first.');
    return;
  }

  if (!lastRecommendation.claudeCodeCommand) {
    void vscode.window.showInformationMessage(
      `ORC: Last recommendation (${lastRecommendation.primaryModel.displayName}) is not a Claude model — nothing to write.`,
    );
    return;
  }

  const config = getOrcConfig();
  const settingsPath = getClaudeSettingsPath(config.claudeCodeSettingsPath);
  await confirmAndApply(lastRecommendation.claudeCodeCommand, settingsPath, false);
}

// ─────────────────────────────────────────────
//  God Mode Pipeline
// ─────────────────────────────────────────────

const MAX_PROMPT_CHARS = 32_000;
const MAX_CONTEXT_CHARS = 500_000;

async function runGodModePipeline(
  prompt: string,
  contextText: string,
  _context: vscode.ExtensionContext,
): Promise<void> {
  if (prompt.length > MAX_PROMPT_CHARS) {
    void vscode.window.showErrorMessage(
      `ORC: Prompt too long (${prompt.length.toLocaleString()} chars, max ${MAX_PROMPT_CHARS.toLocaleString()}).`,
    );
    return;
  }
  if (contextText.length > MAX_CONTEXT_CHARS) {
    void vscode.window.showErrorMessage(
      `ORC: Context too large (${contextText.length.toLocaleString()} chars, max ${MAX_CONTEXT_CHARS.toLocaleString()}).`,
    );
    return;
  }
  if (_pipelineRunning) {
    void vscode.window.showWarningMessage('ORC: A pipeline is already running. Please wait.');
    return;
  }
  const config = getOrcConfig();
  const settingsPath = getClaudeSettingsPath(config.claudeCodeSettingsPath);

  _pipelineRunning = true;
  await Promise.resolve(vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ORC: Analyzing...',
      cancellable: false,
    },
    async (progress) => {

      // ── Step 1: Precision Token Counting ─────────
      // Free Anthropic count_tokens API when key is available; heuristic fallback.
      progress.report({ message: 'Counting tokens...' });

      let promptTokens: number;
      let contextTokens: number;

      if (config.anthropicApiKey) {
        const [promptCount, contextCount] = await Promise.all([
          countTokensViaAPI(prompt, 'claude-haiku-4-5-20251001', config.anthropicApiKey),
          contextText ? countTokensViaAPI(contextText, 'claude-haiku-4-5-20251001', config.anthropicApiKey) : Promise.resolve({ tokens: 0 }),
        ]);
        promptTokens = promptCount.tokens;
        contextTokens = contextCount.tokens;
      } else {
        promptTokens = countTokensHeuristic(prompt).tokens;
        contextTokens = contextText ? countTokensHeuristic(contextText).tokens : 0;
      }

      const meta: PromptMetadata = {
        prompt,
        estimatedPromptTokens: promptTokens,
        contextFileCount: contextText ? 1 : 0,
        contextFileTokens: contextTokens,
        totalContextTokens: promptTokens + contextTokens,
        hasCodeSelection: !!contextText,
        selectionLineCount: contextText ? contextText.split('\n').length : 0,
      };

      // ── Step 2: Cognitive Load Analysis ──────────
      // Heuristic (<1ms) or Haiku LLM (~$0.001) → score 1–10 + routing tier.
      // Analysis runs BEFORE context guard so tier thresholds are tier-accurate.
      progress.report({ message: 'Analyzing cognitive load...' });

      const analyzerMode: AnalyzerMode = config.analyzerMode;
      const useLLM = analyzerMode === 'llm' ||
        (analyzerMode === 'auto' && config.anthropicApiKey.length > 0);

      const analysis = useLLM
        ? await analyzeLLM(meta, config.anthropicApiKey)
        : analyzeHeuristic(meta);

      // ── Step 3: Route Recommendation ─────────────
      // Maps tier + bias to a specific model, thinking budget, cost estimate.
      const bias: RoutingBias = config.defaultBias;
      const rec = buildRecommendation(analysis, meta, bias, config.costWarningThresholdUSD);
      lastRecommendation = rec;

      // ── Step 4: Context Guard ─────────────────────
      // Fires tier-aware warnings: attention dilution, lost-in-middle, peak-hour.
      progress.report({ message: 'Running context guard...' });

      if (config.showCostWarnings) {
        const guardReport = runContextGuard(meta, analysis.tier);
        const guardPassed = await showContextGuardDiagnostics(guardReport);
        if (!guardPassed) { return; }
      }

      // ── Step 5: Context Compression ──────────────
      // Haiku preprocessing when context exceeds tier budget — 65% savings target.
      // Uses tier's MAX_CONTEXT_TOKENS as the budget (not an arbitrary fraction).
      let effectiveContextText = contextText;
      const tierContextBudget = MAX_CONTEXT_TOKENS[rec.analysis.tier];
      if (
        contextText &&
        config.anthropicApiKey &&
        shouldCompress(contextTokens, tierContextBudget, rec.primaryModel.inputCostPerMillion)
      ) {
        progress.report({ message: 'Compressing context with Haiku...' });
        const compressionResult = await compressContext(
          contextText,
          prompt,
          Math.round(tierContextBudget * 0.8),
          rec.primaryModel.inputCostPerMillion,
          config.anthropicApiKey,
        );

        if (compressionResult.wasCompressed) {
          effectiveContextText = compressionResult.compressed;
          void vscode.window.showInformationMessage(
            `ORC: Context compressed ${(compressionResult.originalTokens / 1000).toFixed(1)}k → ` +
            `${(compressionResult.compressedTokens / 1000).toFixed(1)}k tokens ` +
            `(${Math.round((1 - compressionResult.compressionRatio) * 100)}% reduction, ` +
            `~$${compressionResult.estimatedSavingsUSD.toFixed(4)} saved)`,
          );
        }
      }

      // ── Step 6: Approval UI ───────────────────────
      const approval = await showApprovalDialog(rec, config.autoApplyToClaudeCode);
      if (!approval) { return; }

      const finalRec = approval.finalRecommendation;

      // ── Step 7a: Apply to Claude Code settings ────
      if (approval.applyToClaudeCode && finalRec.claudeCodeCommand) {
        await confirmAndApply(finalRec.claudeCodeCommand, settingsPath, config.autoApplyToClaudeCode);
      }

      // Settings-only: user applied settings without requesting model execution
      if (approval.outcome === 'settings-only') { return; }

      // ── Step 7b: No API key — delegate to Claude Code ──
      if (!config.anthropicApiKey) {
        // Settings already applied in 7a. Launch Claude Code with the prompt.
        const choice = await vscode.window.showInformationMessage(
          `ORC: No direct API key — routing to Claude Code extension.\n` +
          `Model: ${finalRec.primaryModel.displayName} (applied to settings.json)`,
          'Open Claude Code',
          'Copy CLI Hint',
          'Set API Key',
        );
        if (choice === 'Open Claude Code') {
          await sendToClaudeCode(prompt);
        } else if (choice === 'Copy CLI Hint') {
          const hint = finalRec.claudeCodeCommand?.cliHint ?? finalRec.primaryModel.displayName;
          await vscode.env.clipboard.writeText(hint);
        } else if (choice === 'Set API Key') {
          await vscode.commands.executeCommand('orc.setApiKey');
        }
        return;
      }

      if (finalRec.primaryModel.provider !== 'anthropic') {
        void vscode.window.showInformationMessage(
          `ORC: Direct execution for ${finalRec.primaryModel.provider} not yet implemented. ` +
          `CLI hint: ${finalRec.claudeCodeCommand?.cliHint ?? 'N/A'}`,
        );
        return;
      }

      // ── Step 7b: Harden system prompt ────────────
      // Suppresses filler tokens, prevents JustAsk extraction attacks, enforces
      // strict output format. Injected immediately before execution.
      progress.report({ message: `Running ${finalRec.primaryModel.displayName}...` });

      const taskType = /\b(implement|write|fix|refactor|code)\b/i.test(prompt) ? 'code'
        : /\b(analyze|review|explain|compare)\b/i.test(prompt) ? 'analysis'
        : 'general';
      const hardenedPrompt = buildHardenedSystemPrompt({
        taskRole: taskType,
        isSubagent: false,
        suppressThinkingTrace: false,
      });
      if (finalRec.claudeCodeCommand) {
        finalRec.claudeCodeCommand = {
          ...finalRec.claudeCodeCommand,
          systemPromptPrefix: hardenedPrompt + '\n\n' + (finalRec.claudeCodeCommand.systemPromptPrefix ?? ''),
        };
      }

      // ── Step 7c: Execute (caching + streaming) ────
      const result = await executeRecommendation(
        prompt,
        finalRec,
        config.anthropicApiKey,
        effectiveContextText || undefined,
      );

      // ── Step 7d: Quality cascade (runs inside executor) + record result ──
      if (!result.success) {
        void vscode.window.showErrorMessage(`ORC: Execution failed — ${result.error}`);
        return;
      }

      statusBar.recordExecution(result);

      // ── Step 7e: Post-run advisories ──────────────
      if (result.cacheHit && result.cacheSavingsUSD > 0.001) {
        void vscode.window.showInformationMessage(
          `ORC: Cache HIT — saved $${result.cacheSavingsUSD.toFixed(5)} ` +
          `(${result.cacheReadTokens.toLocaleString()} tokens from cache)`,
        );
      }

      if (result.wasEscalated) {
        void vscode.window.showWarningMessage(
          `ORC Cascade: Response escalated to ${result.escalatedToModel ?? 'higher model'} ` +
          `due to quality issues. Quality score: ${result.qualityScore}/100.`,
        );
      }

      const sessionStats = statusBar.getStats();
      const tierAdvice = analyzeTierFit(sessionStats);
      if (tierAdvice.shouldUpgrade) {
        void vscode.window.showInformationMessage(`ORC Advisor: ${tierAdvice.reason}`, 'Dismiss');
      }
    },
  )).finally(() => { _pipelineRunning = false; });
}

// ─────────────────────────────────────────────
//  Claude Code Extension Integration
// ─────────────────────────────────────────────

const CLAUDE_CODE_EXT_ID = 'anthropic.claude-code';

/**
 * Sends a prompt to Claude Code after ORC has applied routing settings.
 * Copies prompt to clipboard, then focuses Claude Code's input via its
 * registered command so the user only needs Ctrl+V to send.
 */
async function sendToClaudeCode(prompt: string): Promise<void> {
  const ext = vscode.extensions.getExtension(CLAUDE_CODE_EXT_ID);
  if (!ext) {
    void vscode.window.showErrorMessage(
      'ORC: Claude Code extension (anthropic.claude-code) is not installed. ' +
      'Install it from the VS Code Marketplace or set an API key directly.',
    );
    return;
  }

  await vscode.env.clipboard.writeText(prompt);

  // claude-vscode.focus focuses Claude Code's chat input — user just presses Ctrl+V
  try {
    await vscode.commands.executeCommand('claude-vscode.focus');
    void vscode.window.showInformationMessage(
      'ORC: Model settings applied. Claude Code is focused — press Ctrl+V to send your prompt.',
    );
  } catch {
    // claude-vscode.focus unavailable in this version — fall back to manual paste
    void vscode.window.showInformationMessage(
      'ORC: Model settings applied. Prompt copied — open Claude Code (Ctrl+L) and paste.',
    );
  }
}

// ─────────────────────────────────────────────
//  Config Reader
// ─────────────────────────────────────────────

function getOrcConfig(): OrcConfig {
  const cfg = vscode.workspace.getConfiguration('orc');
  return {
    // API key from env var (Claude Code shared), SecretStorage, or empty
    anthropicApiKey:         _apiKey,
    analyzerMode:            cfg.get<OrcConfig['analyzerMode']>('analyzerMode', 'auto'),
    defaultBias:             cfg.get<OrcConfig['defaultBias']>('defaultBias', 'claude'),
    showCostWarnings:        cfg.get<boolean>('showCostWarnings', true),
    costWarningThresholdUSD: cfg.get<number>('costWarningThresholdUSD', 0.1),
    autoApplyToClaudeCode:   cfg.get<boolean>('autoApplyToClaudeCode', false),
    statusBarEnabled:        cfg.get<boolean>('statusBarEnabled', true),
    claudeCodeSettingsPath:  cfg.get<string>('claudeCodeSettingsPath', ''),
  };
}

// ─────────────────────────────────────────────
//  Deactivate
// ─────────────────────────────────────────────

export function deactivate(): void {
  statusBar?.dispose();
  disposeOutputChannel();
}
