# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repository currently contains **no implementation** — only a design document (`docs/design/linear-todoist-sync-design.md`) and a devcontainer setup. There is no `package.json`, source directory, build tooling, or test suite yet. When asked to implement this service, treat the design document as the authoritative spec and follow it closely rather than inventing alternative architecture — it reflects decisions already locked in with the user (§2.3), including several explicit rationale sections explaining *why* alternatives were rejected.

## What this service does

A single-process, self-hosted sync service that mirrors Linear's "in progress" issues into Todoist projects, so day-to-day task tracking happens in Todoist while Linear remains the system of record. A daily job reports completed Todoist tasks back to Linear as a comment. Runs as one Docker container in a homelab, single user, single Linear workspace, single Todoist account.

## Key architectural decisions (see design doc for full rationale)

- **Runtime**: TypeScript / Node.js — the only runtime with official SDKs for both APIs (`@linear/sdk`, `@doist/todoist-sdk`).
- **No local database.** All durable state lives in Linear and Todoist themselves:
  - **Linear → Todoist** link: a Linear attachment (`attachmentCreate`/`attachmentUpdate`) on the issue, carrying a `metadata.syncApp` marker, `metadata.schemaVersion`, and `metadata.lastDigestAt` (the digest watermark — the one piece of state with no natural home elsewhere).
  - **Todoist → Linear** link: the Todoist project's `description` field, set once at creation to a link back to the Linear issue.
  - Two in-memory-only performance cursors (Todoist `sync_token`, Linear `updatedAt`) exist purely to make polling cheap and are safe to lose on restart.
- **Full-state reconciliation, not an event log.** Every poll cycle rediscovers the current state of both systems from scratch (Linear issues with `state.type == started`, Todoist projects carrying the service's marker) and diffs them — there is no cached "what I did last time." This makes cold start, crash recovery, and total disk loss all identical to a normal poll cycle (§5, §9).
- **Polling, not webhooks** — 1-minute interval, no inbound exposure of the homelab required. Revisit only if latency or rate limits become a real problem (§4.2); a webhook could later be added purely as a "trigger an immediate poll" nudge without changing the reconciliation logic.
- **Linear wins** on any conflict (title/name divergence) — Todoist-side edits are reconciled back to match Linear on the next poll.
- **Never deletes Todoist projects.** The service will create, rename, archive, and unarchive projects, but never issues a delete call. If a Linear issue is deleted, the corresponding project is renamed with a `[LOST] ` prefix and left alone (idempotent — later polls skip already-prefixed projects) rather than removed.
- **Single in-process lock** shared between the 1-minute poll loop and the once-daily digest job, since both can write to the same Linear attachment and must never run concurrently.
- **Retry policy**: exponential backoff (1s → 60s cap, jittered, 5 attempts per poll cycle) on `429`/`5xx`, honoring `Retry-After` when present; backoff state is not persisted across poll cycles.
- **Observability**: Prometheus metrics via `prom-client` on `/metrics` (default port `9464`). The single alert that matters is poll staleness: `time() - sync_last_poll_success_timestamp_seconds > 300`.

## Where to look for details

The design doc is organized by concern — consult the relevant section rather than re-deriving behavior:

- §5 — the state machine (Linear-originated transitions, Todoist-originated transitions, operational edge cases like concurrent transitions or restarts, and the bi-directional linking mechanism).
- §6 — exact schema of what's stored in the Linear attachment and Todoist project description.
- §7 — daily digest job logic and comment formatting.
- §8 — metrics names, types, and what each one means.
- §9 — deployment (single Docker container, env vars, no volumes).
- §10 — a table of every major trade-off and the condition under which it should be revisited.

## Working in this repo

- Since there's no local database, any implementation work should preserve the "discover everything fresh from Linear/Todoist every poll cycle" invariant (§5) — do not introduce local caching of mapping state as a shortcut, since that reintroduces the drift/corruption failure modes the design deliberately avoids.
- The service must never call a Todoist project delete endpoint — this is a hard invariant (§5.1), not a style preference.
- When creating a Todoist project for an issue, always search existing (active + archived) marked projects first before creating a new one — this live search is what prevents duplicate projects, since there's no uniqueness constraint to fall back on (§5.3).
- The reconciler must never read, match, rename, archive, or otherwise act on a Todoist project unless its description starts with the exact `Linked Linear issue: ` marker (§6.2) — this is what scopes every write this service performs to projects it manages itself, as opposed to a user's other, unrelated Todoist projects (verified live: several poll cycles left unrelated projects, including a similarly-worded-but-non-matching description, byte-for-byte unchanged). This filtering happens once, at the client layer (`getMarkedProjects` in `src/clients/todoist.ts`) — nothing downstream should add its own separate marker check.
