# PRP — Loom Hyperscale custom components (OneLake / Direct Lake / Capacity Broker, Azure-native)

> **Title:** Loom Hyperscale — three custom-built Loom-native services that close the last
> *structural* Fabric gaps (unified namespace, in-memory columnar semantic engine, unified
> compute-capacity broker) with Azure-native + OSS substrate, no real Fabric dependency.
> **Date:** 2026-07-09
> **Status:** proposed
> **Owner:** Loom Hyperscale / Platform-Substrate Architect
> **Sources consulted:** Microsoft Learn (OneLake overview + access-API parity + shortcuts +
> medallion-lakehouse + OneLake-security; Direct Lake overview + how-it-works framing/transcoding +
> understand-storage residency ladder + capacity requirements; Fabric capacity CU / bursting /
> smoothing / throttling, `data-warehouse/compute-capacity-smoothing-throttling`,
> `enterprise/throttling`, `data-engineering/spark-job-concurrency-and-queueing`,
> `enterprise/capacity-planning-scale-self-service-analytics`) — full citations inline per component;
> direct code review of `apps/fiab-console/lib/azure/**` with file evidence (`adls-client.ts`,
> `lakehouse-shortcuts.ts`, `shortcut-engines.ts`, `onelake-security-client.ts`,
> `onelake-catalog-client.ts`, `aas-client.ts`, `tabular-eval-client.ts`, `synapse-sql-client.ts`,
> `synapse-livy-client.ts`, `kusto-client.ts`, `cost-attribution.ts`, `capacity-guardrails.ts`,
> `query-cache.ts`, `query-result-cache.ts`, `spark-session-pool.ts`,
> `lib/components/admin/surge-protection-panel.tsx`); the deployable-service template
> `platform/runners/script-runner/**` + `platform/fiab/bicep/modules/admin-plane/script-runner-app.bicep`
> and `apps/copilot-maf/**`; and the existing fabric-parity appendices
> `PRPs/completed/fabric-parity/appendix-onelake.md` / `appendix-power-bi.md` / `appendix-platform-alm.md`.
> **Hard prerequisite:** `PRPs/active/next-waves/PRP-performance-scale-parity.md` — **PSR-1**
> (benchmark harness + `/admin/performance` + persisted trend) and **PSR-2** (CI perf gate) must
> land **before** Wave H1. For this epic the die-hard `no-vaporware.md` receipt IS a PSR-1
> benchmark number, not a screenshot.
> **Governing rules (die-hard, non-negotiable):** `.claude/rules/no-fabric-dependency.md`
> (Azure-native is the DEFAULT; Fabric/Power BI opt-in only, never a gate — none of these three
> services ever call `api.fabric.microsoft.com` / `onelake.dfs.fabric.microsoft.com` /
> `api.powerbi.com`), `.claude/rules/no-vaporware.md` (real backend + measured receipt per merge),
> `.claude/rules/ui-parity.md`, `loom_no_freeform_config`, `loom_design_standards`,
> `.claude/rules/ux-baseline.md`. Dual-cloud (Commercial + Government GCC/GCC-High/DoD IL4-5)
> mandatory. Default-ON / opt-out per the WAVES.md global principle (§ "default-ON / opt-out").

---

## 1. Executive summary

Loom is already Fabric-class on **features** — every item, editor, and object runs 100% Azure-native
with no Fabric capacity, no OneLake, no Power BI workspace. The remaining daylight between Loom and
Fabric is not a feature list; it is **three structural mechanisms Fabric owns as first-party
substrate and Loom currently reproduces as per-item glue**:

1. **A single namespace.** In Fabric every engine reads/writes one logical filesystem (OneLake) so a
   lakehouse, a shortcut to S3, and a warehouse table all resolve through one path space with one
   security model. Loom reproduces this *near-completely* today — but as a set of libraries
   (`adls-client.ts`, `lakehouse-shortcuts.ts`, `shortcut-engines.ts`, `onelake-security-client.ts`)
   invoked per item, not as an owned service every engine funnels through. We turn that library layer
   into **Loom OneLake**, a real namespace/catalog/shortcut/security service exposing one
   `loom://<workspace>/<item>.<type>/<path>` address space.

2. **Import-class query speed without an ETL copy.** Fabric's Direct Lake feeds the in-memory VertiPaq
   columnar engine straight from Delta Parquet via *framing* (metadata-only version pin) and
   *transcoding* (on-demand per-column load), yielding sub-second interactive DAX over lake data.
   Loom cannot license VertiPaq, and Azure Analysis Services (the only place that engine ships) is
   scarce/absent in Gov high-side and on Microsoft's own retirement track. We build the
   **outcome-equivalent**: **Loom Direct Lake**, a custom columnar cache/scan service on
   Arrow + `delta-rs` + DuckDB/DataFusion that gives framing and transcoding as *literal, buildable*
   operations and serves the semantic-model / report layer with import-class latency and a
   DirectQuery-class cold fallback.

3. **One compute currency that meters, smooths, bursts, and throttles.** Fabric's Capacity Unit (CU)
   spans every workload; bursting lets a job temporarily exceed the SKU rate, smoothing amortizes the
   *billing* of that burst across up to 2,880 30-second timepoints, and a four-stage throttle is the
   backstop. No Azure PaaS exposes a single currency across Synapse/Databricks/ADX/AML. Loom already
   has the *seed* — `cost-attribution.ts`'s published LCU coefficient table + append-only Cosmos
   ledger, and a first-generation static hourly cap (`capacity-guardrails.ts` /
   `surge-protection-panel.tsx`, FGC-25). We build the missing stateful piece: **Loom Capacity
   Broker**, an admission-control service with a Redis timepoint ledger implementing the exact
   smoothing math and a synchronous `/admit` choke-point every job-submission path calls.

