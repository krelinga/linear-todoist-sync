import type { Metrics } from '../metrics.js';

export type PollNudge = {
  /** Ask for a reconciliation cycle soon. Safe to call at any rate - see the invariant below. */
  request: () => void;
  /** Cancel any pending cycle. Called on shutdown. */
  stop: () => void;
};

export type NudgeDeps = {
  debounceMs: number;
  /** Starts a webhook-triggered cycle. Fire-and-forget: the caller serializes via the lock. */
  runPoll: () => void;
  metrics: Metrics;
};

/**
 * Collapses a burst of webhook deliveries into a single reconciliation cycle (webhook §3.3).
 *
 * A bulk edit in Linear fires many Issue events within a second or two. Calling the poll
 * directly per event would enqueue one cycle *per event*, because the shared Lock queues rather
 * than drops - twenty events would serialize into twenty redundant full reconciliations.
 *
 * Invariant: at most one webhook-triggered cycle pending at a time, regardless of event volume.
 * Requests arriving while one is already pending are absorbed, since the cycle that is about to
 * run rediscovers everything anyway and will pick up whatever they carried.
 */
export function createPollNudge(deps: NudgeDeps): PollNudge {
  let timer: NodeJS.Timeout | null = null;

  return {
    request: () => {
      if (timer !== null) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        deps.metrics.webhookPollsTriggeredTotal.inc();
        deps.runPoll();
      }, deps.debounceMs);
    },
    stop: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
