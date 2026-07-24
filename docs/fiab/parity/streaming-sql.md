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

Zero ❌. The only non-functional state is the documented honest infra-gate
(opt-in stateful-streaming tier, ~$150–300/mo/cloud).

## Backend per control

| Control | Backend |
|---|---|
| Materialize | `POST /api/streaming-sql/mv` → `executeStreamingDdl` (pg wire → RisingWave frontend :4566), audited |
| Preview / Peek | `POST /api/streaming-sql/query` → `runStreamingQuery` (read-only guard), audited |
| MV status panel | `GET /api/streaming-sql/status` → `readStreamingStatus` (real `rw_catalog` reads) |
| Add source / sink | `POST /api/streaming-sql/mv` with `{ kind, spec }` → pure DDL builders |

## Sovereignty (IL5)

RisingWave runs in-boundary (ACA, internal TCP ingress) and reaches only the
in-VNet Event Hubs Kafka endpoint + ADLS Gen2. No SaaS streaming service, no
Microsoft Fabric / OneLake / Power BI — the tier runs disconnected in an
air-gapped Gov / IL5 enclave.
