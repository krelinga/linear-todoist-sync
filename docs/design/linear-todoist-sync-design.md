# Linear ↔ Todoist Sync Service — Design Document

## 1. Purpose

Mirror Linear's "in progress" work into Todoist as projects, so that day-to-day task tracking happens in Todoist while Linear stays the system of record for issue status. A daily job reports completed Todoist tasks back to Linear as a comment, closing the loop.

The two systems also link to each other directly: each in-progress Linear issue shows an info card pointing at its Todoist project (with a live outstanding-task count), and each Todoist project's description links back to the originating Linear issue — so either system is one click from the other.

This service is self-hosted, single-user, and runs as one Docker container in a homelab.

## 2. Requirements

### 2.1 Functional

- Every Linear issue whose workflow state is in the "started" (in progress) category has exactly one corresponding Todoist project.
- State transitions (full list in §5) keep the two systems reconciled automatically, with Linear treated as the source of truth for an issue's lifecycle and naming.
- Once a day, each active mapping gets a Linear comment summarizing Todoist tasks completed since the last run.
- Each in-progress issue's Linear page shows an info card linking to its Todoist project, with a live count of outstanding tasks (see §5.4).
- Each mapped Todoist project's description links back to the originating Linear issue (see §6.2).

### 2.2 Non-functional

- Self-hosted in a single Docker container, no external dependencies beyond the Linear and Todoist APIs.
- No inbound exposure of the homelab to the public internet (see §4.2).
- Single user, single Linear workspace, single Todoist account. Not designed for multi-tenant use.
- Near-real-time is nice to have; a delay of up to ~1 minute on any transition is acceptable.
- Exposes Prometheus-compatible metrics so the rest of the homelab's monitoring stack can tell whether syncing is actually healthy (see §8).
- No local database: all durable sync state lives in Linear and Todoist themselves (see §5.4, §6), not in anything this service alone holds.

### 2.3 Decisions locked in for this design

These came out of requirements review with the user:

| Decision | Choice |
|---|---|
| Runtime | TypeScript / Node.js |
| Poll interval | 1 minute |
| Todoist project renamed directly (not via Linear) | Linear wins — name is reconciled back on the next poll |
| Outstanding Todoist tasks when an issue leaves "in progress" | Leave tasks as-is in the archived project, and post a note calling them out — no automatic deletion or reassignment |
| Backfill on first run | Yes — create projects for issues already in progress |
| Auth | Personal API token (Linear) / personal API token (Todoist) — single user, no OAuth app needed |
| Persistent sync state | Stored entirely in Linear (attachment metadata) and Todoist (project description) — no local database |

**Runtime rationale:** Both Linear and Todoist publish official, actively maintained TypeScript SDKs — `@linear/sdk` and `@doist/todoist-sdk` respectively. Python only has an official SDK on the Todoist side (`todoist-api-python`); Linear's official SDK is TypeScript-only, so Python would mean falling back to a community GraphQL wrapper for half the integration. TypeScript is the only runtime with first-party tooling for both APIs, which makes it the clear choice over the earlier Python pick.

**Statelessness rationale:** once the bi-directional links in §5.4 exist anyway, nearly everything a local database would hold turns out to be redundant with, or trivially derivable from, data already sitting in Linear and Todoist — see §6 for the field-by-field breakdown. Removing the database entirely means recovery from any kind of data loss (a wiped disk, a botched deploy, moving to a new host) is not a special procedure — it's exactly what every other poll cycle already does. There's no backup strategy to build or test, and no separate "is my cache still accurate" failure mode to worry about.

## 3. High-level architecture

```
                    ┌─────────────────────────────┐
                    │   Docker container (1 proc) │
                    │                              │
   Linear API  <───►│  Poller (every 1 min)        │
                    │    - read "started" issues   │
                    │      + their marked cards     │
                    │    - read marked Todoist      │
                    │      projects (active +       │
                    │      archived)                 │
                    │    - reconcile the two,       │
                    │      refresh info card +      │
                    │      task counts               │
                    │                              │
   Todoist API <───►│  Daily digest job (1x/day)   │
                    │    - completed tasks →        │
                    │      Linear comment            │
                    │    - reads/writes its         │
                    │      watermark via the         │
                    │      Linear attachment         │
                    │                              │
                    │  No local database — all      │
                    │  durable state lives in       │
                    │  Linear + Todoist (§5.4, §6)  │
                    └─────────────────────────────┘
```

