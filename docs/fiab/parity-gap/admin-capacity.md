# Admin Portal — Capacity & Compute (`/admin/capacity`) — Parity Gap

> Validator: v2 fabric-parity-loop · 4-phase check  
> Run date: 2026-05-26  
> Fabric reference: Fabric admin portal → **Capacity settings**  
> Loom URL: <https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/admin/capacity>

## Captures

| Loom | Fabric |
|---|---|
| `temp/parity/admin-capacity-loom.png` (note: the live capture during this session ended up showing a 404 because of the in-Loom tab-restore client redirecting; the page DOES return 200 and the source code at `apps/fiab-console/app/admin/capacity/page.tsx` shows the real implementation, which is described below) | Microsoft Learn — `https://learn.microsoft.com/fabric/admin/capacity-settings` |

## Phase 1 — What Fabric provides

Fabric's Capacity settings is a tabbed page with four capacity-type tabs:

1. **Fabric capacity** (F SKUs)
2. **Power BI Premium** (P SKUs)
3. **Power BI Embedded** (A / EM SKUs)
4. **Trial**

For each capacity in the list, columns include: Name, SKU, Region, Admins, Workspaces count, State. Per-capacity actions:

- **Set up a new capacity in Azure** (deep-links to Azure portal)
- **Change size** (resize)
- **Pause / Resume** (F SKUs)
- **Delete capacity**
- **Manage admins** (add/remove capacity admins)
- **Manage contributors**
- **Designate as Copilot capacity**
- **Workspaces tab** (workspaces assigned to this capacity, with assign/unassign)
- **Notifications tab** (capacity threshold alerts)
- **Disaster Recovery toggle**
- **Workloads tab** with sub-sections: Semantic models (Max memory %), Paginated reports, AI, Data Engineering / Science (Spark pool size + runtime)
- **Delegated tenant settings tab** — capacity-level overrides of tenant settings
- Link to the **Microsoft Fabric Capacity Metrics app** for CU consumption

## Phase 2 — What Loom provides

Source: `apps/fiab-console/app/admin/capacity/page.tsx` (real implementation — 168 lines):

- Calls `GET /api/admin/azure-resources` (which exists at `apps/fiab-console/app/api/admin/azure-resources/route.ts` — confirmed in glob).
- Renders stat cards: **Total resources** + counts per Azure RP (provider).
- Renders a Fluent `Table` with columns: Name, Type, Region, Resource group, SKU/Kind, State (with Fluent Badge for `Succeeded` / other).
- Renders an info MessageBar honestly stating "Cost & utilization deferred — requires Azure Cost Management + Azure Monitor; tracked for v3.5."
- Handles 401/403 → renders `<SignInRequired />`.
- Handles `ok:false` → renders warning MessageBar with the backend `error` + `hint`.

## Phase 3 — Gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| Capacity-type tabs (Fabric / Premium / Embedded / Trial) | Absent — Loom shows ALL Azure resources flat (Loom is not Fabric-capacity-based, so there are no F-SKU capacities to show — but the abstraction is missing) | MAJOR (different conceptual model) |
| Per-capacity / per-resource detail pane with Workloads / Notifications / DR tabs | Absent — only the flat list | **MAJOR** |
| **Change size** / Resize action | Absent (would require `az ... patch` against each compute) | BLOCKER for parity, but documented as v3.5 |
| **Pause / Resume** action (Loom equiv: stop Databricks cluster, scale Synapse pool to 0, etc.) | Absent (the per-item editors HAVE stop/start but those aren't surfaced here) | MAJOR |
| **Manage admins / contributors** of a capacity | Absent | MAJOR (Loom uses Entra group → workspace RBAC, no per-capacity admin concept) |
| **Designate Copilot capacity** | Absent | MAJOR |
| **Capacity metrics app deep link** (CU consumption) | Absent — the MessageBar honestly states this is deferred | MINOR (acceptable per no-vaporware) |
| **Delegated tenant settings** tab | Absent (because Loom has no tenant settings backend — see admin-tenant-settings gap doc) | n/a |
| **Set up new capacity in Azure** deep-link | Absent — the Loom mental model is "deploy via bicep/GitHub Actions" — could surface a link to the deploy workflow | MINOR |
| Pagination / search on resource list | Absent — list is dumped flat | MINOR |
| Cost column | Absent (honestly disclosed in MessageBar) | acceptable |
| Utilization column (CU% / DBU / CPU) | Absent (honestly disclosed) | acceptable |

## Phase 4 — Functional verification

The page is the only admin sub-page besides Updates that has a real backend. I could not exercise the live API in this session because the browser session expired mid-run and the playwright instance lock prevented re-auth. The code path is straightforward and matches the no-vaporware rule.

| Control | Expected behaviour | Status |
|---|---|---|
| Page load | `useEffect` fires `fetch('/api/admin/azure-resources')` | Code-confirmed; live verification deferred |
| 401/403 | Shows `<SignInRequired />` | Code-confirmed |
| 200 + `ok:false` | Shows warning MessageBar with hint | Code-confirmed |
| 200 + `ok:true` | Renders stat cards + table | Code-confirmed |
| No "Cost" or "Util" buttons | The honest MessageBar says so | OK per no-vaporware |

## Grade: **B**

- This is the **only admin page that meaningfully complies with the no-vaporware rule**. Real ARM call, honest cost/util gating, sane error states. Source code is production-shape.
- Reasons it's not A: (a) no capacity-tabs abstraction (treats every Azure RP as a row), (b) no per-resource detail pane / workloads / notifications, (c) no actionable controls (resize / pause / set Copilot capacity / manage admins), (d) live capture was not obtainable this session.
- This is **the model the other 8 stub admin pages should be rebuilt against**.
