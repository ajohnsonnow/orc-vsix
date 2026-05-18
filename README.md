# ORC — Cognitive Prompt Router

> VS Code extension that sits between your prompt and the AI model, analyzes cognitive load, and routes to the optimal model + effort level. Implements every 2026 AI economics best practice.

## Features

| Feature | Detail |
|---|---|
| **Cognitive load scoring** | Heuristic (<1ms, no key) or Haiku LLM classifier (~$0.001) |
| **5-tier model routing** | Haiku → Sonnet → Opus based on task complexity score (1–10) |
| **Claude Code integration** | Writes recommended model + thinking budget to `~/.claude/settings.json` |
| **Prompt caching** | `cache_control` breakpoints — up to 90% input cost reduction |
| **Extended thinking** | Streaming extended thinking with budget (1k–32k tokens) |
| **Self-correction cascade** | Auto-escalates if quality check fails (FrugalGPT pattern) |
| **Context Guard** | Warns on attention dilution, lost-in-middle, context rot |
| **Context Compression** | Haiku preprocessing for oversized context (65% savings) |
| **System prompt hardening** | Anti-extraction directives, filler suppression |
| **Token odometer** | Real-time status bar: tokens, cost, cache savings |

## Quick Start

1. Install the extension
2. Run **ORC: Set API Key** (stores securely in VS Code SecretStorage — never in settings.json)
3. Press `Ctrl+Shift+O R` (or `Cmd+Shift+O R` on Mac) to route a prompt
4. Review the recommendation → Approve / Override / Escalate / Downgrade

## Keybindings

| Key | Command |
|---|---|
| `Ctrl+Shift+O R` | Route & Send Prompt |
| `Ctrl+Shift+O A` | Analyze Selected Text as Prompt (when selection active) |

## Commands

| Command | Description |
|---|---|
| `ORC: Route & Send Prompt` | Main command — analyze, approve, execute |
| `ORC: Analyze Selected Text as Prompt` | Use editor selection as prompt or context |
| `ORC: Apply Last Recommendation to Claude Code` | Re-apply routing to `~/.claude/settings.json` |
| `ORC: Show Token & Cost Status` | Open session stats webview |
| `ORC: Clear Session Token Count` | Reset odometer |
| `ORC: Set Anthropic API Key` | Store API key in SecretStorage |
| `ORC: Open Settings` | Open ORC configuration |

## Settings

| Setting | Default | Description |
|---|---|---|
| `orc.analyzerMode` | `"auto"` | `llm` / `heuristic` / `auto` |
| `orc.defaultBias` | `"claude"` | `claude` / `balanced` / `cost` |
| `orc.autoApplyToClaudeCode` | `false` | Skip confirm when writing settings.json |
| `orc.costWarningThresholdUSD` | `0.10` | Warn when estimated cost exceeds this |
| `orc.showCostWarnings` | `true` | Enable context guard + cost warnings |
| `orc.statusBarEnabled` | `true` | Show token odometer in status bar |
| `orc.claudeCodeSettingsPath` | `""` | Override path to `~/.claude/settings.json` |

## Routing Tiers

| Score | Tier | Model | Thinking Budget |
|---|---|---|---|
| 1–2 | minimal | Claude Haiku 4.5 | — |
| 3–4 | low | Claude Haiku 4.5 | 1,024 |
| 5–6 | medium | Claude Sonnet 4.6 | 4,096 |
| 7–8 | high | Claude Sonnet 4.6 | 10,000 |
| 9–10 | extreme | Claude Opus 4.6 | 32,000 |

## Development

```bash
npm install
npm run compile      # build once
npm run watch        # incremental watch
npm run test:unit    # vitest (154 tests)
npm run lint         # eslint — must be zero errors
npm audit            # zero vulnerabilities required
# F5 in VS Code → launch Extension Host
```

See [CLAUDE.md](CLAUDE.md) for the complete architecture reference.

## License

MIT
