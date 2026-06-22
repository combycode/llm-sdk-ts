<!-- Keep PRs focused. A green lint + typecheck + test run is required to merge. -->

## What & why

<!-- What does this change and what problem does it solve? Link any issue. -->

## Checklist

- [ ] `bun run lint` passes
- [ ] `bun run typecheck` passes
- [ ] `bun test` passes, and new/changed behavior is covered by tests
- [ ] No new runtime dependency (the SDK is zero-dependency)
- [ ] Works in Node, Bun, and the browser (no static `node:` imports in shared paths)
- [ ] Docs updated if behavior or public API changed
