import type {
  TodoistCompletedTaskSummary,
  TodoistSectionSummary,
  TodoistTaskSummary,
} from '../types.js';

/** The only shape either formatter needs from a task. */
type Listable = { content: string; sectionId: string | null };

/**
 * Tasks as markdown: unsectioned ones first and unlabeled, then each section under a bold
 * label in Todoist's own order rather than alphabetically, so the text matches what the app
 * shows. A project with no sections reads as a plain flat list.
 */
function groupBySection(tasks: Listable[], sections: TodoistSectionSummary[]): string {
  const sectionNameById = new Map(sections.map((section) => [section.id, section.name]));
  const sectionOrderById = new Map(sections.map((section) => [section.id, section.order]));

  const unsectioned = tasks.filter((task) => task.sectionId === null);

  const bySectionId = new Map<string, Listable[]>();
  for (const task of tasks) {
    if (task.sectionId === null) {
      continue;
    }
    const list = bySectionId.get(task.sectionId) ?? [];
    list.push(task);
    bySectionId.set(task.sectionId, list);
  }

  const orderedSectionIds = [...bySectionId.keys()].sort(
    (a, b) => (sectionOrderById.get(a) ?? 0) - (sectionOrderById.get(b) ?? 0),
  );

  const blocks: string[] = [];
  if (unsectioned.length > 0) {
    blocks.push(unsectioned.map((task) => `- ${task.content}`).join('\n'));
  }
  for (const sectionId of orderedSectionIds) {
    const name = sectionNameById.get(sectionId) ?? 'Unknown section';
    const taskLines = (bySectionId.get(sectionId) ?? [])
      .map((task) => `- ${task.content}`)
      .join('\n');
    blocks.push(`**${name}**\n${taskLines}`);
  }
  return blocks.join('\n\n');
}

/**
 * Formats a digest comment (§7): tasks with no section first and unlabeled, then any sectioned
 * tasks grouped under a bold section-name label in Todoist's own section order (not
 * alphabetical). A project with no sections at all just reads as a plain flat list. Assumes
 * `completedTasks` is non-empty - the caller (digest.ts) is responsible for skipping the
 * "nothing to report" case before calling this.
 */
export function formatDigestComment(
  completedTasks: TodoistCompletedTaskSummary[],
  sections: TodoistSectionSummary[],
): string {
  return `Completed since last update:\n\n${groupBySection(completedTasks, sections)}`;
}

export type ClosingCommentInput = {
  projectName: string;
  projectUrl: string;
  completedTasks: TodoistCompletedTaskSummary[];
  outstandingTasks: TodoistTaskSummary[];
  sections: TodoistSectionSummary[];
  /** On the comment posted to the duplicate: the issue that absorbed it. */
  absorbedInto?: string | undefined;
  /** On the comment posted to the canonical issue: the duplicate it absorbed. */
  absorbedFrom?: string | undefined;
};

/**
 * The comment posted when a mapping is closed out and its Todoist project archived (§5.6).
 *
 * This is the only record of two things that are otherwise lost. The digest reports on
 * *started* issues, so completions between the last daily run and the moment the issue leaves
 * "started" are never reported anywhere - that last day is exactly the one worth having. And
 * outstanding tasks are archived along with the project rather than moved, so without naming
 * them here they are effectively invisible.
 *
 * When the issue was absorbed as a duplicate the same text goes on both issues, from each
 * side's point of view: the duplicate is told where the work continues, and the canonical
 * issue is told what it just absorbed - including, explicitly, that the tasks did not come
 * with it. Linear moves the duplicate's card onto the canonical issue and says nothing about
 * the Todoist project behind it, so the canonical side would otherwise have no idea the
 * tasks exist.
 *
 * A recurring task completed inside the window appears under *both* headings, and that is
 * deliberate rather than an oversight to tidy up. Completing a recurring task reschedules it
 * instead of closing it (§7), so it genuinely is both - and a recurrence still open at the
 * moment its project is archived means nobody ended it first. Deduplicating would hide exactly
 * the thing worth noticing.
 */
export function formatClosingComment(input: ClosingCommentInput): string {
  const { projectName, projectUrl, completedTasks, outstandingTasks, sections } = input;

  const headline = input.absorbedFrom
    ? `**Todoist mirror archived — absorbed from ${input.absorbedFrom}.** That issue was marked a duplicate of this one, so its Todoist project has been archived. **Its tasks were not moved here.**`
    : input.absorbedInto
      ? `**Todoist mirror archived.** This issue was marked a duplicate of ${input.absorbedInto}, so its Todoist project has been archived. Work continues on ${input.absorbedInto}.`
      : '**Todoist mirror archived.** This issue is no longer in progress, so its Todoist project has been archived.';

  const blocks = [headline];
  if (completedTasks.length > 0) {
    blocks.push(`Completed since last update:\n\n${groupBySection(completedTasks, sections)}`);
  }
  if (outstandingTasks.length > 0) {
    blocks.push(
      `Still outstanding, now archived in Todoist:\n\n${groupBySection(outstandingTasks, sections)}`,
    );
  }
  blocks.push(`[${projectName}](${projectUrl})`);
  return blocks.join('\n\n');
}
