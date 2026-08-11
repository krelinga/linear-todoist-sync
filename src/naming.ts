/** Marker used to recognize this service's own attachment cards during discovery (§6.1). */
export const SYNC_APP_MARKER = 'linear-todoist-sync';

/** Bumped if the attachment metadata schema's shape changes (§6.1). */
export const ATTACHMENT_SCHEMA_VERSION = 1;

/** Marker prefix used to recognize this service's own Todoist projects during discovery (§6.2). */
export const LINKED_ISSUE_MARKER_PREFIX = 'Linked Linear issue: ';

/** Publicly hosted Todoist icon for the Linear attachment card (§5.4). */
export const TODOIST_ICON_URL = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/todoist.png';

/** Prefix applied when an in-progress issue is deleted outright (§5.1). Idempotent by design. */
const LOST_PREFIX = '[LOST] ';

/** `[ENG-123] Fix the flaky login test` (§6.2) - regenerated from Linear on every poll. */
export function buildProjectName(identifier: string, title: string): string {
  return `[${identifier}] ${title}`;
}

/** `Linked Linear issue: <url>` (§6.2/§5.4) - set once at project creation time. */
export function buildProjectDescription(issueUrl: string): string {
  return `${LINKED_ISSUE_MARKER_PREFIX}${issueUrl}`;
}

/** Matches a whole-string markdown link like `[Linear](https://example.com)`. */
const MARKDOWN_LINK = /^\[[^\]]*\]\((\S+)\)$/;

/**
 * Extracts the linked Linear issue URL from a Todoist project description, if present.
 *
 * Todoist rewrites a bare URL in a project description into a markdown link
 * (`[Linear](https://...)`) as soon as it's saved, so a description built by
 * `buildProjectDescription` never round-trips as plain text - it must be unwrapped here.
 */
export function parseLinkedIssueUrl(description: string): string | null {
  if (!description.startsWith(LINKED_ISSUE_MARKER_PREFIX)) {
    return null;
  }
  const raw = description.slice(LINKED_ISSUE_MARKER_PREFIX.length).trim();
  const url = MARKDOWN_LINK.exec(raw)?.[1] ?? raw;
  return url.length > 0 ? url : null;
}

export function isLostProject(name: string): boolean {
  return name.startsWith(LOST_PREFIX);
}

/** Idempotent: returns `name` unchanged if it already carries the `[LOST] ` prefix. */
export function markAsLost(name: string): string {
  return isLostProject(name) ? name : `${LOST_PREFIX}${name}`;
}

export function buildAttachmentMetadata(lastDigestAt?: string): Record<string, unknown> {
  return {
    syncApp: SYNC_APP_MARKER,
    schemaVersion: ATTACHMENT_SCHEMA_VERSION,
    ...(lastDigestAt !== undefined ? { lastDigestAt } : {}),
  };
}

export function isMarkerAttachment(metadata: Record<string, unknown>): boolean {
  return metadata['syncApp'] === SYNC_APP_MARKER;
}

export function getLastDigestAt(metadata: Record<string, unknown>): string | null {
  const value = metadata['lastDigestAt'];
  return typeof value === 'string' ? value : null;
}

/** "7 tasks outstanding" / "1 task outstanding" / "0 tasks outstanding" (§5.4). */
export function buildOutstandingSubtitle(count: number): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'} outstanding`;
}

/** "Archived — 3 tasks were outstanding" (§5.4), frozen at the moment of archiving. */
export function buildArchivedSubtitle(outstandingCountAtArchiveTime: number): string {
  const noun = outstandingCountAtArchiveTime === 1 ? 'task was' : 'tasks were';
  return `Archived — ${outstandingCountAtArchiveTime} ${noun} outstanding`;
}
