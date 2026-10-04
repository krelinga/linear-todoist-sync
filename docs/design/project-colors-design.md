# Todoist Project Colors ↔ Linear State — Design Sketch

**Status:** design agreed, not implemented. Every decision below is settled; §8 records the
configuration surface.

Issue [#16](https://github.com/krelinga/linear-todoist-sync/issues/16): _"This would make it easy to skim the Todoist project list and understand what state the Linear project is in."_

## 1. What this adds

Today every mirrored Todoist project looks identical in the sidebar. Linear's `started`
category is not one state — a team can define several (`In Progress`, `In Review`, `Blocked`,
…), and today they all collapse into "has a project at all". This gives each _specific_ started
state its own Todoist project color, so the Todoist sidebar reads as a status board.

Scope is deliberately only the `started` states. An issue outside `started` has no active
mapping to color (§5.1), so there is nothing to express.

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
difference. No new state, no new storage, no change to §5's "rediscover everything" invariant.

## 3. The mapping

A started state is matched to a color **by state name**, matched case-insensitively and with
surrounding whitespace trimmed.

Names are what the user sees and are stable across teams; a state id is an opaque per-team UUID,
so an id-keyed mapping would need re-deriving for every team and would be unreadable in config.
Keying by name also means two teams that both call a state `In Progress` share one entry, which
is the intended behavior rather than a compromise.

The standing objection to names — that **renaming a state in Linear silently unmaps it** — is
what §4 exists to close.

Configured color values are validated at startup against the SDK's color list; an unknown key is
a `ConfigError` that refuses to boot, consistent with how every other setting fails closed
(`config.ts`).

## 4. Verifying the configured names against Linear

Validating color _keys_ locally is not enough: the failure that actually bites is a state **name**
that no longer exists — a typo, or a state renamed in Linear months after the config was written.
Both are invisible at runtime, because the service cannot tell "this state has no mapping" from
"this state's mapping was meant for a name that is now spelled differently". So at startup the
service fetches Linear's workflow states once and checks the config against reality.

The two directions are checked, and **they are deliberately not symmetrical**:

| Finding                                                 | Handling                | Why                                                                                                                                                                                                 |
| ------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A configured name matches no Linear state at all        | **Refuse to boot.**     | A name the config invented is a static mistake that will never fix itself. It silently produces default-colored projects forever, which looks exactly like a state nobody got round to configuring. |
| A configured name matches a state that is not `started` | **Refuse to boot.**     | Coloring is only defined for started states (§1), so `Done=green` is a misunderstanding of what the setting does, not a harmless extra.                                                             |
| A Linear `started` state is missing from the config     | **Warn, and carry on.** | Expected churn. Adding a state in Linear must not break the next restart of a service that is otherwise healthy, and §5 already defines a runtime behavior for it (the default color).              |

**If Linear is unreachable at boot, verification is skipped with a warning and the service
starts anyway.** This is the one part worth being explicit about: the alternative turns a Linear
API blip into a container that will not start. The service is already built to boot and run while
an API is down — the poll loop fails its cycle, reports through `sync_last_poll_result` and the
staleness alert (§8), and recovers on its own. Making startup depend on Linear would be the only
place in the service where an upstream outage is fatal, and it would trade a loud, self-healing
failure for a silent one, since a container that exits on boot stops producing metrics at all.

A skipped check is **retried on the poll loop until it succeeds once**, so "unverified" is a
transient state rather than one that persists until the next restart. §9.2 is where that comes
from: a boot-only attempt produces an alert whose only remediation is restarting the container.

This check does not live in `loadConfig`. That function is deliberately pure — env in, config
out, no I/O — which is what makes it exhaustively testable. Name verification is a separate
async step in `index.ts`, run after the clients are constructed and before the scheduler starts.

## 5. Reconciliation behavior

Color joins the existing per-cycle diff. Three rows, mirroring the ones already there:

| Trigger                                                              | Action                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue enters a started state                                         | The project is created with that state's mapped color — one call, since `addProject` takes name, description and color together.                                                                                                              |
| Issue moves between two started states (`In Progress` → `In Review`) | The project is recolored on the next poll. **This is the new transition**: today it produces no action at all, because both states are `started` and nothing else about the mapping changes.                                                  |
| A project's color is changed directly in Todoist                     | Reconciled back to the Linear-derived color, for the same reason a direct rename is — §2.3's locked-in "Linear wins". A hand-picked color on a mirrored project does not survive, which is the accepted cost of the row above working at all. |

**Unmapped started states fall back to a configured default color**, rather than leaving the
project's current color alone. Leaving it alone is less intrusive but makes the gap invisible —
a forgotten state looks identical to a correctly configured one. The fallback is logged naming
the state, and exposed as a gauge (§9.1) so "I added a state in Linear and forgot to configure
it" is visible in both the sidebar and the metrics. §4's boot warning catches the common case
earlier; §9 is what covers a state added, or renamed, while running.

**Folding into the existing action.** `updateProject` accepts `name` and `color` in one call, so
when both diverge they must be one write, not two. That argues for widening the existing
`rename_project` action into a single "reconcile the project's fields" action rather than adding
a parallel `recolor_project`. Note this touches §8: the `project_renamed` metric label needs
either a sibling label or an honest rename.

**On close-out.** When an issue leaves `started` the project is archived (§5.6) and its color is
**left exactly as it was** — the parallel of §5.4's frozen card subtitle. An archived project is
not in the sidebar this feature is about, and recoloring it would destroy the record of which
state work stopped in.

## 6. What this does not change

- No new durable state. The desired color is derived from Linear every cycle; the current color
  is read from Todoist every cycle. Nothing is cached or written to attachment metadata.
- The marker-scoping invariant is untouched: color is only ever written to a project whose
  description starts with `Linked Linear issue: ` (§6.2).
- No new API calls in the steady-state poll cycle. §4's `workflowStates` query runs once and
  then stops; it only recurs while it is failing, and stops for good after its first success.

## 7. Considered and rejected

**Deriving the Todoist color from Linear's own state color** (`#f2c94c` → nearest of the 20
Todoist hexes). Tempting: zero configuration, and new states are covered automatically with
colors that already match what the user sees in Linear. Rejected because "nearest hex" is not a
judgment a user can predict or override — Linear's default palette puts several states close
together, so two visually distinct Linear states can collapse onto the same Todoist color, losing
precisely the skimmability the issue asks for. An explicit mapping is a few lines of config and
is always exactly what was asked for.

