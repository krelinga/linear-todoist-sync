import { afterEach, describe, expect, it, vi } from 'vitest';
import { TodoistClient } from '../../src/clients/todoist.js';
import type {
  RawProject,
  RawProjectPage,
  RawTask,
  TodoistSdkClient,
} from '../../src/clients/todoist.js';
import { createMetrics } from '../../src/metrics.js';
import { logger } from '../../src/logger.js';

vi.mock('../../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  vi.clearAllMocks();
});

function rawProject(overrides: Partial<RawProject> = {}): RawProject {
  return {
    id: 'proj-1',
    name: '[ENG-1] Fix the thing',
    url: 'https://todoist.com/showProject?id=proj-1',
    description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-1',
    isArchived: false,
    ...overrides,
  };
}

function fakeSdk(overrides: Partial<TodoistSdkClient> = {}): TodoistSdkClient {
  return {
    getProjects: vi.fn().mockResolvedValue({ results: [], nextCursor: null }),
    getArchivedProjects: vi.fn().mockResolvedValue({ results: [], nextCursor: null }),
    addProject: vi.fn(),
    updateProject: vi.fn(),
    archiveProject: vi.fn(),
    unarchiveProject: vi.fn(),
    getFullProject: vi.fn(),
    getCompletedTasksByCompletionDate: vi.fn(),
    addComment: vi.fn(),
    ...overrides,
  };
}

