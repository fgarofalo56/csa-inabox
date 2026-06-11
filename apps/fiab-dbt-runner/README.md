# CSA Loom — dbt runner

Azure-native dbt execution runtime for the **Synapse dedicated SQL pool** and
(opt-in) **Fabric Warehouse** targets of the Loom `dbt-job` visual builder.

## Why this exists

A Databricks `dbt_task` runs dbt natively as a Databricks Job — no external
runtime needed. **Synapse and Fabric have no equivalent native dbt task**, so
dbt-core must run from a host. This Container App is that host: it bundles
`dbt-core`, `dbt-synapse`, `dbt-fabric`, and the Microsoft **ODBC Driver 18 for
SQL Server**, authenticates to the pool with its **managed identity**
(`authentication=CLI`), runs the requested dbt commands against a project that
the Console generates, and returns the run log + parsed `run_results.json`.

No Microsoft Fabric dependency: Synapse is the default ODBC target; the
`dbt-fabric` adapter is bundled but only exercised when a user explicitly picks
the Fabric adapter on a `dbt-job` item.

## API

- `GET /health` → `{ "ok": true }`
- `POST /run`
  ```json
  {
    "files":   [{ "path": "dbt_project.yml", "content": "…" }, …],
    "commands": ["dbt deps", "dbt build"],
    "adapter": "synapse",
    "env":     { "DBT_SYNAPSE_SERVER": "ws.sql.azuresynapse.net", "DBT_SYNAPSE_DATABASE": "pool01" }
  }
  ```
  → `{ "ok": true, "exitCode": 0, "log": "…", "results": [{ "name": "stg_orders", "status": "success" }] }`

The Console reaches this app over the internal CAE network via
`LOOM_DBT_RUNNER_URL`. Deploy it with the `dbtRunnerEnabled` bicep flag
(`platform/fiab/bicep/modules/integration/dbt-runner.bicep`).
