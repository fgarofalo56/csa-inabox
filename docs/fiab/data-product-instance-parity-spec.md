# Loom Data Product Instance Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. Sources: Microsoft Learn — [Create and manage data products (Purview Unified Catalog)](https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage), [Unified Catalog data product access policies](https://learn.microsoft.com/purview/unified-catalog-data-product-access-policies), [Sample setup for data governance](https://learn.microsoft.com/purview/data-governance-setup-sample), [Use Microsoft Purview to govern Microsoft Fabric](https://learn.microsoft.com/fabric/governance/microsoft-purview-fabric), [OneLake catalog overview](https://learn.microsoft.com/fabric/governance/onelake-catalog-overview), [Set up data quality for Fabric Lakehouse data](https://learn.microsoft.com/purview/unified-catalog-data-quality-fabric-lakehouse). Cross-checked against current Loom editor at `apps/fiab-console/lib/editors/data-product-editors.tsx::DataProductInstanceEditor` and the instantiate route at `app/api/items/data-product-template/[id]/instantiate/route.ts` (which creates the parent `data-product-instance` item).

## What it is

A **data-product-instance** is the materialized result of instantiating a template. It is a parent Loom item that:
- Records which template it was spawned from
- Links to the child items that were created (lakehouse, pipeline, eventhouse, vector-store, etc.)
- Tracks per-component health, instantiation errors, last-refresh metadata
- Is the surface where consumers request access, view lineage, and check data quality

The Microsoft analogue is a **published Purview Unified Catalog data product** in its consumer-facing role: the page a data consumer hits when they discover the product in the catalog, see what assets it bundles, and request access via the configured policy workflow.

## UI components

### Page chrome
- Title bar: instance display name + saved-state indicator + lifecycle badge (Draft / Published / Expired)
- Top toolbar: **Refresh**, **Health check**, **Request access**, **Share**, **Unpublish**, **Set to expired**, **Manage policies**, **View lineage**

### Left rail — Instance metadata
- Display name (read-only post-create; the documented Purview pattern allows the owner to edit pre-publish)
- Source template slug + link
- Owner(s) (with avatars)
- Governance domain
- Audience badge
- Endorsement badge (Endorsed / Certified / Promoted)
- Sensitivity label (inherited from the highest-classified component)
- Created at / Updated at / Instantiated at

### Main pane — six tabs

#### Tab 1: Overview
- Use-case narrative (markdown)
- Description (markdown, up to 10,000 chars per Purview)
- Custom attributes (key-value table from the governance-domain config)
- Linked glossary terms
- References / Learn links

#### Tab 2: Components
- Table: `display name | item type | item id | status | health`
- Each row links to the child item's editor
- Status: `provisioned` / `failed` / `running` / `paused`
- Health: green / amber / red based on the child item's last-refresh timestamp + per-type rules (lakehouse: last write < 24h green; pipeline: last successful run < expected cadence; eventhouse: ingestion lag < 5 min; etc.)
- Bulk actions: **Refresh all**, **Pause all** (where supported by the child item type)

#### Tab 3: Access
- Current access policy summary (from the source template + per-instance overrides)
- **Request access** button (visible to non-owners, hidden for owners) → opens a request flow that captures: justification (free text), required time window, target purpose; routes via the configured approval chain
- Pending requests table (owner-only)
- Granted access list (who, what scope, when granted, when expires)
- **Manage policies** flyout (owner-only) — same form as the template's policy editor but instance-scoped

#### Tab 4: Quality
- Data-quality scorecard per component (Purview data quality scan results when the child is a lakehouse / warehouse / KQL DB)
- Last scan timestamp + next-scan ETA
- Per-asset quality dimensions: completeness, accuracy, freshness, conformity, uniqueness — sourced from Purview Data Quality
- **Run quality scan now** button (gated on Purview data-quality-steward role)

#### Tab 5: Lineage
- Visual lineage graph: upstream sources → components → downstream consumers
- Hops out to: Fabric items (via OneLake catalog), ADF / Synapse pipelines (via Purview integration runtime), Power BI reports, downstream apps registered via APIM
- Click any node → opens that item's editor in a new tab

#### Tab 6: Activity / Audit
- Recent events from Purview Audit + Fabric Audit + Loom session log
- Filter by: actor, event type (read, modify, access-request, policy-change, publish, expire)
- Insider-risk indicators surfaced when Purview IRM has flagged a related activity

### Partial-failure surface
- When the instantiate route returned `errors[]` (components that failed to spawn), an `intent="warning"` MessageBar lists each failure with the slug, the error string, and a **Retry component** button that re-attempts `createOwnedItem` for just that component

### Share dialog
- Sensitivity-label-aware (warns when sharing a Confidential-labeled product externally)
- People + group picker (Microsoft Entra)
- Role: Reader / Contributor / Owner
- **Notify recipient** toggle

## What Loom has

The current `DataProductInstanceEditor` (`apps/fiab-console/lib/editors/data-product-editors.tsx`, lines 157-215) is mostly functional but minimal:

- GET against `/api/items/data-product-instance/[id]` fetches the parent item from Cosmos
- Left rail shows the display name + the source template slug (read from `state.template`)
- Main pane shows a single **Components** table with `display name | item type | item id`; each display name is a working link to the child item editor
- Partial-failure MessageBar renders `state.errors[]` from the instantiation result (per-component failures captured at spawn time)
- Ribbon advertises **Refresh** and **Health** ribbon actions but they are placeholders
- Grade: **C (functional but rough)** — the components table is real and links to real children, but every governance / quality / lineage / access surface is missing

## Gaps for parity

