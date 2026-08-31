/** ContextRegistry subscription teardown + non-string layer content.
 *
 *  Every `subscribe()` returns an unsubscribe closure, and each of the three
 *  pattern kinds returns a DIFFERENT closure. An unsubscribe that silently does
 *  nothing is invisible in a passing test suite and shows up in production as a
 *  handler that keeps firing after its owner is gone — so each one is exercised
 *  and the set is checked to have been emptied, not merely left un-fired once. */

import { describe, expect, it } from 'bun:test';
import { ContextRegistry } from '../../../src/agent/context-registry/registry';
import { concatContent, layerToText } from '../../../src/agent/context-registry/registry-internal';
import type { ContextRegistryEvent } from '../../../src/agent/context-registry/types';
import type { ContentPart } from '../../../src/llm/types/messages';

describe('ContextRegistry — unsubscribe', () => {
  it('an exact-name subscription stops firing after unsubscribe', () => {
    const r = new ContextRegistry();
    const seen: string[] = [];
    const off = r.subscribe('facts', (e: ContextRegistryEvent) => seen.push(e.name));
    r.set('facts', 'a');
    off();
    r.set('facts', 'b');
    expect(seen).toEqual(['facts']);
  });

  it('unsubscribing one exact handler leaves its siblings subscribed', () => {
    const r = new ContextRegistry();
    const a: string[] = [];
    const b: string[] = [];
    const offA = r.subscribe('facts', () => a.push('a'));
    r.subscribe('facts', () => b.push('b'));
    offA();
    r.set('facts', 'x');
    expect(a).toEqual([]);
    expect(b).toEqual(['b']);
  });

  it('a prefix subscription stops firing after unsubscribe', () => {
    const r = new ContextRegistry();
    const seen: string[] = [];
    const off = r.subscribe('memory.*', (e: ContextRegistryEvent) => seen.push(e.name));
    r.set('memory.short', 'a');
    off();
    r.set('memory.long', 'b');
    expect(seen).toEqual(['memory.short']);
  });

  it('unsubscribing one prefix handler leaves its siblings subscribed', () => {
    const r = new ContextRegistry();
    const a: string[] = [];
    const b: string[] = [];
    const offA = r.subscribe('memory.*', () => a.push('a'));
    r.subscribe('memory.*', () => b.push('b'));
    offA();
    r.set('memory.x', 'x');
    expect(a).toEqual([]);
    expect(b).toEqual(['b']);
  });

  it('a wildcard subscription stops firing after unsubscribe', () => {
    const r = new ContextRegistry();
    const seen: string[] = [];
    const off = r.onChange((e: ContextRegistryEvent) => seen.push(e.name));
    r.set('anything', 'a');
    off();
    r.set('anything', 'b');
    expect(seen).toEqual(['anything']);
  });

  it('an onSizeChange subscription stops firing after unsubscribe', () => {
    const r = new ContextRegistry();
    let calls = 0;
    const off = r.onSizeChange(() => {
      calls++;
    });
    r.set('a', 'hello');
    expect(calls).toBe(1);
    off();
    r.set('a', 'hello world again');
    expect(calls).toBe(1);
  });

  it('unsubscribing twice is harmless', () => {
    const r = new ContextRegistry();
    const off = r.subscribe('facts', () => {});
    off();
    expect(() => off()).not.toThrow();
    const offPrefix = r.subscribe('m.*', () => {});
    offPrefix();
    expect(() => offPrefix()).not.toThrow();
  });

  it('re-subscribing after a full unsubscribe works (the set was deleted, not corrupted)', () => {
    const r = new ContextRegistry();
    r.subscribe('facts', () => {})();
    const seen: string[] = [];
    r.subscribe('facts', (e: ContextRegistryEvent) => seen.push(e.name));
    r.set('facts', 'a');
    expect(seen).toEqual(['facts']);
  });
});

describe('layerToText — non-string layer content', () => {
  const parts: ContentPart[] = [
    { type: 'text', text: 'plain' },
    { type: 'tool_call', id: 'c1', name: 'search', arguments: { q: 'cats' } },
    { type: 'tool_result', toolCallId: 'c1', content: 'found 3' },
    { type: 'tool_result', toolCallId: 'c2', content: [{ type: 'text', text: 'structured' }] },
    { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
  ] as ContentPart[];

  it('renders text, tool calls and tool results, and skips media', () => {
    const text = layerToText({ name: 'n', content: parts } as never);
    expect(text).toBe(
      ['plain', '[tool_call search]({"q":"cats"})', '[tool_result] found 3', '[tool_result] [{"type":"text","text":"structured"}]'].join(
        '\n',
      ),
    );
    // An image contributes NOTHING to the text size — a base64 payload counted
    // as characters would blow up every context-budget calculation.
    expect(text).not.toContain('y.png');
  });

  it('a registry sized on part content counts the rendered text, not the raw JSON', () => {
    const r = new ContextRegistry();
    r.set('tools', parts);
    expect(r.flat()).toContain('[tool_call search]');
    expect(r.sizeChars()).toBe(layerToText({ name: 'tools', content: parts } as never).length);
  });
});

describe('concatContent — mergeParent across content kinds', () => {
  it('string + string joins with a blank line', () => {
    expect(concatContent('a', 'b')).toBe('a\n\nb');
  });

  it('parts + parts concatenates the arrays (stays structured)', () => {
    const a: ContentPart[] = [{ type: 'text', text: 'a' }];
    const b: ContentPart[] = [{ type: 'text', text: 'b' }];
    expect(concatContent(a, b)).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('a MIXED pair degrades to text rather than producing an invalid array', () => {
    const parts: ContentPart[] = [{ type: 'text', text: 'from-parts' }];
    expect(concatContent('from-string', parts)).toBe('from-string\n\nfrom-parts');
    expect(concatContent(parts, 'from-string')).toBe('from-parts\n\nfrom-string');
  });

  it('a child layer with mergeParent merges parent text through the same path', () => {
    const parent = new ContextRegistry();
    parent.set('notes', 'parent note');
    const child = new ContextRegistry({ parent });
    child.set('notes', [{ type: 'text', text: 'child note' }] as ContentPart[], {
      mergeParent: true,
    });
    expect(child.flat()).toContain('parent note');
    expect(child.flat()).toContain('child note');
  });
});
