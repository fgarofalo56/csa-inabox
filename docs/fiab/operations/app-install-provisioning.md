# App Install — Phase 2 live-service provisioning

CSA Loom v3.4 extends the `POST /api/apps/[id]/install` route so that
when a user installs a curated app, every bundled item is also
provisioned in the real backing service (Fabric / ADX / Synapse / AI
Search / Activator). The install dialog exposes the new behavior as
two wizard choices:

1. **Deploy artifacts to live Azure services** (default ON) — when ON,
   the install path calls real REST against every supported item type.
   When OFF, the install stays Cosmos-only (templates only).
2. **Shared vs Dedicated compute** — shared uses the tenant's existing
   Fabric workspace / ADX cluster / Synapse pool / AI Search service.
   Dedicated provisions an isolated set via bicep before the
   artifact-level provisioners run. Default: Shared.

## Wizard request shape

```jsonc
POST /api/apps/<appId>/install
{
  "workspaceId": "loom-ws-...",      // required
  "deploy": true,                    // default true
  "mode": "shared" | "dedicated",    // default "shared"
  "targetOverrides": {               // optional, dedicated mode only
    "fabricWorkspaceId": "...",
    "kustoClusterUri": "...",
    "kustoDatabase": "...",
    "synapseWorkspace": "...",
    "warehouseServer": "...",
    "warehouseDatabase": "...",
    "aiSearchService": "...",
    "adlsAccount": "...",
    "adlsContainer": "..."
  }
}
```

## Wizard response shape

```jsonc
{
  "ok": true,
  "app": "app-iot-realtime",
  "workspaceId": "...",
  "installed": [                         // Cosmos-side: same as Phase 1
    { "itemType": "lakehouse", "id": "...", "displayName": "...", "status": "created" }
  ],
  "provision": {                         // Phase 2 — NEW
    "outcome": "all-created" | "partial" | "all-remediation" | "skipped",
    "mode": "shared",
    "target": { ... resolved env vars ... },
    "steps": [
      {
        "itemType": "notebook",
        "displayName": "Telemetry walkthrough",
        "cosmosItemId": "...",
        "result": {
          "status": "created" | "exists" | "skipped" | "remediation" | "failed",
          "resourceId": "<live Azure / Fabric id>",
          "secondaryIds": { "fabricWorkspaceId": "..." },
          "gate": { "reason": "...", "remediation": "...", "link": "..." },
          "error": "<verbatim Azure error>",
          "steps": ["…step log…"]
        }
      }
    ]
  }
}
```

## Provisioner coverage

| Item type            | REST surface                                                                | Bundle content shape    | Status |
| -------------------- | --------------------------------------------------------------------------- | ----------------------- | ------ |
| `notebook`           | Fabric `POST /workspaces/{ws}/notebooks` + `updateDefinition`               | `NotebookContent`       | A      |
| `lakehouse`          | Fabric `POST /workspaces/{ws}/lakehouses` + table-folder declarations       | `LakehouseContent`      | A      |
| `warehouse`          | Synapse TDS over AAD MI (executes bundled DDL + dbt models as views)        | `WarehouseContent`      | A      |
| `kql-database`       | ARM `PUT /Microsoft.Kusto/.../databases/{name}` + KQL `.create table`, `.ingest inline` | `KqlDatabaseContent`    | A      |
| `kql-queryset`       | Same as `kql-database` (shares parent DB)                                   | `KqlDatabaseContent`    | A      |
| `eventhouse`         | Same as `kql-database` (eventhouse == ADX cluster)                          | `KqlDatabaseContent`    | A      |
| `ai-search-index`    | Search `PUT /indexes/{name}` + `POST /indexes/{name}/docs/index`            | `AiSearchIndexContent`  | A      |
| `semantic-model`     | Fabric `POST /workspaces/{ws}/semanticModels` with TMSL bim part            | `SemanticModelContent`  | A      |
| `activator`          | Fabric Activator `POST /workspaces/{ws}/reflexes` + `/triggers`             | `ActivatorContent`      | A      |
| `data-pipeline`      | Fabric `POST /workspaces/{ws}/dataPipelines` + `updateDefinition`           | `SynapsePipelineContent`/`AdfPipelineContent` | A |
| `eventstream`        | Fabric `POST /workspaces/{ws}/eventstreams` + `updateDefinition`            | `EventstreamContent`    | A      |

All other editor types are Cosmos-only at install time (their state.content
remains the source of truth until the user clicks Save in the editor).

