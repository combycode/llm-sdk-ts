import { describe, expect, it } from 'bun:test';
import { fsGlob, shellGlob, urlPattern } from '../../../../src/plugins/permissions/matchers';
import { PermissionPolicy } from '../../../../src/plugins/permissions/policy';

describe('PermissionPolicy — basic matching', () => {
  it('default-denies when no rules match', () => {
    const p = new PermissionPolicy([]);
    expect(p.check('agent', { kind: 'fs', path: '/x' }, 'read').allow).toBe(false);
  });

  it('first-match wins (rule order matters)', () => {
    const p = new PermissionPolicy([
      { effect: 'allow', source: 'a' },
      { effect: 'deny', source: 'a' },
    ]);
    expect(p.check('a', { kind: 'fs', path: '/x' }, 'read').allow).toBe(true);
  });

  it('source array match', () => {
    const p = new PermissionPolicy([{ effect: 'allow', source: ['a', 'b'] }]);
    expect(p.check('a', { kind: 'fs' }, 'r').allow).toBe(true);
    expect(p.check('c', { kind: 'fs' }, 'r').allow).toBe(false);
  });

  it('* wildcards in source/action', () => {
    const p = new PermissionPolicy([{ effect: 'allow', source: ['*'], action: ['*'] }]);
    expect(p.check('any', { kind: 'fs' }, 'any').allow).toBe(true);
  });

  it('target matcher gates rule', () => {
    const p = new PermissionPolicy([{ effect: 'allow', target: fsGlob('/var/log/**') }]);
    expect(p.check('a', { kind: 'fs', path: '/var/log/x' }, 'r').allow).toBe(true);
    expect(p.check('a', { kind: 'fs', path: '/etc/foo' }, 'r').allow).toBe(false);
  });

  it('decision carries matchedRule index and reason', () => {
    const p = new PermissionPolicy([
      { effect: 'deny', source: 'x' },
      { effect: 'allow', source: 'y', reason: 'trusted' },
    ]);
    const d = p.check('y', { kind: 'fs' }, 'r');
    expect(d.matchedRule).toBe(1);
    expect(d.reason).toBe('trusted');
  });

  it('withAdditional appends rules', () => {
    const base = new PermissionPolicy([{ effect: 'deny', source: 'x' }]);
    const ext = base.withAdditional([{ effect: 'allow', source: 'y' }]);
    expect(ext.size).toBe(2);
    expect(ext.check('y', { kind: 'fs' }, 'r').allow).toBe(true);
  });
});

describe('PermissionPolicy — built-in matchers', () => {
  it('shellGlob loose match (slashes inside arg)', () => {
    const p = new PermissionPolicy([{ effect: 'allow', target: shellGlob('git *') }]);
    expect(p.check('a', { kind: 'shell', command: 'git status -s' }, 'execute').allow).toBe(true);
  });

  it('urlPattern matches scheme + host wildcard', () => {
    const p = new PermissionPolicy([
      { effect: 'allow', target: urlPattern('https://api.example.com/*') },
    ]);
    expect(p.check('a', { kind: 'url', url: 'https://api.example.com/v1/foo' }, 'r').allow).toBe(
      true,
    );
    expect(p.check('a', { kind: 'url', url: 'https://api.other.com/x' }, 'r').allow).toBe(false);
  });
});

describe('PermissionPolicy — ask effect', () => {
  it('ask effect: allow is false, ask is true', () => {
    const p = new PermissionPolicy([{ effect: 'ask', source: 'agent' }]);
    const d = p.check('agent', { kind: 'tool' }, 'execute');
    expect(d.allow).toBe(false);
    expect(d.ask).toBe(true);
  });

  it('ask effect carries reason and matchedRule', () => {
    const p = new PermissionPolicy([{ effect: 'ask', source: 'agent', reason: 'needs approval' }]);
    const d = p.check('agent', { kind: 'tool' }, 'execute');
    expect(d.reason).toBe('needs approval');
    expect(d.matchedRule).toBe(0);
  });

  it('allow effect: ask is undefined (not truthy)', () => {
    const p = new PermissionPolicy([{ effect: 'allow', source: 'agent' }]);
    const d = p.check('agent', { kind: 'tool' }, 'execute');
    expect(d.allow).toBe(true);
    expect(d.ask).toBeUndefined();
  });

  it('deny effect: allow is false, ask is undefined', () => {
    const p = new PermissionPolicy([{ effect: 'deny', source: 'agent' }]);
    const d = p.check('agent', { kind: 'tool' }, 'execute');
    expect(d.allow).toBe(false);
    expect(d.ask).toBeUndefined();
  });

  it('first-match wins: ask before deny', () => {
    const p = new PermissionPolicy([
      { effect: 'ask', source: 'agent' },
      { effect: 'deny', source: 'agent' },
    ]);
    const d = p.check('agent', { kind: 'tool' }, 'execute');
    expect(d.ask).toBe(true);
    expect(d.matchedRule).toBe(0);
  });
});
