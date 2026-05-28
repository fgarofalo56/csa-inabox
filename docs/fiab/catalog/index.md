# Unified Catalog (CSA Loom)

The Unified Catalog is the single in-Loom surface for discovering, governing, and granting access to data assets — without leaving the console to bounce between Microsoft Purview, Databricks Unity Catalog, and Microsoft Fabric / OneLake.

## What it federates

| Source | What we pull | API |
|---|---|---|
| **Microsoft Purview** | Business domains, data products, Atlas catalog search, lineage subgraph, classifications | `{account}-api.purview.azure.com` (Unified Catalog + Datamap) |
| **Databricks Unity Catalog** | Metastores, catalogs, schemas, tables, volumes, REST + SQL `GRANT`/`REVOKE` permissions, table-level lineage | `https://{workspace}/api/2.1/unity-catalog/*` + `/api/2.0/lineage-tracking/*` + `/api/2.0/sql/statements` |
| **Microsoft Fabric / OneLake** | Workspaces, items (lakehouse / warehouse / KQL DB / semantic model / mirrored DB / notebook / data pipeline), workspace role assignments, admin scan lineage | `api.fabric.microsoft.com/v1/workspaces/*` + `/v1.0/myorg/admin/workspaces/scan*` |

## Tabs

1. [**Search**](search.md) — single search box across all three back-ends with per-source result tagging and partial-success handling
2. [**Browse**](browse.md) — lazy-loaded tree rooted at Source → Workspace/Metastore → Schema/Domain → Asset
3. [**Domains**](domains.md) — Purview business-domain CRUD
4. [**Permissions**](permissions.md) — Loom-native role matrix (`Reader` / `Contributor` / `Admin` / `Owner`) that fans out to UC privileges + Fabric workspace roles
5. [**Metastores**](metastores.md) — registered Databricks metastores, OneLake workspaces, and the Purview account configured for the tenant
6. [**Lineage**](lineage.md) — federated lineage graph (Purview Atlas + UC lineage tracking + Fabric admin scan)
7. [**Asset detail**](asset-detail.md) — per-asset page with schema preview, classifications, lineage subgraph, cross-source action panel, and an "Open in upstream tool" deep link as a fallback

## Cross-source operations

The asset detail page exposes a single panel that fans the current asset out to the other two stores. Every action posts to a real BFF route that calls the live Azure REST endpoints — there is no faked client-side state.

| Action | From source | BFF route | Backend |
|---|---|---|---|
| Register in Purview | unity-catalog, onelake | `POST /api/catalog/register` | Atlas `POST /datamap/api/atlas/v2/entity` with `databricks_table` or `fabric_lakehouse` typeName + deterministic qualifiedName |
| Create glossary term + apply | any | `POST /api/catalog/glossary` | Atlas glossary v2 `POST /glossary/term` + `/terms/{guid}/assignedEntities` |
| Promote ADLS path → OneLake shortcut | onelake | `POST /api/catalog/shortcut` | Fabric `POST /workspaces/{ws}/items/{item}/shortcuts` (zero-copy ADLS Gen2 / S3 / GCS targets), optionally chained with an Atlas register so the shortcut appears in federated search |
| Grant / revoke privileges | unity-catalog, onelake | `POST /api/catalog/permissions` (DELETE for revoke) | UC REST `PATCH /permissions/<sec>/<name>` or live `GRANT … TO` via SQL warehouse; Fabric `POST /workspaces/{ws}/roleAssignments` |

## Architecture (one line per layer)

- **Front-end**: `apps/fiab-console/app/catalog/` — Next.js pages, Fluent UI, shared `CatalogShell` left rail
- **BFF routes**: `apps/fiab-console/app/api/catalog/{search,browse,domains,permissions,metastores,lineage,asset/[id]}/route.ts` — session-gated; return `{ok, …}` with `hint` payloads on 501 NotConfigured
- **Clients**: `apps/fiab-console/lib/azure/{purview-client.ts, unity-catalog-client.ts, onelake-catalog-client.ts}` — real Azure REST, no mocks
- **Bicep**: `platform/fiab/bicep/modules/admin-plane/main.bicep` (catalog dispatcher), `app-deployments.bicep` (env vars `LOOM_PURVIEW_ACCOUNT`, `LOOM_DATABRICKS_HOSTNAMES`, `LOOM_FABRIC_BASE`)

## NotConfigured behaviour (per `no-vaporware.md`)

Each back-end is queried independently. When a back-end is not provisioned the federated search and the per-tab pages render a `MessageBar intent="warning"` with the precise:

- env var that's missing
- bicep module that would deploy it
- one-time admin grant required (e.g. UC metastore admin add, Purview Data Curator role, Fabric "service principals can use APIs" tenant setting)

The page never silently returns an empty list when a back-end is down.
