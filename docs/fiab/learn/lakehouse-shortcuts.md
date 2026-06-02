# Lakehouse shortcuts

Reference data that lives in another store — ADLS Gen2, Amazon S3, Google Cloud
Storage, Dataverse, or another Loom lakehouse — **without copying a byte**. A
shortcut is a pointer that makes external data appear as a local folder under
`Files` or a local table under `Tables`. Loom's lakehouse editor builds the
OneLake-shortcut experience one-for-one, with the CSA Loom theme applied.

## When to use it

Create a shortcut instead of an ingest pipeline when you want to:

- Query data in another lakehouse, warehouse, or workspace **without
  duplication** (and without it going stale).
- Read directly from **external object storage** (ADLS Gen2, S3, GCS) that your
  team already lands raw data into.
- **Combine** several sources into one lakehouse view while leaving the bytes
  where they are — lower storage cost, single source of truth.

Copy the data instead (a Copy job or pipeline) when you need a transformed,
governed, V-Order-optimized Delta copy in the Silver/Gold layers. Shortcuts are
the Bronze-layer / landing-zone tool.

## Where shortcuts live

The lakehouse editor opens at `/items/lakehouse/<id>` with a `TabList`:
**Files · Tables · Preview · SQL · Shortcuts**. Shortcut behaviour differs by
target tab, exactly as in Fabric:

| Tab | What a shortcut there does |
|---|---|
| **Tables** | Must be at the top level (no subfolders). If the target holds Delta data, it is auto-registered as a queryable table — readable from both Spark and the SQL analytics endpoint. |
| **Files** | Can sit at any folder depth, in any format. Not auto-registered as a table; Spark reads it directly. |

## Step-by-step: shortcut to ADLS Gen2

1. Open the lakehouse item. Select the **Files** tab (or **Tables** if the
   target is Delta you want to query with SQL).
2. On the toolbar, choose **New shortcut**. The source picker lists the
   supported sources Loom builds: **Internal Loom lakehouse**, **ADLS Gen2 /
   Azure Blob**, **Amazon S3**, **Google Cloud Storage**, and **Dataverse**.
3. Choose **ADLS Gen2 / Azure Blob**.
4. Enter the **URL** — the DFS endpoint of the storage account:
   `https://<account>.dfs.core.windows.net`.
5. Pick or create a **connection**. The auth kind must hold at least the
   **Storage Blob Data Reader** role on the account (Organizational account,
   Account key, SAS, Service principal, or the Console **Workspace Identity**).
6. **Browse** to the target container/folder and select one or more locations.
7. Review the names on the confirmation step (rename with the pencil, remove
   with the trash icon), then **Create**.

The shortcut appears in the **Files** tree with the shortcut glyph. Use
**Query this file** to preview, or open the **SQL** tab to read a Delta
shortcut through the SQL analytics endpoint.

## Step-by-step: internal shortcut (another Loom item)

1. **New shortcut → Internal Loom lakehouse**.
2. Pick the target item (lakehouse, warehouse, KQL database, mirrored database,
   or SQL database) — even across workspaces. The item types do **not** need to
   match; a lakehouse can shortcut to a warehouse folder.
3. Select the `Tables/...` or `Files/...` path and **Create**.

Internal shortcuts authorize with the **calling user's identity** — the user
must have read permission on the target. External shortcuts use the **stored
connection credential**.

## Honest infra gate

If the storage account is behind a firewall, the editor surfaces a Fluent
`MessageBar` (`intent="warning"`) naming the trusted-workspace-access
configuration required. The full shortcut UI still renders — Loom never fakes a
shortcut listing.

## Tip

Put structured data you'll query with SQL in **Tables** (use *New table
shortcut* for a single Delta table, *New schema shortcut* for a folder of Delta
tables). Put raw / semi-structured data you'll process with Spark in **Files**.

## Learn more

- **MS Learn — [Shortcuts in a lakehouse](https://learn.microsoft.com/fabric/data-engineering/lakehouse-shortcuts)**
- MS Learn — [OneLake shortcuts (concepts, caching, security)](https://learn.microsoft.com/fabric/onelake/onelake-shortcuts)
- MS Learn — [Create an ADLS Gen2 shortcut](https://learn.microsoft.com/fabric/onelake/create-adls-shortcut)
- Loom editor guide — [Lakehouse](../tutorials/editor-lakehouse.md)
- Loom tutorial — [First lakehouse + Delta tables](../tutorials/02-first-lakehouse.md)
