import { describe, expect, it, vi } from 'vitest';
import { runDigestJob } from '../../src/digest/digest.js';
import { createMetrics } from '../../src/metrics.js';
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
    url: 'https://linear.app/acme/issue/ENG-1',
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
    description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-1',
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
    getStartedIssues: vi.fn().mockResolvedValue([issue()]),
    getIssue: vi.fn().mockResolvedValue(null),
    getMarkerAttachment: vi.fn().mockResolvedValue(attachment()),
    createAttachment: vi.fn(),
    updateAttachment: vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeTodoist(overrides: Partial<TodoistPort> = {}): TodoistPort {
  return {
    getMarkedProjects: vi.fn().mockResolvedValue([project()]),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    archiveProject: vi.fn(),
    unarchiveProject: vi.fn(),
    getOutstandingTasks: vi.fn().mockResolvedValue({ tasks: [], sections: [] }),
    getCompletedTasksSince: vi.fn().mockResolvedValue([]),
    addProjectComment: vi.fn(),
    ...overrides,
  };
}

async function gaugeValue(metrics: ReturnType<typeof createMetrics>, name: string) {
  const values = (await metrics.registry.getSingleMetric(name)?.get())?.values ?? [];
  return values[0]?.value;
}

describe('runDigestJob', () => {
  it('posts a comment and advances the watermark when there are completed tasks', async () => {
    const linear = fakeLinear();
    const todoist = fakeTodoist({
      getCompletedTasksSince: vi
        .fn()
        .mockResolvedValue([{ content: 'Done thing', completedAt: '2026-08-09T00:00:00.000Z', sectionId: null }]),
    });
    const metrics = createMetrics();

    await runDigestJob({ linear, todoist, metrics });

    expect(linear.createComment).toHaveBeenCalledWith(
      'issue-1',
      expect.stringContaining('Done thing'),
    );
    expect(linear.updateAttachment).toHaveBeenCalledWith('att-1', {
      title: '[ENG-1] Fix the thing',
      subtitle: '2 tasks outstanding',
      metadata: expect.objectContaining({ syncApp: 'linear-todoist-sync', schemaVersion: 1, lastDigestAt: expect.any(String) }),
    });
    expect((await metrics.digestCommentsPostedTotal.get()).values[0]?.value).toBe(1);
    expect(await gaugeValue(metrics, 'sync_last_digest_result')).toBe(1);
    expect(await gaugeValue(metrics, 'sync_last_digest_run_timestamp_seconds')).toBeGreaterThan(0);
  });

  it('reads since the stored lastDigestAt watermark, not the epoch, when one exists', async () => {
    const linear = fakeLinear({
      getMarkerAttachment: vi
        .fn()
        .mockResolvedValue(attachment({ metadata: { syncApp: 'linear-todoist-sync', schemaVersion: 1, lastDigestAt: '2026-08-08T00:00:00.000Z' } })),
    });
    const getCompletedTasksSince = vi.fn().mockResolvedValue([]);
    const todoist = fakeTodoist({ getCompletedTasksSince });
    const metrics = createMetrics();

    await runDigestJob({ linear, todoist, metrics });

    expect(getCompletedTasksSince).toHaveBeenCalledWith('proj-1', '2026-08-08T00:00:00.000Z');
  });

  it('falls back to a bounded lookback window, not the epoch, when no watermark has ever been recorded', async () => {
    // Todoist's completed-tasks-by-completion-date endpoint rejects since/until spans over 3
    // months - falling back to the true epoch would 400 on every call, forever, since that
    // failure blocks the watermark from ever being written.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-10T00:00:00.000Z'));
      const linear = fakeLinear();
      const getCompletedTasksSince = vi.fn().mockResolvedValue([]);
      const todoist = fakeTodoist({ getCompletedTasksSince });
      const metrics = createMetrics();

      await runDigestJob({ linear, todoist, metrics });

      expect(getCompletedTasksSince).toHaveBeenCalledWith('proj-1', '2026-05-13T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips silently when there is nothing to report - no comment, no metadata write', async () => {
    const linear = fakeLinear();
    const todoist = fakeTodoist({ getCompletedTasksSince: vi.fn().mockResolvedValue([]) });
    const metrics = createMetrics();

    await runDigestJob({ linear, todoist, metrics });

    expect(linear.createComment).not.toHaveBeenCalled();
    expect(linear.updateAttachment).not.toHaveBeenCalled();
    expect((await metrics.digestCommentsPostedTotal.get()).values[0]?.value ?? 0).toBe(0);
  });

  it('skips a mapping with no active project (not started with a project yet)', async () => {
    const linear = fakeLinear();
    const todoist = fakeTodoist({ getMarkedProjects: vi.fn().mockResolvedValue([]) });
    const metrics = createMetrics();

    await runDigestJob({ linear, todoist, metrics });

    expect(linear.createComment).not.toHaveBeenCalled();
    expect(await gaugeValue(metrics, 'sync_last_digest_result')).toBe(1);
  });

  it('skips a mapping with an active project but no card yet, without failing the run', async () => {
    const linear = fakeLinear({ getMarkerAttachment: vi.fn().mockResolvedValue(null) });
    const todoist = fakeTodoist();
    const metrics = createMetrics();

    await runDigestJob({ linear, todoist, metrics });

    expect(linear.createComment).not.toHaveBeenCalled();
    expect(await gaugeValue(metrics, 'sync_last_digest_result')).toBe(1);
  });

  it('excludes mappings whose matched project is archived', async () => {
    const linear = fakeLinear();
    const getCompletedTasksSince = vi.fn().mockResolvedValue([
      { content: 'Should not be reported', completedAt: '2026-08-09T00:00:00.000Z', sectionId: null },
    ]);
    const todoist = fakeTodoist({
      getMarkedProjects: vi.fn().mockResolvedValue([project({ isArchived: true })]),
      getCompletedTasksSince,
    });
    const metrics = createMetrics();

    await runDigestJob({ linear, todoist, metrics });

    expect(getCompletedTasksSince).not.toHaveBeenCalled();
    expect(linear.createComment).not.toHaveBeenCalled();
  });

  it('marks the run failed when discovery throws, and skips the run timestamp', async () => {
    const linear = fakeLinear({ getStartedIssues: vi.fn().mockRejectedValue(new Error('down')) });
    const todoist = fakeTodoist();
    const metrics = createMetrics();

    await runDigestJob({ linear, todoist, metrics });

    expect(await gaugeValue(metrics, 'sync_last_digest_result')).toBe(0);
    expect(await gaugeValue(metrics, 'sync_last_digest_run_timestamp_seconds')).toBe(0);
  });

  it('continues to the next mapping and marks the run failed when one mapping errors', async () => {
    const secondIssue = issue({ id: 'issue-2', identifier: 'ENG-2', url: 'https://linear.app/acme/issue/ENG-2' });
    const secondProject = project({
      id: 'proj-2',
      description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-2',
    });
    const linear = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([issue(), secondIssue]),
      createComment: vi.fn().mockRejectedValueOnce(new Error('linear down')).mockResolvedValue(undefined),
    });
    const todoist = fakeTodoist({
      getMarkedProjects: vi.fn().mockResolvedValue([project(), secondProject]),
      getCompletedTasksSince: vi
        .fn()
        .mockResolvedValue([{ content: 'Done thing', completedAt: '2026-08-09T00:00:00.000Z', sectionId: null }]),
    });
    const metrics = createMetrics();

    await runDigestJob({ linear, todoist, metrics });

    expect(linear.createComment).toHaveBeenCalledTimes(2);
    expect(await gaugeValue(metrics, 'sync_last_digest_result')).toBe(0);
  });
});