Each is a **standalone deployable** modeled on the proven `platform/runners/script-runner` template
(internal-ingress ACA, dedicated least-privilege UAMI, `az acr build` server-side image, honest-503
BFF gate naming the missing env var + bicep module, bicep-synced env into `admin-plane/main.bicep`
`apps[]`). Two supporting services round out the band: a **Warm-Pool Keepalive** service (Spark/AML
pre-warming — promotes `spark-session-pool.ts` to a shared cross-replica lease store, the PSR-3
default-ON flip) and a **Shared Result-Cache** service (Redis-backed, the cross-replica upgrade
`query-cache.ts` explicitly asks for, feeding Loom Direct Lake's cold path and PSR-5/PSR-6).

**Honest framing (the whole epic is graded against this):** we chase **outcome equivalence measured by
the PSR-1 harness**, not mechanism parity. We will not reimplement VertiPaq, will not reproduce
Fabric's cross-tenant hyperscale multi-tenancy, and will not match a paid F-SKU's per-capacity
guardrails to the decimal. Every component below carries an explicit **HONEST LIMITS** section stating
where the Azure-native outcome-equivalent will not match the proprietary mechanism and why that is
acceptable for Loom's customer-owned-Azure, Gov-capable model.

---

## 2. Where each component sits (grounded current state)

| Component | Fabric mechanism | Loom substrate today | Gap this epic closes |
|---|---|---|---|
| **Loom OneLake** | OneLake = one ADLS Gen2 (HNS) + namespace/shortcut/roles layer | `strong` — `appendix-onelake.md` grades 46/46 capabilities built on `adls-client.ts` + `lakehouse-shortcuts.ts`/`shortcut-engines.ts` + `onelake-security-client.ts` + `onelake-catalog-client.ts`, but invoked **per item** | Promote the library layer to an **owned namespace service** + a single `loom://` address every engine resolves; close the 7 residual UI/BFF gaps. **No new compute engine required.** |
| **Loom Direct Lake** | VertiPaq fed by framing + transcoding from Delta/OneLake | **absent** — `grep DuckDB\|delta-rs\|Apache Arrow` = 0 hits; `aas-client.ts` L885 states "True Direct Lake sub-second freshness requires a Fabric F-SKU (unavailable in Gov)"; `query-result-cache.ts` = "the pragmatic 80% of Direct Lake without a capacity" | A **new** Rust/.NET columnar cache/scan service on Arrow + `delta-rs` + DuckDB/DataFusion behind `LOOM_SEMANTIC_BACKEND=loom-columnar-cache`, sitting alongside AAS-fast-path and Synapse-Serverless-cold-path |
| **Loom Capacity Broker** | CU: bursting ⊕ smoothing (2,880 timepoints) ⊕ 4-stage throttle | **seed only** — `cost-attribution.ts` LCU table + append-only Cosmos ledger; `capacity-guardrails.ts` + `surge-protection-panel.tsx` = static hourly cap (FGC-25) | A **new** stateful admission-control service with a Redis timepoint ledger implementing smoothing math + a synchronous `/admit` choke-point; feeds the `appendix-platform-alm.md` GAP-2 Capacity-Metrics UI |

**Supporting (reference PSR items, do not duplicate):**

| Supporting service | Loom substrate today | Owning perf item |
|---|---|---|
| **Warm-Pool Keepalive** (Spark/AML pre-warm) | `spark-session-pool.ts` — exists, **DEFAULT OFF**, per-ACA-replica, no shared lease store | **PSR-3** (this epic operationalizes it as a shared service) |
| **Shared Result-Cache** | `query-cache.ts` in-proc LRU+TTL (comment: "back this with Redis later"); `query-result-cache.ts` Cosmos tier | **PSR-5 / PSR-6** (this epic gives Loom Direct Lake its cold-path store) |

---

## 3. Architecture — the three services on shared substrate

```
                          ┌─────────────────────────────────────────────────────────┐
                          │                 apps/fiab-console (Next.js BFF)          │
                          │  editors · admin pages · /api/** honest-503 gates        │
                          └───────┬───────────────┬───────────────┬─────────────────┘
                                  │ loom lib      │ loom lib      │ loom lib
                                  │ clients       │ clients       │ clients
              ┌───────────────────▼───┐  ┌────────▼──────────┐  ┌─▼──────────────────────┐
              │  Loom OneLake (H1)     │  │ Loom Direct Lake  │  │ Loom Capacity Broker    │
              │  ACA · Go/.NET         │  │ (H2) ACA/AKS·Rust │  │ (H3) ACA · Rust/Go      │
              │  namespace+shortcut+   │  │ Arrow+delta-rs+   │  │ /admit choke-point +    │
              │  security+catalog svc  │  │ DuckDB/DataFusion │  │ Redis timepoint ledger  │
              └───┬────────┬───────────┘  └───┬──────┬────────┘  └───┬─────────┬──────────┘
                  │        │                  │      │                │         │
   resolve loom://│        │ POSIX ACL        │ read │ warm segments  │ meter   │ throttle events
                  ▼        ▼                  ▼      ▼                ▼         ▼
          ┌───────────────────────┐   ┌──────────────────┐   ┌──────────────┐  ┌────────────┐
          │ ADLS Gen2 (HNS)       │   │ Azure Cache for  │   │ Cosmos       │  │ Event Grid │
          │ = the substrate       │◄──┤ Redis (Premium)  │◄──┤ cost-attrib  │  │ custom     │
          │ Files/ + Tables/Delta │   │ segment residency│   │ + broker log │  │ topic      │
          └───────────────────────┘   │ + timepoint led. │   └──────────────┘  └─────┬──────┘
                  ▲   ▲   ▲            └──────────────────┘                          │
      Synapse ────┘   │   └──── Databricks / ADX / AAS                    Activator (Azure
      Serverless      AML  (all read/write THROUGH loom://)               Monitor) rules ◄┘
```

**Shared infra (amortized across the band):** one Azure Cache for Redis Premium (zone-redundant)
instance backs both Loom Direct Lake's segment-residency index *and* Loom Capacity Broker's timepoint
ledger *and* the Shared Result-Cache; one Cosmos account (existing) holds the namespace/shortcut/role
registry and the broker's durable ledger flush; one Event Grid custom topic emits broker
throttle-state-change events into the existing Activator (Azure Monitor) editor.

---

## 4. Work items

| # | Item | Component | State | Priority | Effort |
|---|------|-----------|-------|----------|--------|
| HYP-1  | Loom OneLake namespace/catalog service skeleton (`loom://` resolver, Cosmos registry, ADLS driver) on ACA | OneLake | NEW | **P0** | XL |
| HYP-2  | Shortcut engine as a service (internal passthrough + external ADLS/S3/GCS/S3-compat/Dataverse) compiled to Synapse external-table / Databricks UC external-location / ADX `external_table()` | OneLake | PARTIAL→service | **P0** | L |
| HYP-3  | OneLake-security enforcement service (recursive ADLS POSIX ACL reconcile, cross-workspace roles) | OneLake | PARTIAL→service | P1 | M |
| HYP-4  | OneLake residual UI/BFF gaps (short-lived SAS UI, access-diagnostics explorer, shortcut caching, shortcut transforms, OPDG gateway shortcuts, unified hub, shortcut event-triggers) | OneLake | PARTIAL | P1 | L |
| HYP-5  | Loom Direct Lake columnar service skeleton (Rust ACA, `delta-rs` framing + Arrow transcoding + DuckDB/DataFusion scan) — core path executes | Direct Lake | NEW | **P0** | XL |
| HYP-6  | Segment-residency cache + Redis cross-replica coherence (cold/semiwarm/warm ladder; incremental framing on Delta-log diff) | Direct Lake | NEW | **P0** | L |
| HYP-7  | DAX-lite → Arrow/SQL compiler front-end + `LOOM_SEMANTIC_BACKEND=loom-columnar-cache` selector wired at `aas-client`/`tabular-eval-client` | Direct Lake | NEW | P1 | L |
| HYP-8  | DirectQuery-class cold fallback (Synapse Serverless warm-shim) + guardrail-triggered fallback semantics | Direct Lake | PARTIAL | P1 | M |
| HYP-9  | Loom Capacity Broker service skeleton (Rust/Go ACA, synchronous `POST /admit`, Redis timepoint ledger) | Capacity Broker | NEW | **P0** | XL |
| HYP-10 | Smoothing/bursting math (interactive 5-64min / background 24h spread) + 4-stage throttle + self-heal; extends FGC-25 cap | Capacity Broker | NEW | **P0** | L |
| HYP-11 | Choke-point wiring — Spark/Databricks/ADX/AML/Loom-Direct-Lake job-submit paths all call `/admit` | Capacity Broker | NEW | P1 | L |
| HYP-12 | Capacity-Metrics admin page (Health/Compute/Storage/Timepoint tabs) reading the live broker ledger — closes `appendix-platform-alm.md` GAP 2 | Capacity Broker | PARTIAL | P1 | M |
| HYP-13 | Broker throttle events → Event Grid custom topic → Activator (Azure Monitor) rule | Capacity Broker | NEW | P2 | S |
| HYP-14 | Warm-Pool Keepalive service — promote `spark-session-pool.ts` to shared cross-replica lease store, **DEFAULT ON** (reference PSR-3) | Supporting | REF/PARTIAL | P1 | L |
| HYP-15 | Shared Result-Cache service — Redis-backed cross-replica cache (the `query-cache.ts` "back with Redis later" upgrade; reference PSR-5/PSR-6) | Supporting | REF/PARTIAL | P1 | M |
| HYP-16 | Cross-cutting platform: per-service bicep under `modules/compute/`, dedicated least-privilege UAMIs, honest-503 gates, Azure Monitor diag-settings, env into `admin-plane/main.bicep` | All | NEW | P1 | M |

**Sequencing.** HYP-1/5/9 are the three P0 skeletons (one per service, each executes its core path at
skeleton stage per no-vaporware). HYP-2/3 ride HYP-1; HYP-6/7 ride HYP-5; HYP-10/11 ride HYP-9.
HYP-14/15 (supporting) can land in parallel and are *referenced* from the PSR PRP — do not re-plan
their perf acceptance here. HYP-16 is the shared platform chore every service depends on and lands
with HYP-1.

---

## 5. Component 1 — Loom OneLake (unified namespace service)

### 5.1 What it is

A namespace-virtualization + shortcut-resolution + security + discovery service that gives every Loom
engine one logical filesystem over ADLS Gen2. It owns the exact layer Fabric adds on top of raw ADLS —
because OneLake *internally is* a single ADLS Gen2 (HNS) account with a
`tenant→account, workspace→container, item→managed folder` hierarchy, Delta-default `Tables/`, a
`Files/` free-form root, metadata-virtualized Iceberg interop, and shortcut symbolic-links
(learn.microsoft.com/fabric/onelake/onelake-overview; `.../fundamentals/microsoft-fabric-overview`;
`.../onelake/onelake-shortcuts`; `.../onelake/onelake-access-api`). Loom does not need to reinvent a
filesystem — it needs to own that top layer as a service.

### 5.2 Architecture

- **Address space.** `loom://<workspace>/<item>.<type>/<path>` — a stable logical path that the service
  resolves to a physical `abfss://<container>@<dlz-account>.dfs.core.windows.net/<item-folder>/<path>`
  (or a shortcut target). Mirrors OneLake's `https://onelake.dfs.fabric.microsoft.com/<ws>/<item>.<type>/<path>`
  shape, but on the customer's own DLZ storage account.
- **Registry.** Cosmos (existing `cosmos-client.ts`) holds `{workspace→container, item→managed folder,
  shortcut→{path,target,type,credentialRef}, role→ACL}` — already the shape `lakehouse.ts` /
  `shortcut-engines.ts` / `onelake-security-client.ts` persist; this service becomes their single owner.
- **Resolver.** A Go/.NET ACA service resolves `loom://` → physical path (+ passthrough vs stored-
  connection auth for shortcuts) and hands back an engine-appropriate pointer.
- **Substrate.** ADLS Gen2 (HNS) unchanged. The service never copies data; shortcuts and Delta⇄Iceberg
  interop are metadata-only, matching OneLake's one-copy design.

### 5.3 Azure infra + bicep

- `platform/fiab/bicep/modules/compute/loom-onelake-app.bicep` — internal-ingress ACA app,
  `minReplicas: 1` (namespace resolution is on the hot path; not scale-to-zero), dedicated UAMI with
  **Storage Blob Data Contributor** on the DLZ lake + **Cosmos data-plane** on the registry containers,
  nothing else. `az acr build` server-side image.
- Env into `admin-plane/main.bicep` `apps[]`: `LOOM_ONELAKE_URL`. Absent ⇒ honest-503 gate; the console
  falls back to the current per-item library path silently (no regression, no Fabric gate).
- No new managed service — ADLS Gen2 + Cosmos only. **Gov:** full parity today (ADLS Gen2 + Cosmos GA in
  GCC/GCC-High/DoD IL4-5).

### 5.4 Service impl

- **Language/runtime:** Go (fast startup, tiny image, strong ADLS SDK) or .NET (team-velocity option) on
  `node:22`-analog distroless multi-stage, non-root, internal ingress. Same shape as
  `platform/runners/script-runner`.
- **Libs:** Azure Storage Files DataLake SDK (DFS REST), Cosmos SDK, the shortcut-compilation logic
  ported from `shortcut-engines.ts` (Synapse Serverless `CREATE EXTERNAL TABLE`/`EXTERNAL DATA SOURCE`,
  Databricks UC external location, ADX `.create external table`).
- **Core endpoints:** `POST /resolve` (`loom://` → physical + auth), `GET/POST/DELETE /shortcuts`,
  `POST /security/reconcile` (recursive ACL), `GET /catalog` (Explore/Govern/Secure discovery).

### 5.5 Loom lib client + BFF + surface

- **Client:** `lib/azure/loom-onelake-client.ts` — thin wrapper the existing lakehouse/shortcut/security
  editors call instead of the per-item libs (which become the in-process fallback when the service is
  absent).
- **BFF:** existing `app/api/items/lakehouse/[id]/shortcuts`, `.../security`, `.../catalog` routes
  re-pointed at the client; honest-503 when `LOOM_ONELAKE_URL` unset.
- **Surface:** the shipped `onelake-catalog-client.ts` Explore/Govern/Secure tabs + `onelake-security-tab.tsx`
  become the service's UI; HYP-4 adds the 7 residual surfaces (short-lived SAS mint UI, access-diagnostics
  explorer, shortcut result-caching toggle, shortcut column-mapping transforms, on-prem-gateway shortcuts,
  a unified OneLake hub, and shortcut change event-triggers).

