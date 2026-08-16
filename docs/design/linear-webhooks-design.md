# Linear Webhooks — Push-Based Sync Design Document

## 1. Purpose and relationship to the base design

The base design (`linear-todoist-sync-design.md`, referenced below as **base §N**) deliberately chose polling over webhooks and left an explicit escape hatch open in base §4.2:

> build a lightweight webhook receiver behind Tailscale Funnel whose sole job is to trigger an immediate poll when something actually changes — not to replace polling as the source of truth […] Because the reconciler is already fully stateless and idempotent, adding a webhook nudge later is a pure latency/volume optimization, not a rearchitecture.

This document is that escape hatch being taken, in exactly the form base §4.1/§4.2 anticipated — Tailscale Funnel as the ingress — with one narrowing: **Linear only.** Todoist stays on the existing poll path (§12).

The goal is to cut Linear→Todoist latency from "up to ~1 minute" to "a couple of seconds," and to stop burning a poll cycle every minute on a workspace where nothing changed.

**Serve vs. Funnel.** Both appear in this system and they are not interchangeable — base §4.1 draws the distinction and base §9 already proposes Serve for the metrics port:

- **Serve** — tailnet-only. Correct for `/metrics` (base §9). Can bind any port.
- **Funnel** — public internet. The only one that can receive Linear's webhooks. Restricted to ports `443`, `8443`, `10000`.

Both are configured by the *same* `tailscaled`, often in the same config file. §5.4 is about keeping that from becoming an accident.

## 2. What changes, and what explicitly does not

### 2.1 Unchanged — the invariants this design must not break

Everything in base §5 and base §6 stands. In particular:

- **Full-state reconciliation stays the only way state is changed.** A webhook never mutates Todoist or Linear directly. It requests a reconciliation cycle, and that cycle is the same `discover → plan → apply` pass (`src/reconcile/poll.ts`) that runs today.
- **No local database, and no new durable sync state.** The receiver persists nothing — not delivery IDs, not a cursor, not a queue. See §3.1 for why it doesn't need to. (Tailscale's own node state is a separate matter — §6.4.)
- **No Todoist project is ever deleted** (base §5.1). Untouched here.
- **The shared in-process lock** (base §5.3) still serializes every reconciliation cycle against the digest job. Webhook-triggered polls go through the same `Lock`.

### 2.2 Amended base requirements

| Base requirement | Amendment |
|---|---|
| base §2.2: "No inbound exposure of the homelab to the public internet" | **No longer true, and this is the whole cost of this design.** One HTTPS path on one `.ts.net` hostname is now reachable from the internet. §5 is the mitigation. |
| base §2.3: "Poll interval — 1 minute" | Becomes the *fallback* interval, and rises (§7). |
| base §4.2: "Why this design skips both, for now" | Superseded for the Linear direction. Todoist rationale still holds. |
| base §8.2: alert `time() - sync_last_poll_success_timestamp_seconds > 300` | **Threshold must rise with the poll interval or it will page falsely** (§8.4). |
| base §9: "No `volumes:` entry" | **No longer literally true** — `tailscaled` needs a state volume, for a reason that turns out to be load-bearing (§6.4). The claim it was standing in for — no durable *sync* state, no backups — is unaffected. |
| base §10: "Polling instead of webhooks" row | Superseded by §13. |

### 2.3 Decisions locked in for this design

| Decision | Choice |
|---|---|
| Webhook role | A **nudge only** — it triggers a normal reconciliation cycle, it does not apply changes itself (§3.1) |
| Ingress | Tailscale Funnel, via a **dedicated** `tailscale/tailscale` sidecar node — not the existing subnet router, which structurally cannot do this (§6.2) |
| Subscribed resource types | `Issue` only (§4.1) |
| Authenticity | HMAC-SHA256 over the raw body + a 60-second replay window, both mandatory (§5.2, §5.3) |
| Listener | A **separate port** from `/metrics`, chosen so Funnel is structurally incapable of exposing metrics (§5.4) |
| Tailscale node identity | Tagged and non-expiring, with a stable hostname and persistent state (§6.4) |
| Ingress monitoring | An external `blackbox_exporter` probe of the Funnel URL, expecting `401` (§8.2) — **not** an admin-scoped Linear API check |
| `LINEAR_API_KEY` scope | Unchanged — no workspace-admin privileges are introduced by this design (§4, §8.2) |
| Behavior with no secret configured | Receiver does not start; service runs exactly as it does today (§5.6) |
| Behavior when the webhook is broken/disabled | Silent, automatic degradation to the fallback poll — correctness is never at risk (§11) |
| Durable sync state added | None |

## 3. Architecture: the nudge model

```
                                   ┌──────────────────────────────────────────┐
                                   │  Docker (shared network namespace)       │
                                   │                                          │
  Linear ──POST /webhooks/linear──►│  tailscaled ──► 127.0.0.1:9465 receiver  │
  (webhook)          via           │  (Funnel :443)         │                 │
             Tailscale Funnel      │                        │ verify sig      │
       https://<node>.<tailnet>    │                        │ + timestamp     │
                 .ts.net           │                        │ 200 OK (<5s)    │
                                   │                        ▼                 │
                                   │                 requestPoll()            │
                                   │                        │ debounce 2s     │
                                   │                        │ coalesce        │
                                   │                        ▼                 │
                                   │   ┌─────────── shared Lock ───────────┐  │
                                   │   │   runPollCycle()   (unchanged)    │  │
                                   │   │   runDigestJob()   (unchanged)    │  │
                                   │   └───────────────────────────────────┘  │
                                   │                        ▲                 │
                                   │           fallback timer (§7)            │
                                   │                                          │
                                   │  127.0.0.1:9464 /metrics — reachable     │
                                   │  only via Serve or LAN, never Funnel     │
                                   │  (§5.4)                                  │
                                   └──────────────────────────────────────────┘
```

The only new arrow into the existing system is `requestPoll()`. Everything downstream of the `Lock` is code that already exists and does not change.

### 3.1 Why a nudge, and not an event applier

The tempting alternative is to read the webhook payload and apply just that change — issue renamed, so rename the project. It is rejected, for four reasons, in descending order of importance:

