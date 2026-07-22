# WS-N — North Star: #1 AI-First Data & Analytics Platform

Part of the master PRP **loom-next-level** (rev 2, pass 2). Author: pass-2 PRP
editor. Date: 2026-07-22.
Sources (read-only, this session): `temp/prp-research/datastack.md` (openness /
modern-data-stack fold-ins), `temp/prp-research/ai-first.md` (agentic trust
stack + competitive bar: Genie One/Ontology, Cortex Analyst/VQR, Spotter,
Fabric IQ/Foundry IQ), `temp/prp-research/bi-dx-gov.md` (BI/DX/governance
edge). Each carried tiered PR-sized specs; this workstream synthesizes them
into ONE coherent backlog under three strategic pillars plus the sovereign
moat.

## The thesis (why these three pillars make Loom #1, not parity)

1. **OPENNESS** — the 2026 stack consolidated on open, engine-neutral
   primitives (Iceberg REST catalog, Arrow/Flight SQL/ADBC, DuckDB, SQLMesh,
   asset semantics, ODCS contracts). Loom already owns the hard parts
   (Delta-on-ADLS, a Rust DataFusion/Arrow scan service emitting Arrow IPC, a
   Debezium mirroring engine, dbt-in-CI). The gap is **interop, not compute**:
   make Loom's lakehouse speak the protocols Snowflake/Databricks/Trino/DuckDB
   clients already speak — *one lakehouse, every engine, zero migration*.
2. **TRUST / AI-FIRST** — every incumbent shipped a Copilot; the 2026
   differentiator is **grounding quality + verification rigor** (semantic-layer
   contract: Sonnet 4.6 90.0→98.2%, GPT-5.3-Codex 84.1→100.0% vs raw
   text-to-SQL; GraphRAG: 3.4× multi-hop, 30-40% fewer factual errors). Loom is
   the ONLY platform owning all three grounding substrates in one product — a
   metrics layer, an authored Apache-AGE ontology, and an agent mesh/MCP/A2A
   fabric. Fuse them: *contract → graph → verified loop → receipt → MCP/A2A*.
3. **GOVERNED ANALYTICS** — the crown-jewel bets nobody holds end-to-end on
   Azure: a headless OSI-compatible metrics layer serving BI + NL2SQL + API
   from one definition, BI-as-code, and an OpenLineage-backed observability
   incident console. *Governed-by-construction analytics that plays in any
   estate.*

## The sovereign moat (cross-pillar design principle — EVERY N-item's IL5 note serves it)

> **The same agentic analyst, disconnected.** Databricks, Snowflake, and
> ThoughtSpot are SaaS-first and structurally cannot follow Loom into
> IL5/air-gap. Every N-item is designed so its full capability runs on
> in-boundary services: in-VNet Postgres/AGE (graph + pgvector vectors),
> in-VNet MLflow/eval (no Braintrust/LangSmith SaaS), self-hosted OSS
> containers on ACA/AKS (Unity Catalog OSS, DuckDB, SQLMesh, RisingWave,
> Trino, Debezium), Cosmos-backed agent memory, fail-closed egress profiles
> (already in `agent-registry`), and receipts as the compliance artifact.
> An N-item whose IL5 note says "not available disconnected" without naming
> the in-boundary fallback is NOT done. This section is the un-numbered
> reference block (like X-MATRIX) that reviewers check every N-item against.

> **Conventions inherited from the master PRP (binding on every N-item):**
> PR-sized with stable IDs; goal/why (research-cited), Loom current state,
> exact files/services, bicep-sync (**R0 param-cap rule** — all new bicep
> params ride the config-object pattern, never a new top-level `param`),
> env/gates (ENV_CHECKS + `lib/gates/registry.ts` + Fix-it per G2, EnvSpecs
> carry the **X2 `availability`** field, serialize on the env-checks/registry
> files), the **O1 alert standard** for anything that alerts, the **Function
> standard** for any new Function, the **audit standard** for privileged
> mutations, per-cloud contract (Commercial / GCC-High / IL5 note), acceptance
> incl. a **G1 real-data E2E receipt**, and honest sizing (S/M/L/XL). New
> platform services follow the existing `apps/loom-*` ACA pattern
> (`apps/loom-directlake` precedent): app dir + Dockerfile, bicep module wired
> through the orchestrator, image built by the `full-app-deploy-*` workflows,
> internal ingress + UAMI role grants declared in bicep. Everything defaults
> ON (`loom_default_on_opt_out`), is Fabric-free on the default path
> (`no-fabric-dependency`), and labs items ship Preview-badged.

---

# PILLAR 1 — OPENNESS (from datastack.md)

## N1 — Iceberg REST Catalog over the Loom lakehouse + Delta↔Iceberg dual metadata (FLAGSHIP)

