import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../src/metrics.js';
import type { LinearPort } from '../src/clients/linear.js';
import type { TodoistPort } from '../src/clients/todoist.js';

const runPollCycle = vi.fn().mockResolvedValue(undefined);
const runDigestJob = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/reconcile/poll.js', () => ({ runPollCycle: (...args: unknown[]) => runPollCycle(...args) }));
vi.mock('../src/digest/digest.js', () => ({ runDigestJob: (...args: unknown[]) => runDigestJob(...args) }));

// Imported after the mocks above so scheduler.ts picks up the mocked modules.
const { startScheduler } = await import('../src/scheduler.js');

function fakePorts() {
  return {
    linear: {} as LinearPort,
    todoist: {} as TodoistPort,
    metrics: createMetrics(),
  };
}

describe('startScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
    runPollCycle.mockReset().mockResolvedValue(undefined);
    runDigestJob.mockReset().mockResolvedValue(undefined);
  });

  it('runs an immediate poll on startup rather than waiting for the first interval', async () => {
    const { linear, todoist, metrics } = fakePorts();
    const scheduler = startScheduler({
      config: { pollIntervalSeconds: 60, digestTime: '23:59', digestTimezone: 'UTC' },
      linear,
      todoist,
      metrics,
    });
    try {
      await vi.waitFor(() => expect(runPollCycle).toHaveBeenCalledTimes(1));
    } finally {
      scheduler.stop();
    }
  });

  it('polls again after the configured interval elapses', async () => {
    vi.useFakeTimers();
    const { linear, todoist, metrics } = fakePorts();
    const scheduler = startScheduler({
      config: { pollIntervalSeconds: 60, digestTime: '23:59', digestTimezone: 'UTC' },
      linear,
      todoist,
      metrics,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(runPollCycle).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runPollCycle).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.stop();
    }
  });

  it('does not run the digest immediately if the configured time has not yet passed today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T05:00:00.000Z'));
    const { linear, todoist, metrics } = fakePorts();
    const scheduler = startScheduler({
      config: { pollIntervalSeconds: 3600, digestTime: '07:00', digestTimezone: 'UTC' },
      linear,
      todoist,
      metrics,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(runDigestJob).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
  });

  it('runs the digest immediately on startup if the configured time already passed today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T08:00:00.000Z'));
    const { linear, todoist, metrics } = fakePorts();
    const scheduler = startScheduler({
      config: { pollIntervalSeconds: 3600, digestTime: '07:00', digestTimezone: 'UTC' },
      linear,
      todoist,
      metrics,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(runDigestJob).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.stop();
    }
  });

  it('does not run the digest twice on the same local day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T07:00:00.000Z'));
    const { linear, todoist, metrics } = fakePorts();
    const scheduler = startScheduler({
      config: { pollIntervalSeconds: 100_000, digestTime: '07:00', digestTimezone: 'UTC' },
      linear,
      todoist,
      metrics,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(runDigestJob).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000 * 60 * 5); // 5 hours later, still the same UTC day
      expect(runDigestJob).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.stop();
    }
  });

  it('runs the digest again once the local date rolls over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T23:59:30.000Z'));
    const { linear, todoist, metrics } = fakePorts();
    const scheduler = startScheduler({
      config: { pollIntervalSeconds: 100_000, digestTime: '00:00', digestTimezone: 'UTC' },
      linear,
      todoist,
      metrics,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const firstRunCount = runDigestJob.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000); // crosses midnight UTC
      expect(runDigestJob.mock.calls.length).toBeGreaterThan(firstRunCount);
    } finally {
      scheduler.stop();
    }
  });

  it('shares one lock between poll and digest so they never run concurrently', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T07:00:00.000Z'));
    const order: string[] = [];
    runPollCycle.mockImplementation(async () => {
      order.push('poll-start');
      await Promise.resolve();
      order.push('poll-end');
    });
    runDigestJob.mockImplementation(async () => {
      order.push('digest-start');
      await Promise.resolve();
      order.push('digest-end');
    });
    const { linear, todoist, metrics } = fakePorts();
    const scheduler = startScheduler({
      config: { pollIntervalSeconds: 60, digestTime: '07:00', digestTimezone: 'UTC' },
      linear,
      todoist,
      metrics,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      // Whichever ran first must have fully finished before the other started.
      expect(order).toEqual(['poll-start', 'poll-end', 'digest-start', 'digest-end']);
    } finally {
      scheduler.stop();
    }
  });

  it('stops both timers so no further calls happen after stop()', async () => {
    vi.useFakeTimers();
    const { linear, todoist, metrics } = fakePorts();
    const scheduler = startScheduler({
      config: { pollIntervalSeconds: 60, digestTime: '23:59', digestTimezone: 'UTC' },
      linear,
      todoist,
      metrics,
    });
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();
    const callsAtStop = runPollCycle.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runPollCycle.mock.calls.length).toBe(callsAtStop);
  });
});