1. **It would reintroduce every failure mode base §5 was built to avoid.** An event applier is an event log: it needs ordering guarantees, deduplication, and a story for "what if I missed one." Full-state reconciliation has none of those problems *because* it never trusts history — it rediscovers reality every cycle. Trading that away for a few hundred milliseconds is a bad deal, and `CLAUDE.md` names preserving it as a hard constraint.

2. **Linear disables webhooks that fail.** After three failed retries (1 minute, 1 hour, 6 hours), Linear may disable the webhook, and it must be re-enabled manually. If webhooks were the source of truth, a disabled webhook would mean **silent, permanent, unbounded drift**. In the nudge model, a dead webhook degrades to exactly today's behavior — polling — which is a non-event. This asymmetry is the single strongest argument for the design, and it matters more with Funnel than it would with a commercial CDN, since the ingress path here has more ways to lapse quietly (§6.4, §11).

3. **Linear's 5-second response deadline makes inline work impossible anyway.** A reconciliation cycle can exceed 5 seconds, and the shared lock may be held by the digest job for longer still. The receiver *must* acknowledge before doing work, which naturally produces "enqueue a poll" rather than "apply this event." (Funnel relays add some latency on top, which is comfortably absorbed because the ack happens before any work — §3.2 step 6.)

4. **Deduplication becomes a non-problem.** Linear retries deliveries, so duplicates are expected. Because the response to any delivery is "run a full reconciliation," a duplicate delivery is an idempotent no-op — the second cycle finds nothing left to do. An event applier would need a persisted `Linear-Delivery` set to get the same property, which means durable state, which means the base design's no-database invariant is gone.

The cost of the nudge model is one extra round of API reads per triggered cycle versus applying the event directly. At single-workspace scale that is not a real cost, and §7 more than pays for it by removing most idle polls.

### 3.2 Request lifecycle

1. `tailscaled` terminates TLS and forwards the request to the receiver on `127.0.0.1:<WEBHOOK_PORT>`.
2. Reject anything that isn't `POST` to the configured path → `404`.
3. Read the **raw body bytes**, capped at a size limit (e.g. 1 MiB) → `413` if exceeded.
4. Verify the HMAC signature against the raw bytes (§5.2). Mismatch → `401`, no poll requested.
5. Parse JSON. Verify `webhookTimestamp` is within 60 seconds of now (§5.3). Stale → `401`.
6. **Respond `200` immediately** — before any reconciliation work, and *including for events that will be ignored* (see below).
7. If `type == "Issue"`, call `requestPoll()`. Otherwise record it as ignored and stop.

Step 6's "200 even when ignoring" matters: Linear counts non-200 responses as delivery failures, and enough failures disable the webhook. The only responses that are deliberately non-200 are authenticity failures — and Linear does not retry 4xx, which is precisely the desired handling for a forged or replayed request.

### 3.3 Coalescing

A bulk edit in Linear (re-prioritizing a backlog, moving a batch of issues) fires many `Issue` events within a second or two. Naively calling `lock.run(runPollCycle)` per event would enqueue one cycle *per event* — the existing `Lock` queues indefinitely rather than dropping, so twenty events would serialize into twenty redundant full reconciliations.

`requestPoll()` therefore coalesces:

- A pending flag guards enqueueing. If a webhook-triggered poll is already pending, further requests set nothing new — they are absorbed.
- The flag is set with a short **debounce (default 2 seconds)** before the cycle is enqueued, so a burst collapses into a single cycle.
- Invariant: **at most one webhook-triggered cycle running and one pending**, regardless of event volume.
- Running a webhook-triggered cycle also resets the fallback timer, so a scheduled poll doesn't fire redundantly seconds after a webhook already reconciled.

Two seconds is a deliberate trade: it is negligible against the ~60s it replaces, and it converts the worst realistic burst into one cycle.

## 4. Linear-side webhook configuration

Created **in Linear's settings** (Settings → API → Webhooks), by you, in a browser. Managing webhooks requires workspace-admin privileges, and Linear personal API keys inherit the user's full workspace role — so doing this in the UI is what keeps that privilege out of the container. **`LINEAR_API_KEY` needs no additional scope beyond what it already has today** (issues, attachments, comments); nothing in this design has the service read or write webhook configuration. §8.2 explains why the tempting alternative was rejected.

The `webhookCreate` mutation exists and would work, but only with an admin-privileged token — which is precisely what this avoids.

| Setting | Value |
|---|---|
| URL | `https://<node>.<tailnet>.ts.net/webhooks/linear` (§6.1 — the hostname is not freely chosen) |
| Resource types | `Issue` |
| Team scope | `allPublicTeams: true`, matching base §5's workspace-wide `state.type == started` query |
| Secret | Generated by Linear; supplied to the container as `LINEAR_WEBHOOK_SECRET` |

### 4.1 Resource types, and the self-echo hazard

`Issue` alone covers every Linear-originated transition in base §5.1:

| base §5.1 trigger | Webhook event |
|---|---|
| Issue enters "started" | `action: "update"`, `updatedFrom` contains `stateId` (or `action: "create"`) |
| In-progress issue's title changes | `action: "update"`, `updatedFrom` contains `title` |
| Issue moves out of "started" | `action: "update"`, `updatedFrom` contains `stateId` |
| Issue deleted outright | `action: "remove"` |

**Do not subscribe to `Attachment` or `Comment`.** This service writes both — attachment subtitle refreshes on every cycle (base §5.4), digest comments daily (base §7). Subscribing would make the service's own writes trigger webhooks that trigger cycles that produce more writes. The base design's "only write the card when the count actually changes" rule keeps that loop from running away, but it is a loop that has no reason to exist. If a future version does need those events, the payload's `actor` field identifies who caused the change and can be used to drop self-originated events.

### 4.2 Payload fields actually used

Deliberately almost none. The receiver reads:

- `type` — to decide whether to nudge at all.
- `webhookTimestamp` — replay window (§5.3).

That is the entire contract. `data`, `updatedFrom`, `action`, and `url` are logged at debug level for troubleshooting and otherwise **ignored**, because the reconciliation cycle rediscovers all of it from the API anyway. This is what makes the receiver near-immune to Linear payload schema changes: there is no field whose meaning the sync logic depends on.

