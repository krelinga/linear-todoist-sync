import { discover } from './discover.js';
import { planActions, type PlanConfig } from './plan.js';
import { applyActions } from './apply.js';
import { errorFields } from '../errors.js';
import { logger } from '../logger.js';
import { isStateMapped } from '../colors.js';
import type { LinearPort } from '../clients/linear.js';
import type { TodoistPort } from '../clients/todoist.js';
import type { Metrics } from '../metrics.js';
import type { Snapshot, TodoistProjectSummary } from '../types.js';

/**
 * What caused this cycle to run. Reconciliation is identical either way - this only labels the
 * metric, so "how much of my reconciliation is push-driven now" is answerable.
 */
export type PollTrigger = 'scheduled' | 'webhook';

export type PollDeps = {
  linear: LinearPort;
  todoist: TodoistPort;
  metrics: Metrics;
  colors: PlanConfig;
  trigger?: PollTrigger;
};

/**
 * Publishes which started states have no configured color (colors design §6.1).
 *
 * Derived from the snapshot rather than from a separate query: discovery already resolved every
 * started issue's state, so this is the whole detection mechanism for a state that was renamed
 * in Linear, newly added, or mistyped in the config - all three surface identically, as a state
 * name Linear is using that the config does not mention.
 *
 * `reset()` first, unconditionally, because a labelled gauge keeps every label it has ever been
 * set with. Without it a state's series would outlive the condition and leave an alert firing
 * that no config change could clear.
 *
 * Called only after a successful discovery. On a failed cycle the previous values are left
 * alone rather than cleared, since "we could not look" is not "nothing is unmapped" - that
 * cycle's failure is already reported by `sync_last_poll_result` and the staleness alert.
 */
function reportUnmappedStates(snapshot: Snapshot, deps: PollDeps): void {
  const issuesByState = new Map<string, number>();
  for (const { issue } of snapshot.mappings) {
    if (!isStateMapped(issue.stateName, deps.colors.stateColors)) {
      issuesByState.set(issue.stateName, (issuesByState.get(issue.stateName) ?? 0) + 1);
    }
  }

  deps.metrics.stateColorUnmapped.reset();
  for (const [state, count] of issuesByState) {
    deps.metrics.stateColorUnmapped.set({ state }, count);
  }

  if (issuesByState.size > 0) {
    // One aggregated line per cycle rather than one per project: the condition persists until
    // someone edits the config, and a line per affected project every minute would bury the
    // rest of the log. The gauge is the signal to alert on; this is for whoever is tailing.
    logger.warn('Started states have no configured Todoist color; using the default', {
      states: [...issuesByState.keys()],
      issues: [...issuesByState.values()].reduce((total, count) => total + count, 0),
      defaultColor: deps.colors.defaultStateColor,
    });
  }
}

/** One full reconciliation cycle (§5): discover -> plan -> apply -> update health metrics. */
export async function runPollCycle(deps: PollDeps): Promise<void> {
  const trigger = deps.trigger ?? 'scheduled';
  const stopTimer = deps.metrics.pollDurationSeconds.startTimer();
  let success = true;
  try {
    const snapshot = await discover(deps.linear, deps.todoist);
    reportUnmappedStates(snapshot, deps);
    const actions = planActions(snapshot, deps.colors);
    const result = await applyActions(actions, deps);
    success = result.failed === 0;

    const projects: TodoistProjectSummary[] = [
      ...snapshot.mappings
        .map((mapping) => mapping.matchedProject)
        .filter((project): project is TodoistProjectSummary => project !== null),
      ...snapshot.orphans.map((orphan) => orphan.project),
    ];
    deps.metrics.mappings.set(
      { status: 'active' },
      projects.filter((project) => !project.isArchived).length,
    );
    deps.metrics.mappings.set(
      { status: 'archived' },
      projects.filter((project) => project.isArchived).length,
    );
  } catch (err) {
    success = false;
    // Unlike a single failed action, this aborted the whole cycle - discovery itself failed, so
    // no action was attempted. The wrapped error names which half of discovery, and for what.
    logger.error('Poll cycle failed', { trigger, ...errorFields(err) });
  } finally {
    stopTimer();
    deps.metrics.pollRunsTotal.inc({ result: success ? 'success' : 'error', trigger });
    deps.metrics.lastPollResult.set(success ? 1 : 0);
    if (success) {
      deps.metrics.lastPollSuccessTimestampSeconds.set(Date.now() / 1000);
    }
  }
}
