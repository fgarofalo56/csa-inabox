# posture-refresh — CSA Loom data-owner posture Function

Backs the **Govern tab → data-owner ("My items") view** (`/governance/govern?view=owner`, F3).

On tab-open the Loom Console BFF (`POST /api/governance/govern/refresh`) dispatches an
owner-scoped recompute to this Function (fire-and-forget). The Function reads the
signed-in owner's items from the Loom Cosmos catalog, computes governance coverage
(sensitivity label / description / endorsement), and UPSERTs the result into the
`posture-aggregates` and `recommended-actions` Cosmos containers. The Console then
re-reads `GET /api/governance/govern/owner`, which serves the freshly written
aggregates.

The Console renders **immediately** from cached/live Cosmos data — it never blocks on
this Function's cold start (Consumption Python cold start ≈ 2–5 s). When the Function is
not provisioned, the refresh endpoint returns an honest gate and the owner view falls
back to a live Cosmos compute in the BFF, so the surface is fully functional either way.

## Endpoints

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| `POST` | `/api/posture-refresh` | Function key (`x-functions-key`) | Recompute owner posture, write Cosmos |
| `GET`  | `/api/health` | anonymous | Liveness |

Owner-scoped request body (set by the BFF from the validated session cookie — never the browser):

```json
{ "scope": "owner", "ownerId": "<owner-oid>", "ownerUpn": "<owner-upn>" }
```

## Cross-owner isolation

- `ownerId` / `ownerUpn` are derived by the BFF from the encrypted session cookie. The
  browser never sets them and there is no `?owner=` parameter anywhere.
- The owner item query filters server-side on
  `state.ownerUpn` / `state.contact` / `state.steward` / `createdBy = ownerUpn`.
- The aggregate doc is keyed `id == partitionKey == ownerId` (the owner OID), so one
  owner's posture can never be written to or read from another owner's partition.

## Cosmos containers (created lazily by the Console; PK `/ownerId`)

| Container | Doc shape |
|-----------|-----------|
| `posture-aggregates` | `{ id: ownerId, ownerId, totalItems, labelCoveragePct, descriptionCoveragePct, endorsementCoveragePct, computedAt }` |
| `recommended-actions` | `{ id: ownerId, ownerId, unlabeled[], undescribed[], unendorsed[], computedAt }` |

These are created on first access by the Console's `cosmos-client.ts`
(`createIfNotExists`) — no separate ARM step beyond the account + database.

## Deploy (one-shot)

```bash
az login --tenant limitlessdata.ai
az account set --subscription "<sub>"

# 1. Infra: storage + Y1 plan + Function App (system-assigned MI) + Cosmos data-plane grant
az deployment group create \
  -g <function-rg> \
  -f azure-functions/posture-refresh/deploy/main.bicep \
  -p loomCosmosEndpoint="https://<acct>.documents.azure.com:443/" \
     loomCosmosAccountName="<acct>" \
     loomCosmosAccountResourceGroup="<cosmos-rg>"

# 2. Publish code
cd azure-functions/posture-refresh
func azure functionapp publish <functionName-from-output>

# 3. Capture the host key and store it in the Loom Key Vault as the secret the
#    Console reads via secretRef (loom-posture-function-key).
HOST_KEY=$(az functionapp keys list -g <function-rg> -n <functionName> --query functionKeys.default -o tsv)
az keyvault secret set --vault-name <loom-kv> --name loom-posture-function-key --value "$HOST_KEY"
```

For **GCC-High / IL5**, use `--query` against `documents.azure.us` endpoints; the Function
needs no cloud-specific code (`LOOM_COSMOS_ENDPOINT` is passed in per boundary by
`admin-plane/main.bicep`).

## Wire the Console

Set these on the admin-plane deployment (`platform/fiab/bicep/modules/admin-plane/main.bicep`):

| Param | Value |
|-------|-------|
| `loomPostureFunctionUrl` | `functionUrl` output from step 1 |
| `loomPostureFunctionKeySecretName` | `loom-posture-function-key` (default) |

The Console surfaces them as `LOOM_POSTURE_FUNCTION_URL` (plain) and
`LOOM_POSTURE_FUNCTION_KEY` (secretRef → Key Vault). When `loomPostureFunctionUrl` is
empty, the Console shows an honest MessageBar and serves live-computed posture instead —
no broken surface.

## Verify

```bash
# Liveness
curl https://<functionName>.azurewebsites.net/api/health   # {"ok":true,"service":"posture-refresh"}

# Owner refresh (replace OID/UPN + host key)
curl -X POST "https://<functionName>.azurewebsites.net/api/posture-refresh?code=<HOST_KEY>" \
  -H 'Content-Type: application/json' \
  -d '{"scope":"owner","ownerId":"<oid>","ownerUpn":"<upn>"}'
# → {"ok":true,"scope":"owner","kpis":{...}}
```