A finer filter is possible later — e.g. only nudge when `updatedFrom` touches `stateId` or `title` — and would cut triggered cycles further. It is deliberately **not** in v1: a filtering mistake silently costs latency (the fallback poll still catches the change, up to §7's interval later), which is a subtle bug to notice, and the cycles it saves are cheap. Revisit only if triggered-cycle volume shows up in rate-limit metrics.

## 5. Security

### 5.1 What is newly exposed

Before this change, the container's only listener was `/metrics` on the LAN, and base §2.2 could claim zero inbound internet exposure. After it, one path on one hostname is reachable by anyone on the internet.

**The hostname is not a secret.** Tailscale issues public Let's Encrypt certificates for `.ts.net` names, and every issued certificate is published in Certificate Transparency logs. Your Funnel hostname is therefore discoverable by anyone watching CT — it should be treated as public knowledge from the moment it exists, not as an obscure address. This is not a flaw in Funnel; it is how public TLS works. It does mean §5.2 is the *only* control actually standing between the internet and this endpoint.

| Threat | Mitigation |
|---|---|
| Forged events from an attacker who knows the URL — and they can (see above) | HMAC signature verification (§5.2). This is the whole defense |
| Replay of a captured genuine delivery | 60-second timestamp window (§5.3) |
| Request-volume abuse causing poll amplification | Coalescing (§3.3) caps reconciliation work at one cycle regardless of request rate |
| Reaching `/metrics` or another local service | Port chosen outside Funnel's reachable set (§5.4) |
| Lateral movement from a compromised receiver into the rest of the tailnet | Tagged node with no advertised routes and no outbound tailnet ACL (§6.4) |
| Contention with other services on the Docker host | Sidecar's own network namespace — the Funnel listener never touches a host port (§6.3) |
| Home IP address disclosure | Funnel relays via Tailscale's infrastructure; the origin IP is never published, and no router port is opened |
| Misconfiguration silently disabling verification | Fail closed at startup (§5.6) |

### 5.2 Signature verification

Linear signs each delivery with HMAC-SHA256 over the raw request body, keyed by the webhook's signing secret, sent as a **bare hex string** in the `Linear-Signature` header (no `sha256=` prefix, unlike GitHub).

Three implementation requirements, each of which is a real bug if skipped:

- **Verify against the raw bytes, not a re-serialized parsed body.** `JSON.parse` → `JSON.stringify` does not round-trip byte-for-byte (key order, whitespace, unicode escapes), and the signature will not match. The receiver must buffer the raw body and verify *before* parsing.
- **Compare with `crypto.timingSafeEqual`**, not `===`. Note that `timingSafeEqual` throws on length mismatch, so length must be checked first — and that check is safe to do non-constant-time, since the length is not secret.
- **Verify the body's `webhookTimestamp` field, not the `Linear-Timestamp` header.** The header is not covered by the HMAC; the body field is. Trusting the header would let an attacker replaying a captured body simply rewrite the header to defeat §5.3.

### 5.3 Replay window

Reject any delivery whose `webhookTimestamp` (Unix milliseconds) is more than 60 seconds from the current time, in either direction. Linear documents this as the recommended window. The bidirectional check also catches a badly skewed container clock, which would otherwise cause a confusing "every delivery rejected" failure — worth logging distinctly from a signature failure for exactly that reason.

### 5.4 Listener separation — and why Funnel makes this sharper

The webhook receiver binds a **separate port** (`WEBHOOK_PORT`, default `9465`) from the metrics server (`9464`). That much would be true under any ingress. What is specific to Funnel is *how* the separation must be enforced:

**`AllowFunnel` is keyed per `host:port`, not per path.** A serve config like this exposes *every* handler under that host:port to the internet:

```json
{
  "Web": { "${TS_CERT_DOMAIN}:443": { "Handlers": {
      "/webhooks/linear": { "Proxy": "http://127.0.0.1:9465" },
      "/metrics":         { "Proxy": "http://127.0.0.1:9464" }
  } } },
  "AllowFunnel": { "${TS_CERT_DOMAIN}:443": true }
}
```

That config publishes your metrics to the internet, and nothing about it looks wrong at a glance. This is a meaningful downgrade from path-scoped ingress rules: with Funnel, publicness is a property of the *port*, so any handler that shares the port inherits it.

Two rules follow:

1. **The Funnel'd host:port carries exactly one handler** — the webhook path. Requests to any other path under it get a 404 from `tailscaled`, since no handler matches.
2. **Anything else this node serves goes on a port Funnel cannot use at all.** Funnel is restricted to `443`, `8443`, and `10000`, so a handler on e.g. `:9443` cannot be exposed by any `AllowFunnel` typo — Tailscale will refuse to Funnel that port. `:8443` is a poor choice for the same reason `:443` is: it is Funnel-capable, and therefore one stray `true` away from public.

In this deployment rule 2 has nothing to apply to, because Prometheus scrapes `/metrics` over the LAN and the metrics port is never given a Serve handler (§6.5). That is the strongest version of this: the config `tailscaled` holds contains exactly one handler, and it is the one meant to be public. Rule 2 exists for the day that changes.

Rule 2 is the design principle worth carrying: make the bad state unrepresentable rather than merely unconfigured. Base §9 already contemplates Serve for metrics on this same node, so both handlers will live in the same file — one keystroke apart.

### 5.5 What Funnel does not give you

Worth stating plainly, since it is the main security cost of Funnel versus a commercial edge like Cloudflare:

- **No WAF, and no IP allowlisting.** Linear publishes static source IPs for webhook delivery, but there is no Funnel-level control to enforce them. They could in principle be checked in-application from the `X-Forwarded-For` header that `tailscaled` sets — but that means trusting a forwarded header, and Linear states the IP list may expand over time, so the failure mode is silently rejecting real deliveries. **Not recommended**: HMAC verification already provides strictly stronger authenticity than an IP check, and this would add a way to break deliveries without adding real security.
- **No rate limiting at the edge.** Coalescing (§3.3) is what bounds the actual damage: request volume translates to at most one reconciliation cycle at a time no matter what. Funnel's own non-configurable bandwidth limits provide a crude ceiling.
- **A non-obvious path** (e.g. `/webhooks/linear/<random>`) is nearly free and keeps the endpoint out of opportunistic scans, but given §5.1's CT-log point, treat it as noise reduction, not a control.

The compensating advantage is that Funnel introduces **no new vendor** — base §9 already puts Tailscale in this deployment for the metrics port — and no new account, DNS zone, or credential beyond a tailnet auth key.

### 5.6 Fail closed

If `LINEAR_WEBHOOK_SECRET` is unset or empty, the receiver **does not start listening at all**, and the service logs that it is running in poll-only mode. It must never start an unverified listener. Config validation (`src/config.ts`) rejects a webhook port set without a secret rather than silently ignoring one of them.

## 6. Ingress: Tailscale Funnel

### 6.1 Prerequisites and constraints

| Requirement | Detail |
|---|---|
| Tailscale version | ≥ 1.38.3 |
| MagicDNS | Enabled for the tailnet |
| HTTPS certificates | Enabled for the tailnet |
| Policy file | A `funnel` node attribute granting this node permission (§6.4) |
| Ports | Funnel listens only on `443`, `8443`, `10000`. This design uses `443` |
| Hostname | **`<node>.<tailnet>.ts.net` only — custom domains are not supported.** The Linear webhook URL is therefore determined by the node's name, which is why §6.4 pins it |
| Bandwidth | Subject to non-configurable limits. Irrelevant at webhook volume |

### 6.2 Why a dedicated node, and not the existing subnet router

A fair question when a subnet router already bridges the LAN into the tailnet. It can't do this job, for a structural reason rather than a policy setting:

**Serve and Funnel can only proxy to `127.0.0.1` on the node running them.** Tailscale states this directly — "only `http://127.0.0.1` is supported for proxies" — and proxying to another host is a long-standing open feature request (`tailscale/tailscale#8751`), not a supported configuration. A subnet router can therefore only Funnel services running *on the subnet router itself*.

The two features are easy to conflate, and the difference is the whole answer:

| | What it does |
|---|---|
| **Subnet router** | Advertises LAN routes so tailnet devices can reach LAN devices. Traffic flows **tailnet → LAN** |
| **Serve / Funnel** | Publishes a service on the node's *own* loopback, under that node's `.ts.net` name. Traffic flows **tailnet (or internet) → that node's localhost** |

LAN devices are reachable *through* the subnet router, but they are not tailnet nodes and have no `.ts.net` name of their own — so there is nothing for Funnel to attach to them. Subnet routing does not bridge that gap in the direction this design needs.

That leaves three options:

1. **A sidecar node** (what this design specifies). The sync container gets its own tailnet identity, hostname, and `:443`.
2. **Run the sync container on a host that already runs `tailscaled`** — the subnet router, or any other tailnet node. Then `127.0.0.1` is satisfied with no sidecar: publish the receiver on loopback only (`ports: ["127.0.0.1:9465:9465"]`) and configure Funnel in that host's `tailscaled`. Fewer moving parts, but see §6.3 for why a host already running a reverse proxy is a poor candidate.
3. **A reverse proxy on the subnet router** (nginx/Caddy bound to `127.0.0.1:9465`, forwarding to the Docker host). Works, but adds a component to a path whose appeal was not having one.

**Option 1 is recommended even where option 2 is available**, for two reasons beyond tidiness:

- **Blast radius.** The subnet router is by definition the node holding routes into your entire LAN. Making it the public TLS terminator puts your most privileged node on the internet. A sidecar node holds no routes and no special access — a worst-case compromise gets a container that talks to two APIs.
- **`AllowFunnel` granularity (§5.4).** A dedicated node's `:443` carries exactly one handler by construction, so §5.4's rule holds for free. On a shared node — particularly one already fronting other services via Serve — setting `AllowFunnel` on `:443` publishes *everything* on that port. That can be worked around by Funnelling `:8443` or `:10000` and leaving `:443` tailnet-only, but it puts an explicit port in the webhook URL (`https://router.<tailnet>.ts.net:8443/webhooks/linear`), which is worth confirming Linear accepts before committing to it.

None of this is affected by the subnet router sitting behind a firewall. Funnel requires no inbound port on any node — `tailscaled` reaches Tailscale's infrastructure outbound — so a sidecar is exactly as firewall-friendly as the router already is.

### 6.3 Compose topology

The `tailscale/tailscale` container owns the network namespace; the sync service joins it with `network_mode: service:`, so `tailscaled` reaches the receiver at `127.0.0.1:9465` with nothing bound to the host.

```yaml
services:
  tailscale:
    image: tailscale/tailscale:latest
    restart: unless-stopped
    hostname: linear-sync                 # becomes <this>.<tailnet>.ts.net — see §6.4
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY}
      TS_EXTRA_ARGS: --advertise-tags=tag:webhook-ingress
      TS_STATE_DIR: /var/lib/tailscale
      TS_SERVE_CONFIG: /config/serve.json
    volumes:
      - tailscale-state:/var/lib/tailscale
      - ./serve.json:/config/serve.json:ro
    ports:
      - "9464:9464"                       # metrics for a LAN Prometheus — see note below

  linear-todoist-sync:
    build: .
    restart: unless-stopped
    network_mode: service:tailscale       # shares the namespace; no ports: stanza of its own
    depends_on: [tailscale]
    environment:
      LINEAR_API_KEY: ${LINEAR_API_KEY}
      TODOIST_API_TOKEN: ${TODOIST_API_TOKEN}
      LINEAR_WEBHOOK_SECRET: ${LINEAR_WEBHOOK_SECRET}
      WEBHOOK_PORT: 9465
      WEBHOOK_PATH: /webhooks/linear
      POLL_INTERVAL_SECONDS: 60
      DIGEST_TIME: "07:00"
      DIGEST_TIMEZONE: "America/Chicago"
      METRICS_PORT: 9464

volumes:
  tailscale-state:
```

**Note the `ports:` move.** Base §9 publishes `9464:9464` on the sync service. Once that service joins the sidecar's namespace it can no longer declare its own port mappings — they must be declared on the `tailscale` container instead. Missing this is the most likely way to break Prometheus scraping while everything else appears healthy. This deployment scrapes over the LAN, so the published port stays and metrics never touch the Serve config at all (§6.5).

**Co-tenancy with a reverse proxy on the same Docker host.** This deployment's host also runs Caddy on the standard web ports, and that is not a conflict — it is an argument for the sidecar. Because the sidecar and the sync container share a namespace that is *not* the host's, the serve config's `:443` is bound on the tailnet side inside that namespace and never appears on a host interface. Caddy binds the host namespace's `:443`. Two namespaces, no contention, and Funnel publishes no host port at all — traffic arrives over the outbound connection `tailscaled` already holds. The only host port this design uses is `9464` for LAN Prometheus, and even that is optional.

This is precisely where §6.2's option 2 stops being attractive. If `tailscaled` ran on the host instead of in a sidecar, and Caddy binds `0.0.0.0:443`, that wildcard covers the tailnet interface too and can collide with Funnel's `:443` — pushing you onto `:8443` and an explicit port in the webhook URL. The sidecar's namespace makes the question moot. **So: a Docker host already running a reverse proxy is a reason to use the sidecar, not a reason to build a separate VM for this** (§13).

Confirm after deploying, on the host: `ss -tlnp | grep -E ':(443|9465)'` should show Caddy on `443` and no listener for `9465` — the latter exists only inside the container namespace.

**No `NET_ADMIN` or `/dev/net/tun` needed.** The sidecar runs in Tailscale's userspace networking mode (the container image's default), which is sufficient here because the only traffic it handles is Funnel proxying to `127.0.0.1` in its own namespace — it is not routing for anyone. This is a further contrast with the subnet router of §6.2, which does need kernel networking precisely because it *is* routing.

