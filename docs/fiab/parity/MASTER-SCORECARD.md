# CSA Loom -> Azure Parity Master Scorecard

> **Synthesized from 12 per-service deep-functional audits (2026-05-31).** Each
> source audit clicked every control on the live Loom surface and compared it
> feature-for-feature against the real Azure portal / Fabric UI per
> `.claude/rules/ui-parity.md`. Grades use the `no-vaporware.md` rubric
> (F vaporware / D stubbed / C functional-but-rough / B production-grade /
> A tested / A+ tested+documented+bicep-synced).
>
> **Note on filename:** the per-service Fabric metrics-scorecard parity doc
> already occupies `scorecard.md` in this folder; on a case-insensitive
> filesystem `SCORECARD.md` would clobber it, so this master synthesis lives at
> `MASTER-SCORECARD.md`.
>
> **Capability counts are honest, not aspirational.** "Built" = real control +
> real backend. "Partial" = renders but thin or read-only where Azure is rich.
> "Gated" = honest infra/preview MessageBar (allowed). "Missing" = the Azure
> capability has no Loom surface at all.

## Scorecard

| Service | Grade | Built | Partial | Gated | Missing | Top gaps (highest-impact first) |
|---|:--:|--:|--:|--:|--:|---|
| Azure Databricks | **B** | 41 | 9 | 5 | 33 | Cluster EDIT unwired (client fn exists); SQL Warehouse edit/scale unwired; cluster Policy + Access-mode (UC gate); Job Repair-run; Unity Catalog is read-only (no create/GRANT/lineage); DLT/Lakeflow editor; Repos branch ops |
| Azure API Management | **C** | 18 | 8 | 0 | 21 | Operations authoring (read-only today); form-based policy editor + effective-policy; subscription key reveal/regenerate + state transitions; Overview+Scale in-editor; named-value secret reveal; versions/version-sets; whole blades (Dev portal, Users, Groups, Certs, Monitoring, Networking) |
| Power BI / Fabric semantic | **C** | 26 | 4 | 3 | 20 | Per-item ⋯ context menu (unlocks settings+governance); semantic-model gateway/credential binding; endorsement + sensitivity labels (0%); Manage-access on REAL PBI workspace ACL (today Cosmos-only); content grid w/ columns; Share/Subscribe; persist DAX measures |
| Power Platform | **C** | 28 | 4 | 1 | 38 | Environment lifecycle command bar (New/Copy/Backup/Reset/Delete); Managed Environments + groups + tenant governance; Dataverse table authoring + row CRUD; all designers deep-linked out (forbidden); 6/8 admin-center areas missing; Power Apps Share; Solutions/ALM navigator |
| Azure AI Foundry | **C** | 13 | 12 | 3 | 5 | Agents editor + playground (client exists, unwired — flagship); Fine-tuning; Connections CRUD (read-only); Guardrails/RAI authoring; observability dashboard + trace spans; lifecycle ops on read-only tabs; remaining playgrounds + templates gallery |
| Azure Data Explorer (Kusto) | **C** | 17 | 21 | 2 | 24 | Cluster lifecycle (stop/start/scale/create) entirely absent; RBAC principal assignment; rich results grid (sort/filter/pivot/profile); export/share (CSV/Excel/Power BI); table schema editing + RLS + external tables; get-data wizards; query history/tabs/IntelliSense |
| Azure AI Search | **C** | 17 | 3 | 4 | 16 | Visual index field designer (replaced by JSON textarea — forbidden); search-explorer query options (semantic/vector unreachable though backend supports); indexer scheduling + run history; semantic-config + vector-profile designers; Import-data wizard; service stats panel |
| Azure Cosmos DB | **C** | 8 | 7 | 5 | 24 | Items data explorer (data-plane CRUD — biggest credibility gap); query editor + RU stats; Scale/Settings write path (reads exist, no PUT); stored-proc/trigger/UDF authoring; indexing + conflict-resolution editors; account blades (Keys/Geo/Consistency/Backup/Networking); typed-delete confirms; bicep env-sync |
| Azure SQL Database | **C** | 6 | 7 | 0 | 31 | Wire existing rich SqlDbTree (real sys.* over TDS) into the registered editor; surface firewall/Entra-admin/geo-replication (backends exist, UI unmounted); compute & storage scale (no ARM PATCH route); backups/PITR/LTR; query-editor export/save-view; DB lifecycle (delete/copy/bacpac) |
| Azure Data Factory | **C** | 11 | 4 | 2 | 11 | Mapping Data Flow visual designer (flagship, entirely absent); Copy Data Tool wizard; Add-Dynamic-Content expression builder (blocks most pipelines); source control / CI-CD; connector galleries + Test Connection; rich Copy activity form; advanced triggers; factory-wide Monitor hub |
| Azure Synapse Analytics | **C** | 4 | 17 | 2 | 16 | Synapse notebook editor (marquee Develop surface, absent); unified Studio shell (Home/Data/Develop/Integrate/Monitor/Manage + Publish/Git); data-flow visual designer; data-hub lake browser + DB object tree; Monitor-hub drill grids; SQL results export/chart; Manage-hub surfaces; surface DWU scale |
| Azure Event Hubs | **D** | 3 | 6 | 4 | 16 | Data Explorer (Send + View events — most-used surface, absent; needs Entra data-plane); SAS keys/connection strings (no way to get one out today); Capture config authoring; Scale/Auto-inflate; Overview blade w/ metrics; Networking editor; Geo-DR; whole mgmt blades (IAM/Tags/Locks/Diag/Metrics/Alerts/CMK/Identity) |
| **TOTAL** | **C avg** | **192** | **102** | **31** | **255** | — |

