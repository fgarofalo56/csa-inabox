# CSA Loom — Complete Diagram Set

This page extends [Full-Picture Architecture](architecture-full-picture.md) (system
topology, identity/auth, deployment, medallion data flow) and
[Architecture Diagrams](diagrams/README.md) (tenant topology, deploy flows, RBAC,
domain-to-catalog data flow) with six additional diagrams that were missing from
the diagram set: item provisioning, the governance/lineage mesh, Weave → Power BI,
the compute topology, notebook execution, and the realtime/streaming path.

Every diagram here is grounded in code that exists on `main` today — no
aspirational boxes. Paths are called out under each diagram; see the
[component index](#component-index) at the bottom for the full list.

---

## 1. Item-provisioning flow — Azure-native default, Fabric strictly opt-in

Every catalog item's "Create" action resolves through the typed provisioner
registry (`apps/fiab-console/lib/install/provisioners/*.ts`). Per
`.claude/rules/no-fabric-dependency.md`, each provisioner's **default** path is
a real Azure backend call; a Fabric backend only runs when the item explicitly
opts in via `LOOM_<ITEM>_BACKEND=fabric` **and** a bound workspace — and even
then, an unbound workspace on the opt-in path falls back to Azure-native rather
than gating.

```mermaid
flowchart TB
    UI["Catalog 'Create item' action<br/>(Console UI)"]
    BFF["Install BFF route<br/>app/api/items/install (or per-type route)"]
    REG["Provisioner registry<br/>lib/install/provisioners/*.ts"]

    UI --> BFF --> REG

    subgraph items["Per-item-type provisioners (Azure-native DEFAULT)"]
        direction TB
        LH["lakehouse.ts"]
        WH["warehouse.ts"]
        KDB["kql-db.ts"]
        ES["eventstream.ts"]
        ACT["activator.ts"]
        NB["notebook.ts"]
        KD["kql-dashboard.ts"]
        MDB["mirrored-database.ts"]
    end
    REG --> LH & WH & KDB & ES & ACT & NB & KD & MDB

    subgraph azureBackends["Azure-native backends (default, always available)"]
        direction TB
        ADLS["ADLS Gen2 + Delta<br/>(+ Synapse serverless OPENROWSET view)"]
        SYNDW["Synapse dedicated SQL pool<br/>(TDS DDL + dbt-model views)"]
        ADX["Azure Data Explorer<br/>(ARM PUT database + .create table)"]
        EH["Azure Event Hubs<br/>(+ Stream Analytics transform if configured)"]
        MON["Azure Monitor scheduledQueryRules<br/>+ action group"]
        LIVY["Synapse Livy notebook<br/>(or Databricks import)"]
        ADXDASH["Loom-native dashboard<br/>tiles query ADX live"]
        CDC["ADF/Synapse CDC copy<br/>→ Bronze Delta"]
    end
    LH --> ADLS
    WH --> SYNDW
    KDB --> ADX
    ES --> EH
    ACT --> MON
    NB --> LIVY
    KD --> ADXDASH
    MDB --> CDC

    subgraph fabricOptIn["Fabric — OPT-IN ONLY (LOOM_&lt;ITEM&gt;_BACKEND=fabric + bound workspace)"]
        direction TB
        FAB["api.fabric.microsoft.com/v1<br/>lakehouses / warehouses / kqlDatabases /<br/>eventstreams / notebooks / kqlDashboards"]
    end
    LH -.->|"opt-in only"| FAB
    WH -.->|"opt-in only<br/>(no Fabric warehouse path exists —<br/>Synapse dedicated is the ONLY backend)"| FAB
    KDB -.->|"opt-in only"| FAB
    ES -.->|"opt-in only"| FAB
    NB -.->|"opt-in only"| FAB
    KD -.->|"opt-in only"| FAB

    classDef uiC fill:#5C2D91,stroke:#fff,color:#fff,stroke-width:2px
    classDef regC fill:#0078D4,stroke:#fff,color:#fff,stroke-width:2px
    classDef itemC fill:#038387,stroke:#fff,color:#fff,stroke-width:2px
    classDef azC fill:#107C10,stroke:#fff,color:#fff,stroke-width:2px
    classDef optC fill:#69797E,stroke:#fff,color:#fff,stroke-width:2px,stroke-dasharray:6 4
    class UI uiC
    class BFF,REG regC
    class LH,WH,KDB,ES,ACT,NB,KD,MDB itemC
    class ADLS,SYNDW,ADX,EH,MON,LIVY,ADXDASH,CDC azC
    class FAB optC
```

Notes:

- **Warehouse has no Fabric backend at all** — `warehouse.ts` reads
  `LOOM_WAREHOUSE_BACKEND` (default `synapse-dedicated`) and only ever targets
  Synapse dedicated SQL pools via `synapse-sql-client.ts`; there is no
  `fabric` value to opt into for this item type.
- **Eventstream / KQL dashboard / notebook / activator** transparently fall
  back to Azure-native even when `LOOM_<ITEM>_BACKEND=fabric` is set but no
  workspace is bound — never a hard gate (`eventstream.ts`, `kql-dashboard.ts`,
  `notebook.ts`, `activator.ts`).
- **Honest gates, not Fabric gates**: when an Azure backend's own config is
  missing (`LOOM_KUSTO_CLUSTER_URI`, `LOOM_EVENTHUBS_NAMESPACE`,
  `LOOM_LOG_ANALYTICS_RESOURCE_ID`, …) the provisioner returns
  `status:'remediation'` naming the exact env var — never "bind a Fabric
  workspace" (`no-vaporware.md`).

---

## 2. Governance / lineage mesh — Purview + Unity Catalog + OneLake catalog

CSA Loom's domain hierarchy (the authoritative Cosmos `domains:<tenantId>` doc)
mirrors into two independent, Azure-native governance back ends. Loom is
authoritative and the sync is one-directional and additive — a remote-only
object is reported as drift and never deleted
(`apps/fiab-console/lib/azure/domain-sync.ts`).

```mermaid
flowchart TB
    DOM["Loom domain hierarchy<br/>(Cosmos domains:&lt;tenantId&gt;,<br/>lib/azure/domain-registry.ts)"]
    EDIT["Per-edit mirror<br/>lib/azure/unified-domain-mapper.ts<br/>(create/update/move/delete)"]
    SYNC["Whole-hierarchy reconciler<br/>lib/azure/domain-sync.ts<br/>(dry-run default; apply=true upserts)"]
    DOM --> EDIT
    DOM --> SYNC

    subgraph purview["Microsoft Purview classic Data Map"]
        direction TB
        COLL["Collections (per domain)<br/>purview-client.ts"]
        SCAN["Auto-scan-source registration<br/>purview-autoonboard.ts / purview-source-map.ts"]
        CLASS["Custom classification rules<br/>purview-classification-sync.ts<br/>(taxonomy admin → namespaced rule → scan)"]
        GLOSS["Business glossary terms<br/>Atlas v2 glossary API"]
        LIN["Lineage (Atlas entities)<br/>purview-unified-client.ts"]
    end

    subgraph unity["Azure Databricks Unity Catalog"]
        direction TB
        UCCAT["Catalogs (per domain, managed-location<br/>storage_root)<br/>unity-catalog-account-client.ts"]
        UCSCHEMA["Schemas (per sub-domain)<br/>unity-catalog-client.ts"]
        ABAC["Unity Catalog ABAC / column masks"]
    end

    subgraph onelakeNs["Loom OneLake-equivalent namespace (apps/loom-onelake)"]
        direction TB
        NS["Unified-namespace catalog<br/>onelake-catalog-client.ts"]
        RLS["OneLake-style security roles<br/>onelake-security-client.ts +<br/>onelake-rls-reconciler.ts"]
    end

    SYNC -->|"upsert / dry-run"| COLL
    SYNC -->|"upsert / dry-run"| UCCAT --> UCSCHEMA
    EDIT --> COLL
    EDIT --> UCCAT
    COLL --> SCAN
    COLL --> CLASS
    COLL --> GLOSS
    COLL --> LIN
    UCCAT --> ABAC
    ADLS["ADLS Gen2 medallion<br/>(Bronze/Silver/Gold)"] -.scanned by.-> SCAN
    ADLS -.cataloged by.-> NS
    NS --> RLS
    LIN -.lineage rendered from.-> ADLS

    classDef domC fill:#5C2D91,stroke:#fff,color:#fff,stroke-width:2px
    classDef purC fill:#D83B01,stroke:#fff,color:#fff,stroke-width:2px
    classDef ucC fill:#0078D4,stroke:#fff,color:#fff,stroke-width:2px
    classDef olC fill:#107C10,stroke:#fff,color:#fff,stroke-width:2px
    classDef dataC fill:#69797E,stroke:#fff,color:#fff,stroke-width:2px
    class DOM,EDIT,SYNC domC
    class COLL,SCAN,CLASS,GLOSS,LIN purC
    class UCCAT,UCSCHEMA,ABAC ucC
    class NS,RLS olC
    class ADLS dataC
```

Notes:

- **Both targets are independently optional.** An unconfigured Purview or
  Unity Catalog account yields an honest `skipped` result with a hint, never
  an error — the reconciler still runs against whichever target IS
  configured (`domain-sync.ts` `TargetSummary.configured/gated/hint`).
- **Classification flows one way**: the tenant's custom classification
  taxonomy (`/admin/classifications`, stored in Cosmos) pushes a namespaced
  Purview custom classification rule + triggers a scan
  (`purview-classification-sync.ts`), then Purview's scan auto-applies the
  classification to matching columns.
- **The daily exercise-every-service probe** (`lib/admin/service-probes.ts`)
  runs a real dry-run domain sync as one of its real-data-path checks, not
  just a config-presence check.

---

## 3. Weave → Power BI flow — Loom-native default, real Power BI opt-in

Weave (`lib/thread/thread-actions.ts`) gives every PBI-sourceable item
(warehouse, lakehouse, KQL database, semantic model, data product — read from
the item-type manifest's `capabilities.pbiSourceable`) a one-click "Analyze in
Power BI" edge. The click always resolves a real Azure-native answer first;
a real Power BI workspace is an explicit, mapped, opt-in target layered on top.

```mermaid
flowchart LR
    ITEM["Loom item (warehouse / lakehouse /<br/>kql-database / semantic-model)"]
    DRAWER["Weave action drawer<br/>(fields = real discovery routes,<br/>never freeform)"]
    ITEM --> DRAWER

    subgraph routes["Thread BFF routes — app/api/thread/*"]
        direction TB
        AIP["analyze-in-powerbi"]
        BLR["build-loom-report"]
        BPM["build-powerbi-model"]
        PAA["publish-as-api"]
    end
    DRAWER --> AIP & BLR & BPM & PAA

    RESOLVER["pbi-source-resolver.ts<br/>resolves item → Azure-native query"]
    AIP --> RESOLVER
    BPM --> RESOLVER

    subgraph loomNative["Loom-native (DEFAULT — zero Power BI dependency)"]
        direction TB
        LNR["Loom report designer<br/>(pages + 11 visual types + DAX,<br/>AAS-native semantic layer)"]
        LND["Loom-native dashboard tiles<br/>querying the resolved backend live"]
    end
    RESOLVER --> LNR
    RESOLVER --> LND
    BLR --> LNR
    PAA -->|"APIM"| API["Published data API"]

    subgraph pbiOptIn["Real Power BI service — OPT-IN (workspace mapped)"]
        direction TB
        MAP["Workspace → Power BI mapping<br/>powerbi-workspace-mapping.ts<br/>pickPbiWorkspaceId(explicit &gt; mapped &gt; envDefault)"]
        GW["VM data gateway (default-on)<br/>auto-upgrades to VNet gateway<br/>when a capacity is bound"]
        PBISVC["Power BI service<br/>(real workspace + capacity)"]
    end
    RESOLVER -.->|"per-click choice,<br/>only if a workspace is bound"| MAP --> GW --> PBISVC

    classDef itemC fill:#5C2D91,stroke:#fff,color:#fff,stroke-width:2px
    classDef routeC fill:#0078D4,stroke:#fff,color:#fff,stroke-width:2px
    classDef nativeC fill:#107C10,stroke:#fff,color:#fff,stroke-width:2px
    classDef optC fill:#69797E,stroke:#fff,color:#fff,stroke-width:2px,stroke-dasharray:6 4
    class ITEM,DRAWER itemC
    class AIP,BLR,BPM,PAA,RESOLVER routeC
    class LNR,LND,API nativeC
    class MAP,GW,PBISVC optC
```

Notes:

- **`pickPbiWorkspaceId`** (`lib/azure/powerbi-workspace-mapping.ts`) is the
  single precedence rule for which Power BI workspace an item targets:
  explicit per-item binding > workspace-level mapping >
  `LOOM_DEFAULT_FABRIC_WORKSPACE`. With nothing bound, the item is fully
  functional on the Loom-native path — no gate.
- **`build-powerbi-model`** is scoped to sources whose Azure-native backend
  can be read table-by-table today (`warehouse`, `synapse-dedicated-sql-pool`
  — `POWERBI_MODELABLE` in `thread-actions.ts`); other sources get the
  Loom-native semantic model instead.
- **Report "Get data"** (`lib/editors/report/get-data-gallery.tsx`) puts "Use
  a Loom item" first in the connector gallery; OneLake/Fabric shortcuts and
  Power BI semantic models sit in a clearly dashed, opt-in group at the
  bottom of the same gallery.

---

## 4. Compute topology — Synapse Spark tiers + Databricks pools + warm session pool

Three workload-tiered Synapse Spark pools and three Databricks instance pools
are provisioned at deploy time (`platform/fiab/bicep/modules/landing-zone/synapse-spark-pools.bicep`,
`scripts/csa-loom/provision-databricks-compute.sh`). A warm session pool sits
in front of both so a notebook run gets a live session handed off instead of
paying Synapse's 2–4 minute cold start.

```mermaid
flowchart TB
    subgraph synapse["Synapse Spark — MemoryOptimized, autoscale, autopause 15 min"]
        direction TB
        LP["loompool — Interactive<br/>Small, 3–10 nodes<br/>notebooks, interactive analytics"]
        LE["loometl — ETL<br/>Medium, 3–12 nodes<br/>medallion transforms, production ETL"]
        LB["loombatch — Batch/ML<br/>Large, 3–20 nodes<br/>heavy batch, wide shuffles, ML training"]
    end

    subgraph databricks["Databricks instance pools + 'Loom Standard' cluster policy"]
        direction TB
        DS["loom-pool-s — Standard_DS3_v2, max 8"]
        DM["loom-pool-m — Standard_E8ds_v4, max 16"]
        DL["loom-pool-l — Standard_E16ds_v4, max 32"]
    end

    subgraph warmpool["Warm Spark session pool — lib/azure/spark-session-pool.ts"]
        direction TB
        SLOTS["Slots: warming → warm → leased → returned<br/>N warm sessions per pool/kind/sizing group"]
        LEASE["acquireWarmSession() / releaseSession()<br/>atomic single-tick flip, never double-leased"]
        STORE["Cross-replica lease store<br/>Cosmos spark-warm-leases container<br/>(falls back to in-process registry)"]
        SLOTS --- LEASE --- STORE
    end

    subgraph heartbeats["Keep-warm heartbeats (external, compensate for ACA scale-to-zero)"]
        direction TB
        KW["csa-loom-spark-keepwarm.yml<br/>every 5 min, public runner<br/>POST /api/internal/spark/keep-warm"]
        RECON["reconcileWarmingSlots()<br/>synchronous Livy/Databricks liveness<br/>check run inside the request (#1947)"]
        REAPER["Leaked-session reaper (#1796)<br/>self-cleans idle untracked Livy sessions"]
    end

    warmpool -->|"leases a Livy session"| LP
    warmpool -->|"or a warmed cluster"| DS
    warmpool -.->|"heavier runs cold-start directly"| LE
    warmpool -.-> LB
    KW --> warmpool
    RECON --> warmpool
    REAPER -.->|"prevents pool starvation"| LP

    TELEM["Spark → Log Analytics telemetry<br/>SparkLoggingEvent_CL / SparkMetrics_CL /<br/>SynapseBigDataPoolApplicationsEnded"]
    LP & LE & LB --> TELEM
    DS & DM & DL --> TELEM

    classDef synC fill:#0078D4,stroke:#fff,color:#fff,stroke-width:2px
    classDef dbxC fill:#FF3621,stroke:#fff,color:#fff,stroke-width:2px
    classDef warmC fill:#107C10,stroke:#fff,color:#fff,stroke-width:2px
    classDef hbC fill:#D83B01,stroke:#fff,color:#fff,stroke-width:2px
    classDef telC fill:#5C2D91,stroke:#fff,color:#fff,stroke-width:2px
    class LP,LE,LB synC
    class DS,DM,DL dbxC
    class SLOTS,LEASE,STORE warmC
    class KW,RECON,REAPER hbC
    class TELEM telC
```

Notes:

- **`loompool` is the only pool the warm session pool targets by default**
  (interactive notebook workload); `loometl`/`loombatch` and the Databricks
  pools serve heavier scheduled/batch runs that cold-start directly since
  their jobs are long-running enough that a warm hand-off doesn't matter.
- **Two historical root causes are both fixed on this path**: the
  fire-and-forget `pollLivyToIdle` loop starving under ACA's CPU throttling
  between requests (fixed by the synchronous `reconcileWarmingSlots()` in
  PR #1947), and ~700 leaked idle Livy sessions jamming `loompool` (fixed by
  the leaked-session reaper, PR #1889/#1796).
- **Every pool carries baked best-practice Spark config** (AQE,
  Kryo serializer, Delta optimize-write + auto-compact) from the same preset
  source the console's compute UI uses (`lib/databricks/cluster-presets.ts`,
  `lib/spark/config-presets.ts`), so pre-provisioned compute matches the UI.

---

## 5. Notebook execution path — Synapse Livy default, Databricks/AML opt-in

Opening a notebook cell run always attempts the warm pool first, then falls
back to a real cold-started session against whichever engine the notebook is
bound to. All engines reach the same PE-locked lake through a managed VNet /
managed private endpoint — there is no public-network path to the data plane.

```mermaid
sequenceDiagram
    autonumber
    actor U as Console user (notebook editor)
    participant RT as POST /api/notebook/[id]/execute
    participant WP as Warm session pool<br/>(spark-session-pool.ts)
    participant LIVY as Synapse Livy session<br/>(synapse-livy-client.ts) — DEFAULT
    participant DBX as Databricks cluster<br/>(execution context) — opt-in<br/>LOOM_NOTEBOOK_BACKEND=databricks
    participant AML as AML compute<br/>(resolve-aml-target.ts) — opt-in<br/>data-science notebooks
    participant LAKE as ADLS Gen2 (PE-locked)<br/>managed VNet + managed PE

    U->>RT: run cell (pool, sessionId, code, kind)
    RT->>WP: acquireWarmSession(pool, kind, sizingKey)
    alt warm slot available
        WP-->>RT: leased session (instant hand-off)
    else no warm slot
        RT->>LIVY: resolveNotebookBackend() → cold-start Livy session
        Note over RT,LIVY: 2-4 min Synapse cold start<br/>(the historical "notebooks are slow" case)
    end
    RT->>LIVY: submitLivyStatement(code) / poll getLivyStatement
    LIVY->>LAKE: Spark reads/writes Delta over managed VNet + managed PE
    LIVY-->>RT: normalizeLivyOutput (text/html/df/image)
    RT-->>U: cell output

    Note over RT,DBX: If the notebook's backend is Databricks:<br/>executeCommand against the cluster's execution context instead of Livy
    RT->>DBX: executeCommand(clusterId, contextId, code)
    DBX->>LAKE: Unity Catalog external location, same PE-locked lake
    DBX-->>RT: command result

    Note over RT,AML: Data-science notebooks resolve AML compute<br/>via resolve-aml-target.ts (control plane = ARM,<br/>data plane honors Gov *.api.ml.azure.us suffix)
```

Notes:

- **`resolveNotebookBackend()`** (`synapse-livy-client.ts`) and the
  per-notebook `LOOM_NOTEBOOK_BACKEND` setting are what select Synapse
  (default) vs Databricks (opt-in); Fabric is never on this path
  (`no-fabric-dependency.md`).
- **The PE-locked lake requires a managed VNet + managed private endpoint**
  for Synapse Spark to reach it at all — an unmanaged (public) Spark pool
  hangs indefinitely against a DLZ lake with no public network access (the
  root cause documented for the mirroring-engine CDC fix, and the same
  constraint applies to every notebook run).
- **A `%%configure` magic cell** is intercepted before submission and
  triggers the editor to recreate the session with new compute options,
  rather than being submitted as code.

---

## 6. Realtime / streaming — Event Hubs → ADX Eventhouse → dashboard / Activator

An eventstream is a real Azure Event Hub with one consumer group per
destination (`eventstream.ts`). Continuous ADX ingestion feeds both a
Loom-native KQL dashboard and the Activator, which itself has two real,
independent evaluation paths.

```mermaid
flowchart LR
    SRC["Event sources<br/>(app telemetry, IoT, CDC, SaaS webhooks)"]
    EH["Azure Event Hubs<br/>(the eventstream backbone)<br/>1 consumer group per destination"]
    SRC --> EH

    SA["Stream Analytics transform<br/>(only when the bundle defines transforms)"]
    EH -.->|"if configured"| SA

    ADX["ADX Eventhouse / KQL Database<br/>continuous ingestion<br/>kusto-client.ts"]
    EH --> ADX
    SA --> ADX

    DASH["KQL Dashboard (Loom-native)<br/>tiles query ADX live<br/>/api/items/kql-dashboard/[id]?run=1"]
    ADX --> DASH

    subgraph activatorPaths["Activator (Reflex) — two real evaluation paths"]
        direction TB
        MONRULE["Azure Monitor scheduledQueryRule<br/>createMonitorActivatorRule()<br/>(activator-monitor.ts) — per-rule,<br/>console-authored, KQL over LA or ADX"]
        AG["Action group<br/>(email / SMS / webhook / Logic App)"]
        ENGINE["fiab-activator-engine<br/>AdxRulePoller (BackgroundService)<br/>polls ADX every N sec (default 30s),<br/>evaluates + dispatches directly"]
    end
    ADX --> MONRULE --> AG
    ADX --> ENGINE

    FAB["Fabric Eventstream / Reflex —<br/>OPT-IN ONLY<br/>LOOM_EVENT_BACKEND=fabric /<br/>LOOM_ACTIVATOR_BACKEND=fabric<br/>+ bound workspace"]
    EH -.->|"opt-in only"| FAB

    classDef srcC fill:#69797E,stroke:#fff,color:#fff,stroke-width:2px
    classDef ehC fill:#D83B01,stroke:#fff,color:#fff,stroke-width:2px
    classDef adxC fill:#107C10,stroke:#fff,color:#fff,stroke-width:2px
    classDef dashC fill:#0078D4,stroke:#fff,color:#fff,stroke-width:2px
    classDef actC fill:#5C2D91,stroke:#fff,color:#fff,stroke-width:2px
    classDef optC fill:#3B3A39,stroke:#fff,color:#fff,stroke-width:2px,stroke-dasharray:6 4
    class SRC srcC
    class EH,SA ehC
    class ADX adxC
    class DASH dashC
    class MONRULE,AG,ENGINE actC
    class FAB optC
```

Notes:

- **Two Activator evaluation paths are both real, not redundant**: the
  console-authored `scheduledQueryRule` path (`activator.ts` +
  `activator-monitor.ts`) is what the editor's rules tab creates and manages
  per rule (Start/Stop/Enable/Disable/Delete/Trigger all key off this
  record); the sibling `fiab-activator-engine` service's `AdxRulePoller` is a
  lower-latency continuous poller that evaluates rules directly against ADX
  without waiting on Monitor's alert evaluation cadence.
- **A Fabric Eventstream/Reflex is opt-in and falls back silently** —
  selecting the Fabric backend without a bound workspace does not gate;
  it runs the Azure-native path (`eventstream.ts`, `activator.ts`).
- **No Fabric RTI dependency anywhere on the default path** — ADX Eventhouse
  is the Azure-native, always-available RTI backend
  (`no-fabric-dependency.md`).

---

## Component index

| Component | Where in the repo |
|---|---|
| Provisioner registry | `apps/fiab-console/lib/install/provisioners/*.ts` |
| Lakehouse / warehouse / KQL-DB / eventstream / activator / notebook / KQL-dashboard / mirrored-DB provisioners | `apps/fiab-console/lib/install/provisioners/{lakehouse,warehouse,kql-db,eventstream,activator,notebook,kql-dashboard,mirrored-database}.ts` |
| Domain hierarchy + per-edit mirror | `apps/fiab-console/lib/azure/{domain-registry,unified-domain-mapper}.ts` |
| Whole-hierarchy governance reconciler | `apps/fiab-console/lib/azure/domain-sync.ts` |
| Purview clients (Data Map, classification sync, autoscan) | `apps/fiab-console/lib/azure/purview-{client,classification-sync,autoonboard,source-map,unified-client}.ts` |
| Unity Catalog clients | `apps/fiab-console/lib/azure/unity-catalog-{account-,}client.ts` |
| OneLake-equivalent namespace + RLS | `apps/fiab-console/lib/azure/onelake-{catalog-client,security-client,rls-reconciler}.ts` · `apps/loom-onelake` |
| Weave edges + Power BI workspace mapping | `apps/fiab-console/lib/thread/thread-actions.ts` · `apps/fiab-console/lib/azure/powerbi-workspace-mapping.ts` |
| PBI source resolver + Get-data gallery | `apps/fiab-console/lib/azure/pbi-source-resolver.ts` · `apps/fiab-console/lib/editors/report/get-data-gallery.tsx` |
| Synapse Spark workload-tier pools | `platform/fiab/bicep/modules/landing-zone/synapse-spark-pools.bicep` |
| Databricks instance pools + cluster policy | `scripts/csa-loom/provision-databricks-compute.sh` · `apps/fiab-console/lib/databricks/cluster-presets.ts` |
| Warm Spark session pool | `apps/fiab-console/lib/azure/spark-session-pool.ts` |
| Notebook execute route + Livy client | `apps/fiab-console/app/api/notebook/[id]/execute/route.ts` · `apps/fiab-console/lib/azure/synapse-livy-client.ts` |
| AML target resolver | `apps/fiab-console/lib/azure/resolve-aml-target.ts` |
| Eventstream / Event Hubs client | `apps/fiab-console/lib/azure/eventhubs-client.ts` |
| Kusto (ADX) client | `apps/fiab-console/lib/azure/kusto-client.ts` |
| Activator Azure Monitor runtime | `apps/fiab-console/lib/azure/activator-monitor.ts` |
| Activator poller engine (sibling service) | `apps/fiab-activator-engine/src/LoomActivator/Polling/AdxRulePoller.cs` |

## Related

- [Full-Picture Architecture](architecture-full-picture.md) — system topology, identity/auth, deployment, medallion data flow
- [Architecture Diagrams](diagrams/README.md) — tenant topology, deploy flows, domain/RBAC model, domain-to-catalog data flow
- [Compute Tiers & Telemetry](compute-tiers-and-telemetry.md) — full pool/tier detail behind diagram 4
- [Reference Architecture](architecture.md) · [Model Strategy](model-strategy.md)