## Per-app provisioner table

| App                          | Live provisioned at install        | Cosmos-only                |
| ---------------------------- | ---------------------------------- | -------------------------- |
| `app-casino-analytics`       | Lakehouse, Notebook, KQL DB, Activator, Semantic Model, Report | dashboard tiles |
| `app-iot-realtime`           | Eventhouse, Eventstream, KQL DB, Activator, KQL Dashboard      | dashboards     |
| `app-healthcare-popmgt`      | Lakehouse, Warehouse, Semantic Model, AI Search                 | reports        |
| `app-fedramp-tracker`        | Lakehouse, Notebook, AI Search, Activator                       | scorecard      |
| `app-rag-builder`            | AI Search index, Notebook, Eventstream                          | prompt flows   |
| `app-pipeline-designer`      | Data Pipeline, Notebook, Lakehouse                              | dataflow specs |
| `app-lakehouse-inspector`    | Lakehouse, Notebook                                              | reports        |
| `app-data-steward`           | AI Search, Activator                                             | data products  |
| `app-finops-cost`            | KQL DB, Lakehouse, KQL Dashboard, Activator                     | scorecards     |
| `app-fabric-mirror-onboard`  | Mirrored DB (uses existing Fabric REST), Notebook               | -              |

## Remediation gates

When a provisioner can't proceed because a tenant-level config is
missing, it returns `status: "remediation"` with a `gate` envelope
carrying the exact admin action required. The wizard surfaces this in a
Fluent UI MessageBar with `intent="warning"` and a **Retry** button so
the admin can grant access and continue without re-running the entire
install.

Common gates:

| Reason                                  | Remediation                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| No bound Fabric workspace               | Bind via /admin/workspaces > Bind capacity, or set `LOOM_DEFAULT_FABRIC_WORKSPACE`.                                          |
| Fabric 401/403                          | Add Console UAMI as Contributor on the Fabric workspace + enable tenant setting "Service principals can use Fabric APIs".    |
| ADX cluster not configured              | Set `LOOM_KUSTO_CLUSTER_URI` + `LOOM_KUSTO_CLUSTER_NAME` env vars on the Console.                                            |
| Kusto 401/403 ARM                       | `az role assignment create --assignee <uami> --role Contributor --scope /subscriptions/.../Microsoft.Kusto/clusters/<c>`     |
| Kusto 401/403 .create table             | `az kusto cluster-principal-assignment create --principal-id <uami> --principal-type App --role AllDatabasesAdmin`           |
| AI Search 401/403                       | `az role assignment create --assignee <uami> --role "Search Service Contributor" --scope <searchSvc>`                        |
| Synapse dedicated pool not configured   | Set `LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_DEDICATED_POOL`.                                                                 |
| Synapse T-SQL not authorized            | In the Synapse workspace, run `CREATE USER [<uami>] FROM EXTERNAL PROVIDER; ALTER ROLE db_owner ADD MEMBER [<uami>];`        |

## Dedicated mode

In dedicated mode, the wizard expects bicep modules to have been
pre-deployed for this app (`platform/fiab/bicep/modules/admin-plane/`
plus any app-specific deltas). The wizard then passes the new resource
ids in `targetOverrides` so the same provisioners run against the
fresh resources. The deployment-time wiring lives in
`scripts/csa-loom/install-app-dedicated.sh` (preview).

## Retry semantics

The engine wraps every provisioner call in a one-shot retry on transient
failures (429, 502, 503, 504, timeout, ECONNRESET) with a 1.5s backoff.
Persistent failures surface verbatim with the Azure error body so the
operator has the exact error code to triage.

## Idempotency

Every provisioner is idempotent:

- Fabric items: list first by `displayName`, then `updateDefinition` if
  found, else `POST` a new item.
- KQL DB: ARM PUT is naturally idempotent, `.create table` is too.
- AI Search: `PUT /indexes/{name}` is upsert.
- Warehouse: DDL batches are wrapped in `CREATE OR ALTER VIEW`.

Re-running install on an already-provisioned app updates artifacts in
place; it does not create duplicates.

## No-vaporware compliance

Per `.claude/rules/no-vaporware.md`, every provisioner hits real REST.
There is no `return []` or `return {}` mock branch. The only honest
defer paths are:

1. `status: "skipped"` when the user toggled the wizard off.
2. `status: "remediation"` when a tenant-level config is missing, with
   the exact env var / role / portal step.

The receipt for this PR's E2E run is attached to the merge commit body.
