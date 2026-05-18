/**
 * ORC — Status Bar
 *
 * Displays a real-time token consumption odometer in the VS Code status bar.
 * Inspired by the cc-context-stats pattern described in the research:
 *   "real-time status line that visually tracks token consumption per session"
 *
 * Shows:
 *   ORC  ⚡ 12.4k tokens  $0.047  [████░░░░░░] 43%
 *
 * Color coding:
 *   Normal:  $(symbol-event) — standard blue
 *   Warning: $(warning)     — yellow at 70% of session budget
 *   Danger:  $(flame)       — red at 90% of session budget
 *
 * Clicking the item runs orc.showStatus for a detailed breakdown.
 */

import * as vscode from 'vscode';
import type { ExecutionResult, SessionStats } from '../types/index.js';
import type { GodModeExecutionResult } from '../executor/modelExecutor.js';

// Session budget estimates (tokens) per subscription tier
// Used to compute the progress bar percentage
const SESSION_BUDGET_TOKENS: Record<string, number> = {
  pro:    100_000,   // Claude Pro ~$20/mo rough session budget
  max5x:  500_000,   // Claude Max 5x
  max20x: 2_000_000, // Claude Max 20x
  api:    Infinity,  // Direct API — no artificial limit shown
};

export class OrcStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly enabled: boolean;
  private stats: SessionStats;
  private sessionBudget: number;
  private totalCacheSavingsUSD: number = 0;
  private totalCacheHits: number = 0;

  constructor(context: vscode.ExtensionContext, enabled: boolean = true) {
    this.enabled = enabled;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100, // priority — shows near the right edge
    );
    this.item.command = 'orc.showStatus';
    this.item.tooltip = 'ORC Cognitive Router — click for session details';

    this.stats = this.createFreshStats();
    this.sessionBudget = SESSION_BUDGET_TOKENS['max5x']; // sensible default

    context.subscriptions.push(this.item);
    this.render();
    if (this.enabled) { this.item.show(); }
  }

  // ─────────────────────────────────────────
  //  Public API
  // ─────────────────────────────────────────

  /** Called after each successful model execution */
  recordExecution(result: ExecutionResult): void {
    this.stats.totalPrompts++;
    this.stats.totalInputTokens += result.inputTokens;
    this.stats.totalOutputTokens += result.outputTokens;
    this.stats.totalThinkingTokens += result.thinkingTokens;
    this.stats.totalCostUSD += result.costUSD;
    this.stats.lastPromptMs = Date.now();
    this.stats.modelsUsed[result.modelUsed] = (this.stats.modelsUsed[result.modelUsed] ?? 0) + 1;

    // Track cache savings (god mode)
    const godResult = result as GodModeExecutionResult;
    if (godResult.cacheHit) {
      this.totalCacheHits++;
      this.totalCacheSavingsUSD += godResult.cacheSavingsUSD ?? 0;
    }

    this.render();
  }

  /** Resets the session counters */
  clearSession(): void {
    this.stats = this.createFreshStats();
    this.totalCacheSavingsUSD = 0;
    this.totalCacheHits = 0;
    this.render();
  }

  /** Returns a copy of current stats for external display */
  getStats(): SessionStats {
    return { ...this.stats };
  }

  setSessionBudget(tier: string): void {
    this.sessionBudget = SESSION_BUDGET_TOKENS[tier] ?? SESSION_BUDGET_TOKENS['max5x'];
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  // ─────────────────────────────────────────
  //  Rendering
  // ─────────────────────────────────────────

  private render(): void {
    if (!this.enabled) { return; }
    const totalTokens = this.stats.totalInputTokens + this.stats.totalOutputTokens + this.stats.totalThinkingTokens;
    const costStr = `$${this.stats.totalCostUSD.toFixed(3)}`;

    if (totalTokens === 0) {
      this.item.text = '$(symbol-event) ORC';
      this.item.backgroundColor = undefined;
      return;
    }

    const kTokens = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : String(totalTokens);

    let icon: string;
    let bg: vscode.ThemeColor | undefined;

    if (this.sessionBudget !== Infinity) {
      const pct = totalTokens / this.sessionBudget;
      const bar = buildProgressBar(pct, 8);

      if (pct >= 0.9) {
        icon = '$(flame)';
        bg = new vscode.ThemeColor('statusBarItem.errorBackground');
      } else if (pct >= 0.7) {
        icon = '$(warning)';
        bg = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        icon = '$(symbol-event)';
        bg = undefined;
      }

      this.item.text = `${icon} ORC  ${kTokens} tok  ${costStr}  ${bar}`;
    } else {
      icon = '$(symbol-event)';
      this.item.text = `${icon} ORC  ${kTokens} tok  ${costStr}`;
      bg = undefined;
    }

    this.item.backgroundColor = bg;
  }

  // ─────────────────────────────────────────
  //  Status Webview (orc.showStatus)
  // ─────────────────────────────────────────

  showDetailPanel(context: vscode.ExtensionContext): void {
    if (!this.enabled) {
      void vscode.window.showInformationMessage('ORC: Status bar is disabled. Enable orca.statusBarEnabled to view session stats.');
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'orcaStatus',
      'ORC — Session Status',
      vscode.ViewColumn.Beside,
      { enableScripts: false },
    );

    panel.webview.html = this.buildStatusHtml();
    context.subscriptions.push(panel);
  }

  private buildStatusHtml(): string {
    const s = this.stats;
    const totalTokens = s.totalInputTokens + s.totalOutputTokens + s.totalThinkingTokens;
    const sessionMin = Math.round((Date.now() - s.sessionStartMs) / 60_000);
    const topModel = Object.entries(s.modelsUsed).sort((a, b) => b[1] - a[1])[0];

    // Escape HTML in any user-derived strings rendered into the webview
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const modelRows = Object.entries(s.modelsUsed)
      .map(([m, c]) => `<tr><td>${esc(m)}</td><td>${c}</td></tr>`)
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px; }
  h2 { color: var(--vscode-symbolIcon-classForeground); margin-bottom: 4px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; }
  .card { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; padding: 12px; }
  .card h3 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; opacity: 0.6; }
  .card .value { font-size: 22px; font-weight: bold; }
  .card .sub { font-size: 11px; opacity: 0.7; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border); font-size: 12px; }
  th { opacity: 0.6; font-weight: normal; }
