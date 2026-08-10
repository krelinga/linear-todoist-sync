import { parseLinkedIssueUrl } from '../naming.js';
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
    linear.getStartedIssues(),
    todoist.getMarkedProjects(),
  ]);

  const projectByIssueUrl = new Map<string, TodoistProjectSummary>();
  for (const project of projects) {
    const issueUrl = parseLinkedIssueUrl(project.description);
    if (issueUrl && !projectByIssueUrl.has(issueUrl)) {
      projectByIssueUrl.set(issueUrl, project);
    }
  }

  const matchedProjectIds = new Set<string>();
  const mappings: IssueMapping[] = await Promise.all(
    issues.map(async (issue) => {
      const matchedProject = projectByIssueUrl.get(issue.url) ?? null;
      if (matchedProject) {
        matchedProjectIds.add(matchedProject.id);
      }
      const attachment = await linear.getMarkerAttachment(issue.id);
      return { issue, matchedProject, attachment };
    }),
  );

  const orphanProjects = projects.filter((project) => !matchedProjectIds.has(project.id));
  const orphans: OrphanedProject[] = await Promise.all(
    orphanProjects.map(async (project) => {
      const issueUrl = parseLinkedIssueUrl(project.description);
      const identifier = issueUrl ? parseIssueIdentifierFromUrl(issueUrl) : null;
      const linkedIssue = identifier ? await linear.getIssue(identifier) : null;
      return { project, linkedIssue };
    }),
  );

  return { mappings, orphans };
}
