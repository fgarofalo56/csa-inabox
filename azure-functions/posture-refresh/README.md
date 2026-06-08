# posture-refresh — Govern posture pre-compute (F2 Admin + F3 data-owner)

One Python v2 Azure Function App that serves **both** Govern posture paths:

- **Admin view (F2)** — pre-computes the per-tenant posture aggregate
  (`posture:{tenantId}`, PK `/tenantId`) into the Loom Cosmos
  `posture-aggregates-admin` container. The Console BFF
  (`/api/governance/govern/posture`) still computes live values on every
  request, so this is a **latency pre-warm, not a hard dependency** — the Govern
  Admin view is fully functional without it. The doc's `updatedAt` surfaces in
  the UI as "Background refresh last ran …".
- **Data-owner view (F3)** — on tab-open, recomputes one signed-in owner's
  governance coverage and upserts owner-scoped docs (id == PK == `ownerId`) into
  the `posture-aggregates` + `recommended-actions` containers. The Console BFF
  (`/api/governance/govern/refresh`) dispatches this fire-and-forget.

## Triggers / routes

- TimerTrigger `0 */5 * * * *` — every 5 min, refreshes every tenant (F2).
- HttpTrigger `GET /api/posture-refresh-admin` (function key) — on-demand F2 refresh.
- HttpTrigger `POST /api/posture-refresh` (function key) — F3 owner refresh
  (`{ "scope": "owner", "ownerId", "ownerUpn" }`).
- HttpTrigger `GET /api/health` (anonymous) — liveness probe.

## What it computes (Cosmos only — no Microsoft Fabric)

F2 (tenant): `workspaceCount`, `totalItems`, `capacityCount`, `domainCount`,
`freshItemsPct`, `describedItemsPct`, `endorsedItemsPct`, `sharedItems30d`.
MIP / DLP / Purview enrichment stays `null` here — those run live in the Console
BFF — so the doc never carries stale Graph/Purview numbers.

F3 (owner): `totalItems`, `labelCoveragePct`, `descriptionCoveragePct`,
`endorsementCoveragePct`, plus `unlabeled` / `undescribed` / `unendorsed` action
cards.

## Auth

`DefaultAzureCredential` with the Function App's **system-assigned managed
identity**, granted the Cosmos DB Built-in Data Contributor role at account scope
by `deploy/cosmos-rbac.bicep` (cross-RG). No account keys.

## Deploy

```bash
az deployment group create -g <function-rg> \
  -f azure-functions/posture-refresh/deploy/main.bicep \
  -p loomCosmosEndpoint='https://<acct>.documents.azure.com:443/' \
     loomCosmosAccountName=<acct> \
     loomCosmosAccountResourceGroup=<cosmos-rg>

# then publish the code (the post-deploy bootstrap workflow auto-publishes any
# app named func-loom-posture*):
cd azure-functions/posture-refresh && func azure functionapp publish <functionName> --python
```

Set the Console `LOOM_POSTURE_FUNCTION_URL` to the bicep `functionUrl` output and
store the host key in Key Vault as `loom-posture-function-key` (see DEPLOYMENT.md).

## Local dev

```bash
cp local.settings.json.sample local.settings.json   # fill in LOOM_COSMOS_ENDPOINT
func start
curl http://localhost:7071/api/health
```
