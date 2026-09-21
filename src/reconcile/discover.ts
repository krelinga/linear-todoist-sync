import { cardPointsAtProject, parseLinkedIssueUrl } from '../naming.js';
import { withContext } from '../errors.js';
import type { LinearPort } from '../clients/linear.js';
import type { TodoistPort } from '../clients/todoist.js';
import type {
  OrphanedProject,
  IssueMapping,
  LinearAttachmentSummary,
  Snapshot,
  TodoistProjectSummary,
} from '../types.js';

/** Extracts e.g. "ENG-123" from a Linear issue URL like `.../issue/ENG-123/some-slug`. */
function parseIssueIdentifierFromUrl(url: string): string | null {
  const match = /\/issue\/([A-Za-z0-9]+-\d+)/.exec(url);
  return match ? (match[1] ?? null) : null;
}

/**
 * Picks which of an issue's marker cards is really its own, and marks the rest for deletion.
 *
 * An issue should only ever hold one, but Linear moves a duplicate's attachments onto the
 * canonical issue when the relation is created, so marking B a duplicate of A leaves A holding
 * B's card as well - ahead of its own in Linear's ordering, which is why taking the first match
 * picked the wrong one (#1).
 *
 * The Todoist project is what disambiguates them: the issue's own card is the one pointing at
 * the project this issue is currently matched to. Preferring it over position also preserves
 * the digest watermark, which lives in that card's metadata (§6.1) - keeping the stray instead
 * would abandon `lastDigestAt` and re-report everything already digested.
 *
 * Matched on project **id** rather than by comparing URLs: a project URL embeds a slug of its
 * name, the service renames projects on every issue title change, and a card's URL is never
 * rewritten - so URLs diverge on the first rename. Comparing them would then find no match
 * here, fall back to position, and delete the issue's own card as the stray.
 *
 * With no matched project, only a card whose project has genuinely vanished can be this
 * issue's own - that is §5.2 row 3, the project deleted outright in Todoist, and it is what
 * `recreate_project` exists for. A card pointing at a project that still exists somewhere
 * (archived, and belonging to whichever issue this one absorbed) is a stray no matter what
 * position it holds.
 *
 * Distinguishing those two matters because they are handled oppositely. Adopting a displaced
 * card here made the reconciler announce "the previously linked project appears to have been
 * deleted outright" on an issue whose project was alive and archived and had never been its
 * own - a false statement, posted once and kept forever, on an issue that had simply absorbed
 * a duplicate while sitting in the backlog.
 */
function chooseCard(
  cards: LinearAttachmentSummary[],
  matchedProject: TodoistProjectSummary | null,
  allProjects: TodoistProjectSummary[],
): { attachment: LinearAttachmentSummary | null; strayAttachments: LinearAttachmentSummary[] } {
  const stillExists = (card: LinearAttachmentSummary): boolean =>
    allProjects.some((project) => cardPointsAtProject(card.url, project.id));

  const attachment = matchedProject
    ? (cards.find((card) => cardPointsAtProject(card.url, matchedProject.id)) ?? null)
    : (cards.find((card) => !stillExists(card)) ?? null);

  return {
    attachment,
    strayAttachments: cards.filter((card) => card.id !== attachment?.id),
  };
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
      const cards = await withContext(
        "Failed to read a started issue's Linear attachment cards",
        {
          phase: 'discover',
          issue: issue.identifier,
          issueId: issue.id,
          issueUrl: issue.url,
          todoistProject: matchedProject?.name,
          todoistProjectId: matchedProject?.id,
        },
        () => linear.getMarkerAttachments(issue.id),
      );
      const { attachment, strayAttachments } = chooseCard(cards, matchedProject, projects);
      return { issue, matchedProject, attachment, strayAttachments };
    }),
  );

  // A card displaced onto another issue is the only surviving copy of its project's digest
  // watermark, and the same cycle deletes it as a stray. Cross-referencing here captures the
  // metadata while it is still in hand, so the two actions need no ordering between them.
  const displacedCards = mappings.flatMap((mapping) => mapping.strayAttachments);

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
      const displacedCard =
        displacedCards.find((card) => cardPointsAtProject(card.url, project.id)) ?? null;
      return { project, linkedIssue, displacedCard };
    }),
  );

  return { mappings, orphans };
}
