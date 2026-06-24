# Changelog

All notable changes to `@combycode/llm-sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Google: billed service tier from `usageMetadata.serviceTier` now populates
  `usage.serviceTier` / `usage.pricingTier` (parity with OpenAI/Anthropic), so
  tiered cost tracking works for Google responses.

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
