import type { ColorKey } from './colors.js';

/** A Linear issue, normalized to the fields this service actually needs. */
export type LinearIssueSummary = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  stateType: string;
  /**
   * The workflow state's display name (e.g. `In Progress`), which is what a project color is
   * keyed on (colors design §3). Free to carry: the client already resolves the whole state
   * object in order to read `stateType`, so this costs no extra request.
   */
  stateName: string;
  updatedAt: string;
};

/** The marker attachment (§5.4/§6.1) this service creates on an issue's Linear page. */
export type LinearAttachmentSummary = {
  id: string;
  url: string;
  title: string;
  subtitle: string | null;
  metadata: Record<string, unknown>;
};

export type CreateAttachmentInput = {
  issueId: string;
  title: string;
  url: string;
  iconUrl: string;
  subtitle?: string;
  metadata: Record<string, unknown>;
};

export type UpdateAttachmentInput = {
  title: string;
  subtitle?: string;
  metadata?: Record<string, unknown>;
};

/** A Todoist project, normalized to the fields this service actually needs. */
export type TodoistProjectSummary = {
  id: string;
  name: string;
  url: string;
  description: string;
  isArchived: boolean;
  /**
   * Current Todoist color key. Read so that divergence from the issue's state color is
   * detectable, exactly as `name` is - a plain `string` rather than `ColorKey` because this is
   * whatever Todoist reports, which is not ours to assume is in the palette we know.
   */
  color: string;
};

export type TodoistTaskSummary = {
  id: string;
  content: string;
  sectionId: string | null;
};

export type TodoistCompletedTaskSummary = {
  content: string;
  completedAt: string;
  sectionId: string | null;
};

export type TodoistSectionSummary = {
  id: string;
  name: string;
  order: number;
};

export type CreateProjectInput = {
  name: string;
  description: string;
  color: ColorKey;
};

export type UpdateProjectInput = {
  name?: string;
  description?: string;
  color?: ColorKey;
};

/** A started Linear issue paired with whatever this service already knows about it (§5 step 3). */
export type IssueMapping = {
  issue: LinearIssueSummary;
  /** Found by matching the issue's URL against a marked Todoist project's description (§5.4). */
  matchedProject: TodoistProjectSummary | null;
  /** This service's own marker attachment on the issue, if one currently exists (§5.4). */
  attachment: LinearAttachmentSummary | null;
  /**
   * Further marker cards on the same issue, which should not exist. Linear moves a duplicate's
   * attachments onto the canonical issue, so marking B a duplicate of A leaves A holding both
   * (§5.5). Everything here is scheduled for deletion.
   */
  strayAttachments: LinearAttachmentSummary[];
};

/** A marked Todoist project with no started Linear issue currently pointing at it (§5.1/§5.2). */
export type OrphanedProject = {
  project: TodoistProjectSummary;
  /** The linked issue's current state, or null if that issue no longer exists at all. */
  linkedIssue: LinearIssueSummary | null;
  /**
   * This project's card, found among the strays on some *other* issue - which happens when the
   * linked issue was absorbed as a duplicate and Linear moved its card away (§5.5). Captured
   * here at discovery because the card carries the digest watermark and is about to be deleted;
   * the metadata is what matters, not the card's continued existence.
   */
  displacedCard: LinearAttachmentSummary | null;
};

export type Snapshot = {
  mappings: IssueMapping[];
  orphans: OrphanedProject[];
};

/**
 * A single reconciliation decision (§5.1/§5.2), independent of how it gets executed. plan.ts
 * only ever decides WHAT to do; apply.ts (next commit) fetches whatever extra content a given
 * action needs and calls the clients.
 */
export type Action =
  | { kind: 'create_project'; issue: LinearIssueSummary }
  | { kind: 'recreate_project'; issue: LinearIssueSummary; previousProjectUrl: string }
  | { kind: 'unarchive_project'; project: TodoistProjectSummary; issue: LinearIssueSummary }
  /**
   * Brings a project's mutable fields back in line with Linear - the name (§5.1) and the color
   * its state implies (colors design §5). One action rather than two because `updateProject`
   * takes both in a single call, so a rename that also changes color must not cost two writes.
   * Only the fields that actually diverged are present; planning never emits this with neither.
   */
  | {
      kind: 'update_project';
      project: TodoistProjectSummary;
      issue: LinearIssueSummary;
      name?: string;
      color?: ColorKey;
    }
  | { kind: 'reattach_card'; issue: LinearIssueSummary; project: TodoistProjectSummary }
  | {
      kind: 'refresh_card';
      attachment: LinearAttachmentSummary;
      project: TodoistProjectSummary;
      issue: LinearIssueSummary;
    }
  | {
      kind: 'archive_project';
      project: TodoistProjectSummary;
      linkedIssueId: string;
      /** Carries the watermark when the linked issue no longer holds its own card (§5.5). */
      displacedCard: LinearAttachmentSummary | null;
    }
  | { kind: 'mark_lost'; project: TodoistProjectSummary }
  | {
      kind: 'delete_stray_cards';
      issue: LinearIssueSummary;
      attachments: LinearAttachmentSummary[];
    };
