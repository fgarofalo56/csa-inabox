# CSA Loom — Next-Waves Execution Plan (WAVES.md)

> **Date:** 2026-07-08 · **Status:** proposed
> **Scope:** wave-by-wave build plan across all five next-wave PRPs plus the docs-drift
> correction backlog and the highest-value net-new breadth findings.
> **Sources folded in:** `PRP-fabric-gap-closure.md` (FGC-01…31), `PRP-azure-ai-foundry-integration.md`
> (AIF-1…18), `PRP-azure-service-integrations.md` (SVC-1…11), `PRP-databricks-parity.md` (DBX-1…14),
> `PRP-surface-max-enhancements.md` (W1…22), the DOCS-VALIDATION stream (DOC-1…6) and the
> BREADTH-CRITIC stream (BR-*).
> **Governing rules (die-hard):** `no-fabric-dependency.md`, `no-vaporware.md`, `ui-parity.md`,
> `loom_no_freeform_config`, `loom_design_standards`. Dual-cloud (Commercial + Gov) mandatory per item.

---

## Global principle — default-ON / opt-out (2026-07-08)

**Standing operator directive (verbatim intent):** *"No gates. Allow admins to shut down / disable,
but everything should be enabled by default with an opt-out approach, not opt-in."*

Every Loom-native feature in these waves ships **enabled by default**. There is no spend-approval gate,
no tenant-admin enablement gate, and no "opt-in before you can use it" flag on any Loom capability.
Instead:

- **Default ON.** A feature is live the moment its code deploys — no one has to turn it on.
- **Cost control = scale-to-zero / idle-stop defaults, not gates.** Metered compute (ACA apps, Spark,
  ACA Jobs, AML compute) defaults to autoscale-to-zero or an idle-stop timer so the resting cost is ~$0.
  Spend is bounded by these defaults plus the cost/capacity *reporting and admin toggles* below — never
  by blocking the feature up front.
- **Admin opt-out, not user opt-in.** Admins get explicit disable / shutdown controls (per-item and, where
  it applies, a tenant-wide kill switch) in tenant settings. The control removes a running default; it is
  not a prerequisite for the feature to work.

**The one exception (do NOT flip):** **real Microsoft Fabric / Power BI service backends stay strictly
opt-IN** per the die-hard `no-fabric-dependency.md` rule. Every item is 100% functional Azure-native by
default; a Fabric/Power BI backend is only ever selected explicitly via `LOOM_<ITEM>_BACKEND=fabric` +
a bound workspace. First-party Databricks/ADT/Photon alternate backends are likewise opt-in.

**Still allowed (these are NOT enablement gates):**
- **Honest infra gates** — a Fluent `MessageBar intent="warning"` naming the exact missing env var / role /
  Azure resource (including metered resources not yet deployed, or a service not GA in a Gov region). This
  is a deployment fact, not a policy gate; the full UI still renders.
- **Governance-as-the-feature** — approval workflows admins *configure* as the product itself (e.g.
  approval-gated deployment-pipeline stage promotion, data-contract breaking-change gates, admission
  control / spend caps / chargeback). These are user-owned controls, kept as designed.

---

## How this plan is ordered

Three ordering forces, applied in this priority:

1. **P0 correctness / docs-drift first.** Release-truth and compliance-truth defects outrank every
   feature. All docs fixes and the compliance-bicep gap land in Wave 1.
2. **Highest user-visible value per unit of effort next.** Canvas power-UX and the RAG/agent/app
   foundations pay back immediately and unblock the most downstream work.
3. **Dependencies before dependents.** Foundations are scheduled ahead of the items that ride them:
   - `AIF-2` (embeddings) → `AIF-1`, `AIF-3`; `AIF-9` (Connections) plumbs `AIF-1`/`AIF-2`;
     `AIF-5` (typed tool catalog) → `AIF-4`/`AIF-6`/`AIF-18`; `AIF-8` (MAF Gov) backstops all agent items.
   - `SVC-1` (4 cognitive clients) → `SVC-2`/`SVC-4`/`SVC-5`/`SVC-6`/`SVC-8`.
   - `DBX-1` (Loom App Runtime / ACA) → `DBX-2`, `DBX-9`; `DBX-6` (Metric Views) → `DBX-5`;
     `DBX-3` + `DBX-7` ship together.
   - `W1` (undo/redo history hook) → the rest of the canvas power layer; `W11` (DQ engine) → `W18`.
   - `BR-PAT` (scoped tokens) → `BR-OPENAPI`, `BR-TERRAFORM`, `BR-SCIM`; `BR-WEBHOOK` → `W18`.

**Wave sizing.** Each wave is 6–10 items sized for one multi-agent build session (one agent per item,
built in parallel, single build-gate + roll at wave end). Items inside a wave carry no hard intra-wave
dependency; where one exists (e.g. AIF-2 before AIF-3) they are split across adjacent waves.

**Tag legend.** `[PRP-source, Priority, Effort]` — e.g. `[AIF, P0, L]`. Sources: `DOCS`, `FGC`,
`AIF`, `SVC`, `DBX`, `SURF`, `BREADTH`.

**Total: 18 waves.** Waves 1–6 are the P0/P1 spine (correctness + the four foundations + canvas power).
Waves 7–13 are the P1/P2 depth build-out. Waves 14–18 are the P2/P3 tail plus net-new breadth.

---

## Operator-action ledger (read before each flagged wave)

Several waves provision **new metered Azure resources, new roles, or new spend**. These need an operator
decision (deploy the bicep, grant the role, accept the cost) — they are called out per wave below and
collected here:

