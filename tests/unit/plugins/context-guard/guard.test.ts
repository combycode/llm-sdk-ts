import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { ConversationHistory } from '../../../../src/agent/history';
import { ModelCatalog } from '../../../../src/plugins/model-catalog/catalog';
import { ContextMeasurer } from '../../../../src/plugins/context-measurer/measurer';
import { ContextGuard } from '../../../../src/plugins/context-guard/guard';
import { TruncateStrategy } from '../../../../src/plugins/context-guard/strategies/truncate';
import { LayeredStrategy } from '../../../../src/plugins/context-guard/strategies/layered';
import { LAYER_CHAT_FACTS } from '../../../../src/agent/context-registry/layers';
import type { ContextTools } from '../../../../src/plugins/context-guard/types';
import type { ExtractedFact } from '../../../../src/plugins/context-guard/facts';
import type { Message } from '../../../../src/llm/types/messages';

function buildCatalog(window = 1000): ModelCatalog {
  const c = new ModelCatalog();
  c.set('test', 'tiny', {
    pricing: { inputPerMTok: 1, outputPerMTok: 1 },
    contextWindow: window,
    tokenizer: { strategy: 'heuristic', charsPerTokenDefault: 4, countApiAvailable: false },
  });
  return c;
}

function fillHistory(history: ConversationHistory, count: number, perMsgChars = 100): void {
  for (let i = 0; i < count; i++) {
    history.append({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(perMsgChars) });
  }
}

describe('ContextGuard', () => {
  it('TruncateStrategy drops oldest entries when threshold crossed', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog(1000);
    const measurer = new ContextMeasurer({ hooks, catalog });
    const guard = new ContextGuard({
      hooks,
      measurer,
      strategies: { truncate: new TruncateStrategy({ keepRecent: 3 }) },
      defaultStrategy: 'truncate',
    });

    const history = new ConversationHistory();
    fillHistory(history, 10, 400); // 4000 chars total → way over the window

    const messages = history.messages();
    await hooks.emit('onMessageResolve', {
      provider: 'test',
      model: 'tiny',
      messages,
      history,
    });

    expect(history.length).toBe(3);
    expect(messages.length).toBe(3);
    guard.destroy();
    measurer.destroy();
  });

  it('does not trigger below threshold', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog(10000);
    const measurer = new ContextMeasurer({ hooks, catalog });
    const guard = new ContextGuard({
      hooks,
      measurer,
      strategies: { truncate: new TruncateStrategy({ keepRecent: 2 }) },
      defaultStrategy: 'truncate',
    });

    const history = new ConversationHistory();
    fillHistory(history, 5, 50);

    const messages = history.messages();
    await hooks.emit('onMessageResolve', {
      provider: 'test',
      model: 'tiny',
      messages,
      history,
    });

    expect(history.length).toBe(5);
    guard.destroy();
    measurer.destroy();
  });

  it('persists per-conversation state across measurements', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog(1000);
    const measurer = new ContextMeasurer({ hooks, catalog });
    new ContextGuard({
      hooks,
      measurer,
      strategies: { truncate: new TruncateStrategy({ keepRecent: 3 }) },
      defaultStrategy: 'truncate',
    });

    const history = new ConversationHistory();
    fillHistory(history, 10, 400);

    await hooks.emit('onMessageResolve', {
      provider: 'test',
      model: 'tiny',
      messages: history.messages(),
      history,
    });

    const orxa = history.metadata.__orxa as Record<string, unknown>;
    expect(orxa).toBeDefined();
    expect(orxa.contextGuard).toBeDefined();
    const guardState = orxa.contextGuard as { v: number; lastLevelIdx: number };
    expect(guardState.v).toBe(1);
    expect(guardState.lastLevelIdx).toBeGreaterThanOrEqual(0);
  });

  it('opt-out via metadata.contextStrategy=false leaves history alone', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog(1000);
    const measurer = new ContextMeasurer({ hooks, catalog });
    new ContextGuard({
      hooks,
      measurer,
      strategies: { truncate: new TruncateStrategy({ keepRecent: 2 }) },
      defaultStrategy: 'truncate',
    });

    const history = new ConversationHistory({ strategy: false });
    fillHistory(history, 10, 400);

    await hooks.emit('onMessageResolve', {
      provider: 'test',
      model: 'tiny',
      messages: history.messages(),
      history,
    });

    expect(history.length).toBe(10);
  });

  it('skips when no history is on the resolve context', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog(1000);
    const measurer = new ContextMeasurer({ hooks, catalog });
    new ContextGuard({
      hooks,
      measurer,
      strategies: { truncate: new TruncateStrategy({ keepRecent: 2 }) },
      defaultStrategy: 'truncate',
    });

    const messages: Message[] = [{ role: 'user', content: 'x'.repeat(8000) }];
    // No history → guard should be inert and not throw.
    await hooks.emit('onMessageResolve', {
      provider: 'test',
      model: 'tiny',
      messages,
    });
    expect(messages.length).toBe(1);
  });

  it('throws on unknown strategy when policy=throw', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog(1000);
    const measurer = new ContextMeasurer({ hooks, catalog });
    new ContextGuard({
      hooks,
      measurer,
      strategies: { truncate: new TruncateStrategy({ keepRecent: 3 }) },
      defaultStrategy: 'truncate',
      onUnknownStrategy: 'throw',
    });

    const history = new ConversationHistory({ strategy: 'does-not-exist' });
    fillHistory(history, 10, 400);

    await expect(
      hooks.emit('onMessageResolve', {
        provider: 'test',
        model: 'tiny',
        messages: history.messages(),
        history,
      }),
    ).rejects.toThrow(/unknown strategy/i);
  });

  it('LayeredStrategy with real ContextTools writes facts layer + summary', async () => {
    const hooks = new HookBus();
    const catalog = buildCatalog(800);
    const measurer = new ContextMeasurer({ hooks, catalog });

    const tools: ContextTools = {
      async summarize(content: string) {
        return `summary-of-${content.length}-chars`;
      },
      async extractFacts(): Promise<ExtractedFact[]> {
        return [{ key: 'project.name', value: 'orxa', category: 'identifier' }];
      },
    };

    const guard = new ContextGuard({
      hooks,
      measurer,
      contextTools: tools,
      strategies: { layered: new LayeredStrategy({ recentCount: 3 }) },
      defaultStrategy: 'layered',
      maxCompactRetries: 0, // single pass
    });

    const history = new ConversationHistory({ strategy: 'layered' });
    fillHistory(history, 12, 100); // ~1200 chars → ~300 tokens, 0.375 of 800 — healthy.
    fillHistory(history, 1, 1500); // jump pushes over 0.5 healthy threshold

    await hooks.emit('onMessageResolve', {
      provider: 'test',
      model: 'tiny',
      messages: history.messages(),
      history,
    });

    // After healthy compaction, OLD entries replaced by 1 summary entry; recent kept.
    const factsLayer = history.registry.get(LAYER_CHAT_FACTS);
    expect(factsLayer).toBeDefined();
    expect(factsLayer!.metadata?.facts).toBeDefined();
    guard.destroy();
    measurer.destroy();
  });
});
