import { createServer, type IncomingMessage, type Server } from 'node:http';
import { verifyDelivery } from './verify.js';
import { logger } from '../logger.js';
import type { WebhookConfig } from '../config.js';
import type { Metrics } from '../metrics.js';

/** Linear payloads are small; anything larger is not a delivery we need to read. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Past this we stop being polite and cut the connection. Below it we keep draining an oversized
 * body so the client gets a clean 413 rather than a connection reset - destroying the socket
 * mid-upload discards the response along with it.
 */
const DRAIN_ABORT_BYTES = MAX_BODY_BYTES * 8;

/**
 * The external ingress probe (webhook design §8.2) deliberately sends an unsigned request and
 * treats the resulting 401 as proof of life. Counting it separately keeps rejected_signature
 * meaningful - otherwise a 5-minute probe adds ~288/day to a counter whose diagnostic value is
 * that it normally sits still.
 */
const PROBE_USER_AGENT_PATTERN = /^Blackbox Exporter/i;

export type WebhookServerDeps = {
  config: WebhookConfig;
  metrics: Metrics;
  /** Called after the response is sent, for deliveries that could have changed a Linear issue. */
  onIssueEvent: () => void;
};

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Buffers the raw bytes, which is what the signature must be checked against (§5.2). */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (!oversized && size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0; // release what was buffered; it will never be used
      }
      if (oversized) {
        if (size > DRAIN_ABORT_BYTES) {
          resolve(null);
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(oversized ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The Linear webhook receiver (webhook design §3.2).
 *
 * Two response rules are deliberate and easy to get wrong:
 *
 * - Any delivery that passes verification gets a 200 *before* reconciliation work starts,
 *   including ones we go on to ignore. Linear counts non-200 responses as failures and disables
 *   a webhook after enough of them, so returning an error for uninteresting events would slowly
 *   turn the feature off.
 * - Authenticity failures are the only deliberate non-2xx. Linear does not retry 4xx, which is
 *   exactly the right handling for a forged or replayed request.
 */
export function createWebhookServer(deps: WebhookServerDeps): Server {
  return createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method !== 'POST' || pathname !== deps.config.path) {
      res.writeHead(404);
      res.end();
      return;
    }

    readBody(req)
      .then((rawBody) => {
        if (rawBody === null) {
          deps.metrics.webhookDeliveriesTotal.inc({ result: 'rejected_malformed' });
          logger.warn('Rejected oversized webhook delivery', { system: 'webhook' });
          res.writeHead(413);
          res.end();
          return;
        }

        const signature = header(req, 'linear-signature');
        const result = verifyDelivery({ rawBody, signature, secret: deps.config.secret });

        if (!result.ok) {
          const userAgent = header(req, 'user-agent') ?? '';
          const isProbe = PROBE_USER_AGENT_PATTERN.test(userAgent);
          deps.metrics.webhookDeliveriesTotal.inc({
            result: isProbe ? 'probe' : `rejected_${result.reason}`,
          });
          if (!isProbe) {
            logger.warn('Rejected webhook delivery', { system: 'webhook', reason: result.reason });
          }
          res.writeHead(401);
          res.end();
          return;
        }

        deps.metrics.lastWebhookReceivedTimestampSeconds.set(Date.now() / 1000);
        res.writeHead(200);
        res.end();

        // Only Issue events can change what reconciliation cares about. Attachment and Comment
        // are not subscribed precisely because this service writes both (webhook §4.1).
        if (result.payload.type !== 'Issue') {
          deps.metrics.webhookDeliveriesTotal.inc({ result: 'ignored' });
          return;
        }
        deps.metrics.webhookDeliveriesTotal.inc({ result: 'accepted' });
        logger.debug('Accepted webhook delivery', { system: 'webhook', type: result.payload.type });
        deps.onIssueEvent();
      })
      .catch((err: unknown) => {
        logger.error('Webhook request failed', {
          system: 'webhook',
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
  });
}
