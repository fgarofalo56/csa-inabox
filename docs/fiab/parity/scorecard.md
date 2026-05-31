# CSA Loom → Azure portal 1:1 parity scorecard

**Honest baseline, 2026-05-31.** Each service was audited by grounding the REAL
Azure portal/studio feature inventory in Microsoft Learn, then grading the
actual Loom editor/navigator/route code per capability (built ✅ / partial ⚠️ /
gated ⚠️ / missing ❌), conservative when unsure. Per `.claude/rules/ui-parity.md`
+ `no-vaporware.md`. Per-service detail in `docs/fiab/parity/<slug>.md`.

> **Bottom line:** the **data plane works** — every navigator is wired to real
> Azure REST and validated 34/34 live (`csa_loom_navigators_live_green`) — but
> the **editors are NOT 1:1 feature-complete with the Azure portal**. Average
> grade ≈ **C**. Of ~570 enumerated Azure capabilities: roughly **40% built,
> 20% partial, 7% honest-gate, 33% missing**. The framework is correct
> (Fluent UI v9 = Azure/Fabric's own design system); the gap is feature
> build-out + fidelity, not the stack.

| Service | Grade | built | partial | gated | missing | doc |
|---|:---:|---:|---:|---:|---:|---|
| Azure Databricks | **B** | 41 | 9 | 5 | 33 | databricks-workspace.md |
| Power Platform | C | 28 | 4 | 1 | 38 | power-platform.md |
| Power BI / Fabric | C | 26 | 4 | 3 | 20 | powerbi-workspace.md |
| API Management | C | 18 | 8 | 0 | 21 | apim-service.md |
| Azure Data Explorer (Kusto) | C | 17 | 21 | 2 | 24 | adx-kusto.md |
| Azure AI Search | C | 17 | 3 | 4 | 16 | ai-search.md |
| Azure AI Foundry | C | 13 | 12 | 3 | 5 | ai-foundry.md |
| Azure Data Factory | C | 11 | 4 | 2 | 11 | adf-data-factory.md |
| Azure Cosmos DB | C | 8 | 7 | 5 | 24 | cosmos-db.md |
| Azure SQL Database | C | 6 | 7 | 0 | 31 | azure-sql-database.md |
| Azure Synapse Analytics | C | 4 | 17 | 2 | 16 | synapse-analytics.md |
| Azure Event Hubs | **D** | 3 | 6 | 4 | 16 | event-hubs.md |

## The single biggest theme
Every service is missing its **flagship "explorer / designer" surface** — the one
operators live in. Loom often substitutes a read-only grid or a raw-JSON
textarea, which `ui-parity.md` explicitly forbids as parity:

- **Cosmos** — Items **Data Explorer** (browse/query/CRUD documents): "the single
  most-used Data Explorer feature and the biggest credibility gap; entirely absent."
- **Event Hubs (D)** — **Send + View events**, SAS keys/connection strings,
  Capture config, auto-inflate scale.
- **ADF** — **Mapping Data Flow** visual designer, Copy Data wizard, Expression Builder.
- **Synapse** — **Notebook editor**, unified Studio shell, data-flow designer.
- **ADX** — **rich results grid** (sort/filter/group/pivot/profile), cluster
  lifecycle, principal-assignment RBAC UI, export/share.
- **AI Foundry** — **Agents editor + playground** (flagship new-Foundry), fine-tuning, connections CRUD, guardrails.
- **AI Search** — **visual field designer**, search-explorer query options (semantic/vector), indexer scheduling, vector profile designer.
- **SQL** — wire the real object navigator into the editor; scale; backup/restore; firewall/Entra-admin/replication.
- **Power BI** — per-item settings/governance (gateway creds, endorsement, sensitivity, workspace ACL).
- **Power Platform** — environment lifecycle + Dataverse table/data authoring (designers are deep-linked, which ui-parity forbids).

## Prioritized build backlog (highest value first)

**Tier 0 — quick wins (backend already exists, just unwired):**
1. **Databricks cluster EDIT** — `editCluster()` exists; wire into the editor (fields disabled today). Highest value / lowest effort.
2. **Databricks SQL warehouse EDIT/scale** — `editWarehouse()` exists, no UI calls it.
3. **Azure SQL: mount the real `SqlDbTree` navigator** into `UnifiedSqlDatabaseEditor` (rich sys.* tree built but the editor shows a flat grid); surface the existing firewall / Entra-admin / geo-replication routes.
4. **AI Search Search-Explorer query options** — backend already supports `queryType` + `vectorQueries`; expose semantic/vector controls.
5. **Synapse dedicated-pool DWU scale** on the ribbon (client fn exists, not surfaced).

**Tier 1 — flagship explorers/designers (biggest credibility gaps):**
6. **Cosmos Items Data Explorer** — documents.azure.com data-plane client (+ data-plane RBAC), Monaco query tab, results grid w/ RU charge, item New/View/Edit/Delete.
7. **Event Hubs Data Explorer** — Send + View events (Entra data-plane), SAS keys/connection strings, Capture config, auto-inflate.
8. **AI Search visual field designer** + indexer scheduling/run-history + vector/semantic config designers + Import-data wizard.
9. **ADX rich results grid** (sort/filter/group/pivot/profile) + cluster lifecycle + principal-assignment RBAC UI + export/share.
10. **AI Foundry Agents editor + playground** (wire `foundry-agent-client`), Connections CRUD, fine-tuning, guardrails.

**Tier 2 — heavy designers (large, schedule deliberately):**
11. **ADF / Synapse Mapping Data Flow** visual designer + Expression Builder + Copy Data wizard.
12. **Synapse notebook editor** + unified Studio shell.
13. **APIM** operations authoring + guided policy editor + subscription key/state.
14. **Power BI** per-item settings/governance pane.
15. **Power Platform** environment lifecycle + Dataverse authoring + Unity Catalog write surface (Databricks).

## How "done" is proven from here (no more DOM/network claims)
Per surface: the parity doc shows every inventory row built ✅ or honest-gate ⚠️
(zero ❌, zero stub banners) · `tsc --noEmit` + `pnpm uat` green · AND a
side-by-side against the live Azure portal (operator or browser screenshot).
DOM strings ≠ parity.
