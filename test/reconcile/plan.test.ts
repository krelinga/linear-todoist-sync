import { describe, expect, it } from 'vitest';
import { planActions } from '../../src/reconcile/plan.js';
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

function mapping(overrides: Partial<IssueMapping> = {}): IssueMapping {
  return { issue: issue(), matchedProject: null, attachment: null, ...overrides };
}

function orphan(overrides: Partial<OrphanedProject> = {}): OrphanedProject {
  return { project: project(), linkedIssue: null, ...overrides };
}

function snapshot(mappings: IssueMapping[] = [], orphans: OrphanedProject[] = []): Snapshot {
  return { mappings, orphans };
}

describe('planActions - §5.1 Linear-originated transitions', () => {
  it('creates a brand-new project for an issue with no project and no prior attachment', () => {
    const actions = planActions(snapshot([mapping()]));
    expect(actions).toEqual([{ kind: 'create_project', issue: issue() }]);
  });

  it('unarchives a matched archived project instead of creating a new one (search-archived-first)', () => {
    const archived = project({ isArchived: true });
    const actions = planActions(snapshot([mapping({ matchedProject: archived })]));
    expect(actions).toEqual([{ kind: 'unarchive_project', project: archived, issue: issue() }]);
  });

  it('renames the project when the issue title has changed', () => {
    const stale = project({ name: '[ENG-1] Old title' });
    const actions = planActions(
      snapshot([mapping({ matchedProject: stale, attachment: attachment() })]),
    );
    expect(actions).toContainEqual({ kind: 'rename_project', project: stale, issue: issue() });
  });

  it('archives the project when its issue moved to another state', () => {
    const active = project();
    const movedIssue = issue({ stateType: 'completed' });
    const actions = planActions(snapshot([], [orphan({ project: active, linkedIssue: movedIssue })]));
    expect(actions).toEqual([
      { kind: 'archive_project', project: active, linkedIssueId: movedIssue.id },
    ]);
  });

  it('marks a project [LOST] when its issue was deleted outright', () => {
    const actions = planActions(snapshot([], [orphan({ linkedIssue: null })]));
    expect(actions).toEqual([{ kind: 'mark_lost', project: project() }]);
  });

  it('is idempotent: does not re-mark an already-[LOST]-prefixed project', () => {
    const lost = project({ name: '[LOST] [ENG-1] Fix the flaky login test' });
    const actions = planActions(snapshot([], [orphan({ project: lost, linkedIssue: null })]));
    expect(actions).toEqual([]);
  });

  it('recreates the project when the linked attachment points at a project that no longer exists', () => {
    const staleAttachment = attachment({ url: 'https://todoist.com/showProject?id=deleted' });
    const actions = planActions(snapshot([mapping({ attachment: staleAttachment })]));
    expect(actions).toEqual([
      { kind: 'recreate_project', issue: issue(), previousProjectUrl: staleAttachment.url },
    ]);
  });
});

describe('planActions - §5.2 Todoist-originated transitions', () => {
  it('unarchives a project the user archived directly, while its issue is still started', () => {
    const archived = project({ isArchived: true });
    const actions = planActions(snapshot([mapping({ matchedProject: archived })]));
    expect(actions).toEqual([{ kind: 'unarchive_project', project: archived, issue: issue() }]);
  });

  it('renames a project back when it was renamed directly in Todoist ("Linear wins")', () => {
    const renamed = project({ name: 'Some manually chosen name' });
    const actions = planActions(
      snapshot([mapping({ matchedProject: renamed, attachment: attachment() })]),
    );
    expect(actions).toContainEqual({ kind: 'rename_project', project: renamed, issue: issue() });
  });

  it('recreates a project that was deleted outright in Todoist', () => {
    const actions = planActions(snapshot([mapping({ attachment: attachment() })]));
    expect(actions).toEqual([
      { kind: 'recreate_project', issue: issue(), previousProjectUrl: attachment().url },
    ]);
  });

  it('takes no action for a project that only has a manually-added task (steady state)', () => {
    const actions = planActions(
      snapshot([mapping({ matchedProject: project(), attachment: attachment() })]),
    );
    expect(actions).toEqual([
      { kind: 'refresh_card', attachment: attachment(), project: project(), issue: issue() },
    ]);
  });
});

describe('planActions - self-healing', () => {
  it('reattaches a missing card for an otherwise-correct active mapping', () => {
    const actions = planActions(snapshot([mapping({ matchedProject: project() })]));
    expect(actions).toEqual([{ kind: 'reattach_card', issue: issue(), project: project() }]);
  });

  it('does not also emit refresh_card when reattaching (attachment is absent)', () => {
    const actions = planActions(snapshot([mapping({ matchedProject: project() })]));
    expect(actions.filter((a) => a.kind === 'refresh_card')).toEqual([]);
  });
});

describe('planActions - already-archived orphan with a still-nonexistent issue', () => {
  it('takes no action when an orphaned project is already archived and correctly not started', () => {
    const archived = project({ isArchived: true });
    const stillActiveIssue = issue({ stateType: 'canceled' });
    const actions = planActions(snapshot([], [orphan({ project: archived, linkedIssue: stillActiveIssue })]));
    expect(actions).toEqual([]);
  });
});

describe('planActions - aggregation across a full snapshot', () => {
  it('produces independent actions for every mapping and orphan in one pass', () => {
    const newIssue = issue({ id: 'issue-2', identifier: 'ENG-2', url: 'https://linear.app/acme/issue/ENG-2' });
    const orphanedProject = project({ id: 'proj-9', description: 'Linked Linear issue: https://linear.app/acme/issue/ENG-9' });
    const orphanedIssue = issue({ id: 'issue-9', identifier: 'ENG-9', stateType: 'done' });

    const actions = planActions(
      snapshot(
        [mapping({ issue: newIssue, matchedProject: null, attachment: null })],
        [orphan({ project: orphanedProject, linkedIssue: orphanedIssue })],
      ),
    );

    expect(actions).toEqual([
      { kind: 'create_project', issue: newIssue },
      { kind: 'archive_project', project: orphanedProject, linkedIssueId: orphanedIssue.id },
    ]);
  });
});
