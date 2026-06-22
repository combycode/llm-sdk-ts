import { describe, expect, it } from 'bun:test';
import { ConversationHistory } from '../../../src/agent/history';
import { emptyUsage } from '../../../src/llm/types/response';

describe('ConversationHistory', () => {
  it('starts empty', () => {
    const h = new ConversationHistory();
    expect(h.length).toBe(0);
    expect(h.messages()).toEqual([]);
  });

  it('append adds messages', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'hello' });
    h.append({ role: 'assistant', content: 'hi' });
    expect(h.length).toBe(2);
    expect(h.messages()[0].content).toBe('hello');
    expect(h.messages()[1].content).toBe('hi');
  });

  it('at() returns entry by index', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'first' });
    h.append({ role: 'user', content: 'second' });
    expect(h.at(0)?.message.content).toBe('first');
    expect(h.at(1)?.message.content).toBe('second');
    expect(h.at(-1)?.message.content).toBe('second');
  });

  it('last() returns last N entries', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'a' });
    h.append({ role: 'user', content: 'b' });
    h.append({ role: 'user', content: 'c' });
    const last2 = h.last(2);
    expect(last2.length).toBe(2);
    expect(last2[0].message.content).toBe('b');
    expect(last2[1].message.content).toBe('c');
  });

  it('byRole filters correctly', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'q1' });
    h.append({ role: 'assistant', content: 'a1' });
    h.append({ role: 'user', content: 'q2' });
    expect(h.byRole('user').length).toBe(2);
    expect(h.byRole('assistant').length).toBe(1);
  });

  it('totalUsage sums across entries', () => {
    const h = new ConversationHistory();
    const u1 = { ...emptyUsage(), inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    const u2 = { ...emptyUsage(), inputTokens: 5, outputTokens: 15, totalTokens: 20 };
    h.append({ role: 'user', content: 'q' }, { usage: u1 });
    h.append({ role: 'assistant', content: 'a' }, { usage: u2 });
    const total = h.totalUsage();
    expect(total.inputTokens).toBe(15);
    expect(total.outputTokens).toBe(35);
  });

  it('estimatedTokens returns rough count', () => {
    const h = new ConversationHistory();
    h.system = 'You are helpful.';
    h.append({ role: 'user', content: 'Hello world test message here' });
    expect(h.estimatedTokens()).toBeGreaterThan(5);
    expect(h.estimatedTokens()).toBeLessThan(30);
  });

  it('truncate keeps last N', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'a' });
    h.append({ role: 'user', content: 'b' });
    h.append({ role: 'user', content: 'c' });
    const removed = h.truncate(2);
    expect(removed.length).toBe(1);
    expect(removed[0].message.content).toBe('a');
    expect(h.length).toBe(2);
    expect(h.messages()[0].content).toBe('b');
  });

  it('fork creates independent copy', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'original' });
    const forked = h.fork();
    forked.append({ role: 'user', content: 'forked only' });
    expect(h.length).toBe(1);
    expect(forked.length).toBe(2);
    expect(forked.id).not.toBe(h.id);
  });

  it('export/import round-trips', () => {
    const h = new ConversationHistory();
    h.system = 'test system';
    h.setMetadata('key', 'value');
    h.append({ role: 'user', content: 'hello' });
    h.append({ role: 'assistant', content: 'world' });

    const snapshot = h.export();
    const restored = ConversationHistory.import(snapshot);

    expect(restored.id).toBe(h.id);
    expect(restored.system).toBe('test system');
    expect(restored.metadata.key).toBe('value');
    expect(restored.length).toBe(2);
    expect(restored.messages()[0].content).toBe('hello');
  });

  it('is iterable', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'a' });
    h.append({ role: 'user', content: 'b' });
    const contents = [...h].map((e) => e.message.content);
    expect(contents).toEqual(['a', 'b']);
  });

  it('clear removes all entries', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'a' });
    h.clear();
    expect(h.length).toBe(0);
  });

  it('spliceRange replaces range with synthetic message', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'a' });
    h.append({ role: 'assistant', content: 'b' });
    h.append({ role: 'user', content: 'c' });
    const removed = h.spliceRange(0, 2, { role: 'system', content: 'summary' });
    expect(removed.length).toBe(2);
    expect(h.length).toBe(2);
    expect(h.at(0)?.message.content).toBe('summary');
    expect(h.at(1)?.message.content).toBe('c');
  });

  it('manual recordActualUsage works', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'hello' });
    h.recordActualUsage(5);
    expect(h.lastActualTotal).toBe(5);
  });

  it('string constructor sets id (backward compat)', () => {
    const h = new ConversationHistory('my-id');
    expect(h.id).toBe('my-id');
  });

  it('undefined constructor generates UUID', () => {
    const h = new ConversationHistory();
    expect(h.id).toHaveLength(36);
  });
});