### 5.6 Item-model integration

Makes lakehouse / warehouse / kql-database "managed-folder-in-a-container" placement and shortcut/role
features **substrate-backed** rather than per-item glue: every item's provisioner registers its managed
folder with the namespace service; every engine (Synapse/Databricks/ADX/AAS) reads/writes via a resolved
`loom://` pointer.

### 5.7 Benchmark targets (PSR-1 metrics)

- `loom://` resolve p95 **≤ 25 ms** (Cosmos point-read + memoized container map).
- External shortcut first-list p95 **≤ 1.5 s** (S3/ADLS) with the HYP-4 shortcut cache warm.
- Cross-workspace role apply over 3 items / 2 workspaces in **one** Cosmos transactional batch.

### 5.8 Gov story

Fully Gov-capable today — ADLS Gen2 + Cosmos are GA GCC-High/IL5. No alternate path needed. External
shortcut targets (S3/GCS) document egress for Gov review; the internal-passthrough path is fully in-tenant.

### 5.9 Phased delivery

- **H1a (HYP-1/2/16):** namespace resolver + shortcut engine as a service + platform chore. Core path
  executes: create a lakehouse, resolve its `loom://` path, add an external ADLS shortcut, read it via
  Synapse Serverless — **Fabric unset**, real rows in the receipt.
