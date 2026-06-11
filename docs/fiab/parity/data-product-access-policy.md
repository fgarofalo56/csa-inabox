# data-product-access-policy — parity with Microsoft Purview "Manage policies" (data product access)

Source UI: Microsoft Purview portal → Unified Catalog → Data product →
**Manage access / Access policies**
(Learn: <https://learn.microsoft.com/purview/unified-catalog-access-policies>,
<https://learn.microsoft.com/purview/data-product-self-service-access>).

CSA Loom surface: `DataProductEditor` → ribbon **Govern → Manage policies**
(and the **Access policies** tab) →
`lib/editors/components/manage-policies-dialog.tsx`.

Azure-native, no Fabric/Power BI dependency — the policy is persisted to the
`data-product` item's `state.accessPolicy` in the Cosmos `items` container and
works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Purview feature inventory

| # | Purview capability | Notes |
|---|--------------------|-------|
| 1 | Manage access only while the product is **unpublished** | Purview blocks policy edits on a published product |
| 2 | **Permitted use** — list of allowed purposes consumers must pick from | Defaults: Analytics, ML, Product development |
| 3 | Add a custom purpose (name + description) | Inline form |
| 4 | Remove a purpose | |
| 5 | **Require manager approval** tier toggle | |
| 6 | **Require privacy & compliance review** tier toggle | |
| 7 | **Access request approvers** — named Entra users/groups | Directory picker |
| 8 | **Access provider** — who provisions the grant on approval | Single principal |
| 9 | Ordered **multi-tier approval sequence** preview | manager → privacy → approver → provider |
| 10 | Persist policy + drive the consumer **access-request** flow | The saved policy gates T13 self-service requests |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | `isPublished` disables every control + MessageBar; PUT route returns HTTP 409 `published_locked` as a server backstop. `apimPublished` is stamped by `publishApimMirror` and persisted to Cosmos |
| 2 | built ✅ | `allowedPurposes` table; `DEFAULT_PURPOSES` seeded on first open |
| 3 | built ✅ | Inline add-purpose form (name + description Inputs + Add button) |
| 4 | built ✅ | Per-row Delete button |
| 5 | built ✅ | "Require manager approval" `Switch` |
| 6 | built ✅ | "Require privacy and compliance review" `Switch` |
| 7 | built ✅ | `PrincipalPicker` (multi) — live Microsoft Graph search via `/api/data-products/[id]/principal-search`; chips show resolved **UPN**; no free-text |
| 8 | built ✅ | `PrincipalPicker` (single) for the access provider |
| 9 | built ✅ | Tier-sequence preview (`policyTiers`) with `Badge` chips + `ChevronRight` separators; auto-approve caption when empty |
| 10 | built ✅ | `PUT /api/data-products/[id]/access-policy` persists `state.accessPolicy`; the access-request flow (T13/T14) reads it; real grant enforcement at approval time via `lib/azure/access-policy-client.ts` |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Load / save policy | `GET`/`PUT /api/data-products/[id]/access-policy` → Cosmos `items` container, `state.accessPolicy` (tenant-scoped via `loadOwnedItem`/`updateOwnedItem`) |
| Approver / provider search | `GET /api/data-products/[id]/principal-search?q=&kind=` → Microsoft Graph `users`/`groups` `$filter=startswith(...)` via Console UAMI app-only token (`lib/azure/graph-principals.ts`, cloud-aware Commercial / GCC-High / IL5) |
| Published guard | `state.apimPublished` (set by `publishApimMirror` POST `/api/items/apim-product`) |
| Grant enforcement (on approval, T14) | `enforceAccessGrant` dispatches by scope (`lib/azure/access-policy-client.ts`): **adls-container** → `grantContainerRole` (ARM `PUT roleAssignments`, Storage Blob Data role); **warehouse** → Synapse **Dedicated SQL** `CREATE USER … FROM EXTERNAL PROVIDER` + `EXEC sp_addrolemember` (db_datareader/writer/owner) over real TDS; **kql-database** → ADX `.add database <db> viewers\|users\|admins ('<fqn>')` via the typed `addDatabasePrincipal` helper. Revoke replays the inverse (`sp_droprolemember` / `.drop database`). ADLS needs the constrained **RBAC Administrator** grant in `platform/fiab/bicep/modules/admin-plane/access-policy-rbac.bicep`; warehouse needs the Console UAMI as Synapse AD admin (`landing-zone/synapse.bicep`); KQL needs `AllDatabasesAdmin` (`admin-plane/adx-cluster.bicep`) |

## Honest infra gates

- **Graph permissions**: if the Console UAMI lacks `User.Read.All` /
  `Group.Read.All`, the picker shows a MessageBar with the exact
  `az ad sp permission add` command (no silent empty list).
- **RBAC-Administrator**: granting container-scoped Storage Blob Data roles at
  approval time needs the `access-policy-rbac.bicep` module (constrained to the
  three Storage Blob Data role GUIDs via an ABAC condition — no escalation).
- **Warehouse env / paused pool**: warehouse grants need
  `LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_DEDICATED_POOL` (bound from the DLZ
  workspace/pool in `main.bicep`). If the Dedicated SQL pool is start-paused
  (cost control), `enforceAccessGrant` kicks off a resume and returns
  `status:'pending'` ("pool is paused — re-run once Online"), keeping the
  access request at the final tier — never a silent success (no-vaporware.md).
- **ADX env**: KQL-database grants need `LOOM_KUSTO_CLUSTER_URI`; when unset the
  grant returns `status:'pending'` naming the env var.

## Per-cloud notes (non-ADLS enforcement)

The `sp_addrolemember` T-SQL and the ADX `.add database … ('aaduser=…')`
control command are **identical across clouds**; only the endpoint host/audience
differ, resolved by `cloud-endpoints` + per-deploy overrides
(`LOOM_SYNAPSE_HOST_SUFFIX` / `LOOM_SYNAPSE_SQL_TOKEN_SCOPE` / `LOOM_KUSTO_CLUSTER_URI`).
Synapse SQL suffix `sql.azuresynapse.net` (Commercial/GCC) vs
`sql.azuresynapse.usgovcloudapi.net` (GCC-High/IL5); ADX `kusto.windows.net` vs
`kusto.usgovcloudapi.net`. No boundary-specific branching in the grant code.

## Per-cloud notes

| Cloud | Graph base | Notes |
|-------|-----------|-------|
| Commercial / GCC | `graph.microsoft.com/v1.0` | Default |
| GCC-High / IL5 / DoD | `graph.microsoft.us/v1.0` | `graphBase()` switches on `AZURE_CLOUD`; `LOOM_GRAPH_BASE` overrides. Role GUIDs are global |

## Verification (receipt)

- `GET /api/data-products/{id}/access-policy` → `{ ok:true, policy:{…}, productPublished:false }`
- `PUT /api/data-products/{id}/access-policy` (purposes + approver OIDs + tier toggles) → `{ ok:true, policy:{…} }` (persisted to Cosmos)
- `GET /api/data-products/{id}/principal-search?q=al&kind=user` → live Entra principals with UPN
- On a published product, `PUT` → HTTP 409 `{ ok:false, code:'published_locked' }`; dialog disabled with MessageBar
- Unit: `lib/types/__tests__/access-policy.test.ts` (8 passing — normalize + tier ordering)
- Unit: `lib/azure/__tests__/access-policy-client.test.ts` — warehouse grant emits `sp_addrolemember` (not `ALTER ROLE … ADD MEMBER`, which Synapse Dedicated rejects), paused-pool returns `pending`, KQL routes through `addDatabasePrincipal` with read→viewers / write→users / admin→admins, revoke emits `sp_droprolemember` / `dropDatabasePrincipal`
