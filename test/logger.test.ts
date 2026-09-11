import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeLogTimezone, formatLocalTimestamp, logger } from '../src/logger.js';

const ORIGINAL_TZ = process.env.TZ;

/**
 * Node re-reads `process.env.TZ` for each Date operation, so a test can exercise a zone the host
 * is not actually in. Every case restores it, since the setting is process-global.
 */
function withTimeZone<T>(timeZone: string, fn: () => T): T {
  process.env.TZ = timeZone;
  try {
    return fn();
  } finally {
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  }
}

function withoutTimeZone<T>(fn: () => T): T {
  delete process.env.TZ;
  try {
    return fn();
  } finally {
    if (ORIGINAL_TZ !== undefined) {
      process.env.TZ = ORIGINAL_TZ;
    }
  }
}

const INSTANT = '2026-09-11T13:42:13.123Z';

describe('formatLocalTimestamp', () => {
  it('renders local wall-clock time with the matching UTC offset', () => {
    const formatted = withTimeZone('America/Chicago', () =>
      formatLocalTimestamp(new Date(INSTANT)),
    );
    expect(formatted).toBe('2026-09-11T08:42:13.123-05:00');
  });

  it('renders +00:00 rather than Z when the zone is UTC', () => {
    const formatted = withTimeZone('UTC', () => formatLocalTimestamp(new Date(INSTANT)));
    expect(formatted).toBe('2026-09-11T13:42:13.123+00:00');
  });

  it('handles a zone ahead of UTC', () => {
    const formatted = withTimeZone('Europe/Berlin', () => formatLocalTimestamp(new Date(INSTANT)));
    expect(formatted).toBe('2026-09-11T15:42:13.123+02:00');
  });

  it('handles a half-hour offset', () => {
    const formatted = withTimeZone('Asia/Kolkata', () => formatLocalTimestamp(new Date(INSTANT)));
    expect(formatted).toBe('2026-09-11T19:12:13.123+05:30');
  });

  it('handles a 45-minute offset', () => {
    const formatted = withTimeZone('Asia/Kathmandu', () => formatLocalTimestamp(new Date(INSTANT)));
    expect(formatted).toBe('2026-09-11T19:27:13.123+05:45');
  });

  it('follows the DST offset in effect for the instant being logged, not for "now"', () => {
    // Standard time and daylight time in the same zone must not render the same offset, or a
    // line written on one side of the changeover reads as an hour off on the other.
    const [winter, summer] = withTimeZone('America/Chicago', () => [
      formatLocalTimestamp(new Date('2026-01-15T13:42:13.123Z')),
      formatLocalTimestamp(new Date('2026-07-15T13:42:13.123Z')),
    ]);
    expect(winter).toBe('2026-01-15T07:42:13.123-06:00');
    expect(summer).toBe('2026-07-15T08:42:13.123-05:00');
  });

  it('stays parseable back to the original instant', () => {
    // The offset is what makes this true; a bare local time would not round-trip.
    for (const zone of ['America/Chicago', 'UTC', 'Asia/Kathmandu', 'Pacific/Auckland']) {
      const formatted = withTimeZone(zone, () => formatLocalTimestamp(new Date(INSTANT)));
      expect(new Date(formatted).toISOString()).toBe(INSTANT);
    }
  });

  it('pads every component to a fixed width so lines stay column-aligned', () => {
    const formatted = withTimeZone('UTC', () =>
      formatLocalTimestamp(new Date('2026-01-02T03:04:05.006Z')),
    );
    expect(formatted).toBe('2026-01-02T03:04:05.006+00:00');
  });
});

describe('logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stamps a log line with a local timestamp ahead of the level and message', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    withTimeZone('America/Chicago', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(INSTANT));
      try {
        logger.info('Scheduler started', { pollIntervalSeconds: 60 });
      } finally {
        vi.useRealTimers();
      }
    });

    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({
      timestamp: '2026-09-11T08:42:13.123-05:00',
      level: 'info',
      message: 'Scheduler started',
      pollIntervalSeconds: 60,
    });
  });

  it('still sends warn and error to stderr', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorOut = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logger.warn('Rejected webhook delivery', { reason: 'signature' });
    logger.error('Poll cycle failed', { error: 'boom' });

    expect(log).not.toHaveBeenCalled();
    expect(errorOut).toHaveBeenCalledTimes(2);
  });
});

describe('describeLogTimezone', () => {
  it('reports the zone, its offset, and that TZ was what selected it', () => {
    const described = withTimeZone('America/Chicago', () => describeLogTimezone());
    expect(described).toEqual({
      timezone: 'America/Chicago',
      utcOffset: expect.stringMatching(/^-0[56]:00$/),
      tzSource: 'TZ',
    });
  });

  it('reports tzSource "host" when TZ is unset, which is the case worth noticing', () => {
    const described = withoutTimeZone(() => describeLogTimezone());
    expect(described).toMatchObject({ tzSource: 'host' });
  });

  it('reports an offset that matches the timestamps it describes', () => {
    // The two must never disagree: an operator reads this line to interpret every line after it.
    const [described, stamped] = withTimeZone('Asia/Kathmandu', () => [
      describeLogTimezone(),
      formatLocalTimestamp(new Date()),
    ]);
    expect(described['utcOffset']).toBe('+05:45');
    expect(stamped.endsWith('+05:45')).toBe(true);
  });
});
