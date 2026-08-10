import { buildProjectName, isLostProject } from '../naming.js';
import type { Action, Snapshot } from '../types.js';

/**
 * The core state machine (§5.1/§5.2): a pure function from the current discovered state of
 * both systems to the list of actions needed to reconcile them. Every poll cycle calls this
 * fresh against a brand-new snapshot - there is no memory of "what we did last time" here or
 * anywhere else, so a given snapshot always produces the same actions regardless of history.
 */
export function planActions(snapshot: Snapshot): Action[] {
  const actions: Action[] = [];

  for (const mapping of snapshot.mappings) {
    actions.push(...planForMapping(mapping));
  }

  for (const orphan of snapshot.orphans) {
    const action = planForOrphan(orphan);
    if (action) {
      actions.push(action);
    }
  }

  return actions;
}

function planForMapping(mapping: Snapshot['mappings'][number]): Action[] {
  const { issue, matchedProject, attachment } = mapping;

  if (!matchedProject) {
    // §5.1 "issue enters started": no active or archived project found at all.
    return attachment
      ? // §5.2 row 3: an attachment still points at a project that's now gone entirely.
        [{ kind: 'recreate_project', issue, previousProjectUrl: attachment.url }]
      : [{ kind: 'create_project', issue }];
  }

  if (matchedProject.isArchived) {
    // §5.1 "issue enters started" (re-entering) / §5.2 row 1: Linear owns the lifecycle.
    return [{ kind: 'unarchive_project', project: matchedProject, issue }];
  }

  const actions: Action[] = [];

  // §5.1 "title changes" / §5.2 row 2: "Linear wins" regardless of which side drifted.
  if (matchedProject.name !== buildProjectName(issue.identifier, issue.title)) {
    actions.push({ kind: 'rename_project', project: matchedProject, issue });
  }

  // §5.4 self-heal: the card is always found fresh, never assumed to still exist.
  actions.push(
    attachment
      ? { kind: 'refresh_card', attachment, project: matchedProject, issue }
      : { kind: 'reattach_card', issue, project: matchedProject },
  );

  return actions;
}

function planForOrphan(orphan: Snapshot['orphans'][number]): Action | null {
  const { project, linkedIssue } = orphan;

  // §5.1: "once a project's name already carries [LOST], later polls skip it."
  if (isLostProject(project.name)) {
    return null;
  }

  if (!linkedIssue) {
    // §5.1 "issue is deleted outright": no surviving issue to reconcile against.
    return { kind: 'mark_lost', project };
  }

  if (!project.isArchived) {
    // §5.1 "issue moves to another state": archive, leaving tasks untouched.
    return { kind: 'archive_project', project, linkedIssueId: linkedIssue.id };
  }

  // Already archived and its issue isn't started - correctly reflects reality, nothing to do.
  return null;
}
