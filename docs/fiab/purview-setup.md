# Microsoft Purview setup for CSA Loom (all scenarios)

CSA Loom's governance and catalog surfaces (catalog browse/search, lineage,
glossary, collections, scans/sources, asset detail) call the **classic
Microsoft Purview Data Map** data plane through the Console managed identity
(UAMI). This page covers the three deployment scenarios and the exact wiring
each requires.

> **Why classic Data Map?** The Loom client
> (`apps/fiab-console/lib/azure/purview-client.ts`) targets the API the
> ARM-provisioned account actually exposes:
>
> | Surface     | Endpoint (host = `{account}.purview.azure.com`)                            | api-version          |
> | ----------- | -------------------------------------------------------------------------- | -------------------- |
> | Health probe| `GET /datamap/api/atlas/v2/types/typedefs/headers`                         | `2023-09-01`         |
> | Search      | `POST /datamap/api/search/query`  (body `{ keywords, limit }`)             | `2023-09-01`         |
> | Asset       | `GET /datamap/api/atlas/v2/entity/guid/{guid}`                             | `2023-09-01`         |
> | Lineage     | `GET /datamap/api/atlas/v2/lineage/{guid}?direction=BOTH&depth=3`          | `2023-09-01`         |
> | Glossary    | `GET /datamap/api/atlas/v2/glossary` → `/glossary/{guid}/terms`            | `2023-09-01`         |
> | Atlas upsert| `POST /datamap/api/atlas/v2/entity`                                        | `2023-09-01`         |
> | Collections | `GET /collections`                                                         | `2019-11-01-preview` |
> | Sources/Scans| `GET/PUT/DELETE /scan/datasources/...`                                     | `2022-07-01-preview` |
>
> The token scope is `https://purview.azure.net/.default`.
> The host is `{account}.purview.azure.com` — **NOT** the `-api` unified-catalog
> host, which a classic ARM account does not resolve (the prior bug: HTTP 000).
>
> Endpoints grounded in Microsoft Learn:
> [Data Map operation groups](https://learn.microsoft.com/rest/api/purview/datamapdataplane/operation-groups),
> [Discovery Query](https://learn.microsoft.com/rest/api/purview/datamapdataplane/discovery/query),
> [Collections](https://learn.microsoft.com/rest/api/purview/accountdataplane/collections/list-collections),
> [Scanning data sources](https://learn.microsoft.com/rest/api/purview/scanningdataplane/data-sources),
> [Atlas 2.2](https://learn.microsoft.com/purview/data-gov-api-atlas-2-2).

## Scenario (a) — classic Data Map account (what CSA Loom uses today)

This is the default and fully supported path.

1. **Deploy the account.** `platform/fiab/bicep/modules/admin-plane/catalog.bicep`
   deploys a classic `Microsoft.Purview/accounts` resource. (The full
   admin-plane deploy already references `LOOM_PURVIEW_ACCOUNT`.)

2. **Wire the env var.** `admin-plane/main.bicep` sets
   `LOOM_PURVIEW_ACCOUNT` on the Console app — it defaults to
   `purview-csa-loom-${location}`, or override via the
   `loomPurviewAccount` bicepparam / `LOOM_PURVIEW_ACCOUNT` env. Set it to the
   **short account name** (e.g. `purview-csa-loom-eastus2`), not a URL.

3. **Grant the UAMI a Data Map role.** Classic Data Map permissions are NOT ARM
   RBAC — they live in the account's collection metadata policy. Run:

   ```bash
   PURVIEW_ACCOUNT=purview-csa-loom-eastus2 \
   ROLE=data-curator \
     ./scripts/csa-loom/grant-purview-datamap-role.sh
   ```

   `data-curator` (read/write) backs every catalog action. Use `data-reader`
   for a read-only Console, or add `data-source-administrator` to register
   sources and run scans. The signed-in principal must be a **Collection
   Admin** on the account for the policy PUT to succeed (one-time human grant in
   the Purview portal → Data Map → Collections → root → Role assignments).

4. **Verify.** The Console's `/api/governance/purview/status` probe returns
   `reason: 'live'` once the typedefs probe answers 200. A 401/403 returns
   `reason: 'role_missing'` (re-run the grant); a DNS failure returns
   `reason: 'not_configured'` (fix `LOOM_PURVIEW_ACCOUNT`).

   Live E2E receipt against `purview-csa-loom-eastus2`:

   ```text
   GET  /datamap/api/atlas/v2/types/typedefs/headers  → 200
   POST /datamap/api/search/query {"keywords":"*"}     → 200 {"@search.count":0,"value":[]}
   GET  /collections                                   → 200 {"value":[{"name":"purview-csa-loom-eastus2",...}]}
   GET  /scan/datasources                              → 200 {"value":[],"count":0}
   GET  /datamap/api/atlas/v2/glossary                 → 200
   ```

## Scenario (b) — Purview not provisioned (honest gate)

If `LOOM_PURVIEW_ACCOUNT` is unset, or the named account does not resolve as a
classic Purview host, the Console does **not** fail — every governance surface
renders fully and shows a Fluent `MessageBar` (`intent="warning"`) naming:

- the env var to set (`LOOM_PURVIEW_ACCOUNT`),
- the bicep module to deploy
  (`platform/fiab/bicep/modules/admin-plane/catalog.bicep`),
- the UAMI role to grant (Data Curator / Data Reader / Data Source Administrator
  on the root collection, via `grant-purview-datamap-role.sh`).

This is enforced by `probePurview()` + `PurviewNotConfiguredError` and rendered
by `lib/components/purview-gate.tsx`. No fabricated data is ever shown.

## Scenario (c) — new unified-catalog account (future)

The **new** Purview unified-catalog experience (purview.microsoft.com) exposes
extra concepts — **business / governance domains** and **data products** — under
the `{account}-api.purview.azure.com/datagovernance` host. Those accounts are
onboarded in the new portal and are **not** provisionable via ARM
`az purview account create`.

The Loom client keeps the function signatures for these concepts
(`listBusinessDomains`, `createBusinessDomain`, `registerDataProduct`,
`listDataProducts`, `listDataQualityRules`) but, on a classic Data Map account,
they raise `PurviewUnifiedCatalogGateError` — a typed honest gate (subclass of
`PurviewNotConfiguredError`) that renders a MessageBar explaining:

> Data products & business domains require a Purview account in the new
> unified-catalog experience; the deployed account is a classic Data Map. Use
> the Data Map catalog/glossary/collections/scans above.

To enable the unified catalog, onboard an account in the new experience and
point `LOOM_PURVIEW_ACCOUNT` at it. (Adopting the `-api` host + `/datagovernance`
client surface would be a follow-up; the classic Data Map path remains the
supported default.)

## Scanning private-endpoint-locked sources — managed-VNet Integration Runtime {#purview-managed-vnet-ir}

To scan a source that is **locked behind Private Link** (no public network
access) you need a self-hosted IR **or** — new in 2026-06 — a Purview
**managed-VNet Integration Runtime** with **managed private endpoints**. The
managed path needs **no SHIR VMSS**: Purview hosts the scan compute inside its
own managed VNet and reaches each PE-locked source through an approved managed
private endpoint.

The Console wires this end-to-end (commit `8704e7ef`):

- BFF: `app/api/admin/scaling/compute/purview-managed-vnet/route.ts` (GET status,
  POST create/upsert), surfaced in `ScaleManagePanel`.
- Client (`apps/fiab-console/lib/azure/purview-client.ts`), over the Purview
  **scanning** data plane:
  - `upsertPurviewManagedVnet` → `PUT /scan/managedvirtualnetworks/{mvnet}` —
    create the managed VNet
  - `upsertPurviewManagedVnetIr` → `PUT /scan/integrationruntimes/{ir}` (kind
    `Managed`) — create the managed-VNet IR
  - `list/upsertPurviewManagedPrivateEndpoint` →
    `PUT /scan/managedvirtualnetworks/{mvnet}/managedprivateendpoints/{name}` —
    create a managed PE to a target resource (`groupId` = the sub-resource, e.g.
    `blob` / `dfs` / `sqlServer`)

**One-time human step (honest gate):** each managed private endpoint must be
**approved by the target resource's owner** (Azure portal → the source resource →
Networking → Private endpoint connections → Approve, or `az network
private-endpoint-connection approve`). The Console surfaces the exact approval
step + portal URL + `az` command. Until approved, the PE is `Pending` and the
scan can't reach the source.

Use the **managed-VNet IR** for Azure PaaS sources behind Private Link (Storage /
Azure SQL / etc.); keep the **SHIR VMSS** ([purview-shir-autoscale](parity/purview-shir-autoscale.md))
for on-prem / VM-hosted sources that a managed PE can't reach.

## Files

- Client: `apps/fiab-console/lib/azure/purview-client.ts`
- Probe route: `apps/fiab-console/app/api/governance/purview/status/route.ts`
- Gate component: `apps/fiab-console/lib/components/purview-gate.tsx`
- Role grant: `scripts/csa-loom/grant-purview-datamap-role.sh`
- Env wiring: `platform/fiab/bicep/modules/admin-plane/main.bicep` (`LOOM_PURVIEW_ACCOUNT`)