One process, two internal schedules (a 1-minute reconciliation loop and a once-daily digest job). Nothing is written to local disk except, optionally, logs. The only thing the process keeps in its own memory is a couple of API sync cursors used purely to make polling cheap (§6.3) — and even those are safe to lose on restart.

## 4. Pull vs. push: why polling, and what that means for Tailscale

### 4.1 The trade-off as originally framed

Linear and Todoist both support webhooks, but a webhook receiver needs a publicly reachable HTTPS endpoint. Exposing anything from the homelab to the internet — even narrowly — is the thing you wanted to avoid or at least do carefully, and Tailscale's answer to "expose selectively" is real:

- **Tailscale Serve** — exposes a service only to devices already on your tailnet. Private, but useless for receiving webhooks from Linear/Todoist's servers, which aren't on your tailnet.
- **Tailscale Funnel** — exposes a service to the public internet, but routed through Tailscale's infrastructure with automatic TLS and no port-forwarding or NAT config on your router. This is the feature that would actually let Linear/Todoist reach a local webhook receiver, and it's meaningfully safer than opening a port yourself (your home IP stays hidden, Tailscale terminates TLS, you can pull it down instantly).

### 4.2 Why this design skips both, for now

Both APIs support cheap, incremental polling, which removes the need for inbound exposure entirely:

- **Todoist**: the Sync API supports an incremental `sync_token` — each poll fetches only what changed since the last one, not a full project/task dump. This token lives in process memory only (§6.3); losing it on restart costs one full resync, not correctness.
- **Linear**: the GraphQL API lets you filter issues by `updatedAt` and by workflow state `type`, so a poll can ask specifically "what changed in started-category issues since my last check" instead of pulling the whole workspace. Same deal — this cursor is in-memory only.

Combined with a 1-minute poll interval, this gets latency close to what a webhook would give you, with zero inbound exposure, zero public DNS, zero TLS certs to manage, and no dependency on Tailscale Funnel staying up. It's simpler to operate and there's less that can go wrong from a security standpoint.

