# Tutorial 08 — Forward-migrate a lakehouse to Fabric (roadmap pattern)

When Microsoft Fabric reaches your audit boundary, you can let Fabric read
your existing Loom ADLS data via a OneLake shortcut — **zero data
movement**. **30 minutes** (conceptual walkthrough).

!!! note "No migration tool exists today"
    There is **no Loom migration CLI or automated migration flow**. This
    tutorial documents the **manual pattern** you will use when Fabric Gov
    GAs in your boundary. The conceptual model is sound today — your ADLS
    Gen2 Delta tables stay in place and Fabric reads them via a OneLake
    shortcut — but you perform the steps by hand in the Fabric portal.

## Prerequisites

- A Loom lakehouse with Bronze / Silver / Gold tables (from previous
  tutorials), backed by ADLS Gen2
- A Fabric workspace (Commercial today; Gov when Fabric Gov GAs) bound to
  F-SKU capacity, where you're a Workspace Admin

## Why this matters

The Azure-native Loom estate is intentionally portable: nothing is locked
into a Fabric-only format. Because tables live as Delta in ADLS Gen2,
Fabric can read them in place via OneLake shortcuts. Testing this pattern
against a Fabric Commercial workspace today lets you validate the bridge
before your Gov boundary's Fabric GA arrives.

## Steps

### 1. Confirm the Fabric workspace is ready

Open the Fabric portal (`https://app.fabric.microsoft.com` Commercial, or
`https://app.fabric.microsoft.us` when Fabric Gov GAs):

- the workspace exists and is bound to F-SKU capacity (F8+), and
- you're a Workspace Admin.

### 2. Create a Fabric Lakehouse

In the Fabric workspace, create a **Lakehouse** item manually.

### 3. Create a OneLake shortcut to your Loom data

In the Fabric Lakehouse → **Files** (or **Tables**) → **New shortcut** →
**Azure Data Lake Storage Gen2**. Point it at your Loom ADLS Gen2 path:

```
abfss://<container>@<storage-account>.dfs.core.windows.net/Tables/noaa_silver_daily
```

Fabric now reads the Delta directly via the shortcut — no copy.

### 4. Verify the read in Fabric

In a Fabric notebook:

```python
df = spark.table("workspace_name.lakehouse_name.noaa_silver_daily")
df.show(10)
```

The SQL Analytics Endpoint can read the same table. Results match what you
see in Loom.

### 5. Reconnect the semantic model

For the model from [Tutorial 03](03-direct-lake-parity.md): in Power BI
Desktop, reconnect (or re-author) it against the Fabric Lakehouse SQL
Analytics Endpoint using **Direct Lake on OneLake** storage mode.

### 6. Compare freshness

- **Loom push dataset** (Tutorial 03): rows arrive on an explicit push.
- **Fabric Direct Lake on OneLake**: sub-second freshness off the same
  Delta files.

This is the gap that closes when you forward-migrate.

### 7. Run side-by-side

Don't decommission Loom immediately. Run both for 30-90 days: Loom keeps
serving while Fabric reads the same data via the shortcut. Validate
identity passthrough in both, compare results, and migrate reports
report-by-report on your own cadence. The ADLS Gen2 data remains the single
source of truth throughout.

## What's next

- [Forward to Fabric runbook](../runbooks/forward-migrate-to-fabric.md) —
  production migration procedure
- [Hybrid topology use case](../use-cases/hybrid-topology.md) —
  running Fabric + Loom long-term
- [Operations — Forward to Fabric](../operations/forward-to-fabric.md)

## Cleanup (if just demoing)

- In the Fabric portal, delete the OneLake shortcut (and the test Fabric
  Lakehouse). Your Loom estate is untouched.

## Troubleshooting

- Shortcut creation fails: verify Entra B2B trust between the Loom tenant
  and the Fabric tenant (only relevant for cross-cloud hybrid; same-tenant
  works natively)
- Result mismatch: Fabric reads the same Delta files, so schema and rows
  should be identical — re-check the shortcut path
