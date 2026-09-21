import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export type Metrics = ReturnType<typeof createMetrics>;

/**
 * Suppresses a gauge's export until something actually writes to it.
 *
 * prom-client seeds an unlabelled gauge with 0 and exports it from the very first scrape -
 * before the event the gauge describes has happened. For a "time of the last X" gauge that is
 * actively harmful, because these exist to be read as `time() - gauge` and a 0 makes that
 * difference the whole Unix epoch: a scrape landing in that window reports ~56 years of
 * staleness and trips any alert built on it. The digest gauge is where it bites, since the
 * digest runs once a day and the window can be most of a day wide (§7).
 *
 * Every placeholder value is a lie of some kind, so the gauge reports nothing instead. Seeding
 * with process start would read as "a digest just ran", which resets staleness on every restart
 * and blinds the alert to a crash loop.
 *
 * `remove()` drops the sample while leaving the HELP and TYPE lines in place, so the metric
 * stays declared and documented and simply has no value yet. A later `set()` restores it.
 *
 * **This makes no-data handling the consumer's job**, which is the trade being made: a
 * dashboard or alert that carries the last observed value across a gap gets the better
 * behaviour, since staleness then accumulates from the last real event rather than restarting
 * with the process. One that treats no-data as zero gets the original bug back, and one that
 * drops the series silently will not alert at all - see §8.1.
 */
function unsetUntilFirstWrite(gauge: Gauge<string>): void {
  gauge.remove();
}

export function createMetrics(registry: Registry = new Registry()) {
  const lastPollSuccessTimestampSeconds = new Gauge({
    name: 'sync_last_poll_success_timestamp_seconds',
    help: 'Unix time of the last poll that completed without error. Absent until one has.',
    registers: [registry],
  });
  unsetUntilFirstWrite(lastPollSuccessTimestampSeconds);

  const lastPollResult = new Gauge({
    name: 'sync_last_poll_result',
    help: '1 if the last poll succeeded, 0 if it failed. Absent until one has run.',
    registers: [registry],
  });
  // Same reasoning as the timestamps, and the lie is more direct here: 0 is defined as
  // "failed", so the default asserts a failure that never happened and fires an alert written
  // as `== 0` on every boot.
  //
  // Note what this gauge deliberately cannot answer even once populated: a job whose scheduler
  // never fires again holds its last success forever. That question belongs to the staleness of
  // the timestamp gauge above, and the two together cover both halves - did the most recent
  // attempt fail, and how long since one succeeded.
  unsetUntilFirstWrite(lastPollResult);

  const lastDigestRunTimestampSeconds = new Gauge({
    name: 'sync_last_digest_run_timestamp_seconds',
    help: 'Unix time of the last completed digest run. Absent until one has completed.',
    registers: [registry],
  });
  unsetUntilFirstWrite(lastDigestRunTimestampSeconds);

  const lastDigestResult = new Gauge({
    name: 'sync_last_digest_result',
    help: '1 if the last digest run succeeded, 0 if it failed. Absent until one has run.',
    registers: [registry],
  });
  unsetUntilFirstWrite(lastDigestResult);

  const pollRunsTotal = new Counter({
    name: 'sync_poll_runs_total',
    help: 'Total number of poll cycles, by result and what triggered them.',
    labelNames: ['result', 'trigger'] as const,
    registers: [registry],
  });

  const webhookDeliveriesTotal = new Counter({
    name: 'sync_webhook_deliveries_total',
    help: 'Total number of inbound webhook deliveries, by how they were handled.',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const webhookPollsTriggeredTotal = new Counter({
    name: 'sync_webhook_polls_triggered_total',
    help: 'Poll cycles actually started by a webhook nudge, after coalescing.',
    registers: [registry],
  });

  const lastWebhookReceivedTimestampSeconds = new Gauge({
    name: 'sync_last_webhook_received_timestamp_seconds',
    help: 'Unix time of the last verified webhook delivery. Absent until one arrives. Diagnostic only - a quiet workspace and a broken webhook look identical here.',
    registers: [registry],
  });
  unsetUntilFirstWrite(lastWebhookReceivedTimestampSeconds);

  const pollDurationSeconds = new Histogram({
    name: 'sync_poll_duration_seconds',
    help: 'Time taken per poll cycle.',
    registers: [registry],
  });

  const reconcileActionsTotal = new Counter({
    name: 'sync_reconcile_actions_total',
    help: 'Total number of reconciliation actions taken, by action type.',
    labelNames: ['action'] as const,
    registers: [registry],
  });

  const digestCommentsPostedTotal = new Counter({
    name: 'sync_digest_comments_posted_total',
    help: 'Total number of digest comments actually posted.',
    registers: [registry],
  });

  const apiRequestsTotal = new Counter({
    name: 'sync_api_requests_total',
    help: 'Total number of upstream API requests, by service and result.',
    labelNames: ['service', 'result'] as const,
    registers: [registry],
  });

  const apiRequestDurationSeconds = new Histogram({
    name: 'sync_api_request_duration_seconds',
    help: 'Upstream API request latency, by service.',
    labelNames: ['service'] as const,
    registers: [registry],
  });

  const mappings = new Gauge({
    name: 'sync_mappings',
    help: 'Count of currently discovered mappings, by status.',
    labelNames: ['status'] as const,
    registers: [registry],
  });

  return {
    registry,
    lastPollSuccessTimestampSeconds,
    lastPollResult,
    lastDigestRunTimestampSeconds,
    lastDigestResult,
    pollRunsTotal,
    webhookDeliveriesTotal,
    webhookPollsTriggeredTotal,
    lastWebhookReceivedTimestampSeconds,
    pollDurationSeconds,
    reconcileActionsTotal,
    digestCommentsPostedTotal,
    apiRequestsTotal,
    apiRequestDurationSeconds,
    mappings,
  };
}
