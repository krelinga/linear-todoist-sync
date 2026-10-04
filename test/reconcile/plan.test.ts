import { describe, expect, it } from 'vitest';
import { planActions, type PlanConfig } from '../../src/reconcile/plan.js';
import type {
  LinearAttachmentSummary,
  LinearIssueSummary,
  OrphanedProject,
  IssueMapping,
  Snapshot,
  TodoistProjectSummary,
} from '../../src/types.js';

function issue(overrides: Partial<LinearIssueSummary> = {}): LinearIssueSummary {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Fix the flaky login test',
    url: 'https://linear.app/acme/issue/ENG-1/fix-the-flaky-login-test',
    stateType: 'started',
    stateName: 'In Progress',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function project(overrides: Partial<TodoistProjectSummary> = {}): TodoistProjectSummary {
  return {
    id: 'proj-1',
    name: '[ENG-1] Fix the flaky login test',
    url: 'https://todoist.com/showProject?id=proj-1',
    description:
      'Linked Linear issue: https://linear.app/acme/issue/ENG-1/fix-the-flaky-login-test',
    isArchived: false,
    color: 'blue',
    ...overrides,
  };
}

/**
 * The colour config most tests run under: the fixture issue's state maps to the fixture
 * project's colour, so colour never diverges and planning is exercised on the other fields.
 * Tests about colour override one side or the other.
 */
const COLORS: PlanConfig = {
  stateColors: new Map([['in progress', 'blue']]),
  defaultStateColor: 'charcoal',
};

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

function mapping(overrides: Partial<IssueMapping> = {}): IssueMapping {
  return {
    issue: issue(),
    matchedProject: null,
    attachment: null,
    strayAttachments: [],
    ...overrides,
  };
}

function orphan(overrides: Partial<OrphanedProject> = {}): OrphanedProject {
  return { project: project(), linkedIssue: null, ...overrides };
}

function snapshot(mappings: IssueMapping[] = [], orphans: OrphanedProject[] = []): Snapshot {
  return { mappings, orphans };
}

describe('planActions - §5.1 Linear-originated transitions', () => {
  it('creates a brand-new project for an issue with no project and no prior attachment', () => {
    const actions = planActions(snapshot([mapping()]), COLORS);
    expect(actions).toEqual([{ kind: 'create_project', issue: issue() }]);
  });

  it('unarchives a matched archived project instead of creating a new one (search-archived-first)', () => {
    const archived = project({ isArchived: true });
    const actions = planActions(snapshot([mapping({ matchedProject: archived })]), COLORS);
    expect(actions).toEqual([{ kind: 'unarchive_project', project: archived, issue: issue() }]);
  });

  it('renames the project when the issue title has changed', () => {
    const stale = project({ name: '[ENG-1] Old title' });
    const actions = planActions(
      snapshot([mapping({ matchedProject: stale, attachment: attachment() })]),
      COLORS,
    );
    expect(actions).toContainEqual({
      kind: 'update_project',
      project: stale,
      issue: issue(),
      name: '[ENG-1] Fix the flaky login test',
    });
  });

  it('archives the project when its issue moved to another state', () => {
    const active = project();
    const movedIssue = issue({ stateType: 'completed' });
    const actions = planActions(
      snapshot([], [orphan({ project: active, linkedIssue: movedIssue })]),
      COLORS,
    );
    expect(actions).toEqual([
      { kind: 'archive_project', project: active, linkedIssueId: movedIssue.id },
    ]);
  });

  it('marks a project [LOST] when its issue was deleted outright', () => {
    const actions = planActions(snapshot([], [orphan({ linkedIssue: null })]), COLORS);
    expect(actions).toEqual([{ kind: 'mark_lost', project: project() }]);
  });

  it('is idempotent: does not re-mark an already-[LOST]-prefixed project', () => {
    const lost = project({ name: '[LOST] [ENG-1] Fix the flaky login test' });
    const actions = planActions(
      snapshot([], [orphan({ project: lost, linkedIssue: null })]),
      COLORS,
    );
    expect(actions).toEqual([]);
  });

  it('recreates the project when the linked attachment points at a project that no longer exists', () => {
    const staleAttachment = attachment({ url: 'https://todoist.com/showProject?id=deleted' });
    const actions = planActions(snapshot([mapping({ attachment: staleAttachment })]), COLORS);
    expect(actions).toEqual([
      { kind: 'recreate_project', issue: issue(), previousProjectUrl: staleAttachment.url },
    ]);
  });
});

describe('planActions - §5.2 Todoist-originated transitions', () => {
  it('unarchives a project the user archived directly, while its issue is still started', () => {
    const archived = project({ isArchived: true });
    const actions = planActions(snapshot([mapping({ matchedProject: archived })]), COLORS);
    expect(actions).toEqual([{ kind: 'unarchive_project', project: archived, issue: issue() }]);
  });

  it('renames a project back when it was renamed directly in Todoist ("Linear wins")', () => {
    const renamed = project({ name: 'Some manually chosen name' });
    const actions = planActions(
      snapshot([mapping({ matchedProject: renamed, attachment: attachment() })]),
      COLORS,
    );
    expect(actions).toContainEqual({
      kind: 'update_project',
      project: renamed,
      issue: issue(),
      name: '[ENG-1] Fix the flaky login test',
    });
  });

  it('recreates a project that was deleted outright in Todoist', () => {
    const actions = planActions(snapshot([mapping({ attachment: attachment() })]), COLORS);
    expect(actions).toEqual([
      { kind: 'recreate_project', issue: issue(), previousProjectUrl: attachment().url },
    ]);
  });

  it('takes no action for a project that only has a manually-added task (steady state)', () => {
    const actions = planActions(
      snapshot([mapping({ matchedProject: project(), attachment: attachment() })]),
      COLORS,
    );
    expect(actions).toEqual([
      { kind: 'refresh_card', attachment: attachment(), project: project(), issue: issue() },
    ]);
  });
});

describe('planActions - self-healing', () => {
  it('reattaches a missing card for an otherwise-correct active mapping', () => {
    const actions = planActions(snapshot([mapping({ matchedProject: project() })]), COLORS);
    expect(actions).toEqual([{ kind: 'reattach_card', issue: issue(), project: project() }]);
  });

  it('does not also emit refresh_card when reattaching (attachment is absent)', () => {
    const actions = planActions(snapshot([mapping({ matchedProject: project() })]), COLORS);
    expect(actions.filter((a) => a.kind === 'refresh_card')).toEqual([]);
  });
});

describe('planActions - already-archived orphan with a still-nonexistent issue', () => {
  it('takes no action when an orphaned project is already archived and correctly not started', () => {
    const archived = project({ isArchived: true });
    const stillActiveIssue = issue({ stateType: 'canceled' });
    const actions = planActions(
      snapshot([], [orphan({ project: archived, linkedIssue: stillActiveIssue })]),
      COLORS,
    );
    expect(actions).toEqual([]);
  });
});

describe('planActions - aggregation across a full snapshot', () => {
  it('produces independent actions for every mapping and orphan in one pass', () => {
    const newIssue = issue({
      id: 'issue-2',
      identifier: 'ENG-2',
      url: 'https://linear.app/acme/issue/ENG-2',
    });
    const orphanedProject = project({
      id: 'proj-9',
      description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-9',
    });
    const orphanedIssue = issue({ id: 'issue-9', identifier: 'ENG-9', stateType: 'done' });

    const actions = planActions(
      snapshot(
        [mapping({ issue: newIssue, matchedProject: null, attachment: null })],
        [orphan({ project: orphanedProject, linkedIssue: orphanedIssue })],
      ),
      COLORS,
    );

    expect(actions).toEqual([
      { kind: 'create_project', issue: newIssue },
      { kind: 'archive_project', project: orphanedProject, linkedIssueId: orphanedIssue.id },
    ]);
  });

  describe('stray cards from a duplicate (#1)', () => {
    const stray = attachment({ id: 'att-moved', url: 'https://todoist.com/showProject?id=B' });

    it('schedules deletion alongside the steady-state refresh', () => {
      const actions = planActions(
        snapshot([
          mapping({
            matchedProject: project(),
            attachment: attachment(),
            strayAttachments: [stray],
          }),
        ]),
        COLORS,
      );

      expect(actions).toEqual([
        { kind: 'delete_stray_cards', issue: issue(), attachments: [stray] },
        { kind: 'refresh_card', attachment: attachment(), project: project(), issue: issue() },
      ]);
    });

    it('schedules deletion even when the project must be created from scratch', () => {
      const actions = planActions(snapshot([mapping({ strayAttachments: [stray] })]), COLORS);

      expect(actions).toEqual([
        { kind: 'delete_stray_cards', issue: issue(), attachments: [stray] },
        { kind: 'create_project', issue: issue() },
      ]);
    });

    it('emits nothing extra when there are no strays', () => {
      const actions = planActions(
        snapshot([mapping({ matchedProject: project(), attachment: attachment() })]),
        COLORS,
      );

      expect(actions.some((a) => a.kind === 'delete_stray_cards')).toBe(false);
    });
  });
});

describe('planActions - project colours (colors design §5)', () => {
  it('recolours when the issue moves between two started states', () => {
    // The new transition: both states are `started`, so before this feature the snapshot
    // produced no action at all beyond the steady-state card refresh.
    const inReview = issue({ stateName: 'In Review' });
    const colors: PlanConfig = {
      stateColors: new Map([
        ['in progress', 'blue'],
        ['in review', 'grape'],
      ]),
      defaultStateColor: 'charcoal',
    };
    const actions = planActions(
      snapshot([mapping({ issue: inReview, matchedProject: project(), attachment: attachment() })]),
      colors,
    );
    expect(actions).toContainEqual({
      kind: 'update_project',
      project: project(),
      issue: inReview,
      color: 'grape',
    });
  });

  it('pushes the mapped colour back when it was changed directly in Todoist ("Linear wins")', () => {
    const recoloured = project({ color: 'red' });
    const actions = planActions(
      snapshot([mapping({ matchedProject: recoloured, attachment: attachment() })]),
      COLORS,
    );
    expect(actions).toContainEqual({
      kind: 'update_project',
      project: recoloured,
      issue: issue(),
      color: 'blue',
    });
  });

  it('emits one action carrying both fields when name and colour have both diverged', () => {
    // `updateProject` takes both in a single call, so a simultaneous rename and recolour must
    // not cost two writes (§5).
    const stale = project({ name: '[ENG-1] Old title', color: 'red' });
    const actions = planActions(
      snapshot([mapping({ matchedProject: stale, attachment: attachment() })]),
      COLORS,
    );
    const updates = actions.filter((action) => action.kind === 'update_project');
    expect(updates).toEqual([
      {
        kind: 'update_project',
        project: stale,
        issue: issue(),
        name: '[ENG-1] Fix the flaky login test',
        color: 'blue',
      },
    ]);
  });

  it('emits no update at all when neither field has diverged', () => {
    const actions = planActions(
      snapshot([mapping({ matchedProject: project(), attachment: attachment() })]),
      COLORS,
    );
    expect(actions.some((action) => action.kind === 'update_project')).toBe(false);
  });

  it('uses the default colour for a state with no configured entry', () => {
    const blocked = issue({ stateName: 'Blocked' });
    const actions = planActions(
      snapshot([mapping({ issue: blocked, matchedProject: project(), attachment: attachment() })]),
      COLORS,
    );
    expect(actions).toContainEqual({
      kind: 'update_project',
      project: project(),
      issue: blocked,
      color: 'charcoal',
    });
  });

  it('leaves colour alone entirely when nothing is configured and the project already matches the default', () => {
    // The "feature off" configuration must not churn every project to charcoal on every cycle
    // if they are already charcoal.
    const charcoal = project({ color: 'charcoal' });
    const actions = planActions(
      snapshot([mapping({ matchedProject: charcoal, attachment: attachment() })]),
      { stateColors: new Map(), defaultStateColor: 'charcoal' },
    );
    expect(actions.some((action) => action.kind === 'update_project')).toBe(false);
  });

  it('does not try to recolour an archived project, which is unarchived first', () => {
    // Colour is left frozen on close-out (§5), and an archived project takes the unarchive
    // path, so planning must not also emit a colour write against it.
    const archived = project({ isArchived: true, color: 'red' });
    const actions = planActions(snapshot([mapping({ matchedProject: archived })]), COLORS);
    expect(actions).toEqual([{ kind: 'unarchive_project', project: archived, issue: issue() }]);
  });
});