- **H1b (HYP-3/4):** security-reconcile service + the 7 residual UI/BFF gaps.

### 5.10 HONEST LIMITS

- **Not a novel filesystem.** Loom OneLake is a *namespace + policy* layer over ADLS; it does not add a
  new storage protocol. This is a feature, not a shortfall — it means every Azure engine already speaks
  the substrate natively (no "authorized-engine registration" protocol Fabric needs for 3rd-party
  engines), but it also means Loom does **not** offer OneLake's single global `onelake.dfs...` DNS name
  across tenants — each customer's namespace is scoped to their own DLZ account.
- **SaaS identity model not reproduced.** Fabric governs item visibility via workspace *roles* (SaaS
  identity, no Subscription ID). Loom's control-plane authz stays Entra/RBAC + workspace membership; the
  data-plane authz is real ADLS POSIX ACLs. Equivalent outcome, different identity substrate — acceptable
  because Loom is customer-owned-Azure by design, not SaaS.
- **Delta⇄Iceberg virtualization is read-path/UniForm-bounded.** Delta→Iceberg uses Databricks UniForm
  (`enableIcebergCompatV2`, already wired) where available; the Gov/AKS-Spark path uses an OSS reader
  shim (`pyiceberg` / a Spark job emitting a compatible log). It does not match OneLake's automatic
  bidirectional manifest generation for every table on write — Loom generates on demand / on schedule.
