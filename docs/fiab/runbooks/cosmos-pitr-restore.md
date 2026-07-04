# Runbook — Cosmos DB point-in-time restore (Console metadata store)

**Scope:** recover the CSA Loom Console's own metadata store — the `loom`
database (workspaces, items, configs, connections, copilot sessions,
tenant-topology, …) held in the admin-plane Cosmos account provisioned by
`platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep`.

**When to use this:** an accidental delete/modify of workspace or item metadata,
a corrupted config write, or loss of the account, where you need to roll the
metadata store back to a known-good moment within the **last 7 days**.

**What this is NOT:** a way to recover the data lake, warehouse, or ADX — those
are separate stores. This runbook only restores the Console's foundation Cosmos
database.

!!! warning "Live execution is operator-verified"
    A restore provisions Azure resources and cannot be exercised from a docs
    build or CI. Run this against a real subscription. Rehearse it in a
    non-production sub first (it is the DR drill in
    [disaster-recovery.md](../operations/disaster-recovery.md#dr-drill-what-you-can-actually-rehearse)).

## How PITR behaves here (know before you run)

- The account is provisioned with **continuous backup, `Continuous7Days` tier**,
  so you can restore to any second within the **last 7 days**. ([Learn: provision continuous backup](https://learn.microsoft.com/azure/cosmos-db/provision-account-continuous-backup))
- Point-in-time restore of a **live** account always creates a **new** account —
  you cannot restore in place. ([Learn: restore continuous backup](https://learn.microsoft.com/azure/cosmos-db/restore-account-continuous-backup))
- The account is **single-region**; PITR restores only into a region where the
  backup existed. Continuous-mode backup storage is locally redundant and cannot
  be changed while in continuous mode. ([Learn: continuous backup intro](https://learn.microsoft.com/azure/cosmos-db/continuous-backup-restore-introduction))
- Our account is **PE-only** (`publicNetworkAccess Disabled`, `disableLocalAuth
  true`). The restore must be created with public access disabled, and the new
  account needs its **own private endpoint + AAD data-plane role grant** before
  the Console can reach it (steps 4–5).

## Prerequisites

- Azure CLI **≥ 2.52.0** (required for `--public-network-access Disabled` on
  restore). `az upgrade` if older. ([Learn](https://learn.microsoft.com/azure/cosmos-db/restore-account-continuous-backup#restore-an-account-using-azure-cli))
- The operator identity needs restore permissions:
  `Microsoft.DocumentDB/locations/restorableDatabaseAccounts/*/read` plus the
  restore action (the built-in **CosmosRestoreOperator** role, or Contributor on
  the subscription). ([Learn: backup/restore permissions](https://learn.microsoft.com/azure/cosmos-db/continuous-backup-restore-permissions))
- Know your values: source account name (`LOOM_COSMOS_ACCOUNT`), resource group,
  region, and the hub private-endpoint subnet + Cosmos private-DNS zone (the same
  ones `loom-console-cosmos.bicep` uses).

```bash
az login
az account set -s <subscriptionId>

SRC_ACCOUNT="<LOOM_COSMOS_ACCOUNT value>"     # e.g. the account the Console points at
RG="<admin-plane resource group>"
REGION="<region, e.g. centralus>"
TARGET_ACCOUNT="${SRC_ACCOUNT}-r$(date +%m%d%H%M)"   # new account the restore creates
```

## Step 1 — Find the restorable account + its instance id

```bash
az cosmosdb restorable-database-account list \
  --account-name "$SRC_ACCOUNT" \
  -o json
```

Note the `name` field of the matching `restorableLocations[]` entry (a GUID) —
that is the **instance id** used to enumerate restorable resources and confirm
the source. Also confirm `creationTime` so your restore timestamp is after it.
([Learn](https://learn.microsoft.com/azure/cosmos-db/restore-account-continuous-backup#list-all-the-accounts-that-can-be-restored-in-the-current-subscription))

```bash
INSTANCE_ID="<name GUID from the command above>"
```

## Step 2 — Choose and validate the restore timestamp (UTC)

If you know the moment just before the bad change, use it. To discover valid
timestamps / confirm the databases exist at that time:

```bash
# What databases/containers are restorable at a candidate time?
az cosmosdb sql restorable-resource list \
  --instance-id "$INSTANCE_ID" \
  --location "$REGION" \
  --restore-location "$REGION" \
  --restore-timestamp "2026-07-03T14:05:00+0000"
```

Confirm the `loom` database appears in the output. Pick the timestamp
immediately **before** the incident. ([Learn](https://learn.microsoft.com/azure/cosmos-db/restore-account-continuous-backup#find-databases-or-containers-that-can-be-restored-at-any-given-timestamp))

```bash
RESTORE_TS="2026-07-03T14:05:00+0000"
```

## Step 3 — Trigger the restore into a new PE-disabled account

```bash
az cosmosdb restore \
  --resource-group "$RG" \
  --account-name "$SRC_ACCOUNT" \
  --target-database-account-name "$TARGET_ACCOUNT" \
  --restore-timestamp "$RESTORE_TS" \
  --location "$REGION" \
  --public-network-access Disabled
```

To restore only the `loom` database (faster, avoids touching anything else):

```bash
az cosmosdb restore \
  --resource-group "$RG" \
  --account-name "$SRC_ACCOUNT" \
  --target-database-account-name "$TARGET_ACCOUNT" \
  --restore-timestamp "$RESTORE_TS" \
  --location "$REGION" \
  --public-network-access Disabled \
  --databases-to-restore name=loom collections=loom-workspaces workspace-folders task-flows embed-codes org-visuals azure-connections env-config app-install-jobs tenant-topology
```

Track progress: the target shows status **Creating**, then **Online** when done.
Expect a per-collection log event with a 5–10 min delay. ([Learn: track restore](https://learn.microsoft.com/azure/cosmos-db/audit-restore-continuous#track-the-progress-of-the-restore-operation))

```bash
# Poll until documentEndpoint resolves / provisioningState is Succeeded
az cosmosdb show --name "$TARGET_ACCOUNT" --resource-group "$RG" \
  --query "{state:provisioningState, endpoint:documentEndpoint, createMode:createMode}" -o json
```

## Step 4 — Give the restored account a private endpoint

The restored account has public access disabled but **no** private endpoint yet.
The Console (PE-only) cannot resolve it until one exists in the hub VNet, wired to
the Cosmos private-DNS zone — the same wiring `loom-console-cosmos.bicep` creates
(`pe-<account>` + `privateDnsZoneGroups`). Create it with the same subnet + DNS
zone:

```bash
PE_SUBNET_ID="<hub snet-private-endpoints resource id>"
DNS_ZONE_ID="<privatelink.documents.azure.<suffix> zone id>"
TARGET_ID=$(az cosmosdb show --name "$TARGET_ACCOUNT" --resource-group "$RG" --query id -o tsv)

az network private-endpoint create \
  --name "pe-${TARGET_ACCOUNT}" \
  --resource-group "$RG" \
  --subnet "$PE_SUBNET_ID" \
  --private-connection-resource-id "$TARGET_ID" \
  --group-id Sql \
  --connection-name cosmos-link

az network private-endpoint dns-zone-group create \
  --resource-group "$RG" \
  --endpoint-name "pe-${TARGET_ACCOUNT}" \
  --name default \
  --private-dns-zone "$DNS_ZONE_ID" \
  --zone-name cosmos-zone
```

## Step 5 — Re-grant the Console UAMI data-plane role

`disableLocalAuth` is on, so AAD-RBAC is the only data path. Re-grant the Console
UAMI **Cosmos DB Built-in Data Contributor** (`00000000-...-0002`) on the restored
account (mirrors the `cosmosDataRole` assignment in the bicep):

```bash
CONSOLE_PRINCIPAL_ID="<Console UAMI principal (object) id>"

az cosmosdb sql role assignment create \
  --account-name "$TARGET_ACCOUNT" \
  --resource-group "$RG" \
  --role-definition-id "00000000-0000-0000-0000-000000000002" \
  --principal-id "$CONSOLE_PRINCIPAL_ID" \
  --scope "/"
```

If the Console also uses the control-plane navigator/Connect panel, re-grant
**DocumentDB Account Contributor** at the account scope as well (the
`cosmosNavRole` assignment).

## Step 6 — Re-point the Console + verify real CRUD

Update the Console container app to point at the restored account, then confirm
item CRUD returns real data:

```bash
NEW_ENDPOINT=$(az cosmosdb show --name "$TARGET_ACCOUNT" --resource-group "$RG" --query documentEndpoint -o tsv)

az containerapp update \
  --name loom-console \
  --resource-group "$RG" \
  --set-env-vars \
    "LOOM_COSMOS_ACCOUNT=$TARGET_ACCOUNT" \
    "LOOM_COSMOS_ACCOUNT_ENDPOINT=$NEW_ENDPOINT"
```

Verify:

- `/api/health` returns 200.
- Open a workspace / item list in the Console and confirm the restored records
  are present (this is the real-data acceptance, not a DOM check).
- Spot-check the record that was lost/corrupted is back to its pre-incident state.

## Step 7 — Make the change durable in bicep

The `az containerapp update` in step 6 is an out-of-band fix. To avoid config
drift (a `no-vaporware` violation — see `.claude/rules/no-vaporware.md`), update
the deployment so a clean redeploy points at the restored account: set the
`accountName` the console-cosmos module expects (or migrate data back into a
freshly-deployed account) and re-run `az deployment sub create`. Record the
incident, the restore timestamp used, and the measured RTO in your ops log.

## Related

- [Disaster recovery — real posture + RPO/RTO](../operations/disaster-recovery.md)
- Bicep: `platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep`
