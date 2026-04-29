---
status: accepted
date: 2026-04-20
deciders: csa-inabox platform team
consulted: security audit (CSA-0030 / CSA-0042 / CSA-0061), portal engineering, SRE
informed: portal maintainers, governance, ops
---

# ADR 0020 — Portal observability (OTel + Prometheus) and per-principal rate limiting

## Context and Problem Statement

The audit surfaced three interlocking gaps on the portal FastAPI
backend:

- **CSA-0042 (observability)** — the portal emits structlog JSON but
  has no distributed tracing. Debugging cross-service latency (SPA →
  BFF → upstream API → Postgres) requires stitching request ids
  manually. Federal customers preparing ATO packages need
  OpenTelemetry parity with the rest of the Azure-native stack.
- **CSA-0061 (metrics)** — no in-process metric surface exists.
  Prometheus scrape jobs in the cluster have no endpoint to target,
  and internal counters (MSAL token-cache hits, SQLite store
  operations, async-store errors) are invisible to SRE dashboards.
- **CSA-0030 (rate limiting)** — write endpoints on `/api/v1/sources`,
  `/api/v1/access`, and `/api/v1/pipelines` are unthrottled. A
  misbehaving integration or a compromised Contributor token can
  DoS the backing store with registration churn.

All three must land without breaking the existing deployment footprint
(the portal must still boot when the optional OTel / Prometheus / slowapi
extras are absent) and without adding a hard dependency on a running
collector or Redis in local dev loops.

## Decision Drivers

- **Graceful degradation.** Every optional dependency (`opentelemetry-*`,
  `prometheus_client`, `slowapi`) is imported lazily inside the
  functions that need it. Missing extras + feature flags off = no-op,
  full stop.
- **Feature-flagged by default.** Back-compat requires every new
  surface to default off. Operators flip the flag per-environment.
- **Zero cross-module coupling in routers.** Rate-limit decorators on
  endpoints stay decorator-shaped even when the limiter is the no-op
  stub — no `if enabled:` branches in route bodies.
- **Per-principal, not per-IP.** Rate-limit keying must resolve to the
  authenticated user's oid when available so multiple users behind the
  same NAT aren't penalised for each other's traffic.
- **Label-cardinality discipline.** Prometheus labels use the FastAPI
  route template (`/api/v1/sources/{source_id}`) not the concrete URL
  so cardinality is bounded by the route table.

## Considered Options

1. **OpenTelemetry + Prometheus client + slowapi (chosen).**
2. **Azure Monitor OpenTelemetry distro** — pulls in the full
   `azure-monitor-opentelemetry` bundle. Rejected because it assumes
   Application Insights is the terminal collector; operators who run
   their own OTel pipeline (Tempo, Jaeger, Grafana Agent) would fight
   the auto-configuration. Vanilla OTel + OTLP is the portable choice.
3. **asgi-prometheus** — single-package shortcut. Rejected because it
   mounts against the default registry, making test isolation
   awkward, and offers no hooks for the in-process custom counters
   the ticket demands.
4. **Built-in slowapi alternative (limits directly).** Rejected because
   slowapi ships a FastAPI-idiomatic decorator, 429 handler, and
   ASGI middleware out of the box; `limits` alone would require
   reimplementing those surfaces.

## Decision Outcome

Adopt option 1. Implementation lives under
`portal/shared/api/observability/`:

- `tracer.py` — OTel bootstrap with OTLP HTTP/Protobuf exporter,
  W3C Trace-Context propagation, and auto-instrumentation of FastAPI,
  httpx, SQLAlchemy, and redis. Activation gate:
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- `metrics.py` — private `CollectorRegistry` with the HTTP counter
  / histogram / error triple, plus three in-process custom counters
  (`portal_bff_token_cache_hits_total`, `portal_sqlite_store_ops_total`,
  `portal_async_store_errors_total`). `/metrics` endpoint is flag
  gated (`PORTAL_METRICS_ENABLED`) and optionally bearer-gated
  (`PORTAL_METRICS_AUTH_TOKEN`).
- `rate_limit.py` — slowapi `Limiter` with moving-window strategy
  keyed on SHA-256-truncated oid (falling back to IP). Per-route
  env overrides via `PORTAL_RATE_LIMIT_<ROUTE>_PER_MINUTE`;
  defaults are 60/minute for writes, 300/minute for reads.

All three are wired into `portal/shared/api/main.py` at app-build
time. The OTel bootstrap runs inside `lifespan` so the tracer
provider is owned by the same event loop that serves traffic;
shutdown flushes batched spans via `shutdown_tracing()`.

### Standard span attributes

Hand-authored spans carry the portal's canonical attribute set so
SIEM queries can slice by portal-specific dimensions:

