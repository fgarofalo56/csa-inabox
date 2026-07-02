# CSA Loom ⇄ Microsoft Fabric — 100% Parity PRP (Master)

> **Goal:** Every Microsoft Fabric workload, item type, and capability has a
> **one-for-one** equivalent in CSA Loom that is **functional end-to-end on an
> Azure-native default backend**, in **both Azure Commercial and Azure
> Government (GCC / GCC-High / DoD IL4/5)**, **turned ON day-one**, with a
> **Web-5.0 wizard/Copilot UI** and a **real backend behind every control**.
>
> Author: Fabric→Loom Parity Architect · Date: 2026-06-26 · Branch:
> `feat/loom-marketplace`
>
> Companion: [`PHASES.md`](./PHASES.md) — the kickoff-ready phased roadmap.

---

## 1. Executive summary

Loom is already a deep Fabric-parity surface: most editors trace to real Azure
backends (Synapse, ADX/Kusto, ADLS+Delta, ADF, AAS, AOAI, Cosmos, Purview,
Graph) with honest infra gates and no hard Fabric dependency. Twelve domain
deep-dives (the `appendix-*.md` files) and six functional audits (the
`audit-*.md` files) drove this PRP. They produce two distinct bodies of work:

- **Track A — Fix the broken (make-it-real).** The audits found a small set of
  *present-but-broken* surfaces that read as vaporware. The flagship is the
  operator's core complaint: **deployed Activators do nothing** (rules never
  persist; Start/Stop/Enable/Trigger no-op or 404), and the **RTI Activator
  runtime only ever queries Log Analytics — never the Eventhouse/ADX where
  streaming data lands**, so the canonical real-time alert can never fire. A
  cluster of **config-ignoring Copilot 503s** (governance/notebook/AI-functions
  call `resolveAoaiTarget()` bare), a **Next.js 15 async-params** latent break
  on the pipeline Debug routes, a **UDF execution backend that has no host**, a
  **DAB GraphQL runtime that ships dark**, and four **wave2-a items missing from
  the provisioning engine** round out Track A. These are P0/P1 and gate trust in
  the whole product.

- **Track B — New parity (build-the-gaps).** ~110 capability gaps across the 12
  domains where Fabric exposes something Loom does not yet surface. Highest
  value: zero-copy **CLONE / time-travel / restore** on the Warehouse;
  **Data Wrangler** (DE + DS); **PREDICT** batch-scoring; **HTAP auto-mirror**
  from SQL/Cosmos; **protection policies / OneLake security roles / item
  sharing / managed private endpoints / workspace identity** (the
  sovereignty-critical governance set, which is also the *primary* Gov story
  since Fabric protection policies and Cosmos mirroring are absent in
  GCC-High/DoD); **Apache Airflow** day-one; connector breadth 72→200+; and the
  developer platform (UDF execution, job scheduler, monitoring hub, SDK).

**Status by domain (loomStatus from the deep-dives):**

| Domain | Status | Features inventoried | Net-new gaps | Broken found |
|---|---|---|---|---|
| OneLake & unified storage | strong | 46 | 8 | 2 |
| Data Factory / integration | strong | 52 | 9 | 2 |
| Data Engineering (Spark/Lakehouse) | strong | 17 | 11 | 3 |
| Data Warehouse (SQL) | partial | 33 | 8 | 2 |
| Data Science | partial | 30 | 6 | 3 |
| Real-Time Intelligence | partial | 80 | 10 | 5 |
| Power BI / semantic | strong | 45 | 5 | 0 |
| Databases & Mirroring | partial | 37 | 10 | 0 |
| Platform, workspaces & ALM | strong | 57 | 5 | 2 |
| Governance, security & sovereignty | strong | 30 | 13 | (audit: 0 broken; 9 A-grade) |
| Developer platform & APIs | partial | 17 | 8 | 3 |

---

## 2. Cross-cutting requirements (apply to EVERY gap + EVERY phase)

These are the non-negotiable principles. A design that violates one is not
"done" regardless of whether it renders.

1. **No hard Fabric dependency** (`.claude/rules/no-fabric-dependency.md`). Each
   Fabric capability maps to an **Azure-native default backend** (+ OSS where a
   managed service is missing) that delivers a 1:1 feature match. Fabric /
   Power BI is an **opt-in alternative only** (`LOOM_<ITEM>_BACKEND=fabric` +
   bound workspace), never required on the default path. Never gate on
   `fabricWorkspaceId`; never call `api.fabric.microsoft.com` /
   `api.powerbi.com` / `onelake.dfs.fabric.microsoft.com` on the default path.

