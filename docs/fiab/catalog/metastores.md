# Catalog — Metastores

Inventory of every back-end the Unified Catalog federates over.

## Endpoint

- `GET /api/catalog/metastores` — list UC metastores (federated across workspaces, deduped by `metastore_id`), the **persisted registrations** (Cosmos), account metastores (attach picker), Fabric / OneLake workspaces, and the configured Purview account
- `POST /api/catalog/metastores` body `{ source: 'unity-catalog', hostname, workspaceNumericId?, metastoreId?, defaultCatalog?, registerPurview?, runScan?, purviewCollection?, scan?: { httpPath, credentialName, integrationRuntimeName? } }` — **persistently register** a Databricks workspace:
  1. Probe its UC catalogs (no account-admin needed).
  2. **Persist** the registration to Cosmos (`metastore-registrations`, PK `/tenantId`, id = workspaceUrl) — this alone makes it **survive Console reloads with no bicep flip**.
  3. If `metastoreId` given + `LOOM_DATABRICKS_ACCOUNT_ID` set → **attach** the workspace to the UC metastore via the account-plane `PUT /accounts/{id}/workspaces/{wsId}/metastore`. A 403 surfaces the account-admin gate (the rest of the call still succeeds).
  4. If `registerPurview` + `LOOM_PURVIEW_ACCOUNT` set → register the workspace as an *Azure Databricks Unity Catalog* Purview source; optionally `runScan` (define + trigger). The scan gates honestly when no Key-Vault Access-Token credential + SQL Warehouse HTTP path is supplied (managed identity is **not** a Databricks scan auth option).

## Persistence (survives reloads — no bicep flip)

Registrations are stored in the `metastore-registrations` Cosmos container (one doc per `workspaceUrl`, PK `/tenantId`). The UC federation reader unions `LOOM_DATABRICKS_HOSTNAMES` (env) with the persisted `workspaceUrl`s (`resolveWorkspaceHostnames()`), so a registered workspace is federated on every subsequent load automatically — the bicep flip on `LOOM_DATABRICKS_HOSTNAMES` is no longer required for a registration to stick.

## Multi-workspace federation

The console reads `LOOM_DATABRICKS_HOSTNAMES` (comma-separated) and falls back to `LOOM_DATABRICKS_HOSTNAME`. Each workspace gets a separate AAD token + REST call; results are deduped so a metastore shared across multiple workspaces appears once. When a workspace is unreachable a synthetic `ERROR_<hostname>` row is returned so the operator sees which workspace is misconfigured (versus a single global 500 hiding the cause).

## NotConfigured gates

- Unity → if `LOOM_DATABRICKS_HOSTNAMES`/`LOOM_DATABRICKS_HOSTNAME` is unset AND no workspace is persisted, the page shows the structured hint with the env var name + bicep module
- UC metastore attach → if `LOOM_DATABRICKS_ACCOUNT_ID` is unset, the attach picker shows an honest "one-click attach not configured" MessageBar (registration + catalog listing still work)
- Fabric → if the UAMI is not in the Fabric service-principals tenant setting, the upstream 403 surfaces verbatim
- Purview → if `LOOM_PURVIEW_ACCOUNT` is unset, the page renders an account-not-configured MessageBar

## Enabling Unity Catalog on a Loom Databricks workspace (one-time, account-admin)

If the catalog tree / metastore list is empty or shows "metastore not listable",
the Databricks **workspace is not attached to a Unity Catalog metastore** (UC is
not enabled on it). UC is an account-level construct: a metastore is created once
per region by a **Databricks account admin** and assigned to the workspace. This
is NOT an Azure ARM action, so the Loom bicep deploy cannot do it for you — it
requires the Databricks **account console**.

### Configured by DEFAULT (2026-06) — recommended

As of 2026-06 the deploy configures Unity Catalog **by default** so that
`Browse > Unity Catalog` shows a real configured metastore/catalog with no manual
clicking. Two prerequisites, both one-time:

1. **Set the Databricks account id.** Export `LOOM_DATABRICKS_ACCOUNT_ID=<account-guid>`
   before the deploy (account console → ⊙ menu → *Account ID*). All UC-supported
   param files (`params/{commercial,commercial-full,gcc,tenant-dmlz}.bicepparam`)
   read it via `readEnvironmentVariable('LOOM_DATABRICKS_ACCOUNT_ID','')`, so no
   param-file edit is needed. The same id is forwarded to the Console container
   env (`main.bicep` → `adminPlane` → `LOOM_DATABRICKS_ACCOUNT_ID`) so Browse can
   list account metastores + offer one-click attach by default. For Azure US
   Government, also set repo var / env `DATABRICKS_ACCOUNT_HOST=accounts.azuredatabricks.us`.
2. **Make the Console UAMI a Databricks account admin** (one-time human step — see
   *Alternative — Account Admin* below; use the UAMI's **Application ID**,
   `LOOM_UAMI_CLIENT_ID`).

With both in place, `landing-zone/databricks-uc-bootstrap.bicep` (a one-shot
`deploymentScript` running as the Console UAMI) creates/assigns the regional
metastore, **creates a default catalog**, and grants the UAMI `account_admin` —
running the same logic as `scripts/csa-loom/enable-unity-catalog.sh`. The
post-deploy bootstrap workflow runs the identical script as a repair/re-run path.
If the UAMI is not yet an account admin the script logs a warning and the deploy
continues (UC enablement is never a hard deploy blocker); enable it later and
re-run. The manual steps below remain valid for older deployments or when you
prefer the least-privilege metastore-admin grant.

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
    --uami-app-id <LOOM_UAMI_CLIENT_ID> \
    --workspace-host <adb-xxxx.region.azuredatabricks.net> --default-catalog main
  ```
  The script finds the existing regional metastore, assigns it, sets the Loom
  UAMI as account admin, and — when `--workspace-host` is reachable — **creates +
  pins a default catalog** so Browse shows a real catalog (idempotent). Runs
  against the Databricks **account API** (not the network-restricted workspace
  host) for the metastore steps, so those work even when the workspace blocks
  public network access; the default-catalog step is best-effort against the
  workspace host. Caller must be a Databricks account admin (one-time; can be a
  service principal for unattended bootstrap).