_Revisit if_ the configured mapping becomes tedious to maintain across many teams — at which
point nearest-hex makes a reasonable **default** for states the config does not mention, instead
of a flat fallback color.

## 8. Configuration

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

The one shape this form cannot express is a state name containing a comma. That is an accepted
limit rather than a silent trap — such a name splits into fragments matching no Linear state, so
§4 refuses to boot and names them, instead of quietly coloring projects wrong.

`LINEAR_STATE_COLOR_DEFAULT` defaults to `charcoal` (the SDK's own default color) when unset.

**Why env vars and not a config file.** The service has **no volumes at all** (§9), and that is a
property worth protecting: every setting is an env var, validated at startup, and the container
has nothing to mount — which is also why total disk loss is not a recovery procedure here (§2.3).
A config file would be the first volume this service ever needed, and would add a reload question
(watch it? restart-only?) that env vars simply do not have. The state list is short enough that
an env var carries it comfortably.

§4 is what makes the compact form safe. The strongest argument for a file was that a hand-edited
list of names is easy to get subtly wrong; refusing to boot on a name Linear does not recognise
answers that directly. What a file would still buy over this is comments and room to grow, which
is not worth a volume today.

_Revisit if_ the mapping grows past roughly a screenful, or needs per-team entries — at which
point the §7 revisit condition probably applies first and removes most of the config instead.

**Rejected:** a JSON env var (`'{"In Progress":"blue"}'`). It handles state names containing `,`
or `=` safely, but those are vanishingly rare, and the cost is real: JSON is awkward to quote
correctly inside `.env` and `docker-compose.yml`, and a malformed brace produces a parse error
that names a character offset rather than the entry that is wrong.

**On implementation**, both vars land in `.env.example` and in the main design doc's §9
deployment table, and the new behavior rows fold into its §5.1/§5.2 tables and §8 metric list.

## 9. Monitoring

§4 verifies the config against Linear once, at startup, and then stops. That leaves two gaps it
structurally cannot close, and this section is about detecting both:

1. **A state is renamed in Linear while the container runs.** Verification already happened and
   will not happen again. The configured name now matches nothing, so projects quietly take the
   default color — and nothing about that looks different from a state nobody configured.
2. **Linear is unreachable, so verification never completes** (§4). The service is running
   on a config that has never been checked against reality, and will stay that way until the
   next restart, which could be months.

Both are silent, cosmetic-only failures. Neither corrupts anything or stops sync, so neither
deserves a page — but both are exactly the kind of thing that goes unnoticed for a quarter and
then takes an hour to work out from first principles, which is what the metrics below are for.

### 9.1 Metrics

The useful property here is that **the poll cycle already knows the answer**. It resolves every
started issue's state object anyway (§2), so it sees, every cycle, the actual set of state names
in use. No extra API calls, and no separate schedule to go stale.

| Metric                                 | Type  | Meaning                                                                                                                                                                                                                           |
| -------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync_state_color_unmapped{state}`     | gauge | Started issues seen in the last poll cycle whose state name has no configured color. One series per offending state name; **absent entirely when nothing is unmapped.**                                                           |
| `sync_state_color_verification_result` | gauge | `1` = §4's check completed against Linear, `0` = skipped because Linear was unreachable. **Absent until the first attempt resolves.**                                                                                             |
| `sync_state_colors_configured`         | gauge | Number of entries parsed out of `LINEAR_STATE_COLORS`. Diagnostic only — answers "is the running container actually using the config I think I deployed", which is otherwise a question you can only answer by `exec`ing into it. |

**Why `sync_state_color_unmapped` is a gauge keyed by state name, and not a counter.** An earlier
draft of §5 had this as a `sync_reconcile_actions_total{action="color_defaulted"}` counter, which
is wrong in a way worth recording. Color is only _written_ when it diverges, so once a
mis-colored project has settled at the default, no further writes happen and the counter stops
increasing — the metric would go quiet at precisely the moment the problem became permanent, and
read as "resolved". A gauge recomputed from each discovery pass says "three issues are in a state
I have no color for" for as long as that is true, and drops to nothing the moment it is fixed.
This is the same instrument choice §8.1 of the base doc already makes for `sync_mappings`:
current state is a gauge, throughput is a counter, and this question is current state.

**The `state` label is the point, not decoration.** Collapsing it to a single count would turn a
page that says _"Blocked has no color configured"_ into one that says _"something is unmapped"_,
leaving the operator to go find out which — and the whole failure mode here is not knowing. State
names are naturally low-cardinality (a handful per workspace), so the label is cheap.

**Implementation trap, and it is the one that would bite.** A labelled `prom-client` gauge keeps
every label combination it has ever been given. Set `{state="Blocked"}` once and it reports
forever, so the series would survive long after the state was configured, deleted, or renamed —
producing an alert that can never clear and no amount of fixing the config will silence. The
gauge must therefore be **`reset()` at the start of each cycle's metric update and repopulated
from that cycle's discovery**, so the exported set is exactly what the latest poll saw. Same
family as `unsetUntilFirstWrite` (§8.1 of the base doc): a stale sample is a confident lie, and
reporting nothing is the honest alternative.

**What this deliberately cannot see.** A configured state that currently holds no issues is
invisible to the poll — it sees state names, not state definitions, so an empty state that was
renamed raises nothing. That is the right behavior rather than a gap to close: an empty state has
no projects to mis-color, so the signal appears exactly when it starts to matter, which is when
an issue first enters it.

### 9.2 Making the skipped-verification alert worth having

An alert on "verification was skipped at boot" has an unsatisfying remediation: restart the
container and hope Linear answers this time. Worse, the condition is permanent — it will sit
firing until someone does.

So §4's check should **retry on the poll loop until it succeeds once**, rather than being a
single boot-time attempt. It is one cheap query, it stops after the first success, and it reuses
the retry and backoff machinery already wrapping every Linear call. That turns a permanent
unverified state into a transient one that almost always clears itself within a cycle or two,
and it turns the alert from "go restart the container" into "Linear has been unreachable long
enough that nothing has been verified", which is genuinely worth knowing and usually already
visible in `sync_api_requests_total{service="linear",result="error"}`.

This is a change to §4 rather than pure monitoring, and it is here because thinking about the
alert is what exposed it: a boot-only check produces an alert nobody can act on well.

### 9.3 Alert rules

Both are **warning** severity. Colors being wrong is cosmetic — reconciliation is still correct
and nothing is at risk — so neither should page.

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
            color. Most likely the state was renamed in Linear, or added since the
            config was last touched.

      - alert: LinearStateColorConfigUnverified
        expr: max_over_time(sync_state_color_verification_result[1h]) == 0
        labels:
          severity: warning
        annotations:
          summary: State colour config has not been verified against Linear
          description: >-
            Linear was unreachable every time the config check ran in the last hour,
            so the configured state names have never been confirmed to exist. Colours
            may be silently defaulting. Check Linear API reachability.
```

Grafana Cloud takes this YAML as-is through the Mimir ruler (`mimirtool rules load`), or the same
two expressions can be pasted into the UI's rule builder.

**Why each expression is shaped the way it is:**

- **`max_over_time(…[15m])`** on both, in place of a `for:` clause — the idiom the webhook doc
  already settled on (webhook §8.4). One window instead of a threshold plus a duration, and a
  single odd poll cycle is ridden out by construction. The cost is symmetric and worth knowing:
  after you fix the config, the alert takes up to the window length to clear.

- **`max by (state)`** keeps one alert instance per offending state, which is what makes the
  annotation able to name it. Grafana's rule builder is happy with this — a multi-dimensional
  rule produces one alert instance per label set, which is the desired behavior here. Note this
  is **the opposite choice** from webhook §8.4, which deliberately collapses to a single
  number with `max(…)`; there the labels carried no information worth alerting per-value on,
  here they are the entire payload.

- **No `or vector(0)` on either rule, and that is deliberate.** The base and webhook docs both
  lean on `or vector(0)` to make a _vanished_ series fire instead of evaporating, so its absence
  here needs justifying rather than assuming it was forgotten. The direction of the fallback is
  what differs: for `probe_success`, absence means the thing being watched is gone, which is bad.
  For both metrics here, absence means either nothing is unmapped (the healthy state, for the
  first rule) or the container is not running — and _that_ is already the poll-staleness rule's
  job (base §8.2). Adding `or vector(0)` would make every restart and every scrape gap raise
  these two alerts alongside the staleness one, three pages for one outage, and would train
  everyone to ignore them.

- **`max_over_time(… ) == 0`** rather than a bare `== 0` for the verification gauge: the `0` is
  sticky until a check succeeds, so this reads as "no successful verification anywhere in the
  last hour" and clears on its own the moment §9.2's retry lands one. A bare `== 0` would also
  work, but would fire within one scrape of a boot that happened during a brief Linear blip,
  which is noise.

One accepted hole: if a future change stops setting `sync_state_color_verification_result`
altogether, the series is simply absent and the second rule goes quiet. `absent_over_time` would
catch it, at the price of firing on every legitimately-unset boot window — the same trade §8.1 of
the base doc describes for its unset gauges. Not worth it for a cosmetic-severity signal.

### 9.4 What to check when `LinearStateColorUnmapped` fires

In rough order of likelihood:

1. Was the state **renamed** in Linear? The alert's `state` label is the _current_ Linear name;
   compare it against `LINEAR_STATE_COLORS`. This is the case §4 cannot catch.
2. Was a **new started state added**? Same fix, different cause.
3. Did a state's **type** change — something previously `unstarted` moved into the `started`
   category? It now has projects and needs a color.
4. Is the running container using the config you think it is? Compare
   `sync_state_colors_configured` against the number of entries you expect.