1. **Governance / publication state machine absent** — no Draft / Published / Expired badge, no Publish / Unpublish / Set-Expired actions. Purview requires this lifecycle.
2. **Access tab absent** — no **Request access** button, no pending-requests view, no granted-access list, no policy override editor. This is the single biggest gap; the whole point of Purview data products is governed access.
3. **Quality tab absent** — Purview Data Quality scorecard not surfaced; the documented [Fabric Lakehouse data quality setup](https://learn.microsoft.com/purview/unified-catalog-data-quality-fabric-lakehouse) describes this UX as a first-class consumer view.
4. **Lineage tab absent** — Purview lineage graph is one of the headline value props; not surfaced.
5. **Activity / Audit tab absent** — Purview Audit + Fabric Audit + IRM insights are documented integration points.
6. **Health computation absent** — the components table has no Health column even though the editor's docstring claims it ("Health column is best-effort — peeks at child items' updatedAt"). Vaporware-rule violation: either implement or remove from the docstring.
7. **Refresh-all / Pause-all bulk actions absent** — placeholder ribbon labels.
8. **Retry-component action absent** — partial failures render but can't be retried inline.
9. **Share dialog absent** — no people/group picker, no sensitivity-label warning.
10. **Custom attributes absent** — Purview's per-business-concept custom attributes are not displayed even when set on the source template.
11. **Endorsement badge absent**.
12. **Sensitivity label absent** — the component with the highest classification should propagate up; not modeled.
13. **Created-at / Updated-at metadata not surfaced in the left rail** — present in Cosmos doc but not rendered.
14. **No OneLake catalog cross-link** — when the instance bundles Fabric items, the editor should deep-link to the OneLake catalog entry for each.

## Backend mapping

| Loom surface | Backing service | Notes |
|---|---|---|
| Instance persistence + components list | Cosmos `items` container, partition `data-product-instance` (already wired by the instantiate route) | No change |
| Per-component health | Each child item type already exposes a status / last-refresh signal: Fabric REST `GET /v1/workspaces/{ws}/items/{id}/status`, KQL `.show database tables stats`, lakehouse OneLake `_metadata`, ADF `runs/queryByPipelineRun` | New BFF route `/api/items/data-product-instance/[id]/health` fan-outs to each child's existing status endpoint and aggregates |
| Governance state machine | Purview Unified Catalog REST `PATCH /datagovernance/catalog/dataProducts/{id} {state: ...}` | Mirror the source-template state in the instance |
| Access request workflow | Purview REST `POST /datagovernance/catalog/dataProducts/{id}/accessRequests` body `{justification, scope, durationDays}` | Notifications via the documented approver-chain |
| Quality scorecard | Purview Data Quality `GET /datagovernance/dataQuality/dataProducts/{id}/scores` | Per documented [Fabric lakehouse data quality](https://learn.microsoft.com/purview/unified-catalog-data-quality-fabric-lakehouse) |
| Lineage graph | Purview Lineage REST `GET /catalog/api/atlas/v2/lineage/{guid}` for the linked Purview asset id | Render with vis-network / Cytoscape |
| Activity / Audit | Purview Audit `POST /office/auditlogs/searches` + Fabric Audit `GET /admin/auditlog/events` + Loom session log | Three sources merged client-side |
| Sensitivity label propagation | Each component item's `state.sensitivityLabel` (computed by Purview Information Protection scanning); aggregate max | Cached on the instance doc |
| Endorsement badge | Fabric item endorsement (`endorsementStatus` field) on each Fabric-resident component; aggregate "the lowest of all components" | Cached on the instance doc |
| Retry component | Existing `createOwnedItem` from `_lib/item-crud` — re-call for the specific component slug | No new backend |

## Required Azure resources

- **Microsoft Purview account** with Unified Catalog enabled (shared with the template spec)
- **Purview Data Quality** workload enabled on the account (tenant-level toggle; document in `docs/fiab/v3-tenant-bootstrap.md`)
- **Purview Lineage scanning** configured against the workspaces hosting Loom's child items (existing bootstrap: scan jobs for ADF, Synapse, Fabric)
- **AAD permissions**: `Purview.Read.All` delegated for read; `Purview.ReadWrite.All` for owner actions; **Data Steward** or **Data Quality Steward** for quality-scan kickoff
- **Fabric capacity** for the OneLake catalog cross-links
- **No new resource** for the Loom-internal instance doc

## Estimated effort

- **Session N+1 (~3 hrs)** — Health column computation (fan-out + aggregate per-component); Refresh-all / Retry-component actions; remove vaporware ribbon labels
- **Session N+2 (~3 hrs)** — Access tab: Request-access button + pending-requests view + granted-access list + Manage policies flyout (reuses Purview client from template spec)
- **Session N+3 (~3 hrs)** — Quality tab: Purview Data Quality scorecard + Run-scan-now action
- **Session N+4 (~3 hrs)** — Lineage tab: Purview lineage REST + visualization (reuses graph viz component from gremlin/cypher/gql editors)
- **Session N+5 (~2 hrs)** — Activity/Audit tab: merge Purview Audit + Fabric Audit + Loom session log
- **Session N+6 (~2 hrs)** — Governance state machine (Publish/Unpublish/Set-Expired), Share dialog, endorsement + sensitivity-label badges, custom attributes, OneLake cross-links
- **Session N+7 (~1 hr)** — Vitest + Playwright UAT covering: instantiate a template → see all six tabs populate → request access → owner approves → consumer queries one of the child items

Total: **~17 hrs** across 7 sessions. Current grade: **C**. Target: **A+** — together with the template spec, this is the most consequential editor pair because it determines whether Loom's "push-button data product" story is governance-grade or marketing-only.
