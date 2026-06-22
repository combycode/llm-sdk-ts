/** AuthPlugin (BearerKeyAuth) tests. */

import { describe, expect, it } from 'bun:test';
import { BearerKeyAuth } from '../../../src/server/auth';

describe('BearerKeyAuth', () => {
  it('verifies known key (record form)', () => {
    const auth = new BearerKeyAuth({ keys: { 'sk-abc': 'alice' } });
    expect(auth.verify({ authorization: 'Bearer sk-abc' })).toEqual({ userId: 'alice' });
  });

  it('verifies known key (array form, anon userId)', () => {
    const auth = new BearerKeyAuth({ keys: ['sk-12345'] });
    expect(auth.verify({ authorization: 'Bearer sk-12345' })).toMatchObject({
      userId: expect.stringMatching(/^key:/) as unknown as string,
    });
  });

  it('rejects missing header', () => {
    const auth = new BearerKeyAuth({ keys: { 'sk-x': 'u' } });
    expect(() => auth.verify({})).toThrow(/Authorization/);
  });

  it('rejects malformed header', () => {
    const auth = new BearerKeyAuth({ keys: { 'sk-x': 'u' } });
    expect(() => auth.verify({ authorization: 'Token sk-x' })).toThrow(/Bearer/);
  });

  it('rejects unknown key', () => {
    const auth = new BearerKeyAuth({ keys: { 'sk-x': 'u' } });
    expect(() => auth.verify({ authorization: 'Bearer sk-other' })).toThrow(/unknown bearer/);
  });
});
