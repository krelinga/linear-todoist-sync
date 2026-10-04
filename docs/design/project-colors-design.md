# Todoist Project Colors ↔ Linear State — Design Sketch

**Status:** design agreed, not implemented.

**Section references:** bare `§N` refers to _this_ doc; the base design doc is cited as
`base §N` and the webhook doc as `webhook §N`, matching the convention those two already use
between themselves.

Issue [#16](https://github.com/krelinga/linear-todoist-sync/issues/16): _"This would make it easy to skim the Todoist project list and understand what state the Linear project is in."_

## 1. What this adds

Today every mirrored Todoist project looks identical in the sidebar. Linear's `started` category
is not one state — a team can define several (`In Progress`, `In Review`, `Blocked`, …), and
today they all collapse into "has a project at all". This gives each _specific_ started state its
own Todoist project color, so the Todoist sidebar reads as a status board.

Scope is deliberately only the `started` states. An issue outside `started` has no active mapping
to color (base §5.1), so there is nothing to express.

## 2. What the APIs give us

Both halves already exist, which is why this is small:

- **Linear** — a workflow state carries `id`, `name`, `type`, and its own `color` hex
  (`In Progress` → `#f2c94c`). Verified live. The reconciler **already resolves the full state
  object** for every started issue (`resolveStateType` awaits `issue.state` and keeps only
  `.type`), so reading the state's name costs **zero additional API calls**.
- **Todoist** — a fixed palette of **20** colors, keyed by string (`berry_red`, `sky_blue`,
  `grape`, …; `@doist/todoist-sdk` exports the list as `colors` plus a `ColorKey` type).
  `addProject` and `updateProject` both accept `color?: ColorKey`, and a project's response
  carries `color`, so divergence is detectable. Verified against the installed SDK.

That last point matters: color reconciles by exactly the mechanism the project _name_ already
uses — read current value, compare against the Linear-derived desired value, write only on
difference. No new state, no new storage, no change to base §5's "rediscover everything"
invariant.

## 3. The mapping

A started state is matched to a color **by state name**, matched case-insensitively and with
surrounding whitespace trimmed.

Names are what the user sees and are stable across teams; a state id is an opaque per-team UUID,
so an id-keyed mapping would need re-deriving for every team and would be unreadable in config.
Keying by name also means two teams that both call a state `In Progress` share one entry, which
is the intended behavior rather than a compromise.

The standing objection to names is that **renaming a state in Linear silently unmaps it**. §6 is
what closes that, and it closes it at runtime — which is the only place it can be closed, since
a rename happens long after any startup check would have run.

Configured color values are validated at startup against the SDK's color list; an unknown key is
a `ConfigError` that refuses to boot, consistent with how every other setting fails closed
(`config.ts`). Note what that validates and what it does not: color _keys_ are a fixed,
locally-known list, so they are checkable offline. State _names_ are not, and §8 explains why no
attempt is made to check them at startup either.

## 4. Configuration

Two env vars, in the compact `Name=color` form:

```
LINEAR_STATE_COLORS="In Progress=blue,In Review=grape,Blocked=red"
LINEAR_STATE_COLOR_DEFAULT=charcoal
```

Parsing rules: entries split on `,`, and each entry on its **last** `=` — a color key never
contains `=`, so splitting from the right lets a state name contain one. Names are trimmed and
matched case-insensitively (§3). An empty or absent `LINEAR_STATE_COLORS` means no state is
mapped and every project gets the default, which is a legitimate "off" setting rather than an
error. A duplicate name is a `ConfigError` rather than last-one-wins: the two entries disagree
about intent, and guessing which was meant is worse than saying so.

The one shape this form cannot express is a state name containing a comma. Such a name splits
into fragments matching no Linear state, so its projects take the default color and the state
shows up in §6's unmapped gauge like any other gap — the same signal, reached by a different
cause.

`LINEAR_STATE_COLOR_DEFAULT` defaults to `charcoal` (the SDK's own default color) when unset.

**The parsed mapping is logged once at startup**, as a single line naming each state and the
color it resolved to. With no startup verification against Linear (§8), this log line plus
`sync_state_colors_configured` (§6.1) are what answer "is the running container using the config
I think I deployed" — a question otherwise only answerable by `exec`ing into it.

**Why env vars and not a config file.** The service has **no volumes at all** (base §9), and that
is a property worth protecting: every setting is an env var, validated at startup, and the
container has nothing to mount — which is also why total disk loss is not a recovery procedure
here (base §2.3). A config file would be the first volume this service ever needed, and would add
a reload question (watch it? restart-only?) that env vars simply do not have. The state list is
short enough that an env var carries it comfortably. What a file would buy over this is comments
and room to grow, which is not worth a volume today.

_Revisit if_ the mapping grows past roughly a screenful, or needs per-team entries — at which
point §8's nearest-hex revisit condition probably applies first and removes most of the config
instead.

## 5. Reconciliation behavior

Color joins the existing per-cycle diff. Three rows, mirroring the ones already there:

| Trigger                                                              | Action                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue enters a started state                                         | The project is created with that state's mapped color — one call, since `addProject` takes name, description and color together.                                                                                                                   |
| Issue moves between two started states (`In Progress` → `In Review`) | The project is recolored on the next poll. **This is the new transition**: today it produces no action at all, because both states are `started` and nothing else about the mapping changes.                                                       |
| A project's color is changed directly in Todoist                     | Reconciled back to the Linear-derived color, for the same reason a direct rename is — base §2.3's locked-in "Linear wins". A hand-picked color on a mirrored project does not survive, which is the accepted cost of the row above working at all. |

**Unmapped started states fall back to a configured default color**, rather than leaving the
project's current color alone. Leaving it alone is less intrusive but makes the gap invisible — a
forgotten state looks identical to a correctly configured one. The fallback is logged naming the
state, and exposed as a gauge (§6.1), which is the whole detection story for a state that is
added, renamed, or mistyped.

**Folding into the existing action.** `updateProject` accepts `name` and `color` in one call, so
when both diverge they must be one write, not two. That argues for widening the existing
`rename_project` action into a single "reconcile the project's fields" action rather than adding
a parallel `recolor_project`. Note this touches base §8: the `project_renamed` metric label needs
either a sibling label or an honest rename.

**On close-out.** When an issue leaves `started` the project is archived (base §5.6) and its color
is **left exactly as it was** — the parallel of base §5.4's frozen card subtitle. An archived
project is not in the sidebar this feature is about, and recoloring it would destroy the record of
which state work stopped in.

## 6. Monitoring

One failure mode matters, and it has several causes that all look identical from the outside:
**a started state the config has no color for**, whether because it was renamed in Linear, newly
added, mistyped in the config, or had its type changed into `started`. In every case the projects
quietly take the default color, sync stays correct, and nothing else looks wrong.

That is cosmetic, so it does not deserve a page. It is also exactly the profile of a thing that
goes unnoticed for a quarter and then takes an hour to reason out from first principles, which is
what the gauge below is for.

### 6.1 Metrics

The useful property is that **the poll cycle already knows the answer**. It resolves every started
issue's state object anyway (§2), so it sees, every cycle, the actual set of state names in use.
No extra API calls, and no separate schedule to go stale.

| Metric                             | Type  | Meaning                                                                                                                                                                 |
| ---------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync_state_color_unmapped{state}` | gauge | Started issues seen in the last poll cycle whose state name has no configured color. One series per offending state name; **absent entirely when nothing is unmapped.** |
| `sync_state_colors_configured`     | gauge | Number of entries parsed out of `LINEAR_STATE_COLORS`. Diagnostic only, and the metric half of §4's startup log line.                                                   |

**Why a gauge keyed by state name, and not a counter.** An earlier draft of §5 had this as a
`sync_reconcile_actions_total{action="color_defaulted"}` counter, which is wrong in a way worth
recording. Color is only _written_ when it diverges, so once a mis-colored project has settled at
the default, no further writes happen and the counter stops increasing — the metric would go quiet
at precisely the moment the problem became permanent, and read as "resolved". A gauge recomputed
from each discovery pass says "three issues are in a state I have no color for" for as long as
that is true, and drops to nothing the moment it is fixed. This is the same instrument choice
base §8.1 already makes for `sync_mappings`: current state is a gauge, throughput is a counter,
and this question is current state.

**The `state` label is the point, not decoration.** Collapsing it to a single count would turn an
alert that says _"Blocked has no color configured"_ into one that says _"something is unmapped"_,
leaving the operator to go find out which — and not knowing which is the entire failure mode.
State names are naturally low-cardinality (a handful per workspace), so the label is cheap.

**It names the state Linear currently uses, which is what makes a rename diagnosable.** After a
rename the gauge reports the _new_ name, so the alert hands over one half of the comparison and
`LINEAR_STATE_COLORS` is the other. A mistyped entry surfaces the same way: the typo leaves the
real state unmapped, so the gauge names the real state and the config is where the discrepancy
is visible.

**Implementation trap, and it is the one that would bite.** A labelled `prom-client` gauge keeps
every label combination it has ever been given. Set `{state="Blocked"}` once and it reports
forever, so the series would survive long after the state was configured, deleted, or renamed —
producing an alert that can never clear and no amount of fixing the config will silence. The gauge
must therefore be **`reset()` at the start of each cycle's metric update and repopulated from that
cycle's discovery**, so the exported set is exactly what the latest poll saw. Same family as
`unsetUntilFirstWrite` (base §8.1): a stale sample is a confident lie, and reporting nothing is
the honest alternative.

**What this deliberately cannot see.** Two things, both benign:

- **A configured state holding no issues.** The poll sees state names in use, not state
  definitions, so an empty state that was renamed or mistyped raises nothing. This is the right
  behavior rather than a gap to close: an empty state has no projects to mis-color, so the signal
  appears exactly when it starts to matter, which is when an issue first enters it.
- **An entry naming a real state that is not `started`** — `Done=green`. Nothing is ever colored
  by it, so nothing is ever unmapped, so the gauge stays silent. The entry is inert rather than
  harmful, and §8 records why catching it was judged not worth a startup check.

### 6.2 Alert rule

**Warning** severity. Colors being wrong is cosmetic — reconciliation is still correct and nothing
is at risk — so this should not page.

```yaml
groups:
  - name: linear-todoist-sync-colors
    interval: 1m
    rules:
      - alert: LinearStateColorUnmapped
        expr: max by (state) (max_over_time(sync_state_color_unmapped[15m])) > 0
        labels:
          severity: warning
        annotations:
          summary: 'Linear state "{{ $labels.state }}" has no configured Todoist color'
          description: >-
            {{ $value }} in-progress issue(s) are in a state with no entry in
            LINEAR_STATE_COLORS, so their Todoist projects are taking the default
            color. Most likely the state was renamed in Linear, added since the
            config was last touched, or misspelled in it.
```

Grafana Cloud takes this YAML as-is through the Mimir ruler (`mimirtool rules load`), or the same
expression can be pasted into the UI's rule builder.

**Why the expression is shaped the way it is:**

- **`max_over_time(…[15m])`** in place of a `for:` clause — the idiom webhook §8.4 already settled
  on. One window instead of a threshold plus a duration, and a single odd poll cycle is ridden out
  by construction. The cost is symmetric and worth knowing: after you fix the config, the alert
  takes up to the window length to clear.

- **`max by (state)`** keeps one alert instance per offending state, which is what lets the
  annotation name it. Grafana's rule builder is happy with this — a multi-dimensional rule
  produces one alert instance per label set, which is the desired behavior here. Note this is
  **the opposite choice** from webhook §8.4, which deliberately collapses to a single number with
  `max(…)`; there the labels carried no information worth alerting per-value on, here they are the
  entire payload.

- **No `or vector(0)`, and that is deliberate.** The base and webhook docs both lean on it to make
  a _vanished_ series fire instead of evaporating, so its absence here needs justifying rather
  than looking like an oversight. The direction of the fallback is what differs: for
  `probe_success`, absence means the thing being watched is gone, which is bad. Here absence means
  either nothing is unmapped — the healthy state — or the container is not running, and _that_ is
  already the poll-staleness rule's job (base §8.2). Adding `or vector(0)` would make every
  restart and every scrape gap raise this alongside the staleness alert, two alerts for one
  outage, and would train everyone to ignore them.

### 6.3 What to check when it fires

In rough order of likelihood:

1. Was the state **renamed** in Linear? The alert's `state` label is the current Linear name;
   compare it against `LINEAR_STATE_COLORS`.
2. Was a **new started state added**? Same fix, different cause.
3. Is the name **misspelled** in the config? Presents identically to a rename — the real state is
   the one that shows up unmapped.
4. Did a state's **type** change — something previously `unstarted` moved into the `started`
   category? It now has projects and needs a color.
5. Is the running container using the config you think it is? Compare
   `sync_state_colors_configured` against the number of entries you expect, or read §4's startup
   log line.

## 7. What this does not change

- No new durable state. The desired color is derived from Linear every cycle; the current color is
  read from Todoist every cycle. Nothing is cached or written to attachment metadata.
- The marker-scoping invariant is untouched: color is only ever written to a project whose
  description starts with `Linked Linear issue: ` (base §6.2).
- **No new API calls anywhere**, in the poll cycle or at startup. Everything this feature needs
  from Linear is already being fetched.
- Nothing about startup. The service still boots on local config validation alone, with no
  dependency on Linear being reachable — see §8.

## 8. Considered and rejected

### Verifying the configured state names against Linear at startup

The idea: fetch Linear's workflow states once at boot, refuse to start on a configured name that
matches no state (or matches a non-`started` one), and warn on a started state the config does not
mention. It was fully specified in an earlier draft of this doc and then removed, which is worth
recording so it does not get re-proposed as an obvious missing safeguard.

**It turned out to be almost entirely redundant with §6.** Checked cause by cause:

| Startup check would catch                        | §6's gauge                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| A started state missing from the config          | Covered, and better — fires only once issues actually exist in that state, so it cannot nag about a state with nothing in it.         |
| A configured name matching no Linear state       | Covered. A typo leaves the _real_ state unmapped, so the gauge names the real state and the config is where the discrepancy shows up. |
| A configured name matching a non-`started` state | **Not covered.** Nothing is colored by it, so nothing is unmapped and the gauge stays silent.                                         |

So the entire unique yield is the last row: an entry like `Done=green` that does nothing. That is
dead config with no runtime consequence — the user's expectation is wrong, but nothing is
mis-colored, nothing drifts, and the mistake is visible the moment they look at Todoist.

**What it would have cost** for that one row: an async startup step outside the otherwise pure
`loadConfig`; a new way for the container to refuse to boot; a branch for "Linear unreachable at
boot, skip and carry on"; a retry loop so that skip did not persist until the next restart; a
`sync_state_color_verification_result` gauge; and a second alert rule whose only remediation was
usually "wait, or restart the container". Each piece existed to shore up the piece before it, and
none of them were load-bearing for the failure that actually happens.

It also would have made startup the **only** place in this service where an upstream outage could
be fatal — a property the base design deliberately does not have, and one that needed its own
mitigation (the skip branch) precisely because it was undesirable. Dropping the check removes the
problem rather than mitigating it.

_Revisit if_ inert config entries turn out to be a real source of confusion in practice — at
which point the cheap version is a warning log line at startup, with no refuse-to-boot path, no
metric, and no alert.

### Deriving the Todoist color from Linear's own state color

Mapping `#f2c94c` to the nearest of the 20 Todoist hexes. Tempting: zero configuration, and new
states are covered automatically with colors that already match what the user sees in Linear.
Rejected because "nearest hex" is not a judgment a user can predict or override — Linear's default
palette puts several states close together, so two visually distinct Linear states can collapse
onto the same Todoist color, losing precisely the skimmability the issue asks for. An explicit
mapping is a few lines of config and is always exactly what was asked for.

_Revisit if_ the configured mapping becomes tedious to maintain across many teams — at which point
nearest-hex makes a reasonable **default** for states the config does not mention, instead of a
flat fallback color.

### A JSON env var for the mapping

`LINEAR_STATE_COLORS='{"In Progress":"blue"}'`. It handles state names containing `,` or `=`
safely, but those are vanishingly rare, and the cost is real: JSON is awkward to quote correctly
inside `.env` and `docker-compose.yml`, and a malformed brace produces a parse error that names a
character offset rather than the entry that is wrong.

## 9. On implementation

Both env vars land in `.env.example` and in the base doc's §9 deployment table; the new behavior
rows fold into its §5.1/§5.2 tables, and the new gauge plus the `project_renamed` label question
(§5) into its §8.
