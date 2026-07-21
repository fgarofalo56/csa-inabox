# Gov 89/92 — verified gap analysis + operator runbook

**Date:** 2026-07-21 · **Verified against:** live GCC-High `loom-console`
(`rg-csa-loom-admin-usgovvirginia`) via `gov-selfaudit.yml`, `gov-discover.yml`
(read-only ARM probe), and both deploy-path what-ifs.

## Current score: **75 / 92 configured, 17 blocked**

All 17 blocked gates are `severity: optional` (scale-out backends). Zero
critical / recommended gates are blocked — Gov is at **100% of every mandatory
gate**. `svc-digital-twins` already PASSES on the ADX graph-twin default
(`LOOM_KUSTO_CLUSTER_URI` set; no Azure Digital Twins needed — ADT is not in
GCC-High). The MapLibre maps stack and the ADX graph-twin (the two "OSS
replacements") are already implemented in code; the gap is deployment, not
engineering.

## Why literal 89/92 is unreachable

**~11 of the 17 cannot close by any automated action.** Verified reasons:

### A. Impossible in GCC-High *by design* (4) — param-proven
| Gate | Proof (in `params/gcc-high.bicepparam` / bicep) |
|------|--------------------------------------------------|
| `svc-databricks-sql` | `databricksSqlWarehouseEnabled = false  // NOT in Gov` |
| `svc-batch`          | `// OpenAI Batch API NOT in Gov` |
| `svc-data-wrangler`  | `wranglerActive` is `false` on GCC-High / IL5 by construction |
| `svc-purview-uc`     | `catalogPrimary = 'purview'  // UC managed not yet in Gov` |

These will honest-gate forever on Gov. They are **not** defects — the base
features work on their Azure-native / Purview-classic defaults.

### B. Operator-owned — I cannot perform these from CI (7)

**B1. Postgres-Flex quota (unblocks 4 gates):** `svc-airflow`, `svc-pgvector`,
`svc-weave-ontology`, `svc-postgres`. `usgovvirginia` is quota-restricted from
`Microsoft.DBforPostgreSQL/flexibleServers`, so `postgresQuotaAvailable=false`
and the OSS Airflow host + Postgres-backed items honest-gate.

> **Operator action:** file a quota-increase / region-enablement request for
> `Microsoft.DBforPostgreSQL/flexibleServers` in the Gov subscription
> (`usgovvirginia`), then re-run the Gov deploy so `postgresQuotaAvailable`
> flips true and the Airflow host + Postgres items provision.
> Azure portal → Subscriptions → *(Gov sub)* → **Usage + quotas** → search
> "PostgreSQL flexible" → **Request increase** (or open a support case; some
> sovereign regions require a support ticket to enable the RP).

**B2. Entra admin-consent for Graph app-roles (2 gates):** `svc-m365-link`
(Group.ReadWrite.All), `svc-sharepoint-shortcuts` (Files.Read.All), granted to
the Console UAMI. Requires a Privileged Role / Global admin.

> **Operator action (per app-role):**
> ```bash
> # Console UAMI object id (from the Gov deploy outputs) + Microsoft Graph SP
> GRAPH_SP=$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" -o tsv)
> # Group.ReadWrite.All app-role id = 62a82d76-70ea-41e2-9197-370581804d09
> # Files.Read.All app-role id      = 01d4889c-1287-42c6-ac1f-5d1e02578ef6
> az rest --method POST \
>   --url "https://graph.microsoft.us/v1.0/servicePrincipals/$GRAPH_SP/appRoleAssignedTo" \
>   --body '{"principalId":"<CONSOLE_UAMI_OBJECT_ID>","resourceId":"'$GRAPH_SP'","appRoleId":"<APP_ROLE_ID>"}'
> ```
> Then set `LOOM_WORKSPACE_M365_LINK=true` / `LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true`
> via `gov-apply-env.yml`.

**B3. GitHub PAT (1 gate):** `svc-feedback-forwarding` needs a fine-grained PAT
(issues:write on the target repo), stored as the ACA secret
`loom-feedback-github-token`.

> **Operator action:** mint a fine-grained PAT (github.com → Settings →
> Developer settings → Fine-grained tokens; repo `fgarofalo56/csa-inabox`;
> Issues: Read/Write), then set it as the Gov console secret and wire
> `LOOM_FEEDBACK_GITHUB_TOKEN` (secretref) via a Gov deploy/secret update.

### C. Provisionable, but needs new incremental-deploy tooling (≈4)
`svc-aisearch` (`aiSearchEnabled=true` — AI Search *is* in GCC-High),
`svc-azure-maps` (deploy `loom-maps-app` tileserver ACA — image must be built to
the Gov ACR first), `svc-dbt` (build `loom-dbt-runner` image → flip
`dbtRunnerImageReady`), `svc-posture-refresh` (deploy the posture Function).

**Blocker:** there is no safe existing path to add these to the *live* console —
`deploy-fiab-gcch.yml` (from-scratch installer) refuses via its topology guard
("a CSA Loom hub already exists in the target subscription"), and the legacy
`deploy-gov.yml` (`deploy/bicep/gov/main.bicep`) does not compile
(BCP036/BCP120/BCP139). `ai-search.bicep` is not standalone — it needs the live
VNet/private-endpoint/DNS/identity context, so deploying it in isolation against
the live sovereign VNet risks breaking Console networking.

> **To close these safely (a real, reviewed engineering task — not a config
> flip):** build an *incremental* Gov provisioning workflow that
> `az deployment group create`s the single module into the existing admin RG,
> sourcing the subnet / DNS-zone / workspace / UAMI ids from the live deployment
> (via `gov-discover`), guarded to touch ONLY the new resource. Validate with a
> group-scoped what-if before apply, then wire the env var via `gov-apply-env`
> and re-run `gov-selfaudit`. Each closes one gate; none reaches 89/92.

## Realistic ceiling

With the operator actions in B (7 gates) **and** the incremental tooling in C
(≈4 gates), Gov could reach **≈86/92**. The 4 in bucket A can never close on
GCC-High. **89/92 and 92/92 are not attainable** — this is a sovereign-cloud
service-availability reality, not a code defect. The honest completion metric is
"100% of mandatory gates + every optional gate whose backend GCC-High supports."

## Re-measure

```bash
gh workflow run gov-selfaudit.yml --ref main          # prints X/92 + blocked list
gh workflow run gov-discover.yml  --ref main          # read-only: which backends exist
```

## Execution update 2026-07-21 — 75→77/92 via incremental provisioners

Two gates CLOSED by net-new out-of-band provisioners (the reusable pattern):
- **`svc-dbt`** — `.github/workflows/gov-provision-dbt.yml` built `loom-dbt-runner`
  on the Gov ACR, deployed the ACA, wired `LOOM_DBT_RUNNER_URL`. Audit-confirmed.
- **`svc-posture-refresh`** — `.github/workflows/gov-provision-posture.yml`
  deployed the posture Function App, `func publish`ed the code, stored the host
  key in KV, wired `LOOM_POSTURE_FUNCTION_URL`. Audit-confirmed.

### HARD CONSTRAINT discovered — the Gov deploy SP cannot create role assignments
`gov-provision-aisearch.yml`'s what-if failed with:
`Authorization failed … client bc4f5085-… does not have permission to perform
'Microsoft.Authorization/roleAssignments/write'`. The Gov deploy SP is scoped to
resource **creation**, NOT role management. Consequence: every remaining PaaS
gate whose backend needs a **Console-UAMI data-plane role grant** —
`svc-aisearch` (Search Index Data Contributor + Search Service Contributor),
`svc-copyjob-control` (db_datawriter on the control DB), `svc-cosmos-vcore` — is
**operator-gated for the grant**. `dbt`/`posture` closed only because they need
no such SP-forbidden assignment.

**True self-achievable ceiling = 77/92.** Reaching higher needs an operator with
User Access Administrator (or Owner) on `rg-csa-loom-admin-usgovvirginia`.

### Operator step to finish `svc-aisearch` (once you provide UAA rights or run it yourself)
```bash
# 1) deploy the service (skip role grants the SP can't make)
az deployment group create -g rg-csa-loom-admin-usgovvirginia -f platform/fiab/bicep/modules/admin-plane/ai-search.bicep \
  -p location=usgovvirginia sku=standard privateEndpointSubnetId=<snet-private-endpoints id> \
     privateDnsZoneSearchId=<privatelink.search.usgovcloudapi.net zone id (create+link if missing)> \
     workspaceId=<law-csa-loom-usgovvirginia id> consolePrincipalId=791fb231-cbba-4e49-b6ac-c812e0c6ec3f \
     skipRoleGrants=true deployGovernanceIndex=false complianceTags='{"env":"gov"}'
# 2) grant the Console UAMI the two Search roles (needs UAA/Owner)
SVC=$(az search service list -g rg-csa-loom-admin-usgovvirginia --query "[?starts_with(name,'search-loom')].id|[0]" -o tsv)
az role assignment create --assignee 791fb231-cbba-4e49-b6ac-c812e0c6ec3f --role "Search Index Data Contributor" --scope "$SVC"
az role assignment create --assignee 791fb231-cbba-4e49-b6ac-c812e0c6ec3f --role "Search Service Contributor"     --scope "$SVC"
# 3) wire it
gh workflow run gov-apply-env.yml --ref main -f env_pairs="LOOM_AI_SEARCH_SERVICE=$(basename "$SVC")"
```
