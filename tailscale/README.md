# Tailscale Funnel serve config

Mounted read-only into the `tailscale` sidecar by `docker-compose.webhook.yml`.
Full rationale in [`../docs/design/linear-webhooks-design.md`](../docs/design/linear-webhooks-design.md) §6.5.

## Why there is exactly one handler

**`AllowFunnel` is keyed per `host:port`, not per path.** Every handler sharing a
Funnel'd port is public, so adding a second one here publishes it to the internet —
and a config that does so looks entirely unremarkable at a glance.

That is why `/metrics` is absent: Prometheus scrapes it over the LAN via the port
published on the `tailscale` service instead, so it never enters this file at all.

If you ever do need a Serve handler for metrics — because Prometheus moved onto the
tailnet — **do not add it under `${TS_CERT_DOMAIN}:443`**. Put it on a port Funnel
structurally cannot serve. Funnel is limited to `443`, `8443` and `10000`, so `:9443`
works and can never be exposed by an `AllowFunnel` typo. `:8443` is a poor choice for
exactly the reason `:443` is.

## Verifying

```sh
docker compose -f docker-compose.webhook.yml exec tailscale tailscale funnel status
```

Should show one path public and nothing else.
