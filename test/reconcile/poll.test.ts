import { describe, expect, it, vi } from 'vitest';
import { runPollCycle } from '../../src/reconcile/poll.js';
import type { PlanConfig } from '../../src/reconcile/plan.js';
import { createMetrics } from '../../src/metrics.js';
import type { LinearPort } from '../../src/clients/linear.js';
import type { TodoistPort } from '../../src/clients/todoist.js';
import type { LinearIssueSummary, TodoistProjectSummary } from '../../src/types.js';

const COLORS: PlanConfig = {
  stateColors: new Map([['in progress', 'blue']]),
  defaultStateColor: 'charcoal',
};

function issue(overrides: Partial<LinearIssueSummary> = {}): LinearIssueSummary {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Fix the thing',
    url: 'https://linear.app/acme/issue/ENG-1',
    stateType: 'started',
    stateName: 'In Progress',
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
    color: 'blue',
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
    getOutstandingTasks: vi.fn().mockResolvedValue({ tasks: [], sections: [] }),
    getCompletedTasksSince: vi.fn(),
    addProjectComment: vi.fn(),
    ...overrides,
  };
}

async function gaugeValue(
  metrics: ReturnType<typeof createMetrics>,
  name: string,
  labels: Record<string, string>,
) {
  const values = (await metrics.registry.getSingleMetric(name)?.get())?.values ?? [];
  return values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value;
}

describe('runPollCycle', () => {
  it('records success metrics and mapping gauges on a clean cycle', async () => {
    const activeMatched = project();
    const archivedOrphan = project({
      id: 'proj-2',
      isArchived: true,
      color: 'blue',
      description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-9',
    });
    const linear = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([issue()]),
      getMarkerAttachments: vi.fn().mockResolvedValue([
        {
          id: 'att-1',
          url: activeMatched.url,
          title: activeMatched.name,
          subtitle: '0 tasks outstanding',
          metadata: {},
        },
      ]),
    });
    const todoist = fakeTodoist({
      getMarkedProjects: vi.fn().mockResolvedValue([activeMatched, archivedOrphan]),
    });
    const metrics = createMetrics();

    await runPollCycle({ linear, todoist, metrics, colors: COLORS, colors: COLORS });

    expect(await gaugeValue(metrics, 'sync_last_poll_result', {})).toBe(1);
    expect(await gaugeValue(metrics, 'sync_mappings', { status: 'active' })).toBe(1);
    expect(await gaugeValue(metrics, 'sync_mappings', { status: 'archived' })).toBe(1);
    const successTimestamp = await gaugeValue(
      metrics,
      'sync_last_poll_success_timestamp_seconds',
      {},
    );
    expect(successTimestamp).toBeGreaterThan(0);
    const runs = (await metrics.pollRunsTotal.get()).values;
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labels: { result: 'success', trigger: 'scheduled' }, value: 1 }),
      ]),
    );
  });

  it('labels the run with the trigger that caused it', async () => {
    const linear = fakeLinear();
    const todoist = fakeTodoist();
    const metrics = createMetrics();

    await runPollCycle({ linear, todoist, metrics, colors: COLORS, trigger: 'webhook' });

    const runs = (await metrics.pollRunsTotal.get()).values;
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labels: { result: 'success', trigger: 'webhook' }, value: 1 }),
      ]),
    );
  });

  it('marks the cycle failed and skips the success timestamp when discovery throws', async () => {
    const linear = fakeLinear({
      getStartedIssues: vi.fn().mockRejectedValue(new Error('linear is down')),
    });
    const todoist = fakeTodoist();
    const metrics = createMetrics();

    await runPollCycle({ linear, todoist, metrics, colors: COLORS, colors: COLORS });

    expect(await gaugeValue(metrics, 'sync_last_poll_result', {})).toBe(0);
    // Absent rather than 0 until a cycle succeeds - see metrics.ts.
    expect(
      await gaugeValue(metrics, 'sync_last_poll_success_timestamp_seconds', {}),
    ).toBeUndefined();
    const runs = (await metrics.pollRunsTotal.get()).values;
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labels: { result: 'error', trigger: 'scheduled' }, value: 1 }),
      ]),
    );
  });

  it('marks the cycle failed when at least one action fails to apply, even if discovery succeeds', async () => {
    const linear = fakeLinear({ getStartedIssues: vi.fn().mockResolvedValue([issue()]) });
    const todoist = fakeTodoist({
      createProject: vi.fn().mockRejectedValue(new Error('todoist is down')),
    });
    const metrics = createMetrics();

    await runPollCycle({ linear, todoist, metrics, colors: COLORS, colors: COLORS });

    expect(await gaugeValue(metrics, 'sync_last_poll_result', {})).toBe(0);
  });

  it('always stops the poll duration timer, even on failure', async () => {
    const linear = fakeLinear({ getStartedIssues: vi.fn().mockRejectedValue(new Error('down')) });
    const todoist = fakeTodoist();
    const metrics = createMetrics();

    await runPollCycle({ linear, todoist, metrics, colors: COLORS, colors: COLORS });

    const histogram = (await metrics.pollDurationSeconds.get()).values;
    const count = histogram.find((v) => v.metricName?.endsWith('_count'));
    expect(count?.value).toBe(1);
  });
});