describe('TodoistClient', () => {
  describe('getMarkedProjects', () => {
    it('filters active and archived projects by the marker prefix, ignoring unrelated ones', async () => {
      const marked = rawProject();
      const unrelated = rawProject({ id: 'proj-2', description: 'Just a normal project' });
      const archivedMarked = rawProject({
        id: 'proj-3',
        isArchived: true,
        description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-2',
      });
      const sdk = fakeSdk({
        getProjects: vi.fn().mockResolvedValue({ results: [marked, unrelated], nextCursor: null }),
        getArchivedProjects: vi.fn().mockResolvedValue({ results: [archivedMarked], nextCursor: null }),
      });
      const client = new TodoistClient(sdk);
      const result = await client.getMarkedProjects();
      expect(result.map((p) => p.id)).toEqual(['proj-1', 'proj-3']);
    });

    it('ignores a description that looks like the marker but does not match it exactly', async () => {
      // A similarly-worded description for another tool's integration (or the marker text
      // appearing mid-description rather than as a prefix) must never be treated as this
      // service's own project - only an exact-prefix match may ever be acted on.
      const lookalikePrefix = rawProject({
        id: 'proj-lookalike',
        description: 'Linked Jira issue: https://example.atlassian.net/browse/HOME-1',
      });
      const markerNotAtStart = rawProject({
        id: 'proj-embedded',
        description: 'See also: Linked Linear issue: https://linear.app/acme/issue/ENG-9',
      });
      const sdk = fakeSdk({
        getProjects: vi
          .fn()
          .mockResolvedValue({ results: [lookalikePrefix, markerNotAtStart], nextCursor: null }),
      });
      const client = new TodoistClient(sdk);
      const result = await client.getMarkedProjects();
      expect(result).toEqual([]);
    });

    it('paginates through multiple pages of both active and archived projects', async () => {
      const getProjects = vi
        .fn()
        .mockResolvedValueOnce({ results: [rawProject({ id: 'a' })], nextCursor: 'cursor-1' })
        .mockResolvedValueOnce({ results: [rawProject({ id: 'b' })], nextCursor: null } satisfies RawProjectPage);
      const sdk = fakeSdk({ getProjects });
      const client = new TodoistClient(sdk);
      const result = await client.getMarkedProjects();
      expect(result.map((p) => p.id)).toEqual(['a', 'b']);
      expect(getProjects).toHaveBeenCalledTimes(2);
      expect(getProjects.mock.calls[1]?.[0]).toEqual({ cursor: 'cursor-1' });
    });
  });

  it('createProject forwards name and description', async () => {
    const addProject = vi.fn().mockResolvedValue(rawProject());
    const client = new TodoistClient(fakeSdk({ addProject }));
    const result = await client.createProject({
      name: '[ENG-1] Fix the thing',
      description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-1',
    });
    expect(addProject).toHaveBeenCalledWith({
      name: '[ENG-1] Fix the thing',
      description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-1',
    });
    expect(result.id).toBe('proj-1');
    expect(logger.info).toHaveBeenCalledWith(
      'Created Todoist project',
      expect.objectContaining({ system: 'todoist', projectId: 'proj-1', name: '[ENG-1] Fix the thing' }),
    );
  });

  it('updateProject, archiveProject, and unarchiveProject forward to the SDK and log each write', async () => {
    const updateProject = vi.fn().mockResolvedValue(rawProject());
    const archiveProject = vi.fn().mockResolvedValue(rawProject());
    const unarchiveProject = vi.fn().mockResolvedValue(rawProject());
    const client = new TodoistClient(fakeSdk({ updateProject, archiveProject, unarchiveProject }));

    await client.updateProject('proj-1', { name: 'New name' });
    expect(updateProject).toHaveBeenCalledWith('proj-1', { name: 'New name' });
    expect(logger.info).toHaveBeenCalledWith(
      'Updated Todoist project',
      expect.objectContaining({ system: 'todoist', projectId: 'proj-1', name: 'New name' }),
    );

    await client.archiveProject('proj-1');
    expect(archiveProject).toHaveBeenCalledWith('proj-1');
    expect(logger.info).toHaveBeenCalledWith(
      'Archived Todoist project',
      expect.objectContaining({ system: 'todoist', projectId: 'proj-1' }),
    );

    await client.unarchiveProject('proj-1');
    expect(unarchiveProject).toHaveBeenCalledWith('proj-1');
    expect(logger.info).toHaveBeenCalledWith(
      'Unarchived Todoist project',
      expect.objectContaining({ system: 'todoist', projectId: 'proj-1' }),
    );
  });

  describe('getOutstandingTasks', () => {
    it('maps tasks and sorts sections by sectionOrder', async () => {
      const getFullProject = vi.fn().mockResolvedValue({
        tasks: [{ id: 't1', content: 'Do the thing', sectionId: 'sec-2', completedAt: null }],
        sections: [
          { id: 'sec-2', name: 'Backend', sectionOrder: 2 },
          { id: 'sec-1', name: 'Frontend', sectionOrder: 1 },
        ],
      });
      const client = new TodoistClient(fakeSdk({ getFullProject }));
      const result = await client.getOutstandingTasks('proj-1');
      expect(result.tasks).toEqual([{ id: 't1', content: 'Do the thing', sectionId: 'sec-2' }]);
      expect(result.sections.map((s) => s.name)).toEqual(['Frontend', 'Backend']);
    });
  });

  describe('getCompletedTasksSince', () => {
    it('paginates and maps completedAt to an ISO string', async () => {
      const task: RawTask = {
        id: 't1',
        content: 'Done thing',
        sectionId: null,
        completedAt: new Date('2026-08-09T12:00:00.000Z'),
      };
      const getCompletedTasksByCompletionDate = vi
        .fn()
        .mockResolvedValueOnce({ items: [task], nextCursor: 'cursor-1' })
        .mockResolvedValueOnce({ items: [], nextCursor: null });
      const client = new TodoistClient(fakeSdk({ getCompletedTasksByCompletionDate }));
      const result = await client.getCompletedTasksSince('proj-1', '2026-08-01T00:00:00.000Z');
      expect(result).toEqual([
        { content: 'Done thing', completedAt: '2026-08-09T12:00:00.000Z', sectionId: null },
      ]);
      expect(getCompletedTasksByCompletionDate).toHaveBeenCalledTimes(2);
      expect(getCompletedTasksByCompletionDate.mock.calls[0]?.[0]).toMatchObject({
        projectId: 'proj-1',
        since: '2026-08-01T00:00:00.000Z',
      });
    });
  });

  it('addProjectComment forwards projectId and content, and logs a preview of the write', async () => {
    const addComment = vi.fn().mockResolvedValue({});
    const client = new TodoistClient(fakeSdk({ addComment }));
    await client.addProjectComment('proj-1', 'hello');
    expect(addComment).toHaveBeenCalledWith({ projectId: 'proj-1', content: 'hello' });
    expect(logger.info).toHaveBeenCalledWith(
      'Posted Todoist comment',
      expect.objectContaining({ system: 'todoist', projectId: 'proj-1', contentPreview: 'hello' }),
    );
  });

  it('truncates a long comment body in the log preview', async () => {
    const addComment = vi.fn().mockResolvedValue({});
    const client = new TodoistClient(fakeSdk({ addComment }));
    const longContent = 'x'.repeat(200);
    await client.addProjectComment('proj-1', longContent);
    const fields = vi.mocked(logger.info).mock.calls[0]?.[1] as { contentPreview: string };
    expect(fields.contentPreview.length).toBe(121); // 120 chars + the ellipsis marker
    expect(fields.contentPreview.endsWith('…')).toBe(true);
  });

  it('records API request metrics on success and failure', async () => {
    const metrics = createMetrics();
    const archiveProject = vi
      .fn()
      .mockResolvedValueOnce(rawProject())
      .mockRejectedValueOnce({ status: 404 });
    const client = new TodoistClient(fakeSdk({ archiveProject }), metrics);
    await client.archiveProject('proj-1');
    await expect(client.archiveProject('proj-2')).rejects.toBeDefined();
    const counts = await metrics.apiRequestsTotal.get();
    expect(counts.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labels: { service: 'todoist', result: 'success' }, value: 1 }),
        expect.objectContaining({ labels: { service: 'todoist', result: 'error' }, value: 1 }),
      ]),
    );
  });
});
