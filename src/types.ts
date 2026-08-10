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
