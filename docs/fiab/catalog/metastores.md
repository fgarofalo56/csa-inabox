# Catalog — Metastores

Inventory of every back-end the Unified Catalog federates over.

## Endpoint

- `GET /api/catalog/metastores` — list UC metastores (federated across workspaces, deduped by `metastore_id`), Fabric / OneLake workspaces, and the configured Purview account
- `POST /api/catalog/metastores` body `{ source: 'unity-catalog', hostname }` — **probe** a new Databricks workspace. Persistent registration still requires a bicep flip on `LOOM_DATABRICKS_HOSTNAMES`; the probe lets the admin pre-validate that the metastore admin group already includes the Loom UAMI before they push the bicep change.

## Multi-workspace federation

The console reads `LOOM_DATABRICKS_HOSTNAMES` (comma-separated) and falls back to `LOOM_DATABRICKS_HOSTNAME`. Each workspace gets a separate AAD token + REST call; results are deduped so a metastore shared across multiple workspaces appears once. When a workspace is unreachable a synthetic `ERROR_<hostname>` row is returned so the operator sees which workspace is misconfigured (versus a single global 500 hiding the cause).

## NotConfigured gates

- Unity → if `LOOM_DATABRICKS_HOSTNAMES`/`LOOM_DATABRICKS_HOSTNAME` is unset, the page shows the structured hint with the env var name + bicep module
- Fabric → if the UAMI is not in the Fabric service-principals tenant setting, the upstream 403 surfaces verbatim
- Purview → if `LOOM_PURVIEW_ACCOUNT` is unset, the page renders an account-not-configured MessageBar

## Enabling Unity Catalog on a Loom Databricks workspace (one-time, account-admin)

If the catalog tree / metastore list is empty or shows "metastore not listable",
the Databricks **workspace is not attached to a Unity Catalog metastore** (UC is
not enabled on it). UC is an account-level construct: a metastore is created once
per region by a **Databricks account admin** and assigned to the workspace. This
is NOT an Azure ARM action, so the Loom bicep deploy cannot do it for you — it
requires the Databricks **account console**.

### Step 1 — create + assign a metastore (Databricks account admin)
1. Open the Databricks **account** console: <https://accounts.azuredatabricks.net>.
2. **Catalog** → **Create metastore**: pick the workspace region (e.g. `eastus2`),
   name it (e.g. `loom-eastus2`), and (optionally) a root ADLS Gen2 container.
3. On the new metastore → **Workspaces** → **Assign to workspace** → select your
   Loom workspace (`adb-loom-default-<region>`).

### Step 2 — make the Loom Console UAMI a metastore admin (least-privilege)
Prefer this over granting the UAMI full **Account Admin**. Run the bundled script
(needs `az` logged in as a Databricks workspace admin + `jq`):

```bash
scripts/csa-loom/add-loom-uami-to-uc-metastore-admin.sh \
  --workspace-hostname <adb-xxxx.region.azuredatabricks.net> \
  --uami-principal-id  <Console-UAMI-objectId>   # az identity show -g <admin-rg> -n uami-loom-console-<region> --query principalId -o tsv
```

The UAMI's **applicationId** (client id, e.g. `LOOM_UAMI_CLIENT_ID`) is what
Databricks SCIM uses — the script resolves it from the object id automatically.

### Alternative — Account Admin (broader)
Databricks account console → **User management** → **Service principals** → add the
UAMI by its **Application ID** (`LOOM_UAMI_CLIENT_ID`) → **Roles** → **Account admin**.

### After either step
The catalog metastore list + per-workspace catalogs light up immediately (no
redeploy). Loom already lists a workspace's **catalogs** without account-admin —
account-admin / metastore-admin is only needed for the account-level *metastore*
list and UC privilege management.

### Already have a metastore? Just assign it (don't create another)
If a metastore already exists for the region (e.g. `metastore_azure_eastus2`),
**do not create a second one** — assign the existing one to the workspace:

- **UI (1 click):** account console → **Catalog** → open the existing metastore →
  **Workspaces** → **Assign to workspace** → pick `adb-loom-default-<region>`.
- **Scripted (fully automated, reuses the existing metastore):**
  ```bash
  DATABRICKS_ACCOUNT_ID=<account-guid> \
  scripts/csa-loom/enable-unity-catalog.sh \
    --region eastus2 --workspace-id <workspaceId> \
    --uami-app-id <LOOM_UAMI_CLIENT_ID>
  ```
  The script finds the existing regional metastore, assigns it, and sets the
  Loom UAMI as metastore owner/admin — idempotent. Runs against the Databricks
  **account API** (not the network-restricted workspace host), so it works even
  when the workspace blocks public network access. Caller must be a Databricks
  account admin (one-time; can be a service principal for unattended bootstrap).
