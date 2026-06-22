/** Tests for ConversationHistory ↔ ContextRegistry integration.
 *  Ensures the legacy `system` getter/setter routes through the registry and
 *  new registry-direct writes interoperate cleanly. */

import { describe, expect, it } from 'bun:test';
import { ConversationHistory } from '../../../src/agent/history';

describe('ConversationHistory — registry is present and owned by history', () => {
  it('new history has an empty registry', () => {
    const h = new ConversationHistory();
    expect(h.registry).toBeDefined();
    expect(h.registry.list().length).toBe(0);
    expect(h.system).toBeUndefined();
  });

  it('registry id is derived from history id', () => {
    const h = new ConversationHistory({ id: 'hist-123456789' });
    expect(h.registry.id).toContain('history-');
  });
});

describe('ConversationHistory — legacy system setter routes through registry', () => {
  it('setting system creates a _legacy_system layer tagged "system"', () => {
    const h = new ConversationHistory();
    h.system = 'You are helpful.';
    const layer = h.registry.get('_legacy_system');
    expect(layer).toBeDefined();
    expect(layer?.content).toBe('You are helpful.');
    expect(layer?.tags).toContain('system');
    expect(layer?.owner).toBe('history.system-setter');
  });

  it('system getter returns the rendered system-tagged view', () => {
    const h = new ConversationHistory();
    h.system = 'Base prompt';
    expect(h.system).toBe('Base prompt');
  });

  it('setting system to undefined removes the legacy layer', () => {
    const h = new ConversationHistory();
    h.system = 'A';
    expect(h.registry.has('_legacy_system')).toBe(true);
    h.system = undefined;
    expect(h.registry.has('_legacy_system')).toBe(false);
    expect(h.system).toBeUndefined();
  });

  it('replacing system overwrites, not appends', () => {
    const h = new ConversationHistory();
    h.system = 'v1';
    h.system = 'v2';
    expect(h.system).toBe('v2');
  });
});

describe('ConversationHistory — new registry writes compose with legacy setter', () => {
  it('legacy system + new registry layer render together (order by priority)', () => {
    const h = new ConversationHistory();
    h.system = 'role text';
    h.registry.set('facts', '- user: Alice', { tags: ['system'], priority: 300 });

    expect(h.system).toBe('role text\n\n- user: Alice');
  });

  it('new layer with higher priority renders after legacy', () => {
    const h = new ConversationHistory();
    h.system = 'base';
    h.registry.set('addendum', 'extra', { tags: ['system'], priority: 500 });
    expect(h.system).toBe('base\n\nextra');
  });

  it('new layer not tagged "system" is invisible to legacy getter', () => {
    const h = new ConversationHistory();
    h.system = 'base';
    h.registry.set('sidebar', 'extra', { tags: ['other'] });
    expect(h.system).toBe('base');
  });
});

describe('ConversationHistory — appendSystem preserves semantics', () => {
  it('concatenates to existing legacy layer', () => {
    const h = new ConversationHistory();
    h.system = 'First.';
    h.appendSystem('Second.');
    expect(h.system).toBe('First.\n\nSecond.');
  });

  it('creates legacy layer when none exists', () => {
    const h = new ConversationHistory();
    h.appendSystem('Only.');
    expect(h.system).toBe('Only.');
  });
});

describe('ConversationHistory — fork preserves registry state', () => {
  it('fork copies all registry layers', () => {
    const h = new ConversationHistory();
    h.system = 'role';
    h.registry.set('facts', 'F', { tags: ['system'], priority: 300 });
    h.registry.set('memory', 'M', { tags: ['system'], priority: 200 });

    const forked = h.fork('fork-1');
    expect(forked.registry.list().length).toBe(3);
    expect(forked.system).toBe('role\n\nM\n\nF');
  });

  it('forked registry is independent (mutations do not affect source)', () => {
    const h = new ConversationHistory();
    h.system = 'orig';
    const forked = h.fork();
    forked.system = 'changed';
    expect(h.system).toBe('orig');
    expect(forked.system).toBe('changed');
  });
});

describe('ConversationHistory — export / import round-trip', () => {
  it('export includes registry snapshot', () => {
    const h = new ConversationHistory();
    h.system = 'role';
    h.registry.set('facts', 'F', { tags: ['system'], priority: 300 });
    const snap = h.export();
    expect(snap.registry).toBeDefined();
    expect(snap.registry?.layers.length).toBe(2);
  });

  it('import restores registry layers', () => {
    const h = new ConversationHistory();
    h.system = 'role';
    h.registry.set('facts', 'F', { tags: ['system'], priority: 300 });
    const snap = h.export();

    const restored = ConversationHistory.import(snap);
    expect(restored.registry.list().length).toBe(2);
    expect(restored.system).toBe('role\n\nF');
  });

  it('import supports legacy snapshot format (system field, no registry)', () => {
    const legacySnap = {
      id: 'legacy',
      entries: [],
      system: 'old system',
      metadata: {},
      createdAt: 1000,
      updatedAt: 1000,
    };
    const restored = ConversationHistory.import(legacySnap);
    expect(restored.system).toBe('old system');
    expect(restored.registry.has('_legacy_system')).toBe(true);
  });

  it('when both registry and system are present, registry wins', () => {
    const h = new ConversationHistory();
    h.system = 'from-registry';
    const snap = h.export();
    snap.system = 'from-legacy-field';

    const restored = ConversationHistory.import(snap);
    expect(restored.system).toBe('from-registry');
  });
});

describe('ConversationHistory — estimatedTokens accounts for registry-composed system', () => {
  it('estimatedTokens includes system from registry', () => {
    const h = new ConversationHistory();
    h.system = 'x'.repeat(40);
    h.registry.set('facts', 'y'.repeat(40), { tags: ['system'] });

    const tokens = h.estimatedTokens();
    expect(tokens).toBeGreaterThanOrEqual(15);
  });
});