| Wave | Operator action needed | Why |
|------|------------------------|-----|
| 1 | Redeploy the flagged bicep modules with `publicNetworkAccess: 'Disabled'` param (DOC-2) | Zero-trust posture the compliance docs already claim |
| 3 | Grant Search service identity **Cognitive Services OpenAI User** on Foundry AOAI (AIF-2) | Server-side integrated vectorization |
| 4 | Deploy 4 Cognitive accounts (FormRecognizer/ComputerVision/TextAnalytics/TextTranslation) + UAMI `Cognitive Services User` (SVC-1) | AI-enrichment pipeline activities |
| 5 | Deploy `copilot/maf.bicep` Container App + UAMI (AIF-8) | Gov OSS agent runtime |
| 6 | Grant Console UAMI **Container Apps Contributor + AcrPush** on a `loom-apps` sub-RG; env `LOOM_APPS_CAE_ID`/`LOOM_APPS_ACR_LOGIN_SERVER` (DBX-1); new Cosmos `loomPatTokens` (BR-PAT) | Hosted-app runtime + API tokens |
| 7 | (opt-in only) `adt-instance.bicep` + ADT Data Owner if the ADT path is exercised (FGC-12) | Digital-twin ADT alternate (ADX path needs nothing) |
| 8 | Cost Management Reader for Console UAMI (FGC-25/28); scoped ADLS grant + Entra B2B for external share (FGC-30) | Admission control, chargeback, cross-tenant share |
| 10 | `postgres-flexible.bicep` (metered server) (DBX-4) | Lakebase-parity OLTP |
| 11 | Durable Functions app + task-hub storage (`LOOM_AGENTFLOW_ORCHESTRATOR`) (W9); DQ Cosmos container (W11) | Agent-flow execution + DQ store |
| 12 | `Microsoft.SignalRService/webPubSub` + UAMI Service Owner; `LOOM_WEBPUBSUB_ENDPOINT` (W5) | Real-time co-authoring (silent single-editor fallback if unset) |
| 13 | `health-data-services.bicep` (metered FHIR workspace, default-off) (SVC-3); Video Indexer account (SVC-6) | Health + media backends |
| 15 | Automation-runbook / Logic-App teardown timer (W22 sandbox); Confidential Ledger (SVC-9) | TTL teardown, tamper-evident audit |
| 17 | Chaos Studio experiment targets (SVC-11); Graph Data Connect app consent + M365 E5 (SVC-10) | Reliability + M365 org analytics |
| 18 | Cosmos multi-region write + secondary ACA env behind Front Door (BR-CONTROLPLANE-DR) | Control-plane DR |

All infra items ship behind a `LOOM_<SERVICE>_*` flag with an honest MessageBar gate; nothing hard-blocks
when the resource is absent.

---

## Wave 1 — Docs-drift & compliance truth  *(do first — P0 correctness)*

Release-truth and compliance-truth. Fast (mostly docs + a bicep param sweep), high blast-radius, and
they stop a public/gov reader from being misled.

- **DOC-1** Remove Power BI Premium from base deployment prerequisites/cost tables; reframe as opt-in Direct-Lake-Shim callout. `[DOCS, P0, S]`
- **DOC-2** Add a private-endpoint-conditional `publicNetworkAccess` param (default `'Disabled'`) to the flagged data-plane bicep modules **and** soften the blanket compliance claims to match. `[DOCS, P0, M]`
- **DOC-3** Finish rel-T77: replace the 4 surviving "Deploy-to-Azure button" mentions with `az deployment sub create`. `[DOCS, P1, S]`
- **DOC-4** Rewrite `semantic-model-parity-spec.md` to describe the shipped AAS-native designer as default; demote Power BI/XMLA to opt-in. `[DOCS, P1, S]`
- **DOC-5** Scope `disaster-recovery.md` honestly (label as generic guidance) + add a CSA-Loom-specific DR page stating the current gap; parameterize `storage.bicep` sku for an opt-in GRS/GZRS DR tier. `[DOCS, P1, M]`
- **BR-SIEM** Continuous SIEM-exportable admin/audit activity stream: emit every admin-plane mutation to Log Analytics via a DCR/`LoomAudit_CL` custom table + Sentinel rule templates. `[BREADTH, P1, S]`

**Operator action:** DOC-2 needs a bicep redeploy of the flagged modules; BR-SIEM needs a DCR + (optional) Sentinel.

---

## Wave 2 — Canvas power layer + cross-item intelligence  *(Surface Wave A/B — fast UX wins)*

Mostly client-side, near-zero backend, and the single most-felt gaps in any design tool. `W1`'s history
hook is the shared foundation the rest reuse.

- **W1** Action-level undo/redo (`useCanvasHistory` hook, `Ctrl+Z`/`Ctrl+Shift+Z`) on every canvas. `[SURF, P0, M]`
- **W2** Copy/paste + duplicate-node on canvases. `[SURF, P1, S]`
- **W3** Multi-select align/distribute toolbar. `[SURF, P2, S]`
- **W20** Canvas shortcut cheat-sheet / `?` overlay. `[SURF, P3, S]`
- **W21** Command-palette coverage for canvas-scoped actions. `[SURF, P3, S]`
- **W19** Cross-item "Explain this" Copilot (pipelines/notebooks/warehouses). `[SURF, P2, S]`
- **W8** Cross-catalog impact analysis before delete/edit. `[SURF, P1, M]`
- **W6** In-editor version-history timeline + visual diff. `[SURF, P1, L]`

**Operator action:** none (all reuse existing AOAI/lineage/git/Cosmos backends).

---

## Wave 3 — RAG spine foundation  *(AI Foundry P0 core)*

The embedding path and agentic retrieval that turn "a Search editor" into Loom's intelligence layer.
`AIF-9`/`AIF-2` land first because `AIF-1`/`AIF-3` (Wave 4) stand on them.

- **AIF-9** Foundry Connections CRUD (shared plumbing — land first). `[AIF, P1, M]`
- **AIF-2** Embedding client + integrated-vectorization (skillset + vector-profile designers). `[AIF, P0, L]`
- **AIF-1** Knowledge Sources + Knowledge Bases (agentic retrieval / Foundry IQ). `[AIF, P0, L]`
- **AIF-10** Indexer scheduling + execution history + field mappings + reset. `[AIF, P1, M]`
- **AIF-16** Scoring-profile / analyzer / CORS / CMK designers (kills JSON textareas). `[AIF, P2, M]`
- **AIF-17** AI Search service administration in-editor. `[AIF, P2, M]`

**Operator action:** grant the Search service system identity **Cognitive Services OpenAI User** on the Foundry AOAI account (AIF-2).

---

## Wave 4 — AI-enrichment spine  *(Azure services P0/P1 + Foundry index wizard)*

