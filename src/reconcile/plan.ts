import { buildProjectName, isLostProject } from '../naming.js';
import { resolveStateColor, type ColorKey, type StateColorMap } from '../colors.js';
import type { Action, Snapshot } from '../types.js';

/**
 * What planning needs beyond the snapshot: the state-to-color mapping (colors design §4).
 *
 * Passed in rather than read from the environment so `planActions` stays a pure function of
 * its inputs - the property that lets the state machine be tested exhaustively without
 * stubbing config.
 */
export type PlanConfig = {
  stateColors: StateColorMap;
  defaultStateColor: ColorKey;
};

/**
 * The core state machine (§5.1/§5.2): a pure function from the current discovered state of
 * both systems to the list of actions needed to reconcile them. Every poll cycle calls this
 * fresh against a brand-new snapshot - there is no memory of "what we did last time" here or
 * anywhere else, so a given snapshot always produces the same actions regardless of history.
 */
export function planActions(snapshot: Snapshot, config: PlanConfig): Action[] {
  const actions: Action[] = [];

  for (const mapping of snapshot.mappings) {
    actions.push(...planForMapping(mapping, config));
  }

  for (const orphan of snapshot.orphans) {
    const action = planForOrphan(orphan);
    if (action) {
      actions.push(action);
    }
  }

  return actions;
}

function planForMapping(mapping: Snapshot['mappings'][number], config: PlanConfig): Action[] {
  const { issue, matchedProject, attachment, strayAttachments } = mapping;

  // Independent of everything below: these belong to an issue this one absorbed as a duplicate
  // (§5.5), and are removed whatever else this mapping turns out to need.
  const strays: Action[] =
    strayAttachments.length > 0
      ? [{ kind: 'delete_stray_cards', issue, attachments: strayAttachments }]
      : [];

  if (!matchedProject) {
    // §5.1 "issue enters started": no active or archived project found at all.
    return attachment
      ? // §5.2 row 3: an attachment still points at a project that's now gone entirely.
        [...strays, { kind: 'recreate_project', issue, previousProjectUrl: attachment.url }]
      : [...strays, { kind: 'create_project', issue }];
  }

  if (matchedProject.isArchived) {
    // §5.1 "issue enters started" (re-entering) / §5.2 row 1: Linear owns the lifecycle.
    return [...strays, { kind: 'unarchive_project', project: matchedProject, issue }];
  }

  const actions: Action[] = [...strays];

  // §5.1 "title changes" / §5.2 row 2 and colors design §5: "Linear wins" regardless of which
  // side drifted, for the name and the color alike. Emitted as one action because
  // `updateProject` takes both fields in a single call, so a simultaneous rename and recolor
  // must not cost two writes - and only the fields that actually diverged are carried, so the
  // write stays minimal and the metrics can tell which of the two happened.
  const desiredName = buildProjectName(issue.identifier, issue.title);
  const desiredColor = resolveStateColor(
    issue.stateName,
    config.stateColors,
    config.defaultStateColor,
  );
  const update: Extract<Action, { kind: 'update_project' }> = {
    kind: 'update_project',
    project: matchedProject,
    issue,
  };
  if (matchedProject.name !== desiredName) {
    update.name = desiredName;
  }
  if (matchedProject.color !== desiredColor) {
    update.color = desiredColor;
  }
  if (update.name !== undefined || update.color !== undefined) {
    actions.push(update);
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
  const { project, linkedIssue, displacedCard } = orphan;

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
    return { kind: 'archive_project', project, linkedIssueId: linkedIssue.id, displacedCard };
  }

  // Already archived and its issue isn't started - correctly reflects reality, nothing to do.
  return null;
}
