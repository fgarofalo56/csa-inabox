# Purview tab (`/admin/security` → Purview)

Inline management for the Purview-backed data plane. Every action calls the real Purview REST API via the Console UAMI ChainedTokenCredential.

## Sub-tabs

### Data sources

- **List** — `GET /scan/datasources`. Renders Name, Kind, Endpoint, Collection.
- **Register source** — `PUT /scan/datasources/{name}` with `{ kind, properties: { endpoint } }`. The dialog supports Azure SQL Database, ADLS Gen2, Synapse, Databricks, Blob, Snowflake, Oracle, SAP ECC.
- **De-register source** — `DELETE /scan/datasources/{name}`. Idempotent (returns `deleted: false` on 404).

BFF route: `apps/fiab-console/app/api/admin/security/purview/sources/route.ts`.

### Scans

- **List per source** — `GET /scan/datasources/{source}/scans`.
- **Trigger run** — `PUT /scan/datasources/{source}/scans/{scan}/runs/{runId}` (Loom mints the runId as `loom-{epoch}`). Returns 202 with the runId.
- **Last 10 runs** — `GET /scan/datasources/{source}/scans/{scan}/runs`. Status / startTime / errorMessage rendered per row.

BFF route: `apps/fiab-console/app/api/admin/security/purview/scans/route.ts`.

### Classifications

Defers to the existing `/api/governance/classifications` route (Cosmos-derived classification hits across the tenant) with a link out to the dedicated `/governance/classifications` page.

### Glossary

- **List terms** — `GET /catalog/api/atlas/v2/glossaries` to find the first glossary, then `GET /catalog/api/atlas/v2/glossary/{guid}/terms?limit=200`.
- **Create term** — `POST /catalog/api/atlas/v2/glossary/term` with `{ name, anchor: { glossaryGuid }, shortDescription, longDescription, status: 'Draft' }`.

BFF route: `apps/fiab-console/app/api/admin/security/purview/glossary/route.ts`.

### Governance domains

- **List** — `GET /datagovernance/catalog/businessdomains`.
- **Create** — `POST /datagovernance/catalog/businessdomains` with `{ name, displayName, description, type }`.

These are the GUIDs that `state.domain` on a data-product item must reference before `POST /api/items/data-product/{id}/register-purview` will succeed.

BFF route: `apps/fiab-console/app/api/admin/security/purview/domains/route.ts`.

### Data quality (Preview)

- **List rules** — `GET /datagovernance/dataquality/rules`. The Purview DQ endpoint is in public preview as of this build. Some tenants 404 this entirely — the route renders `note: "preview not enabled"` rather than faking results.

BFF route: `apps/fiab-console/app/api/admin/security/purview/dataquality/route.ts`.

### Sensitivity / Lineage

Direct deep-links to the existing `/governance/sensitivity` and `/governance/lineage` pages (already real-data-backed).

## Not-configured behaviour

If `LOOM_PURVIEW_ACCOUNT` is unset, every sub-tab returns HTTP 503 with a `code: purview_not_configured` payload that the panel renders as a MessageBar with:

- the missing env var,
- the bicep module that would deploy a Purview account (`platform/fiab/bicep/modules/purview/` — not yet committed; phase 6 of the data-product parity spec adds it),
- the two governance-domain RBAC roles required (Data Curator, Data Product Owner — granted in the Purview portal, NOT ARM RBAC),
- a deep-link to `https://web.purview.azure.com/resource/sources` as a fallback while the bicep is missing.

## Source files

- Panel: `apps/fiab-console/lib/components/admin-security/purview-panel.tsx`
- Client: `apps/fiab-console/lib/azure/purview-client.ts`
- Routes: `apps/fiab-console/app/api/admin/security/purview/**`
- Vitest: `apps/fiab-console/lib/azure/__tests__/purview-client.extensions.test.ts`
