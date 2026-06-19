# CSA Loom — DAY-ONE Validation Scorecard (2026-06-18)

**Count:** 4 BLOCKING bugs · 10 NEEDS-day-one-config gates (3 shared root causes) · 6 of 8 audit areas fully clean.

---

## 1. BLOCKING bugs — break day-one

All four are in a single component family: the **API Management admin pane** (`/admin/api-management`). Every tab's CRUD buttons are decorative (no `onClick`), so create/edit/delete silently no-op. This violates `no-vaporware.md` ("Buttons with no click handler").

| Surface | Issue | File:line | Fix |
|---|---|---|---|
| `/admin/api-management` · **Backends** tab | Create/Edit/Delete buttons have no `onClick`. Dialog state + `openCreate`/`openEdit`/`handleSave` are defined but never wired — CRUD UI is dead. | `lib/components/admin/apim-backends-pane.tsx:80` (Create), `:94` (Edit), `:101` (Delete); callbacks at `:60-78` | Wire `onClick={(e)=>{e.stopPropagation(); openCreate();}}` to Create, `openEdit(b)` to Edit, `setDeleting(b)` to Delete. Dialog + handlers already exist below. |
| `/admin/api-management` · **APIs** tab | Edit/Delete/Create buttons have no `onClick`; no dialog/form state defined at all. | `lib/components/admin/apim-apis-pane.tsx:94-107` (Edit/Delete), `:128` (Create) | Implement dialog/form state (mirror Backends or Subscriptions pane). Minimum acceptable: `onClick` showing an `intent="info"` MessageBar instead of a silent no-op. |
| `/admin/api-management` · **Products** tab | Edit/Delete/Create buttons have no `onClick`; no dialog/form state. | `lib/components/admin/apim-products-pane.tsx:93-106` (Edit/Delete), `:126` (Create) | Same as APIs tab — implement dialog/handlers or honest `intent="info"` MessageBar. |
| `/admin/api-management` · **Named values** tab | Edit/Delete/Create buttons are purely decorative; no dialog/form state. | `lib/components/admin/apim-named-values-pane.tsx:93, 96, 117` | Wire `onClick` to a dialog (implement or stub). Currently blocks day-one CRUD on named values. |

**Shared root cause:** APIM pane components ship buttons without handlers. Backends has the full dialog/state machinery but is unwired (smallest fix); APIs/Products/Named-values need state machinery built or an honest gate. Fix Backends first as the reference implementation, then replicate.

---

## 2. NEEDS day-one config — honest gates (not bugs)

All 10 findings are honest `MessageBar` gates naming the exact env var/role/resource. They collapse into **3 shared root causes** plus 2 standalone items. Setting these few config values clears all 10.

### Root cause A — Microsoft Purview not configured (`LOOM_PURVIEW_ACCOUNT`) — gates 3 surfaces
| Surface | Fix |
|---|---|
| `/onelake` · Govern tab (`app/onelake/page.tsx:847-849`) | Set `LOOM_PURVIEW_ACCOUNT`; grant Console UAMI **Data Curator** on Purview. Enables live MIP sensitivity-label taxonomy. |
| `/catalog/metastores` · Purview registration (`app/catalog/metastores/page.tsx:613`) | Set `LOOM_PURVIEW_ACCOUNT` (provisioned classic account). Enables Databricks UC scan registration. |
| `/catalog/domains` · Purview Data Map (`app/catalog/domains/page.tsx:357`) | Set `LOOM_PURVIEW_ACCOUNT`. Enables domain→collection mirroring. |

### Root cause B — Databricks Unity Catalog not configured (`LOOM_DATABRICKS_ACCOUNT_ID` / `LOOM_DATABRICKS_HOSTNAME` + account-admin) — gates 3 surfaces
| Surface | Fix |
|---|---|
| `/catalog/metastores` · Unified Catalog (`app/catalog/metastores/page.tsx:384`) | Set `LOOM_DATABRICKS_ACCOUNT_ID`; ensure Console UAMI is **Databricks account admin**. |
| `/catalog/metastores` · One-click attach (`app/catalog/metastores/page.tsx:509-510`) | Set `LOOM_DATABRICKS_ACCOUNT_ID` in admin-plane bicep (account API creds). |
| `/catalog/domains` · UC mirror (`app/catalog/domains/page.tsx:316`) | Set `LOOM_DATABRICKS_HOSTNAME`; grant Console UAMI **CREATE CATALOG** on the metastore. |

### Root cause C — Azure AI Search not deployed (`LOOM_AI_SEARCH_SERVICE`) — gates 2 surfaces (falls back to Cosmos)
| Surface | Fix |
|---|---|
| `/onelake` · Explore tab (`app/api/onelake/catalog/route.ts:89-96`) | Deploy `ai-search.bicep`, set `LOOM_AI_SEARCH_SERVICE` in `admin-plane/main.bicep`, run reindex. Restores full-text search facets (Cosmos-only fallback works meanwhile). |
| `/governance/catalog` (`app/api/governance/catalog/route.ts:65-92`) | Deploy `ai-search.bicep`, set `LOOM_AI_SEARCH_SERVICE`. Enables semantic search facets (Cosmos fallback works meanwhile). |

> Note: surfaces under root causes A/B degrade to honest gates; surfaces under C degrade gracefully to a Cosmos fallback (still functional, just no full-text facets).

---

## 3. Areas that are clean (no findings)

- **Admin governance** — Security & Governance (Purview/Information Protection/DLP/DSPM/Audit/SHIR), Batch labeling, Classifications, Sensitivity labels, Feature permissions, Custom attributes, Audit logs, Embed codes, Organizational visuals, Copilot usage. All gates honest, all routes wired.
- **Domains / Landing zones / MCP Servers / Deployment planner / Network & DNS** — real backends (Cosmos, ARM, Resource Graph), honest gates for optional features (MCP bridge, built-in tools, VNet gateway), no Fabric default-path deps.
- **Monitor** (all 12 tabs) — Overview, Activities, Metrics, Logs(KQL), Diagnostics, Activity log, Deployed items, Refresh summary, Alerts, Cost, Security, Maintenance. Real Azure REST, lazy mounting, honest env-var-specific gates, full error taxonomy.
- **Warp/Weave/Thread, Warehouse, Lakehouse, Notebook, Semantic model, Data products, Deployment pipelines, Real-time hub, item editors** — real BFF endpoints, auth checks, honest gates, Azure-native defaults (no hard Fabric dep). Warehouse/Notebook/Lakehouse labeled "legacy stub" but internally execute real SQL/compute/Delta scans.
- **Learning Hub, Copilot, Data agents, API marketplace, Connections, Workspaces, Activator, Business events, Workload hub, Browse** — all wired to real Azure-native Cosmos/AI BFF routes, honest gates, all handlers/states rendered.

> Note: the **APIM admin pane** (root cause of all 4 BLOCKING bugs) lives in the Admin-portal-core area; the rest of that area (Health/self-audit, Tenant settings, Capacity & compute, Scale by SKU, Runtime config, Updates, Users & licenses, Workspaces) reported no issues.
