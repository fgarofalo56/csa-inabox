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

### Azure Government (GCC-High / IL5 / DoD) specifics

The classic Purview **data-plane host suffix differs per cloud** (Microsoft
Learn, self-hosted IR networking table + Gov private-DNS zones):

| Cloud | Data-plane host | Token audience |
|---|---|---|
| Commercial / GCC | `{account}.purview.azure.com` | `https://purview.azure.net` |
| Azure Government | `{account}.purview.azure.us` | `https://purview.azure.net` |
| China | `{account}.purview.azure.cn` | `https://purview.azure.net` |

The token **audience is cloud-invariant** (`https://purview.azure.net` per
Learn `purview/data-gov-api-rest-data-plane`) — only the host changes.

How the Console resolves the endpoint (`lib/azure/purview-endpoints.ts`):

1. `LOOM_PURVIEW_ENDPOINT` — explicit data-plane base URL, wins outright
   (escape hatch for custom DNS / clouds we don't enumerate).
2. **ARM-derived** — the account's REAL `properties.endpoints.catalog` origin,
   read from the `Microsoft.Purview/accounts` resource (discovered by name via
   Azure Resource Graph across every readable subscription), cached per
   process. Authoritative in every cloud.
3. **Cloud-aware convention fallback** — `{account}.purview.azure.us` when
   `LOOM_CLOUD`/`AZURE_CLOUD` indicate Azure Government, `.com` otherwise.

The `/api/governance/purview/status` probe (and its gate MessageBar) reports
the **exact endpoint it tried** and whether the ARM lookup succeeded — a gate
that names `*.purview.azure.com` in a Gov deployment means the console image
predates this fix, or `LOOM_CLOUD` is unset AND the ARM lookup failed.

**Gov verification + grant workflow:** run
`.github/workflows/gov-purview-verify.yml` (workflow_dispatch, Gov deploy SP).
It lists the sub's Purview accounts with their true ARM endpoints, probes the
catalog endpoint with a deploy-SP token AND with the console UAMI token from
inside the loom-console container (in-VNet — required for PE-protected
accounts), prints the exact root-collection metadata-policy REST calls, and
with `apply_grants=true` applies Data Reader + Data Curator + Data Source
Administrator to the console UAMI idempotently via
`scripts/csa-loom/grant-purview-datamap-role.sh` (which is itself Gov-aware
via `PURVIEW_CLOUD=AzureUSGovernment`).

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

## Scan-plane register/trigger contract (live-proven 2026-07-15) {#purview-scan-plane-contract}

Requirements of `PUT /scan/datasources/{name}` + scan triggers that the classic
scan plane enforces but barely documents — each proven by an in-VNet probe
against `purview-csa-loom-eastus2` and encoded in `purview-client.ts`:

1. **`properties.collection` is required.** A register without it answers
   `404 ResourceNotFound` (the "resource" is the unspecified collection).
   `registerDataSource()` / `upsertScan()` default it to the account **root
   collection** when the caller doesn't pick one.
2. **Azure kinds need `properties.resourceId`.** An endpoint without a
   resourceId answers `403 OperationNotAllowed: "…requires a valid resourceId
   when an endpoint is specified."` (Synapse variant: "…resourceId or
   subscriptionId"). `purview-source-map.ts` derives the ARM id from the
   non-secret coordinates (`derivePurviewArmResourceId`).
3. **Scan-run ids must be GUIDs, and `scanLevel` must be passed.** A non-GUID
   run id (or a missing `scanLevel`) makes the plane answer
   `500 InternalServerError: "Unknown error"`. `triggerScanRun()` uses
   `randomUUID()` + `scanLevel=Full` → `202 Accepted { scanResultId }`.
4. **Duplicate targets answer `409 DataSource_Duplicate`** ("A data source
   already exists for this target: …") — sources are keyed by target endpoint,
   not by name. "Auto-add all sources" treats this as *already registered*
   (partial success), never a failure.
5. **Payload-level 403s are not role gates.** `handleSecurityError` only renders
   the Data-Map-role remediation for genuine auth failures; `OperationNotAllowed`
   / `InvalidField` / `Scan_*` codes propagate verbatim.

For the scan to actually **complete**, two runtime prerequisites apply (a scan
triggers fine without them and then fails with an honest error in the run
record):

- the Purview account's system-assigned MI needs data-plane read on each target
  (e.g. **Storage Blob Data Reader** on a scanned storage account);
- on a **PE-only account** (`publicNetworkAccess: Disabled`, the Loom default)
  the default AutoResolve Azure IR cannot run — the run fails with
  `(1100) Scan failed due to private endpoint settings on your account`. Create
  the **managed-VNet IR** (next section) and pin scans to it via
  `connectedVia`, or deploy ingestion private endpoints.

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

## Troubleshooting — endpoint + network failure modes (field-diagnosed 2026-07-15)

**Gate says `role_missing` (403) even after a correct grant — new-platform host.**
Accounts upgraded to the new Microsoft Purview platform report ARM
`properties.endpoints.catalog` as a tenant-scoped
`{guid}-api.purview-service.microsoft.com` host. That host is NOT the classic
Data Map data plane and rejects the Console UAMI with a bare 403 regardless of
collection metadata-policy roles, while the classic
`{account}.purview.azure.{com|us}` host answers 200 with the same token. The
client detects that hostname and falls back to the classic convention host
(`lib/azure/purview-endpoints.ts`); check the `endpoint` field returned by
`GET /api/governance/purview/status` — it names the base actually probed.

**Gate says `fetch failed` / `ENOTFOUND` — empty privatelink zone shadowing.**
When the Purview account is reused brownfield (e.g. a pre-existing DMLZ
account), `catalog.bicep`'s private-endpoint wiring never runs, but the
`privatelink.purview.azure.{com|us}` / `privatelink.purviewstudio.…` zones are
still deployed and linked to the hub VNet **empty**. Public DNS CNAMEs the
account host into the privatelink zone, and the linked empty zone answers
NXDOMAIN authoritatively — so the host resolves publicly but NOT from inside
the Container Apps VNet. Fix (Gov: run `gov-purview-verify` with
`fix_dns=true`): create `pe-purview-account` + `pe-purview-portal` into the hub
private-endpoint subnet with `dns-zone-group`s (populates the A records), then
approve the pending private-endpoint connections on the account — the data
plane rejects `Pending` connections with 403 `AccountProtectedByPrivateEndpoint`.

**Grant bootstrap.** The metadata-policy PUT requires the CALLER to already be
a Collection Admin. ARM `accounts/{name}/addRootCollectionAdmin` bootstraps
that with any objectId — but it needs `Microsoft.Authorization/roleAssignments/write`
(Owner / User Access Administrator), NOT just Contributor. Where the account's
`publicNetworkAccess` toggle is blocked by Azure Policy (error 21010), run the
grant from inside the Console container (in-VNet through the PE) — the Console
UAMI can self-grant once it's been added as a root Collection Admin via ARM.

## Files

- Client: `apps/fiab-console/lib/azure/purview-client.ts`
- Probe route: `apps/fiab-console/app/api/governance/purview/status/route.ts`
- Gate component: `apps/fiab-console/lib/components/purview-gate.tsx`
- Role grant: `scripts/csa-loom/grant-purview-datamap-role.sh`
- Env wiring: `platform/fiab/bicep/modules/admin-plane/main.bicep` (`LOOM_PURVIEW_ACCOUNT`)