The cognitive-client family that every other AI service reuses, plus the one-click "index my estate" wizard.

- **SVC-1** AI-enrichment pipeline activities — 4 clients (doc-intel / vision / language / translator) + canvas nodes. **Foundation.** `[SVC, P0, L]`
- **SVC-2** AI Search cognitive skillsets (ordered skill-chain builder). `[SVC, P1, L]`
- **SVC-8** Content Safety `ModerateText` pipeline activity (trivial extend of the built client). `[SVC, P3, S]`
- **AIF-3** Index-my-lakehouse / warehouse / ADX wizard (depends on AIF-2). `[AIF, P0, XL]`
- **AIF-7** `ai-enrichment` workflow item (batch LLM over columns). `[AIF, P1, L]`
- **FGC-19** AI Functions breadth + model-tier selector. `[FGC, P3, S]`

**Operator action:** deploy the 4 single-kind Cognitive accounts + `Cognitive Services User` grant (SVC-1); reuse the Wave-3 Search→AOAI grant for AIF-3.

---

## Wave 5 — Multi-agent spine  *(AI Foundry agents)*

`AIF-5` (typed tool catalog) removes the `no-freeform-config` violation and unblocks the rest.

- **AIF-5** Typed agent tool catalog (removes the freeform comma-separated box). **Prereq for 4/6/18.** `[AIF, P0, M]`
- **AIF-4** Connected-agent (multi-agent) composition. `[AIF, P0, M]`
- **AIF-6** Visual multi-agent workflow canvas (`canvas-node-kit`). `[AIF, P1, L]`
- **AIF-8** Microsoft Agent Framework 1.0 OSS runtime tier (Gov backstop). `[AIF, P1, XL]`
- **AIF-14** Durable cross-session agent memory. `[AIF, P2, M]`
- **AIF-18** Browser-automation tool type (Playwright ACA substitute). `[AIF, P3, M]`

**Operator action:** deploy `copilot/maf.bicep` Container App + UAMI (AIF-8); AIF-14 needs a new Cosmos container (`createIfNotExists`, no new resource type).

---

## Wave 6 — Loom App Runtime + API surface foundation  *(Databricks P0 + platform)*

The marquee hosted-app gap and the API-token foundation the whole developer-platform track rides.

- **DBX-1** `loom-app-runtime` — one-click hosted Python/Node apps on ACA (autoscale-to-zero, OAuth-scoped). Deploy **default-allowed / no spend gate**; cost bounded by scale-to-zero; admin **per-app disable + tenant-wide runtime kill switch** (opt-out). **Foundation for DBX-2/9.** `[DBX, P0, XL]`
- **DBX-2** Custom agent hosting (bring-your-own harness — rides DBX-1). `[DBX, P1, L]`
- **DBX-9** Publish a Data Agent as a Managed MCP Server (rides DBX-1). `[DBX, P2, M]`
- **BR-PAT** Scoped API tokens / PAT for non-interactive access (`loomPatTokens` + `resolvePat()` middleware + `/admin/developer/tokens`). **Foundation for BR-OPENAPI/TERRAFORM/SCIM.** `[BREADTH, P0, M]`
- **BR-WEBHOOK** Outbound webhook / event-subscription registry (Event Grid + Service Bus fan-out). **Feeds W18.** `[BREADTH, P1, M]`
- **W18** Marketplace listing analytics + subscriber SLA webhooks (uses BR-WEBHOOK). `[SURF, P2, M]`

**Operator action:** Console UAMI **Container Apps Contributor + AcrPush** on a `loom-apps` sub-RG + `LOOM_APPS_CAE_ID`/`LOOM_APPS_ACR_LOGIN_SERVER` (DBX-1); new Cosmos `loomPatTokens` (BR-PAT); Event Grid topic + Service Bus DLQ (BR-WEBHOOK).

---

## Wave 7 — Real-Time Intelligence depth  *(Fabric gap P1 + Foundry P1/P2)*

- **FGC-12** Digital Twin Builder item (ADX-native default, ADT opt-in). `[FGC, P1, XL]`
- **FGC-13** Activator trigger-model depth (Event/Split/Property rules, object-key grouping). `[FGC, P1, L]`
- **FGC-14** Real-Time hub new source connectors + curated samples. `[FGC, P2, M]`
- **FGC-15** Eventstream DeltaFlow analytics-ready CDC transform. `[FGC, P2, M]`
- **AIF-11** PTU + Batch deployment types. `[AIF, P1, M]`
- **AIF-13** AgentOps: eval-linked tracing + per-agent cost/latency rollup. `[AIF, P2, M]`

**Operator action:** only if the ADT alternate path of FGC-12 is exercised (`adt-instance.bicep` + Data Owner); the default ADX-native path needs none.

---

## Wave 8 — Databases, ALM & capacity governance  *(Fabric gap P1)*

The P1 admin/ALM cluster — every item is release-relevant.

- **FGC-20** Azure SQL Database PITR / restore points. `[FGC, P1, M]`
- **FGC-24** Variable-library-aware deployment-pipeline promotion. `[FGC, P1, M]` ✅ **DONE**
- **FGC-25** Capacity surge protection (admission control). `[FGC, P1, M]`
- **FGC-28** Chargeback report page. `[FGC, P1, M]`
- **FGC-30** External (cross-tenant) data sharing (Entra B2B + scoped ADLS grant). `[FGC, P1, L]`
- **BR-APPROVAL** Approval-gated deployment-pipeline stage promotion (required reviewers). `[BREADTH, P1, S]` ✅ **DONE**
- **BR-COSTATTR** Cost-per-query / per-user cost attribution depth. `[BREADTH, P1, M]`

**Operator action:** Cost Management Reader for Console UAMI (FGC-25/28); scoped ADLS grant + Entra B2B guest config (FGC-30).

---

## Wave 9 — Data Science depth  *(Fabric gap P1/P2 + model router)*

