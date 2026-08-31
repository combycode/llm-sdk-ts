import { describe, expect, it } from 'bun:test';
import { DefaultBatchStrategy } from '../../../../src/plugins/batch/strategy';

describe('DefaultBatchStrategy', () => {
  describe('defaults', () => {
    it('uses the documented defaults when constructed with no options', () => {
      const s = new DefaultBatchStrategy();
      expect(s.collectionWindowMs).toBe(10_000);
      expect(s.minBatchSize).toBe(3);
      expect(s.maxBatchSize).toBe(50_000);
      expect(s.pollIntervalMs).toBe(30_000);
    });

    it('uses the documented defaults when constructed with an empty object', () => {
      const s = new DefaultBatchStrategy({});
      expect(s.collectionWindowMs).toBe(10_000);
      expect(s.minBatchSize).toBe(3);
      expect(s.maxBatchSize).toBe(50_000);
      expect(s.pollIntervalMs).toBe(30_000);
    });

    it('every option is individually overridable', () => {
      const s = new DefaultBatchStrategy({
        collectionWindowMs: 25,
        minBatchSize: 1,
        maxBatchSize: 7,
        pollIntervalMs: 99,
      });
      expect(s.collectionWindowMs).toBe(25);
      expect(s.minBatchSize).toBe(1);
      expect(s.maxBatchSize).toBe(7);
      expect(s.pollIntervalMs).toBe(99);
    });

    it('accepts 0 as an explicit override rather than falling back to the default', () => {
      // `??` not `||` — a zero collection window means "flush on next tick",
      // which is a legitimate configuration and must not be silently replaced.
      const s = new DefaultBatchStrategy({
        collectionWindowMs: 0,
        minBatchSize: 0,
        maxBatchSize: 0,
        pollIntervalMs: 0,
      });
      expect(s.collectionWindowMs).toBe(0);
      expect(s.minBatchSize).toBe(0);
      expect(s.maxBatchSize).toBe(0);
      expect(s.pollIntervalMs).toBe(0);
    });
  });

  describe('shouldBatch', () => {
    it('batches only once marked requestors reach minBatchSize', () => {
      const s = new DefaultBatchStrategy({ minBatchSize: 3 });
      const ctx = (markedRequestorsCount: number) => ({
        provider: 'openai',
        markedRequestorsCount,
        pendingCount: 0,
      });
      expect(s.shouldBatch(ctx(0))).toBe(false);
      expect(s.shouldBatch(ctx(2))).toBe(false);
      // Boundary: >= not >.
      expect(s.shouldBatch(ctx(3))).toBe(true);
      expect(s.shouldBatch(ctx(4))).toBe(true);
    });

    it('ignores pendingCount — the decision is on marked requestors only', () => {
      const s = new DefaultBatchStrategy({ minBatchSize: 3 });
      expect(
        s.shouldBatch({ provider: 'openai', markedRequestorsCount: 1, pendingCount: 999 }),
      ).toBe(false);
      expect(s.shouldBatch({ provider: 'openai', markedRequestorsCount: 3, pendingCount: 0 })).toBe(
        true,
      );
    });
  });

  describe('estimateFirstPoll', () => {
    it('scales the first poll delay with batch size, on documented boundaries', () => {
      const s = new DefaultBatchStrategy();
      expect(s.estimateFirstPoll(1)).toBe(30_000);
      expect(s.estimateFirstPoll(9)).toBe(30_000);
      expect(s.estimateFirstPoll(10)).toBe(60_000);
      expect(s.estimateFirstPoll(99)).toBe(60_000);
      expect(s.estimateFirstPoll(100)).toBe(300_000);
      expect(s.estimateFirstPoll(999)).toBe(300_000);
      expect(s.estimateFirstPoll(1000)).toBe(600_000);
      expect(s.estimateFirstPoll(100_000)).toBe(600_000);
    });

    it('is monotonically non-decreasing across the boundaries', () => {
      const s = new DefaultBatchStrategy();
      const sizes = [1, 9, 10, 99, 100, 999, 1000, 5000];
      const delays = sizes.map((n) => s.estimateFirstPoll(n));
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
      }
    });
  });
});
