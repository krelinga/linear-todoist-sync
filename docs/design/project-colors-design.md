# Todoist Project Colors ↔ Linear State — Design Sketch

**Status:** design agreed, not implemented. Every decision below is settled; §8 records the
configuration surface.

Issue [#16](https://github.com/krelinga/linear-todoist-sync/issues/16): *"This would make it easy to skim the Todoist project list and understand what state the Linear project is in."*

## 1. What this adds

Today every mirrored Todoist project looks identical in the sidebar. Linear's `started`
category is not one state — a team can define several (`In Progress`, `In Review`, `Blocked`,
…), and today they all collapse into "has a project at all". This gives each *specific* started
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

That last point matters: color reconciles by exactly the mechanism the project *name* already
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

## 4. Verifying the configured names against Linear at boot

Validating color *keys* locally is not enough: the failure that actually bites is a state **name**
that no longer exists — a typo, or a state renamed in Linear months after the config was written.
Both are invisible at runtime, because the service cannot tell "this state has no mapping" from
"this state's mapping was meant for a name that is now spelled differently". So at startup the
service fetches Linear's workflow states once and checks the config against reality.

The two directions are checked, and **they are deliberately not symmetrical**:

| Finding | Handling | Why |
|---|---|---|
| A configured name matches no Linear state at all | **Refuse to boot.** | A name the config invented is a static mistake that will never fix itself. It silently produces default-colored projects forever, which looks exactly like a state nobody got round to configuring. |
| A configured name matches a state that is not `started` | **Refuse to boot.** | Coloring is only defined for started states (§1), so `Done=green` is a misunderstanding of what the setting does, not a harmless extra. |
| A Linear `started` state is missing from the config | **Warn, and carry on.** | Expected churn. Adding a state in Linear must not break the next restart of a service that is otherwise healthy, and §5 already defines a runtime behavior for it (the default color). |

**If Linear is unreachable at boot, verification is skipped with a warning and the service
starts anyway.** This is the one part worth being explicit about: the alternative turns a Linear
API blip into a container that will not start. The service is already built to boot and run while
an API is down — the poll loop fails its cycle, reports through `sync_last_poll_result` and the
staleness alert (§8), and recovers on its own. Making startup depend on Linear would be the only
place in the service where an upstream outage is fatal, and it would trade a loud, self-healing
failure for a silent one, since a container that exits on boot stops producing metrics at all.

This check does not live in `loadConfig`. That function is deliberately pure — env in, config
out, no I/O — which is what makes it exhaustively testable. Name verification is a separate
async step in `index.ts`, run after the clients are constructed and before the scheduler starts.

## 5. Reconciliation behavior

Color joins the existing per-cycle diff. Three rows, mirroring the ones already there:

| Trigger | Action |
|---|---|
| Issue enters a started state | The project is created with that state's mapped color — one call, since `addProject` takes name, description and color together. |
| Issue moves between two started states (`In Progress` → `In Review`) | The project is recolored on the next poll. **This is the new transition**: today it produces no action at all, because both states are `started` and nothing else about the mapping changes. |
| A project's color is changed directly in Todoist | Reconciled back to the Linear-derived color, for the same reason a direct rename is — §2.3's locked-in "Linear wins". A hand-picked color on a mirrored project does not survive, which is the accepted cost of the row above working at all. |

**Unmapped started states fall back to a configured default color**, rather than leaving the
project's current color alone. Leaving it alone is less intrusive but makes the gap invisible —
a forgotten state looks identical to a correctly configured one. The fallback is logged naming
the state, and counted in `reconcile_actions_total` under its own label, so "I added a state in
Linear and forgot to configure it" is visible in both the sidebar and the metrics. §4's boot
warning catches the common case earlier; this is what covers a state added while running.

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
- No new API calls in the poll cycle. The single `workflowStates` query in §4 happens once, at
  boot.

## 7. Considered and rejected

**Deriving the Todoist color from Linear's own state color** (`#f2c94c` → nearest of the 20
Todoist hexes). Tempting: zero configuration, and new states are covered automatically with
colors that already match what the user sees in Linear. Rejected because "nearest hex" is not a
judgment a user can predict or override — Linear's default palette puts several states close
together, so two visually distinct Linear states can collapse onto the same Todoist color, losing
precisely the skimmability the issue asks for. An explicit mapping is a few lines of config and
is always exactly what was asked for.

*Revisit if* the configured mapping becomes tedious to maintain across many teams — at which
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

*Revisit if* the mapping grows past roughly a screenful, or needs per-team entries — at which
point the §7 revisit condition probably applies first and removes most of the config instead.

**Rejected:** a JSON env var (`'{"In Progress":"blue"}'`). It handles state names containing `,`
or `=` safely, but those are vanishingly rare, and the cost is real: JSON is awkward to quote
correctly inside `.env` and `docker-compose.yml`, and a malformed brace produces a parse error
that names a character offset rather than the entry that is wrong.

**On implementation**, both vars land in `.env.example` and in the main design doc's §9
deployment table, and the new behavior rows fold into its §5.1/§5.2 tables and §8 metric list.
