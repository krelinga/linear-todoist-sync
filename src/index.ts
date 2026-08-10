import { createServer } from 'node:http';
import { LinearClient as LinearSdkClient } from '@linear/sdk';
import { TodoistApi } from '@doist/todoist-sdk';
import { loadConfig, ConfigError } from './config.js';
import { logger } from './logger.js';
import { createMetrics } from './metrics.js';
import { LinearClient } from './clients/linear.js';
import { TodoistClient } from './clients/todoist.js';
import { startScheduler } from './scheduler.js';

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

  const shutdown = (signal: string) => {
    logger.info('Shutting down', { signal });
    scheduler.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
