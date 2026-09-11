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

export interface RawCompletedTaskPage {
  items: RawTask[];
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
  getCompletedTasksByCompletionDate(args: {
    projectId: string;
    since: string;
    until: string;
    cursor?: string | null;
  }): Promise<RawCompletedTaskPage>;
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

  async getCompletedTasksSince(
    projectId: string,
    sinceIso: string,
  ): Promise<TodoistCompletedTaskSummary[]> {
    const untilIso = new Date().toISOString();
    const completed: RawTask[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: RawCompletedTaskPage = await this.call(
        'getCompletedTasksByCompletionDate',
        { projectId, since: sinceIso, until: untilIso, cursor },
        () =>
          this.sdk.getCompletedTasksByCompletionDate({
            projectId,
            since: sinceIso,
            until: untilIso,
            cursor,
          }),
      );
      completed.push(...page.items);
      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }
    return completed.map((task) => ({
      content: task.content,
      completedAt: (task.completedAt ?? new Date(0)).toISOString(),
      sectionId: task.sectionId,
    }));
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
