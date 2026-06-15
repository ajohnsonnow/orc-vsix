# Changelog

All notable changes to ORC — Cognitive Prompt Router are documented here.

## [0.1.0] — 2026-06-15

### Added
- **God Mode pipeline**: cognitive load scoring → model routing → approval UI → caching → streaming → self-correction cascade
- **5-tier model routing**: Haiku 4.5 → Sonnet 4.6 → Opus 4.8 → Fable 5, selected by prompt complexity score (1–10)
- **Claude Code integration**: writes recommended model + thinking budget to `~/.claude/settings.json`
- **Prompt caching**: `cache_control` breakpoints — up to 90% input cost reduction on repeated context
- **Extended thinking**: adaptive streaming thinking for Opus 4.8 and Fable 5
- **Self-correction cascade**: auto-escalates to a higher model if quality check fails (FrugalGPT pattern)
- **Context Guard**: warns on attention dilution, lost-in-middle effect, context rot, and peak API hours
- **Context Compression**: Haiku preprocessing for oversized context (65% savings target)
- **System prompt hardening**: anti-extraction directives, filler suppression, XML trust delimiters
- **Token odometer**: real-time status bar showing tokens used, cost, and cache savings per session
- **Prompt injection defenses**: all untrusted content wrapped in typed XML delimiters (`<editor_context>`, `<untrusted_context>`, `<developer_prompt>`)
- **Path traversal protection**: `claudeCodeSettingsPath` validated to `~/.claude/*.json` only
- **Concurrent pipeline guard**: prevents double-invocation race condition
- **Per-model token caps**: Fable 5 (128k), Opus 4.8 (32k), Sonnet 4.6 (16k), Haiku 4.5 (8k)
- **Stream timeout**: 120-second AbortController on all API calls with typed error messages
- **SecretStorage API key**: stored encrypted in VS Code SecretStorage, never in `settings.json`
- **Heuristic fallback mode**: all analysis and routing works without an API key

### Security
- 75-finding adversarial red-team audit applied before initial release
- Prompt injection mitigated at all 4 LLM call sites
- `capabilities.untrustedWorkspaces` restricts settings path in untrusted workspaces
