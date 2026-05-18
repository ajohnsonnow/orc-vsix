# Contributing to ORC — Cognitive Prompt Router

## Quick Start

```bash
git clone <repo>
cd orca-vsix
npm install
npm run compile     # build once
npm run test:unit   # run all tests
# F5 in VS Code → Extension Host (debug mode)
```

## Development Workflow

### Branch strategy
- `main` — always releasable
- Feature branches: `feat/<name>`, Bug fixes: `fix/<name>`

### Before every commit
```bash
npm run lint         # zero errors required
npm run compile      # must succeed
npm run test:unit    # all tests green
npm audit            # zero high/critical vulnerabilities
```

### Code style
- TypeScript strict mode — no `any` without a comment explaining why
- `void` operator for intentional fire-and-forget VS Code Thenable calls
- No `console.log` — use the VS Code output channel
- No floating promises — every `async` call must be `await`ed or prefixed `void`
- Prefer `const`, `readonly`, and narrow types

### Adding a new module
1. Create `src/<domain>/<module>.ts`
2. Add corresponding `src/test/<module>.test.ts`
3. Export shared types through `src/types/index.ts`
4. Update the pipeline table in `CLAUDE.md` if the module is part of the God Mode pipeline

### Tests
- Framework: Vitest 4.x
- Test files: `src/test/**/*.test.ts`
- VS Code API mock: `src/test/__mocks__/vscode.ts`
- Run: `npm run test:unit` (once) or `npm run test:unit:watch` (watch mode)

### Commit messages
Follow [Conventional Commits](https://www.conventionalcommits.org/):
```
feat(router): add DeepSeek R2 to model registry
fix(cache): handle empty context block below 1024 token minimum
docs(CLAUDE.md): update routing tier table
```

## Reporting Bugs
Open a GitHub issue with:
- VS Code version
- ORC version (from `package.json`)
- Steps to reproduce
- Expected vs actual behaviour

## Security Issues
See [SECURITY.md](SECURITY.md).
