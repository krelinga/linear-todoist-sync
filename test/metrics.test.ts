import { describe, expect, it } from 'vitest';
import { createMetrics } from '../src/metrics.js';

async function samples(gauge: { get: () => Promise<{ values: unknown[] }> }) {
  return (await gauge.get()).values;
}

function lineFor(body: string, name: string): string | undefined {
  return body.split('\n').find((l) => l.startsWith(`${name} `));
}

/**
 * These gauges are read as `time() - gauge`. prom-client's default of 0 makes that difference
 * the whole Unix epoch, so a scrape before the first event reports ~56 years of staleness and
 * fires any alert built on it - for the digest, potentially for most of a day.
 */
describe('timestamp gauges before their first event', () => {
  it.each([
    ['sync_last_digest_run_timestamp_seconds', 'lastDigestRunTimestampSeconds'],
    ['sync_last_poll_success_timestamp_seconds', 'lastPollSuccessTimestampSeconds'],
    ['sync_last_webhook_received_timestamp_seconds', 'lastWebhookReceivedTimestampSeconds'],
  ] as const)('%s reports no sample at all', async (name, key) => {
    const metrics = createMetrics();

    expect(await samples(metrics[key])).toHaveLength(0);
    expect(lineFor(await metrics.registry.metrics(), name)).toBeUndefined();
  });

  it('never renders the zero that caused the bug', async () => {
    const body = await createMetrics().registry.metrics();
    expect(body).not.toContain('sync_last_digest_run_timestamp_seconds 0');
  });

  it('stays declared, so the metric is still discoverable while unset', async () => {
    // HELP/TYPE survive remove(); only the sample is withheld. A metric that vanished
    // entirely would be harder to find when wiring up a dashboard.
    const body = await createMetrics().registry.metrics();
    expect(body).toContain('# TYPE sync_last_digest_run_timestamp_seconds gauge');
    expect(body).toContain('# HELP sync_last_digest_run_timestamp_seconds');
  });

  it('appears as soon as a real event writes to it', async () => {
    const metrics = createMetrics();
    metrics.lastDigestRunTimestampSeconds.set(1_800_000_000);

    expect(await samples(metrics.lastDigestRunTimestampSeconds)).toHaveLength(1);
    expect(
      lineFor(await metrics.registry.metrics(), 'sync_last_digest_run_timestamp_seconds'),
    ).toBe('sync_last_digest_run_timestamp_seconds 1800000000');
  });
});

/**
 * Same defect, more direct: 0 is a meaningful value here, so the default asserts a failure
 * that never happened.
 */
describe('result gauges before their first run', () => {
  it.each([
    ['sync_last_digest_result', 'lastDigestResult'],
    ['sync_last_poll_result', 'lastPollResult'],
  ] as const)('%s reports no sample rather than "failed"', async (name, key) => {
    const metrics = createMetrics();

    expect(await samples(metrics[key])).toHaveLength(0);
    expect(lineFor(await metrics.registry.metrics(), name)).toBeUndefined();
  });

  it('reports a real failure once one happens', async () => {
    const metrics = createMetrics();
    metrics.lastDigestResult.set(0);

    expect(lineFor(await metrics.registry.metrics(), 'sync_last_digest_result')).toBe(
      'sync_last_digest_result 0',
    );
  });
});
