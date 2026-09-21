import { describe, expect, it, vi } from 'vitest';
import { discover } from '../../src/reconcile/discover.js';
import { errorFields } from '../../src/errors.js';
import type { LinearPort } from '../../src/clients/linear.js';
import type { TodoistPort } from '../../src/clients/todoist.js';
import type {
  LinearAttachmentSummary,
  LinearIssueSummary,
  TodoistProjectSummary,
} from '../../src/types.js';

function issue(overrides: Partial<LinearIssueSummary> = {}): LinearIssueSummary {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Fix the thing',
    url: 'https://linear.app/acme/issue/ENG-1/fix-the-thing',
    stateType: 'started',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function project(overrides: Partial<TodoistProjectSummary> = {}): TodoistProjectSummary {
  return {
    id: 'proj-1',
    name: '[ENG-1] Fix the thing',
    url: 'https://todoist.com/showProject?id=proj-1',
    description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-1/fix-the-thing',
    isArchived: false,
    ...overrides,
  };
}

function attachment(overrides: Partial<LinearAttachmentSummary> = {}): LinearAttachmentSummary {
  return {
    id: 'att-1',
    url: 'https://todoist.com/showProject?id=proj-1',
    title: '[ENG-1] Fix the thing',
    subtitle: '2 tasks outstanding',
    metadata: { syncApp: 'linear-todoist-sync', schemaVersion: 1 },
    ...overrides,
  };
}

function fakeLinear(overrides: Partial<LinearPort> = {}): LinearPort {
  return {
    getStartedIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue(null),
    getMarkerAttachments: vi.fn().mockResolvedValue([]),
    createAttachment: vi.fn(),
    updateAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    createComment: vi.fn(),
    ...overrides,
  };
}

function fakeTodoist(overrides: Partial<TodoistPort> = {}): TodoistPort {
  return {
    getMarkedProjects: vi.fn().mockResolvedValue([]),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    archiveProject: vi.fn(),
    unarchiveProject: vi.fn(),
    getOutstandingTasks: vi.fn(),
    getCompletedTasksSince: vi.fn(),
    addProjectComment: vi.fn(),
    ...overrides,
  };
}

describe('discover', () => {
  it('matches a started issue to its project via the description URL, and finds its attachment', async () => {
    const linear = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([issue()]),
      getMarkerAttachments: vi.fn().mockResolvedValue([attachment()]),
    });
    const todoist = fakeTodoist({ getMarkedProjects: vi.fn().mockResolvedValue([project()]) });

    const snapshot = await discover(linear, todoist);

    expect(snapshot.mappings).toEqual([
      { issue: issue(), matchedProject: project(), attachment: attachment(), strayAttachments: [] },
    ]);
    expect(snapshot.orphans).toEqual([]);
  });

  it('still matches after a title change moves the issue URL slug (project keeps the stale slug)', async () => {
    const renamedIssue = issue({
      title: 'Renamed title',
      url: 'https://linear.app/acme/issue/ENG-1/renamed-title',
    });
    const linear = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([renamedIssue]),
      getMarkerAttachments: vi.fn().mockResolvedValue([attachment()]),
    });
    // Project's description still has the URL captured at creation time, with the old slug.
    const todoist = fakeTodoist({ getMarkedProjects: vi.fn().mockResolvedValue([project()]) });

    const snapshot = await discover(linear, todoist);

    expect(snapshot.mappings[0]?.matchedProject).toEqual(project());
    expect(snapshot.orphans).toEqual([]);
  });

  it('leaves matchedProject and attachment null for a brand-new started issue', async () => {
    const linear = fakeLinear({ getStartedIssues: vi.fn().mockResolvedValue([issue()]) });
    const todoist = fakeTodoist();

    const snapshot = await discover(linear, todoist);

    expect(snapshot.mappings).toEqual([
      { issue: issue(), matchedProject: null, attachment: null, strayAttachments: [] },
    ]);
  });

  it('surfaces an existing attachment even when no marked project currently matches it (deleted-outright case)', async () => {
    const linear = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([issue()]),
      getMarkerAttachments: vi.fn().mockResolvedValue([attachment()]),
    });
    const todoist = fakeTodoist();

    const snapshot = await discover(linear, todoist);

    expect(snapshot.mappings[0]?.matchedProject).toBeNull();
    expect(snapshot.mappings[0]?.attachment).toEqual(attachment());
  });

  it('resolves an orphaned active project to its still-existing, non-started issue', async () => {
    const orphanProject = project({ id: 'proj-2' });
    const linear = fakeLinear({
      getIssue: vi.fn().mockResolvedValue(issue({ stateType: 'completed' })),
    });
    const todoist = fakeTodoist({ getMarkedProjects: vi.fn().mockResolvedValue([orphanProject]) });

    const snapshot = await discover(linear, todoist);

    expect(snapshot.orphans).toEqual([
      { project: orphanProject, linkedIssue: issue({ stateType: 'completed' }) },
    ]);
    expect(linear.getIssue).toHaveBeenCalledWith('ENG-1');
  });

  it('resolves an orphaned project whose issue was deleted outright to a null linkedIssue', async () => {
    const orphanProject = project({ id: 'proj-2' });
    const linear = fakeLinear({ getIssue: vi.fn().mockResolvedValue(null) });
    const todoist = fakeTodoist({ getMarkedProjects: vi.fn().mockResolvedValue([orphanProject]) });

    const snapshot = await discover(linear, todoist);

    expect(snapshot.orphans).toEqual([{ project: orphanProject, linkedIssue: null }]);
  });

  it('does not look up an issue for an orphan whose description has no parseable marker URL', async () => {
    const malformed = project({ id: 'proj-2', description: 'Linked Linear issue: ' });
    const linear = fakeLinear();
    const todoist = fakeTodoist({ getMarkedProjects: vi.fn().mockResolvedValue([malformed]) });

    const snapshot = await discover(linear, todoist);

    expect(snapshot.orphans).toEqual([{ project: malformed, linkedIssue: null }]);
    expect(linear.getIssue).not.toHaveBeenCalled();
  });

  it('treats a project as orphaned only when no started issue matches it, even among several projects', async () => {
    const matched = project({ id: 'proj-1' });
    const other = project({
      id: 'proj-2',
      description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-9/other',
    });
    const linear = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([issue()]),
      getMarkerAttachments: vi.fn().mockResolvedValue([]),
      getIssue: vi.fn().mockResolvedValue(null),
    });
    const todoist = fakeTodoist({
      getMarkedProjects: vi.fn().mockResolvedValue([matched, other]),
    });

    const snapshot = await discover(linear, todoist);

    expect(snapshot.mappings[0]?.matchedProject).toEqual(matched);
    expect(snapshot.orphans).toEqual([{ project: other, linkedIssue: null }]);
  });

  describe('error context', () => {
    it("names the project and the issue when an orphan's linked issue lookup fails", async () => {
      const orphanProject = project({
        id: 'proj-7',
        name: '[ENG-9] Other thing',
        description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-9/other-thing',
      });
      const linear = fakeLinear({
        getIssue: vi
          .fn()
          .mockRejectedValue(
            new Error('Entity not found: Issue - Could not find referenced Issue.'),
          ),
      });
      const todoist = fakeTodoist({
        getMarkedProjects: vi.fn().mockResolvedValue([orphanProject]),
      });

      const err = await discover(linear, todoist).catch((e: unknown) => e);

      expect(errorMessageOf(err)).toContain('Entity not found: Issue');
      expect(errorFields(err)).toMatchObject({
        phase: 'discover',
        todoistProject: '[ENG-9] Other thing',
        todoistProjectId: 'proj-7',
        linkedIssue: 'ENG-9',
        linkedIssueUrl: 'https://linear.app/acme/issue/ENG-9/other-thing',
      });
    });

    it('names the issue when reading its attachment card fails', async () => {
      const linear = fakeLinear({
        getStartedIssues: vi.fn().mockResolvedValue([issue()]),
        getMarkerAttachments: vi.fn().mockRejectedValue(new Error('503 Service Unavailable')),
      });

      const err = await discover(linear, fakeTodoist()).catch((e: unknown) => e);

      expect(errorFields(err)).toMatchObject({
        phase: 'discover',
        issue: 'ENG-1',
        issueId: 'issue-1',
      });
    });

    it('says which of the two listings failed', async () => {
      const linear = fakeLinear({
        getStartedIssues: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
      });

      const err = await discover(linear, fakeTodoist()).catch((e: unknown) => e);

      expect(errorMessageOf(err)).toBe(
        'Failed to list started Linear issues (phase=discover): 401 Unauthorized',
      );
    });
  });

  describe('an issue holding more than one marker card (#1)', () => {
    // Marking B a duplicate of A moves B's card onto A, ahead of A's own in Linear's ordering.
    const own = attachment({ id: 'att-own', url: project().url });
    const moved = attachment({ id: 'att-moved', url: 'https://todoist.com/showProject?id=proj-B' });

    it("keeps the card pointing at the issue's own project, not the first one", async () => {
      const linear = fakeLinear({
        getStartedIssues: vi.fn().mockResolvedValue([issue()]),
        getMarkerAttachments: vi.fn().mockResolvedValue([moved, own]),
      });
      const todoist = fakeTodoist({ getMarkedProjects: vi.fn().mockResolvedValue([project()]) });

      const snapshot = await discover(linear, todoist);

      expect(snapshot.mappings[0]?.attachment?.id).toBe('att-own');
      expect(snapshot.mappings[0]?.strayAttachments.map((a) => a.id)).toEqual(['att-moved']);
    });

    it('reports no strays when the only card is the right one', async () => {
      const linear = fakeLinear({
        getStartedIssues: vi.fn().mockResolvedValue([issue()]),
        getMarkerAttachments: vi.fn().mockResolvedValue([own]),
      });
      const todoist = fakeTodoist({ getMarkedProjects: vi.fn().mockResolvedValue([project()]) });

      const snapshot = await discover(linear, todoist);

      expect(snapshot.mappings[0]?.strayAttachments).toEqual([]);
    });

    it('falls back to the first card when there is no project to compare against', async () => {
      // Nothing distinguishes them here; planning will recreate the project, and the next
      // cycle matches the fresh card by URL.
      const linear = fakeLinear({
        getStartedIssues: vi.fn().mockResolvedValue([issue()]),
        getMarkerAttachments: vi.fn().mockResolvedValue([moved, own]),
      });

      const snapshot = await discover(linear, fakeTodoist());

      expect(snapshot.mappings[0]?.attachment?.id).toBe('att-moved');
      expect(snapshot.mappings[0]?.strayAttachments.map((a) => a.id)).toEqual(['att-own']);
    });
  });
});

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
