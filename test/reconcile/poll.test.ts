import { describe, expect, it, vi } from 'vitest';
import { runPollCycle } from '../../src/reconcile/poll.js';
import { createMetrics } from '../../src/metrics.js';
import type { LinearPort } from '../../src/clients/linear.js';
import type { TodoistPort } from '../../src/clients/todoist.js';
import type { LinearIssueSummary, TodoistProjectSummary } from '../../src/types.js';

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

function fakeLinear(overrides: Partial<LinearPort> = {}): LinearPort {
  return {
    getStartedIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue(null),
    getMarkerAttachment: vi.fn().mockResolvedValue(null),
    createAttachment: vi.fn(),
    updateAttachment: vi.fn(),
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
    getOutstandingTasks: vi.fn().mockResolvedValue({ tasks: [], sections: [] }),
    getCompletedTasksSince: vi.fn(),
    addProjectComment: vi.fn(),
    ...overrides,
  };
}

async function gaugeValue(metrics: ReturnType<typeof createMetrics>, name: string, labels: Record<string, string>) {
  const values = (await metrics.registry.getSingleMetric(name)?.get())?.values ?? [];
  return values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value;
}

describe('runPollCycle', () => {
  it('records success metrics and mapping gauges on a clean cycle', async () => {
    const activeMatched = project();
    const archivedOrphan = project({
      id: 'proj-2',
      isArchived: true,
      description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-9',
    });
    const linear = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([issue()]),
      getMarkerAttachment: vi.fn().mockResolvedValue({
        id: 'att-1',
        url: activeMatched.url,
        title: activeMatched.name,
        subtitle: '0 tasks outstanding',
        metadata: {},
      }),
    });
    const todoist = fakeTodoist({
      getMarkedProjects: vi.fn().mockResolvedValue([activeMatched, archivedOrphan]),
    });
    const metrics = createMetrics();

    await runPollCycle({ linear, todoist, metrics });

    expect(await gaugeValue(metrics, 'sync_last_poll_result', {})).toBe(1);
    expect(await gaugeValue(metrics, 'sync_mappings', { status: 'active' })).toBe(1);
    expect(await gaugeValue(metrics, 'sync_mappings', { status: 'archived' })).toBe(1);
    const successTimestamp = await gaugeValue(metrics, 'sync_last_poll_success_timestamp_seconds', {});
    expect(successTimestamp).toBeGreaterThan(0);
    const runs = (await metrics.pollRunsTotal.get()).values;
    expect(runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ labels: { result: 'success' }, value: 1 })]),
    );
  });

  it('marks the cycle failed and skips the success timestamp when discovery throws', async () => {
    const linear = fakeLinear({
      getStartedIssues: vi.fn().mockRejectedValue(new Error('linear is down')),
    });
    const todoist = fakeTodoist();
    const metrics = createMetrics();

    await runPollCycle({ linear, todoist, metrics });

    expect(await gaugeValue(metrics, 'sync_last_poll_result', {})).toBe(0);
    expect(await gaugeValue(metrics, 'sync_last_poll_success_timestamp_seconds', {})).toBe(0);
    const runs = (await metrics.pollRunsTotal.get()).values;
    expect(runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ labels: { result: 'error' }, value: 1 })]),
    );
  });

  it('marks the cycle failed when at least one action fails to apply, even if discovery succeeds', async () => {
    const linear = fakeLinear({ getStartedIssues: vi.fn().mockResolvedValue([issue()]) });
    const todoist = fakeTodoist({
      createProject: vi.fn().mockRejectedValue(new Error('todoist is down')),
    });
    const metrics = createMetrics();

    await runPollCycle({ linear, todoist, metrics });

    expect(await gaugeValue(metrics, 'sync_last_poll_result', {})).toBe(0);
  });

  it('always stops the poll duration timer, even on failure', async () => {
    const linear = fakeLinear({ getStartedIssues: vi.fn().mockRejectedValue(new Error('down')) });
    const todoist = fakeTodoist();
    const metrics = createMetrics();

    await runPollCycle({ linear, todoist, metrics });

    const histogram = (await metrics.pollDurationSeconds.get()).values;
    const count = histogram.find((v) => v.metricName?.endsWith('_count'));
    expect(count?.value).toBe(1);
  });
});
