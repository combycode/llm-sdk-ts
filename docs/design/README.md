# Design docs index

Internal architecture docs for `@combycode/llm-sdk`. These describe HOW and
WHY each subsystem works internally -- the real types, real data flow, real
trade-offs. For usage (how to call the library), see `docs/guide/`.

| Doc | Subsystem | Source |
|---|---|---|
| [network.md](network.md) | NetworkEngine -- multi-queue HTTP router, rate limiter (RPM/TPM/RPD token buckets), semaphore, retry/backoff, SSE parser, WebSocket realtime | `src/network/` |
| [llm-client.md](llm-client.md) | LLMClient -- provider adapter interface, input normalization, complete/stream flows, queue routing, API surface (completions/responses/messages/generate), realtime | `src/llm/` |
| [agent-loop.md](agent-loop.md) | AgentLoop -- tool-call loop, StepState accumulator, ConversationHistory, ContextRegistry layered system prompts, delegate/chain/consolidate helpers | `src/agent/` |
| [cost-and-estimation.md](cost-and-estimation.md) | CostCollector, ModelCatalog pricing, pre-flight estimate(), Estimator adaptive calibration (EWMA), honest-zero rule, budget enforcement | `src/plugins/cost-collector/`, `src/plugins/model-catalog/`, `src/helpers/estimate*.ts` |
| [telemetry-and-hooks.md](telemetry-and-hooks.md) | HookBus typed pub/sub contract, full HookMap event catalog, TelemetryAdapter (traces/metrics/logs, no @opentelemetry dep), secret redaction, OTLP export | `src/bus/`, `src/plugins/telemetry/` |
| [media-files-batch.md](media-files-batch.md) | Media generation/TTS/video (MediaProviderAdapter, MediaStore, polling), FilesRegistry (resolution strategy, provider adapters), Batcher (intercept/collect/poll/deliver) | `src/plugins/media/`, `src/plugins/files/`, `src/plugins/batch/` |
| [context-guard-and-persistence.md](context-guard-and-persistence.md) | ContextMeasurer (HybridTokenCounter, calibration), ContextGuard (trigger levels, strategies: truncate/layered), Persistence interface (Memory/File), Cache (TTL, onBeforeSubmit interception) | `src/plugins/context-guard/`, `src/plugins/context-measurer/`, `src/plugins/persistence/`, `src/plugins/cache/` |
| [server.md](server.md) | OaiServer OpenAI-compatible front-end, AuthPlugin/AgentLoaderPlugin/ConversationLoaderPlugin slots, dispatch, fake streaming, ResponseStore | `src/server/` |
| [internal-tools.md](internal-tools.md) | InternalTool catalog, ToolRegistry multi-backend, runner (model selection, JSON enforcement, LLM tool helpers), builtin tools | `src/plugins/internal-tools/` |
| [mcp.md](mcp.md) | MCP client -- stdio/HTTP/WebSocket transports, JSON-RPC 2.0, tool adapter, OAuth 2.1 + PKCE, all protocol surfaces | `src/plugins/mcp/` |
