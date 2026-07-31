# Streaming SQL on RisingWave

> **Surface:** Streaming SQL editor (`/items/streaming-sql/<id>`) — **Author**, **Materialized views**, **Sources & sinks** tabs
> **Backend:** `loom-risingwave`, an internal-ingress Container App running single-node RisingWave (Apache-2.0), consuming Azure Event Hubs through the namespace's Kafka-protocol endpoint and sinking to Delta/Iceberg on your own ADLS Gen2
> **Kill-switch flag:** `n7a-streaming-sql` (default ON)
> **Honest gate:** `LOOM_RISINGWAVE_URL` (gate id `svc-loom-risingwave`) — the editor still renders fully

The **stateful** streaming tier above Azure Stream Analytics. Author streaming
**materialized views** in ordinary SQL over Event Hubs; RisingWave maintains
them incrementally and continuously, and the result is sunk to Delta/Iceberg on
your lake or served over the Postgres wire.

## Why it exists

Azure Stream Analytics is the light default and stays the right tool for simple
jobs. What it cannot express is the class of query that needs durable state:
windowed joins across two streams, incremental aggregations that must survive a
restart, a continuously-correct materialized view rather than a periodic batch.

RisingWave is a self-contained Rust binary with **no external control plane**.
It reaches only the in-VNet Event Hubs Kafka endpoint and in-boundary ADLS
Gen2 — no SaaS streaming service is in the path, so the whole tier runs
disconnected in an air-gapped enclave.

## How to use it end to end

1. **Create a Streaming SQL item** from the catalog.
2. **Sources & sinks tab — define a source.** The builders are
   dropdown-driven (no freeform config): pick the Event Hubs namespace, hub and
   consumer group, and the format. Loom compiles the structured spec to a
   `CREATE SOURCE` over the Event Hubs Kafka endpoint.
3. **Sources & sinks tab — define a sink.** Same shape: pick the target and Loom
   compiles a `CREATE SINK` writing Delta or Iceberg to your ADLS Gen2, so a
   streaming result lands in the same lake the batch world reads.
4. **Author tab — write the view.** A Monaco SQL editor over the shared
   resizable results split. Write the SELECT that defines your materialized
   view.
   - **Preview** runs a read-only `SELECT` against the tier
     (`/api/streaming-sql/query`) so you can check the shape before you commit.
   - **Materialize** runs the `CREATE MATERIALIZED VIEW`
     (`/api/streaming-sql/mv`).
5. **Materialized views tab — watch it fill.** The status panel is read from
   **RisingWave's own catalog** (`/api/streaming-sql/status`): each view's
   definition, its backfill progress, and its current materialized row count —
   throughput as it fills. Not a synthetic progress bar.
6. **Consume the result** from the sink (Delta/Iceberg on your lake, readable by
   every downstream Loom item and, via
   [Iceberg interop](iceberg-interop.md), by external engines) or directly over
   the Postgres wire.

## What the backend actually does

| Control | Backend |
|---|---|
| Preview | `POST /api/streaming-sql/query` -> read-only SELECT on RisingWave |
| Materialize | `POST /api/streaming-sql/mv` -> `CREATE MATERIALIZED VIEW` |
| Status panel | `GET /api/streaming-sql/status` -> RisingWave's own catalog |
| Source / sink builders | Structured specs compiled to `CREATE SOURCE` / `CREATE SINK` |
| Wire protocol | RisingWave speaks the PostgreSQL wire protocol on its frontend port, so the console talks to it with the same driver the Lakebase and Weave paths use — not an HTTP API |
| Audit | Streaming DDL is a privileged mutation and a query is a data-access event; both write an `_auditLog` row and fan out through the SIEM stream. Mutations emit the event first, synchronously, before the awaited Cosmos write. |

The container has **internal ingress**. The Console BFF is the sole door, and
every statement flows through the audited routes.

## Deployment (default ON) and honest gates