**Revisit if:** 1-minute latency ever feels too slow, or API rate limits become a real constraint (unlikely at single-workspace scale — Todoist allows on the order of 1,000 requests per 15-minute window per token, and Linear's per-key limits are generous — though the stateless design in §5/§6 does mean somewhat more live reads per poll than a local-cache design would). There are two levers, cheapest first: lengthen the poll interval (5 or 15 minutes costs very little in a personal tool, and everything in §5 stays correct regardless of cadence), and only after that, build a lightweight webhook receiver behind Tailscale Funnel whose sole job is to trigger an immediate poll when something actually changes — not to replace polling as the source of truth, just to cut the number of poll cycles that turn up nothing to do. Because the reconciler is already fully stateless and idempotent, adding a webhook nudge later is a pure latency/volume optimization, not a rearchitecture — it slots in without touching the reconciliation logic in §5 at all.

### 4.3 Rate limiting and retries

Every call to either API goes through the same retry wrapper, rather than each call site handling failure differently:

- On an HTTP `429` or `5xx` response, retry with exponential backoff: start at 1s, double each attempt, cap at 60s, with a little jitter added so retries don't cluster. Give up after 5 attempts within a single poll cycle.
- If the response includes a `Retry-After` header, that value is used verbatim instead of the computed backoff — the API's own guidance wins.
- If retries are exhausted, the poll cycle is simply marked failed (`sync_poll_runs_total{result="error"}`, §8) and reconciliation resumes on the next cycle. No special recovery logic is needed here: because reconciliation is full-state-diff based (§5), a failed cycle just means "try again in a minute," not "figure out what was missed."
- Backoff state isn't persisted across poll cycles — each cycle starts clean, so a bad patch of failures doesn't compound into an ever-growing wait.
- `sync_api_requests_total{service, result="rate_limited"}` (§8) surfaces if either upstream is being hit harder than expected, without needing a dedicated alert for it.

## 5. State machine

The core mental model: every poll cycle, discover the current state of both systems directly — there is no local memory of "what I did last time" to consult. Concretely:

1. Fetch Linear issues where workflow state `type == started`. This is the "should have an active Todoist project" set.
2. Fetch Todoist projects carrying this service's marker (§5.4, §6.1) — both active and archived. Active marked projects are the "currently believed in-progress" set; archived marked projects are the "previously in-progress, now closed out" set. This live query plays exactly the role a local `issue_project_map` table used to play, except it can never drift out of sync with reality, because it *is* reality.
3. Cross-reference the two sets and apply whichever transition below matches each mismatch.

Because there's no separate cache to consult, recovery isn't a distinct procedure: a cold start with nothing cached runs the exact same three steps as every other poll cycle. Losing a fresh install, an old install, or a corrupted one all look identical from here, since there was never any local state to lose in the first place.

### 5.1 Linear-originated transitions

| Trigger | Action |
|---|---|
| Issue enters "started" category (new, or re-entering after having left) | If no active marked Todoist project is found for this issue, search archived marked projects first — if one matches, unarchive it and un-freeze its attachment card (preserves task history) instead of creating a new one. Otherwise, create a fresh Todoist project named from the issue (§6.2), set its description to link back to the Linear issue (§6.2), and create a Linear attachment card linking to the Todoist project (§5.4). |
| In-progress issue's title changes | Reconciliation renames the Todoist project to match on the next poll. (Same code path handles the Todoist-side rename conflict in §5.2 — the app always pushes Linear's title as truth.) |
| In-progress issue moves to another state (Todo, Done, Canceled, etc.) | Post a Todoist project comment calling out any incomplete tasks, archive the Todoist project, and update the Linear attachment card's subtitle to a frozen "archived" summary (§5.4). Tasks are left exactly as they are — no auto-complete, no move. The Todoist project's own archived flag is now the record of this; nothing else needs updating. |
| In-progress issue is deleted outright | Rename the Todoist project with a `[LOST] ` prefix (e.g. `[LOST] [ENG-123] Fix the flaky login test`) and otherwise leave it exactly as-is — no archiving, no touching tasks, nothing deleted. Unlike leaving "started" for another state, there's no surviving Linear issue to comment on or reconcile against, so this is the most that can safely be done automatically; a human decides what to do with it from there. The prefix also makes this idempotent: once a project's name already carries `[LOST] `, later polls skip it instead of re-checking every cycle. |

This is a deliberate design invariant, not just a choice for this one case: nothing in this service ever issues a delete call against a Todoist project. The closest thing to it, §5.2's response to a project that's already been deleted directly in Todoist, only ever creates a replacement — it never removes anything itself. A bug that mismatches a project to the wrong issue can, at worst, mislabel or misfile something; it can't destroy data.

### 5.2 Todoist-originated transitions

| Trigger | Action |
|---|---|
| A tracked (active) Todoist project is archived directly by the user | Unarchived on the next poll — while the Linear issue is still "started", Linear owns the project's lifecycle. |
| A tracked project is renamed directly | Reconciled back to the Linear-derived name on the next poll ("Linear wins," per §2.3). |
| A tracked project is deleted outright (not archived) | Its history can't be recovered either way, so the simplest path is taken: a fresh Todoist project is created and linked exactly as in the "issue enters started" case (§5.1). A Linear comment notes that the previous project was deleted and a new one was created, so the swap isn't silent. The event is counted separately (`project_recreated`, §8) for visibility. |
| A task is manually added to a mirrored project | No special handling needed — it's just a normal Todoist task. It shows up in the daily digest like any other completed task, and (per §2.3) stays in the project through an eventual archive. |

### 5.3 Operational edge cases

