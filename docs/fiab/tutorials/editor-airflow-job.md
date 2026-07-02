# Tutorial: Apache Airflow job editor

> CSA Loom `airflow-job` editor — DAG-based orchestration on **managed Apache
> Airflow** (preview) for workloads that need Airflow operators beyond what
> ADF / Synapse pipelines cover. **No Microsoft Fabric required.**

## What it is

An Apache Airflow job runs DAGs synced from a Git repo on a managed Airflow
environment. Use it when you need Airflow-native operators (Spark, dbt,
Snowflake, HTTP, sensors) or an existing Airflow investment that ADF / Synapse
pipelines don't cover.

## When to use it

- Your team already authors Airflow DAGs and wants to keep that workflow.
- You need operators or scheduling semantics (sensors, backfills, dynamic DAGs)
  that visual pipelines don't expose.
- You orchestrate tools like dbt or Snowflake alongside Azure services from one
  scheduler.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Apache Airflow job** (Data
   Factory). The editor opens at `/items/airflow-job/<id>`.
2. **Connect a Git repo.** Point the managed Airflow environment at the Git
   repo that holds your DAG definitions.
3. **Sync DAGs.** DAGs sync from the repo and appear in the Airflow environment
   for scheduling.
4. **Use Airflow operators.** Author tasks with native operators (Spark, dbt,
   Snowflake, HTTP) that ADF / Synapse pipelines don't expose.
5. **Mind the preview gate.** This is a preview item; if the managed Airflow
   runtime isn't provisioned the editor surfaces the exact env / bicep
   requirement as an honest MessageBar — nothing is faked.

## The Azure backend it rides on

- **Runtime:** managed Apache Airflow (Workflow Orchestration Manager) in Azure
  Data Factory.
- **Source of truth:** your Git repo — DAG authoring stays in code.

## No Fabric required

The Airflow environment is an Azure Data Factory capability; no Fabric
capacity, workspace, or OneLake is involved on the default path.

## Learn more

- Workflow Orchestration Manager (managed Airflow):
  <https://learn.microsoft.com/azure/data-factory/airflow-overview>
