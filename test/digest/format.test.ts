import { describe, expect, it } from 'vitest';
import { formatClosingComment, formatDigestComment } from '../../src/digest/format.js';
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

describe('formatClosingComment', () => {
  const base = {
    projectName: '[ENG-1] Fix the thing',
    projectUrl: 'https://app.todoist.com/app/project/eng-1-fix-the-thing-p1',
    completedTasks: [
      { content: 'Did a thing', completedAt: '2026-09-01T00:00:00.000Z', sectionId: null },
    ],
    outstandingTasks: [{ id: 't1', content: 'Left undone', sectionId: null }],
    sections: [],
  };

  it('reports both what was finished and what was left behind', () => {
    const body = formatClosingComment(base);
    expect(body).toContain('Todoist mirror archived.');
    expect(body).toContain('Completed since last update:');
    expect(body).toContain('- Did a thing');
    expect(body).toContain('Still outstanding, now archived in Todoist:');
    expect(body).toContain('- Left undone');
    expect(body).toContain(
      '[[ENG-1] Fix the thing](https://app.todoist.com/app/project/eng-1-fix-the-thing-p1)',
    );
  });

  it('tells the duplicate where the work continues', () => {
    expect(formatClosingComment({ ...base, absorbedInto: 'ENG-9' })).toContain(
      'marked a duplicate of ENG-9',
    );
  });

  it('tells the canonical issue what it absorbed, and that the tasks did not come with it', () => {
    const body = formatClosingComment({ ...base, absorbedFrom: 'ENG-2' });
    expect(body).toContain('absorbed from ENG-2');
    expect(body).toContain('**Its tasks were not moved here.**');
  });

  it('omits a section entirely when it has nothing in it', () => {
    const quiet = formatClosingComment({ ...base, completedTasks: [], outstandingTasks: [] });
    expect(quiet).not.toContain('Completed since last update');
    expect(quiet).not.toContain('Still outstanding');
    // Still posted: the record that the mirror was torn down is the point.
    expect(quiet).toContain('Todoist mirror archived.');
  });

  it('groups by section in Todoist order, like the daily digest', () => {
    const body = formatClosingComment({
      ...base,
      outstandingTasks: [
        { id: 'a', content: 'In second', sectionId: 's2' },
        { id: 'b', content: 'In first', sectionId: 's1' },
      ],
      sections: [
        { id: 's2', name: 'Second', order: 2 },
        { id: 's1', name: 'First', order: 1 },
      ],
    });
    expect(body.indexOf('**First**')).toBeLessThan(body.indexOf('**Second**'));
  });

  it('lists a recurring task as outstanding even when it was completed in the window', () => {
    // Deliberate, not a dedupe bug. Completing a recurring task reschedules it rather than
    // closing it, so it genuinely is both - and a recurrence still open when its project is
    // archived means nobody ended it first, which is worth surfacing rather than hiding.
    const body = formatClosingComment({
      ...base,
      completedTasks: [
        { content: 'Water the plants', completedAt: '2026-09-01T00:00:00.000Z', sectionId: null },
      ],
      outstandingTasks: [{ id: 'r1', content: 'Water the plants', sectionId: null }],
    });

    expect(body.split('Still outstanding')[0]).toContain('Water the plants');
    expect(body.split('Still outstanding')[1]).toContain('Water the plants');
  });
});