### 6.4 Node identity: three settings that fail silently if wrong, and one that limits the damage

The Linear webhook URL contains the node's name, and the URL is registered once in Linear's settings. Anything that changes the name, or lets the node fall out of the tailnet, breaks delivery — and breaks it in the quiet way §8.1 is about.

- **Persistent state volume.** `TS_STATE_DIR` on a named volume. Without it, the container re-authenticates on every restart and can come back as `linear-sync-1`, `linear-sync-2`, … — silently changing the hostname the webhook URL depends on. This is why base §9's "no `volumes:`" property cannot survive this design (§2.2). Ephemeral auth keys are the wrong choice here for the same reason.
- **A tag, not a user identity.** `--advertise-tags=tag:webhook-ingress`, with a matching policy entry:

  ```json
  "nodeAttrs": [
    { "target": ["tag:webhook-ingress"], "attr": ["funnel"] }
  ]
  ```

  Tagging is not just tidiness: **tagged nodes do not have key expiry, while user-owned nodes expire (180 days by default)**. An untagged node here works perfectly for six months and then drops off the tailnet, taking the Funnel with it. That is a genuinely nasty failure to debug months after deploying, and §8.2's probe is what would surface it — within one scrape interval rather than whenever you next noticed sync feeling slow.
- **A pinned `hostname:`.** So the name is a declared property of the deployment rather than an accident of container naming.