- **FGC-16** Data Wrangler in-notebook (AI-assisted prep). `[FGC, P1, L]`
- **FGC-17** Semantic link / SemPy (`LoomDataFrame`). `[FGC, P2, L]`
- **FGC-18** Batch model scoring (PREDICT-equivalent). `[FGC, P2, M]`
- **FGC-22** Copilot autonomous model-health scan + apply-fix. `[FGC, P2, M]`
- **FGC-21** Standalone DAX query view. `[FGC, P2, S]`
- **AIF-12** Model Router (router deployment + Loom-native tier router). `[AIF, P2, M]`

**Operator action:** none (reuses AOAI/AAS/Synapse/AML already provisioned).

---

## Wave 10 — Databricks pipelines, SQL & Lakebase  *(parity P1/P2)*

`DBX-3` + `DBX-7` ship together (streaming tables/MVs are DLT-backed); `DBX-5` follows `DBX-6`.

- **DBX-3** Lakeflow Declarative Pipelines (DLT) visual editor. `[DBX, P1, L]`
- **DBX-7** Streaming tables + materialized views in the SQL editor. `[DBX, P2, M]`
- **DBX-4** Lakebase — serverless Postgres OLTP (Flexible Server default, Databricks opt-in). `[DBX, P1, L]`
- **DBX-6** UC Metric Views (Loom-native semantic-layer default). `[DBX, P2, M]`
- **DBX-5** Data Agent Genie deltas (metric-view grounding + deep link — after DBX-6). `[DBX, P2, S]`
- **DBX-11** Managed Iceberg + UniForm table-format dropdown. `[DBX, P2, S]`

**Operator action:** `postgres-flexible.bicep` (metered server) for DBX-4.

---

## Wave 11 — New item types: governance, quality & agent-flow  *(Surface Wave D)*

