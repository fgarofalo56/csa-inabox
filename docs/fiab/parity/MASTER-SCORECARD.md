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

> **⚠️ rev.2 (2026-06-01) — grades re-audited UPWARD against current code.**
> The rev.1 grades below the table's count columns predate a build wave that
> shipped 12 parity features (Databricks cluster/warehouse edit, SQL navigator,
> Cosmos Items Data Explorer, AI Search field designer + search explorer, ADX
> results grid + DB policies, APIM OpenAPI import + operations authoring, Event
> Hubs Send, AI Foundry Agents, Power BI governance, Power Platform env
> lifecycle). Each per-service doc was re-read against the real editor on
> 2026-06-01 and corrected (see each `<slug>.md` rev.2 note). **The Grade column
> is current. The Built/Partial/Gated/Missing count cells are NOT yet
> recomputed — trust the per-service docs for exact counts.** Two surfaces (AI
> Search field designer + search explorer; Cosmos Items Data Explorer) were
> additionally verified LIVE via Playwright against the deployed console with a
> real authenticated session (real index fields; real `2.25 RU` Cosmos
> data-plane request charge).

| Service | Grade (rev.2) | was | Top gaps still open (highest-impact first) |
|---|:--:|:--:|---|
| Azure Databricks | **A** | B | Unity Catalog is read-only (no create/GRANT/lineage); DLT/Lakeflow editor; Repos branch ops; cluster Policy + Access-mode (UC gate); Job Repair-run |
| Azure AI Search | **B** | C | Indexer scheduling + run history + field/output mappings; semantic-config & vector-profile *designers* (JSON-only today); scoring-profile/analyzer designers; Import-data wizard; service-stats panel; Keys/Identity/Networking/Monitoring admin |
| Azure Cosmos DB | **B-** | C | Stored-proc/trigger/UDF authoring + execute; account blades (Keys/Geo/Consistency/Backup/Networking); write-path Scale/Settings/Indexing editors; bulk upload; query save/multi-tab |
| Power BI / Fabric semantic | **B-** | C | Workspace content grid + Lineage view; sensitivity labels (honestly omitted — no public apply REST); Subscriptions; App publishing/capacity; data-source credential sign-in; in-browser report authoring |
| Azure API Management | **B-** | C | Form-based policy editor + effective-policy + fragments; subscription key reveal/regenerate + state; named-value secret reveal + KV refs; versions/version-sets; whole portal blades (Dev portal, Users, Groups, Certs, Monitoring, Networking) |
| Azure AI Foundry | **C+** | C | Fine-tuning (submit/monitor/deploy); templates gallery; observability/trace dashboards; 7-of-8 playgrounds deep-link only; agent depth (knowledge/memory/guardrails attach, publish/versioning, evals) |
| Azure Data Explorer (Kusto) | **C+** | C | Cluster lifecycle/scale/start-stop + create/delete; RBAC (cluster + database) principal mgmt; RLS authoring (tooltip-only); grid group-by/pivot/full-profile; Open-in-Excel / Query-to-Power-BI / share-link |
| Azure SQL Database | **C+** | C | Compute & storage scale (no update route); backups/PITR/geo-restore/LTR; copy/export-import bacpac + results export; Networking/TDE/Defender/Auditing + monitoring; geo-replication failover (add-only today) |
| Power Platform | **C** | C | Copy/Backup-Restore/Reset/Convert/History (honest admin-gates); Managed Environments + groups; 7-of-8 admin-center areas; all maker authoring (canvas/flow/Pages/table/connector — deep-linked, forbidden as parity); App Share |
| Azure Data Factory | **C** | C | Mapping Data Flow visual designer (flagship, absent — the React Flow canvas is pipeline-only); Copy Data Tool wizard; Add-Dynamic-Content expression builder; source control/Publish/ARM; connector galleries + Test Connection; factory Monitor hub |
| Azure Synapse Analytics | **C** | C | Synapse notebook authoring editor (absent); unified Studio shell + Publish/Git; data-flow visual designer; data-hub lake browser; Monitor-hub drill grids; SQL results export/chart; Manage-hub surfaces |
| Azure Event Hubs | **C** | D | Data Explorer View/receive (honest AMQP dependency-gate — allowed); SAS keys/connection-string copy; Capture authoring; Scale/Auto-inflate; namespace Overview blade + metrics; IAM/Networking/Geo-DR |

**Grade distribution (rev.2):** 1 × A, 4 × B/B-, 3 × C+, 4 × C. Zero D, zero F.
Up from rev.1's 1 × B / 10 × C / 1 × D. The shift is real built code (every ✅
flip was verified by reading the route handler back to a real Azure REST/data-
plane call), not re-scoring — but **every service still has genuine missing
breadth**, and no service is yet at the `ui-parity.md` A+ bar (full inventory
built). The headline gaps that remain are the heavy designers: ADF/Synapse
Mapping Data Flow + notebook authoring, Databricks Unity Catalog write surface,
and the per-service admin blades.

> The rev.1 capability counts (192 built / 102 partial / 31 gated / 255 missing
> across 580 inventoried) are preserved below for history but understate the
> current built total by ~40–60 capabilities (the 12 shipped features). A full
> recount is tracked as follow-up.

## Deepened sub-surfaces (rev.3 — 2026-06-01)

> Seven heavy designer / write surfaces were built out and audited individually
> (per-surface docs alongside this file). These are the surfaces the rev.2 note
> called the "headline gaps … heavy designers." Counts are honest
> (built ✅ / partial ⚠️ / honest-gate ⚠️ / missing ❌), derived from reading the
> editor source back to a real REST/data-plane call, not a live click-through
> (confirm against the live portal per the no-scaffold rule). Lifts the parent
> service grade where noted.

| Sub-surface | Doc | Grade | ✅ | ⚠️ | gate | ❌ | Lifts |
|---|---|:--:|:--:|:--:|:--:|:--:|---|
| Databricks Unity Catalog WRITE (create catalog/schema/table + grants) | `databricks-unity-catalog.md` | **B−** | 24 | 1 | 0 | 17 | flips `databricks-workspace.md` F4–F5 ❌→✅ |
| Synapse Spark notebook (cells + Livy run) | `synapse-notebook.md` | **B−** | 18 | 4 | 1 | 14 | flips `synapse-analytics.md` "notebook absent" ❌→built |
| ADF Mapping Data Flow designer | `adf-mapping-data-flow.md` | **B−** | 18 | 3 | 1 | 8 | cures `adf-data-factory.md` "rich surface→JSON" violation |
| ADX web UI — query + `render` auto-chart | `adx-web-ui.md` | **B** | 19 | 6 | 0 | 8 | deepens `adx-kusto.md` results/render |
| AI Search — Search Explorer query options | `ai-search-explorer.md` | **B+** | 27 | 5 | 0 | 9 | deepens `ai-search.md` search tab |
| AI Foundry — Evaluations | `foundry-evaluations.md` | **C+** | 13 | 2 | 1 | 11 | deepens `ai-foundry.md` evals tab |
| Data API Builder — config UX | `data-api-builder.md` | **B+** | 30 | 6 | 1 | 1 | new DAB authoring surface |

**Sub-surface distribution:** 1 × B+, 1 × B+, 1 × B, 3 × B−, 1 × C+ (two B+ rows).
All seven are real built code with honest gates — no vaporware. The two flagship
`ui-parity.md` violations called out in rev.2 (ADF/Synapse heavy designers,
Databricks UC write) now have genuine built surfaces; they sit at **B−** because
breadth (full transform library / `display()` viz / UC lineage+external-locations)
is still missing, not because anything is faked.

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
