# Tutorial: Spark environment editor

> CSA Loom `spark-environment` editor — a versioned, publishable bundle of
> Spark runtime + compute + library configuration that **Publish** bakes into a
> real Synapse Spark pool. **No Microsoft Fabric required.**

## What it is

A Spark environment is a versioned, publishable bundle of runtime, compute, and
library configuration. In Loom the spec persists to Cosmos; **Publish** bakes
it into a Synapse Spark Big Data pool (`sessionLevelPackagesEnabled` +
`libraryRequirements` + `customLibraries` + `sparkConfigProperties`) via ARM,
and **Attach** wires it onto notebooks and Spark job definitions so they share
the same runtime.

## When to use it

- Multiple notebooks / Spark jobs must share the same package set and Spark
  properties.
- You need custom wheels/JARs staged and importable on the pool, with proof.
- You want runtime upgrades (e.g. Spark 3.5) rolled out as a versioned config
  change.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Spark environment** (Data
   Engineering). The editor opens at `/items/spark-environment/<id>`.
2. **Pick the runtime.** Choose the Spark runtime version (3.5 GA recommended)
   and node family on the **Runtime** tab.
3. **Size the compute.** Set node size, autoscale or a fixed node count, and
   auto-pause on the **Compute** tab — these are baked into the pool on
   publish.
4. **Add libraries.** List pip/conda packages on **Public libraries** and
   upload `.whl` / `.jar` files (staged to ADLS) on **Custom libraries**.
5. **Publish + validate.** **Publish** bakes the spec into the target Spark
   pool, then **Validate import** runs a live Spark session that installs the
   packages and imports them — the receipt proves importability.
6. **Attach to items.** Attach the environment to notebooks and Spark job
   definitions so they default to the published pool and share the same
   libraries.

## The Azure backend it rides on

- **Pool:** Azure Synapse Spark Big Data pool ARM (library requirements, custom
  libraries, Spark config properties).
- **Staging:** custom libraries staged to ADLS Gen2.
- **Validation:** a live Livy session that imports each package.

## No Fabric required

The environment publishes to Synapse + ADLS; no Fabric capacity, workspace, or
OneLake is involved.

## Learn more

- Managing Spark pool libraries:
  <https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-azure-portal-add-libraries>