**`LOOM_RISINGWAVE_URL` is set by the deployment itself.** Since 2026-07-28
`admin-plane/main.bicep` deploys
`platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep` on every
apps-enabled deploy, in **every Container Apps boundary — Commercial, GCC,
GCC-High and IL5** — and wires `<fqdn>:4566` onto the Console. A fresh
push-button deploy closes the `svc-loom-risingwave` gate with no operator step.

**Cost, stated plainly.** This is the one runtime in the band that cannot honour
"scale to zero so default-ON stays cheap": a single-node RisingWave keeps its
materialized-view and meta state **in process**, so a scaled-to-zero replica
loses every MV definition and its progress. It therefore runs `minReplicas: 1`
at the smallest ACA-Consumption-legal footprint — **2.0 vCPU / 4.0 GiB** (the
profile requires memory == 2 x vCPU GiB). **Budget the ACTIVE rate: about $150
per month per cloud, 24/7.** Azure Container Apps applies its idle rate only
while a replica stays under 0.01 vCPU *and* under 1 KB/s
([billing](https://learn.microsoft.com/azure/container-apps/billing)), and an
engine running meta heartbeats, barriers and periodic compaction does not
qualify — planning against an "idle" figure understates the bill. Raise it to
the 4.0 vCPU / 8.0 GiB ceiling through the module's config bag for heavier
topologies.

**Durability caveat.** `minReplicas: 1` buys continuity *within a revision*, not
durability. The Container App has no volume mount and `RW_STATE_STORE` is unset
by default, so the replica filesystem is ephemeral: an ACA revision roll or a
platform replica replacement drops the materialized views regardless. Set
`stateStore` (→ `RW_STATE_STORE`) to the ADLS hummock store through the config
bag for a genuinely durable deployment.

**Admin opt-out (a disable toggle, never an enablement wizard).** Set
`observabilityConfig.backendOverrides.risingwave = 'disabled'` at the root
orchestrator (or `loomBackends.risingwave = 'disabled'` on the admin-plane
module) to skip the app entirely; `LOOM_RISINGWAVE_URL` is then emitted empty.
The var can also be blanked live from `/admin/env-config`.

**With the var unset the full editor still renders with a Fix-it gate**, never a
blocker: Azure Stream Analytics remains the light default for simple jobs, and
the `stream-analytics-job` item type is a separate surface that this gate does
not touch.

To wire it by hand (an already-running estate, or the incremental Gov path in
`.github/workflows/gov-provision-streaming-migrate.yml`): deploy
`platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep` **with
`risingwaveConfig.rootPasswordSecretUri`** (see Authentication below), then set
`LOOM_RISINGWAVE_URL` on the Console app to the internal-ingress FQDN
(optionally `host:port`) and `LOOM_RISINGWAVE_PASSWORD` as a Key-Vault-backed
`secretref`. Optional: `LOOM_RISINGWAVE_DATABASE` (default `dev`),
`LOOM_RISINGWAVE_USER` (default `root`).

## Security — one routable port, and it requires a password

Two separate defects were found here, a day apart. Both are closed in the image.

### Defect 1 — the wire had no credential (2026-07-29)

RisingWave ships its `root` **superuser with no password**: with `AuthInfo`
unset the frontend's `UserAuthenticator` is `None`, so anything that can open a
TCP connection to port 4566 *is* root.

On 2026-07-29 this module was deployed to the live Commercial estate and
inspected. The container had env `[LOOM_LAKE_ACCOUNT]` and **zero secrets**, on
`cae-csa-loom-centralus` — the same Container Apps environment as
`loom-script-runner` and `loom-udf-runtime`, two services whose purpose is
executing user-supplied code. It was removed from the estate the same day, and
the `svc-loom-risingwave` gate went back to blocked, because "not shippable yet"
was the honest status.

### Defect 2 — the credential only covered 4566 (2026-07-30)

`single_node` binds **five** routable ports. Measured, not assumed — read off
`/proc/net/tcp` inside a running stock `risingwavelabs/risingwave:v2.1.3`:

| Port | Bind | Service | Authentication |
|---|---|---|---|
| 4566 | `0.0.0.0` | Postgres-wire SQL frontend | credential (defect 1's fix) |
| 5688 | `0.0.0.0` | compute-node gRPC — Exchange / Task / Config / Monitor | **none** |
| 5690 | `0.0.0.0` | meta-node gRPC — Cluster / **Ddl** / HummockManager | **none** |
| 5691 | `0.0.0.0` | meta dashboard HTTP + REST API | **none** |
| 6660 | `0.0.0.0` | compactor gRPC | **none** |
| 1260 | `127.0.0.1` | prometheus metrics (1222/2222 collapse here) | loopback only |
| 6786 | `127.0.0.1` | frontend health-check gRPC | loopback only |

The meta gRPC service alone can create and drop catalog objects. **"Internal" is
not a property of a Container Apps port:** ingress publishes only `targetPort`,
but ingress is not a firewall — a replica holds a VNet IP from the environment's
infrastructure subnet, so a sibling app reaches any listening port on the **pod
IP** directly, past ingress and past `ipSecurityRestrictions`.

`single_node` cannot be made to bind them elsewhere. Upstream hard-codes the
addresses in `map_single_node_opts_to_standalone_opts`
(`src/cmd_all/src/single_node.rs`, v2.1.3):

```rust
meta_opts.listen_addr      = "0.0.0.0:5690".to_string();
meta_opts.dashboard_host   = Some("0.0.0.0:5691".to_string());
compute_opts.listen_addr   = "0.0.0.0:5688".to_string();
compactor_opts.listen_addr = "0.0.0.0:6660".to_string();
```

and `single_node --help` exposes only `--listen-addr` (the *frontend*) and
`--prometheus-listener-addr`.

### Why the fix is in the image, not in the network

| Candidate | Why it fails |
|---|---|
| ACA ingress IP rules (`ipSecurityRestrictions`, the `consoleAllowedCidrs` shape) | Two reasons. Every app in a Container Apps environment draws its pod IP from the **same infrastructure subnet**, so any CIDR that admits the Console also admits `loom-script-runner` and `loom-udf-runtime`. And the rules only govern the *ingress* path — a direct pod-IP connect to 5690 never touches them. |
| A dedicated Container Apps environment | Same problem one level up. Its infrastructure subnet is routable from the peer subnets in the VNet, and an NSG keyed on the Console's subnet again admits the code-execution apps, because they share it. |
| An in-container packet filter (`iptables`/`nftables`) | Needs `NET_ADMIN`. Container Apps does not grant it. |

**Removing the listener is strictly stronger than filtering it.** So the engine
runs in `standalone` mode, which exposes per-node options, with every non-wire
listener pinned to `127.0.0.1`. Everything else is byte-identical to what
`single_node` derives — the engine's own parsed-opts log lines were diffed
between the two invocations on the pinned image: meta backend `Sqlite`,
`--sql-endpoint <store>/meta_store/single_node.db`,
`hummock+fs://<store>/state_store`, `hummock_001`,
`total_memory_bytes 4509715660`, `parallelism 2` and both
`*_total_memory_bytes` all match; only the four addresses differ.

### The bootstrap

1. `admin-plane/main.bicep` derives an unpredictable password from
   `loomGeneratedSecretSeed` (`newGuid()`) — the same construction the Airflow
   admin password uses, never `guid(rg.id, <public-const>)`.
2. `admin-plane/keyvault.bicep` writes it as the KV secret
   `loom-risingwave-root-password` and grants **Key Vault Secrets User** to the
   `loom-risingwave` UAMI. The Console already holds Key Vault Secrets Officer.
   Nothing else in the environment is granted anything on that secret, so the
   code-execution apps cannot obtain it.
3. Both apps bind it as a **Key-Vault-backed Container Apps secret** resolved by
   their own managed identity at revision start — `LOOM_RW_ROOT_PASSWORD` on the
   engine, `LOOM_RISINGWAVE_PASSWORD` on the Console. Neither is ever a plain
   env literal, and the value never enters the template, the deployment history
   or `az containerapp show`.
4. `apps/loom-risingwave/scripts/entrypoint.sh` **fails closed at every step**:
   - no `LOOM_RW_ROOT_PASSWORD` → exit 1 before anything listens;
   - **phase 1 (sealed)** starts the engine with *every* listener on
     `127.0.0.1`, including the wire port, then asserts from `/proc/net/tcp` +
     `/proc/net/tcp6` that there are **zero** routable listening sockets. That is
     the measurement proving the per-node options took effect on this binary, and
     it is taken while nothing at all is reachable from the pod IP;
   - still sealed, it applies `ALTER USER root PASSWORD` and verifies that a
     password-less connection is now **rejected** and the configured one
     **accepted**;
   - **phase 2 (serving)** restarts against the same store directory (the SQLite
     meta store carries root's md5 credential across the restart) with only the
     frontend moved to `0.0.0.0`, then asserts the surface again: **exactly one**
     routable listener and it must be the wire port. Anything else and the
     container dies instead of serving.

   A `--selftest` mode exercises the loopback-vs-routable classifier against a
   synthetic procfs snapshot, and the Dockerfile runs it at **build** time — a
   broken hex comparison there would make both runtime assertions pass vacuously,
   which is exactly the "green gate measuring nothing" failure this repo has been
   burned by.

Re-applying the `ALTER USER` on every boot makes rotation free: change the Key
Vault secret and roll both revisions.

**Side effect worth knowing:** under `single_node`, `RW_STATE_STORE` /
`RW_DATA_DIRECTORY` were read by clap and then *silently overwritten* with the
local-filesystem store, so the module's `stateStore` knob was inert. Under
`standalone` they take effect.

**Still open, disclosed:** ACA TCP ingress does not terminate TLS, so the
connection itself is plaintext. The credential is not exposed by that — the
handshake is a salted md5 challenge, not a cleartext password — but query text
and results are. Frontend TLS plus `ssl` on the `pg` client is the follow-up.

The dashboard is still there, just not routable — reach it with
`az containerapp exec -n loom-risingwave … -- curl -s 127.0.0.1:5691`.

## Getting the image into a sovereign ACR (GCC-High / IL5)

The Container App is deployed by the same template in Gov, so the only Gov
prerequisite is the same one `loom-console` has: **the image must already be in
that boundary's registry**, at the tag `appImageTags.risingwave` resolves to
(`v0.1` by default in `params/gcc-high.bicepparam` and `params/il5.bicepparam`).
A Container App whose manifest is absent fails its PUT with `MANIFEST_UNKNOWN`.

Both Gov producers build **server-side** with `az acr build`, which is the only
mechanism that reaches a registry provisioned `publicNetworkAccess=Disabled`:

| Workflow | Use it for |
|---|---|
| `.github/workflows/build-fiab-images-acr-tasks.yml` (`boundary=GCC-High` or `IL5`) | The full image set, including `loom-risingwave` and `loom-migrate`. |
| `.github/workflows/gov-provision-streaming-migrate.yml` (`mode=build-only`) | Just these two, as phase 2 of a from-scratch install. `mode=build-and-deploy` also stands the Container Apps up and wires the vars on an estate that is already running. |

**Not** `build-fiab-images.yml` — it authenticates with the *Commercial* service
principal, never runs `az cloud set --name AzureUSGovernment`, and pushes
client-side, so it cannot produce a Gov image. It now hard-fails when dispatched
with a Gov boundary rather than silently producing nothing.

## Kill-switch

`n7a-streaming-sql` — default ON. Flipping it OFF replaces the editor body with
a guided notice on the next render. The `loom-risingwave` Container App, the
`/api/streaming-sql/**` routes, and every already-created item are unaffected.
**Azure Stream Analytics (`stream-analytics-job`) is a separate item type and is
not touched by this flag.**

## Related

- [Iceberg REST catalog and interop](iceberg-interop.md) — reading the sink from anywhere
- Editor guide — [Eventstream](../tutorials/editor-eventstream.md) · [Stream Analytics job](../workloads/stream-analytics-job.md)
- [Real-Time Intelligence parity](../workloads/real-time-intelligence.md)