**Constrain the node with ACLs.** The tag earns its keep a second time here. This node is the one thing in the tailnet exposed to the internet, so it should be the least privileged member of it — it needs to talk to `api.linear.app` and `api.todoist.com` and nothing else on the tailnet. Deny it outbound tailnet access in the policy file:

```json
"acls": [
  { "action": "accept", "src": ["tag:webhook-ingress"], "dst": [] }
]
```

Tailscale denies by default, so the practical work is *not* writing a permissive rule that happens to include `tag:webhook-ingress` — check that no existing broad rule (`autogroup:member` → `*`, or a catch-all `src: ["*"]`) already grants it more than it needs, since a tagged node picks up any rule whose source matches.

This is the cheap version of the isolation a dedicated VM would provide. A separate VM would additionally stop the receiver from sharing a kernel with the host's other containers — a real boundary, but a heavy one for a service whose worst-case compromise is a container that can reach two public APIs. A few lines of policy get most of the benefit for none of the ongoing maintenance (§13).

### 6.5 Serve configuration

Prometheus scrapes `/metrics` over the LAN via the published port in §6.3, so metrics never enter this config at all — `tailscaled` serves exactly one thing:

```json
{
  "TCP": {
    "443": { "HTTPS": true }
  },
  "Web": {
    "${TS_CERT_DOMAIN}:443": { "Handlers": {
      "/webhooks/linear": { "Proxy": "http://127.0.0.1:9465" }
    } }
  },
  "AllowFunnel": {
    "${TS_CERT_DOMAIN}:443": true
  }
}
```

This is the strongest form of §5.4: there is only one handler, on one port, and it is the one that is supposed to be public. Nothing else is reachable through `tailscaled` at all, so `AllowFunnel`'s port-level granularity has nothing to over-expose. Requests to any other path under `:443` get a 404 from `tailscaled`.

**If you later add a Serve handler for metrics** — because Prometheus moved onto the tailnet, or the LAN port went away — do not add it under `${TS_CERT_DOMAIN}:443`. It would inherit that key's `AllowFunnel: true` and be published to the internet, with nothing about the config looking wrong. Put it on a port Funnel structurally cannot serve (Funnel is limited to `443`, `8443`, `10000`, so `:9443` works and `:8443` is a poor choice), and §5.4's reasoning is preserved.

Verify with `tailscale funnel status` — it prints exactly what is public, and is the fastest way to confirm that only the one path is.

## 7. The poll interval after push

The fallback poll does not go away, for three independent reasons:

1. It is the safety net for every webhook failure mode in §11.
2. **Todoist-originated transitions (base §5.2) are still poll-only** — a project archived, renamed, or deleted directly in Todoist is discovered only by a cycle.
3. **The outstanding-task-count subtitle (base §5.4) is refreshed only by a cycle**, and task counts change in Todoist, not Linear.

Reasons 2 and 3 are what bound how far the interval can rise. Linear→Todoist latency becomes webhook-speed regardless of the interval, but Todoist→Linear latency *is* the interval.

**Recommendation: `POLL_INTERVAL_SECONDS=300`.** That is a 5× reduction in idle cycles and API reads, while keeping the Todoist-side worst case at five minutes — still well inside "check the task count, it's roughly right." Going to 15 or 60 minutes saves little more and makes the stale-subtitle window obvious in daily use.

Deploy at the existing 60s first and only raise it once §8's metrics show deliveries actually landing (§10).

