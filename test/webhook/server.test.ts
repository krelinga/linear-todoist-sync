import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../../src/metrics.js';
import { createWebhookServer } from '../../src/webhook/server.js';

const SECRET = 'lin_wh_test_secret';
const PATH = '/webhooks/linear';

let server: Server;
let baseUrl: string;
let onIssueEvent: ReturnType<typeof vi.fn>;
let metrics: ReturnType<typeof createMetrics>;

beforeEach(async () => {
  onIssueEvent = vi.fn();
  metrics = createMetrics();
  server = createWebhookServer({
    config: { secret: SECRET, port: 0, path: PATH, debounceMs: 2000 },
    metrics,
    onIssueEvent,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'update',
    type: 'Issue',
    webhookTimestamp: Date.now(),
    ...overrides,
  });
}

function post(payload: string, init: { signed?: boolean; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...init.headers };
  if (init.signed !== false) {
    headers['linear-signature'] = createHmac('sha256', SECRET).update(payload).digest('hex');
  }
  return fetch(`${baseUrl}${PATH}`, { method: 'POST', headers, body: payload });
}

async function deliveryCount(result: string): Promise<number> {
  const { values } = await metrics.webhookDeliveriesTotal.get();
  return values.find((v) => v.labels.result === result)?.value ?? 0;
}

describe('createWebhookServer', () => {
  it('accepts a signed Issue delivery and nudges a poll', async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(onIssueEvent).toHaveBeenCalledTimes(1);
    expect(await deliveryCount('accepted')).toBe(1);
  });

  it('records the time of the last verified delivery', async () => {
    await post(body());
    const { values } = await metrics.lastWebhookReceivedTimestampSeconds.get();
    expect(values[0]?.value ?? 0).toBeGreaterThan(0);
  });

  // Linear disables a webhook after enough non-200 responses, so uninteresting events must
  // still be acknowledged rather than rejected.
  it('acknowledges non-Issue events with 200 but does not nudge', async () => {
    const res = await post(body({ type: 'Comment' }));
    expect(res.status).toBe(200);
    expect(onIssueEvent).not.toHaveBeenCalled();
    expect(await deliveryCount('ignored')).toBe(1);
  });

  it('rejects an unsigned delivery with 401 and does not nudge', async () => {
    const res = await post(body(), { signed: false });
    expect(res.status).toBe(401);
    expect(onIssueEvent).not.toHaveBeenCalled();
    expect(await deliveryCount('rejected_signature')).toBe(1);
  });

  it('rejects a stale delivery', async () => {
    const res = await post(body({ webhookTimestamp: Date.now() - 120_000 }));
    expect(res.status).toBe(401);
    expect(await deliveryCount('rejected_stale')).toBe(1);
  });

  it('rejects a signed but malformed body', async () => {
    const res = await post('not json at all');
    expect(res.status).toBe(401);
    expect(await deliveryCount('rejected_malformed')).toBe(1);
  });

  // The ingress probe's whole design is that an unsigned 401 proves the path is alive; it must
  // not pollute rejected_signature, whose value is that it normally sits still.
  it('counts the ingress probe separately from signature failures', async () => {
    const res = await post(body(), {
      signed: false,
      headers: { 'user-agent': 'Blackbox Exporter/0.25.0' },
    });
    expect(res.status).toBe(401);
    expect(await deliveryCount('probe')).toBe(1);
    expect(await deliveryCount('rejected_signature')).toBe(0);
  });

  it('404s a GET to the webhook path', async () => {
    const res = await fetch(`${baseUrl}${PATH}`);
    expect(res.status).toBe(404);
  });

  it('404s a POST to any other path', async () => {
    const res = await fetch(`${baseUrl}/metrics`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(onIssueEvent).not.toHaveBeenCalled();
  });

  it('ignores a query string when matching the path', async () => {
    const payload = body();
    const signature = createHmac('sha256', SECRET).update(payload).digest('hex');
    const res = await fetch(`${baseUrl}${PATH}?retry=1`, {
      method: 'POST',
      headers: { 'linear-signature': signature },
      body: payload,
    });
    expect(res.status).toBe(200);
  });

  it('rejects a body over the size cap', async () => {
    const res = await post(body({ padding: 'x'.repeat(2 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(onIssueEvent).not.toHaveBeenCalled();
  });

  // Duplicate deliveries are expected (Linear retries) and are safe by construction: each one
  // just requests another full reconciliation, which is idempotent.
  it('handles a duplicate delivery without special-casing it', async () => {
    const payload = body();
    expect((await post(payload)).status).toBe(200);
    expect((await post(payload)).status).toBe(200);
    expect(onIssueEvent).toHaveBeenCalledTimes(2);
  });
});
