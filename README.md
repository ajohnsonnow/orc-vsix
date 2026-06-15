# ORC — Cognitive Prompt Router

> VS Code extension that sits between your prompt and the AI model, analyzes cognitive load, and routes to the optimal model + effort level. Implements every 2026 AI economics best practice.

## Features

| Feature | Detail |
| --- | --- |
| **Cognitive load scoring** | Heuristic (<1ms, no key) or Haiku LLM classifier (~$0.001) |
| **5-tier model routing** | Haiku → Sonnet → Opus based on task complexity score (1–10) |
| **Claude Code integration** | Writes recommended model + thinking budget to `~/.claude/settings.json` |
| **Prompt caching** | `cache_control` breakpoints — up to 90% input cost reduction |
| **Extended thinking** | Streaming extended thinking with budget (1k–128k tokens) |
| **Self-correction cascade** | Auto-escalates if quality check fails (FrugalGPT pattern) |
| **Context Guard** | Warns on attention dilution, lost-in-middle, context rot |
| **Context Compression** | Haiku preprocessing for oversized context (65% savings) |
| **System prompt hardening** | Anti-extraction directives, filler suppression |
| **Token odometer** | Real-time status bar: tokens, cost, cache savings |
| **Hybrid local routing** | Plan/reason on Claude; run code tasks **free** on a local LM Studio model |
| **Local execution** | Streams from LM Studio's OpenAI-compatible API — no Anthropic key, $0 cost |
| **Local image generation** | `ORC: Generate Image` drives a local ComfyUI server |

## Quick Start

1. Install the extension
2. Run **ORC: Set API Key** (stores securely in VS Code SecretStorage — never in settings.json)
3. Press `Ctrl+Shift+O R` (or `Cmd+Shift+O R` on Mac) to route a prompt
4. Review the recommendation → Approve / Override / Escalate / Downgrade

## Keybindings

| Key | Command |
| --- | --- |
| `Ctrl+Shift+O R` | Route & Send Prompt |
| `Ctrl+Shift+O A` | Analyze Selected Text as Prompt (when selection active) |

## Commands

| Command | Description |
| --- | --- |
| `ORC: Route & Send Prompt` | Main command — analyze, approve, execute |
| `ORC: Analyze Selected Text as Prompt` | Use editor selection as prompt or context |
| `ORC: Apply Last Recommendation to Claude Code` | Re-apply routing to `~/.claude/settings.json` |
| `ORC: Show Token & Cost Status` | Open session stats webview |
| `ORC: Clear Session Token Count` | Reset odometer |
| `ORC: Set Anthropic API Key` | Store API key in SecretStorage |
| `ORC: Open Settings` | Open ORC configuration |
| `ORC: Generate Image (local ComfyUI)` | Generate an image on a local ComfyUI server |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `orc.analyzerMode` | `"auto"` | `llm` / `heuristic` / `auto` |
| `orc.defaultBias` | `"claude"` | `claude` / `balanced` / `cost` / `hybrid` |
| `orc.autoApplyToClaudeCode` | `false` | Skip confirm when writing settings.json |
| `orc.costWarningThresholdUSD` | `0.10` | Warn when estimated cost exceeds this |
| `orc.showCostWarnings` | `true` | Enable context guard + cost warnings |
| `orc.statusBarEnabled` | `true` | Show token odometer in status bar |
| `orc.claudeCodeSettingsPath` | `""` | Override path to `~/.claude/settings.json` |
| `orc.localRoutingEnabled` | `true` | Let `hybrid` bias route code tasks to a local model |
| `orc.lmStudioEndpoint` | `"http://127.0.0.1:1234"` | LM Studio OpenAI-compatible base URL |
| `orc.localCodingModel` | `"qwen2.5-coder-32b-instruct"` | LM Studio model id for local code tasks |
| `orc.comfyUIEndpoint` | `"http://127.0.0.1:8188"` | ComfyUI base URL for image generation |
| `orc.comfyWorkflowPath` | `""` | Path to an API-format ComfyUI workflow with a `%ORC_PROMPT%` token |

## Routing Tiers

| Score | Tier | Model | Thinking Budget |
| --- | --- | --- | --- |
| 1–2 | minimal | Claude Haiku 4.5 | — |
| 3–4 | low | Claude Haiku 4.5 | 1,024 |
| 5–6 | medium | Claude Sonnet 4.6 | 4,096 |
| 7–8 | high | Claude Opus 4.8 | 10,000 |
| 9–10 | extreme | Claude Fable 5 | 32,000–128,000 |

## Local & Hybrid Routing (free coding on your machine)

Set `orc.defaultBias` to `hybrid` to **plan and reason on Claude (Opus/Fable), then run code tasks for free on a local model**. ORC detects whether a prompt is a coding task and, if so, routes it to a local [LM Studio](https://lmstudio.ai) model over its OpenAI-compatible API — no Anthropic key required, $0 per run. Planning/analysis prompts still go to Claude.

1. Install LM Studio, download a coding model (recommended: **Qwen2.5-Coder-32B-Instruct**), and start its local server (Developer → Start Server, default `:1234`).
2. Set `orc.defaultBias` to `hybrid`. ORC checks the server before each code task; if it's unreachable, it transparently falls back to Claude.
3. Point `orc.localCodingModel` at the model id you loaded (default `qwen2.5-coder-32b-instruct`).

### Local image generation (ComfyUI)

`ORC: Generate Image` sends a prompt to a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server (default `:8188`).

- **Classic checkpoints (SD/SDXL):** works out of the box — ORC discovers a checkpoint and builds a standard txt2img graph.
- **Flux / HiDream / SD3 (UNET-based):** export your working graph from ComfyUI (**Save → API Format**), put the token `%ORC_PROMPT%` in your positive-prompt text field, and set `orc.comfyWorkflowPath` to that file. ORC injects the prompt, randomizes the seed, and submits it. Output is saved to `.orc-images/` in your workspace.

## Development

```bash
npm install
npm run compile      # build once
npm run watch        # incremental watch
npm run test:unit    # vitest (157 tests)
npm run lint         # eslint — must be zero errors
npm audit            # zero vulnerabilities required
# F5 in VS Code → launch Extension Host
```

See [CLAUDE.md](CLAUDE.md) for the complete architecture reference.

## Support

ORC is free and open source. If it saves you API costs or speeds up your workflow, a tip is always appreciated:

- Venmo: [@ajnow](https://venmo.com/u/ajnow)
- Cash App: [$ajnow](https://cash.app/$ajnow)
- PayPal: [paypal.me/ajohnsonnow](https://paypal.me/ajohnsonnow)

## License

MIT