## 8. Observability

### 8.1 The failure mode that makes this section necessary

**A broken webhook is invisible from the outside.** If Funnel stops working, the node's key expires, the secret is rotated, or Linear disables the webhook after retries, the fallback poll keeps everything correct — so nothing fails, no alert fires, no metric goes stale, and the only symptom is that sync quietly got slower.

It is worth being precise about why passive metrics are insufficient. A gauge like "time since last webhook received" cannot distinguish **"the webhook is broken"** from **"nobody touched Linear today"** — a quiet weekend and a dead Funnel look identical. Any threshold tight enough to catch a real outage will page every holiday.

§6.4's expiry trap makes this concrete: an untagged node's key expires roughly six months after deploy, silently, with every other signal in this system looking perfectly healthy.

### 8.2 External probe of the Funnel path

The answer to §8.1 is an **active** check, and the cheapest useful one is an unauthenticated request to the webhook URL from outside the tailnet.

**The rejection is the health signal.** An unauthenticated `POST` to the webhook path returns **401** by design (§3.2, step 4 — signature verification fails before anything else happens). A 401 therefore proves the whole chain is alive: public DNS resolved, Tailscale's Funnel ingress accepted the connection, TLS terminated, the node is on the tailnet, the container is running, and the receiver executed its verification path. A timeout, connection refused, or 404 means ingress is broken.

This needs **no code in this service and no new endpoint** — the receiver already answers this way. It is purely Prometheus configuration.

#### Prober

A `blackbox_exporter` container scraped by the existing Prometheus:

```yaml
blackbox:
  image: prom/blackbox-exporter
  restart: unless-stopped
  dns: ["1.1.1.1"]                 # load-bearing — see below
  command: --config.file=/config/blackbox.yml
  volumes: ["./blackbox.yml:/config/blackbox.yml:ro"]
```

```yaml
# blackbox.yml
modules:
  linear_webhook:
    prober: http
    timeout: 10s
    http:
      method: POST
      valid_status_codes: [401]
      fail_if_not_ssl: true
```

```yaml
# prometheus.yml
- job_name: linear-webhook-probe
  scrape_interval: 5m
  metrics_path: /probe
  params: { module: [linear_webhook] }
  static_configs:
    - targets: ["https://linear-sync.<tailnet>.ts.net/webhooks/linear"]
  relabel_configs:
    - { source_labels: [__address__], target_label: __param_target }
    - { source_labels: [__param_target], target_label: instance }
    - { target_label: __address__, replacement: "blackbox:9115" }
```

#### Why `dns:` is the load-bearing line

**The probe must not resolve the hostname via MagicDNS.** Tailscale's resolver (`100.100.100.100`) answers `*.ts.net` with the node's `100.x` tailnet address, *not* the public Funnel ingress. A prober that gets that answer reaches the receiver directly over the tailnet, completely bypassing Funnel — and reports green while Funnel is dead. That is worse than having no probe, because it converts "no alert" from evidence of health into evidence of nothing.

This bites whenever the prober's DNS path touches the tailnet: a host running `tailscaled` with `--accept-dns`, or a LAN resolver (router, Pi-hole) configured to forward `*.ts.net` to the tailnet resolver. Pinning `dns: ["1.1.1.1"]` on the container makes the correct behavior structural rather than something verified once and hoped to stay true — the same move as the Funnel-incapable port in §5.4.

Note the asymmetry with §6.2: a machine merely *reachable through* the subnet router is not on the tailnet and would resolve publicly anyway. It is DNS configuration, not subnet routing, that creates the hazard.

To confirm at setup time, from inside the prober container:

```
dig +short linear-sync.<tailnet>.ts.net     # public IP = good; 100.x = bypassing Funnel
```

#### What this does and does not cover

It catches the *causes* — Funnel down, node key expired (§6.4), container down, hostname changed — within one scrape interval, which is far faster than watching for the downstream consequence.

It does **not** catch Linear having disabled the webhook while ingress is healthy. In practice Linear disables it *because* deliveries failed, which is one of the causes above and is caught hours earlier; the genuinely uncovered case is someone disabling it by hand in Linear's UI, which is a deliberate action rather than a spontaneous failure. It also cannot detect a secret rotated only on Linear's side — the probe gets its expected 401 either way — but `sync_webhook_deliveries_total{result="rejected_signature"}` already surfaces that.

#### Why not query Linear's API instead

The obvious alternative is for the service to poll Linear's `webhooks` API hourly and assert its own webhook is `enabled`. **Rejected: it requires workspace-admin privileges on `LINEAR_API_KEY` (§4), and Linear personal keys inherit the user's full role** — meaning a credential that can do anything in the workspace, living permanently in a homelab container, in exchange for a strictly *slower* signal about a strictly *narrower* set of failures. The probe needs no credential at all. Keeping the container's key non-admin is worth more than the one extra failure mode the API check would cover.

#### Note on the prober's own liveness

If Prometheus dies, this alert dies with it. That is a pre-existing property of the whole alerting stack rather than something this design introduces, and it is accepted here. A dead-man's-switch pattern (a local cron pinging an external service *only* on success, so silence itself alerts) would close it, at the cost of an external dependency — disproportionate for a failure whose worst consequence is that sync runs at the §7 poll interval.

### 8.3 New metrics

Following the existing naming in `src/metrics.ts`:

| Metric | Type | Meaning |
|---|---|---|
| `sync_webhook_deliveries_total{result}` | counter | `result="accepted"` \| `"ignored"` \| `"rejected_signature"` \| `"rejected_stale"` \| `"rejected_malformed"` \| `"probe"` |
| `sync_webhook_polls_triggered_total` | counter | Cycles actually started by a nudge — the gap against `accepted` is what coalescing (§3.3) saved |
| `sync_last_webhook_received_timestamp_seconds` | gauge | Unix time of the last verified delivery. Diagnostic only — see §8.1 for why this must not be alerted on directly |
| `sync_poll_runs_total{result, trigger}` | counter | **Existing metric, new `trigger` label**: `"scheduled"` \| `"webhook"` |

The ingress health signal itself is **not** a metric this service exports — it is `probe_success{job="linear-webhook-probe"}`, produced by `blackbox_exporter` (§8.2). That separation is the point: a signal about whether this service is reachable cannot come from the service itself.

