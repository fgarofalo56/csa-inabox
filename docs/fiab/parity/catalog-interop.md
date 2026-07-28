<!-- parity-doc-meta
Reviewed-on: 2026-07-28
Validated-against:
  - apps/fiab-console/app/governance/interop/page.tsx
  - apps/fiab-console/lib/catalog/interop/model.ts
  - apps/fiab-console/lib/catalog/interop/datahub.ts
  - apps/fiab-console/lib/catalog/interop/openmetadata.ts
  - apps/fiab-console/lib/catalog/interop/ingest.ts
  - apps/fiab-console/lib/catalog/interop/export-source.ts
  - apps/fiab-console/app/api/catalog/interop
  - apps/fiab-console/lib/lineage/openlineage.ts
-->

# catalog-interop — parity with **DataHub ingestion (file source) + OpenMetadata metadata import**

Source formats:

- DataHub metadata model — Dataset entity + `DatasetProperties` / `Ownership` /
  `GlobalTags` / `GlossaryTerms` / `SchemaMetadata` / `UpstreamLineage` aspects,
  <https://datahubproject.io/docs/generated/metamodel/entities/dataset>
- DataHub `file` source (MetadataChangeEvent stream),
  <https://datahubproject.io/docs/generated/ingestion/sources/file>
- OpenMetadata entity + lineage APIs, <https://docs.open-metadata.org/swagger.html>
- OpenLineage 1.x RunEvent (the vendor-neutral third leg, already emitted by N17),
  <https://openlineage.io/docs/spec/object-model>

> **Scope note (sovereign, no SaaS dependency).** Loom SPEAKS these formats; it
> never calls a DataHub or OpenMetadata service. Export produces a JSON file (or
> an inline preview) that the operator moves; ingest accepts a pasted payload.
> No Fabric/Power BI/OneLake host is contacted on any path, and no external
> network egress is required for either direction.
>
> **Rides N17.** Asset identity is `lineage/openlineage.datasetUriForItem` — the
> SAME function the OpenLineage emitter and `/api/lineage/openlineage/export`
> use. DataHub URNs embed that URI, OpenMetadata FQNs prefix it with the `loom`
> service, and the OpenLineage leg uses it directly, so all three formats name
> one graph and an ingest resolves straight back to the originating item. The
> OpenLineage leg is serialized by N17's `unifiedGraphToOpenLineageEvents` —
> there is no second lineage serializer.

## Format feature inventory → Loom coverage

| Capability | Loom | Encoding |
|---|---|---|
| Dataset entity with a stable URN/FQN | ✅ | `urn:li:dataset:(urn:li:dataPlatform:loom,<uri>,PROD)` / `loom.<uri>` |
| Display name + description | ✅ | `DatasetProperties.name/description` · OM `displayName`/`description` |
| Custom properties (source-system identity) | ✅ | `customProperties.loomItemId/loomItemType/loomWorkspaceId/…` · OM `extension.*` |
| Ownership | ✅ | `Ownership.owners[] → urn:li:corpuser:<upn>` (DATAOWNER) · OM `owners[]` |
| Tags | ✅ | `GlobalTags.tags[] → urn:li:tag:<tag>` · OM `tags[].tagFQN` (Classification) |
| Governance classifications | ✅ | Merged into the tag set (Loom `state.classifications`) |
| Sensitivity label | ✅ | `GlossaryTerms → urn:li:glossaryTerm:Sensitivity.<label>` · OM tag `Sensitivity.<label>` |
| Endorsement (Certified / Promoted) | ✅ | `customProperties.loomEndorsement` · OM tag `Endorsement.<value>` |
| Schema / columns | ✅ | `SchemaMetadata.fields[]` · OM `columns[]` |
| Table-level lineage | ✅ | `UpstreamLineage` on the DOWNSTREAM dataset (DataHub semantics) · OM `AddLineage` edge list |
| Vendor-neutral lineage export | ✅ | `?format=openlineage` → N17 `unifiedGraphToOpenLineageEvents` |
| Scope to one workspace | ✅ | `?workspaceId=` |
| Lineage opt-out | ✅ | `?lineage=false` |
| Download as a file | ✅ | `?download=true` → `content-disposition: attachment` |
| Ingest: DataHub MCE | ✅ | `parseDataHubMces` |
| Ingest: OpenMetadata payload | ✅ | `parseOpenMetadata` |
| Ingest: dry-run plan before any write | ✅ | `POST /api/catalog/interop/ingest` without `apply` → typed plan |
| Ingest: apply | ✅ | `apply: true` → Cosmos `items` patch + `recordThreadEdge` |
| Ingest: per-row skip reasons | ✅ | `unknown-item` / `no-change` + `unresolved` (foreign-platform URNs) |
| Foreign-platform URN | ⚠️ reported, never guessed | A non-`loom` platform URN cannot resolve to a Loom item; it is surfaced in `unresolved`, not silently dropped |
| Export size ceiling | ⚠️ disclosed | 2,000 assets per call; `truncated: true` renders a warning MessageBar telling the operator to narrow scope |

**Zero ❌.**

## Merge semantics (ingest)

Additive and non-destructive, by design:

| Field | Rule |
|---|---|
| Owners | UNION (case-insensitive); Loom's existing owners are never removed |
| Tags | UNION (case-insensitive) |
| Description | Written ONLY when Loom has none — an external catalog can never overwrite Loom curation |
| Sensitivity label | Written ONLY when Loom has none — labels are a governance decision, not an import |
| Lineage | Recorded through `recordThreadEdge` (action `catalog-interop-ingest`), the SAME sink the N17 OpenLineage emitter writes to, so backfilled edges merge into the unified lineage graph |

## Backend per control

| Control | Backend |
|---|---|
| Preview export / Download JSON | Cosmos `loom-workspaces` + `items` (real catalog) + `thread-edges` (real Weave lineage) → `datahub.ts` / `openmetadata.ts` / N17 OL serializer |
| Preview changes (ingest dry-run) | Same Cosmos read + pure `planIngest` — zero writes |
| Apply | Cosmos `items` read-modify-write + `recordThreadEdge` |
| Audit | `emitAuditEvent` on `catalog.interop.export` and `catalog.interop.ingest` (an export IS a metadata egress event) |