**What/why (research T1-A):** the Iceberg REST Catalog (IRC) protocol is the
metadata lingua franca (S3 Tables, Snowflake Polaris, BigQuery, Databricks
Managed Iceberg all standardized on it); Delta keeps the installed base. The
winning 2026 posture is neutrality: **write Delta, expose Iceberg metadata
(UniForm/XTable), serve an IRC endpoint** — any engine (Spark, Trino, Flink,
DuckDB, Snowflake, Databricks) reads Loom tables off the same customer-owned
ADLS, zero copy. "The defector-maker."

**Loom today:** Delta-only; interop stops at the Synapse Serverless TDS
endpoint; `grep iceberg` hits only docs.

**Build (3 PRs):**
1. **`iceberg-catalog` service** — deploy **Unity Catalog OSS** (preferred:
   natively bridges Delta+Iceberg; Polaris is the alternative) as an ACA
   service: bicep `modules/data-plane/iceberg-catalog-aca.bicep` (internal
   ingress, UAMI Storage Blob Data Reader on the DLZ lake, params via the R0
   config object), env `LOOM_ICEBERG_CATALOG_URL` (ENV_CHECKS + gate + Fix-it,
   `availability:{commercial:true,gccHigh:true,il5:true}` — self-hosted
   container). BFF `/api/catalog/iceberg/**` proxies + injects Entra auth.
2. **UniForm-style dual-metadata write** — extend the lakehouse write/OPTIMIZE
   path (delta-maintenance dialog + Livy job) to emit Iceberg metadata via
   Apache XTable/delta-rs; lakehouse editor gets an **Interop tab** (per-table
   "Expose as Iceberg/Delta" toggles, IRC connection string + copy-paste
   snippets for Spark/Trino/DuckDB/Snowflake).
3. **`/admin/catalog` federation surface** — namespaces, tables, format badges
   (Delta ✓ / Iceberg ✓), external-engine connection strings, grant mapping;
   honest-gate + Fix-it if the catalog URL is unset.

**Acceptance:** G1 receipt = an EXTERNAL engine (`pyiceberg` or DuckDB iceberg
ext) lists AND reads a real Loom lakehouse table through the IRC endpoint;
Trino/DuckDB reads the same table Loom wrote as Delta (dual-metadata proof);
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset throughout. **Per-cloud:** Commercial +
GCC-High live (ACA + ADLS both GA); IL5 — fully in-boundary (container +
storage only, no SaaS catalog) — this IS the moat item for data interop.
**Serialization:** lakehouse editor (WS-R decomposition targets). **Size: XL.**

## N2 — DuckDB dual-mode: in-browser WASM preview + server-side query tier

