/**
 * How far back to look for completions when no `lastDigestAt` watermark exists.
 *
 * Shared by the daily digest and by the closing comment posted when a mapping is archived
 * (§5.6), which needs the same fallback for the same reason.
 *
 * A mapping with no watermark yet - one that has never had a successful digest -
 * needs *some* start point, and the true epoch is not it.
 *
 * This was 89 days, sized to stay under the completed-tasks endpoint's 3-month span limit. That
 * endpoint is gone (#2): completions now come from the activity log, whose own limit is
 * retention rather than span, is plan-dependent, and answers an over-long window with a 403 the
 * client handles by falling back to an unbounded query. So the API no longer constrains this
 * number at all, and it can be chosen for what makes a good first digest instead.
 *
 * About a week is that choice. A first digest exists to say "here is what you finished
 * recently", and three months of history dumped into a Linear comment serves nobody - it is a
 * wall of text about work whose context is long gone.
 *
 * Six rather than seven because the free plan's activity retention is exactly seven days, and
 * asking for the boundary itself is outside it: probing a live account, six days back returns
 * results and seven returns 403. Seven therefore 403'd on every first digest for a free
 * account. The client's fallback now recovers from that correctly, but recovering needs a
 * second request and logs a warning each time, so it is better not to trip it. A day of margin
 * also absorbs the difference between a rolling cutoff and a calendar-day one.
 */
const DEFAULT_LOOKBACK_DAYS = 6;

export function defaultDigestSince(): string {
  return new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
