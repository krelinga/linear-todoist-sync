import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../../src/metrics.js';
import { createPollNudge } from '../../src/webhook/nudge.js';

function setup(debounceMs = 2000) {
  const runPoll = vi.fn();
  const metrics = createMetrics();
  return { runPoll, metrics, nudge: createPollNudge({ debounceMs, runPoll, metrics }) };
}

async function triggeredCount(metrics: ReturnType<typeof createMetrics>): Promise<number> {
  const { values } = await metrics.webhookPollsTriggeredTotal.get();
  return values[0]?.value ?? 0;
}

describe('createPollNudge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll before the debounce window elapses', async () => {
    vi.useFakeTimers();
    const { runPoll, nudge } = setup();
    nudge.request();
    await vi.advanceTimersByTimeAsync(1999);
    expect(runPoll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runPoll).toHaveBeenCalledTimes(1);
  });

  // The reason this module exists: the shared Lock queues rather than drops, so one cycle per
  // event would serialize into a backlog of redundant full reconciliations.
  it('collapses a burst of requests into a single cycle', async () => {
    vi.useFakeTimers();
    const { runPoll, metrics, nudge } = setup();
    for (let i = 0; i < 20; i += 1) {
      nudge.request();
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(runPoll).toHaveBeenCalledTimes(1);
    expect(await triggeredCount(metrics)).toBe(1);
  });

  it('polls again for a request arriving after the previous cycle started', async () => {
    vi.useFakeTimers();
    const { runPoll, metrics, nudge } = setup();
    nudge.request();
    await vi.advanceTimersByTimeAsync(2000);
    expect(runPoll).toHaveBeenCalledTimes(1);

    nudge.request();
    await vi.advanceTimersByTimeAsync(2000);
    expect(runPoll).toHaveBeenCalledTimes(2);
    expect(await triggeredCount(metrics)).toBe(2);
  });

  it('cancels a pending cycle on stop', async () => {
    vi.useFakeTimers();
    const { runPoll, nudge } = setup();
    nudge.request();
    nudge.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runPoll).not.toHaveBeenCalled();
  });

  it('counts triggered cycles, not absorbed requests', async () => {
    vi.useFakeTimers();
    const { metrics, nudge } = setup();
    nudge.request();
    nudge.request();
    nudge.request();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await triggeredCount(metrics)).toBe(1);
  });
});
