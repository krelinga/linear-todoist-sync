export type RetryClassification =
  { retryable: false } | { retryable: true; retryAfterSeconds?: number };

export type RetryClassifier = (error: unknown) => RetryClassification;

export type RetryOptions = {
  classify: RetryClassifier;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(baseMs: number, maxDelayMs: number, random: () => number): number {
  const capped = Math.min(baseMs, maxDelayMs);
  return capped / 2 + random() * (capped / 2);
}

/**
 * Retries `fn` with exponential backoff (§4.3): 1s -> 60s cap, doubling each attempt, with
 * jitter so retries from repeated calls don't cluster. A Retry-After from the classifier
 * wins over the computed backoff. Gives up after maxAttempts and rethrows the last error.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let attempt = 0;
  let delayMs = initialDelayMs;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      const classification = options.classify(err);
      if (!classification.retryable || attempt >= maxAttempts) {
        throw err;
      }
      const waitMs =
        classification.retryAfterSeconds !== undefined
          ? classification.retryAfterSeconds * 1000
          : jitteredDelay(delayMs, maxDelayMs, random);
      await sleep(waitMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}

/**
 * The error itself followed by its `cause` chain, so HTTP details survive being wrapped for
 * context (see errors.ts): `getIssueRaw`'s "a 4xx means the issue is gone" check and the
 * clients' rate_limited metric label both read a status back off an already-wrapped error.
 * Depth-bounded, since an error whose `cause` points at itself would otherwise never terminate.
 */
function* causeChain(error: unknown): Generator<Record<string, unknown>> {
  let current = error;
  for (let depth = 0; depth < 10; depth++) {
    if (typeof current !== 'object' || current === null) {
      return;
    }
    yield current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * The property names HTTP clients use for a response status, in no particular order of
 * preference because no error carries two of them.
 *
 * `httpStatusCode` is the Todoist SDK's spelling (`TodoistRequestError`) and its absence here
 * was silently disabling every status-dependent behaviour on that half of the service:
 * §4.3's backoff never retried a Todoist 429 or 5xx, the `result="rate_limited"` metric could
 * not fire, and the digest's 403 fallback for an over-long activity window was unreachable.
 * Linear's `status` worked throughout, so the retry policy appeared to function.
 */
const STATUS_KEYS = ['status', 'statusCode', 'httpStatusCode'] as const;

export function extractHttpStatus(error: unknown): number | undefined {
  for (const link of causeChain(error)) {
    const candidates = [
      ...STATUS_KEYS.map((key) => link[key]),
      (link as { response?: Record<string, unknown> }).response?.['status'],
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'number') {
        return candidate;
      }
    }
  }
  return undefined;
}

function extractRetryAfterSeconds(error: unknown): number | undefined {
  for (const link of causeChain(error)) {
    const headerSources = [
      link['headers'],
      (link as { response?: { headers?: unknown } }).response?.headers,
    ];
    for (const headers of headerSources) {
      if (!headers) {
        continue;
      }
      let raw: string | null | undefined;
      if (typeof (headers as Headers).get === 'function') {
        raw = (headers as Headers).get('retry-after');
      } else {
        raw = (headers as Record<string, string>)['retry-after'];
      }
      if (raw) {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) {
          return seconds;
        }
      }
    }
  }
  return undefined;
}

/**
 * Retries on HTTP 429 and 5xx responses (§4.3), reading status and Retry-After off common
 * error shapes (a bare `status`/`statusCode` property, or a `response`/`headers` object as
 * produced by fetch-based HTTP clients).
 */
export function httpRetryClassifier(error: unknown): RetryClassification {
  const status = extractHttpStatus(error);
  if (status === undefined || (status !== 429 && status < 500)) {
    return { retryable: false };
  }
  const retryAfterSeconds = extractRetryAfterSeconds(error);
  return retryAfterSeconds === undefined
    ? { retryable: true }
    : { retryable: true, retryAfterSeconds };
}