**Distribution of capabilities (580 total inventoried across 12 services):**

- **Built (real control + real backend): 192 — 33.1%**
- **Partial (renders but thin / read-only): 102 — 17.6%**
- **Gated (honest infra/preview MessageBar — allowed): 31 — 5.3%**
- **Missing (no Loom surface at all): 255 — 44.0%**

**Grade distribution:** 1 × B, 10 × C, 1 × D. Zero A-grade services. Zero F
(no outright vaporware found — what exists is real, there's just far too little
of it).

---

## Overall honest assessment: how far is Loom from 1:1 Azure parity?

**Loom is roughly one-third of the way to 1:1 Azure parity, and not close to
the `ui-parity.md` bar on any service.** Across the 580 capabilities the audits
inventoried, only **33% are actually built**. **44% are entirely missing** —
not gated, not stubbed, simply absent. A further **18% are partial**: they
render but are read-only or reduced to a thin form where the real portal is a
rich designer, grid, or wizard. Only **5%** sit behind the *allowed* honest
infra-gate.

The single B is **Databricks**, and even it is B not A because several of its
highest-value gaps are *already-written client functions that were never wired
to a button* (cluster edit, warehouse scale, repos branch ops). That pattern —
**backend exists, UI doesn't call it** — recurs in almost every audit (Cosmos
throughput reads but no PUT; Azure SQL has firewall/AAD/replication routes but
the registered editor never mounts them; AI Foundry ships `foundry-agent-client.ts`
with no route or editor; Power BI has `cloneReport`/`addDashboardTile`/`BindToGateway`
in the client and no UI; AI Search `getServiceStats()` has no route). This is the
cheapest parity ground in the entire program and a large fraction of the backlog
below is "wire what already exists."

The **D is Event Hubs**, and it is the clearest failure: the two things
operators use Event Hubs for — **sending and viewing events**, and **getting a
connection string** — are both absent, partly because the deployment sets
`disableLocalAuth: true` and no Entra data-plane path was built to replace SAS.
It reads as a bare resource tree, not an Event Hubs portal.

The recurring `ui-parity.md` violation is **"rich Azure surface -> JSON
textarea"**: ADF's Mapping Data Flow, Synapse's notebook + data-flow designers,
AI Search's index field grid, and Cosmos's items explorer are all flagship
visual experiences that Loom either omits entirely or replaces with a raw-JSON
editor. The other recurring violation is **deep-link-as-parity** (Power Platform
routes all five authoring designers — canvas Studio, flow designer, connector
wizard, Power Pages, AI Builder — out to the real product instead of building
them; Synapse fragments one Studio into four disconnected catalog items).
Both are explicitly forbidden, so several "C" surfaces are really D-grade on the
specific tabs that matter most.

