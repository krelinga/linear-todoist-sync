# linear-todoist-sync

Mirrors Linear's "in progress" issues into Todoist projects, so day-to-day task
tracking happens in Todoist while Linear stays the system of record. A daily
job reports completed Todoist tasks back to Linear as a comment. Self-hosted,
single-user, runs as one Docker container.

Full design rationale, the state machine, and every edge case this service
handles live in [`docs/design/linear-todoist-sync-design.md`](docs/design/linear-todoist-sync-design.md)
— this README only covers running it.

## Scope

Safe to run against a Todoist account that already has other, unrelated
projects in it: this service only ever reads, renames, archives, or
otherwise touches a Todoist project if its description starts with the
exact `Linked Linear issue: <url>` marker it writes at creation time. Any
other project - including one with a similar-looking but non-matching
description - is left alone entirely.

## Configuration

Copy `.env.example` to `.env` and fill in both API tokens:

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `LINEAR_API_KEY` | yes | - | Personal API token from [Linear settings](https://linear.app/settings/account/security) |
| `TODOIST_API_TOKEN` | yes | - | Personal API token from [Todoist integration settings](https://app.todoist.com/app/settings/integrations/developer) |
| `POLL_INTERVAL_SECONDS` | no | `60` | How often the reconciliation loop runs |
| `DIGEST_TIME` | no | `07:00` | Local time (24-hour `HH:MM`) the daily digest comment runs |
| `DIGEST_TIMEZONE` | no | `UTC` | IANA time zone `DIGEST_TIME` is interpreted in |
| `METRICS_PORT` | no | `9464` | Port serving Prometheus-format metrics at `/metrics` |

## Running with Docker (recommended)

```sh
docker compose up --build -d
```

Reads `LINEAR_API_KEY` and `TODOIST_API_TOKEN` from a `.env` file in this
directory automatically (that's a Docker Compose feature, not something this
app does itself) - `docker-compose.yml` already sets the other variables. No
volumes are mounted; there's no local state that needs to survive a restart.

## Local development

Requires Node.js 20+.

```sh
npm install
set -a && source .env && set +a   # load .env into the shell for the commands below
npm run dev                        # runs src/index.ts directly, restarts on change
npm test                           # vitest
npm run typecheck
npm run lint
npm run build && npm start         # compile to dist/ and run the compiled output
```

The app reads configuration straight from `process.env` - there's no
built-in `.env` loader, so local runs need the variables exported into the
shell first (as above), same as any other env var.

## Release

```sh
npm version <newversion>   # e.g. npm version minor - bumps package.json and
                            # package-lock.json together, commits, and tags
git push && git push --tags
```

Then run the **Release Docker image** workflow from the repo's Actions tab
(Actions → Release Docker image → Run workflow). It's manually triggered, not
run automatically on push or tag - see
[`.github/workflows/release-docker.yml`](.github/workflows/release-docker.yml).
It builds the image and pushes it to GitHub Container Registry at
`ghcr.io/krelinga/linear-todoist-sync`, tagged with the `major`,
`major.minor`, and `major.minor.patch` versions read from `package.json` at
run time (e.g. `:0`, `:0.1`, `:0.1.0`), plus `:latest` - so it always
reflects whatever version is on `main` when you run it, not the commit that
triggered it.

## Observability

`/metrics` on `METRICS_PORT` serves Prometheus text format. The one metric
worth alerting on is poll staleness:

```
time() - sync_last_poll_success_timestamp_seconds > 300
```

See §8 of the design doc for the full metric list.
