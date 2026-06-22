# @combycode/llm-sdk -- Guide

One-stop index of the guide pages. Each page covers a coherent export group:
what it is for, the main exports, and a minimal runnable example.

## Pages

| Page | What it covers |
|---|---|
| [Network Engine](./network.md) | `createEngine`, `NetworkEngine`, `LLMError`, queues, semaphores, rate limiter, `isBrowser` |
| [LLM Client + complete / stream](./llm-client.md) | `complete`, `createLLM`, `LLMClient`, `select`, `selectModels`, `listModels`, `route`, provider adapters |
| [Agent Loop + delegate / chain / consolidate](./agent-loop.md) | `createAgent`, `AgentLoop`, `delegate`, `chain`, `parallel`, `consolidate`, `createObserver`, `ConversationHistory`, `ContextRegistry` |
| [Tools (defineTool)](./tools.md) | `defineTool`, `AgentTool`, `ParamSpec`, built-in server-side tools |
| [Tokens + Embeddings](./tokens-embeddings.md) | `countTokens`, `embed`, `transcribe`, `HybridTokenCounter`, individual counters |
| [Cost Tracking + estimate()](./cost.md) | `estimate`, `CostCollector`, `BudgetExceededError`, `ModelCatalog`, budget events |
| [Observability / Telemetry](./telemetry.md) | `createObserver`, `TelemetryAdapter`, `HookBus`, `AgentBus`, `Logger`, `ConsoleSink` |
| [Media / Files / Batch](./media-files-batch.md) | `createMediaOutput`, `batch`, `submitBatch`, `batchJob`, `createRealtime`, `loadContent`, `transcribe` |
| [MCP (Model Context Protocol)](./mcp.md) | `connectMcp`, `mcpToolset`, `finishMcpAuth`, `McpClient`, OAuth helpers |
| [Context Guard + Permissions + Persistence + Cache](./context-guard.md) | `ContextGuard`, `ContextMeasurer`, `PermissionPolicy`, `MemoryPersistence`, `FilePersistence`, `Cache` |
| [OpenAI-Compatible Server](./server.md) | `createServer`, `OaiServer`, `BearerKeyAuth`, `ModelRouter`, `ResponseStore` |
| [Agent Patterns](./agent-patterns.md) | `Guardrail` interface, `moderationGuardrail`, `handoff` vs `delegate`, guardrail hooks, OpenAI Agents SDK mapping |
| [Moderation](./moderation.md) | `moderate`, `moderationGuardrail`, `ModerationResult`, `ModerationCategories`, text + image input |
| [Retrieval (RAG)](./retrieval.md) | `localRetrieval`, `openaiRetrieval`, `googleRetrieval`, `xaiRetrieval`, `createRetrieval`, `RetrievalBackend`, `RetrievalHit`, `CorpusRef` |
| [Approval and Checkpoints](./approval-and-checkpoints.md) | `PermissionPolicy` ask effect, `approve` callback, `ApprovalRequest`, `ApprovalDecision`, `dump`/`restore`, `checkpoint` persistence, `resumeWithApproval` |
| [Realtime (Live)](./realtime.md) | `createRealtime`, `RealtimeSession`, events, modalities; OpenAI + Google (beta) |

## Quick orientation

```text
complete()              -- simplest path: prompt -> text, one call
createLLM()             -- reusable client for streaming + multi-turn
createAgent()           -- stateful agent with tools + history
createEngine()          -- engine handle: networking, hooks, cost, catalog
connectMcp()            -- MCP server tools into any agent
createServer()          -- OpenAI-compatible HTTP front end
createObserver()        -- react to agent events
estimate()              -- pre-flight cost estimate
```

Start with [LLM Client + complete/stream](./llm-client.md) if you are new to the
SDK. Start with [Agent Loop](./agent-loop.md) if you need tool use or multi-turn
agents. Jump to [MCP](./mcp.md) if you want to plug in external MCP servers.
