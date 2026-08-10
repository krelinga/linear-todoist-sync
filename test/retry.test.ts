import { describe, expect, it, vi } from 'vitest';
import { httpRetryClassifier, withRetry } from '../src/retry.js';

function httpError(status: number, retryAfter?: string): unknown {
  return {
    status,
    headers: retryAfter === undefined ? undefined : { 'retry-after': retryAfter },
  };
}

describe('withRetry', () => {
  it('returns the result on first success without sleeping', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { classify: httpRetryClassifier, sleep });
    expect(result).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a retryable error and eventually succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { classify: httpRetryClassifier, sleep, random: () => 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('doubles the backoff each attempt, capped at maxDelayMs, with half-jitter', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(httpError(500));
    await expect(
      withRetry(fn, {
        classify: httpRetryClassifier,
        sleep,
        random: () => 0, // no added jitter: delay = base / 2
        initialDelayMs: 1000,
        maxDelayMs: 60_000,
        maxAttempts: 5,
      }),
    ).rejects.toBeDefined();
    // 5 attempts -> 4 sleeps, base delays 1000, 2000, 4000, 8000 -> halved by random()=0
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 1000, 2000, 4000]);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const error = httpError(429);
    const fn = vi.fn().mockRejectedValue(error);
    await expect(
      withRetry(fn, { classify: httpRetryClassifier, sleep, maxAttempts: 3, random: () => 0 }),
    ).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable error', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const error = httpError(404);
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withRetry(fn, { classify: httpRetryClassifier, sleep })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('honors Retry-After verbatim instead of the computed backoff', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValueOnce(httpError(429, '17')).mockResolvedValue('ok');
    await withRetry(fn, { classify: httpRetryClassifier, sleep, random: () => 0 });
    expect(sleep).toHaveBeenCalledWith(17_000);
  });
});

describe('httpRetryClassifier', () => {
  it.each([429, 500, 502, 503, 599])('treats %s as retryable', (status) => {
    expect(httpRetryClassifier(httpError(status))).toEqual({ retryable: true });
  });

  it.each([200, 400, 401, 403, 404])('treats %s as not retryable', (status) => {
    expect(httpRetryClassifier(httpError(status))).toEqual({ retryable: false });
  });

  it('treats an error with no discernible status as not retryable', () => {
    expect(httpRetryClassifier(new Error('boom'))).toEqual({ retryable: false });
  });
});