</style>
</head>
<body>
<h2>⚡ ORC Session Report</h2>
<p style="opacity:0.6;font-size:12px">Session duration: ${sessionMin} min · ${s.totalPrompts} prompts routed</p>

<div class="grid">
  <div class="card">
    <h3>Total Tokens</h3>
    <div class="value">${(totalTokens / 1000).toFixed(1)}k</div>
    <div class="sub">In: ${(s.totalInputTokens/1000).toFixed(1)}k · Out: ${(s.totalOutputTokens/1000).toFixed(1)}k · Think: ${(s.totalThinkingTokens/1000).toFixed(1)}k</div>
  </div>
  <div class="card">
    <h3>Estimated Cost</h3>
    <div class="value">$${s.totalCostUSD.toFixed(4)}</div>
    <div class="sub">${s.totalPrompts > 0 ? `~$${(s.totalCostUSD / s.totalPrompts).toFixed(4)} avg/prompt` : '—'}</div>
  </div>
  <div class="card">
    <h3>Top Model</h3>
    <div class="value" style="font-size:14px">${topModel ? topModel[0].split('-').slice(0,3).join('-') : '—'}</div>
    <div class="sub">${topModel ? `${topModel[1]} calls` : 'No calls yet'}</div>
  </div>
  <div class="card">
    <h3>Thinking Tokens</h3>
    <div class="value">${(s.totalThinkingTokens / 1000).toFixed(1)}k</div>
    <div class="sub">${totalTokens > 0 ? `${((s.totalThinkingTokens / totalTokens) * 100).toFixed(0)}% of total` : '—'}</div>
  </div>
  <div class="card">
    <h3>Cache Savings</h3>
    <div class="value" style="color:var(--vscode-terminal-ansiGreen)">$${this.totalCacheSavingsUSD.toFixed(4)}</div>
    <div class="sub">${this.totalCacheHits} cache hit${this.totalCacheHits !== 1 ? 's' : ''} this session</div>
  </div>
</div>

<h3 style="font-size:12px;opacity:0.7;margin-bottom:4px">MODELS USED THIS SESSION</h3>
<table>
  <tr><th>Model</th><th>Calls</th></tr>
  ${modelRows || '<tr><td colspan="2" style="opacity:0.5">No models used yet</td></tr>'}
</table>
</body>
</html>`;
  }

  // ─────────────────────────────────────────
  //  Helpers
  // ─────────────────────────────────────────

  private createFreshStats(): SessionStats {
    return {
      totalPrompts: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalThinkingTokens: 0,
      totalCostUSD: 0,
      sessionStartMs: Date.now(),
      lastPromptMs: Date.now(),
      modelsUsed: {},
    };
  }
}

// ─────────────────────────────────────────────
//  Progress Bar Builder
// ─────────────────────────────────────────────

function buildProgressBar(fraction: number, width: number): string {
  const filled = Math.round(Math.min(1, fraction) * width);
  const empty = width - filled;
  return `[${'\u2588'.repeat(filled)}${'\u2591'.repeat(empty)}]`;
}
