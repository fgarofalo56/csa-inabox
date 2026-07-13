# CSA Loom — Full-Picture Architecture

This page is the single "whole system on one screen" reference for CSA Loom:
the console + BFF, every Azure backend it drives, the sibling backend services,
the identity/auth flows, the Commercial + Government deployment topology, and
the medallion data flow with the Weave edge graph on top.

Every box below is grounded in the actual code or bicep in this repo (paths in
the [component index](#component-index) at the bottom). Verified against `main`
2026-07-12 (includes the warm-pool synchronous-reconcile fix, PR #1947; the
G2 AI-functions-at-scale batch surface, PR #1946; and the linguistic-schema
grounding wiring, PR #1948). For focused views see
[Architecture Diagrams](diagrams/README.md),
[Complete Diagram Set](architecture-diagrams.md) (item provisioning, governance
mesh, Weave → Power BI, compute topology, notebook execution, realtime/streaming),
[Reference Architecture](architecture.md),
[Model Strategy](model-strategy.md),
[Compute Tiers & Telemetry](compute-tiers-and-telemetry.md), and
[Service exercise — validate every backend](operations/service-exercise.md).

---

## 1. Full system — console, BFF, backends, sibling services

The console is a Next.js App Router app (`apps/fiab-console`) whose `app/api/*`
routes form the BFF: every editor control calls a BFF route, which validates the
session, resolves the item via the typed **item-type manifest registry**
(`lib/items/manifest/`), and calls a real Azure data-plane / ARM client in
`lib/azure/*`. Fabric / Power BI is opt-in only — the default backend for every
item type is Azure-native (per `.claude/rules/no-fabric-dependency.md`).

```mermaid
flowchart TB
    subgraph edge["Edge"]
        FD["Azure Front Door<br/>csa-loom.<your-domain> (Comm)<br/>csaloom-gov.<your-domain> (Gov)"]
    end

    subgraph console["Console — apps/fiab-console (Container App)"]
        UI["Editors + canvases + admin<br/>Fluent v9 + Loom tokens"]
        BFF["BFF app/api/* routes<br/>session validate + structured JSON"]
        MAN["Item-type manifest registry<br/>lib/items/manifest/"]
        TR["AIF-12 model tier router<br/>lib/foundry/model-tier-router.ts"]
        UI --> BFF --> MAN
        BFF --> TR
    end

    subgraph siblings["Sibling backend services (apps/*, Container Apps / Jobs)"]
        ACT["fiab-activator-engine<br/>ADX rule poller + actions"]
        MIR["fiab-mirroring-engine<br/>CDC mirroring runtime"]
        DLS["fiab-direct-lake-shim<br/>TOM warm-cache refresh"]
        DLQ["loom-directlake<br/>columnar cache/scan service"]
        OLK["loom-onelake<br/>unified-namespace catalog"]
        UCS["loom-unity<br/>OSS Unity Catalog (Gov)"]
        CAP["loom-capacity-broker<br/>compute admission control"]
        ORC["fiab-setup-orchestrator<br/>deploy backend for Setup Wizard"]
        MCP["fiab-mcp-bridge + fiab-mcp-config<br/>MCP server catalog + stdio bridge"]
        CPL["copilot + copilot-maf<br/>RAG QA + MAF agent tier"]
        AUX["fiab-dbt-runner · fiab-wrangler-host<br/>fiab-report-subscriptions · fiab-label-propagation"]
    end

    subgraph data["Azure data + analytics backends"]
        SYN["Synapse<br/>serverless SQL + dedicated pools<br/>Spark: loompool / loometl / loombatch"]
        ADX["Azure Data Explorer<br/>Eventhouse / KQL DB / RTI"]
        ADLS["ADLS Gen2 + Delta<br/>Bronze / Silver / Gold"]
        DBX["Azure Databricks + Unity Catalog<br/>instance pools + Loom cluster policy"]
        ADF["Azure Data Factory<br/>pipelines + managed VNet IR"]
        EH["Azure Event Hubs<br/>eventstream backbone"]
        AAS["Azure Analysis Services<br/>tabular semantic layer"]
    end

    subgraph platform["Platform + AI backends"]
        COS["Cosmos DB<br/>items, workspaces, config,<br/>refresh policies, schedules"]
        PUR["Purview classic Data Map<br/>scan / classify / glossary"]
        AOAI["AOAI / AI Foundry<br/>GPT-5.x + embeddings<br/>via APIM AI-gateway (opt-in)"]
        SRCH["Azure AI Search<br/>RAG corpus"]
        MON["Azure Monitor + Log Analytics<br/>Spark telemetry, alerts, chargeback"]
        PBI["Power BI service (OPT-IN)<br/>via VM data gateway"]
    end

    FD --> UI
    BFF --> siblings
    BFF --> data
    BFF --> platform
    ACT --> ADX
    ACT --> MON
    MIR --> ADLS
    DLS --> AAS
    DLQ --> ADLS
    OLK --> ADLS
    UCS --> DBX
    CPL --> AOAI
    CPL --> SRCH
    SYN --> ADLS
    DBX --> ADLS
    ADF --> ADLS
    EH --> ADX
    AAS --> SYN
    TR --> AOAI
    PBI -.->|"opt-in only<br/>never on the default path"| BFF

    classDef edgeC fill:#5C2D91,stroke:#fff,color:#fff,stroke-width:2px
    classDef consoleC fill:#0078D4,stroke:#fff,color:#fff,stroke-width:2px
    classDef sibC fill:#038387,stroke:#fff,color:#fff,stroke-width:2px
    classDef dataC fill:#107C10,stroke:#fff,color:#fff,stroke-width:2px
    classDef platC fill:#D83B01,stroke:#fff,color:#fff,stroke-width:2px
    classDef optC fill:#69797E,stroke:#fff,color:#fff,stroke-width:2px,stroke-dasharray:6 4
    class FD edgeC
    class UI,BFF,MAN,TR consoleC
    class ACT,MIR,DLS,DLQ,OLK,UCS,CAP,ORC,MCP,CPL,AUX sibC
    class SYN,ADX,ADLS,DBX,ADF,EH,AAS dataC
    class COS,PUR,AOAI,SRCH,MON platC
    class PBI optC
```

Key reading of this diagram:

- **Every editor control terminates in a real backend call** (`no-vaporware.md`)
  — the BFF's `lib/azure/*` clients speak Azure REST, ARM, TDS/SQL, Kusto,
  Livy, and Databricks/UC REST directly.
- **The manifest registry** (`lib/items/manifest/item-manifest.ts` +
  `registry.ts`) is the typed source of truth for what each item type is, which
  backend serves it, and which routes/editors bind to it.
- **The AIF-12 tier router** resolves the best supported model per task per
  cloud at request time (day-one populated at deploy; see
  [Model Strategy](model-strategy.md)); AOAI traffic optionally flows through
  the **APIM AI-gateway** with automatic direct-with-managed-identity fallback
  where APIM LLM policies are unsupported (Gov).
- **Power BI is strictly opt-in** — dashed in the diagram because no default
  code path reaches `api.powerbi.com`.

---

## 2. Identity and auth flows

Four distinct identities move through the system: the signed-in user (MSAL),
the user's delegated token (OBO) for per-user data-plane access, the Console's
UAMI for platform calls, and the internal token that authenticates
console-to-sibling-service calls.

```mermaid
flowchart LR
    subgraph user["User plane"]
        U["Browser user"]
        AAD["Microsoft Entra ID<br/>(MSAL auth-code flow)"]
        SESS["Encrypted session cookie<br/>AES-256-GCM + sliding refresh<br/>lib/auth/session.ts"]
    end

    subgraph consoleId["Console identities"]
        BFF2["BFF route<br/>getSession / workspace-guard"]
        OBO["OBO token exchange<br/>lib/auth/obo.ts<br/>per-user data-plane access"]
        UAMI["Console UAMI<br/>AcaManagedIdentityCredential<br/>platform + ARM calls"]
        INT["LOOM_INTERNAL_TOKEN<br/>lib/auth/internal-token.ts<br/>KV-random secret"]
    end

    subgraph targets["Targets"]
        DP["User-scoped data plane<br/>Synapse SQL · ADLS · ADX<br/>(caller's own RBAC)"]
        PLAT["Platform plane<br/>ARM · Cosmos · Purview ·<br/>AOAI · Monitor (UAMI RBAC)"]
        SIB["Sibling services + cron<br/>/api/internal/* (blocked at<br/>Front Door, internal-token gated)"]
    end

    U -->|"1 sign-in"| AAD
    AAD -->|"2 id + access tokens"| SESS
    SESS -->|"3 every request"| BFF2
    BFF2 -->|"per-user path"| OBO --> DP
    BFF2 -->|"platform path"| UAMI --> PLAT
    BFF2 -->|"service-to-service"| INT --> SIB

    classDef userC fill:#5C2D91,stroke:#fff,color:#fff,stroke-width:2px
    classDef idC fill:#0078D4,stroke:#fff,color:#fff,stroke-width:2px
    classDef tgtC fill:#107C10,stroke:#fff,color:#fff,stroke-width:2px
    class U,AAD,SESS userC
    class BFF2,OBO,UAMI,INT idC
    class DP,PLAT,SIB tgtC
```

Flow notes:

- **MSAL user sign-in** (`lib/auth/msal.ts` + `authflow.ts`) mints the
  AES-256-GCM session cookie; `use-session-keepalive.ts` slides expiry.
- **OBO (on-behalf-of)** — shipped as EH-P1-OBO (#1922): BFF routes that touch
  user-attributable data exchange the session's access token for a data-plane
  token so Synapse SQL / ADLS / ADX see the **caller's own identity and RBAC**,
  not the platform identity.
- **Console UAMI** — all platform/ARM calls ride the Container App's
  user-assigned managed identity via the custom `AcaManagedIdentityCredential`
  (the stock `@azure/identity` ACA MSI path is broken; see
  `lib/azure/aca-managed-identity-credential`-adjacent clients).
- **Internal token** — sibling services and the 5-minute Spark keep-warm cron
  (`/api/internal/spark/keep-warm`, #1932) authenticate with
  `LOOM_INTERNAL_TOKEN`, derived from a Key-Vault-random secret; `/api/internal/*`
  is blocked at Front Door so it is reachable only in-VNet.
- **Authorization layers on top:** `workspace-guard.ts` / `item-access.ts`
  (ownership + tenant partition), `domain-role.ts` (domain roles), and the PDP
  engine (`lib/auth/pdp/`) for label-protection policies and OneLake-style
  security roles.

---

## 3. Deployment topology — Commercial + Government

One subscription-scope bicep entry point (`platform/fiab/bicep/main.bicep`)
deploys the hub (admin plane) and any number of data landing zones (DLZ) across
subscriptions. The same modules deploy Commercial and Gov; boundary-specific
endpoints, private-DNS zones, and model availability are parameterized.

```mermaid
flowchart TB
    subgraph internet["Public edge"]
        AFD["Azure Front Door + WAF<br/>vanity: csa-loom.<your-domain><br/>Gov: csaloom-gov.<your-domain>"]
    end

    subgraph hub["Hub subscription — admin plane (modules/admin-plane)"]
        VNET["Hub VNet + Private DNS zones<br/>(boundary-branched Comm/Gov)"]
        ACAE["Container Apps Environment<br/>(container-platform.bicep)"]
        APPS["loom-console + sibling apps<br/>(app-deployments.bicep)"]
        ACR["ACR (PE-locked;<br/>az acr build server-side)"]
        KV["Key Vault (PE-locked)"]
        RUN["gh-aca-runner — ACA Job<br/>KEDA scale-to-zero in-VNet runner<br/>(loom-ui-verify, spark probes)"]
        VPN["P2S VPN gateway<br/>(AAD / OpenVPN, admin access)"]
        AIH["AOAI / Foundry · AI Search ·<br/>APIM AI-gateway · AAS · Cosmos"]
    end

    subgraph dlz["DLZ subscription(s) — landing zone (modules/landing-zone)"]
        DVNET["DLZ VNet (peered) + PEs"]
        LAKE["ADLS Gen2 (Bronze/Silver/Gold)"]
        DSYN["Synapse ws + Spark pools<br/>loompool / loometl / loombatch<br/>(synapse-spark-pools.bicep)"]
        DDBX["Databricks ws + UC<br/>instance pools + cluster policy"]
        DADX["ADX cluster"]
        DINT["ADF + SHIR · Event Hubs ·<br/>Stream Analytics · Event Grid"]
    end

    subgraph ops["Deploy + verify + continuous-validation path"]
        BICEP["1 · az deployment sub create<br/>main.bicep (deployAppsEnabled=false)"]
        BUILD["2 · full-app-deploy workflow<br/>az acr build + roll Container Apps"]
        BOOT["3 · post-deploy bootstrap<br/>MSAL app reg + data-plane grants"]
        VERIFY["loom-ui-verify (in-VNet browser<br/>verification on gh-aca-runner)"]
        EXER["csa-loom-exercise-services<br/>(daily 05:30 UTC, gh-aca-runner)<br/>real data-path probes: spark ·<br/>warehouse-sql · adx · adls · cosmos ·<br/>aoai · domain-sync · adf"]
        KEEPWARM["csa-loom-spark-keepwarm<br/>(5-min, public GH runner)<br/>POST /api/internal/spark/keep-warm"]
    end

    AFD --> ACAE
    VNET --- ACAE
    ACAE --> APPS
    APPS --> AIH
    VNET <-->|"peering + PEs"| DVNET
    APPS -->|"private endpoints"| LAKE
    APPS --> DSYN
    APPS --> DDBX
    APPS --> DADX
    APPS --> DINT
    VPN -.-> VNET
    RUN --- VNET
    RUN -.->|"hosts"| VERIFY
    RUN -.->|"hosts"| EXER
    BICEP --> BUILD --> BOOT --> VERIFY
    VERIFY --> EXER
    BUILD --> ACR
    ACR --> APPS
    KEEPWARM -.->|"HTTPS + internal token<br/>over Front Door"| AFD

    classDef edgeC fill:#5C2D91,stroke:#fff,color:#fff,stroke-width:2px
    classDef hubC fill:#0078D4,stroke:#fff,color:#fff,stroke-width:2px
    classDef dlzC fill:#107C10,stroke:#fff,color:#fff,stroke-width:2px
    classDef opsC fill:#D83B01,stroke:#fff,color:#fff,stroke-width:2px
    class AFD edgeC
    class VNET,ACAE,APPS,ACR,KV,RUN,VPN,AIH hubC
    class DVNET,LAKE,DSYN,DDBX,DADX,DINT dlzC
    class BICEP,BUILD,BOOT,VERIFY,EXER,KEEPWARM opsC
```

Topology notes:

- **All data-plane traffic is private** — every backend is PE-locked into the
  VNet plane; admin access is via the AAD/OpenVPN P2S gateway; CI that must see
  the private plane (UI verification, Spark probes, KV reads) runs on the
  **in-VNet `gh-aca-runner`** ACA Job (KEDA scale-to-zero).
- **Commercial and Gov are the same shape.** Gov (live at
  `csaloom-gov.<your-domain>`) swaps endpoints (`*.us`,
  `*.usgovcloudapi.net`), boundary-branched private-DNS zones, Gov MSAL, and
  Power BI Embedded A1 — and the deploy-time model resolution picks the best
  **supported** Gov model set with APIM-policy auto-fallback (see
  [Model Strategy](model-strategy.md)).
- **Compute tiers are deploy-time** (#1931): three workload-tiered Synapse Spark
  pools (`loompool` interactive, `loometl` pipeline ETL, `loombatch` heavy
  batch), Databricks instance pools (`loom-pool-s/m/l`) + a Loom cluster policy,
  baked best-practice Spark config (AQE, Kryo, Delta optimize-write/auto-compact)
  on every pool, and Spark → Log Analytics telemetry (`SparkLoggingEvent_CL` /
  `SparkMetrics_CL` / `SynapseBigDataPoolApplicationsEnded`) — details in
  [Compute Tiers & Telemetry](compute-tiers-and-telemetry.md).
- **The warm Spark session pool** (`lib/azure/spark-session-pool.ts`) keeps N
  idle Livy (or a warmed Databricks cluster) on standby per pool/kind/sizing
  group, so a notebook run gets an instant hand-off instead of the 2–4 min
  Synapse cold start — the same experience Fabric's starter pools give, built on
  the Azure-native default. Two external heartbeats compensate for serverless
  Container Apps recycling the pool to cold on every scale-to-zero / roll:
  `csa-loom-spark-keepwarm` (every 5 min, public runner, hits Front Door) tops
  the pool back up to `min`, and each tick now also calls the **synchronous
  `reconcileWarmingSlots()`** promotion (#1947) — a real Livy/Databricks
  liveness check run *inside* the request that promotes any `warming` slot
  whose backend session already reached `idle`/`RUNNING`. This closes the
  root cause of the "notebooks are stuck slow" reports: the pool's background
  `pollLivyToIdle` poll loop is fire-and-forget with a `setTimeout`, and a
  serverless replica is CPU-throttled to near-zero *between* requests, so that
  loop never advanced — the slot froze at `warming` forever and every tick kept
  reporting `warming:1 / warm:0`. A leaked-session reaper (#1796) separately
  self-cleans idle, untracked Livy sessions that would otherwise jam the pool
  (the *other* historical root cause — ~700 leaked sessions starving `loompool`).
  See [Compute Tiers & Telemetry](compute-tiers-and-telemetry.md) for the
  provisioning side and `apps/fiab-console/lib/azure/spark-session-pool.ts` for
  the pool engine itself.
- **Exercise-every-service validation** goes one level deeper than config-presence
  health checks: `lib/admin/service-probes.ts` runs a REAL, self-cleaning
  operation against each backend's actual data path (create-a-Livy-session +
  `spark.range(1).count()` + delete, `SELECT 1` over TDS, `print 1` KQL, a lake
  container list, a Cosmos query, a one-shot AOAI completion, a dry-run
  Purview/Unity-Catalog domain sync, an ADF pipeline list) and reports
  `pass` / honest-`gate` / `fail`. This is what catches a *configured-but-broken*
  backend — the motivating case was a faulted Synapse pool that was green on
  every presence check but errored every Livy session instantly. Exposed at
  `/admin/health` (tenant-admin, `POST`/`GET /api/admin/health/exercise`) and run
  daily by `csa-loom-exercise-services.yml` on the in-VNet `gh-aca-runner`,
  failing the job on any real `fail` (gates are warnings, never failures). Full
  writeup: [Service exercise — validate every backend](operations/service-exercise.md).

---

## 4. Data flow — medallion + the Weave edge graph

Data lands in Bronze, is refined to Silver/Gold on ADLS Delta, and is served
through four engines. On top of the item graph, **Weave** (thread actions)
gives every item one-click edges to downstream experiences — including
"Analyze in Power BI" from any PBI-sourceable item (W1–W6, #1902–#1913).

```mermaid
flowchart LR
    subgraph sources["Sources"]
        SRC["Operational stores<br/>Azure SQL · Cosmos · SaaS ·<br/>files · streams"]
    end

    subgraph ingest["Ingest"]
        MIR2["Mirroring engine<br/>CDC → Bronze Delta"]
        CPY["ADF / Synapse pipelines<br/>Copy Job + watermark"]
        EH2["Event Hubs eventstream"]
    end

    subgraph medallion["ADLS Gen2 Delta — medallion"]
        BR["Bronze<br/>raw / CDC landing"]
        SV["Silver<br/>conformed"]
        GD["Gold<br/>curated / serving"]
    end

    subgraph serve["Serving engines"]
        SS["Synapse serverless SQL<br/>OPENROWSET over Delta"]
        DW["Warehouse<br/>dedicated SQL pool"]
        RTI["ADX / Eventhouse<br/>KQL + dashboards + Activator"]
        SEM["Semantic layer<br/>AAS tabular + Direct-Lake shim"]
    end

    subgraph weave["Weave edges (lib/thread/thread-actions.ts)"]
        W1["analyze-in-powerbi<br/>(Loom-native OR real PBI,<br/>VM gateway default-on)"]
        W2["build-loom-report /<br/>build-powerbi-model"]
        W3["publish-as-api<br/>(APIM)"]
        W4["mirror-to-lakehouse ·<br/>analyze-in-notebook ·<br/>add-data-agent-source"]
    end

    SRC --> MIR2 --> BR
    SRC --> CPY --> BR
    SRC --> EH2 --> RTI
    BR -->|"Spark loometl"| SV -->|"Spark loometl"| GD
    GD --> SS
    GD --> DW
    GD --> SEM
    RTI -->|"continuous export"| GD
    SS --> W1
    DW --> W1
    RTI --> W1
    SEM --> W2
    GD --> W3
    SS --> W4

    classDef srcC fill:#69797E,stroke:#fff,color:#fff,stroke-width:2px
    classDef ingC fill:#D83B01,stroke:#fff,color:#fff,stroke-width:2px
    classDef medC fill:#107C10,stroke:#fff,color:#fff,stroke-width:2px
    classDef srvC fill:#0078D4,stroke:#fff,color:#fff,stroke-width:2px
    classDef weaveC fill:#5C2D91,stroke:#fff,color:#fff,stroke-width:2px
    class SRC srcC
    class MIR2,CPY,EH2 ingC
    class BR,SV,GD medC
    class SS,DW,RTI,SEM srvC
    class W1,W2,W3,W4 weaveC
```

Data-flow notes:

- **Weave edges live in `THREAD_ACTIONS`** (`lib/thread/thread-actions.ts`),
  gated by `fromTypes`, with one BFF route per edge under `app/api/thread/*`
  (`analyze-in-powerbi`, `build-loom-report`, `build-powerbi-model`,
  `publish-as-api`, `mirror-to-lakehouse`, `analyze-in-notebook`,
  `mirror-to-notebook`, `add-data-agent-source`, `warehouse-tables`).
- **"Analyze in Power BI"** offers a per-click choice: Loom-native (default,
  zero Power BI dependency) or the real Power BI service when a workspace +
  capacity is bound — reached through the default-on **VM data gateway** that
  auto-upgrades to a VNet data gateway when a capacity is bound.
- **Report "Get data"** (`lib/editors/report/get-data-gallery.tsx`, #1927) is a
  Power-BI-style gallery: a "Use a Loom item" hero card is offered FIRST
  (resolves any PBI-sourceable item — lakehouse, warehouse, KQL database,
  dataset, semantic model, data product — straight to its Azure backend, no
  server/database typed), then the same 32-connector catalog the ADF/Synapse
  "New linked service" gallery uses, then Recent connections. OneLake/Fabric
  shortcuts and Power BI semantic models render in a clearly-demarcated,
  dashed **opt-in** group at the bottom — never required, never on the default
  path.
- **AI functions at scale** — the grid "Add AI column" action
  (`lib/editors/components/add-ai-column-dialog.tsx`, wired into the Delta
  preview grid and the Dataflow Gen2 AI step) and its batch endpoint
  `POST /api/ai-functions/table` (`lib/azure/ai-functions-client.ts`) apply one
  AI function — summarize, classify, translate, extract (incl. a multi-field
  structured-schema mode), fix-grammar, generate, embed, or similarity — across
  every row of up to 500 rows in one request, with a model-tier override
  (mini/standard/strong via the AIF-12 router) and a multimodal image/document
  input path honest-gated on `LOOM_AOAI_VISION_DEPLOYMENT`. Every call rides the
  same live AOAI deployment the cross-item Copilot resolves — no Fabric/Power BI
  dependency, no mock rows.
- **Governance rides the same graph:** domains (multi-library designer, #1924 —
  Federal Civilian, Defense & Intel, State & Local, Commercial libraries in
  `lib/domains/libraries/`) sync to **Unity Catalog catalogs with
  managed-location `storage_root`**, Purview collections, and the OneLake-style
  namespace (#1926/#1930) — Purview + UC + OneLake sync all green.

---

## Component index

| Component | Where in the repo |
|---|---|
| Console + BFF | `apps/fiab-console` (`app/api/*` routes, `lib/azure/*` clients) |
| Item-type manifest registry | `apps/fiab-console/lib/items/manifest/{item-manifest,registry}.ts` |
| Model tier router / availability matrix | `apps/fiab-console/lib/foundry/{model-tier-router,model-availability-matrix}.ts` |
| Session / MSAL / OBO / internal token | `apps/fiab-console/lib/auth/{session,msal,obo,internal-token}.ts` |
| PDP engine (protection policies, security roles) | `apps/fiab-console/lib/auth/pdp/` |
| Weave edges | `apps/fiab-console/lib/thread/thread-actions.ts` + `app/api/thread/*` |
| Warm Spark session pool | `apps/fiab-console/lib/azure/spark-session-pool.ts` (`reconcileWarmingSlots`, `acquireWarmSession`) |
| Spark keep-warm heartbeat | `apps/fiab-console/app/api/internal/spark/keep-warm` + `.github/workflows/csa-loom-spark-keepwarm.yml` |
| Exercise-every-service probes | `apps/fiab-console/lib/admin/service-probes.ts` + `app/api/admin/health/exercise` + `.github/workflows/csa-loom-exercise-services.yml` |
| AI functions at scale ("Add AI column") | `apps/fiab-console/lib/editors/components/add-ai-column-dialog.tsx` + `app/api/ai-functions/table/route.ts` + `lib/azure/ai-functions-client.ts` |
| Report "Get data" gallery | `apps/fiab-console/lib/editors/report/get-data-gallery.tsx` |
| Activator engine | `apps/fiab-activator-engine` (`AdxRulePoller.cs`) |
| Mirroring engine | `apps/fiab-mirroring-engine` |
| Direct Lake shim / cache-scan service | `apps/fiab-direct-lake-shim` · `apps/loom-directlake` |
| OneLake-equivalent namespace | `apps/loom-onelake` |
| OSS Unity Catalog (Gov) | `apps/loom-unity` |
| Capacity broker | `apps/loom-capacity-broker` |
| Setup orchestrator | `apps/fiab-setup-orchestrator` |
| MCP bridge + config | `apps/fiab-mcp-bridge` · `apps/fiab-mcp-config` |
| Copilot services | `apps/copilot` · `apps/copilot-maf` · `azure-functions/copilot-chat` |
| Domain libraries | `apps/fiab-console/lib/domains/libraries/` |
| Bicep entry + modules | `platform/fiab/bicep/main.bicep` + `modules/{admin-plane,landing-zone,compute,ai,integration,copilot,deploy-planner,shared}` |
| Spark pool tiers | `platform/fiab/bicep/modules/landing-zone/synapse-spark-pools.bicep` |
| Front Door / ACA / UDF / DAB / Airflow hosts | `platform/fiab/bicep/modules/admin-plane/{front-door,container-platform,udf-runtime,dab-runtime,airflow}.bicep` |
| In-VNet runner + UI verification | `.github/workflows/loom-ui-verify.yml` (runs on `gh-aca-runner`) |

## Related

- [Reference Architecture](architecture.md) — the narrative version
- [Complete Diagram Set](architecture-diagrams.md) — item provisioning, governance mesh, Weave → Power BI, compute topology, notebook execution, realtime/streaming
- [Architecture Diagrams](diagrams/README.md) — topology, deploy flows, RBAC
- [Model Strategy](model-strategy.md) — AIF-12 tiers, per-cloud model matrix
- [Compute Tiers & Telemetry](compute-tiers-and-telemetry.md) — pool tiers, Log Analytics
- [Service exercise — validate every backend](operations/service-exercise.md) — real data-path probes, daily CI gate
- [Parity Matrix](parity-matrix.md) · [UX Standards](ux-standards.md)
