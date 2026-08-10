import {
  buildArchivedSubtitle,
  buildAttachmentMetadata,
  buildOutstandingSubtitle,
  buildProjectDescription,
  buildProjectName,
  markAsLost,
  TODOIST_ICON_URL,
} from '../naming.js';
import { logger } from '../logger.js';
import type { LinearPort } from '../clients/linear.js';
import type { TodoistPort } from '../clients/todoist.js';
import type { Metrics } from '../metrics.js';
import type {
  Action,
  LinearAttachmentSummary,
  LinearIssueSummary,
  TodoistProjectSummary,
} from '../types.js';

export type ApplyDeps = {
  linear: LinearPort;
  todoist: TodoistPort;
  metrics: Metrics;
};

export type ApplyResult = { succeeded: number; failed: number };

/**
 * Executes each planned action (§5) against the real clients, sequentially - one poll cycle
 * processes its whole action set one at a time (§5.3), so two actions never race on the same
 * project or issue. A single action failing doesn't stop the rest: each is caught and logged
 * independently, since a failed item just needs to be retried on the next poll cycle (§4.3),
 * not have every other item's progress thrown away with it.
 */
export async function applyActions(actions: Action[], deps: ApplyDeps): Promise<ApplyResult> {
  let succeeded = 0;
  let failed = 0;
  for (const action of actions) {
    try {
      await applyAction(action, deps);
      succeeded++;
    } catch (err) {
      failed++;
      logger.error('Failed to apply reconciliation action', {
        action: action.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { succeeded, failed };
}

async function applyAction(action: Action, deps: ApplyDeps): Promise<void> {
  switch (action.kind) {
    case 'create_project':
      await createProjectAndCard(action.issue, deps);
      deps.metrics.reconcileActionsTotal.inc({ action: 'project_created' });
      return;

    case 'recreate_project':
      await createProjectAndCard(action.issue, deps);
      await deps.linear.createComment(
        action.issue.id,
        `The previously linked Todoist project (${action.previousProjectUrl}) appears to have been deleted outright. A new one has been created and linked above.`,
      );
      deps.metrics.reconcileActionsTotal.inc({ action: 'project_recreated' });
      deps.metrics.reconcileActionsTotal.inc({ action: 'comment_posted' });
      return;

    case 'unarchive_project':
      await deps.todoist.unarchiveProject(action.project.id);
      deps.metrics.reconcileActionsTotal.inc({ action: 'project_unarchived' });
      await refreshOrCreateCard(action.issue, action.project, deps);
      return;

    case 'rename_project':
      await deps.todoist.updateProject(action.project.id, {
        name: buildProjectName(action.issue.identifier, action.issue.title),
      });
      deps.metrics.reconcileActionsTotal.inc({ action: 'project_renamed' });
      return;

    case 'reattach_card':
      await createCardForExistingProject(action.issue, action.project, deps);
      deps.metrics.reconcileActionsTotal.inc({ action: 'card_reattached' });
      return;

    case 'refresh_card':
      await refreshCard(action.issue, action.project, action.attachment, deps);
      return;

    case 'archive_project':
      await archiveProject(action.project, action.linkedIssueId, deps);
      return;

    case 'mark_lost':
      await deps.todoist.updateProject(action.project.id, { name: markAsLost(action.project.name) });
      deps.metrics.reconcileActionsTotal.inc({ action: 'project_marked_lost' });
      return;
  }
}

async function createProjectAndCard(issue: LinearIssueSummary, deps: ApplyDeps): Promise<void> {
  const project = await deps.todoist.createProject({
    name: buildProjectName(issue.identifier, issue.title),
    description: buildProjectDescription(issue.url),
  });
  await deps.linear.createAttachment({
    issueId: issue.id,
    title: buildProjectName(issue.identifier, issue.title),
    url: project.url,
    iconUrl: TODOIST_ICON_URL,
    subtitle: buildOutstandingSubtitle(0),
    metadata: buildAttachmentMetadata(),
  });
}

async function createCardForExistingProject(
  issue: LinearIssueSummary,
  project: TodoistProjectSummary,
  deps: ApplyDeps,
): Promise<void> {
  const { tasks } = await deps.todoist.getOutstandingTasks(project.id);
  await deps.linear.createAttachment({
    issueId: issue.id,
    title: buildProjectName(issue.identifier, issue.title),
    url: project.url,
    iconUrl: TODOIST_ICON_URL,
    subtitle: buildOutstandingSubtitle(tasks.length),
    metadata: buildAttachmentMetadata(),
  });
}

/** Un-freezes the card after an unarchive by refreshing it, or self-heals a missing one (§5.4). */
async function refreshOrCreateCard(
  issue: LinearIssueSummary,
  project: TodoistProjectSummary,
  deps: ApplyDeps,
): Promise<void> {
  const attachment = await deps.linear.getMarkerAttachment(issue.id);
  if (attachment) {
    await refreshCard(issue, project, attachment, deps);
  } else {
    await createCardForExistingProject(issue, project, deps);
    deps.metrics.reconcileActionsTotal.inc({ action: 'card_reattached' });
  }
}

async function refreshCard(
  issue: LinearIssueSummary,
  project: TodoistProjectSummary,
  attachment: LinearAttachmentSummary,
  deps: ApplyDeps,
): Promise<void> {
  const { tasks } = await deps.todoist.getOutstandingTasks(project.id);
  const desiredTitle = buildProjectName(issue.identifier, issue.title);
  const desiredSubtitle = buildOutstandingSubtitle(tasks.length);
  if (attachment.title === desiredTitle && attachment.subtitle === desiredSubtitle) {
    return; // Avoid noisy no-op writes (§5.4).
  }
  await deps.linear.updateAttachment(attachment.id, {
    title: desiredTitle,
    subtitle: desiredSubtitle,
    metadata: attachment.metadata,
  });
  deps.metrics.reconcileActionsTotal.inc({ action: 'card_updated' });
}

async function archiveProject(
  project: TodoistProjectSummary,
  linkedIssueId: string,
  deps: ApplyDeps,
): Promise<void> {
  const { tasks } = await deps.todoist.getOutstandingTasks(project.id);
  if (tasks.length > 0) {
    const list = tasks.map((task) => `- ${task.content}`).join('\n');
    await deps.todoist.addProjectComment(
      project.id,
      `This project is being archived - the following tasks are still outstanding:\n${list}`,
    );
    deps.metrics.reconcileActionsTotal.inc({ action: 'comment_posted' });
  }

  await deps.todoist.archiveProject(project.id);
  deps.metrics.reconcileActionsTotal.inc({ action: 'project_archived' });

  const attachment = await deps.linear.getMarkerAttachment(linkedIssueId);
  if (attachment) {
    await deps.linear.updateAttachment(attachment.id, {
      title: attachment.title,
      subtitle: buildArchivedSubtitle(tasks.length),
      metadata: attachment.metadata,
    });
    deps.metrics.reconcileActionsTotal.inc({ action: 'card_updated' });
  }
}
