# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately via one of:
- GitHub private vulnerability reporting (preferred)
- Email to the repository maintainer

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment

You will receive an acknowledgement within 48 hours. Critical issues will be
patched within 7 days; a public advisory will follow after users have had time
to update.

## Security Design Notes

- **API key storage**: The Anthropic API key is stored exclusively in VS Code
  SecretStorage (OS-level credential store). It is never written to
  `settings.json` or any workspace file.
- **No network calls at activation**: ORC makes no outbound API calls until
  the user explicitly triggers a command.
- **System prompt hardening**: Built-in anti-extraction directives guard
  against prompt-injection attacks via malicious code files opened in the editor.
- **Dependency audit**: Run `npm audit` to check for known CVEs in dependencies.
  All production dependencies are pinned via `package-lock.json`.