- **W9** Generalized Agent Flow Designer (chains MCP tools via Durable Functions). `[SURF, P1, XL]`
- **W10** Data Contract item type (schema + SLA + breaking-change gate). `[SURF, P1, L]`
- **W11** Data Quality Rule Engine item (feeds W18 SLA webhooks). `[SURF, P1, L]`
- **W12** Synthetic Data Generator item. `[SURF, P2, M]`
- **AIF-15** AI Red Teaming Agent (PyRIT adversarial scan). `[AIF, P2, M]`
- **BR-CONTRACT-GATE** Publish-time schema-diff breaking-change gate (folds into W10's enforcement). `[BREADTH, P2, M]`
- **DOC-6** Build the typed replacements the parity specs already call for: per-channel Copilot-Studio config forms, a typed Spark-conf key/value grid, and a Graph-Model node/edge canvas — retiring three raw-JSON-textarea `no-freeform-config` violations. `[DOCS, P2, L]`

**Operator action:** Durable Functions app + task-hub storage (`LOOM_AGENTFLOW_ORCHESTRATOR`) for W9; DQ Cosmos container for W11.

---

## Wave 12 — Collaboration layer  *(Surface Wave C)*

Shared Web PubSub + Yjs foundation; honest-gated to single-editor fallback when `LOOM_WEBPUBSUB_ENDPOINT` is unset.

- **W5** Real-time co-authoring (live cursors/presence) — canvases **and** notebooks. `[SURF, P1, XL]`
- **W4** Canvas comments / sticky-note annotations. `[SURF, P1, M]`
- **W7** Ambient/inline Copilot ghost-node suggestions on canvas. `[SURF, P2, L]`
- **BR-COMMENTS** Threaded comments + @mentions on any item (shares W4's Cosmos + Graph @mention plumbing). `[BREADTH, P2, M]`
- **W22** Learning Hub interactive sandbox labs. `[SURF, P3, L]`

**Operator action:** `Microsoft.SignalRService/webPubSub` + UAMI Service Owner + `LOOM_WEBPUBSUB_ENDPOINT` (W5); Automation/Logic-App TTL teardown for W22 sandbox.

---

## Wave 13 — Health, media & batch AI services  *(Azure services P1/P2)*

- **SVC-3** Azure Health Data Services (real FHIR + DICOM + de-identification behind the Healthcare bundle; retires the vaporware Safe-Harbor claim + Power BI framing). `[SVC, P1, XL]`
- **SVC-4** Content Understanding (unified multimodal analyzer). `[SVC, P2, M]`
- **SVC-5** Azure Batch app wiring (pool/job/task navigator + `BatchExecute` activity). `[SVC, P2, M]`
- **SVC-6** Azure AI Video Indexer (media analytics → Delta). `[SVC, P2, M]`
- **SVC-7** Planetary Computer + Open Datasets shortcuts (reuse shortcut engine). `[SVC, P3, S]`
- **DBX-10** MLflow 3.x GenAI tracing + versioned Prompt Registry. `[DBX, P2, M]`

**Operator action:** `health-data-services.bicep` (metered FHIR workspace, default-off) for SVC-3; Video Indexer account for SVC-6.

---

## Wave 14 — Data Engineering & Data Factory depth  *(Fabric gap P2/P3)*

- **FGC-01** T-SQL Notebook (Spark-free, SQL-endpoint). `[FGC, P2, M]`
- **FGC-02** Python-only single-node Notebook (DuckDB/Polars, ACA kernel). `[FGC, P2, L]`
- **FGC-03** Materialized Lake Views — incremental + multi-schedule + cross-workspace lineage. `[FGC, P2, M]`
- **FGC-04** Semantic Model Refresh pipeline activity. `[FGC, P2, S]`
- **FGC-05** Airflow native Loom-item operators. `[FGC, P2, L]`
- **FGC-08** Spark consumption/autoscale billing + max-spend cap. `[FGC, P2, L]`
- **FGC-11** Developer tooling — `loom-cli` + VS Code extension. `[FGC, P2, XL]`
- **FGC-31** Workspace create wizard (multi-step) + settings flyout. `[FGC, P2, M]`

**Operator action:** Cost Management Reader for the Spark spend cap (FGC-08, shared with Wave 8).

---

## Wave 15 — Admin, FinOps & app lifecycle  *(P2/P3)*

- **FGC-26** Capacity overage toggle. `[FGC, P2, S]`
- **FGC-27** Capacity health + timepoint summary/detail. `[FGC, P2, M]`
- **FGC-29** Copilot capacity (AOAI) designation + isolated spend. `[FGC, P3, S]`
- **W14** FinOps what-if capacity/cost simulator (Retail Prices API). `[SURF, P2, M]`
- **W15** Use-case app clone/fork (re-run with new params). `[SURF, P2, M]`
- **W16** Use-case app version-upgrade path. `[SURF, P3, M]`
- **W13** Incident / Runbook item (Azure Monitor-tied). `[SURF, P2, M]`
- **W17** Report designer mobile/phone layout view. `[SURF, P3, M]`

**Operator action:** W13 wires an action-group webhook → Function + Automation account reference.

---

## Wave 16 — Databricks tail + developer platform  *(P2/P3 + breadth)*

The API-surface build-out (all riding BR-PAT from Wave 6).

- **DBX-8** Clean Rooms create + task CRUD. `[DBX, P2, M]`
- **DBX-12** Lakeflow Connect sink = Databricks UC managed table. `[DBX, P3, M]`
- **DBX-13** Catalog Federation (honest-gate until GA REST stabilizes). `[DBX, P3, M]`
- **DBX-14** Feature Store + Online Tables (Cosmos online store). `[DBX, P3, L]`
- **BR-OPENAPI** Versioned OpenAPI 3.1 surface + generated TS/Python SDKs (`/developer/api-docs`, APIM product). `[BREADTH, P1, L]`
- **BR-TERRAFORM** `terraform-provider-loom` (Go, terraform-plugin-framework). `[BREADTH, P2, L]`
- **BR-SCIM** SCIM 2.0 provisioning endpoint (`/scim/v2/Users|Groups`, PAT-auth). `[BREADTH, P2, M]`

**Operator action:** (opt-in) APIM product fronting for BR-OPENAPI; Terraform Registry publish for BR-TERRAFORM.

---

## Wave 17 — Reliability, DR & remaining Fabric/service tail  *(P3)*

- **FGC-06** Dataflow Gen2 Fast Copy path. `[FGC, P3, M]`
- **FGC-07** OneLake cross-workspace security-role management. `[FGC, P3, M]`
- **FGC-09** Native Execution Engine honest-gate + Photon opt-in. `[FGC, P3, S]`
- **FGC-10** High-concurrency Spark session pooling. `[FGC, P3, L]`
- **FGC-23** Mirrored-database native CDC copy-job. `[FGC, P3, M]`
- **SVC-9** Azure Confidential Ledger (tamper-evident audit receipts). `[SVC, P3, M]`
- **SVC-10** Microsoft Graph Data Connect (bulk M365 org analytics). `[SVC, P3, L]`
- **SVC-11** Chaos Studio reliability panel. `[SVC, P3, M]`

**Operator action:** Confidential Ledger deploy (SVC-9); Chaos Studio targets (SVC-11); GDC app consent + M365 E5/GDC add-on (SVC-10).

---

## Wave 18 — Net-new breadth tail: data movement & platform resilience  *(P1/P2 leapfrog)*

Highest-value breadth findings not owned by any PRP item.

- **BR-REVERSEETL** Reverse-ETL / operational activation (`reverse-etl-flow` item → Azure SQL/Cosmos/Dataverse/Salesforce). `[BREADTH, P1, L]`
- **BR-DBT** dbt Core integration (`dbt-project` item, ACA runner, manifest DAG viewer). `[BREADTH, P1, L]`
- **BR-DQANOMALY** Statistical/ML DQ anomaly detection (ADX `series_decompose_anomalies`). `[BREADTH, P1, M]`
- **BR-CONTROLPLANE-DR** Loom control-plane multi-region active-passive (Cosmos multi-write + secondary ACA behind Front Door + RTO/RPO runbook). `[BREADTH, P1, L]`
- **BR-AIDOCS** AI-generated data documentation (table/column descriptions, lineage-aware change summaries). `[BREADTH, P2, M]`
- **BR-ICEBERG-WRITE** Apache Iceberg first-class writable table format (OSS Iceberg REST catalog on ACA). `[BREADTH, P2, L]`
- **BR-AMBIENT-FEED** Ambient/proactive AI insight feed on the home surface. `[BREADTH, P2, M]`
- **BR-BLUEGREEN** Blue-green / canary release for the Console's own ACA image (traffic-split + health-gate). `[BREADTH, P2, M]`

*(Deferred as duplicates — already covered by PRP items: BR co-editing = W5; BR data-contracts = W10; BR CDC connector catalog partially = FGC-14/15/23 + tracked as a follow-on XL if breadth beyond SQL-family is needed.)*

**Operator action:** Cosmos multi-region write + secondary ACA environment behind Front Door (BR-CONTROLPLANE-DR); OSS Iceberg REST catalog Container App (BR-ICEBERG-WRITE).

---

## Totals

| PRP source | Items | Scheduled across |
|------------|-------|------------------|
| Fabric gap closure (FGC) | 31 | Waves 4,7,8,9,14,15,17 |
| AI Foundry integration (AIF) | 18 | Waves 3,4,5,7,9 |
| Azure service integrations (SVC) | 11 | Waves 4,13,17 |
| Databricks parity (DBX) | 14 | Waves 6,10,13,16 |
| Surface max-capability (W) | 22 | Waves 2,6,11,12,15 |
| Docs-drift (DOC) | 6 | Waves 1,11 |
| Breadth-critic net-new (BR) | ~14 scheduled (of 21; 7 dedup/deferred) | Waves 1,6,8,11,12,16,18 |
| **Total** | **~116 scheduled** | **18 waves** |

---

## Wave 1 — ready to build now

Exact work items with target files. All P0/P1, one agent per item, parallel-safe.

### DOC-1 — Power BI Premium: base prerequisite → opt-in  `[DOCS, P0, S]`
- `docs/fiab/deployment/commercial.md` (lines 4, 12, 63 — remove F8/$1,049 from base prereq + cost table)
- `docs/fiab/deployment/gcc.md` (line 25 — P1-SKU)
- `docs/fiab/deployment/gcc-high.md` (lines 37, 147 — F8)
- `docs/fiab/deployment/index.md` (lines 133, 157)
- `docs/fiab/index.md` (line 190 — LD-2 "Primary compute" → `Azure Databricks + Synapse Serverless + Azure Data Explorer + Azure Analysis Services (Power BI opt-in for Direct Lake parity)`)
- Move each into an explicit "Optional — only with `LOOM_SEMANTIC_MODEL_BACKEND=powerbi`" callout, matching `quickstart.md:22`.

### DOC-2 — publicNetworkAccess Disabled param + compliance-claim softening  `[DOCS, P0, M]`
- Add a `privateEndpointsEnabled`-gated `publicNetworkAccess` param (default `'Disabled'`) to: `platform/fiab/bicep/modules/landing-zone/eventgrid-business.bicep:46`, `platform/fiab/bicep/modules/deploy-planner/cognitive-account.bicep:59`, and the deploy-planner set `{batch,data-factory,event-grid,ml-workspace,mysql,postgres,redis,service-bus,signalr,static-web-app,storage-queues}.bicep`, plus `admin-plane/{adx-cluster,airflow}.bicep` and `landing-zone/{databricks-scim-bootstrap,databricks-uc-bootstrap,postgres-weave}.bicep`.
- Soften the blanket claims to name hardened modules + carve out deploy-planner opt-in + documented no-data exceptions: `docs/compliance/cjis.md:142`, `docs/compliance/dod-il4-il5.md:189`, `docs/best-practices/security-compliance.md:573`.
- (`landing-zone/hub-console-dlz-env.bicep:129` is the documented justified exception — leave, keep its comment.)

### DOC-3 — finish rel-T77 Deploy-to-Azure button removal  `[DOCS, P1, S]`
- `docs/fiab/index.md:153` and `:192` (LD-4 → "Two-tier (azd CLI + `az deployment sub create`)")
- `docs/fiab/deployment/marketplace.md:7` and `:48`
- `docs/fiab/what-is-csa-loom.md:42` and `:45` (rewrite, or delete in favor of `docs/fiab/concepts/what-is-csa-loom.md` if a duplicate).

### DOC-4 — semantic-model-parity-spec rewrite  `[DOCS, P1, S]`
- `docs/fiab/semantic-model-parity-spec.md` (lines 70, 73, 74, 79) — rewrite the "Loom coverage"/gap section to describe the shipped AAS-native designer (TMSL builders in `apps/fiab-console/lib/azure/aas-client.ts`, `LOOM_AAS_XMLA_ENDPOINT`) as default; demote Power BI/XMLA to the opt-in Direct-Lake-Shim path.

### DOC-5 — disaster-recovery honesty + opt-in DR tier  `[DOCS, P1, M]`
- `docs/best-practices/disaster-recovery.md` (lines 32–481) — label as generic guidance for the older `deploy/bicep/` reference architecture; add a CSA-Loom-specific DR page cross-link stating the current gap.
- `platform/fiab/bicep/modules/landing-zone/storage.bicep:52` — parameterize `sku.name` (default `Standard_ZRS`) to allow `Standard_GZRS`/`Standard_GRS` for an opt-in DR-tier deploy.

### BR-SIEM — continuous SIEM-exportable audit stream  `[BREADTH, P1, S]`
- Emit every admin-plane mutation (role change, RBAC grant, deploy, teardown) as a structured event to the existing Log Analytics workspace via a Data Collection Rule → `LoomAudit_CL` custom table; ship Sentinel analytics-rule template + starter KQL.
- Anchor: `apps/fiab-console/lib/admin/self-audit.ts` (existing `LOOM_LOG_ANALYTICS_WORKSPACE_ID` hint at :129) + a new emitter in the admin-plane mutation paths + the DCR/table bicep in `platform/fiab/bicep/modules/admin-plane/`.

**Wave 1 operator action:** redeploy the DOC-2 bicep modules with the new param; provision the DCR/`LoomAudit_CL` table (BR-SIEM). Everything else is docs-only and ships in one PR set.

---

## Addendum (2026-07-08, post-plan): Copilot-AI G1–G6 verified remainders

`copilot-ai-G1-G6-verification.md` (this folder) re-verified the fabric-parity appendix's six Copilot/AI gaps against current code. Slot these alongside the AIF items (same subsystem, several share plumbing with AIF-4/5/6):

- **G1** Copilot builders on 7 remaining surfaces (eventstream, stream-analytics, lakehouse, materialized-lake-view, mirrored-database, ml-experiment/automl, graph) + extract a shared `<CopilotBuilderPane>` primitive `[COPILOT, P1, L]` — 3 proven templates exist (kql-database, kql-dashboard, semantic-model).
- **G2** AI-Functions-at-scale remainders: "Add AI column" on Synapse warehouse/lakehouse grids, T-SQL surface, Dataflow AI step, notebook pkg 5→9 sync, multimodal `[AI-FN, P1, L]` — pairs with SVC-1 (pipeline AI activities).
- **G3** Operations Agent re-architecture to Azure Monitor scheduled-query + Logic App/Teams rule canvas `[OPS, P1, L]` — current item deploys a conversational Foundry agent instead.
- **G4** Data Wrangler AI tab `[WRANGLER, P2, L]` — depends on G2's table-batch endpoint.
- **G5** Prep-for-AI / Verified Answers on semantic-model `[SEMANTIC, P1, L]` — 0% built; four code comments currently punt to real Power BI (violation-adjacent).
- **G6** Agentic publish depth (description_for_model, deliver-as-is, connected-agent, auth mode) `[AGENTS, P2, M]`.

Recommended slotting: G5+G1 with the AIF multi-agent waves (3–6); G2 with SVC-1's wave; G3 standalone; G4/G6 in the P2 tail.

---

## Addendum (2026-07-08, post-plan): Copilot transparency, skills library & long-term memory (CTS-01…17)

`PRP-copilot-transparency-skills-memory.md` (this folder) ports the ATLAS-class chat UX onto Loom's
Azure-native stack (Cosmos + Azure AI Search vectors — never Mongo/Qdrant/Neo4j). 17 items across five
scope areas: per-message transparency/grounding, the segmented context-window meter, a skills library with
per-skill toggles, a long-term memory brain, and MCP-in-chat visibility. Die-hard posture: **default-ON,
opt-out — no enablement gate.** Slot alongside the AIF waves (shared Copilot/agent subsystem):

- **Ships immediately — pair with the MCP default-ON flip (Wave 6 companion PR):**
  - **CTS-09** MCP visibility in chat ("MCP this conversation" panel + per-call "via &lt;server&gt;" badge). `[CTS, P1, M]`
- **Wave 5 (multi-agent spine — transparency rides the agent work):**
  - **CTS-01** Per-message transparency status bar (model/tokens-in-out/cost-via-rel-T85/latency/tool-count). `[CTS, P1, M]`
  - **CTS-02** Per-message collapsible detail badge (per-tool status, routing, delegation, parallelism). `[CTS, P1, M]`
  - **CTS-04** Sources/grounding attribution on the cross-item orchestrator (docs/schema/memory citations). `[CTS, P1, M]`
  - **CTS-05** Context-expander graphic (segmented window breakdown + pure invariant-tested segment-sum). `[CTS, P1, L]`
- **Wave 6 (skills + app-runtime — skills library lands with the AIF skills work):**
  - **CTS-07** Skills library + management (registry, custom builder, per-skill tenant-default-ON/user-opt-out). `[CTS, P1, XL]`
  - **CTS-03** Admin-only deep debug/trace panel (Flow/JSON/Routing/Tools/Knowledge/Timeline). `[CTS, P2, L]`
  - **CTS-10** Extend transparency + context meter to every AI surface (scoped per-pane assists). `[CTS, P2, M]`
- **New dedicated "Memory & Brain" wave (slot as Wave 6.5, between Waves 6 and 7 — memory is its own item, from-scratch on Cosmos + AI Search):**
  - **CTS-08** Long-term memory / brain (user + workspace scope, L0–L3 layered recall, admin visibility/purge). **Foundation.** `[CTS, P1, XL]`
  - **CTS-12** Memory-write security guard (4-layer: injection scan + classifier + secret redaction + locked-field gate + audit). **Gov-critical hard dependency of CTS-08.** `[CTS, P2, L]`
  - **CTS-06** "Dump conversation to long-term memory" action (pre-compaction extraction; manual override of auto-flush). `[CTS, P1, M]`
  - **CTS-13** Nightly memory consolidation pass (REM-analog, Cosmos-native; dedupe/contradiction/topic-promotion). `[CTS, P3, L]`
- **P2/P3 tail — fold into existing depth/tail waves (dedupe notes):**
  - **CTS-14** Copilot replay → eval-suite harness. → **Wave 7**, alongside **AIF-13** AgentOps (shared trace store + redactor). `[CTS, P2, M]`
  - **CTS-15** Proactive / ambient context injection. → **Wave 18**, feeds **BR-AMBIENT-FEED**. `[CTS, P2, M]`
  - **CTS-16** Per-provider circuit breaker + learned model routing. → **Wave 9**, deepens **AIF-12** Model Router. `[CTS, P3, M]`
  - **CTS-11** Skills self-evolution (auto-learn + guided synthesis). → **Wave 9** tail, rides CTS-07. `[CTS, P3, L]`
  - **CTS-17** AI spend burn-rate projection + budget alert. → **Wave 15**, slices into **W14** FinOps / **FGC-28** chargeback. `[CTS, P3, S]`

**Operator actions (new):** new Cosmos containers (`copilot-skills`, `copilot-skill-states`,
`copilot-memory`, `copilot-memory-flush-log`, `copilot-memory-write-audit`, `copilot-memory-contradictions`,
`copilot-topic-pages`, `copilot-routing-stats`) — all via `createIfNotExists`, no new resource type; an
Azure AI Search **vector index** (`copilot-memory-vec`) provisioned by the existing `loom-docs-index`
bootstrap (honest-gates to a Cosmos keyword fallback if absent); and an ACA Job / Function timer for the
CTS-13 nightly consolidation pass. The MCP default-ON flip (CTS-09's companion) is tracked separately.

**Portable-extras triage.** Of ATLAS's 11 portable extras: 8 KEEP (→ CTS-11…17, with household-scope folded
into CTS-08 and parallelism telemetry folded into CTS-02), 1 DROP (talking-head avatar / real-time voice —
not relevant to an enterprise analytics console). Full table in the PRP.

---

## Addendum (2026-07-08, post-plan): Data Product — ultimate experience (DP-1…DP-17)

`PRP-data-product-ultimate.md` (this folder) audited the four poorly-reconciled "data product" surfaces +
two look-alike sibling item types and specs a 17-item program to (a) **fix the model** (one canonical
status vocabulary, projection parity, taxonomy cleanup, the 3 freeform violations), (b) build the
operator-asked **guided wizard**, **certification state machine**, **walkthroughs + Copilot builder**, and
(c) close the **mesh-class gaps** (ports, versioning+deprecation, subscription fulfillment, feedback,
sample-data, SLO monitoring, value metrics, governed↔infra linkage, shareable end-state). Tag legend adds
source `DP`.

**Dedupe — DP items that RIDE existing plan items (reference, do not rebuild):**
- **DP-9** breaking-change gate at publish → rides **W10** (Data Contract item) + **BR-CONTRACT-GATE**
  (Wave 11); DP-9 adds only the data-product version-history + deprecation glue.
- **DP-5** certification DQ-score check → consumes **W11** (DQ Rule Engine, Wave 11) + the shipped
  `ContractQualityRunPanel`.
- **DP-16** external sharing → rides **FGC-30** (cross-tenant B2B + scoped ADLS grant, Wave 8) + the shipped
  bidirectional **Delta Sharing** (PR #1578); surfaces a "Share externally" action, not a new engine.
- **DP-11** feedback/usage analytics → reuses **W18** (marketplace listing analytics + subscriber webhooks,
  Wave 6) + **BR-WEBHOOK** + **BR-COMMENTS/W4** comment plumbing.
- **DP-14** cost/value → reuses **FGC-28** chargeback + **BR-COSTATTR** (Wave 8).

**Dependency ordering (governs the slotting):** DP-1 (model unification) is the keystone — DP-3/DP-5/DP-8/
DP-16 all assume it, so it lands with the earliest DP work. DP-9 must follow W10/BR-CONTRACT-GATE (Wave 11);
DP-10/DP-16 follow FGC-30 (Wave 8); DP-11 follows W18 (Wave 6) — all of which precede the two new waves below.

**Recommended slotting:**

- **Fold the 3 P0 correctness/foundation items into the existing Wave 11** (governance/quality/contract —
  same subsystem as W10 Data Contract + W11 DQ Engine + DOC-6): **DP-1** (unify the data-product model),
  **DP-2** (item-type taxonomy cleanup), **DP-17** (fix the 3 freeform violations). These are P0 model-truth
  fixes that must precede any depth build and share the Wave-11 subsystem.
- **New Wave 19 — Data Product guided creation & certification** *(P0/P1 marquee; after Wave 11)*:
  **DP-3** guided creation wizard `[DP, P0, XL]` · **DP-5** certification pipeline `[DP, P0, XL]` ·
  **DP-4** template gallery + instance provenance `[DP, P1, L]` · **DP-6** walkthroughs + LearnPopovers
  `[DP, P1, M]` · **DP-7** Copilot data-product builder `[DP, P1, L]` · **DP-8** input/output/management
  ports `[DP, P1, L]`. (6 items.) *Operator action:* none new (reuses AOAI/ADX/Cosmos/Graph).
- **New Wave 20 — Data Product mesh-class depth & shareable end-state** *(P1/P2; after Waves 8, 11, 19)*:
  **DP-9** versioning + deprecation `[DP, P1, L]` (rides W10/BR-CONTRACT-GATE) · **DP-10** subscription
  approval + automated fulfillment `[DP, P1, L]` · **DP-16** editable/consumable/shareable end state
  `[DP, P1, M]` (rides FGC-30 + PR #1578) · **DP-11** consumer feedback/ratings/usage `[DP, P2, M]` (rides
  W18) · **DP-12** sample data + starter notebook `[DP, P2, M]` · **DP-13** live SLO monitoring `[DP, P2, M]` ·
  **DP-14** value metrics (OKRs+CDEs+cost) `[DP, P2, M]` · **DP-15** governed↔infra cross-linking `[DP, P2, L]`.
  (8 items.) *Operator action:* Console UAMI **User Access Administrator** (or scoped custom role) on the
  data-plane RG for DP-10 automated fulfillment (default-off, honest-gated); Azure Monitor scheduled-query
  alert rule for DP-13 (reuses the RTI Activator substitute); Cosmos containers via `createIfNotExists` for
  DP-11/DP-12 (no new resource type).

This raises the plan to **20 waves** (18 existing + 2 new) and **~133 scheduled items** (~116 + 17 DP), with
3 DP items folded into Wave 11 and 14 across the two new waves.

---

## Addendum (2026-07-08, live-found bug): Lineage garbage collection on delete (LIN-GC)

**Live repro:** after the 07-08 purge of 160 UAT workspaces (+435 items), the Analyze → Lineage surfaces
still render those items and their lineage. Root cause: item/workspace delete paths (per-item DELETE,
workspace cascade, `POST /api/workspaces/bulk-delete`) remove the Cosmos doc + `deleteLoomDoc` search doc
but never clean the **metadata plane** — the Purview Data Map entities (registered at provision/scan time)
and any Loom-native Weave lineage edges keep serving lineage for dead assets
(`app/api/catalog/lineage/route.ts` federates Purview Atlas / UC / OneLake, so deleted-in-Loom ≠ deleted-in-lineage).

- **LIN-GC-1** Delete-time metadata cleanup: extend the shared item/workspace delete + bulk-delete cascade to
  best-effort delete the matching Purview entity (Atlas by qualifiedName/guid via `purview-client`) and any
  Weave/edge-graph edges referencing the item; fire-and-forget with outcome recorded, never blocks the delete. `[CATALOG, P1, M]`
- **LIN-GC-2** Orphan reconciliation sweep: an admin-triggerable (and scheduled) job that diffs Purview entities
  tagged as Loom-provisioned against live Cosmos items and flags/purges orphans — this also performs the
  **one-time cleanup of the debris already live** from the 07-08 purge. Admin UI: a "Reconcile lineage" action
  on the Lineage/Catalog admin surface with a dry-run preview list before purge. `[CATALOG, P1, M]`
- **LIN-GC-3** Lineage views render-side guard: nodes whose Loom item 404s get a "deleted" badge/ghost style
  instead of appearing alive (defense-in-depth while GC propagates). `[CATALOG, P2, S]`

**Slot:** ride Wave 2's W8 (impact analysis) plumbing — same lineage clients + shared delete choke points.

### Status — DELIVERED (feat/lin-gc-lineage-cleanup)

- **LIN-GC-1 ✅** New `lib/azure/lineage-gc.ts` (`cleanupItemMetadata` / `cleanupWorkspaceMetadata`)
  composes the existing `offboardFromPurview` (Atlas soft-delete by the `loom://<tenant>/<ws>/<type>/<id>`
  qualifiedName + scan-source retire) and `reconcileThreadEdgesOnDelete` (hard-remove Weave/Thread edges).
  Fire-and-forget with a per-item outcome; wired into the three shared choke points that previously only
  cleaned Cosmos + loom-search: the per-item DELETE (`app/api/workspaces/[id]/items/[itemId]`), the
  workspace cascade DELETE (`app/api/workspaces/[id]`), and `POST /api/workspaces/bulk-delete`.
- **LIN-GC-2 ✅** `POST /api/admin/lineage/reconcile` (isTenantAdmin-gated, `{dryRun}` default true):
  `findLineageOrphans` lists Loom-provisioned Purview entities (`loom://` scheme) and diffs against live
  Cosmos items; `purgeLineageOrphans` deletes the orphans (best-effort, per-entity outcome). Admin UI:
  "Reconcile lineage" action on `/governance/lineage` (dry-run preview table → explicit purge confirm).
  Running it non-dry-run post-deploy performs the one-time cleanup of the 07-08 debris.
- **LIN-GC-3 ✅** `annotateDeletedLoomNodes` flags `loom://` lineage nodes whose item is gone; the shared
  `LineageCanvas` (and legacy SVG `LineageGraph`) render them as a dashed, muted "Deleted"-badged ghost with
  the open-item link suppressed. Wired into both `/api/catalog/lineage` and `/api/catalog/lineage/item`.