**What/why (T1-B):** DuckDB is the frictionless engine of 2026 (ClickBench
top, SO-survey #4). Two folds, both riding Loom's EXISTING Arrow pipeline:
(a) **`duckdb-wasm` preview** — the Preview grid + SQL editors run local SQL
over the Arrow IPC that `loom-directlake` already returns: instant client-side
slice/filter/aggregate, zero server cost, **near-free** (the Arrow producer
exists — this sub-item may ride an earlier phase per the master spine);
(b) **`loom-duckdb` ACA service** (DuckDB + httpfs/delta/iceberg extensions,
UAMI Blob Reader) as the "fast path" tier below Spark — new catalog item
**SQL Lab (DuckDB)** with Monaco + Arrow results; falls back to Synapse
Serverless on unset `LOOM_DUCKDB_URL` (honest gate + Fix-it).

**Files:** preview-grid + SQL-editor wiring in `lib/editors/**`;
`apps/loom-duckdb` + `modules/data-plane/duckdb-aca.bicep`; env per X2 (all
three clouds `true` — embedded OSS binary; wasm is static JS).
**Acceptance:** G1 — filter/group a 100k-row sample entirely client-side (no
network, timing bar proves it); server tier: `delta_scan('abfss://…')` returns
real rows with Fabric unset. **Per-cloud:** identical everywhere; IL5
air-gap-safe (no external calls). **Size: M (wasm) + M (server tier).**

## N3 — Arrow Flight SQL + ADBC serving wire

**What/why (T1-C):** ODBC/JDBC serialization is 60-90% of transfer time;
Flight SQL/ADBC stream Arrow RecordBatches 10-100× faster and are becoming the
standard analytical wire. `loom-directlake` (DataFusion 43) already produces
Arrow IPC — DataFusion has a first-party Flight SQL server, so this extends an
existing service, not new infra.

**Build (3 PRs):** (1) Flight SQL endpoint on `loom-directlake` (or sibling
ACA) fronting DataFusion/DuckDB; `LOOM_FLIGHTSQL_URL`; BFF mints short-lived
Entra-scoped Flight tickets. (2) **Connect tab** on
lakehouse/warehouse/SQL-endpoint items: ADBC/Flight/JDBC connection snippets
(read-only, no secrets). (3) Loom's own large-result grids fetch Arrow over
Flight past a size threshold (measurable latency drop on wide results —
receipt includes the before/after timing).
**Acceptance:** G1 — `adbc_driver_flightsql` (Python) pulls ≥1M rows from a
real lakehouse table in the receipt, with timing vs the TDS path.
**Per-cloud:** gRPC/HTTP2 on ACA works Commercial + Gov; IL5 in-VNet only
(ticket issuance in-boundary). **Size: M–L.**

## N4 — SQLMesh alongside dbt: transform runner + plan/apply UI

**What/why (T1-D):** SQLMesh's virtual data environments + Terraform-style
plan/apply + column-level model diff (~9× cheaper transforms, 136× faster
rollbacks vs dbt Core in the Databricks-led study). dbt keeps the ecosystem —
ship BOTH: a **`transformation-project` item** with backend selector
(`dbt` | `sqlmesh`, default dbt for continuity).

**Build (3 PRs):** (1) `apps/loom-transform-runner` ACA (Python: dbt-core +
sqlmesh + synapse/databricks/duckdb adapters) + bicep +
`LOOM_TRANSFORM_RUNNER_URL`; BFF `/api/transform/**` (plan/apply/run/diff/
env-list). (2) **Plan/apply wizard** — environment picker → impact-diff grid
(model, change type, breaking/non-breaking, downstream, column-level) → apply
(view-swap); SQL is the one allowed freeform surface
(`loom_no_freeform_config`). (3) Model DAG on `canvas-node-kit` as
software-defined assets (feeds N5).
**Acceptance:** G1 — change a model in a dev virtual env, see the real diff,
apply, verify prod untouched until promote; rollback receipt.
**Per-cloud:** OSS Python on ACA, engines all Gov-available; IL5 in-VNet.
**Serialization:** dbt CI workflows (`dbt-ci.yml`) + WS-L L6 (dbt manifest
lineage) — L6's manifest parse consumes this runner's artifacts; coordinate.
**Size: L.**

## N5 — Software-defined-asset semantics over the existing lineage

**What/why (T1-E):** Dagster's reframe — the estate as a graph of ASSETS with
freshness policies and data-aware scheduling, not a pile of pipelines. Adopt
the *semantics* natively (no Dagster runtime): every lakehouse table, MLV,
SQLMesh model, and pipeline output becomes an asset with declared deps
(auto-derived from lineage — **consumes WS-L's columnMappings/unified-lineage,
does not fork it**), a freshness policy, and event-driven materialization.

**Build (3 PRs):** (1) Cosmos-backed asset registry + `/api/assets/**`
(list/lineage/freshness/status), initial graph derived from
`unified-lineage`. (2) **Assets canvas** (canvas-node-kit; freshness/status
chips; per-asset freshness-policy editor, dropdowns only) — stale asset flags;
"Materialize" runs the real backing job. (3) `asset-reconciler` (Function per
the master Function standard OR ACA worker) watching Delta commit versions /
eventstream signals → data-aware triggers into Synapse/Databricks/SQLMesh
runners; alerts via O1 dispatch.
**Acceptance:** G1 — a seeded upstream table updates → the dependent asset
auto-materializes within its policy window; the canvas shows the state flip;
receipt includes the real run id. **Per-cloud:** Cosmos + ADLS + Event Hubs —
all clouds; IL5 in-boundary. **Serialization:** WS-L (`unified-lineage`),
`lineage-canvas`. **Size: L.**

## N6 — ODCS data contracts enforced at ingestion

**What/why (T1-F):** ODCS v3.1 (Linux Foundation Bitol) is the contract
standard; the 2026 lesson is that winners **enforce** — block violations at
ingestion, don't document them. **This is also Pillar-2's trust boundary**
(N14c's AI data-engineering validates against the same contracts).

**Build (3 PRs):** (1) **`data-contract` item + editor** — schema (from bound
table introspection), quality/semantic rules via dropdown builder (no raw
YAML), SLA; stored as ODCS 3.1 JSON in Cosmos; import/export for portability.
(2) **Enforcement hook** in the ingestion paths (mirroring engine, pipeline
sinks, eventstream): conform → land; violate → quarantine to a Bronze
`_rejected` dead-letter path + alert via O1 dispatch. (3) Governance registry
page: contracts, bindings, pass/fail trend.
**Acceptance:** G1 — push a schema-breaking row through the mirroring engine →
rejected + quarantined + alerted, table uncorrupted; receipt shows the
`_rejected` blob path. **Per-cloud:** pure Loom + Azure, all clouds; IL5
in-boundary. **Size: M–L.**

## N7 — Openness Tier-2 (condensed): streaming SQL, CDC control plane, reverse ETL, data diff, Trino

One item id, five sequenced PR-clusters (each individually receipted; split
into separate PRs at implementation — the id groups them for phasing):
- **N7a RisingWave streaming SQL** (T2-A): `streaming-sql` item backed by
  RisingWave on ACA/AKS consuming Event Hubs **via its Kafka-protocol
  endpoint** + Debezium CDC; streaming materialized views in SQL; sink to
  Delta/Iceberg or serve over Postgres wire. ASA stays the light default.
  `LOOM_RISINGWAVE_URL` (X2 all-clouds true — Apache-2.0 container).
  Acceptance: a two-stream join MV updates live and lands in Delta. **L**
- **N7b Debezium CDC control plane** (T2-B): source-connector wizard
  (SQL Server/Postgres/MySQL/Mongo/Oracle) writing the config
  `fiab-mirroring-engine` already consumes + a live connector monitor
  (snapshot %→streaming lag, schema-change events, dead-letter). Contract
  enforcement (N6) at the boundary. Acceptance: add a Postgres source in-UI,
  watch snapshot→streaming, rows land in Bronze Delta. **M**
- **N7c Reverse ETL / activation-sync item** (T2-C): source = table/model/
  audience; destinations Dataverse/Dynamics FIRST (S2S already wired per
  memory) + webhook/Event Grid/Service Bus; full/incremental via Delta CDF;
  scheduled by N5 asset triggers. Acceptance: sync a modeled segment to
  Dataverse; incremental picks up CDF changes. **M**
- **N7d Data-quality depth + data-diff** (T2-D): rule-builder checks (Soda
  Core/GE in the N4 transform runner), anomaly baselines, and a **data-diff
  panel** (Delta-version / cross-env row+column diff via time-travel + the N2
  DuckDB engine). Feeds N17's incident console (which owns the incident UX —
  no duplicate surface here). Acceptance: an injected anomaly trips a check;
  a diff of two Delta versions shows the exact changed cells. **M**
- **N7e Trino/Starburst federation (opt-in)** (T2-E): Trino OSS on AKS
  registered against N1's IRC + external connectors; "Federated SQL" engine
  option in the SQL editors + Flight/ADBC exposure (N3). Opt-in (heavy tier;
  DuckDB is the light default) — the ONE Pillar-1 item that is opt-in rather
  than default-ON, disclosed per the master G2 convention.
  Acceptance: one SQL statement joins a Loom Iceberg table with an external
  Postgres table. **L**

**Per-cloud (all five):** OSS containers on ACA/AKS + Azure services GA in
Gov; IL5 self-hosted in-boundary (webhook/Event Grid destinations work
air-gapped; SaaS destinations honest-gated). **Combined size: XL.**

## N8 — Openness Tier-3 labs (one-liners, Preview-badged)

- **DuckLake catalog option** — Postgres-backed lakehouse metadata alongside
  N1's IRC (forward bet on the DuckDB ecosystem). **S**
- **Malloy / PRQL "modern query" mode** — transpile-to-SQL over the N2 DuckDB
  engine in the SQL editor. Community signal, zero prod commitment. **S**
- **S3-compatible ADLS gateway** — MinIO-gateway pattern so `s3://`-native OSS
  clients connect; complements N1. Gov-viable (self-hosted). **M**

Acceptance per labs item: Preview badge + catalog `preview:true` + one real
E2E receipt. **Per-cloud:** self-hosted, all clouds.

---

# PILLAR 2 — TRUST / AI-FIRST (from ai-first.md)

Sequencing inside the pillar (research §6): contract + receipts first (the
trust substrate), then GraphRAG (the headline), then self-heal + LLMOps.

## N9 — Verified Semantic Contract + Verified Query Repository + refuse-not-guess (AIF-2)

**What/why:** the single highest-trust behavior in the category — Snowflake
VQR parity + the 2026 benchmark ("semantic-layer failure looks like an error
message, not a plausible wrong number"). Elevate semantic-model/metric-view
from a grounding *hint* to a **governed contract**: metrics with owners,
descriptions, synonyms + a **VQR** of approved question→query pairs; the agent
retrieves verified queries first, routes unmatched questions through
metric-grounded generation, and **refuses out-of-contract questions with a
guided message** instead of guessing.

**Loom has:** the semantic-model grounding path, metric-view execute,
`explain-metric-panel`, `data-agent-reasoning.ts` loop.
**Build (3 PRs):** (1) `lib/azure/semantic-contract.ts` — metric registry +
synonym index + VQR store (Cosmos, PK `/tenantId`; MIG1 migrator registered
day-one). (2) Verified-query retrieval in the loop + the hard `refuse` path
(confidence < threshold AND no metric match). (3) semantic-model editor
**Verified Queries tab** (add/approve/version; approval writes an `_auditLog`
row per the master audit standard).
**Acceptance:** G1 — an in-contract question answers grounded on a verified
query (receipt shows the VQR hit); an out-of-contract question REFUSES with
the guided message (screenshot); approval audit row in the receipt.
**Per-cloud:** identical all clouds (pure metadata + TDS/KQL). IL5: the
refusal behavior is the compliance posture. **Serialization:**
`data-agent-reasoning.ts` (with N11/N12), semantic-model editor (WS-A).
**Cross-wire:** N15's metrics service compiles FROM this contract store — N9
owns the definition substrate; build N9 first. **Size: L.**

## N10 — Answer Receipts + verified badge (AIF-3 — near-free substrate, may ride early)

**What/why:** nobody surfaces the full audit inline. Every agentic answer
renders a **receipt**: plan steps, exact SQL/KQL/Cypher executed, row counts,
metrics + graph paths used, model tier, token cost, and a
**Verified ✓ / Unverified ⚠ / Refused ⛔** badge. For a CDO/auditor this is
the buy signal; for IL5 the receipt IS the compliance artifact.
**Loom has:** `turn-trace.ts`, `tool-citations.ts`, `phase-timer.ts`,
`cost-estimate.ts`, the verify verdict — assembly, not invention (the research
marks this near-free; the master spine lets it ride Phase 2/3).
**Build (3 PRs):** (1) `lib/copilot/answer-receipt.ts` assembler + type;
(2) collapsible `ReceiptPanel` in the Copilot dock (per-answer); (3) receipt
persistence to Cosmos for the governance audit trail (TTL'd; MIG1 migrator).
**Acceptance:** G1 — ask a data-agent question, expand the receipt, see the
REAL SQL + row count + tier + badge; persisted doc id in the receipt.
**Per-cloud:** identical everywhere. **Size: M.**

## N11 — GraphRAG retriever over Weave/AGE (AIF-1 — the headline)

**What/why:** GraphRAG = 3.4× multi-hop accuracy, 30-40% fewer factual errors
— on a substrate Loom ALREADY owns and competitors don't: an authored, typed,
governed property graph (Databricks' Genie Ontology is auto-extracted +
read-only). Wire the PLAN→EXECUTE→VERIFY loop to retrieve over the ontology:
seed-entity extraction → multi-hop Cypher traversal → subgraph + precomputed
community summaries → grounded context with **graph-path citations** (into
N10's receipts).
**Loom has:** `weave-ontology-store.ts`, `weave-explore.ts`, the AGE store,
pluggable `DataAgentTool` sources. **Known gotcha (memory):** AGE search
Cypher no-ops on some predicates — filter in JS post-fetch.
**Build (3 PRs):** (1) `lib/azure/ontology-graphrag.ts` (retrieval planner +
Cypher assembly + citations); (2) `graphrag-index.ts` offline
community-summary builder (Loom item build step, scheduled; uses the standard
AOAI deployment so it runs in Gov); (3) "Graph grounding" toggle in the
data-agent editor + receipt rows.
**Acceptance:** G1 — a multi-hop question (impossible for schema-only NL2SQL)
answers with graph-path citations over the seeded Enterprise Ontology; receipt
shows the traversal. **Per-cloud:** identical Commercial/GCC-High/IL5 — AGE is
in-VNet Postgres, zero external egress. **Air-gap-safe: the moat headline.**
**Serialization:** `data-agent-reasoning.ts` (N9/N12). **Size: L.**

## N12 — Self-healing / verified NL2SQL loop (AIF-4)

**What/why:** on query error or implausible result the loop **repairs**:
re-reads live schema, checks the metric contract (N9), rewrites, re-runs
(bounded retries), records every attempt in the receipt (N10); the verify pass
checks the answer follows from the real rows. Genie's "small validation steps"
made explicit + bounded + auditable.
**Build (2 PRs):** (1) repair sub-loop in `data-agent-reasoning` execute step
(max-N attempts, each grounded; EXPLAIN cost as a guardrail via `sql-tools`);
(2) plausibility check + receipt wiring.
**Acceptance:** G1 — inject a stale-schema failure; watch the loop repair and
answer, with all attempts in the receipt. **Per-cloud:** identical; reasoning
tier degrades to standard in Gov (`reasoningConfigured=false` honest-Fix-it
pattern). **Serialization:** `data-agent-reasoning.ts` (after N9; with N11).
**Size: M.**

## N13 — Unified LLMOps: prompt registry + eval-in-CI gate + per-workspace token budgets (AIF-5 — EXTENDS WS-E)

**What/why:** the 2026 LLMOps standard — eval gates that block a roll on
regression, semver'd prompts with scores + approvals, and token budgets
attributed per workspace/agent. **This item EXTENDS WS-E — it does NOT
duplicate it.** Decision rules: WS-E (E1–E6) owns the eval harness, the
copilot-evaluator Function, score-floor ratchets, and corpus-change gating;
N13 adds ONLY the three missing planes on top: (1) **prompt registry**
(`lib/copilot/prompt-registry.ts`, Cosmos-backed, semver + eval score +
approval; approvals audited), with E2's evaluator consuming registry versions
so a prompt bump triggers an eval run through the EXISTING E3/E4 gates —
no second CI gate; (2) **per-workspace/per-agent token budgets**
(`lib/copilot/token-budget.ts`) enforced in the `aoai-chat-client` hot path
with attribution; (3) budget + registry panels folded into E5's
`/admin/copilot-quality` page (no orphan admin tile).
**Acceptance:** G1 — bump a prompt version → eval run fires through E3's
regression check (receipt); exceed a workspace budget → honest 429-class
refusal with the Fix-it; attribution dashboard shows real per-workspace spend.
**Per-cloud:** identical; IL5 — eval + registry fully in-VNet (no external
LLMOps SaaS; this is why Loom builds native). **Serialization:** the E-chain
(E1→…→E6) must land first; `aoai-chat-client` hot path (tier-router — also
E6). **Size: L.**

## N14 — AI-first Tier-2 (condensed): embeddings/pgvector, NL governance, AI data engineering, A2A cards + memory, agent-designer publish

One item id, five PR-clusters:
- **N14a Embedding-pipeline item + hybrid vector default** (AIF-6): a
  first-class `embedding-pipeline` item (source→chunk→embed→index) + a hybrid
  retriever (`lib/copilot/hybrid-retriever.ts`) switched by
  `LOOM_VECTOR_BACKEND`: AI Search (Commercial default) | **pgvector/DiskANN
  on the in-VNet AGE Postgres (Gov/air-gap default)**. X2 availability rows
  differ per backend. Acceptance: same RAG question answers on both backends.
  **M**
- **N14b Natural-language governance** (AIF-7): governance Copilot answering
  policy questions ("who can read PII columns in the EU workspace?") from the
  policy graph (PDP + classification-59 + Weave lineage as an ontology
  overlay), reusing the N11 retriever scoped to the policy graph; answers cite
  exact policy edges. Unclaimed category; IL5 auditor differentiator.
  Acceptance: a revoke-impact question returns the real grant path. **M–L**
- **N14c AI-assisted data engineering with contract validation** (AIF-8):
  pipeline/dataflow/SQL copilots validate generated artifacts against N6
  contracts at build time (schema-drift + classification check BEFORE
  proposing), auto-doc + auto-classify outputs, violations surfaced pre-PR in
  the receipt. Acceptance: an intent that would break a contract is flagged
  with the exact violation. **M**
- **N14d A2A Agent Cards + Gov-safe agent memory** (AIF-9): an Agent Card
  generator (`lib/copilot/a2a-agent-card.ts`) served at a well-known endpoint
  for every data-agent/agent-flow/mesh agent; formalize the existing
  `memory-*-core.ts` into an `agent-memory` service (Cosmos-backed, recall in
  the loop, write-guard). Egress profiles gate A2A to gov/internal hosts,
  air-gap fail-closed (already in `agent-registry`) — per-cloud enforcement
  tests are part of acceptance. **M**
- **N14e Agent-designer publish surface** (AIF-10): level `aip-logic-editor`
  up with knowledge-source picker (N9 contract / N11 GraphRAG / N14a vector),
  guardrail + memory + eval panels, and publish-as-**A2A** + **M365
  declarative-agent manifest export** alongside the existing publish-as-MCP.
  M365 publish is Commercial/GCC only (honest-gated elsewhere); MCP/A2A all
  clouds, air-gap internal-only. **L**

**Pillar-2 Tier-3 riders (one-liners, fold into the above where cheap):**
notebook `%%ai` magics + cell error-fix reuse the N12 repair loop (rides
N19a's notebook work); proactive insights/anomaly narration is OWNED by N19d
(scheduled insights) — cross-reference, don't build twice; the model
availability matrix (AIF-15) is already covered by §X X-MATRIX + the existing
`model-availability-matrix.ts` — surface it in the E5 admin page, not a new
item. **Combined size: XL.**

---

# PILLAR 3 — GOVERNED ANALYTICS (from bi-dx-gov.md)

(The `/browse` virtualization defect from this research (T1.3) is OWNED by
**WS-U U10** — cross-reference, not duplicated here.)

## N15 — Headless metrics layer (MetricFlow-based, serving BI + NL2SQL + API)

**What/why (T1.1):** MetricFlow went Apache-2.0 (Oct 2025) and OSI (dbt +
Snowflake + Salesforce) standardized metric definitions — ONE governed metric
serving BI, NL2SQL, and REST kills "two dashboards, two revenue numbers" and
powers trustworthy agents. No competitor holds this cleanly on Azure.
**Loom has:** the semantic-model *editor* — a model editor, not a headless
queryable metrics *service*. **Cross-wire (binding):** the metric/dimension/
entity definitions live in **N9's semantic-contract store** — N15 adds the
MetricFlow-compatible spec import/export (OSI interop) and the **compiler +
`POST /api/metrics/query` endpoint** (SQL against `synapse-sql-client` default
/ `kusto-client` / lakehouse). One definition substrate, two consumers (agent
contract + metrics API); N9 lands first.
**Build (3 PRs):** (1) spec types + MetricFlow YAML import/export on the
contract store; (2) compiler + query route (gate-envelope, cached via
`getOrComputeCached`); (3) the report designer + Copilot NL2SQL + external
SDK all resolve metrics through the one endpoint.
**Acceptance:** G1 — the SAME metric returns the SAME number via a report
visual, an NL question, and a raw `POST /api/metrics/query` (three-way
receipt); an OSI YAML round-trips. **Per-cloud:** control-plane + Gov-GA
engines, identical; IL5 in-boundary. **Serialization:** semantic-model editor
(WS-A), N9. **Size: L.**

## N16 — BI-as-code `code-report` item type

**What/why (T1.2):** BI-as-code went mainstream 2026 (Evidence.dev, Rill,
Observable) — dashboards as versionable text: PR-reviewed, CI-tested,
diff-able. A category Loom is missing, and exactly what its git integration +
`.loomapp` export were built for.
**Build (4 PRs):** (1) `code-report` item type + parser (markdown +
```sql loom``` fenced blocks + `{visual}` directives → AST); registers in
`new-item-dialog` + nav registries (passes `nav-registries.test.ts`).
(2) Server renderer executing blocks against Synapse/ADX/lakehouse — metrics
references resolve through N15 (real backend, no vaporware). (3) CI hook:
`loom report validate <file>` in the CLI/SDK. (4) Parity doc
`docs/fiab/parity/code-report.md` vs Evidence.dev.
**Acceptance:** G1 — author a code-report against a Demo lakehouse, render
with real rows, change a query in a git branch, see the versioned diff, CI
validate passes/fails correctly. **Per-cloud:** identical; IL5 in-boundary.
**Serialization:** `new-item-dialog` (WS-U U12 touches it), nav registries.
**Size: L.**

## N17 — OpenLineage-backed observability incident console (EXTENDS WS-L + existing dq clients)

**What/why (T1.4 + T1.5):** Monte Carlo's value = monitors + incident timeline
+ downstream impact; OpenLineage is the vendor-neutral lineage standard. Loom
already has the BACKEND (`dq-monitor-client`, `dq-run-store`, `dq-item-run`,
`unified-lineage`, `lineage-gc`) — the missing piece is OL conformance + the
incident UX. **Decision rules vs WS-L (binding, no duplication):** WS-L **L2**
owns the OpenLineage Spark-listener INGEST (with its security redesign) and
the lineage store; N17 (a) generalizes OL emission to pipelines/notebooks/
code-report runs via a shared `lib/lineage/openlineage.ts` emitter writing to
the SAME L2 ingest path, (b) adds `GET /api/lineage/openlineage/export` (OL
1.x JSON) for DataHub/OpenMetadata/Marquez interop, and (c) builds the
**Monitors + Incidents surface**: per-table freshness/volume/schema-drift
monitors (default-ON with baselines), incident timeline
(open→acknowledged→resolved; state changes audited), downstream-impact panel
rendered from `unified-lineage`/OL facets. Incident alerts via O1 dispatch.
**Acceptance:** G1 — a stale seeded table opens a real incident; the impact
panel shows true downstream assets; acknowledge→resolve round-trip; OL export
validates against the OL 1.x schema and imports into Marquez.
**Per-cloud:** backend clients Gov-safe; anomaly detection server-side (no
external ML); IL5 — the collector + console fully in-boundary.
**Serialization:** WS-L (L2 first; `unified-lineage`), O1. **Size: L.**

## N18 — Embedded analytics SDK with RLS (Power BI Embedded parity, Fabric-free)

**What/why (T2.1):** PBI Embedded is the proven ISV pattern but now demands
Fabric F-SKUs — Loom undercuts with an Azure-native embed. **Embed tokens**
(short-lived, scoped, carrying an effective identity) + a `<loom-report>` web
component / `@csa-loom/embed` React wrapper (extends the shipped
`@csa-loom/sdk`); **RLS enforced at query time** via N15 metrics-service
filters keyed on the token identity (engine-level, not client-side hiding).
**Build (3 PRs):** token mint route (`POST /api/embed/token`, audited);
web component + wrapper; RLS-by-identity in the metrics query filters.
**Acceptance:** G1 — a standalone host page embeds a real Loom report; two
different token identities see different rows from the SAME report (RLS
receipt); token expiry enforced. **Per-cloud:** control-plane, no PBI host —
identical all clouds; Gov: this IS the Fabric-independent embed story.
**Size: M–L.**

## N19 — Governed-analytics Tier-2 (condensed)

One item id, seven PR-clusters:
- **N19a Reactive notebook mode** (T2.2, Marimo-style): cell dependency DAG
  (static parse), reactive re-run of dependents, `.py` round-trip
  serialization, "deploy as data app" → `loom apps`. Editor-layer only
  (execution backend unchanged). Folds in the AIF-11 `%%ai` magics one-liner.
  Serialize: notebook editor (WS-U U3, A14). **L**
- **N19b Python SDK + Go Terraform provider** (T2.3): `csa-loom` PyPI package
  (OpenAPI-generated core + auth ergonomics matching the TS SDK) +
  `terraform-provider-loom` (Go; `loom_workspace`/`loom_item` resources);
  contract-test both against `/api/openapi.json` in CI so drift fails the
  build. **M–L**
- **N19c Access-review / recertification campaigns** (T2.4): scope → reviewers
  → grant-by-grant attest (approve/revoke/delegate + justification) →
  auto-revoke on reject through RBAC → **signed evidence record** (audit
  standard; SOX/FedRAMP CA headline on Gov). Quarterly via existing cron
  infra. **M–L**
- **N19d Scheduled insights / anomaly narration** (T2.5): metric/monitor
  deltas on a cadence → Copilot-narrated "what changed" digest → delivered via
  the EXISTING report-subscriptions Function (WS-C C5 delivery path — extend,
  don't fork). Owns the AIF-12 proactive-insights scope. **M**
- **N19e Cost-per-query / cost-per-dashboard FOCUS attribution** (T2.6):
  tag every query/run (item+user+workspace), join Synapse/ADX metering,
  FOCUS-normalized cost mart, per-asset panels in the chargeback surface.
  **EXTENDS WS-C** — serialize on `cost-client.ts` per the master list. **M**
- **N19f Webhooks / Event Grid platform events** (T2.7): typed event taxonomy
  → Event Grid publisher (Azure-native default) + webhook registry
  (`/api/webhooks`, signed payloads, retry) + admin subscriptions UI. The
  substrate for the extension ecosystem. Gov: Event Grid GA; IL5:
  in-boundary topics only. **M**
- **N19g DataHub / OpenMetadata catalog interop** (T2.8): export Loom entities
  as OpenMetadata JSON + DataHub MCE, ingest to backfill; lineage rides N17's
  OL export. Adoption unlock into existing estates. **M**

## N20 — Governed-analytics Tier-3 labs (one-liners, Preview-badged)

Univer OSS spreadsheet `sheet` item over lakehouse tables (read + write-back
through the existing Delta path) · VS Code extension (scaffold/preview/auth on
the N19b SDK) · `loom dev` local loop/emulators · plugin/extension marketplace
(needs N19f webhooks + a versioned item-type contract FIRST — contract before
ecosystem) · privacy engineering (pragmatic first slice: **DSAR search** over
catalog + classification-59; then purpose-based access; then differential
privacy on shared datasets) · audit-grade evidence packs (falls out of N19c +
N17 structured events) · dashboards-as-code Terraform resources (once N16 +
N19b land) · virtualized pivot grid (extends WS-U U10's primitive).
Acceptance per shipped labs item: Preview badge + one real E2E receipt.
**Sizes: S–L each; schedule opportunistically.**

---

## Phasing, serialization, and exclusions (mirrored in the master)

**Phase:** all N-items land in **Phase 4 (post-Phase-3)** EXCEPT the
research-marked near-free riders — **N2a (duckdb-wasm preview)** and **N10
(answer-receipts substrate)** — which may ride Phase 2/3 slots when their
serialization windows are open. Within Phase 4 the spines are:
N9→N10→N11→N12→N13 (trust chain; N13 after the WS-E E-chain),
N1→{N2b server tier, N3, N7e}, N4→N5, N6→{N7b enforcement, N14c},
N9→N15→{N16 renderer, N18 RLS}, L2→N17→N19g, N19f→N20-marketplace.

**Serialization with existing workstreams (added to the master list):**
`data-agent-reasoning.ts` (N9/N11/N12 — serialize among themselves),
`aoai-chat-client.ts` hot path (N13 with E6/tier-router), semantic-model
editor + contract store (N9/N15 with WS-A A1–A5), `unified-lineage` +
OL ingest (N17 after WS-L L2), `cost-client.ts` (N19e with WS-C),
notebook editor (N19a with WS-U U3 + A14), `new-item-dialog`/nav registries
(N16 with WS-U U12), lakehouse editor (N1/N2 with WS-R decomposition
targets), report-subscriptions Function (N19d extends C5).

**Deliberately excluded from the source research (recorded):**
- **AIF-14 Web IQ-style live-web grounding** — cuts against the sovereign-moat
  design principle (external egress on an AI grounding path), is
  Commercial-only by construction, and MCP web servers already exist in the
  catalog for teams that want it. Not taken.
- **AIF-15 model availability matrix** — not a new item: covered by the
  master's §X X-MATRIX reference block + the existing
  `model-availability-matrix.ts`; surfaced via E5's admin page instead.
- **AIF-12 / AIF-13 as standalone items** — proactive insights folded into
  N19d (single owner); agentic data prep deferred until N6 contracts + N14c
  land (it is their composition, not a new substrate).
- **bi-dx T1.3 VirtualizedGrid** — owned by WS-U U10 (defect-priority), not
  duplicated here.
