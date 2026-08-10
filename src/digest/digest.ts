import { discover } from '../reconcile/discover.js';
import { formatDigestComment } from './format.js';
import { buildAttachmentMetadata, getLastDigestAt } from '../naming.js';
import { logger } from '../logger.js';
import type { LinearPort } from '../clients/linear.js';
import type { TodoistPort } from '../clients/todoist.js';
import type { Metrics } from '../metrics.js';
import type { IssueMapping } from '../types.js';

const EPOCH = new Date(0).toISOString();

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
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    success = false;
    logger.error('Digest job failed', { error: err instanceof Error ? err.message : String(err) });
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

  const lastDigestAt = getLastDigestAt(attachment.metadata) ?? EPOCH;
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
