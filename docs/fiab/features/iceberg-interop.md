# Iceberg REST catalog and Delta/Iceberg interop

> **Surface:** lakehouse editor → **Interop** tab (`/items/lakehouse/<id>`); the catalog proxy at `/api/catalog/iceberg/*`
> **Backend:** a real Synapse Spark job writing Apache Iceberg V2 metadata beside the Delta log in your own ADLS Gen2, plus Unity Catalog OSS serving the standard Iceberg REST Catalog surface as an internal-ingress Container App
> **Kill-switch flag:** `n1-lakehouse-interop-tab` (default ON)
> **Honest gate:** `LOOM_ICEBERG_CATALOG_URL` unset — dual metadata still works; only catalog *discovery* is gated (gate id `svc-iceberg-catalog`)

Your Delta tables become readable by every Iceberg-speaking engine — Spark,
Trino, DuckDB, Snowflake, Databricks — **without copying a byte**. Loom writes
Iceberg V2 metadata beside the Delta log in the same storage account you already
own, and optionally registers the table in an Iceberg REST Catalog so those
engines can browse rather than being handed paths.

This is the anti-lock-in surface. The lake stays yours, in your storage account,
readable by tools that have never heard of Loom.

## Why it exists

Delta and Iceberg are two metadata formats over the same Parquet files. A
platform that only speaks one of them makes the customer's data hostage to the
platform. Dual metadata removes that: Delta stays canonical for Loom's own
engines, Iceberg makes the same table a first-class citizen everywhere else, and
nothing is duplicated or migrated.

The catalog choice matters for sovereignty. Loom serves the Iceberg REST surface
from **Unity Catalog OSS as a self-hosted container in your own Container Apps
environment**, reading your own ADLS Gen2 over the VNet. There is no SaaS
catalog anywhere in the path, which is exactly why a disconnected IL5 enclave
can still hand Trino a working Iceberg catalog.

## How to use it end to end

1. **Open a lakehouse** and select the **Interop** tab. It lists the real Delta
   tables the Tables tab reads — the live catalog, not a cached copy.
2. **Flip "expose as Iceberg"** on a table. This submits a **real Synapse Spark
   job** that writes Apache Iceberg V2 metadata next to the Delta log (Delta
   UniForm first, Apache XTable as the fallback) and registers the table in the
   Iceberg REST Catalog when one is configured.
   - **Data files are never copied.**
   - **The Delta log is never touched** — the Delta badge stays green forever.
3. **Read the badges.** Each table shows Delta and Iceberg state so you can see
   at a glance which tables are dual-exposed.
4. **Copy the catalog connection string.** The tab prints the endpoint external
   engines point at — the audited Loom proxy, never the internal container FQDN.
5. **Copy a connect snippet.** The tab renders ready-to-paste snippets for
   **Spark, Trino, DuckDB, Snowflake and Databricks**, built from the live
   catalog and table values.
6. **Connect from the external engine.** Point it at the proxy with a scoped
   Loom API token (or a session, for a browser-based tool) and query the table.
7. **Verify the audit trail.** Every read and write through the catalog proxy
   writes an `_auditLog` row naming the principal, the namespace/table scope and
   the operation. High-volume LIST reads aggregate into one row per request
   rather than one per table.

## What the backend actually does

| Control | Backend |
|---|---|
| Table list | The live lakehouse catalog (same source as the Tables tab) |
| Expose as Iceberg toggle | `PUT /api/lakehouse/interop` -> a real Synapse Spark job writing Iceberg V2 metadata into your ADLS Gen2 |
| Catalog operations | Unity Catalog OSS on an internal-ingress Container App, reached only through the Loom BFF proxy at `/api/catalog/iceberg/*` |
| Auth on the proxy hop | The caller is authenticated (session cookie or a scoped Loom API token); the BFF then injects an Entra bearer for the upstream hop |
| Audit | `_auditLog` plus the SIEM fan-out on every catalog read/write |

The catalog exposes the standard Apache Iceberg REST Catalog endpoints
(`/v1/config`, `/v1/namespaces`, `/v1/namespaces/{ns}/tables`, register) under a
prefix — `/api/2.1/unity-catalog/iceberg` by default, overridable with
`LOOM_ICEBERG_CATALOG_PREFIX` for a plain root-mounted deployment. Multi-level
namespaces are joined with the Iceberg spec's unit separator inside a single URL
path segment.

## Honest gates

**`LOOM_ICEBERG_CATALOG_URL` unset is a supported posture, not a broken one.**
The full Interop surface still renders: dual metadata is still written into your
lake, and the tab shows the direct metadata-folder path so any engine can be
pointed straight at it. What you lose is *discovery* — namespace and table
listing, and credential vending. The tab renders an inline honest gate with a
Fix-it naming the exact variable and the bicep module
(`platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep`). No red
banner on first open, and never an empty tab.

Optional overrides once the catalog is deployed:
`LOOM_ICEBERG_CATALOG_WAREHOUSE` (default `loom`),
`LOOM_ICEBERG_CATALOG_PREFIX`, `LOOM_ICEBERG_CATALOG_AUDIENCE`.

The catalog is **never public**. External engines always reach it through the
audited Loom proxy.

## Kill-switch

`n1-lakehouse-interop-tab` — default ON. Flipping it OFF hides the Interop tab
on the next render. **Already-emitted Iceberg metadata stays in the lake and
external engines keep reading it** — nothing is unregistered or deleted — and
every other lakehouse tab is unaffected.

## Related

- [Arrow Flight SQL and ADBC connect](flight-sql-adbc.md) — the other half of "read this from my own tools"
- [Trino federation (opt-in)](trino-federation.md) — the engine that consumes this catalog
- Editor guide — [Lakehouse](../tutorials/editor-lakehouse.md) · [Lakehouse shortcuts](../learn/lakehouse-shortcuts.md)
- [OneLake parity](../workloads/onelake-parity.md) · [Governance catalog](../governance/catalog.md)
