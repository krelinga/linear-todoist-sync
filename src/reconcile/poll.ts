import { discover } from './discover.js';
import { planActions } from './plan.js';
import { applyActions } from './apply.js';
import { logger } from '../logger.js';
import type { LinearPort } from '../clients/linear.js';
import type { TodoistPort } from '../clients/todoist.js';
import type { Metrics } from '../metrics.js';
import type { TodoistProjectSummary } from '../types.js';

export type PollDeps = {
  linear: LinearPort;
  todoist: TodoistPort;
  metrics: Metrics;
};

/** One full reconciliation cycle (§5): discover -> plan -> apply -> update health metrics. */
export async function runPollCycle(deps: PollDeps): Promise<void> {
  const stopTimer = deps.metrics.pollDurationSeconds.startTimer();
  let success = true;
  try {
    const snapshot = await discover(deps.linear, deps.todoist);
    const actions = planActions(snapshot);
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
    logger.error('Poll cycle failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    stopTimer();
    deps.metrics.pollRunsTotal.inc({ result: success ? 'success' : 'error' });
    deps.metrics.lastPollResult.set(success ? 1 : 0);
    if (success) {
      deps.metrics.lastPollSuccessTimestampSeconds.set(Date.now() / 1000);
    }
  }
}
