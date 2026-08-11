import { extractHttpStatus, httpRetryClassifier, withRetry } from '../retry.js';
import { isMarkerAttachment } from '../naming.js';
import { logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import type {
  CreateAttachmentInput,
  LinearAttachmentSummary,
  LinearIssueSummary,
  UpdateAttachmentInput,
} from '../types.js';

// --- Minimal structural shapes of the parts of @linear/sdk this service reads. Kept narrow
// and separate from the SDK's own classes so a plain fake object can implement them in tests;
// a real `LinearClient` instance from @linear/sdk satisfies this interface structurally. ---

export interface RawWorkflowState {
  type: string;
}

export interface RawAttachment {
  id: string;
  url: string;
  title: string;
  subtitle?: string | null;
  metadata: Record<string, unknown>;
}

export interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  updatedAt: Date;
  state: Promise<RawWorkflowState> | undefined;
  attachments(): Promise<{ nodes: RawAttachment[] }>;
}

export interface RawConnection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

export interface RawAttachmentPayload {
  attachment: Promise<RawAttachment> | undefined;
}

/** Only the filter shape this service actually constructs (a subset of Linear's IssueFilter). */
export type IssueStateTypeFilter = { state: { type: { eq: string } } };

export interface LinearSdkClient {
  issues(variables: {
    filter?: IssueStateTypeFilter;
    after?: string;
  }): Promise<RawConnection<RawIssue>>;
  issue(id: string): Promise<RawIssue>;
  createAttachment(input: Record<string, unknown>): Promise<RawAttachmentPayload>;
  updateAttachment(id: string, input: Record<string, unknown>): Promise<unknown>;
  createComment(input: Record<string, unknown>): Promise<unknown>;
}

export interface LinearPort {
  getStartedIssues(): Promise<LinearIssueSummary[]>;
  getIssue(id: string): Promise<LinearIssueSummary | null>;
  getMarkerAttachment(issueId: string): Promise<LinearAttachmentSummary | null>;
  createAttachment(input: CreateAttachmentInput): Promise<LinearAttachmentSummary>;
  updateAttachment(id: string, input: UpdateAttachmentInput): Promise<void>;
  createComment(issueId: string, body: string): Promise<void>;
}

function toSummary(issue: RawIssue, stateType: string): LinearIssueSummary {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    stateType,
    updatedAt: issue.updatedAt.toISOString(),
  };
}

/** Keeps log lines scannable when a comment body (e.g. a full digest) is long. */
function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function toAttachmentSummary(attachment: RawAttachment): LinearAttachmentSummary {
  return {
    id: attachment.id,
    url: attachment.url,
    title: attachment.title,
    subtitle: attachment.subtitle ?? null,
    metadata: attachment.metadata,
  };
}

export class LinearClient implements LinearPort {
  constructor(
    private readonly sdk: LinearSdkClient,
    private readonly metrics?: Metrics,
  ) {}

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    const stopTimer = this.metrics?.apiRequestDurationSeconds.startTimer({ service: 'linear' });
    try {
      const result = await withRetry(fn, { classify: httpRetryClassifier });
      this.metrics?.apiRequestsTotal.inc({ service: 'linear', result: 'success' });
      return result;
    } catch (err) {
      const status = extractHttpStatus(err);
      this.metrics?.apiRequestsTotal.inc({
        service: 'linear',
        result: status === 429 ? 'rate_limited' : 'error',
      });
      throw err;
    } finally {
      stopTimer?.();
    }
  }

  private async resolveStateType(issue: RawIssue): Promise<string> {
    const state = await issue.state;
    return state?.type ?? 'unknown';
  }

  async getStartedIssues(): Promise<LinearIssueSummary[]> {
    const issues: RawIssue[] = [];
    let after: string | undefined;
    for (;;) {
      const variables: { filter?: IssueStateTypeFilter; after?: string } = {
        filter: { state: { type: { eq: 'started' } } },
      };
      if (after !== undefined) {
        variables.after = after;
      }
      const page = await this.call(() => this.sdk.issues(variables));
      issues.push(...page.nodes);
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) {
        break;
      }
      after = page.pageInfo.endCursor;
    }
    return Promise.all(
      issues.map(async (issue) => toSummary(issue, await this.resolveStateType(issue))),
    );
  }

  async getIssue(id: string): Promise<LinearIssueSummary | null> {
    const issue = await this.getIssueRaw(id);
    return issue ? toSummary(issue, await this.resolveStateType(issue)) : null;
  }

  async getMarkerAttachment(issueId: string): Promise<LinearAttachmentSummary | null> {
    const issue = await this.getIssueRaw(issueId);
    if (!issue) {
      return null;
    }
    const { nodes } = await this.call(() => issue.attachments());
    const marker = nodes.find((attachment) => isMarkerAttachment(attachment.metadata));
    return marker ? toAttachmentSummary(marker) : null;
  }

  private async getIssueRaw(id: string): Promise<RawIssue | null> {
    try {
      return await this.call(() => this.sdk.issue(id));
    } catch (err) {
      const status = extractHttpStatus(err);
      if (status !== undefined && status >= 400 && status < 500) {
        return null;
      }
      throw err;
    }
  }

  async createAttachment(input: CreateAttachmentInput): Promise<LinearAttachmentSummary> {
    const payload = await this.call(() =>
      this.sdk.createAttachment({
        issueId: input.issueId,
        title: input.title,
        url: input.url,
        iconUrl: input.iconUrl,
        subtitle: input.subtitle,
        metadata: input.metadata,
      }),
    );
    const attachment = await payload.attachment;
    if (!attachment) {
      throw new Error(`createAttachment for issue ${input.issueId} returned no attachment`);
    }
    logger.info('Created Linear attachment', {
      system: 'linear',
      issueId: input.issueId,
      title: input.title,
      url: input.url,
    });
    return toAttachmentSummary(attachment);
  }

  async updateAttachment(id: string, input: UpdateAttachmentInput): Promise<void> {
    await this.call(() =>
      this.sdk.updateAttachment(id, {
        title: input.title,
        subtitle: input.subtitle,
        metadata: input.metadata,
      }),
    );
    logger.info('Updated Linear attachment', {
      system: 'linear',
      attachmentId: id,
      title: input.title,
      subtitle: input.subtitle,
    });
  }

  async createComment(issueId: string, body: string): Promise<void> {
    await this.call(() => this.sdk.createComment({ issueId, body }));
    logger.info('Posted Linear comment', {
      system: 'linear',
      issueId,
      bodyPreview: truncate(body, 120),
    });
  }
}
