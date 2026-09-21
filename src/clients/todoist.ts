import { extractHttpStatus, httpRetryClassifier, withRetry } from '../retry.js';
import { LINKED_ISSUE_MARKER_PREFIX } from '../naming.js';
import { ContextualError, type ErrorContext } from '../errors.js';
import { logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import type {
  CreateProjectInput,
  TodoistCompletedTaskSummary,
  TodoistProjectSummary,
  TodoistSectionSummary,
  TodoistTaskSummary,
  UpdateProjectInput,
} from '../types.js';

// --- Minimal structural shapes of the parts of @doist/todoist-sdk this service reads/writes.
// Kept narrow so a plain fake object can implement them in tests; a real TodoistApi instance
// satisfies this interface structurally. ---

export interface RawProject {
  id: string;
  name: string;
  url: string;
  description: string;
  isArchived: boolean;
}

export interface RawTask {
  id: string;
  content: string;
  sectionId: string | null;
  completedAt: Date | null;
}

export interface RawSection {
  id: string;
  name: string;
  sectionOrder: number;
}

export interface RawProjectPage {
  results: RawProject[];
  nextCursor: string | null;
}

/**
 * One entry from Todoist's activity log. `extraData` is a loose bag whose keys depend on the
 * event and on which of the task's fields were set - `sectionId` is present only when the task
 * is in a section, so its absence means "unsectioned" rather than "unknown".
 */
export interface RawActivityEvent {
  objectId: string;
  eventType: string;
  eventDate: Date | string;
  extraData?: Record<string, unknown> | null;
}

export interface RawActivityPage {
  results: RawActivityEvent[];
  nextCursor: string | null;
}

export interface RawFullProject {
  tasks: RawTask[];
  sections: RawSection[];
}

export interface TodoistSdkClient {
  getProjects(args?: { cursor?: string | null }): Promise<RawProjectPage>;
  getArchivedProjects(args?: { cursor?: string | null }): Promise<RawProjectPage>;
  addProject(args: { name: string; description?: string }): Promise<RawProject>;
  updateProject(id: string, args: { name?: string; description?: string }): Promise<RawProject>;
  archiveProject(id: string): Promise<RawProject>;
  unarchiveProject(id: string): Promise<RawProject>;
  getFullProject(id: string): Promise<RawFullProject>;
  getActivityLogs(args: {
    objectEventTypes?: CompletedTaskEvent;
    parentProjectId?: string;
    dateFrom?: string;
    cursor?: string | null;
  }): Promise<RawActivityPage>;
  addComment(args: { projectId: string; content: string }): Promise<unknown>;
}

export interface TodoistPort {
  getMarkedProjects(): Promise<TodoistProjectSummary[]>;
  createProject(input: CreateProjectInput): Promise<TodoistProjectSummary>;
  updateProject(id: string, input: UpdateProjectInput): Promise<void>;
  archiveProject(id: string): Promise<void>;
  unarchiveProject(id: string): Promise<void>;
  getOutstandingTasks(
    projectId: string,
  ): Promise<{ tasks: TodoistTaskSummary[]; sections: TodoistSectionSummary[] }>;
  getCompletedTasksSince(
    projectId: string,
    sinceIso: string,
  ): Promise<TodoistCompletedTaskSummary[]>;
  addProjectComment(projectId: string, content: string): Promise<void>;
}

function toProjectSummary(project: RawProject): TodoistProjectSummary {
  return {
    id: project.id,
    name: project.name,
    url: project.url,
    description: project.description,
    isArchived: project.isArchived,
  };
}

function toTaskSummary(task: RawTask): TodoistTaskSummary {
  return { id: task.id, content: task.content, sectionId: task.sectionId };
}

function toSectionSummary(section: RawSection): TodoistSectionSummary {
  return { id: section.id, name: section.name, order: section.sectionOrder };
}

/**
 * The single activity event the digest cares about. Typed as a literal rather than `string`
 * so this interface stays structurally satisfiable by the real `TodoistApi`, whose
 * `objectEventTypes` is a template-literal union that plain `string` does not fit.
 */
const COMPLETED_TASK_EVENT = 'task:completed';
type CompletedTaskEvent = typeof COMPLETED_TASK_EVENT;

/** `extraData.sectionId` is omitted entirely for an unsectioned task, so absent means null. */
function toSectionId(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** Keeps log lines scannable when a comment body is long. */
function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export class TodoistClient implements TodoistPort {
  constructor(
    private readonly sdk: TodoistSdkClient,
    private readonly metrics?: Metrics,
  ) {}

  /**
   * `operation` and `context` name the REST call and the arguments it was given, so a failure
   * identifies the project it was about rather than only what went wrong (see errors.ts).
   */
  private async call<T>(
    operation: string,
    context: ErrorContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    const stopTimer = this.metrics?.apiRequestDurationSeconds.startTimer({ service: 'todoist' });
    try {
      const result = await withRetry(fn, { classify: httpRetryClassifier });
      this.metrics?.apiRequestsTotal.inc({ service: 'todoist', result: 'success' });
      return result;
    } catch (err) {
      const status = extractHttpStatus(err);
      this.metrics?.apiRequestsTotal.inc({
        service: 'todoist',
        result: status === 429 ? 'rate_limited' : 'error',
      });
      throw new ContextualError(
        'Todoist API request failed',
        { system: 'todoist', operation, ...context, httpStatus: status },
        err,
      );
    } finally {
      stopTimer?.();
    }
  }

  private async fetchAllProjects(
    operation: string,
    fetchPage: (cursor: string | null) => Promise<RawProjectPage>,
  ): Promise<RawProject[]> {
    const projects: RawProject[] = [];
    let cursor: string | null = null;
    for (;;) {
      // Annotated rather than inferred: `cursor` is narrowed by the assignment at the bottom of
      // the loop, and reading it directly in the context argument would make `page`'s inferred
      // type depend on itself.
      const page: RawProjectPage = await this.call(operation, { cursor }, () => fetchPage(cursor));
      projects.push(...page.results);
      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }
    return projects;
  }

  async getMarkedProjects(): Promise<TodoistProjectSummary[]> {
    const [active, archived] = await Promise.all([
      this.fetchAllProjects('getProjects', (cursor) => this.sdk.getProjects({ cursor })),
      this.fetchAllProjects('getArchivedProjects', (cursor) =>
        this.sdk.getArchivedProjects({ cursor }),
      ),
    ]);
    return [...active, ...archived]
      .filter((project) => project.description.startsWith(LINKED_ISSUE_MARKER_PREFIX))
      .map(toProjectSummary);
  }

  async createProject(input: CreateProjectInput): Promise<TodoistProjectSummary> {
    const project = await this.call('addProject', { name: input.name }, () =>
      this.sdk.addProject({ name: input.name, description: input.description }),
    );
    logger.info('Created Todoist project', {
      system: 'todoist',
      projectId: project.id,
      name: project.name,
    });
    return toProjectSummary(project);
  }

  async updateProject(id: string, input: UpdateProjectInput): Promise<void> {
    await this.call('updateProject', { projectId: id, ...input }, () =>
      this.sdk.updateProject(id, input),
    );
    logger.info('Updated Todoist project', { system: 'todoist', projectId: id, ...input });
  }

  async archiveProject(id: string): Promise<void> {
    await this.call('archiveProject', { projectId: id }, () => this.sdk.archiveProject(id));
    logger.info('Archived Todoist project', { system: 'todoist', projectId: id });
  }

  async unarchiveProject(id: string): Promise<void> {
    await this.call('unarchiveProject', { projectId: id }, () => this.sdk.unarchiveProject(id));
    logger.info('Unarchived Todoist project', { system: 'todoist', projectId: id });
  }

  async getOutstandingTasks(
    projectId: string,
  ): Promise<{ tasks: TodoistTaskSummary[]; sections: TodoistSectionSummary[] }> {
    const full = await this.call('getFullProject', { projectId }, () =>
      this.sdk.getFullProject(projectId),
    );
    return {
      tasks: full.tasks.map(toTaskSummary),
      sections: full.sections
        .slice()
        .sort((a, b) => a.sectionOrder - b.sectionOrder)
        .map(toSectionSummary),
    };
  }

  /**
   * Completions reported to the digest (§7), sourced from Todoist's **activity log** rather
   * than its completed-tasks endpoint.
   *
   * Completing a recurring task does not complete anything: Todoist advances the due date and
   * leaves the task open, so it never appears in `getCompletedTasksByCompletionDate` and its
   * completions were silently missing from every digest (#2, verified against a live account -
   * a one-off and a recurring task completed together, and only the one-off came back). The
   * activity log records a `task:completed` event either way, and carries `content`,
   * `eventDate` and `extraData.sectionId`, which is everything the digest formats with.
   *
   * Two properties of this endpoint are load-bearing and neither is documented:
   *
   * - **`dateFrom` only filters precisely when given an ISO timestamp.** A `Date` object or a
   *   `YYYY-MM-DD` string truncates to day granularity, which would re-report everything
   *   already covered by an earlier digest that same day. The client-side `eventDate` filter
   *   below is what actually guarantees the watermark is honoured; sending the timestamp is an
   *   optimisation on top of it, not the correctness mechanism.
   * - **Asking for a window older than the account's activity retention returns 403**, not an
   *   empty page - seven days on the free plan, longer on paid ones, so it cannot be hardcoded.
   *   A 403 therefore falls back to an unbounded query, which returns whatever the plan does
   *   retain and is then filtered client-side. Worse than failing the digest would be reporting
   *   nothing and advancing the watermark past it.
   */
  async getCompletedTasksSince(
    projectId: string,
    sinceIso: string,
  ): Promise<TodoistCompletedTaskSummary[]> {
    const events = await this.fetchCompletionEvents(projectId, sinceIso);
    return events
      .map((event) => ({
        content: String(event.extraData?.['content'] ?? ''),
        completedAt: new Date(event.eventDate).toISOString(),
        sectionId: toSectionId(event.extraData?.['sectionId']),
      }))
      .filter((task) => task.content !== '' && task.completedAt > sinceIso);
  }

  private async fetchCompletionEvents(
    projectId: string,
    sinceIso: string,
  ): Promise<RawActivityEvent[]> {
    try {
      return await this.fetchActivityPages(projectId, sinceIso);
    } catch (err) {
      if (extractHttpStatus(err) !== 403) {
        throw err;
      }
      logger.warn("Activity window predates this account's retention; querying unbounded", {
        system: 'todoist',
        projectId,
        since: sinceIso,
      });
      return this.fetchActivityPages(projectId, undefined);
    }
  }

  private async fetchActivityPages(
    projectId: string,
    sinceIso: string | undefined,
  ): Promise<RawActivityEvent[]> {
    const events: RawActivityEvent[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: RawActivityPage = await this.call(
        'getActivityLogs',
        { projectId, since: sinceIso ?? '(unbounded)', cursor },
        () =>
          this.sdk.getActivityLogs({
            objectEventTypes: COMPLETED_TASK_EVENT,
            parentProjectId: projectId,
            ...(sinceIso === undefined ? {} : { dateFrom: sinceIso }),
            cursor,
          }),
      );
      events.push(...page.results.filter((e) => e.eventType === 'completed'));
      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }
    return events;
  }

  async addProjectComment(projectId: string, content: string): Promise<void> {
    await this.call('addComment', { projectId, contentLength: content.length }, () =>
      this.sdk.addComment({ projectId, content }),
    );
    logger.info('Posted Todoist comment', {
      system: 'todoist',
      projectId,
      contentPreview: truncate(content, 120),
    });
  }
}
