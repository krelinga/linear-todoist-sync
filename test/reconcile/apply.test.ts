import { describe, expect, it, vi } from 'vitest';
import { applyActions } from '../../src/reconcile/apply.js';
import { createMetrics } from '../../src/metrics.js';
import type { LinearPort } from '../../src/clients/linear.js';
import type { TodoistPort } from '../../src/clients/todoist.js';
import type {
  Action,
  LinearAttachmentSummary,
  LinearIssueSummary,
  TodoistProjectSummary,
  TodoistTaskSummary,
} from '../../src/types.js';

function issue(overrides: Partial<LinearIssueSummary> = {}): LinearIssueSummary {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Fix the flaky login test',
    url: 'https://linear.app/acme/issue/ENG-1/fix-the-flaky-login-test',
    stateType: 'started',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function project(overrides: Partial<TodoistProjectSummary> = {}): TodoistProjectSummary {
  return {
    id: 'proj-1',
    name: '[ENG-1] Fix the flaky login test',
    url: 'https://todoist.com/showProject?id=proj-1',
    description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-1/fix-the-flaky-login-test',
    isArchived: false,
    ...overrides,
  };
}

function attachment(overrides: Partial<LinearAttachmentSummary> = {}): LinearAttachmentSummary {
  return {
    id: 'att-1',
    url: 'https://todoist.com/showProject?id=proj-1',
    title: '[ENG-1] Fix the flaky login test',
    subtitle: '2 tasks outstanding',
    metadata: { syncApp: 'linear-todoist-sync', schemaVersion: 1 },
    ...overrides,
  };
}

function task(overrides: Partial<TodoistTaskSummary> = {}): TodoistTaskSummary {
  return { id: 't1', content: 'Do the thing', sectionId: null, ...overrides };
}

function fakeLinear(overrides: Partial<LinearPort> = {}): LinearPort {
  return {
    getStartedIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue(null),
    getMarkerAttachment: vi.fn().mockResolvedValue(null),
    createAttachment: vi.fn().mockResolvedValue(attachment()),
    updateAttachment: vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeTodoist(overrides: Partial<TodoistPort> = {}): TodoistPort {
  return {
    getMarkedProjects: vi.fn().mockResolvedValue([]),
    createProject: vi.fn().mockResolvedValue(project()),
    updateProject: vi.fn().mockResolvedValue(undefined),
    archiveProject: vi.fn().mockResolvedValue(undefined),
    unarchiveProject: vi.fn().mockResolvedValue(undefined),
    getOutstandingTasks: vi.fn().mockResolvedValue({ tasks: [], sections: [] }),
    getCompletedTasksSince: vi.fn().mockResolvedValue([]),
    addProjectComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function actionCounts(metrics: ReturnType<typeof createMetrics>) {
  const values = (await metrics.reconcileActionsTotal.get()).values;
  return Object.fromEntries(values.map((v) => [v.labels['action'], v.value]));
}

describe('applyActions', () => {
  it('creates a Todoist project and a linked Linear card for create_project', async () => {
    const linear = fakeLinear();
    const todoist = fakeTodoist({ createProject: vi.fn().mockResolvedValue(project()) });
    const metrics = createMetrics();
    const actions: Action[] = [{ kind: 'create_project', issue: issue() }];

    const result = await applyActions(actions, { linear, todoist, metrics });

    expect(result).toEqual({ succeeded: 1, failed: 0 });
    expect(todoist.createProject).toHaveBeenCalledWith({
      name: '[ENG-1] Fix the flaky login test',
      description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-1/fix-the-flaky-login-test',
    });
    expect(linear.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: 'issue-1',
        url: project().url,
        subtitle: '0 tasks outstanding',
        metadata: { syncApp: 'linear-todoist-sync', schemaVersion: 1 },
      }),
    );
    expect(await actionCounts(metrics)).toEqual({ project_created: 1 });
  });

  it('recreates a deleted project and posts a Linear comment noting the swap', async () => {
    const linear = fakeLinear();
    const todoist = fakeTodoist();
    const metrics = createMetrics();
    const actions: Action[] = [
      { kind: 'recreate_project', issue: issue(), previousProjectUrl: 'https://todoist.com/showProject?id=old' },
    ];

    await applyActions(actions, { linear, todoist, metrics });

    expect(todoist.createProject).toHaveBeenCalled();
    expect(linear.createAttachment).toHaveBeenCalled();
    expect(linear.createComment).toHaveBeenCalledWith(
      'issue-1',
      expect.stringContaining('https://todoist.com/showProject?id=old'),
    );
    expect(await actionCounts(metrics)).toEqual({ project_recreated: 1, comment_posted: 1 });
  });

  describe('unarchive_project', () => {
    it('unarchives and refreshes an existing card with a fresh count', async () => {
      const linear = fakeLinear({
        getMarkerAttachment: vi.fn().mockResolvedValue(attachment({ subtitle: '0 tasks outstanding' })),
      });
      const todoist = fakeTodoist({
        getOutstandingTasks: vi.fn().mockResolvedValue({ tasks: [task()], sections: [] }),
      });
      const metrics = createMetrics();
      const actions: Action[] = [{ kind: 'unarchive_project', project: project(), issue: issue() }];

      await applyActions(actions, { linear, todoist, metrics });

      expect(todoist.unarchiveProject).toHaveBeenCalledWith('proj-1');
      expect(linear.updateAttachment).toHaveBeenCalledWith(
        'att-1',
        expect.objectContaining({ subtitle: '1 task outstanding' }),
      );
      expect(await actionCounts(metrics)).toEqual({ project_unarchived: 1, card_updated: 1 });
    });

    it('self-heals by creating a card when none exists after unarchiving', async () => {
      const linear = fakeLinear({ getMarkerAttachment: vi.fn().mockResolvedValue(null) });
      const todoist = fakeTodoist();
      const metrics = createMetrics();
      const actions: Action[] = [{ kind: 'unarchive_project', project: project(), issue: issue() }];

      await applyActions(actions, { linear, todoist, metrics });

      expect(linear.createAttachment).toHaveBeenCalled();
      expect(await actionCounts(metrics)).toEqual({ project_unarchived: 1, card_reattached: 1 });
    });
  });

  it('renames the Todoist project for rename_project', async () => {
    const linear = fakeLinear();
    const todoist = fakeTodoist();
    const metrics = createMetrics();
    const actions: Action[] = [{ kind: 'rename_project', project: project(), issue: issue() }];

    await applyActions(actions, { linear, todoist, metrics });

    expect(todoist.updateProject).toHaveBeenCalledWith('proj-1', {
      name: '[ENG-1] Fix the flaky login test',
    });
    expect(await actionCounts(metrics)).toEqual({ project_renamed: 1 });
  });

  it('creates a card with a fresh count for reattach_card', async () => {
    const linear = fakeLinear();
    const todoist = fakeTodoist({
      getOutstandingTasks: vi.fn().mockResolvedValue({ tasks: [task(), task({ id: 't2' })], sections: [] }),
    });
    const metrics = createMetrics();
    const actions: Action[] = [{ kind: 'reattach_card', issue: issue(), project: project() }];

    await applyActions(actions, { linear, todoist, metrics });

    expect(linear.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ subtitle: '2 tasks outstanding' }),
    );
    expect(await actionCounts(metrics)).toEqual({ card_reattached: 1 });
  });

  describe('refresh_card', () => {
    it('updates the card when the live count differs from the stored subtitle', async () => {
      const linear = fakeLinear();
      const todoist = fakeTodoist({
        getOutstandingTasks: vi.fn().mockResolvedValue({ tasks: [task()], sections: [] }),
      });
      const metrics = createMetrics();
      const staleAttachment = attachment({ subtitle: '5 tasks outstanding' });
      const actions: Action[] = [
        { kind: 'refresh_card', attachment: staleAttachment, project: project(), issue: issue() },
      ];

      await applyActions(actions, { linear, todoist, metrics });

      expect(linear.updateAttachment).toHaveBeenCalledWith('att-1', {
        title: '[ENG-1] Fix the flaky login test',
        subtitle: '1 task outstanding',
        metadata: staleAttachment.metadata,
      });
      expect(await actionCounts(metrics)).toEqual({ card_updated: 1 });
    });

    it('is a no-op when the card already matches the live count and title', async () => {
      const linear = fakeLinear();
      const todoist = fakeTodoist({
        getOutstandingTasks: vi.fn().mockResolvedValue({ tasks: [task()], sections: [] }),
      });
      const metrics = createMetrics();
      const upToDate = attachment({ subtitle: '1 task outstanding' });
      const actions: Action[] = [
        { kind: 'refresh_card', attachment: upToDate, project: project(), issue: issue() },
      ];

      await applyActions(actions, { linear, todoist, metrics });

      expect(linear.updateAttachment).not.toHaveBeenCalled();
      expect(await actionCounts(metrics)).toEqual({});
    });
  });

  describe('archive_project', () => {
    it('posts a comment, archives, and freezes the card when tasks are outstanding', async () => {
      const linear = fakeLinear({ getMarkerAttachment: vi.fn().mockResolvedValue(attachment()) });
      const todoist = fakeTodoist({
        getOutstandingTasks: vi.fn().mockResolvedValue({
          tasks: [task({ content: 'Task A' }), task({ id: 't2', content: 'Task B' })],
          sections: [],
        }),
      });
      const metrics = createMetrics();
      const actions: Action[] = [{ kind: 'archive_project', project: project(), linkedIssueId: 'issue-1' }];

      await applyActions(actions, { linear, todoist, metrics });

      expect(todoist.addProjectComment).toHaveBeenCalledWith(
        'proj-1',
        expect.stringContaining('Task A'),
      );
      expect(todoist.addProjectComment).toHaveBeenCalledWith(
        'proj-1',
        expect.stringContaining('Task B'),
      );
      expect(todoist.archiveProject).toHaveBeenCalledWith('proj-1');
      expect(linear.updateAttachment).toHaveBeenCalledWith('att-1', {
        title: attachment().title,
        subtitle: 'Archived — 2 tasks were outstanding',
        metadata: attachment().metadata,
      });
      expect(await actionCounts(metrics)).toEqual({
        comment_posted: 1,
        project_archived: 1,
        card_updated: 1,
      });
    });

    it('skips the comment when there are no outstanding tasks', async () => {
      const linear = fakeLinear({ getMarkerAttachment: vi.fn().mockResolvedValue(attachment()) });
      const todoist = fakeTodoist();
      const metrics = createMetrics();
      const actions: Action[] = [{ kind: 'archive_project', project: project(), linkedIssueId: 'issue-1' }];

      await applyActions(actions, { linear, todoist, metrics });

      expect(todoist.addProjectComment).not.toHaveBeenCalled();
      expect(await actionCounts(metrics)).toEqual({ project_archived: 1, card_updated: 1 });
    });

    it('skips freezing the card when no attachment is found', async () => {
      const linear = fakeLinear({ getMarkerAttachment: vi.fn().mockResolvedValue(null) });
      const todoist = fakeTodoist();
      const metrics = createMetrics();
      const actions: Action[] = [{ kind: 'archive_project', project: project(), linkedIssueId: 'issue-1' }];

      await applyActions(actions, { linear, todoist, metrics });

      expect(linear.updateAttachment).not.toHaveBeenCalled();
      expect(await actionCounts(metrics)).toEqual({ project_archived: 1 });
    });
  });

  it('renames with the [LOST] prefix for mark_lost', async () => {
    const linear = fakeLinear();
    const todoist = fakeTodoist();
    const metrics = createMetrics();
    const actions: Action[] = [{ kind: 'mark_lost', project: project() }];

    await applyActions(actions, { linear, todoist, metrics });

    expect(todoist.updateProject).toHaveBeenCalledWith('proj-1', {
      name: '[LOST] [ENG-1] Fix the flaky login test',
    });
    expect(await actionCounts(metrics)).toEqual({ project_marked_lost: 1 });
  });

  it('keeps processing remaining actions after one fails, and reports the split', async () => {
    const linear = fakeLinear();
    const todoist = fakeTodoist({
      updateProject: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined),
    });
    const metrics = createMetrics();
    const actions: Action[] = [
      { kind: 'rename_project', project: project({ id: 'proj-fail' }), issue: issue() },
      { kind: 'mark_lost', project: project({ id: 'proj-ok' }) },
    ];

    const result = await applyActions(actions, { linear, todoist, metrics });

    expect(result).toEqual({ succeeded: 1, failed: 1 });
    expect(todoist.updateProject).toHaveBeenCalledTimes(2);
  });
});