**Bottom line:** what Loom has built is genuine (no fake data, gates are
honest), but it is a thin slice. To honestly claim parity on any single service
you'd need to roughly triple its built-capability count, and the program-wide
gap is dominated by *missing visual designers/data-explorers* and *unwired
existing backends*.

---

## Prioritized build backlog (highest impact first, across all services)

Ordering weights: operator frequency-of-use, credibility gap (how "fake" the
surface looks without it), `ui-parity.md` violation severity, and
effort-to-impact (unwired-backend items are starred ★ as quick wins).

### Tier 0 — Quick wins: wire backends that already exist (days, not weeks)

1. **★ Databricks Cluster EDIT** — wire the existing `editCluster()` into
   `DatabricksClusterEditor` (today create/view only, fields disabled). Highest
   value / lowest effort in the whole program.
2. **★ Databricks SQL Warehouse edit/scale** — wire `editWarehouse()` (size,
   min/max, auto-stop, serverless toggle). Client fn exists, no caller.
3. **★ Azure SQL: mount the rich `SqlDbTree` (real sys.* over TDS) into
   `UnifiedSqlDatabaseEditor`** — replaces the flat INFORMATION_SCHEMA grid with
   the navigator that's already built but never mounted; also surface the
   existing firewall / Entra-admin / geo-replication routes.
4. **★ AI Foundry Agents editor + playground** — wire existing
   `foundry-agent-client.ts` into a new `/api/foundry/agents` route + editor
   (model/instructions/tools/knowledge/threads-runs/publish). Flagship new-Foundry
   surface; today only a forbidden greyed "coming" tooltip.
5. **★ Power BI quick wins** — wire `cloneReport` (Save-a-copy), `addDashboardTile`
   /`cloneDashboardTile` (Pin tile); these client fns already exist.
6. **★ Cosmos Scale/Settings write path** — add the `PUT throughputSettings`
   (and TTL) call; reads of throughput/defaultTtl already exist.
7. **★ AI Search service-stats panel** — add a route over the implemented
   `getServiceStats()` for usage/quota/search-units at a glance.

### Tier 1 — Flagship visual surfaces missing entirely (biggest credibility gaps)

8. **Cosmos DB Items data explorer** (data-plane browse/new/view/edit/delete +
   query editor with RU-charge/doc-count stats) — the single most-used Cosmos
   feature; requires an AAD data-plane `documents.azure.com` client.
9. **Event Hubs Data Explorer — Send + View events** (partition/position/grid/
   download) over Entra data-plane (deployment is `disableLocalAuth:true`).
   The most-used Event Hubs surface; lifts the service off its D.
10. **ADF Mapping Data Flow visual designer** (source -> transforms -> sink graph
    + data preview + debug) — the flagship ADF surface, today only empty-shell +
    raw JSON.
11. **Synapse notebook editor** (cells, %% magics, attach-pool, Run/Run-all,
    variable explorer, charts) — the marquee Develop experience; Spark is a single
    textbox today.
12. **AI Search visual index field designer** — per-field grid (add/edit, attribute
    checkboxes, analyzer/type pickers) to replace the forbidden JSON textarea; plus
    search-explorer **query options** (semantic/vector are unreachable though the
    backend already supports them).

### Tier 2 — Authoring & write surfaces that are currently read-only

13. **APIM Operations authoring** (add/edit/delete operations, params, request/
    response schemas) + **form-based policy editor** with effective-policy calc.
14. **Power Platform Environment lifecycle command bar** (New/Edit/Copy/Backup-
    Restore/Reset/Delete/Convert) + **Dataverse table authoring + row CRUD**.
15. **Databricks Unity Catalog write surface** (create catalog/schema/table/volume,
    GRANT/REVOKE, lineage, external locations) — entire governance write surface is
    read-only.
16. **Power BI semantic-model settings pane** (gateway binding + datasource
    credentials) — without it refresh fails for any gateway/cloud model; plus
    **per-item ⋯ context menu** (unlocks settings + governance across all item types).
