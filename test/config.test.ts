import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    LINEAR_API_KEY: 'linear-key',
    TODOIST_API_TOKEN: 'todoist-token',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('applies defaults when optional vars are unset', () => {
    const config = loadConfig(baseEnv());
    expect(config).toEqual({
      linearApiKey: 'linear-key',
      todoistApiToken: 'todoist-token',
      pollIntervalSeconds: 60,
      digestTime: '07:00',
      digestTimezone: 'UTC',
      metricsPort: 9464,
    });
  });

  it('reads all overrides', () => {
    const config = loadConfig(
      baseEnv({
        POLL_INTERVAL_SECONDS: '30',
        DIGEST_TIME: '23:45',
        DIGEST_TIMEZONE: 'America/Chicago',
        METRICS_PORT: '9100',
      }),
    );
    expect(config.pollIntervalSeconds).toBe(30);
    expect(config.digestTime).toBe('23:45');
    expect(config.digestTimezone).toBe('America/Chicago');
    expect(config.metricsPort).toBe(9100);
  });

  it.each(['LINEAR_API_KEY', 'TODOIST_API_TOKEN'])('throws when %s is missing', (name) => {
    const env = baseEnv();
    delete env[name];
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it.each(['0', '-1', 'abc', '1.5'])('rejects invalid POLL_INTERVAL_SECONDS %s', (value) => {
    expect(() => loadConfig(baseEnv({ POLL_INTERVAL_SECONDS: value }))).toThrow(ConfigError);
  });

  it.each(['7:00', '25:00', '07:60', 'not-a-time'])('rejects invalid DIGEST_TIME %s', (value) => {
    expect(() => loadConfig(baseEnv({ DIGEST_TIME: value }))).toThrow(ConfigError);
  });

  it('rejects an unrecognized DIGEST_TIMEZONE', () => {
    expect(() => loadConfig(baseEnv({ DIGEST_TIMEZONE: 'Not/AZone' }))).toThrow(ConfigError);
  });
});
