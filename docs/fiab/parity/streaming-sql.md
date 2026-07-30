# streaming-sql — parity with RisingWave streaming SQL (Openness Tier-2 T2-A)

Source UI: RisingWave Cloud / `psql` streaming-SQL workflow
(https://docs.risingwave.com/docs/current/intro/) — the reference surface for
authoring streaming materialized views over Kafka/Event Hubs. There is no Azure
*portal* analog for stateful streaming SQL; Azure Stream Analytics (a separate
Loom item, `stream-analytics-job`) covers the LIGHT/simple-job tier only, so this
is the stateful-tier build-out, not a 1:1 portal twin.

## RisingWave feature inventory (grounded in the RisingWave docs)

| Capability | Notes |
|---|---|
| CREATE SOURCE over Kafka | Consume a topic with a typed schema + payload format |
| CREATE MATERIALIZED VIEW | Streaming MV maintained incrementally (joins, aggregations, windows) |
| Multi-stream JOIN in an MV | The stateful class ASA cannot express |
| CREATE SINK to Delta / Iceberg | Land the maintained result into a lakehouse |
| Postgres-wire serving | Query the MV directly (`SELECT … FROM mv`) |
| MV status / progress | `rw_catalog.rw_materialized_views`, `rw_ddl_progress`, row counts |
| DROP MATERIALIZED VIEW / SOURCE / SINK | Lifecycle management |

## Loom coverage

| Row | Status | Loom surface |
|---|---|---|
| CREATE SOURCE over Kafka (Event Hubs) | ✅ built | Sources & sinks → "Add an Event Hubs source" (dropdown-driven builder → `buildEventHubKafkaSourceSql` → `/api/streaming-sql/mv`) |
| CREATE MATERIALIZED VIEW | ✅ built | Author tab (Monaco SQL → Materialize → `/api/streaming-sql/mv`) |
| Multi-stream JOIN MV | ✅ built | Author tab + `buildTwoStreamJoinMvSql` structured builder (`kind: mv-join`) |
| CREATE SINK to Delta / Iceberg | ✅ built | Sources & sinks → "Add a lake sink" (`buildLakeSinkSql`, `abfss://` on the DLZ lake) |
| Postgres-wire serving / preview | ✅ built | Author → Preview + Materialized views → Peek (`/api/streaming-sql/query`, read-only guard) |
| MV status / throughput / backfill | ✅ built | Materialized views tab (real `rw_catalog` read via `/api/streaming-sql/status`) |
| DROP MV / SOURCE / SINK | ✅ built | authored DDL accepted by `assertStreamingDdl` on `/api/streaming-sql/mv` |
| Tier not deployed | ⚠️ honest-gate | Fluent MessageBar naming `LOOM_RISINGWAVE_URL` + inline Fix-it (gate `svc-loom-risingwave`); full surface still renders |

Zero ❌. The tier is deployed **by default** with the estate
(`admin-plane/main.bicep` → `data-plane/loom-risingwave-aca.bicep`, every
Container Apps boundary), so the honest infra-gate is only reachable on a
pre-2026-07-28 estate, before the apps tier deploys, or after an explicit admin
opt-out (`loomBackends.risingwave='disabled'`). Disclosed cost of that default:
1 replica at 2.0 vCPU / 4.0 GiB — a streaming engine cannot scale to zero
without losing its materialized-view state — budgeted at the ACA **active**
rate, about $150/mo per cloud (the idle rate needs <0.01 vCPU and <1 KB/s, which
the engine does not hold).

## Backend per control

| Control | Backend |
|---|---|
| Materialize | `POST /api/streaming-sql/mv` → `executeStreamingDdl` (pg wire → RisingWave frontend :4566), audited |
| Preview / Peek | `POST /api/streaming-sql/query` → `runStreamingQuery` (read-only guard), audited |
| MV status panel | `GET /api/streaming-sql/status` → `readStreamingStatus` (real `rw_catalog` reads) |
| Add source / sink | `POST /api/streaming-sql/mv` with `{ kind, spec }` → pure DDL builders |

## Attack surface (one routable port, credential-gated)

Two defects, a day apart:

1. **2026-07-29 —** upstream RisingWave's `root` superuser has **no password**,
   and every app in a Container Apps environment draws its pod IP from the
   **same infrastructure subnet**, so on the live Commercial estate the engine
   was reachable as root by `loom-script-runner` and `loom-udf-runtime`, which
   execute user-supplied code. Removed from the estate.
2. **2026-07-30 —** the credential covered only 4566. Measured on the pinned
   image, `single_node` binds **five** routable ports; four have no
   authentication at all: compute gRPC 5688, meta gRPC 5690 (create/drop catalog
   objects), meta dashboard + REST 5691, compactor gRPC 6660. Ingress publishes
   only `targetPort`, but ingress is not a firewall — a sibling app reaches any
   listening port on the pod IP directly.

Upstream hard-codes those four addresses in
`map_single_node_opts_to_standalone_opts` and offers no flag or env var for
them, so the engine now runs in `standalone` mode with every non-wire listener
pinned to `127.0.0.1` (byte-identical opts otherwise). No CIDR rule or dedicated
environment can separate environment siblings, and an in-container packet filter
needs `NET_ADMIN`, which ACA does not grant — **removing the listener is
strictly stronger than filtering it.**

| Control | Backend |
|---|---|
| Routable surface | `4566` only. Meta / dashboard / compute / compactor bound `127.0.0.1` by `apps/loom-risingwave/scripts/entrypoint.sh`; `EXPOSE` narrowed to `4566` |
| Engine root credential | KV secret `loom-risingwave-root-password` → Container Apps **Key-Vault-backed secretRef** `LOOM_RW_ROOT_PASSWORD` resolved by the engine UAMI |
| Console credential | the SAME KV secret → `LOOM_RISINGWAVE_PASSWORD` secretRef resolved by the Console UAMI |
| Enforcement — credential | refuses to start without it; installs it against an all-loopback engine; proves an anonymous connect is rejected before any routable port exists |
| Enforcement — ports | phase 1 asserts **zero** routable listeners from `/proc/net/tcp{,6}`; phase 2 asserts **exactly one**, and it must be the wire port. Either assertion failing kills the container |
| Enforcement — build gate | `entrypoint.sh --selftest` checks the loopback-vs-routable classifier against a synthetic procfs snapshot, run in the Dockerfile so a broken classifier cannot ship a vacuously-green runtime assertion |
| Who can read the secret | the engine UAMI (Key Vault Secrets User) and the Console UAMI (Key Vault Secrets Officer). Nothing else in the environment. |

Residual ⚠️: ACA TCP ingress does not terminate TLS, so statements/results are
plaintext in-VNet (the credential is not — md5 salted challenge). Tracked.

## Sovereignty (IL5)

RisingWave runs in-boundary (ACA, internal TCP ingress) and reaches only the
in-VNet Event Hubs Kafka endpoint + ADLS Gen2. No SaaS streaming service, no
Microsoft Fabric / OneLake / Power BI — the tier runs disconnected in an
air-gapped Gov / IL5 enclave.
