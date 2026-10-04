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
      webhook: null,
      stateColors: new Map(),
      defaultStateColor: 'charcoal',
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

  describe('webhook settings', () => {
    it('is poll-only when no signing secret is set', () => {
      expect(loadConfig(baseEnv()).webhook).toBeNull();
    });

    it('applies webhook defaults once a secret is present', () => {
      const config = loadConfig(baseEnv({ LINEAR_WEBHOOK_SECRET: 'shh' }));
      expect(config.webhook).toEqual({
        secret: 'shh',
        port: 9465,
        path: '/webhooks/linear',
        debounceMs: 2000,
      });
    });

    it('reads webhook overrides', () => {
      const config = loadConfig(
        baseEnv({
          LINEAR_WEBHOOK_SECRET: 'shh',
          WEBHOOK_PORT: '9999',
          WEBHOOK_PATH: '/hooks/x',
          WEBHOOK_DEBOUNCE_MS: '500',
        }),
      );
      expect(config.webhook).toEqual({
        secret: 'shh',
        port: 9999,
        path: '/hooks/x',
        debounceMs: 500,
      });
    });

    // Fails closed (§5.6): these combinations always mean the operator believed the receiver
    // was running when it was not, so they must be loud rather than silently ignored.
    it.each(['WEBHOOK_PORT', 'WEBHOOK_PATH', 'WEBHOOK_DEBOUNCE_MS'])(
      'throws when %s is set without a secret',
      (name) => {
        expect(() => loadConfig(baseEnv({ [name]: '9999' }))).toThrow(ConfigError);
      },
    );

    it('rejects a webhook port that collides with the metrics port', () => {
      expect(() =>
        loadConfig(baseEnv({ LINEAR_WEBHOOK_SECRET: 'shh', WEBHOOK_PORT: '9464' })),
      ).toThrow(ConfigError);
    });

    it('rejects a webhook path that is not rooted', () => {
      expect(() =>
        loadConfig(baseEnv({ LINEAR_WEBHOOK_SECRET: 'shh', WEBHOOK_PATH: 'webhooks/linear' })),
      ).toThrow(ConfigError);
    });
  });
});

describe('loadConfig - LINEAR_STATE_COLORS (colors design §4)', () => {
  const base = { LINEAR_API_KEY: 'k', TODOIST_API_TOKEN: 't' };

  it('parses entries, trimming and lowercasing the state names', () => {
    const config = loadConfig({
      ...base,
      LINEAR_STATE_COLORS: 'In Progress=blue, In Review =grape,BLOCKED=red',
    });
    expect(config.stateColors).toEqual(
      new Map([
        ['in progress', 'blue'],
        ['in review', 'grape'],
        ['blocked', 'red'],
      ]),
    );
  });

  it('treats an absent or empty value as "colour nothing" rather than an error', () => {
    // A legitimate way to switch the feature off (§4), not a misconfiguration.
    expect(loadConfig({ ...base }).stateColors).toEqual(new Map());
    expect(loadConfig({ ...base, LINEAR_STATE_COLORS: '' }).stateColors).toEqual(new Map());
    expect(loadConfig({ ...base, LINEAR_STATE_COLORS: '   ' }).stateColors).toEqual(new Map());
  });

  it('ignores a trailing or doubled comma', () => {
    const config = loadConfig({ ...base, LINEAR_STATE_COLORS: 'In Progress=blue,,' });
    expect(config.stateColors).toEqual(new Map([['in progress', 'blue']]));
  });

  it('splits on the LAST equals, so a state name may contain one', () => {
    // A colour key never contains '=', so splitting from the right is free (§4).
    const config = loadConfig({ ...base, LINEAR_STATE_COLORS: 'Needs QA=/=blocked=red' });
    expect(config.stateColors).toEqual(new Map([['needs qa=/=blocked', 'red']]));
  });

  it('rejects an unknown colour, naming the state and listing the valid keys', () => {
    expect(() =>
      loadConfig({ ...base, LINEAR_STATE_COLORS: 'In Progress=periwinkle' }),
    ).toThrowError(/state "In Progress" an unknown Todoist color "periwinkle"/);
    expect(() =>
      loadConfig({ ...base, LINEAR_STATE_COLORS: 'In Progress=periwinkle' }),
    ).toThrowError(/sky_blue/);
  });

  it('rejects an entry with no equals at all', () => {
    expect(() => loadConfig({ ...base, LINEAR_STATE_COLORS: 'In Progress' })).toThrowError(
      /missing "="/,
    );
  });

  it('rejects an empty state name', () => {
    expect(() => loadConfig({ ...base, LINEAR_STATE_COLORS: '=blue' })).toThrowError(
      /empty state name/,
    );
  });

  it('rejects a duplicate state rather than letting the last one win', () => {
    // The two entries disagree about intent; silently picking one leaves the operator looking
    // at a colour they did not ask for with no hint why (§4).
    expect(() =>
      loadConfig({ ...base, LINEAR_STATE_COLORS: 'In Progress=blue,in progress=red' }),
    ).toThrowError(/names the same state twice/);
  });

  it('is a ConfigError, so main() exits cleanly rather than throwing a stack trace', () => {
    expect(() => loadConfig({ ...base, LINEAR_STATE_COLORS: 'x=nope' })).toThrowError(ConfigError);
  });
});

describe('loadConfig - LINEAR_STATE_COLOR_DEFAULT', () => {
  const base = { LINEAR_API_KEY: 'k', TODOIST_API_TOKEN: 't' };

  it("defaults to the SDK's own default colour when unset or blank", () => {
    expect(loadConfig({ ...base }).defaultStateColor).toBe('charcoal');
    expect(loadConfig({ ...base, LINEAR_STATE_COLOR_DEFAULT: '  ' }).defaultStateColor).toBe(
      'charcoal',
    );
  });

  it('accepts any real colour key, trimmed', () => {
    expect(loadConfig({ ...base, LINEAR_STATE_COLOR_DEFAULT: ' taupe ' }).defaultStateColor).toBe(
      'taupe',
    );
  });

  it('rejects an unknown colour', () => {
    expect(() => loadConfig({ ...base, LINEAR_STATE_COLOR_DEFAULT: 'burnt_sienna' })).toThrowError(
      ConfigError,
    );
  });
});