The `result="probe"` value exists so §8.2's probe doesn't pollute `rejected_signature`. A 5-minute probe interval would otherwise add a constant ~288/day baseline to a counter whose whole diagnostic value is that it normally sits still. The receiver distinguishes the probe by a `User-Agent` it sets (`Blackbox Exporter` by default, or an explicit `headers:` entry in the module config), still answers `401`, and counts it separately — a few lines, and it keeps `rejected_signature` meaning what its name says.

The `trigger` label on `sync_poll_runs_total` is a breaking change for any existing dashboard or recording rule that sums without aggregating over it. Worth doing anyway — "what fraction of reconciliation is push-driven now" is the question you'll want answered while tuning §7 — but adjust dashboards in the same change.

### 8.4 Alerts

Replacing base §8.2's single rule:

- **Sync is stuck** (carried over, **retuned**): `time() - sync_last_poll_success_timestamp_seconds > <3 × poll interval>`. At `POLL_INTERVAL_SECONDS=300` this becomes `> 900`, not the base doc's `300`. **Leaving the old threshold in place while raising the interval will page on every healthy cycle** — this is the easiest mistake to make in this whole design, because the alert lives in Prometheus and the interval lives in the container, and nothing links them.
- **Webhook ingress is unreachable** (new): `probe_success{job="linear-webhook-probe"} == 0` for 15m. Not urgent — sync is still correct, just slower — so warning severity, not a page. At a 5-minute scrape interval, `for: 15m` means three consecutive failures, which rides out a single transient blip.

That is the whole alerting story: one rule for "reconciliation stopped" and one for "the fast path stopped." Everything else in §8.3 is diagnostic detail you'd consult *after* one of them fires.

**What to check when the ingress alert fires**, roughly in order of likelihood:

1. `docker compose ps` — is the sidecar up, and did the sync container come back without it?
2. `tailscale funnel status` — is Funnel still on, and still pointing at `127.0.0.1:9465`?
3. Is the node still in the tailnet admin console, or did its key expire (§6.4)?
4. Did the node's hostname change, so the registered URL no longer resolves (§6.4)?
5. Is the webhook still `enabled` in Linear's settings — the one case §8.2 deliberately doesn't cover?
6. `dig +short` from the prober — did something reroute `*.ts.net` to the tailnet resolver (§8.2)? A *green* probe with slow sync points here too.

`sync_webhook_deliveries_total{result="rejected_signature"}` climbing means a secret mismatch — deliveries failing, sync degraded to polling — or someone probing the endpoint, which per §5.1 is expected since the hostname is public. It should not include §8.2's own probe (§8.3). Worth a glance, not an alert.

## 9. Configuration

| Env var | Default | Notes |
|---|---|---|
| `LINEAR_WEBHOOK_SECRET` | *(unset)* | Signing secret from Linear. Unset ⇒ receiver disabled, poll-only mode (§5.6) |
| `WEBHOOK_PORT` | `9465` | Bound on `127.0.0.1` within the shared namespace (§6.3). Rejected at startup if set without a secret |
| `WEBHOOK_PATH` | `/webhooks/linear` | Must match both the Linear webhook URL and the serve config handler |
| `WEBHOOK_DEBOUNCE_MS` | `2000` | Coalescing window (§3.3) |
| `LINEAR_API_KEY` | — | **Unchanged scope** — no admin privileges needed (§4, §8.2) |
| `POLL_INTERVAL_SECONDS` | `60` | Unchanged default; raise to `300` after §10's rollout |
| `TS_AUTHKEY`, `TS_STATE_DIR`, `TS_SERVE_CONFIG`, `TS_EXTRA_ARGS` | — | Consumed by the `tailscale` sidecar, not by this service (§6.3) |

## 10. Rollout and rollback

Because the webhook is purely a nudge and adds no durable sync state, both directions are config-only — there is no migration, no backfill, and no state to reconcile.

1. **Enable the tailnet prerequisites** (§6.1): HTTPS certs, MagicDNS, the `funnel` node attribute for `tag:webhook-ingress`, and the ACL constraining that tag (§6.4) — including a check that no pre-existing broad rule already grants it more than it needs. These are tailnet-wide settings and are the most likely thing to be missing on first attempt.
2. **Deploy the sidecar topology with the receiver, keeping `POLL_INTERVAL_SECONDS=60`.** Nothing observable changes; polling still does all the work. Confirm with `tailscale funnel status` that exactly one path is public; with `ss -tlnp` on the host that nothing new bound a host port alongside Caddy (§6.3); and that Prometheus is still scraping after the `ports:` move (§6.3).
3. **Register the webhook in Linear's UI** using the `.ts.net` URL (§4). Watch `sync_webhook_deliveries_total{result="accepted"}` climb as issues change.
4. **Stand up the probe** (§8.2), and confirm `dig +short` *from inside the prober container* returns a public IP rather than a `100.x` address — a green probe proves nothing until you've checked this once.
5. **Confirm the nudge path end to end** — move an issue into "In Progress" and check that the Todoist project appears in seconds rather than up to a minute, with `sync_poll_runs_total{trigger="webhook"}` incrementing.
6. **Raise `POLL_INTERVAL_SECONDS` to 300 and retune the staleness alert in the same change** (§8.4).

**Rollback:** unset `LINEAR_WEBHOOK_SECRET`, set `POLL_INTERVAL_SECONDS` back to `60`, restore the alert threshold, restart. The service is then functionally the pre-webhook system. Removing `AllowFunnel` from the serve config, deleting the Linear webhook, and collapsing the sidecar topology back to a single container can each happen afterward at leisure — with the receiver down, deliveries simply fail and Linear gives up.

## 11. Failure modes

