/** A Linear issue, normalized to the fields this service actually needs. */
export type LinearIssueSummary = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  stateType: string;
  updatedAt: string;
};

/** The marker attachment (§5.4/§6.1) this service creates on an issue's Linear page. */
export type LinearAttachmentSummary = {
  id: string;
  url: string;
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
};

export type UpdateProjectInput = {
  name?: string;
  description?: string;
};

/** A started Linear issue paired with whatever this service already knows about it (§5 step 3). */
export type IssueMapping = {
  issue: LinearIssueSummary;
  /** Found by matching the issue's URL against a marked Todoist project's description (§5.4). */
  matchedProject: TodoistProjectSummary | null;
  /** This service's own marker attachment on the issue, if one currently exists (§5.4). */
  attachment: LinearAttachmentSummary | null;
};

/** A marked Todoist project with no started Linear issue currently pointing at it (§5.1/§5.2). */
export type OrphanedProject = {
  project: TodoistProjectSummary;
  /** The linked issue's current state, or null if that issue no longer exists at all. */
  linkedIssue: LinearIssueSummary | null;
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
  | { kind: 'rename_project'; project: TodoistProjectSummary; issue: LinearIssueSummary }
  | { kind: 'reattach_card'; issue: LinearIssueSummary; project: TodoistProjectSummary }
  | {
      kind: 'refresh_card';
      attachment: LinearAttachmentSummary;
      project: TodoistProjectSummary;
      issue: LinearIssueSummary;
    }
  | { kind: 'archive_project'; project: TodoistProjectSummary; linkedIssueId: string }
  | { kind: 'mark_lost'; project: TodoistProjectSummary };
