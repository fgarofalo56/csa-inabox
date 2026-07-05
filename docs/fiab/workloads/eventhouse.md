# Eventhouse editor

!!! note "Superseded by the hands-on tutorial"
    This workload overview is superseded by the hands-on
    [Eventhouse tutorial](../tutorials/editor-eventhouse.md) (UAT-dated). See
    that guide for the current step-by-step.

The **Eventhouse** editor is the entry point for Real-Time Intelligence in
CSA Loom. An Eventhouse is a logical container that owns one or more KQL
databases on the shared **Azure Data Explorer (ADX)** cluster — Azure-native by
default, no Microsoft Fabric required (per
`.claude/rules/no-fabric-dependency.md`).

## Backend

| Layer | Implementation |
|---|---|
| Cluster | `adx-csa-loom-shared.eastus2.kusto.windows.net` (admin-plane, single Dev SKU by default) |
| Databases | Per-DLZ ADX databases, provisioned via ARM `Microsoft.Kusto/clusters/databases` |
| Auth | Console UAMI (`LOOM_UAMI_CLIENT_ID`) with `AllDatabasesAdmin` on the cluster |
| BFF routes | `/api/items/eventhouse/[id]`, `/api/items/eventhouse/[id]/database`, `/api/items/eventhouse/[id]/ingest`, `/api/items/eventhouse/[id]/policies` |

## What works today

| Action | Backend call | Status |
|---|---|---|
| List databases | Kusto `.show databases` | live |
| Create database | ARM `PUT Microsoft.Kusto/clusters/{c}/databases/{n}` | live |
| Set hot-cache + soft-delete policies | Kusto `.alter database policy caching` / `policy retention` | live |
| Ingest CSV / JSON / JSONL (<= 5 MB / 50k rows) | Kusto `.ingest inline into table` | live |
| Wire Event Hub data connection | ARM `PUT .../dataConnections/{n}` with `kind: EventHub` | live (requires `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID`) |
| Ingest from OneLake / ADLS path | Kusto `.ingest into table (h'<url>')` | live (requires cluster MI to have RBAC on the path) |

## What still surfaces a MessageBar gate

| Feature | Gate / reason |
|---|---|
| **OneLake availability mirror** | Fabric opt-in only — the ADX-native default does not mirror to OneLake. Set `LOOM_KUSTO_FABRIC_MANAGED=true` to surface the flag when running against a Fabric-managed cluster. |
| **New dashboard from Eventhouse** | Use the KQL Dashboard editor directly. |

## Bicep

- Cluster: `platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep`
- Per-DLZ database: `platform/fiab/bicep/modules/landing-zone/adx.bicep` →
  `adx-db-inner.bicep`
- Gate: `param adxEnabled bool = true` (top-level `main.bicep` default
  flipped to ON as of sweep-rti, 2026-05-27)

## Env vars

| Variable | Purpose |
|---|---|
| `LOOM_KUSTO_CLUSTER_URI` | ADX cluster URI (defaults to the shared `adx-csa-loom-shared`) |
| `LOOM_KUSTO_DEFAULT_DB` | Fallback database when item state has no `databaseName` (defaults to `loomdb-default`) |
| `LOOM_SUBSCRIPTION_ID` | Required for ARM database/data-connection creation |
| `LOOM_KUSTO_RG` | Resource group of the cluster (default `rg-csa-loom-admin-eastus2`) |
| `LOOM_KUSTO_CLUSTER_NAME` | Cluster name (default `adx-csa-loom-shared`) |
| `LOOM_KUSTO_FABRIC_MANAGED` | `true` to surface OneLake availability flag in the policies dialog |
| `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` | Full ARM id of the Event Hubs namespace to wire data connections to |
