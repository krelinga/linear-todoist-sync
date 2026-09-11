import { parseLinkedIssueUrl } from '../naming.js';
import { withContext } from '../errors.js';
import type { LinearPort } from '../clients/linear.js';
import type { TodoistPort } from '../clients/todoist.js';
import type { OrphanedProject, IssueMapping, Snapshot, TodoistProjectSummary } from '../types.js';

/** Extracts e.g. "ENG-123" from a Linear issue URL like `.../issue/ENG-123/some-slug`. */
function parseIssueIdentifierFromUrl(url: string): string | null {
  const match = /\/issue\/([A-Za-z0-9]+-\d+)/.exec(url);
  return match ? (match[1] ?? null) : null;
}

/**
 * Gathers the current state of both systems (§5 steps 1-2) and cross-references them (§5 step
 * 3) into a plain snapshot. Makes no decisions - that's plan.ts's job - but does resolve
 * whatever extra data a decision will need, since plan.ts is not allowed to fetch anything
 * itself.
 */
export async function discover(linear: LinearPort, todoist: TodoistPort): Promise<Snapshot> {
  const [issues, projects] = await Promise.all([
    withContext('Failed to list started Linear issues', { phase: 'discover' }, () =>
      linear.getStartedIssues(),
    ),
    withContext('Failed to list marked Todoist projects', { phase: 'discover' }, () =>
      todoist.getMarkedProjects(),
    ),
  ]);

  // Keyed by Linear issue identifier (e.g. "ENG-123"), not the full issue URL: the URL carries a
  // title-derived slug that changes whenever the issue is renamed, which would otherwise break
  // matching on every title edit - exactly the transition §5.1's rename_project exists to handle.
  const projectByIssueIdentifier = new Map<string, TodoistProjectSummary>();
  for (const project of projects) {
    const issueUrl = parseLinkedIssueUrl(project.description);
    const identifier = issueUrl ? parseIssueIdentifierFromUrl(issueUrl) : null;
    if (identifier && !projectByIssueIdentifier.has(identifier)) {
      projectByIssueIdentifier.set(identifier, project);
    }
  }

  const matchedProjectIds = new Set<string>();
  const mappings: IssueMapping[] = await Promise.all(
    issues.map(async (issue) => {
      const matchedProject = projectByIssueIdentifier.get(issue.identifier) ?? null;
      if (matchedProject) {
        matchedProjectIds.add(matchedProject.id);
      }
      const attachment = await withContext(
        "Failed to read a started issue's Linear attachment card",
        {
          phase: 'discover',
          issue: issue.identifier,
          issueId: issue.id,
          issueUrl: issue.url,
          todoistProject: matchedProject?.name,
          todoistProjectId: matchedProject?.id,
        },
        () => linear.getMarkerAttachment(issue.id),
      );
      return { issue, matchedProject, attachment };
    }),
  );

  const orphanProjects = projects.filter((project) => !matchedProjectIds.has(project.id));
  const orphans: OrphanedProject[] = await Promise.all(
    orphanProjects.map(async (project) => {
      const issueUrl = parseLinkedIssueUrl(project.description);
      const identifier = issueUrl ? parseIssueIdentifierFromUrl(issueUrl) : null;
      // The identifier here came out of the project's own description, so this lookup is the one
      // place a stale or hand-edited link surfaces - name both sides, since the failure could be
      // the project's link or the issue itself.
      const linkedIssue = identifier
        ? await withContext(
            'Failed to look up the Linear issue linked from a Todoist project',
            {
              phase: 'discover',
              todoistProject: project.name,
              todoistProjectId: project.id,
              todoistProjectUrl: project.url,
              linkedIssue: identifier,
              linkedIssueUrl: issueUrl,
            },
            () => linear.getIssue(identifier),
          )
        : null;
      return { project, linkedIssue };
    }),
  );

  return { mappings, orphans };
}