| Attribute                    | Meaning                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `portal.route`               | Logical route name (e.g. `sources.register`).                |
| `portal.user_principal_hash` | SHA-256 prefix of the caller's oid — stable, non-reversible. |
| `portal.domain_scope`        | Resolved `DomainScope` (Admin or per-domain).                |
| `portal.store_backend`       | `sqlite` / `postgres` / `mixed`.                             |

### Standard rate-limit budget

Per-route write/read defaults:

| Route                                                     | Default    |
| --------------------------------------------------------- | ---------- |
| POST `/api/v1/sources`                                    | 60/minute  |
| PATCH `/api/v1/sources/{id}`                              | 60/minute  |
| POST `/api/v1/sources/{id}/{provision,decommission,scan}` | 60/minute  |
| POST `/api/v1/access`                                     | 60/minute  |
| POST `/api/v1/access/{id}/{approve,deny}`                 | 60/minute  |
| POST `/api/v1/pipelines/{id}/trigger`                     | 60/minute  |
| All GET routes                                            | 300/minute |

Overrides via `PORTAL_RATE_LIMIT_<ROUTE>_PER_MINUTE` env vars.

## Consequences

**Positive.**

- OTel traces propagate via W3C Trace-Context end-to-end; the portal
  plays nicely with Grafana Tempo / Jaeger / Application Insights.
- Prometheus `/metrics` surface gives SRE the standard HTTP RED
  (rate / errors / duration) triple plus MSAL + store counters with no
  per-deployment code changes.
- Rate-limit DoS protection on every write endpoint, per principal,
  tunable per route.
- Back-compat preserved: portal boots cleanly on deployments without
  any of the optional extras installed.

**Negative.**

- Three new optional dependencies on the `portal` extra. The slim
  footprint is preserved because everything is lazy-imported.
- slowapi's in-memory backend is single-process; multi-replica
  deployments must point at Redis via `PORTAL_RATE_LIMIT_STORAGE_URI`.
  Documented in the ADR, operator-visible in the env var name.
- OTel auto-instrumentation adds small per-request overhead; OTel's
  own benchmarks measure < 5 % on FastAPI when the span exporter is
  batch-configured.

## Validation

- `portal/shared/tests/test_observability.py` exercises the tracer
  bootstrap (real SDK + missing-SDK degradation), the `/metrics`
  exposition (flag off → 404, flag on → Prometheus text, bearer
  required when token is set), the in-process metric helpers, and a
  429 rate-limit burst. Baseline of 228 → 244 after landing.
- `curl http://localhost:8000/metrics` returns valid Prometheus
  exposition with the portal's custom counters visible.
- Per-principal 429 responses include `Retry-After` and a human
  readable body.

## Pros and Cons of the Options

### Option 1 — OTel + Prometheus client + slowapi (chosen)

- **Pros.** Portable, vendor-neutral, battle-tested; lazy-importable;
  matches the telemetry stack in the rest of `csa_platform`.
- **Cons.** Three separate optional dependencies to track.

### Option 2 — Azure Monitor OpenTelemetry distro

- **Pros.** One-line setup for App Insights; no OTLP collector
  required.
- **Cons.** Vendor-locks the telemetry target; operators running
  their own OTel collector must disable the auto-configuration;
  heavier dependency graph.

### Option 3 — asgi-prometheus

- **Pros.** Tiny dependency surface; fewer lines to maintain.
- **Cons.** No hook for in-process custom counters at the granularity
  the ticket requires; mounts to the default registry, complicating
  test isolation.

### Option 4 — limits directly

- **Pros.** Fewer packages; finer-grained control.
- **Cons.** Requires re-implementing the decorator, 429 handler, and
  ASGI middleware that slowapi already ships.

## References

- **Code.**
    - [`portal/shared/api/observability/__init__.py`](../../portal/shared/api/observability/__init__.py)
    - [`portal/shared/api/observability/tracer.py`](../../portal/shared/api/observability/tracer.py)
    - [`portal/shared/api/observability/metrics.py`](../../portal/shared/api/observability/metrics.py)
    - [`portal/shared/api/observability/rate_limit.py`](../../portal/shared/api/observability/rate_limit.py)
    - [`portal/shared/api/main.py`](../../portal/shared/api/main.py) — observability wiring.
    - [`portal/shared/tests/test_observability.py`](../../portal/shared/tests/test_observability.py)
- **Specs.**
    - [W3C Trace-Context](https://www.w3.org/TR/trace-context/)
    - [OpenTelemetry Protocol (OTLP)](https://opentelemetry.io/docs/specs/otlp/)
    - [Prometheus exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/)
- **Related ADRs.**
    - [ADR-0014](./0014-msal-bff-auth-pattern.md) — BFF auth (feeds the
      token-cache hit counter).
    - [ADR-0016](./0016-async-store-backend.md) — async store backend
      (feeds the SQLite op counter).
    - [ADR-0019](./0019-bff-reverse-proxy.md) — HMAC-sealed MSAL token
      cache (feeds the tamper metric label).
