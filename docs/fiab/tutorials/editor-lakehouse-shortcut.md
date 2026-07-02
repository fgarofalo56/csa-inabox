# Tutorial: Lakehouse shortcut editor

> CSA Loom `lakehouse-shortcut` editor — the Azure-native equivalent of a
> Microsoft Fabric **OneLake shortcut**: a named pointer to external
> Delta/Parquet that a lakehouse reads **in place** without copying. Built on
> **ADLS Gen2** with **no OneLake / Fabric dependency.**

## What it is

A shortcut is a **named pointer** to external data that a lakehouse reads in
place — no bytes are copied. Loom persists the pointer as a workspace item: a
**connector** made of a source type, non-secret coordinates, and (for
credentialed sources) a Key Vault `secretRef`. On create and on verify, Loom
lists one level of the target to prove the pointer resolves, then SQL / Spark
over the lakehouse reads the shortcut's Delta / Parquet directly at query time.

## When to use it

- You want to query external Delta/Parquet (in ADLS, Blob, S3, GCS, or a
  Dataverse Synapse Link export) alongside your lakehouse tables without an ETL
  copy.
- You want a governed, named reference to another team's data location instead of
  duplicating it.
- You are migrating OneLake-shortcut patterns to an Azure-native lake.

## Step-by-step in Loom

1. **Open the editor.** Choose **+ New item → Lakehouse shortcut** (Data
   Engineering). The editor opens at `/items/lakehouse-shortcut/<id>`.
2. **Name the shortcut.** Give it a name; it appears under the lakehouse's
   shortcuts as a virtual folder.
3. **Pick a source type.** Choose one of the parity sources — internal
   lakehouse-to-lakehouse, external **ADLS Gen2** / **Blob** (optional SAS),
   **Amazon S3** / **S3-compatible** (MinIO / Wasabi), **Google Cloud Storage**,
   or **Dataverse** (Synapse Link export path).
4. **Enter the coordinates.** Provide the container + path (or bucket + region),
   and for credentialed sources a key that Loom stores in **Key Vault** — only a
   `secretRef` is persisted in Cosmos, never the secret itself.
5. **Verify resolution.** Loom lists the target path via the source's real client
   (ADLS / S3 SigV4 / GCS JWT→OAuth / Dataverse) to confirm the pointer resolves
   — proving access **without copying a single byte**.
6. **Query in place.** Spark or Synapse serverless SQL over the lakehouse reads
   the shortcut's Delta / Parquet directly at query time; the data is never
   duplicated.

## The Azure backend it rides on

- **Lake:** the existing DLZ **ADLS Gen2** account (`LOOM_ADLS_ACCOUNT`,
  `LOOM_BRONZE/SILVER/GOLD_URL`) — no new infrastructure to deploy.
- **Credentials (external sources):** **Azure Key Vault**
  (`LOOM_SHORTCUT_KEYVAULT` / `LOOM_KEY_VAULT_URI`) holds S3 / GCS / SAS secrets;
  Cosmos stores only the `secretRef`.
- **RBAC:** the Console UAMI's **Storage Blob Data Reader/Contributor** on the
  DLZ account (internal + external ADLS) and **Key Vault Secrets Officer** on the
  shortcut vault (credentialed sources).

## No Fabric required

The shortcut is a pure **ADLS Gen2** external-location pointer resolved to an
`abfss://` path — no OneLake, no Fabric capacity or workspace. When no ADLS
account / medallion URL is configured, verify/create returns a precise message
naming the missing `LOOM_*_URL` container rather than failing silently.

## Learn more

- Parity notes: `../parity/lakehouse-shortcut.md`
- Lakehouse editor tutorial: `editor-lakehouse.md`
- OneLake shortcuts (source concept):
  <https://learn.microsoft.com/fabric/onelake/onelake-shortcuts>
- ADLS Gen2:
  <https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction>
