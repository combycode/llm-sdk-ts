# Contributing to @combycode/llm-sdk

Thanks for your interest in improving the SDK. This guide covers local setup, the
quality gates, and the conventions we hold the codebase to.

## Project principles

These shape almost every review decision:

- **Zero runtime dependencies.** The published package ships no runtime deps.
  A change that needs one is very unlikely to be accepted — propose it in an
  issue first.
- **Cross-environment.** Code must run in Node, Bun, and the browser. Avoid
  static `node:` imports in shared paths; use the runtime-swappable helpers.
- **All HTTP goes through the engine.** Never `fetch` directly from a provider
  adapter or plugin — route through the `NetworkEngine` so calls ride the queue,
  retries, auth injection, and telemetry.
- **Single responsibility + composability.** Small units, dependency injection,
  no hidden globals.

## Setup

The repo uses [Bun](https://bun.sh).

```sh
bun install
bun run build       # compile to dist/
```

## Quality gates (all required before a PR is merged)

```sh
bun run lint        # biome
bun run typecheck   # tsc --noEmit
bun test            # full suite
```

- Every new branch, function, or behavior must be covered by a test.
- Do not bypass a failing gate with an ignore/allow comment — fix the cause.
- Test subsets exist if you need them: `bun run test:unit`, `test:integration`,
  `test:helpers`. Live provider tests (`test:live`) need real API keys and are
  not part of the required gate.

## Pull requests

- Keep each PR focused on one change.
- Fill in the PR checklist.
- Commit messages are brief: one line for the *what* and *why*; add a body only
  when the reasoning is non-obvious. No plans, phase notes, or validation
  reports in commit messages.

## Docs

User-facing docs live in `docs/` (`docs/guide/` and `docs/design/`) and are
published to the documentation site. If your change alters public behavior or
API, update the relevant doc in the same PR.

## Security

Do not open public issues for vulnerabilities. Use the private advisory flow:
<https://github.com/combycode/llm-sdk-ts/security/advisories/new>.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
