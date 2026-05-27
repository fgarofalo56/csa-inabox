# Loom User Data Function Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. Fabric "User Data Functions" (UDF) = serverless Python 3.11.9 functions hosted in Fabric, invokable from Pipelines, Notebooks, Activator, Power BI translytical flows, and external REST callers. Each `@udf.function()` exposes its own Entra-secured HTTPS endpoint.

## Overview

User Data Functions provide a serverless compute layer inside Fabric so analysts and engineers can author reusable business logic once and call it from every Fabric workload plus external apps. Authoring is Python-only with the `fabric-user-data-functions` PyPI package pre-installed; the editor enforces a `Develop` vs `Run only` mode separation so unpublished code is sandboxed in a 15-minute test session and only `Publish` makes it available for invocation. Connections to Fabric SQL DB / Warehouse / Lakehouse / Mirrored DB / Variable Library are first-class via the `@udf.connection` decorator — credentials never appear in code.

## UI components

### Header chrome
- **Item name** + workspace breadcrumb
- **Mode switcher** (top-right): `Develop` ↔ `Run only`
- **Share** button (Share / Edit / Execute permissions)
- **Publish** button (Develop mode only — global, publishes all functions in the item)
- **Status bar** (bottom): test-session indicator · last-published timestamp · publish in-progress spinner

### Home toolbar
- **Settings** (description, sensitivity label, endorsement, manage connections, library management)
- **Refresh**
- **Language selector** (read-only — Python only)
- **Generate invocation code** dropdown:
  - **Client code** → Python / C# / Node.js with `InteractiveBrowserCredential` scaffold + per-function REST URL
  - **Notebook code** → Python using `mssparkutils.userDataFunction`
  - **OpenAPI spec** → JSON or YAML, includes auth (bearer), per-function schemas, standard 400/401/403/408/413/500 errors
- **Manage connections** (opens Settings → Connections panel)
- **Library management** (opens Settings → Libraries panel)
- **Open in VS Code** (launches the `fabric.vscode-fabric-functions` extension)
- **Publish**

### Edit toolbar (Develop mode only)
- **Reset code** — reverts unpublished edits to last-published snapshot
- **Undo / Redo / Copy / Paste**
- **Insert sample** — code-template menu (SQL CRUD, Lakehouse files, HTTP call, Variable Library, etc.)
- **Manage connections** / **Library management** (duplicated shortcuts)
- **Find and replace**
- **Publish**

### Functions list (left pane)
- One entry per `@udf.function()` discovered in the file
- Hover reveals **Test** (Develop) or **Run** (Run only) icon
- Unpublished functions marked with a circle / "edited" badge
- Right-click menu: Rename · Delete · Copy invocation URL

### Code editor (center, Monaco)
- Python syntax highlighting, autocomplete, hover docs
- Linting against the `fabric.functions` SDK
- Required boilerplate enforced: `import fabric.functions as fn` + `udf = fn.UserDataFunctions()`
- Decorator-aware folding for `@udf.function()` blocks
- In Develop mode: full editor; in Run only mode: read-only viewer of published code

### Test panel (Develop mode, opens on Test icon)
- **Function selector** dropdown (published + unpublished)
- **Parameters form** — typed inputs derived from function signature (default values pre-filled)
- **Test button** — kicks off the 15-min test session
- **Test output** pane — return value or error trace
- **Logs output** pane — captures `logging.info/warn/error` from the function body

### Run panel (Run only mode, opens on Run icon)
- Same layout as Test panel but only published functions
- Used to validate what end-users with Execute permission will see

### Settings → Manage connections
- Per-item table of connections: alias · source type · source name
- **Add connection** flow: OneLake catalog picker (SQL DB / Warehouse / Lakehouse / Mirrored DB / Variable Library)
- Per-row Edit (rename alias) · Delete
- Warning banner: renaming an alias breaks any function still referencing the old name

### Settings → Library management
- Public libraries (PyPI) — search + version pin
- Private libraries — upload `.whl`
- Per-library version history
- Save triggers a function-app rebuild

### Settings → Item details
- Description / sensitivity label / endorsement
- Workspace identity / owner (functions are owner-editable only — limitation)
- Region info (UDF is not GA in all regions; banner if unsupported)

## What Loom has