| Failure | Effect | Recovery |
|---|---|---|
| Funnel down, or tailnet unreachable | Deliveries fail; Linear retries at 1m / 1h / 6h, may disable the webhook | Fallback poll keeps sync correct throughout. Probe catches it within a scrape interval (§8.2) |
| **Node key expires (untagged node, ~180 days)** | Node drops off the tailnet; Funnel stops; everything else looks healthy | Prevented by tagging (§6.4). If it happens, the probe is the only signal (§8.2) |
| Linear webhook disabled by hand in the UI, ingress healthy | Latency returns to the poll interval | **Not detected** — the one gap §8.2 accepts. Item 5 of §8.4's checklist |
| Prober resolves the hostname via MagicDNS | Probe reports green while Funnel is dead | Prevented by pinning `dns:` (§8.2); verified once with `dig` at rollout (§10) |
| **State volume lost; node renamed on restart** | Funnel comes back on a *different* hostname; the registered webhook URL 404s | Prevented by the persistent volume and pinned hostname (§6.4) |
| Linear disables the webhook after retries | Latency returns to the poll interval | Alert fires; re-enable in Linear's settings |
| Secret rotated in Linear but not in the container | All deliveries rejected; `rejected_signature` climbs | Fallback poll covers it; update the env var |
| Container restart mid-delivery | That delivery fails and is retried by Linear | Even if every retry fails, the next poll cycle reconciles — no event is load-bearing (§3.1) |
| Duplicate delivery (Linear retry after a slow 200) | A redundant reconciliation cycle | Idempotent no-op by construction (§3.1) |
| Burst of 100 issue events | One reconciliation cycle | Coalescing (§3.3) |
| Container clock skew > 60s | Every delivery rejected as stale | Distinct log line (§5.3); fallback poll covers it |
| Forged/replayed request | Rejected before any work; `4xx`, which Linear does not retry | No action |

Every row degrades to "the system polls, as it did before." That is the property the whole design is organized around — and with Funnel it earns its keep, since the top three rows are all quiet, delayed failures.

## 12. Out of scope

- **Todoist webhooks.** Todoist supports them, and adding them would let §7's poll interval rise much further by removing reasons 2 and 3. But it requires a Todoist OAuth app rather than the personal token the base design chose (base §2.3), which is a materially bigger change than this one. The receiver and Funnel path built here are the natural place to add a second verified endpoint — note it would need its own handler under the Funnel'd `:443`, which is the one case where §5.4's "exactly one handler" rule gets revisited deliberately rather than by accident.
- **Replacing reconciliation with event application.** Rejected in §3.1, and not a "later" item — it is contrary to base §5.
- **Webhook-driven digest.** The digest is time-based by definition (base §7); nothing about it benefits from push.

## 13. Trade-offs and what to revisit

| Decision | Trade-off | Revisit when |
|---|---|---|
| Webhook as a nudge, not an event applier | Costs one extra round of API reads per triggered cycle vs. applying the event directly; buys immunity to missed, duplicated, and out-of-order events, and makes every webhook failure a latency issue instead of a correctness one | Essentially never — this is the load-bearing decision. Revisiting it means giving up base §5 |
| Public exposure via Tailscale Funnel | Gives up base §2.2's zero-inbound-exposure property, the base design's cleanest security claim | If the latency win doesn't feel worth it in practice, rollback is a config change (§10) |
| Tailscale Funnel over a commercial edge (Cloudflare Tunnel et al.) | No new vendor, account, or DNS zone — Tailscale is already in this deployment per base §9. Costs a WAF, edge rate limiting, IP allowlisting, and a custom domain; and `AllowFunnel`'s port-level granularity is easier to get wrong than path-scoped ingress rules (§5.4) | You want a vanity hostname, or edge filtering becomes something you actually need |
| Funnel's `.ts.net` hostname | Free TLS with no DNS to manage; but the hostname is fixed by node name, appears in CT logs, and is baked into the registered webhook URL — so node identity becomes load-bearing (§6.4) | Never worth fighting; just pin the hostname and tag the node |
| Dedicated Funnel node rather than the existing subnet router | Adds a second tailnet node to operate; but Serve/Funnel proxies only to its own `127.0.0.1`, so reuse would require co-locating the container on the router anyway — and that would put the node holding every LAN route on the public internet (§6.2) | Tailscale ships non-localhost proxy targets (`tailscale/tailscale#8751`), which would make reuse merely inadvisable rather than impossible |
| Co-tenant on the existing Docker host rather than a dedicated VM | The sidecar's namespace means no port contention with Caddy and no host ports published, so a VM would buy only kernel-level isolation from the other containers — paid for with another OS to patch and another thing to reconstruct after a long gap (§6.3). Tailnet ACLs (§6.4) get most of the benefit for a few lines | You start hosting something on that box you'd genuinely mind losing together with this, or you adopt a general policy of isolating internet-facing workloads |
| Sidecar sharing a network namespace | Nothing binds to the host, which is the cleanest possible exposure story; costs the ability to declare ports on the app service and moves them to the sidecar (§6.3) | You outgrow one-service-per-sidecar |
| Metrics scraped over the LAN, never given a Serve handler | Keeps `tailscaled`'s config down to the single handler that is meant to be public, so `AllowFunnel`'s port-level granularity has nothing to over-expose (§5.4, §6.5) | Prometheus moves onto the tailnet — then add the handler on a Funnel-incapable port such as `:9443`, not under `:443` |
| `Issue` events only | Simplest subscription, avoids the self-echo loop (§4.1); means non-issue changes are still poll-latency | Never, unless a future feature reacts to Linear comments or projects |
| Nudge on any `Issue` event, without filtering on `updatedFrom` | Some triggered cycles find nothing to do; avoids a filter bug silently costing latency (§4.2) | Triggered-cycle volume shows up in rate-limit metrics |
| Poll interval to 300s, not higher | Bounded by Todoist-originated transitions and task-count freshness (§7), not by Linear | Todoist webhooks land (§12) |
| External blackbox probe instead of querying Linear's webhook API | Keeps `LINEAR_API_KEY` non-admin, needs no code, and catches ingress failure in one scrape interval rather than up to 6 hours later; costs one container and misses the "disabled by hand in the UI" case (§8.2) | You start disabling webhooks by hand often enough to want that covered — and are willing to put an admin-scoped key in the container to get it |
| Probe's correctness depends on a pinned resolver | `dns: ["1.1.1.1"]` looks arbitrary until you know why; without it the probe can silently pass forever (§8.2) | Never — this is the failure mode most likely to fool a future reader |
| Debounce of 2s | Adds 2s to the best case, which is still ~30× better than the 60s it replaces | Sub-second latency ever matters, which for a personal task mirror it does not |
