export type Config = {
  linearApiKey: string;
  todoistApiToken: string;
  pollIntervalSeconds: number;
  digestTime: string;
  digestTimezone: string;
  metricsPort: number;
};

class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

function parseDigestTime(env: NodeJS.ProcessEnv, fallback: string): string {
  const raw = env.DIGEST_TIME ?? fallback;
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(raw)) {
    throw new ConfigError(`DIGEST_TIME must be in HH:MM 24-hour format, got: ${raw}`);
  }
  return raw;
}

function parseDigestTimezone(env: NodeJS.ProcessEnv, fallback: string): string {
  const raw = env.DIGEST_TIMEZONE ?? fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
  } catch {
    throw new ConfigError(`DIGEST_TIMEZONE is not a recognized IANA time zone, got: ${raw}`);
  }
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    linearApiKey: required(env, 'LINEAR_API_KEY'),
    todoistApiToken: required(env, 'TODOIST_API_TOKEN'),
    pollIntervalSeconds: parsePositiveInt(env, 'POLL_INTERVAL_SECONDS', 60),
    digestTime: parseDigestTime(env, '07:00'),
    digestTimezone: parseDigestTimezone(env, 'UTC'),
    metricsPort: parsePositiveInt(env, 'METRICS_PORT', 9464),
  };
}

export { ConfigError };
