import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CreditsService } from '../src/services/credits.js';
import { createFirestoreMock, createRedisMock, createTestLogger } from './utils/mocks.js';

describe('CreditsService', () => {
  let service;
  let firestore;
  let redis;
  let logger;

  beforeEach(() => {
    firestore = createFirestoreMock();
    redis = createRedisMock();
    logger = createTestLogger();
    service = new CreditsService({
      redisClient: redis,
      firestoreClient: firestore,
      logger,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('consumes free credits before paid credits and enforces daily limits', async () => {
    vi.spyOn(service, '_getDailyFreeLimit').mockReturnValue(1);
    await redis.set('credits:user-limit', 2);

    const first = await service.checkAndDeduct({ userId: 'user-limit', jobId: 'job-1' });
    expect(first.allowed).toBe(true);
    expect(first.type).toBe('free');

    const second = await service.checkAndDeduct({ userId: 'user-limit', jobId: 'job-2' });
    expect(second.allowed).toBe(true);
    expect(second.type).toBe('paid');
    expect(second.remainingCredits).toBe(1);

    const ledger = firestore.__getLedger().filter((entry) => entry.userId === 'user-limit');
    expect(ledger).toHaveLength(2);
    expect(ledger.find((entry) => entry.jobId === 'job-1')?.type).toBe('free');
    expect(ledger.find((entry) => entry.jobId === 'job-2')?.type).toBe('paid');
  });

  it('prevents overdraft when insufficient paid credits are available', async () => {
    vi.spyOn(service, '_getDailyFreeLimit').mockReturnValue(0);

    const result = await service.checkAndDeduct({ userId: 'user-overdraft', jobId: 'job-1', amount: 2 });

    expect(result.allowed).toBe(false);
    expect(result.remainingCredits).toBe(0);
    expect(firestore.__getLedger().filter((entry) => entry.userId === 'user-overdraft')).toHaveLength(0);
  });

  it('refunds multi-credit jobs and records ledger entries', async () => {
    vi.spyOn(service, '_getDailyFreeLimit').mockReturnValue(0);
    await redis.set('credits:user-refund', 5);

    const deduction = await service.checkAndDeduct({ userId: 'user-refund', jobId: 'job-100', amount: 2 });
    expect(deduction.allowed).toBe(true);
    expect(deduction.remainingCredits).toBe(3);

    const refund = await service.refund({ userId: 'user-refund', jobId: 'job-100', amount: 2, reason: 'worker_failure' });
    expect(refund.success).toBe(true);

    const balance = await redis.get('credits:user-refund');
    expect(Number(balance)).toBe(5);

    const ledger = firestore.__getLedger().filter((entry) => entry.userId === 'user-refund');
    expect(ledger).toHaveLength(2);
    const refundEntry = ledger.find((entry) => entry.type === 'refund');
    expect(refundEntry).toBeTruthy();
    expect(refundEntry?.originalTransactionId).toBeTruthy();
  });

  it('reports total balance including free tier usage', async () => {
    vi.spyOn(service, '_getDailyFreeLimit').mockReturnValue(2);

    await service.checkAndDeduct({ userId: 'user-balance', jobId: 'job-free-1' });
    await service.checkAndDeduct({ userId: 'user-balance', jobId: 'job-free-2' });
    await redis.set('credits:user-balance', 4);

    const balance = await service.getBalance('user-balance');
    expect(balance.paidCredits).toBe(4);
    expect(balance.dailyFreeUsed).toBe(2);
    expect(balance.freeCredits).toBe(0);
    expect(balance.totalAvailable).toBe(4);
  });
});