- `apps/fiab-console/lib/editors/phase4-editors.tsx` lines 487-560: `UserDataFunctionEditor`
- Cosmos persistence of: `runtime` (python/node/dotnet), `entrypoint`, `source` (textarea), `functionAppName`, `connections` (free-text)
- One ribbon: Function (Reload / Save) + Deploy (Deploy to Function App — placeholder)
- Plain `<textarea>` for code — no Monaco
- A MessageBar explicitly discloses: *"v2.1: code + config persisted. Deploy-to-Azure-Functions wiring (ARM Microsoft.Web/sites publish) is deferred to v2.x"*
- C-grade verdict — config saves to Cosmos, no real deploy, no test invoke, no logs, no connection picker

## Gaps for parity

1. **Develop / Run-only mode switch** — Loom has no mode concept; everything is "edit"
2. **Monaco code editor** with Python autocomplete + `fabric.functions` SDK awareness
3. **Per-function discovery** — Loom treats the whole file as one blob; no `@udf.function()` parser populating a functions list
4. **Test panel** — no test session, no parameter form, no output / logs panes
5. **Publish flow** — no real publish; "Deploy to Function App" is a stub
6. **Logs viewer** — no integration with App Insights / Function App logs
7. **Manage connections UI** — `connections` is a free-text field, not an alias-bound OneLake picker
8. **Library management UI** — no PyPI search, no `requirements.txt` editing surface
9. **Generate invocation code dialog** — no Python / C# / Node.js / OpenAPI generator
10. **Insert sample templates** — no template gallery
11. **Open-in-VS-Code link** — Loom has no equivalent (no Fabric VS Code extension parallel)
12. **Variable Library connection** — no `fn.FabricVariablesClient` story
13. **Region availability banner** — no awareness that UDF is GA only in subset of regions
14. **Owner-only edit lock** — no enforcement
15. **Cooldown warning** — Fabric requires 2-min gap between publishes; Loom has no equivalent if/when deploy is wired

## Backend mapping

- **Compute backend = Azure Functions** (Microsoft.Web/sites, Linux Consumption or Premium plan, Python 3.11 runtime). Fabric UDF is itself a managed Azure Functions instance under the hood.
- **Deploy path** (deferred today):
  - `az functionapp create` via ARM → returns scm endpoint
  - Zip-deploy `source.py` + generated `function.json` + `requirements.txt` via `POST {scm}/api/zipdeploy`
  - Or use `Microsoft.Web/sites/extensions/zipdeploy` ARM action
- **Test session** ≈ a Functions "run" against a staging slot, or a local container exec via the Fabric Functions Core Tools v4
- **Connections** map to Functions App Settings (KeyVault references) or Managed-Identity-bound resource role assignments
- **Logs** = App Insights `traces` table filtered by `operation_Name == <function_name>`
- **Variable Library equivalent** = Azure App Configuration + Key Vault references
- **Generate-invocation OpenAPI** = the Functions OpenAPI extension (`Microsoft.Azure.WebJobs.Extensions.OpenApi`) — already exposed in some Loom function-backed surfaces

## Required Azure resources

- **Azure Function App** (Linux Consumption Y1 or Premium EP1) — needs to be either pre-provisioned per Loom deployment or created on first publish
- **Storage account** for the Function App (already required by Functions runtime)
- **App Insights** for logs / test output pane
- **Key Vault** for connection secrets when not using Managed Identity
- **User-assigned managed identity** on the Function App with role assignments to: Fabric SQL DB, Warehouse, Lakehouse (Storage Blob Data Contributor on the workspace OneLake container)
- **Bicep** module: `platform/fiab/bicep/modules/loom-udf-host.bicep` (does not exist yet — net-new for v2.x)

## Estimated effort

4-5 sessions for B-grade parity:
- Session 1: Monaco Python editor + `@udf.function()` parser → functions list (3 h)
- Session 2: Develop/Run mode switch + test panel UI shell (parameters form, output, logs tabs) (3 h)
- Session 3: Real Function App deploy via ARM zipdeploy + Bicep module for the host (5 h)
- Session 4: Test-invoke wired to the deployed function + App Insights log streaming (3 h)
- Session 5: Manage-connections OneLake picker + library management surface (3 h)

A+ parity (variable library, generate-invocation-code dialog, VS Code launcher, multi-region awareness) is another 2-3 sessions on top.
