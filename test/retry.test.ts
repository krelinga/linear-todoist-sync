import { describe, expect, it, vi } from 'vitest';
import { extractHttpStatus, httpRetryClassifier, withRetry } from '../src/retry.js';
import { ContextualError } from '../src/errors.js';

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

describe('extractHttpStatus', () => {
  it('reads a status off the error itself', () => {
    expect(extractHttpStatus(httpError(429))).toBe(429);
    expect(extractHttpStatus({ statusCode: 503 })).toBe(503);
    expect(extractHttpStatus({ response: { status: 404 } })).toBe(404);
  });

  it('finds a status through a wrapping ContextualError', () => {
    // The clients wrap SDK errors for context, and getIssueRaw still has to tell a 4xx
    // ("this issue is gone") apart from a 5xx ("try again next cycle") afterwards.
    const wrapped = new ContextualError('Linear API request failed', {}, httpError(404));
    expect(extractHttpStatus(wrapped)).toBe(404);
  });

  it('returns undefined for an error with no status anywhere in the chain', () => {
    const wrapped = new ContextualError('outer', {}, new Error('inner'));
    expect(extractHttpStatus(wrapped)).toBeUndefined();
  });

  it('terminates on a self-referential cause chain', () => {
    const err = new Error('loop');
    Object.defineProperty(err, 'cause', { value: err });
    expect(extractHttpStatus(err)).toBeUndefined();
  });

  it('classifies a wrapped 429 as retryable', () => {
    const wrapped = new ContextualError('outer', {}, httpError(429, '3'));
    expect(httpRetryClassifier(wrapped)).toEqual({ retryable: true, retryAfterSeconds: 3 });
  });
});

describe('status extraction across SDK error shapes', () => {
  // Each SDK spells this differently, and a spelling that is not recognised does not fail
  // loudly - it silently disables retries, the rate_limited metric, and every other
  // status-dependent branch for that client.
  const shapes: [string, Record<string, unknown>][] = [
    ['Linear (status)', { status: 429 }],
    ['Todoist (httpStatusCode)', { httpStatusCode: 429 }],
    ['fetch-style (statusCode)', { statusCode: 429 }],
    ['nested (response.status)', { response: { status: 429 } }],
  ];

  it.each(shapes)('reads a status from %s', (_label, shape) => {
    expect(extractHttpStatus(shape)).toBe(429);
  });

  it.each(shapes)('classifies %s as retryable', (_label, shape) => {
    expect(httpRetryClassifier(shape)).toMatchObject({ retryable: true });
  });

  it('actually retries a Todoist-shaped 429', async () => {
    // The regression this guards: TodoistRequestError was unrecognised, so withRetry gave up
    // on the first attempt and §4.3's backoff applied to Linear only.
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 429'), { httpStatusCode: 429 }))
      .mockResolvedValue('ok');

    await expect(withRetry(fn, { classify: httpRetryClassifier, sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('finds a Todoist status through a wrapping ContextualError', () => {
    const wrapped = new ContextualError(
      'Todoist API request failed',
      {},
      Object.assign(new Error('HTTP 403'), { httpStatusCode: 403 }),
    );
    expect(extractHttpStatus(wrapped)).toBe(403);
  });
});