17. **ADX rich results grid** (sort/filter/group/pivot/profile/cell-stats) +
    **export/share** (CSV/Excel/Power BI) — the defining ADX web-UI experience.
18. **Cosmos stored-proc/trigger/UDF authoring** + indexing/conflict-resolution
    editors.
19. **AI Foundry Connections CRUD** (AOAI/AI-Search/Blob) + Guardrails/RAI policy
    authoring (flows + agents depend on connections).

### Tier 3 — Scale, lifecycle, and platform plumbing

20. **Scale/compute editors** missing across the board: ADF/Synapse IR + DWU,
    Azure SQL service-tier/vCore/serverless (need ARM PATCH route), Event Hubs
    TU/auto-inflate, ADX cluster stop/start/scale, Databricks cluster Policy +
    Access-mode (UC gate).
21. **Source control / CI-CD + unified Studio shell** for ADF and Synapse
    (Git config, Publish/Discard live-mode, ARM export) — today both are
    live-mode-only and Synapse is fragmented into 4 catalog items.
22. **Connector galleries + Test Connection** for ADF/Synapse linked services &
    datasets (90+ connectors today reduced to ~2 typed forms + raw JSON).
23. **Backups & restore** (Azure SQL PITR/geo-restore/LTR; Cosmos backup/restore).
24. **Monitor hubs** — factory/workspace-wide run grids with rerun/cancel/Gantt
    for ADF & Synapse; AI Foundry observability dashboard + trace spans.
25. **Management blades** (IAM, Tags, Locks, Diagnostic settings, Metrics, Alerts,
    CMK, Identity, Networking/private-endpoints) — entirely absent on Event Hubs,
    Cosmos, APIM, and most services; build a reusable Azure-mgmt-blade component
    once and mount it everywhere.
26. **Bicep / env-var sync** — several navigators (Cosmos `LOOM_COSMOS_*`, plus
    the navigators noted as silently config-gated in the live deployment) need
    their env vars wired into `admin-plane/main.bicep` `apps[]` so they aren't
    silently dead in production (`no-vaporware.md` bicep-sync requirement).

### Tier 4 — Governance, secrets, and remaining portal tools

27. **Endorsement (promote/certify) + sensitivity labels** across Power BI item
    types (0% today); **Manage-access on the real PBI workspace ACL** (today
    Cosmos-only Loom roles).
28. **Secret reveal/regenerate**: Event Hubs SAS keys/connection strings, APIM
    subscription-key reveal/regenerate + state transitions, APIM named-value +
    Key-Vault references, Cosmos account keys.
29. **RBAC principal-assignment UIs**: ADX cluster/database roles, Databricks ACLs,
    AI Foundry RBAC, generic IAM blade.
30. **Get-data / import wizards**: AI Search Import-data (datasource->skillset->
    index->indexer + vectorization), ADX get-data (blob/ADLS + schema inference),
    ADF Copy Data Tool, Power BI quick-create report.
31. **Remaining portal tools** (lower freq): ADX dashboards multi-page + import/
    export, AI Search debug sessions + demo app, AI Foundry Images/Audio/Speech
    playgrounds + templates gallery, Power Platform Solutions/ALM + 6 missing
    admin-center areas.

---

### How to use this backlog

- **Tier 0 first** — these are the cheapest possible parity gains (existing
  backend, missing wire-up) and several are flagged as "highest value / lowest
  effort" in their source audits. Knocking out Tier 0 alone moves Databricks
  toward A and lifts Azure SQL / AI Foundry / Cosmos off their worst tabs.
- **Tier 1 is what makes Loom *look* real** — these are the flagship visual
  surfaces whose absence is the biggest "this is a scaffold" tell, and the ones
  most directly violating `ui-parity.md`'s "rich surface -> JSON textarea" ban.
- Build the **reusable Azure-management-blade** (Tier 3 #25) and
  **secret-reveal** (Tier 4 #28) components *once* and mount across services —
  they recur in nearly every audit's missing list.

_Last updated: 2026-05-31. Source: 12 per-service parity audits under
`docs/fiab/parity/`._
