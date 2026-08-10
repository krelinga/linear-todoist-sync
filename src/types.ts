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
