type LogFields = Record<string, unknown>;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * ISO 8601 in the container's local timezone, offset included — `2026-09-11T08:42:13.123-05:00`.
 *
 * Local rather than UTC so a log line can be read straight against an alert notification or a
 * Grafana panel without doing the arithmetic first (#4). The offset is not decoration: it keeps
 * the line unambiguous across a DST transition, where one local wall-clock hour occurs twice,
 * and it keeps every ISO 8601 parser able to place the line on an absolute timeline. It is
 * recomputed per line, so the autumn changeover is reflected from the next line onward.
 *
 * The zone comes from the standard `TZ` environment variable, which Node's bundled ICU resolves
 * without the Alpine `tzdata` package (verified against `node:24-alpine`). That makes it a
 * deployment setting rather than a config option — see `docker-compose.yml`. With `TZ` unset the
 * offset is `+00:00` and the rendering is UTC, exactly as it was before.
 *
 * Only the *rendering* of log lines is local. Everything the service stores or sends stays UTC —
 * the `lastDigestAt` watermark (§6.1), the Todoist completion window (§7), the Prometheus
 * timestamp gauges (§8). Those are data, not display, and must not follow this.
 */
export function formatLocalTimestamp(date: Date): string {
  // getTimezoneOffset() reports minutes *behind* UTC, so UTC-5 comes back as +300. Negate it to
  // get the sign ISO 8601 uses, and take the remainder for the zones at :30 and :45.
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absMinutes = Math.abs(offsetMinutes);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absMinutes / 60))}:${pad(absMinutes % 60)}`
  );
}

function write(level: LogLevel, message: string, fields?: LogFields): void {
  const line = JSON.stringify({
    timestamp: formatLocalTimestamp(new Date()),
    level,
    message,
    ...fields,
  });
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write('debug', message, fields),
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
};