describe('runPollCycle - unmapped state colours (colors design §6.1)', () => {
  const colors: PlanConfig = {
    stateColors: new Map([['in progress', 'blue']]),
    defaultStateColor: 'charcoal',
  };

  function startedIssue(identifier: string, stateName: string) {
    return {
      id: `id-${identifier}`,
      identifier,
      title: 'Something',
      url: `https://linear.app/acme/issue/${identifier}/something`,
      stateType: 'started',
      stateName,
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
  }

  async function unmappedSeries(metrics: ReturnType<typeof createMetrics>) {
    const { values } = await metrics.stateColorUnmapped.get();
    return Object.fromEntries(values.map((v) => [v.labels['state'], v.value]));
  }

  it('counts issues per unmapped state, naming the state Linear currently uses', async () => {
    const linear = fakeLinear({
      getStartedIssues: vi
        .fn()
        .mockResolvedValue([
          startedIssue('ENG-1', 'In Progress'),
          startedIssue('ENG-2', 'Blocked'),
          startedIssue('ENG-3', 'Blocked'),
        ]),
    });
    const metrics = createMetrics();

    await runPollCycle({ linear, todoist: fakeTodoist(), metrics, colors });

    // 'In Progress' is configured, so it must not appear at all.
    expect(await unmappedSeries(metrics)).toEqual({ Blocked: 2 });
  });

  it('exports nothing when every started state is configured', async () => {
    const linear = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([startedIssue('ENG-1', 'In Progress')]),
    });
    const metrics = createMetrics();

    await runPollCycle({ linear, todoist: fakeTodoist(), metrics, colors });

    expect(await unmappedSeries(metrics)).toEqual({});
  });

  it('clears a state that is no longer unmapped instead of leaving the series behind', async () => {
    // The trap this guards: a labelled prom-client gauge retains every label combination it has
    // ever been set with, so without reset() the series outlives the condition and leaves an
    // alert firing that no config change can clear (§6.1).
    const metrics = createMetrics();
    const stillBroken = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([startedIssue('ENG-2', 'Blocked')]),
    });
    await runPollCycle({ linear: stillBroken, todoist: fakeTodoist(), metrics, colors });
    expect(await unmappedSeries(metrics)).toEqual({ Blocked: 1 });

    const fixed = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([startedIssue('ENG-2', 'In Progress')]),
    });
    await runPollCycle({ linear: fixed, todoist: fakeTodoist(), metrics, colors });
    expect(await unmappedSeries(metrics)).toEqual({});
  });

  it('leaves the previous values alone when the cycle failed, rather than reporting "all clear"', async () => {
    // "We could not look" is not "nothing is unmapped"; the failure is already reported by
    // sync_last_poll_result and the staleness alert.
    const metrics = createMetrics();
    const working = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([startedIssue('ENG-2', 'Blocked')]),
    });
    await runPollCycle({ linear: working, todoist: fakeTodoist(), metrics, colors });
    expect(await unmappedSeries(metrics)).toEqual({ Blocked: 1 });

    const broken = fakeLinear({
      getStartedIssues: vi.fn().mockRejectedValue(new Error('Linear is down')),
    });
    await runPollCycle({ linear: broken, todoist: fakeTodoist(), metrics, colors });
    expect(await unmappedSeries(metrics)).toEqual({ Blocked: 1 });
    expect(await gaugeValue(metrics, 'sync_last_poll_result', {})).toBe(0);
  });

  it('treats every state as unmapped when no colours are configured', async () => {
    const linear = fakeLinear({
      getStartedIssues: vi.fn().mockResolvedValue([startedIssue('ENG-1', 'In Progress')]),
    });
    const metrics = createMetrics();

    await runPollCycle({
      linear,
      todoist: fakeTodoist(),
      metrics,
      colors: { stateColors: new Map(), defaultStateColor: 'charcoal' },
    });

    expect(await unmappedSeries(metrics)).toEqual({ 'In Progress': 1 });
  });
});
