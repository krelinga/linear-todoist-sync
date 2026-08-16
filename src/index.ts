import { createServer, type Server } from 'node:http';
import { LinearClient as LinearSdkClient } from '@linear/sdk';
import { TodoistApi } from '@doist/todoist-sdk';
import { loadConfig, ConfigError } from './config.js';
import { logger } from './logger.js';
import { createMetrics } from './metrics.js';
import { LinearClient } from './clients/linear.js';
import { TodoistClient } from './clients/todoist.js';
import { startScheduler } from './scheduler.js';
import { createPollNudge, type PollNudge } from './webhook/nudge.js';
import { createWebhookServer } from './webhook/server.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error('Invalid configuration', { error: err.message });
      process.exit(1);
    }
    throw err;
  }

  const metrics = createMetrics();
  const linear = new LinearClient(new LinearSdkClient({ apiKey: config.linearApiKey }), metrics);
  const todoist = new TodoistClient(new TodoistApi(config.todoistApiToken), metrics);

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      metrics.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': metrics.registry.contentType });
          res.end(body);
        })
        .catch((err: unknown) => {
          logger.error('Failed to render metrics', { error: String(err) });
          res.writeHead(500);
          res.end();
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(config.metricsPort, () => {
    logger.info('Metrics server listening', { port: config.metricsPort });
  });

  const scheduler = startScheduler({
    config: {
      pollIntervalSeconds: config.pollIntervalSeconds,
      digestTime: config.digestTime,
      digestTimezone: config.digestTimezone,
    },
    linear,
    todoist,
    metrics,
  });
  logger.info('Scheduler started', {
    pollIntervalSeconds: config.pollIntervalSeconds,
    digestTime: config.digestTime,
    digestTimezone: config.digestTimezone,
  });

  // The webhook receiver is a pure latency optimization: with no signing secret configured the
  // service runs exactly as it did before, reconciling on the poll interval alone.
  let webhookServer: Server | null = null;
  let nudge: PollNudge | null = null;
  if (config.webhook === null) {
    logger.info('Webhook receiver disabled; reconciling on the poll interval only');
  } else {
    nudge = createPollNudge({
      debounceMs: config.webhook.debounceMs,
      runPoll: scheduler.requestPoll,
      metrics,
    });
    const requestPoll = nudge.request;
    webhookServer = createWebhookServer({
      config: config.webhook,
      metrics,
      onIssueEvent: requestPoll,
    });
    webhookServer.listen(config.webhook.port, () => {
      logger.info('Webhook receiver listening', {
        port: config.webhook?.port,
        path: config.webhook?.path,
        debounceMs: config.webhook?.debounceMs,
      });
    });
  }

  const shutdown = (signal: string) => {
    logger.info('Shutting down', { signal });
    scheduler.stop();
    nudge?.stop();
    const servers = [server, webhookServer].filter((s): s is Server => s !== null);
    let remaining = servers.length;
    for (const s of servers) {
      s.close(() => {
        remaining -= 1;
        if (remaining === 0) {
          process.exit(0);
        }
      });
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
