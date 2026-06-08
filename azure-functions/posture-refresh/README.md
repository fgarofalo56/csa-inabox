# posture-refresh — Govern Admin (F2) posture pre-compute

Python v2 Azure Function that pre-computes the Govern → Admin view (F2) posture
aggregates per tenant and upserts one doc per tenant
(`posture:{tenantId}`, PK `/tenantId`) into the Loom Cosmos `posture-aggregates`
container.

The Console BFF (`/api/governance/govern/posture`) still computes live values on
every request, so this Function is a **latency pre-warm, not a hard dependency** —
the Govern Admin view is fully functional without it. The doc's `updatedAt` is
surfaced in the UI as "Background refresh last ran …".

## Triggers

- TimerTrigger `0 */5 * * * *` — every 5 minutes.
- HttpTrigger `GET /api/posture-refresh` (function key) — on-demand.

## What it computes (Cosmos only — no Microsoft Fabric)

- `workspaceCount`, `totalItems`, `capacityCount`, `domainCount`
- `freshItemsPct`, `describedItemsPct`, `endorsedItemsPct`, `sharedItems30d`

MIP / DLP / Purview enrichment (`mipCoveragePct`, `dlpViolations30d`,
`purviewLastScanAt`) stays `null` here — those run live in the Console BFF — so
the doc never carries stale Graph/Purview numbers.

## Auth

`DefaultAzureCredential` with the **existing Console UAMI**
(`LOOM_UAMI_CLIENT_ID`), which already holds the Cosmos DB Built-in Data
Contributor role at account scope. No new RBAC grant is required.

## Deploy

```bash
az deployment group create -g <admin-rg> \
  -f azure-functions/posture-refresh/deploy/main.bicep \
  -p cosmosEndpoint='https://<acct>.documents.azure.com:443/' \
     consoleUamiResourceId=<uami-resource-id> \
     consoleUamiClientId=<uami-client-id>

# then publish the code (the post-deploy bootstrap workflow also does this):
cd azure-functions/posture-refresh && func azure functionapp publish <functionAppName> --python
```

## Local dev

```bash
cp local.settings.json.sample local.settings.json   # fill in LOOM_COSMOS_ENDPOINT
func start
curl http://localhost:7071/api/posture-refresh
```
