/**
 * Export the live VS Code Problems panel to a JSON file.
 *
 * VS Code's Problems panel aggregates diagnostics from every active extension
 * (TS language server, ESLint extension, Snyk IDE, cspell extension, markdown
 * linters, etc). Many of these surface findings that the corresponding CLI
 * tools miss, because IDE extensions can:
 *   - honour inline ignore comments the CLI ignores
 *   - run incremental / deeper analysis on in-memory buffers
 *   - include findings from proprietary rule packs
 *
 * The preflight pipeline runs CLI tools, so it can't see IDE-only findings.
 * This command writes `vscode.languages.getDiagnostics()` to a project file
 * that preflight can read as an additional gate.
 *
 * Default output: <workspaceRoot>/.diagnostics/vscode-problems.json
 * Shape:
 *   {
 *     "generated": "2026-04-21T12:34:56.000Z",
 *     "workspace": "<absolute workspace folder>",
 *     "summary": { "error": N, "warning": N, "info": N, "hint": N, "files": N },
 *     "problems": [
 *       { "file": "relative/path", "line": N, "column": N, "severity": "error"|...,
 *         "source": "ts|eslint|snyk|cspell|...", "code": "...", "message": "..." }
 *     ]
 *   }
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type SeverityName = 'error' | 'warning' | 'info' | 'hint';

function severityName(s: vscode.DiagnosticSeverity): SeverityName {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'info';
  }
}

function codeToString(code: vscode.Diagnostic['code']): string {
  if (code == null) return '';
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  // { value, target }
  return String(code.value ?? '');
}

export interface ExportOptions {
  /** Absolute output path. Default: <workspace>/.diagnostics/vscode-problems.json */
  outputPath?: string;
  /** Minimum severity to include. Default: 'hint' (everything). */
  minSeverity?: SeverityName;
  /** Only include diagnostics from these source IDs (ts, eslint, snyk, cspell, ...). */
  sources?: string[];
}

const SEVERITY_ORDER: Record<SeverityName, number> = { error: 0, warning: 1, info: 2, hint: 3 };

export function exportDiagnostics(opts: ExportOptions = {}): {
  outputPath: string;
  problemCount: number;
} {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    throw new Error('No workspace folder is open — cannot export diagnostics.');
  }
  const wsRoot = ws.uri.fsPath;
  const outPath =
    opts.outputPath ?? path.join(wsRoot, '.diagnostics', 'vscode-problems.json');
  const minSev = opts.minSeverity ?? 'hint';
  const minSevOrd = SEVERITY_ORDER[minSev];
  const sourceFilter = opts.sources?.length ? new Set(opts.sources.map((s) => s.toLowerCase())) : null;

  const all = vscode.languages.getDiagnostics();
  const problems: Array<{
    file: string;
    line: number;
    column: number;
    severity: SeverityName;
    source: string;
    code: string;
    message: string;
  }> = [];
  const fileSet = new Set<string>();
  const counts: Record<SeverityName, number> = { error: 0, warning: 0, info: 0, hint: 0 };

  for (const [uri, diags] of all) {
    // Only include files inside the workspace — skips node_modules, scheme: vscode-*, etc.
    if (uri.scheme !== 'file') continue;
    const abs = uri.fsPath;
    if (!abs.startsWith(wsRoot)) continue;
    const rel = path.relative(wsRoot, abs).replace(/\\/g, '/');
    // Skip third-party directories to keep the export tight.
    if (/^(?:node_modules|\.next|dist|out|coverage|\.archive)(?:\/|$)/.test(rel)) continue;

    for (const d of diags) {
      const sev = severityName(d.severity);
      if (SEVERITY_ORDER[sev] > minSevOrd) continue;
      const src = (d.source ?? '').toLowerCase();
      if (sourceFilter && !sourceFilter.has(src)) continue;
      counts[sev]++;
      fileSet.add(rel);
      problems.push({
        file: rel,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity: sev,
        source: d.source ?? '',
        code: codeToString(d.code),
        message: d.message,
      });
    }
  }

  // Sort: by severity, then file, then line.
  problems.sort((a, b) => {
    const sd = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sd !== 0) return sd;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  const payload = {
    generated: new Date().toISOString(),
    workspace: wsRoot,
    summary: { ...counts, files: fileSet.size },
    problems,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { outputPath: outPath, problemCount: problems.length };
}

/** VS Code command entry point. Triggered by `orc.exportDiagnostics` or the
 *  `ORC: Export Problems Panel to JSON` command palette entry. */
export function exportDiagnosticsCommand(): void {
  try {
    const { outputPath, problemCount } = exportDiagnostics();
    const relOut = vscode.workspace.asRelativePath(outputPath);
    vscode.window.showInformationMessage(
      `ORC: exported ${problemCount} problem(s) to ${relOut}`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `ORC: failed to export diagnostics — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
