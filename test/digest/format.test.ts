import { describe, expect, it } from 'vitest';
import { formatDigestComment } from '../../src/digest/format.js';
import type { TodoistCompletedTaskSummary, TodoistSectionSummary } from '../../src/types.js';

function task(
  content: string,
  sectionId: string | null,
  completedAt = '2026-08-09T12:00:00.000Z',
): TodoistCompletedTaskSummary {
  return { content, completedAt, sectionId };
}

describe('formatDigestComment', () => {
  it('matches the §7 example exactly: unsectioned first, then sections in Todoist order', () => {
    const tasks = [
      task('Fix null pointer in auth middleware', null),
      task('Add retry logic to the sync job', 'sec-backend'),
      task('Write integration test for retry logic', 'sec-backend'),
      task('Update error toast copy', 'sec-frontend'),
    ];
    const sections: TodoistSectionSummary[] = [
      { id: 'sec-backend', name: 'Backend', order: 1 },
      { id: 'sec-frontend', name: 'Frontend', order: 2 },
    ];

    expect(formatDigestComment(tasks, sections)).toBe(
      [
        'Completed since last update:',
        '',
        '- Fix null pointer in auth middleware',
        '',
        '**Backend**',
        '- Add retry logic to the sync job',
        '- Write integration test for retry logic',
        '',
        '**Frontend**',
        '- Update error toast copy',
      ].join('\n'),
    );
  });

  it('reads as a plain flat list when the project uses no sections', () => {
    const tasks = [task('Task one', null), task('Task two', null)];
    expect(formatDigestComment(tasks, [])).toBe(
      ['Completed since last update:', '', '- Task one', '- Task two'].join('\n'),
    );
  });

  it('omits the unsectioned block entirely when every task is sectioned', () => {
    const tasks = [task('Do the backend thing', 'sec-backend')];
    const sections: TodoistSectionSummary[] = [{ id: 'sec-backend', name: 'Backend', order: 1 }];
    expect(formatDigestComment(tasks, sections)).toBe(
      ['Completed since last update:', '', '**Backend**', '- Do the backend thing'].join('\n'),
    );
  });

  it('orders sections by their Todoist order, not alphabetically', () => {
    const tasks = [task('Z task', 'sec-z'), task('A task', 'sec-a')];
    const sections: TodoistSectionSummary[] = [
      { id: 'sec-z', name: 'Zeta', order: 1 },
      { id: 'sec-a', name: 'Alpha', order: 2 },
    ];
    const result = formatDigestComment(tasks, sections);
    expect(result.indexOf('**Zeta**')).toBeLessThan(result.indexOf('**Alpha**'));
  });
});
