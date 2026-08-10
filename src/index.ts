import { createServer } from 'node:http';
import { loadConfig, ConfigError } from './config.js';
import { logger } from './logger.js';
import { createMetrics } from './metrics.js';

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

  const shutdown = (signal: string) => {
    logger.info('Shutting down', { signal });
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
