# Changelog

All notable changes to `@combycode/llm-sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Unified `CompletionResponse.files` (`FileOutput[]`) - files produced by hosted tools
  (code execution, etc.), independent of `media`. The Anthropic adapter surfaces
  code-execution file outputs there by file id; OpenAI/Google/xAI producers to follow.
- Model catalog: new `ModelInfo.availability` field (`limited` / `preview`, vs default
  generally-available) so gated / early-access models are distinguishable from the
  `status` lifecycle. (Entries for specific limited/preview models are populated by the
  catalog pipeline.)
- Anthropic: the unified `code_interpreter` builtin now maps to Anthropic's hosted
  `code_execution` tool (GA on Messages) - it was previously silently skipped. Hosted
  code execution is now usable across Anthropic / OpenAI / Google through one interface.
- Google service tier, both directions (parity with OpenAI/Anthropic): a requested
  unified `serviceTier` (`flex`/`standard`/`priority`) maps to Google's top-level
  request field, and the billed `usageMetadata.serviceTier` is read back into
  `usage.serviceTier` / `usage.pricingTier` for tiered cost tracking.
  (New `providers/google/tiers.ts`.)

## [1.0.0] - 2026-06-13

First public release.

### Added
- Unified API across Anthropic, OpenAI, Google, xAI, and OpenRouter.
- Model catalog: normalised slug names, `model:tier` selectors, and
  capability-based `select()`.
- Tiered pricing with cost tracking and budget limits.
- Service tiers end to end (request → bill → cost).
- Cross-environment: runs on Node, Bun, and the browser. ESM, zero runtime deps.

[1.0.0]: https://github.com/combycode/llm-sdk-ts/releases/tag/v1.0.0