2. **Dual cloud — Commercial AND Government.** Every design works in Commercial
   and in Gov with GCC / GCC-High / DoD tenants. Use Gov endpoints (`*.us`,
   `*.usgovcloudapi.net`, `*.loganalytics.us`, Gov AOAI), private-only
   networking and CMK for IL4/5. Where a managed service is absent in Gov, ship
   the **OSS / self-hosted substitute deployable in Gov**:
   - Databricks Unity Catalog metastore → OSS Unity Catalog on AKS/ACA + Postgres
   - Apache Airflow → OSS Airflow on ACA/AKS (already cloud-neutral)
   - Data API Builder, MapLibre+PMTiles (Azure Maps gaps), Debezium CDC,
     sentence-transformers / Presidio (AI fallback), DuckDB columnar cache,
     OSS MLflow ≥3, OSS Spark on AKS (Delta SHALLOW CLONE) — all Gov-deployable.
   Many gaps are *Gov-defining*: protection policies, Cosmos/SQL HTAP mirroring,
   and per-workspace identity are **the** sovereign substitute because Fabric
   itself / those Fabric features do not exist in GCC-High/DoD.

3. **Day-one ON, no gates.** Everything is provisioned, configured, and
   **enabled by default at deploy via bicep**. Opt-in = turned **on and
   capable**, not dark-and-gated. The user can **disable** what they don't want.
   Where infra is genuinely required (a Function host, a DAB runtime, a
   paginated renderer, an Eventhouse alert path, an AAS engine), the **platform
   deploys it day-one** — it is not left as an honest-gate the user must satisfy.

4. **Web-5.0 UX** (`.claude/rules/web3-ui.md` + Loom design standards). Fluent v9
   + Loom design tokens, cards with elevation, section icons, `TileGrid`,
   `EmptyState`, polished loading/error/gate states. **All configuration via
   wizards, dropdowns, WYSIWYG/canvas, and Copilot builders** — users never
   hand-write config or guess wiring (`loom_no_freeform_config`). The **only**
   freeform exception is a 1:1 source-product code/expression surface (KQL
   editor, SQL editor, ADF dynamic-content expression builder, notebook cells).
   Every capability is surfaced in its design UI.

