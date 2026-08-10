import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export type Metrics = ReturnType<typeof createMetrics>;

export function createMetrics(registry: Registry = new Registry()) {
  const lastPollSuccessTimestampSeconds = new Gauge({
    name: 'sync_last_poll_success_timestamp_seconds',
    help: 'Unix time of the last poll that completed without error.',
    registers: [registry],
  });

  const lastPollResult = new Gauge({
    name: 'sync_last_poll_result',
    help: '1 if the last poll succeeded, 0 if it failed.',
    registers: [registry],
  });

  const lastDigestRunTimestampSeconds = new Gauge({
    name: 'sync_last_digest_run_timestamp_seconds',
    help: 'Unix time of the last completed digest run.',
    registers: [registry],
  });

  const lastDigestResult = new Gauge({
    name: 'sync_last_digest_result',
    help: '1 if the last digest run succeeded, 0 if it failed.',
    registers: [registry],
  });

  const pollRunsTotal = new Counter({
    name: 'sync_poll_runs_total',
    help: 'Total number of poll cycles, by result.',
    labelNames: ['result'] as const,
    registers: [registry],
  });

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
    pollDurationSeconds,
    reconcileActionsTotal,
    digestCommentsPostedTotal,
    apiRequestsTotal,
    apiRequestDurationSeconds,
    mappings,
  };
}
