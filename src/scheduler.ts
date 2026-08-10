import { Lock } from './lock.js';
import { runPollCycle } from './reconcile/poll.js';
import { runDigestJob } from './digest/digest.js';
import { logger } from './logger.js';
import type { LinearPort } from './clients/linear.js';
import type { TodoistPort } from './clients/todoist.js';
import type { Metrics } from './metrics.js';

export type SchedulerConfig = {
  pollIntervalSeconds: number;
  digestTime: string;
  digestTimezone: string;
};

export type SchedulerDeps = {
  config: SchedulerConfig;
  linear: LinearPort;
  todoist: TodoistPort;
  metrics: Metrics;
};

/** How often to check whether it's time for today's digest - independent of the poll interval. */
const DIGEST_CHECK_INTERVAL_MS = 60_000;

/**
 * Starts the two internal schedules (§3): a poll loop on `pollIntervalSeconds`, and a once-daily
 * digest check. Both run through the same Lock so they never overlap (§5.3) - whichever is
 * scheduled to start simply waits for the other to finish. Both also run once immediately on
 * startup rather than waiting for the first interval to elapse: a fresh start should backfill
 * right away (§2.3), and a digest time that's already passed today shouldn't wait until tomorrow.
 */
export function startScheduler(deps: SchedulerDeps): { stop: () => void } {
  const lock = new Lock();
  let lastDigestLocalDate: string | null = null;

  const runPoll = (): void => {
    lock
      .run(() => runPollCycle({ linear: deps.linear, todoist: deps.todoist, metrics: deps.metrics }))
      .catch((err: unknown) => {
        logger.error('Unhandled poll cycle error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  const checkDigest = (): void => {
    const { date, time } = currentLocalDateTime(deps.config.digestTimezone);
    if (date === lastDigestLocalDate || time < deps.config.digestTime) {
      return;
    }
    lastDigestLocalDate = date;
    lock
      .run(() => runDigestJob({ linear: deps.linear, todoist: deps.todoist, metrics: deps.metrics }))
      .catch((err: unknown) => {
        logger.error('Unhandled digest job error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  runPoll();
  checkDigest();

  const pollTimer = setInterval(runPoll, deps.config.pollIntervalSeconds * 1000);
  const digestTimer = setInterval(checkDigest, DIGEST_CHECK_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(pollTimer);
      clearInterval(digestTimer);
    },
  };
}

function currentLocalDateTime(timeZone: string): { date: string; time: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  // Some Intl implementations report midnight as "24" with hour12: false.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
  };
}
