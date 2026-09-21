import { discover } from '../reconcile/discover.js';
import { formatDigestComment } from './format.js';
import { buildAttachmentMetadata, getLastDigestAt } from '../naming.js';
import { errorFields } from '../errors.js';
import { logger } from '../logger.js';
import type { LinearPort } from '../clients/linear.js';
import type { TodoistPort } from '../clients/todoist.js';
import type { Metrics } from '../metrics.js';
import type { IssueMapping } from '../types.js';

/**
 * A mapping with no `lastDigestAt` watermark yet - one that has never had a successful digest -
 * needs *some* start point, and the true epoch is not it.
 *
 * This was 89 days, sized to stay under the completed-tasks endpoint's 3-month span limit. That
 * endpoint is gone (#2): completions now come from the activity log, whose own limit is
 * retention rather than span, is plan-dependent, and answers an over-long window with a 403 the
 * client handles by falling back to an unbounded query. So the API no longer constrains this
 * number at all, and it can be chosen for what makes a good first digest instead.
 *
 * Seven days is that choice. A first digest exists to say "here is what you finished recently",
 * and three months of history dumped into a Linear comment serves nobody - it is a wall of text
 * about work whose context is long gone. A week is recognisable. It also happens to sit at the
 * free plan's retention boundary, so the common case asks for exactly what is available and the
 * 403 path stays unexercised.
 */
const DEFAULT_LOOKBACK_DAYS = 7;

function defaultDigestSince(): string {
  return new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export type DigestDeps = {
  linear: LinearPort;
  todoist: TodoistPort;
  metrics: Metrics;
};

/**
 * The daily digest job (§7): for each active mapping, report Todoist tasks completed since the
 * last run as a Linear comment, then advance the watermark. Shares its discovery pass with the
 * poll cycle's logic (an "active mapping" is exactly what discover.ts already knows how to find)
 * but runs on its own schedule - the scheduler (a later commit) is responsible for making sure
 * this never overlaps a poll cycle, since both write to the same Linear attachment (§5.3).
 */
export async function runDigestJob(deps: DigestDeps): Promise<void> {
  let success = true;
  try {
    const snapshot = await discover(deps.linear, deps.todoist);
    const activeMappings = snapshot.mappings.filter(
      (mapping) => mapping.matchedProject && !mapping.matchedProject.isArchived,
    );
    for (const mapping of activeMappings) {
      try {
        await runDigestForMapping(mapping, deps);
      } catch (err) {
        success = false;
        logger.error('Failed to run digest for mapping', {
          issue: mapping.issue.identifier,
          issueId: mapping.issue.id,
          issueUrl: mapping.issue.url,
          todoistProject: mapping.matchedProject?.name,
          todoistProjectId: mapping.matchedProject?.id,
          ...errorFields(err),
        });
      }
    }
  } catch (err) {
    success = false;
    // Thrown out of discovery, before any individual mapping was reached - so unlike the
    // per-mapping error above, no single issue is to blame and none were digested.
    logger.error('Digest job failed', errorFields(err));
  } finally {
    deps.metrics.lastDigestResult.set(success ? 1 : 0);
    if (success) {
      deps.metrics.lastDigestRunTimestampSeconds.set(Date.now() / 1000);
    }
  }
}

async function runDigestForMapping(mapping: IssueMapping, deps: DigestDeps): Promise<void> {
  const { issue, matchedProject: project, attachment } = mapping;
  if (!project || !attachment) {
    // No card to read/write the watermark from - the poll loop will self-heal it (§5.4);
    // this mapping's digest just picks back up once that happens.
    return;
  }

  const lastDigestAt = getLastDigestAt(attachment.metadata) ?? defaultDigestSince();
  const completedTasks = await deps.todoist.getCompletedTasksSince(project.id, lastDigestAt);
  if (completedTasks.length === 0) {
    return; // §7 point 3: nothing to report, no comment and no metadata write.
  }

  const { sections } = await deps.todoist.getOutstandingTasks(project.id);
  const body = formatDigestComment(completedTasks, sections);
  await deps.linear.createComment(issue.id, body);

  await deps.linear.updateAttachment(attachment.id, {
    title: attachment.title,
    ...(attachment.subtitle !== null ? { subtitle: attachment.subtitle } : {}),
    metadata: buildAttachmentMetadata(new Date().toISOString()),
  });
  deps.metrics.digestCommentsPostedTotal.inc();
}