| Case | Handling |
|---|---|
| Service is down for a while, then restarts | No different from any other poll cycle (§5): the next run discovers current reality from Linear and Todoist directly and reconciles it, same as it does every minute. The digest watermark (`lastDigestAt`, stored in the Linear attachment's metadata, §5.4/§6.1) means a delayed digest run simply covers the longer elapsed window instead of losing data. |
| Local state (or the whole container's disk) is lost | Not a special case at all — see the row above. The next poll cycle just runs its normal discovery pass; since Linear and Todoist hold all the durable state, there's nothing to restore. See §9 for why this also means there's no backup story to build. |
| Two issues transition into "started" in the same poll cycle | Not a race in practice — one poll cycle processes the whole set sequentially in a single process, and a simple in-process lock ensures only one poll runs at a time. Because project creation always does a live search for an existing marked project before creating a new one (§5.1), that search is itself the safeguard against duplicates — there's no separate uniqueness constraint to maintain, since there's no local table to enforce one on. |
| The daily digest job's scheduled time falls in the middle of a poll cycle | The in-process lock above isn't scoped to the poll loop alone — it's shared with the digest job, so the two never run concurrently. This matters because both write to the same Linear attachment (the poll refreshes the task-count subtitle, §5.4; the digest reads and rewrites `lastDigestAt`, §7): without a shared lock, a `attachmentUpdate` from one could race the other's read-modify-write and silently clobber it — most dangerously, the poll's subtitle refresh overwriting the digest's fresh `lastDigestAt` with the stale value it read before the digest ran, causing tasks to be double-reported the next day. Whichever one is scheduled to start simply waits for the other to finish; at this service's scale that's a negligible delay, not a design compromise. |

### 5.4 Bi-directional linking (and the state it carries)

Two persistent links keep the systems cross-referenceable — and, since there's no local database, they're also now the *entire* durable state this service has. There is nothing else.

- **Todoist → Linear**: the project's `description` field (Todoist added project and section descriptions in 2026) is set once, at creation time, to a link back to the originating Linear issue — e.g. `Linked Linear issue: https://linear.app/<workspace>/issue/ENG-123`. It's a create-time write, not something that needs polling; it only changes again if the mapping is later recreated (e.g. after the Todoist project was deleted outright and auto-recreated, §5.2). The Linear issue identifier embedded in this URL is also what discovery uses to confirm a match found via the Linear-side card, or to locate the right project when scanning for one that's lost its card.

- **Linear → Todoist**: a Linear attachment — Linear's "info card" mechanism, created via `attachmentCreate` — is added to the issue at the same time, linking to the Todoist project URL, with `iconUrl` set to a small, already publicly hosted Todoist icon (`https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/todoist.png`, served via the open-source dashboard-icons project's jsDelivr CDN — no icon hosting of our own required). Its subtitle carries the live outstanding-task count (e.g. "7 tasks outstanding") and is refreshed on every poll cycle. This is cheap: the task list for a mapped project is already in memory from the Todoist Sync API delta fetch, so computing the count is a local operation, not an extra API call. The card is only *written* back to Linear when the count actually changes, to avoid noisy no-op writes.

  Confirmed against Linear's schema: `attachmentUpdate` takes the existing attachment's `id` plus an `input` object (e.g. `{ subtitle: "7 tasks outstanding" }`) and updates those fields directly — no delete/recreate cycle needed, so refreshing the count is a single cheap mutation.

  Each poll finds the relevant attachment fresh — by listing the issue's attachments and matching on the marker in its `metadata` (§6.1) — rather than remembering an attachment ID from a previous run. This is what makes the no-local-database approach work: there's no ID to lose, because none is ever assumed to still be known.

  The attachment's `metadata` also carries the one piece of state that has no natural home anywhere else: the daily digest's watermark (§6.1, §7). Everything else this service used to cache locally (task counts, titles, which project belongs to which issue) is cheap enough to just recompute live from what §5's discovery pass already fetched.

  When a project archives (its issue leaves "in progress"), the card is left in place rather than deleted — its subtitle gets one last update, something like "Archived — 3 tasks were outstanding," matching the "leave things as-is" philosophy already used for the tasks themselves (§2.3). That keeps the issue's history intact instead of erasing the card.

## 6. State schema

No local database — everything durable lives in the Linear attachment and the Todoist project description created for each mapping (§5.4). This section is the schema reference for both, plus the one bit of state that's allowed to be ephemeral.

### 6.1 Linear attachment metadata

Set at creation time via `attachmentCreate`, updated via `attachmentUpdate` (§5.4):

| Field | Type | Notes |
|---|---|---|
| `title` / `subtitle` | string | Display fields — subtitle carries the live outstanding-task count, or the frozen "archived" summary once the mapping is archived |
| `url` | string | The Todoist project URL. This is what makes the card clickable, and it's also where the Todoist project ID lives — no separate field needed, it's just parsed out of the URL during discovery |
| `iconUrl` | string | The publicly hosted Todoist icon (§5.4) |
| `metadata.syncApp` | string | Fixed marker, e.g. `"linear-todoist-sync"` — how the poller recognizes its own cards during discovery, as opposed to some other integration's attachment on the same issue |
| `metadata.schemaVersion` | number | Bumped if this schema's shape changes, so a future version of the poller can tell an older card apart from a current one during discovery |
| `metadata.lastDigestAt` | string (ISO 8601 timestamp) | High-water mark for "already reported" completions (§7) — the one field with no natural home in either system's own data model, so it rides along here instead |

### 6.2 Todoist project naming and description

`[ENG-123] Fix the flaky login test` — the Linear identifier as a stable prefix (so collisions and re-parenting are easy to reason about) plus the current title. Regenerated from Linear on every poll; if it doesn't match what's in Todoist, it gets pushed.

Todoist added project (and section) descriptions in 2026. Traceability back to Linear uses that field directly: `Linked Linear issue: <url>`, set once at creation time — durable, and readable by discovery (§5.4) without needing a comment thread parsed or a local table consulted.

### 6.3 In-memory-only performance state

Two values exist purely to make polling cheap, and neither is ever written to disk:

- Todoist's `sync_token`, for incremental fetches of task and project data instead of a full dump every cycle.
- Linear's `updatedAt` cursor, for the same reason on the issue side.

Both live as plain variables in the running process. Losing them (a restart, a crash) costs exactly one full fetch on the next cycle to rebuild them — not a correctness problem, just a marginally more expensive single poll. This is deliberate: nothing about correctness is allowed to depend on these surviving a restart, only the discovery-based reconciliation in §5.

## 7. Daily digest job

Runs once a day at a configurable local time (env var, default e.g. `07:00`), on its own schedule separate from the 1-minute poll loop — but not concurrently with it: both write to the same Linear attachment, so they share the in-process lock described in §5.3 to avoid one job's `attachmentUpdate` stomping the other's.

For each active mapping (discovered per §5 — a Linear "started" issue with a matching marked Todoist project):

1. Read `lastDigestAt` from the Linear attachment's metadata (§6.1).
2. Query Todoist for tasks completed in this project with `completed_at > lastDigestAt`.
3. If none, skip — no comment posted, and no metadata write either (avoids noise on quiet days).
4. Otherwise, group the completed tasks by Todoist section (section names come from the same in-memory, incrementally-synced Todoist state used for task counts in §5.4, so no extra API call is needed here), post a Linear comment on the issue, and write the new `lastDigestAt` back into the attachment's metadata via `attachmentUpdate` — ideally batched into the same mutation that also refreshes the outstanding-task-count subtitle, since both are just fields on one call.

Because the watermark is read from Linear rather than a local table, a missed run (container down overnight) just picks up a bigger batch the next time it reads a stale `lastDigestAt` — nothing is silently dropped, and there's no separate recovery behavior to reason about.

**Formatting:** tasks with no section are listed first, unlabeled; any sectioned tasks follow under a bold section-name label, in Todoist's own section order (not alphabetical) so the comment matches what you'd see in the app. A project that doesn't use sections at all ends up looking like a plain flat list — the structure only appears when it's actually there to help. Subtasks aren't a consideration: these Todoist projects aren't expected to use them, so every completed task is treated as top-level.

```
Completed since last update:

- Fix null pointer in auth middleware

**Backend**
- Add retry logic to the sync job
- Write integration test for retry logic

**Frontend**
- Update error toast copy
```

## 8. Observability

To let the rest of the homelab keep an eye on this without checking logs, the service exposes a `/metrics` endpoint in Prometheus text format via `prom-client` (the standard Node.js client library). A local Prometheus server scrapes it like any other exporter — a 30–60s scrape interval is a reasonable match for the app's own 1-minute poll cadence.

### 8.1 What gets exported

**Health / freshness — the signal that actually matters, is sync still happening:**

| Metric | Type | Meaning |
|---|---|---|
| `sync_last_poll_success_timestamp_seconds` | gauge | Unix time of the last poll that completed without error. Its age is the best "is this stuck" signal. |
| `sync_last_poll_result` | gauge | `1` = last poll succeeded, `0` = failed |
| `sync_last_digest_run_timestamp_seconds` | gauge | Unix time of the last completed digest run |
| `sync_last_digest_result` | gauge | `1` = last digest run succeeded, `0` = failed |

**Volume / throughput:**

| Metric | Type | Meaning |
|---|---|---|
| `sync_poll_runs_total{result}` | counter | `result="success"` \| `"error"`, one per poll cycle |
| `sync_poll_duration_seconds` | histogram | Time taken per poll cycle |
| `sync_reconcile_actions_total{action}` | counter | `action="project_created"` \| `"project_renamed"` \| `"project_archived"` \| `"project_unarchived"` \| `"project_recreated"` \| `"card_reattached"` \| `"project_marked_lost"` \| `"comment_posted"` \| `"card_updated"` |
| `sync_digest_comments_posted_total` | counter | Digest comments actually posted (excludes runs skipped for having nothing to report) |

**Upstream API health:**

| Metric | Type | Meaning |
|---|---|---|
| `sync_api_requests_total{service, result}` | counter | `service="linear"` \| `"todoist"`, `result="success"` \| `"error"` \| `"rate_limited"` |
| `sync_api_request_duration_seconds{service}` | histogram | Request latency to each upstream |

**Current mapping state (a snapshot, not a rate):**

| Metric | Type | Meaning |
|---|---|---|
| `sync_mappings{status}` | gauge | Count of currently discovered mappings by state (`active`, `archived`) — computed fresh from each poll's discovery pass (§5), not read from a local table, since there isn't one. |

### 8.2 Suggested alerts

One rule covers the case worth waking up for; everything else in §8.1 is diagnostic detail you'd only check after it fires:

- **Sync is stuck:** `time() - sync_last_poll_success_timestamp_seconds > 300` — no successful poll in 5 minutes, well past the expected 1-minute cadence.

Todoist projects deleted outright, or cards that go missing, are self-healed automatically (§5.2, §5.4) rather than requiring manual intervention, so there's no alert for either case — but `sync_reconcile_actions_total{action="project_recreated"}` and `action="card_reattached"` are both there to glance at if you're curious how often self-healing actually kicks in.

`action="project_marked_lost"` (§5.1) is different in kind — it's not self-healing, it's a marker that a human needs to eventually look at and decide what to do with. It's not urgent enough to page on, but it's worth an occasional glance (or a low-priority alert if `[LOST]` projects start piling up) since nothing in this design will ever clean one of those up on its own.

### 8.3 Implementation notes

- Metrics live in `prom-client`'s default in-process registry and reflect current values on every scrape — no pushgateway needed, since this is a long-running container rather than a batch job.
- The digest job updates its own gauges/counters independently of the poll loop, since it runs on a separate once-daily schedule.
- Because there's no local table to query for a cheap snapshot, `sync_mappings` is populated from the most recent poll's discovery results, cached in memory for the metrics endpoint to read — not re-queried from Todoist/Linear on every Prometheus scrape, since scrape interval and poll interval aren't the same cadence.

### 8.4 Scrape configuration

Assume the homelab's existing Prometheus instance doesn't auto-discover new containers — add a static scrape target for this one rather than relying on discovery:

```yaml
scrape_configs:
  - job_name: linear-todoist-sync
    static_configs:
      - targets: ["<host-or-container-address>:9464"]
```

Use the host's LAN address (or its Tailscale IP, if Prometheus reaches it through Serve per §9) rather than a bare container name, unless Prometheus and this container happen to share a Docker network.

## 9. Deployment

Single Docker container, single process (an internal scheduler runs both the 1-minute poll and the once-daily digest — no need for cron or a second container).

```yaml
services:
  linear-todoist-sync:
    build: .
    restart: unless-stopped
    environment:
      LINEAR_API_KEY: ${LINEAR_API_KEY}
      TODOIST_API_TOKEN: ${TODOIST_API_TOKEN}
      POLL_INTERVAL_SECONDS: 60
      DIGEST_TIME: "07:00"
      DIGEST_TIMEZONE: "America/Chicago"
      METRICS_PORT: 9464
    ports:
      - "9464:9464"
```

No `volumes:` entry — there's nothing local that needs to survive a restart (§5.4, §6).

The metrics port is the one intentional exception to "no inbound exposure": Prometheus has to be able to reach it. Publishing it on the Docker network is fine as long as your Prometheus server lives on the same LAN — that's still entirely internal, not the internet-exposure trade-off from §4. If your Prometheus instance lives elsewhere on the tailnet instead, put this port behind **Tailscale Serve** (§4.2) rather than opening it more broadly — Serve is exactly the tailnet-only, no-public-exposure fit for "another one of my own machines needs to reach this," as opposed to Funnel, which is for the public internet reaching in. Everything else about the container's networking is unchanged: it makes outbound calls to `api.linear.app` and `api.todoist.com`, and nothing about it needs to be reachable from outside your LAN/tailnet.

**Backups:** not needed. There's no local, authoritative state to lose — Linear and Todoist hold it all (§5.4, §6). Recovering from total data loss (a wiped disk, a botched container recreation, even moving this service to an entirely new host) is identical to any other cold start: point it at the same Linear workspace and Todoist account, let the first poll cycle run its normal discovery pass (§5), and it's back to a fully correct state within one poll interval. The earlier revision of this design that used a local SQLite file needed a backup strategy; removing that file removed the need for one along with it.

## 10. Trade-offs and what to revisit

| Decision | Trade-off | Revisit when |
|---|---|---|
| Polling instead of webhooks | Up to ~1 min latency vs. instant; simpler and no exposure | Latency feels too slow, or you want push as a low-latency nudge on top of polling (via Tailscale Funnel) |
| No local database — all durable state lives in Linear (attachment metadata) and Todoist (project description) | Removes an entire class of failure (DB loss, corruption, backup/restore) and makes cold-start recovery identical to normal operation (§5.3) — but costs more live API reads per poll than a local-cache design would, and means a multi-step write (create project, then create its card) has to be resumable rather than atomic | The live-discovery reads start showing up meaningfully in rate-limit metrics (§8) — first lever is a longer poll interval, second is a webhook-triggered poll to cut idle cycles (§4.2) |
| Full-state reconciliation instead of an event log | Simpler to reason about, self-healing after downtime or total data loss alike; can't reconstruct arbitrary historical audit trails | You need a real audit log of every change, not just current-state correctness |
| "Linear wins" on naming conflicts | Blunt — silently overwrites a manual Todoist rename with no warning | This becomes annoying in practice; could add a manual-override flag instead |
| Personal API tokens instead of OAuth | Much simpler for single-user self-hosting | You ever want multi-user support |
| TypeScript over Python/Go | Only runtime with official SDKs on both sides (`@linear/sdk` and `@doist/todoist-sdk`) | Operational footprint (binary size, memory) becomes a priority — Go would be the next choice |
| Prometheus pull metrics, published port instead of push/pushgateway | Matches how the rest of a typical homelab Prometheus setup already scrapes exporters; requires the metrics port to be reachable from wherever Prometheus runs | You want metrics visible from outside the LAN/tailnet too — same Tailscale Serve vs. Funnel trade-off as §4 applies |
| Linear card left in place (frozen) on archive, instead of deleted | Keeps issue history intact; means a closed issue permanently shows a "3 tasks were outstanding" card even if you don't care anymore | This clutters old issues in practice — deleting the attachment on archive would be a small change |
| Auto-recreate the Todoist project if it's deleted outright, instead of requiring manual re-link | Simplest implementation — this is now just the same live search-before-create logic every poll already runs, not a special case — and self-healing, but any comments or task-completion history inside the deleted project are gone for good, silently, aside from a log line and a Linear comment | Accidental project deletions turn out to be common enough that you'd rather be asked before a replacement is created |
| Rename-and-leave (`[LOST] ` prefix) instead of deleting a Todoist project when its Linear issue is deleted | Never destroys data, and keeps the invariant that this service never issues a delete call against a Todoist project — a mismatch bug can mislabel something but can't destroy it. Trade-off is that `[LOST]` projects accumulate indefinitely with no automatic cleanup | These pile up enough to be annoying; could add an optional "archive `[LOST]` projects older than N days" pass, still short of an outright delete |
