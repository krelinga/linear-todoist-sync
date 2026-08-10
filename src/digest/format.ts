import type { TodoistCompletedTaskSummary, TodoistSectionSummary } from '../types.js';

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
  const sectionNameById = new Map(sections.map((section) => [section.id, section.name]));
  const sectionOrderById = new Map(sections.map((section) => [section.id, section.order]));

  const unsectioned = completedTasks.filter((task) => task.sectionId === null);

  const bySectionId = new Map<string, TodoistCompletedTaskSummary[]>();
  for (const task of completedTasks) {
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
    const taskLines = (bySectionId.get(sectionId) ?? []).map((task) => `- ${task.content}`).join('\n');
    blocks.push(`**${name}**\n${taskLines}`);
  }

  return `Completed since last update:\n\n${blocks.join('\n\n')}`;
}