5. **Real & usable** (`.claude/rules/no-vaporware.md` + `.claude/rules/ui-parity.md`).
   Every control maps to a real backend (Azure REST / SQL-TDS / ARM /
   data-plane). No dead buttons, no mock arrays, no `return []`. Each merge
   attaches a **real-data E2E receipt** (endpoint hit + first 300 chars of the
   real response + screenshot/Playwright trace + bicep diff), validated with
   `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**.

---

## 3. Fabric → Loom parity scorecard

Workload-level. Per-capability rows live in each appendix's "Loom coverage"
section. Status legend: **A** = built, real backend, day-one (regression
baseline) · **B** = built but opt-in/gated or shallow · **C** = partial /
parity-gap · **D** = stubbed/broken · **❌** = missing.

| Fabric workload / capability | Azure-native Loom backend (default) | Loom status | Gap → Phase |
|---|---|---|---|
| **OneLake** storage, shortcuts (ADLS/S3/GCS), Delta/Iceberg | ADLS Gen2 + Delta; shortcut engines | **A** | — |
| OneLake short-lived user-delegated SAS (external access) | ADLS user-delegation SAS + Storage Blob Delegator | **D** broken | P3 |
| OneLake access diagnostics (who-read-what) | ADLS diag → Log Analytics KQL | **❌** | P3 |
| Shortcut caching / transformations / gateway / Iceberg-in | Synapse/Databricks/ADF copy + SHIR | **C** | P1/P3 |
| OneLake file explorer hub + connect helpers | ADLS DFS recursive + catalog | **C** | P3 |
| OneLake events → Activator | Event Grid system topic → Activator | **C** | P2 |
| **Data Factory** pipelines (canvas, 50+ activities) | Synapse/ADF pipelines (real ARM) | **A** | — |
| Copy job (Full/Incremental/CDC) | ADF pipeline + Azure SQL watermark control table | **A** (847-row E2E) | broaden P1 |
| Dataflow Gen2 (Fast Copy, staging, incremental) | ADF Copy/WranglingDataFlow | **C** | P1 |
| Mapping data flow live preview/debug | ADF data-flow debug session | **C** | P1 |
| Apache Airflow job | OSS Airflow (ACA/AKS) day-one | **D** no host | P0/P1 |
| Connector catalog (200+) | ADF/Synapse linkedservices ARM | **B** (72) | P1 |
| Mirroring (SQL/Cosmos/Snowflake/PG/Databricks/MySQL/SAP) | ADF CDC / change-feed → Bronze Delta + Synapse | **C** | P1 |
| **Lakehouse / Spark** notebooks, SJD, env, Delta maint | Synapse/Databricks Livy + ADLS Delta | **A** | — |
| Data Wrangler (no-code transform + codegen) | pandas/PySpark transpiler on Livy | **❌** | P3/P5 |
| API for GraphQL (auto-schema from SQL) | Data API Builder on ACA | **B** gated | P0/P3 |
| Native Execution Engine (Velox/Gluten) | Databricks Photon / Synapse Gluten conf | **❌** | P3 |
| High-concurrency sessions + runMultiple DAG | shared Livy/Databricks session | **❌** | P3 |
| **Warehouse** (T-SQL, schemas, queries) | Synapse dedicated/serverless + ADLS Delta | **B** | — |
| Zero-copy CLONE TABLE (+ point-in-time) | Delta SHALLOW CLONE / CTAS fallback | **❌** | P3 |
| FOR TIMESTAMP AS OF time travel | Delta time travel (Serverless/Spark) | **❌** | P3 |
| Restore points + restore-in-place | Synapse ARM restore points / Delta RESTORE | **❌** | P3 |
| COPY INTO ingestion wizard | Synapse TDS COPY INTO + UAMI credential | **❌** | P3 |
| RLS / CLS / DDM builders | Synapse SQL security policies | **C** | P3/P4 |
| **Data Science** notebooks, AutoML, experiments | Synapse Spark + AML/OSS MLflow | **B** | — |
| PREDICT batch scoring (ML model) | SynapseML MLFlowTransformer Spark job | **❌** | P5 |
| Real-time endpoint test/lifecycle/auto-sleep | AML managed online endpoint / ACA scale-0 | **D** | P5 |
| AI Functions (9) + Text Analytics / Translator | AOAI + Azure AI Language/Translator (+OSS) | **C** (5/9) | P5 |
| **Real-Time Intelligence** Eventhouse/KQL DB | Azure Data Explorer (ADX) | **A** | — |
| **Activator (Reflex) runtime** | Logic App Standard → ADX Run-KQL → actions | **D** broken | **P0** |
| RTI Hub day-one discovery + live preview | Resource Graph + ADX sink / EH Capture | **D** gated | **P0** |
| Eventstream no-code canvas (7 operators) | Stream Analytics + Event Hubs | **C** | P2 |
| Real-Time Dashboard depth | Loom-native renderer over ADX | **C** | P2 |
| Anomaly detection / forecasting | ADX native KQL (series_decompose_*) | **❌** | P2 |
| OneLake availability (ADX→Delta) | ADX continuous export → ADLS Delta | **❌** | P2 |
| **Power BI** report designer + semantic model | Loom-native renderer + AAS / DAX→Synapse | **A** | — |
| Multi-table (star-schema) visuals on default | report-model-resolver JOIN graph | **C** | P5 |
| Day-one tabular engine (AAS / DAX→Synapse) | AAS day-one + Loom-native Gov default | **D** gated | P5 |
| Linguistic schema / synonyms / Q&A grounding | Cosmos + AOAI + TMDL | **❌** | P5 |
| Connected metrics / scorecards + alerts | DAX eval + Azure Monitor action groups | **C** | P5 |
| Paginated report export (PDF/Excel) | render Function (needs bicep) | **C** | P5 |
| **Databases** Fabric SQL DB / Cosmos DB HTAP | Azure SQL/Cosmos + auto-mirror → Bronze | **C** | P1 |
| **Platform/ALM** workspaces, Git CI, deploy pipelines | Cosmos + ADO/GitHub REST + provisioners | **A** | — |
| Workspace identity (per-ws UAMI + trusted access) | UAMI + RBAC + storage resource-instance rules | **❌** | P4/P6 |
| Capacity Metrics app | Azure Monitor + Log Analytics + Cost | **C** | P6 |
| Task flows (10 types, templates, multi-canvas) | Cosmos metadata | **C** | P6 |
| Git branch-out to new workspace | ADO/GitHub ref API + Cosmos | **❌** | P6 |
| **Governance** Purview Data Map / scan / classify | Classic Purview data plane (real) | **A** | — |
| MIP labels / DLP / DSPM-AI / audit / catalog | Graph /beta + Cosmos + AI Search | **A** | — |
| Protection policies (label → access enforce) | Loom label-protection engine (RBAC/DENY) | **D** | **P4** |
| OneLake security roles (folder/table OLS+RLS/CLS) | ADLS ACL + Synapse RLS + ADX RLS | **D** | **P4** |
| Item sharing / granular permission dialog | Cosmos grants + ADLS ACL + Synapse GRANT | **D** | **P4** |
| Managed private endpoint self-service | ARM privateEndpoints on DLZ managed VNet | **❌** | **P4** |
| Endorsement / certification | Cosmos + Graph group check | **C** | P4 |
| Label inheritance / default / mandatory | MIP + reconciler | **C** | P4 |
| **Developer** Fabric REST + LRO + `fab` CLI | Loom BFF REST + `loom` CLI | **A** | — |
| User Data Functions execution | Azure Functions Flex / ACA host (day-one) | **D** no host | **P0**/P7 |
| Unified Job Scheduler + schedule store | Cosmos schedule + provisioner | **❌** | P7 |
| Monitoring Hub (cross-item runs) | Livy + Log Analytics aggregation | **C** | P7 |
| Fabric events → Event Grid webhooks | Event Grid system topic + subs | **C** | P7 |
| Loom SDK (Python/TS) + Terraform provider | published packages | **❌** | P7 |

---

## 4. Track A — Fix the broken (from the audits)

Detailed in [`audit-rti-activator.md`](./audit-rti-activator.md),
[`audit-data-integration.md`](./audit-data-integration.md),
[`audit-analytics-bi.md`](./audit-analytics-bi.md),
[`audit-governance-admin.md`](./audit-governance-admin.md),
[`audit-platform-items.md`](./audit-platform-items.md),
[`audit-ai-copilot.md`](./audit-ai-copilot.md). These flow into **Phase 0**.

| # | Surface | Severity | Root cause | Fix |
|---|---|---|---|---|
| A1 | **Deployed Activator does nothing** | P0 | `provisionAzureMonitor` creates real `scheduledQueryRules` but never persists `MonitorRuleRecord[]` to Cosmos `state.rules`; every action keys off the empty `state.rules` → no-op / 404 | Persist full `state.rules` from the provisioner (add a state channel to `ProvisionResult` or upsert `state.rules` directly) |
| A2 | **Activator runtime queries only Log Analytics** | P0 | `activator-monitor.ts` / `provisioners/activator.ts` have **zero ADX path**; RTI data lands in Eventhouse → alert can never fire | Add an **ADX-query-backed Activator runtime**: Logic App Standard (recurrence → ADX Run-KQL → condition → action fan-out); reserve scheduledQueryRules for LA/infra alerts |
| A3 | **Activator + RTI Hub appear dead on fresh deploy** | P0 | Activator demands `LOOM_LOG_ANALYTICS_RESOURCE_ID` + Monitoring Contributor; RTI Hub 503s for `LOOM_SUBSCRIPTION_ID` + Reader | Bicep deploys Eventhouse alert path + Logic App host day-one; grant Console UAMI ADX DB Admin + Reader(subs) + Monitoring Contributor + Logic App Contributor; wire env in every param file |
| A4 | **RTI Hub / Eventstream live preview blank** | P0 | `@azure/event-hubs` (AMQP) not bundled; EH has no HTTPS receive | Bundle EH receive day-one **and** add fallback reading last-N from ADX sink / EH Capture Delta so preview always shows real data under private-only networking |
| A5 | Editor rules table inert (only Trigger) + no rule edit | P1 | editor renders only `triggerNow`; PATCH/DELETE only on hub pane | Add per-row Enable/Disable/Delete + Edit-rule (re-open wizard) to the editor |
| A6 | **Config-ignoring Copilot 503s** (governance, notebook, AI-functions) | P1 | `resolveAoaiTarget()` called **bare** — ignores admin tenant Copilot pick | `resolveAoaiTarget(await loadTenantCopilotConfig(oid))` — mirror the dataflow/report routes |
| A7 | **Pipeline Debug/Evaluate/Output/Triggers** Next.js 15 async-params | P1 | routes read `ctx.params.id` sync → `undefined` → "pipeline not found"; hard-breaks on Next 16 | `ctx:{params:Promise<…>}` + `await ctx.params` (4 routes) |
| A8 | **User Data Functions never execute** | P0/P1 | editor saves Python but no provisioner deploys a Function host | Ship UDF runtime (Azure Functions Flex / ACA) day-one + publish route writing `state.azureFunctionUrl` |
| A9 | **DAB GraphQL runtime ships dark** | P1 | `dab-runtime.bicep` exists but not wired ON; `LOOM_DAB_PREVIEW_URL` unset | Deploy DAB ACA day-one + set env |
| A10 | **wave2-a items skipped by provisioning engine** | P1/P2 | event-hubs/service-bus/event-grid/lakehouse-shortcut absent from `PROVISIONERS` → install marks `skipped` | Register thin namespace-verify provisioners (or document navigator-only allowlist) |
| A11 | Mapping data flow preview/debug hard-disabled | P1 | `debugClusterAvailable={false}`; no debug route | Add `createDataFlowDebugSession` + debug route; flip flag |
| A12 | Pipeline Copilot not docked in flagship editor | P2 | route exists only for alias editors | Dock `PipelineCopilotPane` + generalize copilot route to unified item id |
| A13 | Dead legacy stub editors (Synapse/Databricks) | P2 | orphaned exports render "legacy stub" MessageBar | Delete dead exports or alias to real editors |

---

## 5. Track B — New parity (from the gaps)

~110 capability gaps across the 12 domains, each specified in its appendix with
architecture, Web-5.0 UI, BFF APIs, Azure services, deploy work, Commercial vs
Gov variants, day-one config, and acceptance. They are sequenced by value into
Phases 1–7 in [`PHASES.md`](./PHASES.md). P0 net-new (build alongside Track A):

- **Apache Airflow day-one** (data-factory) — OSS host, no Fabric.
- **HTAP auto-mirror** from Azure SQL DB and Cosmos DB (databases) — the only
  HTAP path in Gov (Fabric SQL DB absent; Cosmos mirroring sovereign-blocked).
- **MySQL mirroring source** (databases).
- **Zero-copy CLONE TABLE** + **time travel** (warehouse).
- **Data Wrangler** + **PREDICT** wizard (data engineering / data science).
- **Protection policies**, **OneLake security roles**, **item sharing**,
  **managed private endpoints**, **workspace identity** (governance/platform) —
  the sovereign-critical set.
- **Day-one tabular engine** (Power BI) — un-gate AAS-backed surfaces.

---

## 6. Appendix & audit index

**Domain deep-dives (full per-capability detail — link, don't duplicate):**

- [appendix-onelake.md](./appendix-onelake.md)
- [appendix-data-factory.md](./appendix-data-factory.md)
- [appendix-data-engineering.md](./appendix-data-engineering.md)
- [appendix-data-warehouse.md](./appendix-data-warehouse.md)
- [appendix-data-science.md](./appendix-data-science.md)
- [appendix-real-time-intelligence.md](./appendix-real-time-intelligence.md)
- [appendix-power-bi.md](./appendix-power-bi.md)
- [appendix-databases.md](./appendix-databases.md)
- [appendix-platform-alm.md](./appendix-platform-alm.md)
- [appendix-governance-security.md](./appendix-governance-security.md)
- [appendix-developer-platform.md](./appendix-developer-platform.md)

**Functional audits (the broken/vaporware findings → Track A):**

- [audit-rti-activator.md](./audit-rti-activator.md)
- [audit-data-integration.md](./audit-data-integration.md)
- [audit-analytics-bi.md](./audit-analytics-bi.md)
- [audit-governance-admin.md](./audit-governance-admin.md)
- [audit-platform-items.md](./audit-platform-items.md)
- [audit-ai-copilot.md](./audit-ai-copilot.md)

---

## 7. Definition of done (whole program)

Per `no-fabric-dependency.md` §Verification: with
`LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**, every item installs + its editor
executes its primary action against a real Azure backend (real receipt) in
**both Commercial and Gov**; every config surface is a wizard/dropdown/canvas/
Copilot (no freeform except 1:1 code surfaces); every capability is ON day-one
via bicep with a user-facing disable; and the parity doc per surface
(`docs/fiab/parity/<slug>.md`) shows zero ❌ and zero stub banners.
