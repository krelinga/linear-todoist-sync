import {
  colorKeys,
  FALLBACK_STATE_COLOR,
  isColorKey,
  normalizeStateName,
  type ColorKey,
  type StateColorMap,
} from './colors.js';

/**
 * Settings for the Linear webhook receiver (webhook design §9). Present only when a signing
 * secret is configured - see `parseWebhook` for why that gate is the whole feature flag.
 */
export type WebhookConfig = {
  secret: string;
  port: number;
  path: string;
  debounceMs: number;
};

export type Config = {
  linearApiKey: string;
  todoistApiToken: string;
  pollIntervalSeconds: number;
  digestTime: string;
  digestTimezone: string;
  metricsPort: number;
  /** null means poll-only mode: no receiver is started at all (webhook design §5.6). */
  webhook: WebhookConfig | null;
  /** Linear state name -> Todoist project color (colors design §4). Empty disables coloring. */
  stateColors: StateColorMap;
  /** Color for a started state `stateColors` does not mention (colors design §5). */
  defaultStateColor: ColorKey;
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

/** Every var that only makes sense alongside a signing secret - see `parseWebhook`. */
const WEBHOOK_DEPENDENT_VARS = ['WEBHOOK_PORT', 'WEBHOOK_PATH', 'WEBHOOK_DEBOUNCE_MS'] as const;

/**
 * Fails closed (webhook design §5.6): with no signing secret there is no webhook config, so
 * nothing can start an unverified listener. Setting the other webhook vars without a secret is
 * an error rather than a silent no-op, since that combination always means the operator thought
 * the receiver was running when it was not.
 */
function parseWebhook(env: NodeJS.ProcessEnv, metricsPort: number): WebhookConfig | null {
  const secret = env.LINEAR_WEBHOOK_SECRET;
  if (!secret) {
    const orphaned = WEBHOOK_DEPENDENT_VARS.filter((name) => env[name] !== undefined);
    if (orphaned.length > 0) {
      throw new ConfigError(
        `${orphaned.join(', ')} set without LINEAR_WEBHOOK_SECRET; the webhook receiver cannot start unverified`,
      );
    }
    return null;
  }

  const port = parsePositiveInt(env, 'WEBHOOK_PORT', 9465);
  if (port === metricsPort) {
    throw new ConfigError(
      `WEBHOOK_PORT (${port}) must differ from METRICS_PORT; only the webhook port is exposed publicly`,
    );
  }

  const path = env.WEBHOOK_PATH ?? '/webhooks/linear';
  if (!path.startsWith('/')) {
    throw new ConfigError(`WEBHOOK_PATH must start with "/", got: ${path}`);
  }

  return { secret, port, path, debounceMs: parsePositiveInt(env, 'WEBHOOK_DEBOUNCE_MS', 2000) };
}

/**
 * Parses `LINEAR_STATE_COLORS` - `"In Progress=blue,In Review=grape"` (colors design §4).
 *
 * Each entry splits on its **last** `=`, not its first: a color key never contains one, so
 * splitting from the right lets a state name contain `=` for free. The shape this form cannot
 * express is a state name containing a comma, which is an accepted limit - such a name splits
 * into fragments matching no Linear state, so its projects take the default color and the state
 * appears in the unmapped gauge like any other gap.
 *
 * Absent or empty is valid and means "color nothing": every project gets the default. That is a
 * legitimate way to switch the feature off rather than a misconfiguration.
 */
function parseStateColors(env: NodeJS.ProcessEnv): StateColorMap {
  const raw = env.LINEAR_STATE_COLORS;
  if (raw === undefined || raw.trim() === '') {
    return new Map();
  }

  const stateColors = new Map<string, ColorKey>();
  const names = new Map<string, string>();
  for (const entry of raw.split(',')) {
    if (entry.trim() === '') {
      continue; // A trailing or doubled comma is sloppy, not ambiguous.
    }
    const separator = entry.lastIndexOf('=');
    if (separator === -1) {
      throw new ConfigError(
        `LINEAR_STATE_COLORS entry is missing "=": ${entry.trim()}. Expected "State Name=color".`,
      );
    }
    const name = entry.slice(0, separator).trim();
    const color = entry.slice(separator + 1).trim();
    if (name === '') {
      throw new ConfigError(`LINEAR_STATE_COLORS entry has an empty state name: ${entry.trim()}`);
    }
    if (!isColorKey(color)) {
      throw new ConfigError(
        `LINEAR_STATE_COLORS gives state "${name}" an unknown Todoist color "${color}". Valid colors: ${colorKeys().join(', ')}`,
      );
    }
    const key = normalizeStateName(name);
    const existing = names.get(key);
    if (existing !== undefined) {
      // Not last-one-wins: the two entries disagree about intent, and silently picking one
      // would leave the operator looking at a colour they did not ask for with no hint why.
      throw new ConfigError(
        `LINEAR_STATE_COLORS names the same state twice ("${existing}" and "${name}"); state names are matched case-insensitively`,
      );
    }
    names.set(key, name);
    stateColors.set(key, color);
  }
  return stateColors;
}

function parseDefaultStateColor(env: NodeJS.ProcessEnv): ColorKey {
  const raw = env.LINEAR_STATE_COLOR_DEFAULT;
  if (raw === undefined || raw.trim() === '') {
    return FALLBACK_STATE_COLOR;
  }
  const color = raw.trim();
  if (!isColorKey(color)) {
    throw new ConfigError(
      `LINEAR_STATE_COLOR_DEFAULT is not a known Todoist color: ${color}. Valid colors: ${colorKeys().join(', ')}`,
    );
  }
  return color;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const metricsPort = parsePositiveInt(env, 'METRICS_PORT', 9464);
  return {
    linearApiKey: required(env, 'LINEAR_API_KEY'),
    todoistApiToken: required(env, 'TODOIST_API_TOKEN'),
    pollIntervalSeconds: parsePositiveInt(env, 'POLL_INTERVAL_SECONDS', 60),
    digestTime: parseDigestTime(env, '07:00'),
    digestTimezone: parseDigestTimezone(env, 'UTC'),
    metricsPort,
    webhook: parseWebhook(env, metricsPort),
    stateColors: parseStateColors(env),
    defaultStateColor: parseDefaultStateColor(env),
  };
}

export { ConfigError };