- **Cross-tenant live sharing** is Delta Sharing (shipped, PR #1578) + shortcut-back, not OneLake's
  in-place cross-Entra-tenant shortcut. Outcome (recipient reads governed data without a copy) matches;
  the wire mechanism differs.

---

## 6. Component 2 — Loom Direct Lake (columnar cache/scan engine)

### 6.1 What it is

A custom in-memory columnar cache/scan service that transcodes Delta Parquet into an Arrow-backed
columnar store, *framed* (pinned to a Delta-log version, metadata-only refresh) and *transcoded*
on demand (per-column, per-row-group load), serving the semantic-model / tabular + report layer with
import-class latency and a DirectQuery-class cold fallback. It is the **outcome-equivalent of Direct
Lake**, which is a table storage mode that feeds VertiPaq directly from OneLake Parquet via framing +
transcoding rather than an ETL Import copy (learn.microsoft.com/fabric/fundamentals/direct-lake-overview;
`.../direct-lake-how-it-works`; `.../direct-lake-understand-storage`).

Loom cannot license VertiPaq; AAS embeds the same engine but is scarce/absent in Gov high-side and on a
retirement track (`appendix-power-bi.md` G1). So the durable default becomes an OSS columnar engine that
reproduces the *operations* — framing and transcoding — as literal code, not a VertiPaq reimplementation.

### 6.2 Architecture — framing and transcoding as buildable operations

- **Engine:** DuckDB (embedded OLAP, native Delta + Parquet + Arrow readers) or Apache DataFusion
  (Rust query engine) for scan/execution; **`delta-rs`** (Rust `deltalake` crate) to read the Delta
  transaction log off ADLS the same way Direct Lake reads it off OneLake.
- **Framing (metadata-only refresh):** on each framing pass, `delta-rs` reads the Delta log, pins the
  baseline Parquet version, and updates references — no data rewrite (mirrors
  `direct-lake-how-it-works#framing`). **Incremental framing:** diff the log, evict/reload only the
  column segments whose Parquet files changed; extend dictionaries in place.
- **Transcoding (on-demand columnar load):** on a cold column touch, load its Parquet column-chunks into
  an Arrow `RecordBatch` cache (≈ VertiPaq column segments), building join indexes for cross-table DAX.
  V-Order pre-optimized files (already emitted by `delta-maintenance.ts` OPTIMIZE/V-Order) transcode fast.
- **Residency ladder:** cold → semiwarm → warm, exactly Direct Lake's model; the whole design goal is to
  keep tables semiwarm/warm via incremental framing + Delta OPTIMIZE.
- **Cross-replica coherence:** Azure Cache for Redis Premium as the shared segment-residency index
  (key `{tableId, deltaVersion, columnId, rowGroupId}` → Arrow IPC bytes / mmap pointer) — the exact
  gap `query-cache.ts` names ("back this with Redis later").

### 6.3 Azure infra + bicep

- `platform/fiab/bicep/modules/compute/loom-directlake-app.bicep` — internal-ingress ACA app
  (or AKS memory-optimized node pool if a single ACA replica's memory ceiling is too small for hot
  working sets), **`minReplicas` tuned per-tenant, NOT scale-to-zero** (warm-cache retention is the
  entire point — unlike script-runner). Dedicated UAMI with **Storage Blob Data Reader** on the DLZ lake
  only. Azure Cache for Redis Premium (shared with HYP-9/HYP-15).
- Env: `LOOM_SEMANTIC_BACKEND` (extend the `appendix-power-bi.md` G1 selector with a third value
  `loom-columnar-cache` alongside `analysis-services` and `synapse-serverless`), `LOOM_DIRECTLAKE_URL`,
  `LOOM_DIRECTLAKE_REDIS`. Absent ⇒ honest-503; console falls back to AAS-fast-path or Synapse-Serverless.

### 6.4 Service impl

- **Language/runtime:** **Rust** (primary — Arrow/`delta-rs`/DataFusion are first-class Rust, predictable
  memory, no GC pauses on a hot columnar store) on a distroless multi-stage image, internal ingress.
  **.NET fallback** if team velocity favors it (Arrow has a mature .NET binding; DuckDB via `DuckDB.NET`).
- **Libs:** `arrow-rs`, `deltalake` (delta-rs), `datafusion` and/or `duckdb-rs`, `redis-rs`.
- **Endpoints:** `POST /frame` (pin/refresh a table to a Delta version — metadata only),
  `POST /query` (measure + filter context → Arrow/SQL plan → result), `GET /residency` (ladder state for
  the admin surface), `POST /evict`.

### 6.5 Loom lib client + BFF + surface

- **Integration point:** `aas-client.ts` / `tabular-eval-client.ts` gain a backend branch — when
  `LOOM_SEMANTIC_BACKEND=loom-columnar-cache` and the service resolves, DAX-class queries route to
  `lib/azure/loom-directlake-client.ts` (HYP-7's DAX-lite → Arrow/SQL compiler) instead of XMLA/Serverless.
- **BFF:** the semantic-model + report-designer query routes call the client transparently; the report
  renderer and DAX query view (FGC-21) get import-class latency with no editor change.
- **Surface:** a "Storage mode" indicator on the semantic-model editor (Direct-Lake-equivalent / Import /
  DirectQuery-cold), and a residency/framing panel on `/admin/performance` (shares the PSR-1 page).

### 6.6 Item-model integration

The semantic-model item gains a `storageMode: 'loom-direct-lake' | 'import' | 'directquery'` field; a
Direct-Lake-mode model frames against its source lakehouse/warehouse Delta tables and serves report
visuals + DAX from the columnar service. No new item type.

### 6.7 Benchmark targets (PSR-1 — the receipt)

- **Warm-frame aggregate p95 ≤ 1 s** (sub-second on a warm frame — the headline acceptance) for a
  star-schema SUM/GROUP BY over a ~100M-row fact, vs the Synapse-Serverless cold-path baseline.
- **Framing p95 ≤ 5 s** regardless of table size (metadata-only, matching Direct Lake's seconds-not-minutes
  refresh claim).
- **Cold→warm transcode** of a single column segment measured and trended; **semiwarm reframe** after a
  small Delta append reloads only changed row-groups.
- Every number is a PSR-1 harness metric persisted to `perf-benchmarks` and PSR-2 CI-gated for regression.

### 6.8 Gov story

**Fully Gov-capable** — Rust/Arrow/DuckDB/DataFusion/`delta-rs` are OSS with zero Azure-region licensing
dependency; ACA + Azure Cache for Redis are GCC-High/IL5 GA. This component is *specifically why the epic
exists for Gov*: it replaces the Gov-scarce, retirement-track AAS/VertiPaq path with an owned OSS engine.
No alternate Gov path required (it **is** the Gov path).

### 6.9 Phased delivery

- **H2a (HYP-5/6):** columnar skeleton — `delta-rs` framing + Arrow transcoding + DuckDB scan + Redis
  residency index. Core path executes: frame one Delta table, run one aggregate, prove sub-second on a
  warm frame in the PSR-1 harness (**Fabric unset**).
- **H2b (HYP-7/8):** DAX-lite compiler + `LOOM_SEMANTIC_BACKEND` selector + Synapse-Serverless cold/
  DirectQuery-class fallback with guardrail-triggered fallback semantics.

### 6.10 HONEST LIMITS

- **Not VertiPaq.** We do not reproduce VertiPaq's exact RLE/bit-packed segment encoding, its dictionary
  compression ratios, or its query optimizer. On very wide, very high-cardinality models a VertiPaq Import
  model on a large F-SKU may still beat the Arrow/DuckDB store on some queries. We claim **sub-second on a
  warm frame for typical star-schema aggregates**, benchmark-proven — not universal parity with a paid
  capacity's peak.
- **No SKU-tied Direct Lake guardrails.** Fabric falls back to DirectQuery on documented guardrails
  (>10,000 Parquet files, table exceeds the SKU's Direct Lake memory guardrail). Loom's fallback triggers
  are *our* memory/residency limits, not an F-SKU ceiling — different thresholds, same fallback outcome
  (route to the Synapse-Serverless cold path).
- **Warm-cache cost is real.** Unlike scale-to-zero services, keeping frames warm costs money at rest.
  This is bounded by per-tenant `minReplicas` tuning + idle eviction, and is the honest trade for
  import-class latency — surfaced in the Capacity Broker's LCU accounting, not hidden.
- **First-touch is cold.** A never-queried column pays transcode latency on first hit (exactly Direct
  Lake's cold-column behavior). We warm proactively via framing + optional pre-touch, but the cold-start
  tail exists and is benchmarked honestly, not papered over.

---

## 7. Component 3 — Loom Capacity Broker (unified compute scheduler)

### 7.1 What it is

A stateful admission-control service exposing a CU-like abstraction — the **LCU** (Loom Capacity Unit) —
that **meters, smooths, bursts, and throttles** across Synapse pools, Databricks, ADX, AML, and the two
Loom services above. It reproduces the *outcome* of Fabric capacity: bursting lets a job temporarily
exceed a steady-state rate; smoothing amortizes the *billing* of that burst across up to 2,880 30-second
timepoints (interactive 5-64 min, background 24 h); a four-stage throttle is the backstop and capacities
self-heal as the debt elapses (learn.microsoft.com/fabric/enterprise/throttling;
`.../data-warehouse/compute-capacity-smoothing-throttling`;
`.../data-engineering/spark-job-concurrency-and-queueing`).

No Azure PaaS exposes one currency across these engines — each meters its own DWU/vCore/SU independently —
so this is the one component Loom must build **outright as a control-plane service**, not a wrapper.

### 7.2 Architecture

- **Seed reused:** `cost-attribution.ts`'s `ATTRIBUTION_RATES` LCU coefficient table (Spark session ≈ 30
  LCU, Databricks run ≈ 25, ADX query ≈ 0.5, AOAI 50K tok ≈ 1, pipeline run ≈ 10) becomes the broker's
  per-engine cost-normalization input; the append-only Cosmos `cost-attribution` container (PK
  `/tenantId`, 90-day TTL) remains the durable audit trail.
- **Timepoint ledger:** a sliding **2,880 × 30-second bucket (24 h)** LCU ledger per tenant/workspace in
  Redis (sorted-set / time-bucketed counters). Each admitted job's LCU cost is spread across N future
  timepoints per its interactive-vs-background class — the exact Fabric smoothing/debt-amortization math.
- **Admission control:** a synchronous `POST /admit {tenantId, workspaceId, engine, estimatedLcu,
  class}` → `{decision: 'allow'|'delay'|'reject', delayMs?, reason?}` — the choke-point every
  job-submission path calls before dispatch, returning allow / 20s-delay / reject like Fabric's four
  throttle stages, with 10-minute overage protection and self-heal.
- **Bursting parity:** the broker does not *provide* burst compute (Synapse/Databricks/ADX/AML autoscale
  already do) — it *gates and accounts for* it so one burst doesn't starve another workspace on the same
  underlying pool. This upgrades `capacity-guardrails.ts` / `surge-protection-panel.tsx`'s static hourly
  cap (FGC-25) to true multi-window smoothed-debt accounting.

### 7.3 Azure infra + bicep

- `platform/fiab/bicep/modules/compute/loom-capacity-broker-app.bicep` — internal-ingress ACA,
  **`minReplicas: 2`** for HA (admission control can't scale-to-zero), dedicated UAMI with **zero
  data-plane roles** (it talks to Redis + Cosmos only — it gates the caller, never proxies the call;
  the least-privilege threat-model the script-runner README warns about). Azure Cache for Redis Premium
  (shared with HYP-5/HYP-6). Event Grid custom topic (HYP-13).
- Env: `LOOM_CAPACITY_BROKER_URL`, `LOOM_CAPACITY_BROKER_REDIS`, `LOOM_CAPACITY_BROKER_EVENTGRID`.
  Absent ⇒ honest-503 gate; job submission proceeds **unthrottled** with a MessageBar (default-ON posture:
  the broker constrains, it never blocks the platform from running if it isn't deployed).

### 7.4 Service impl

- **Language/runtime:** **Rust or Go** (the `/admit` choke-point needs a tight, low-latency,
  predictable-GC admission loop — a Next.js/Node BFF route is too slow/stateful-unfriendly at scale).
  Internal-ingress ACA, distroless multi-stage.
- **Libs:** `redis-rs`/`go-redis`, Cosmos SDK, Event Grid publisher.
- **Endpoints:** `POST /admit` (the hot path), `POST /report` (record actual consumption post-run),
  `GET /ledger/{tenant}/{workspace}` (timepoint state for the admin UI), `GET /policy` / `PUT /policy`
  (per-workspace LCU/hour cap + rejection threshold, migrated from `surge-protection-panel.tsx`).

### 7.5 Loom lib client + BFF + surface

- **Client:** `lib/azure/capacity-broker-client.ts` with an `admit()` call injected at every
  choke-point: Synapse Spark session start (`synapse-livy-client.ts`), Databricks Jobs run-submit, ADX
  query wrapper (`kusto-client.ts`), AML training-job submit, and Loom Direct Lake framing.
- **BFF:** `app/api/admin/capacity/guardrails` (existing, extended) + `app/api/admin/capacity/ledger`.
- **Surface:** the **Capacity-Metrics admin page** (`/admin/capacity`) with **Health / Compute / Storage /
  Timepoint** tabs reading the live broker ledger — directly closing `appendix-platform-alm.md` GAP 2
  (which today is per-resource Azure Monitor charts only). `surge-protection-panel.tsx`'s master switch +
  rejection-threshold + per-engine override + per-workspace cap become the broker's policy layer.

### 7.6 Item-model integration

Not an item type — a cross-cutting control plane. Every metered item (notebook/Spark, pipeline,
kql-query, ml-experiment, semantic-model framing) flows through `/admit` on submit and `/report` on
completion; the ledger + chargeback (FGC-28 / rel-T85) read the same store.

### 7.7 Benchmark targets (PSR-1 metrics)

- **`/admit` p99 ≤ 10 ms** (Redis timepoint read + smoothing math — must not add perceptible submit
  latency).
- **Smoothing correctness:** a golden test reproducing Learn's worked example (a 1-CUHr background job on
  an F2-equivalent contributes ~1.25 LCU per timepoint) — invariant-tested, not benchmarked.
- **Throttle self-heal:** after a sustained-overage burst, throttling lifts automatically within one
  timepoint window of debt paydown.

### 7.8 Gov story

**Fully Gov-capable** — ACA, Azure Cache for Redis, Event Grid, Cosmos are all GCC-High/IL5 GA. No
managed-service substitution anywhere. No alternate Gov path required.

### 7.9 Phased delivery

- **H3a (HYP-9/10):** broker skeleton + smoothing math + FGC-25 cap migration. Core path executes:
  `/admit` returns allow/delay/reject against a live Redis timepoint ledger, smoothing golden test green.
- **H3b (HYP-11/12/13):** wire every choke-point, the Capacity-Metrics admin page, and Event-Grid→Activator.

### 7.10 HONEST LIMITS

- **LCU is a coefficient model, not a metered CU.** Fabric's CU is a first-party unit its own engines emit
  natively. Loom's LCU is a *published coefficient* over engine-native meters (vCore-s, DBU-s, ADX query
  cost, tokens). It is transparent and tunable but is an approximation of true cross-engine cost — it will
  not be penny-accurate the way a single-vendor meter is. Chargeback stays reconciled against real Azure
  Cost Management ($-truth via `cost-management-client.ts`) so the LCU never becomes the billing source.
- **Bursting is bounded by each engine's own elasticity.** Fabric's 3× Spark burst is a property of one
  capacity fabric. Loom's "burst" is whatever the underlying Synapse pool / Databricks cluster / ADX /
  AML autoscale allows — the broker accounts for and gates it, but cannot grant burst an engine can't
  physically provide.
- **Not cross-tenant hyperscale.** The broker smooths per tenant/workspace on the customer's own compute.
  It does not implement Fabric's cross-tenant capacity multiplexing or a global rescue-capacity pool —
  out of scope for a customer-owned-Azure model, and called out as a non-goal.
- **Admission is advisory-strong, not a hard kernel quota.** `/admit` gates at the job-submission
  choke-points Loom controls. A caller bypassing the client (raw ARM/SDK against the customer's own
  Synapse) is not intercepted — the broker governs Loom-mediated submission, not the whole Azure
  subscription. Documented honestly; the same posture Fabric-external tools have.

---

## 8. Supporting services (reference PSR — do not duplicate)

### 8.1 HYP-14 — Warm-Pool Keepalive (Spark/AML pre-warming)

`spark-session-pool.ts` already implements a warm pool but ships **DEFAULT OFF**
(`LOOM_SPARK_POOL_ENABLED` unset) and is **per-ACA-replica with no shared lease store** (its own scope
note). This epic promotes it to a shared cross-replica service and flips it **DEFAULT ON** — which is
exactly **PSR-3** in `PRP-performance-scale-parity.md`. We **reference PSR-3 as the owner**; HYP-14
contributes the shared-lease-store + Redis coordination the Direct Lake band needs (Loom Direct Lake and
the Spark pool share the same Redis instance). Acceptance = the PSR-3 benchmark delta (2-4 min cold start
→ warm attach), not a new number here.

### 8.2 HYP-15 — Shared Result-Cache

`query-cache.ts` is an in-process LRU+TTL with the explicit comment "back this with Redis later"; the
Cosmos tier lives in `query-result-cache.ts`. This epic stands up the Redis-backed cross-replica cache
that both **Loom Direct Lake's cold path** and **PSR-5/PSR-6** (AAS warm-cache, ADX result-cache) consume.
We **reference PSR-5/PSR-6 as owners**; HYP-15 contributes the shared Redis substrate (again, the same
Premium instance amortized across all three services). Acceptance = the PSR-5/PSR-6 cache-hit-ratio and
latency deltas.

**Amortization note.** HYP-14 and HYP-15 exist primarily to make one Azure Cache for Redis Premium
instance serve four consumers (Direct Lake residency, Broker timepoint ledger, Spark lease store,
result-cache) — one metered resource, four capabilities, bounded resting cost.

---

## 9. Wave slotting — the Hyperscale band (Waves H1-H3)

This is a **multi-wave XL epic** slotted as **its own band after the feature waves** (Waves 1-20 in
WAVES.md) and **after** the perf PRP's foundation. The dependency is hard:

```
 ... Waves 1-20 (features)  →  Wave PSR-A (PSR-1 harness + PSR-2 CI gate)  ──┐
                                                                            │ HARD PREREQ
                                                     ┌──────────────────────┘
                                                     ▼
   Wave H1 — Loom OneLake        Wave H2 — Loom Direct Lake     Wave H3 — Loom Capacity Broker
   HYP-1,2,3,4,16                HYP-5,6,7,8                    HYP-9,10,11,12,13
   (+ HYP-14/15 supporting, land alongside H2, reference PSR-3/5/6)
```

- **Why after the feature waves:** these are substrate services that make *existing* features faster /
  more unified / more governable — not new user-facing capability. They pay back only once the surface is
  broad enough to feel the structural gap, and they must not delay feature parity.
- **Why the benchmark harness is a hard prerequisite:** every H1-H3 acceptance is a *measured delta*
  (sub-second warm frame, `/admit` p99, resolve p95, smoothing golden test). Without PSR-1's harness and
  PSR-2's CI gate there is no receipt, and under `no-vaporware.md` the number **is** the receipt for this
  band. **Wave H1 must not start until PSR-1 + PSR-2 are green on main.**
- **Wave sizing:** each of H1/H2/H3 is one multi-agent build session (one agent per HYP item, parallel,
  single build-gate + roll at wave end), matching the WAVES.md wave-sizing convention. The three P0
  skeletons (HYP-1/5/9) each execute their core path at skeleton stage — no stubbed `/admit`, no mock
  frame, no empty resolver — advanced features (HYP-4 residual gaps, HYP-8 fallback semantics, HYP-13
  events) phase behind honest TODOs tied to a tracked follow-on.

**Total: 3 waves (H1-H3), 16 work items**, gated behind the 2-item PSR-A foundation. Adds a Hyperscale
band to the plan without renumbering the existing 20 feature waves.

---

## 10. Acceptance (epic-level, no-vaporware)

- **Loom OneLake:** create a lakehouse + external ADLS shortcut, resolve its `loom://` path, read via
  Synapse Serverless — **`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET**, real rows, resolve p95 ≤ 25 ms in PSR-1.
- **Loom Direct Lake:** frame a Delta table, run a star-schema aggregate, **sub-second on a warm frame**
  in the PSR-1 harness with `LOOM_SEMANTIC_BACKEND=loom-columnar-cache` — no `api.powerbi.com` call.
- **Loom Capacity Broker:** `/admit` gates a Spark + a Databricks + an ADX submission against a live Redis
  timepoint ledger; smoothing golden test reproduces Learn's worked example; throttle self-heals; the
  Capacity-Metrics admin page renders the live ledger.
- **Every merge** attaches a PSR-1 benchmark receipt (the number is the receipt) + the honest-503 gate
  proof (service env unset ⇒ silent fallback, no Fabric gate, no regression).

---

## 11. Operator-action ledger (Hyperscale band)

| Wave | Operator action | Why |
|------|-----------------|-----|
| PSR-A (prereq) | Deploy PSR-1 `perf-benchmarks` Cosmos container + `/admin/performance`; enable PSR-2 CI perf gate | The harness/receipt every H item is measured against |
| H1 | Deploy `compute/loom-onelake-app.bicep` + dedicated UAMI (Storage Blob Data Contributor on DLZ lake + Cosmos registry) | Namespace/shortcut/security service |
| H2 | Deploy `compute/loom-directlake-app.bicep` (per-tenant `minReplicas`) + **Azure Cache for Redis Premium** + UAMI (Storage Blob Data Reader) | Columnar cache/scan engine + shared residency index |
| H2 | (supporting) flip `LOOM_SPARK_POOL_ENABLED` **ON** + shared lease store (PSR-3) | Warm-pool keepalive |
| H3 | Deploy `compute/loom-capacity-broker-app.bicep` (`minReplicas: 2`) + Event Grid custom topic + UAMI (**zero data-plane roles**) | Admission-control broker + throttle events |

All infra ships behind a `LOOM_<SERVICE>_*` flag with an honest MessageBar gate; nothing hard-blocks when
a service is absent (default-ON, opt-out; a missing service degrades to the current per-item / cold path,
never to a Fabric requirement).

---

## 12. Cross-references

- `PRPs/active/next-waves/PRP-performance-scale-parity.md` — **hard prerequisite** (PSR-1/PSR-2 harness);
  supporting HYP-14/15 reference PSR-3/PSR-5/PSR-6 (do not duplicate).
- `PRPs/completed/fabric-parity/appendix-onelake.md` — the 46/46 `strong` grade + 7 residual gaps HYP-4 closes.
- `PRPs/completed/fabric-parity/appendix-power-bi.md` — G1 `LOOM_SEMANTIC_BACKEND` selector Loom Direct Lake extends.
- `PRPs/completed/fabric-parity/appendix-platform-alm.md` — GAP 2 Capacity-Metrics UI HYP-12 closes.
- `PRPs/active/enterprise-hardening/appendix-capacity-cost-governance.md` — the cost/chargeback policy layer the Broker's LCU ledger feeds.
- `platform/runners/script-runner/**` + `apps/copilot-maf/**` — the deployable-service template all three services follow.
