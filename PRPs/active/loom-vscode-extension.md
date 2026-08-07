# PRP — CSA Loom VS Code extension (`loom-vscode`)

**Title:** One extension, one sign-in, one tree — a CSA Loom developer surface in VS Code that meets or beats the Microsoft Fabric VS Code extension family
**Date:** 2026-08-03 · **Status re-verified 2026-08-06**
**Status:** **SHIPPED (Phases 1–5 landed; distribution/marketplace publish outstanding).** ~~proposed (spec time — every parity row below is ❌ by construction; nothing is built yet)~~

> ### ⚠ Header corrected 2026-08-06 — this PRP said "nothing is built yet"; it is built
>
> Measured against the tree, not against this document:
>
> | Claim | Measured truth | Evidence |
> |---|---|---|
> | "nothing is built yet" | **The extension exists and is substantial** | `apps/loom-vscode/` — **62** TypeScript source files under `src/`, plus `test/`, `media/`, `build.mjs`, `vitest.config.ts` |
> | no packaged extension | `name: loom-vscode`, `publisher: csa-loom`, `version: 0.1.0` | `apps/loom-vscode/package.json` |
> | no commands | **100** `"command":` entries contributed | `apps/loom-vscode/package.json` |
> | phases unbuilt | Phases through **5** are in the changelog with real routes named | `apps/loom-vscode/CHANGELOG.md` — Git/ALM (W9/W10) over `/api/git-integration/{status,commit,pull,resolve}`; Spark job definitions (J1–J6) over `…/[id]`, `…/files`, `…/submit`, `…/runs` |
>
> Parity docs exist for the shipped surfaces: `docs/fiab/parity/loom-vscode.md`,
> `loom-vscode-git-alm.md`, `loom-vscode-spark-job-definition.md`.
>
> **Every ❌ in the parity inventory below is therefore suspect.** Re-measure a row
> against `apps/loom-vscode/src/**` before treating it as forward work. What has
> NOT been established here is a live in-editor E2E receipt (`ux-baseline.md` G1)
> or a marketplace publish — those remain owed.

**Domain:** Developer platform / client tooling. Commercial **and** Government.
**Related:** `apps/loom-cli` (`@csa-loom/cli`), `apps/loom-sdk` (`@csa-loom/sdk`), `PRPs/active/next-waves/PRP-databricks-parity.md` (the "Loom App Runtime" ACA pattern), backlog task #58 (developer toolkit).

**Microsoft grounding (Learn, verified 2026-08-03):**
- Fabric Data Engineering VS Code extension — <https://learn.microsoft.com/fabric/data-engineering/setup-vs-code-extension>
- VFS mode — <https://learn.microsoft.com/fabric/data-engineering/manage-workspace-with-vs-code-vfs-mode>, <https://learn.microsoft.com/fabric/data-engineering/author-notebook-with-vs-code-vfs-mode>
- Notebook authoring (local mode, publish/update/merge, M/L/C decorations) — <https://learn.microsoft.com/fabric/data-engineering/author-notebook-with-vs-code>
- Notebook resources — <https://learn.microsoft.com/fabric/data-engineering/author-notebook-resource-with-vs-code>
- Local vs remote runtime — <https://learn.microsoft.com/fabric/data-engineering/fabric-runtime-in-vscode>
- Spark job definitions — <https://learn.microsoft.com/fabric/data-engineering/author-sjd-with-vs-code>
- Environments — <https://learn.microsoft.com/fabric/data-engineering/manage-environment-with-vs-code>
- Lakehouse explorer — <https://learn.microsoft.com/fabric/data-engineering/explore-lakehouse-with-vs-code>
- Core "Microsoft Fabric" extension + User data functions + Fabric MCP in Chat — <https://learn.microsoft.com/fabric/data-engineering/set-up-fabric-vs-code-extension>
- Fabric Notebook custom agent (preview) — <https://learn.microsoft.com/fabric/data-engineering/notebook-custom-agent-with-vs-code>
- Dev Container escape hatch — <https://learn.microsoft.com/fabric/data-engineering/set-up-vs-code-extension-with-docker-image>
- Pipelines in VS Code (MCP-only, no UI) — <https://learn.microsoft.com/fabric/data-factory/pipelines-manage-vs-code>
- Fabric MCP servers — <https://learn.microsoft.com/rest/api/fabric/articles/mcp-servers/pro-dev-local/get-started-local#install>, <https://learn.microsoft.com/rest/api/fabric/articles/mcp-servers/core-remote/get-started-core>, <https://learn.microsoft.com/fabric/data-warehouse/data-warehouse-mcp-server>
- MSSQL extension ↔ Fabric — <https://learn.microsoft.com/sql/tools/visual-studio-code-extensions/mssql/mssql-fabric-integration?view=sql-server-ver17>
- Item definition contract — <https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/item-definition-overview>
- **Fabric in Azure Government: "Forecasted" for FedRAMP High, DoD IL4, IL5 and IL6 — i.e. NOT generally available** — <https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap#product-general-availability-roadmap>

**Loom grounding (read from the tree, this worktree):** `apps/loom-cli/src/**` (18 files, 8 command groups incl. `context.ts`), `apps/loom-sdk/src/http.ts`, `apps/fiab-console/lib/auth/pat.ts`, `apps/fiab-console/lib/openapi/spec.ts`, `apps/fiab-console/app/api/auth/{cli-session,me,refresh}`, `app/api/workspaces/**`, `app/api/cosmos-items/[type]/[id]/route.ts`, `app/api/notebook/**`, `app/api/warehouse/{query,explain,history}`, `app/api/items/kql-database/[id]/query`, `app/api/sql/trino`, `app/api/catalog/find`, `app/api/git-integration/{status,commit,pull,resolve}`, `lib/workspace/workspace-export.ts`, `lib/types/workspace.ts`, `apps/fiab-mcp-bridge/**`, `azure-functions/mcp-server/**`, `.github/workflows/publish-loom-cli.yml`.

**Governing rules applied:** `.claude/rules/no-fabric-dependency.md` (Azure-native default; the extension must be fully functional with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset), `.claude/rules/no-vaporware.md` (no phase ships scaffolding; every command hits a real backend or shows an honest gate), `.claude/rules/ui-parity.md` (feature-by-feature inventory below + a parity doc per surface), `.claude/rules/ux-baseline.md` (G1 browser/E2E receipt, G2 zero day-one gates with inline Fix-it), `.claude/rules/web3-ui.md` (any webview uses Loom tokens, never ad-hoc CSS).

---

## Executive summary — the strategic why

Microsoft ships **five separate VS Code artifacts** for Fabric, from different teams, with **two different sign-in commands** that do not share a session (`Fabric: Sign in` vs `Fabric Data Engineering: Sign In` — <https://learn.microsoft.com/fabric/data-engineering/set-up-fabric-vs-code-extension>, <https://learn.microsoft.com/fabric/data-engineering/setup-vs-code-extension>), plus a global .NET tool for pipelines and a hand-edited `.vscode/mcp.json`. The Data Engineering extension additionally requires the Jupyter extension and a JDK before it will work at all — a setup tax so real that Microsoft ships an MCR-hosted Dev Container purely to escape it (<https://learn.microsoft.com/fabric/data-engineering/set-up-vs-code-extension-with-docker-image>). **That fragmentation is the clearest thing for Loom to beat, and beating it costs us nothing architecturally: one extension, one sign-in, one tree, zero non-VS-Code prerequisites.**

The second strategic fact is harder and more valuable: **Fabric is not GA in Azure Government.** The Azure Government product roadmap lists Microsoft Fabric as *Forecasted* for FedRAMP High, IL4, IL5 and IL6. A Gov data engineer therefore has **no** Fabric VS Code extension to install, because there is no Fabric tenant to point it at. Loom's whole premise (`no-fabric-dependency.md`) is that the Azure-native backend is the default, so a Loom VS Code extension is the **only** Fabric-class in-editor data-engineering surface that exists at all for Gov. That is not a parity claim; it is a category the incumbent cannot enter.

The third fact is that this is not a from-zero build. Loom already ships the entire non-interactive spine this extension needs, verified in tree:

| Already built | Path | What the extension gets for free |
|---|---|---|
| Scoped API tokens (`loom_pat_<id>_<secret>`, SHA-256-at-rest, typed `read-only`/`read-write`/`admin` scopes, 30d default / 90d max) | `apps/fiab-console/lib/auth/pat.ts` | A revocable bearer credential for `SecretStorage` — no bespoke auth |
| Server-side MSAL **device-authorization grant** (RFC 8628) streamed as NDJSON | `app/api/auth/cli-session/route.ts`; consumer `apps/loom-cli/src/commands/auth.ts` | Interactive sign-in **without** an Entra authority matrix in the client — token acquisition happens server-side, so **one binary serves Commercial and Gov; only `--api-url` differs** |
| Typed REST client with cookie **or** PAT bearer, envelope normalization, no third-party HTTP dep | `apps/loom-sdk/src/http.ts`, `src/client.ts` | The extension's transport layer |
| OpenAPI 3.1 contract for the stable surface | `apps/fiab-console/lib/openapi/spec.ts`, served at `GET /api/openapi.json` | A pinned contract + `sdk-contract.yml` CI gate to break the build on drift |
| Workspace + item CRUD | `GET/POST /api/workspaces`, `GET/POST /api/workspaces/:id/items`, `GET/PATCH /api/cosmos-items/[type]/[id]` | The tree and item lifecycle |
| Notebook compute | `POST/GET/DELETE /api/notebook/[id]/session` (real Synapse **Livy** sessions or Databricks execution contexts, `?probe=1` tells the client which), `POST /api/notebook/[id]/execute`, `GET/PUT /api/notebook/[id]/contents` (Jupyter Server contents over the AML CI tunnel) | A real `NotebookController` — remote Spark, per-cell, warm session |
| Query engines | `POST /api/warehouse/query` + `/explain` + `/history`, `POST /api/items/kql-database/[id]/query`, `POST /api/sql/trino` | SQL/KQL/federated execution |
| Estate search | `GET /api/catalog/find` | Command-palette "Go to item" |
| Git integration | `/api/git-integration/{status,commit,pull,resolve}` | ALM commands |
| Portable bundles with **secret-scrubbing by construction** | `lib/workspace/workspace-export.ts` (`.loomws`), `/api/items/loom-app-runtime/[id]/export` (`.loomapp`) | The serializer the new item-definition route reuses |
| MCP: in-repo Functions server (`POST /api/mcp`, streamable-HTTP JSON, `x-api-key`), stdio→HTTP/SSE bridge Container App | `azure-functions/mcp-server/function_app.py`, `apps/fiab-mcp-bridge/src/server.mjs` | Copilot Chat tools with **zero** hand-edited `mcp.json` |

**Honest gaps in that spine, stated up front.** `git tag -l` returns **no** `loom-cli-v*` or `loom-sdk-v*` tags, so `@csa-loom/cli` and `@csa-loom/sdk` have **never been published** — `.github/workflows/publish-loom-cli.yml` only publishes on that tag push. The extension therefore cannot `npm i @csa-loom/sdk` today (see §2.2 and R-1). And Loom has **no generic item-definition route**: `app/api/cosmos-items/[type]/[id]/route.ts` exports only `GET` and `PATCH` over the item's `state?: Record<string, unknown>` field (`lib/types/workspace.ts:246`) — there is nothing equivalent to Fabric's `Get/Update Item Definition`. Building one is Phase 1 work item **P1.5**, not an assumption.

---

## 1 — Feature inventory / parity matrix

Per `ui-parity.md`: every capability the five Fabric VS Code artifacts expose, and Loom's planned equivalent. **Legend:** ✅ built · ⚠️ honest gate (renders, names the exact remediation, offers Fix-it) · ❌ MISSING. **Everything is ❌ at spec time.** The `Ph` column is the phase that closes it; a `↑` in "Beat" marks where the Loom design is deliberately better than Fabric's.

### 1.1 Structure, install, prerequisites

| # | Fabric capability | Fabric source | Loom equivalent | Ph | Status | Beat |
|---|---|---|---|---|---|---|
| S1 | **Five** marketplace artifacts: `SynapseVSCode.synapse`, `fabric.vscode-fabric`, `fabric.vscode-fabric-functions`, `fabric.vscode-fabric-mcp-server`, `ms-mssql.mssql` | [set-up-fabric-vs-code-extension](https://learn.microsoft.com/fabric/data-engineering/set-up-fabric-vs-code-extension), [setup-vs-code-extension](https://learn.microsoft.com/fabric/data-engineering/setup-vs-code-extension) | **One** extension `csa-loom.loom-vscode` covering tree + notebooks + data explorer + query + MCP + chat | 1–4 | ❌ | ↑ |
| S2 | **Two** sign-in commands, no shared session (`Fabric: Sign in` / `Fabric Data Engineering: Sign In`) | same two pages | **One** `Loom: Sign in`, exposed as a `vscode.AuthenticationProvider` (id `loom`) so every Loom surface *and* third-party extensions reuse the same session | 1 | ❌ | ↑ |
| S3 | Requires the **Jupyter extension** (`ms-toolsai.jupyter`) | [setup-vs-code-extension](https://learn.microsoft.com/fabric/data-engineering/setup-vs-code-extension) | None — VS Code's built-in `vscode.ipynb` serializer provides the `jupyter-notebook` notebook type; we contribute only a `NotebookController` | 2 | ❌ | ↑ |
| S4 | Requires a **JDK** (marketplace README; absent from Learn) | [marketplace](https://marketplace.visualstudio.com/items?itemName=SynapseVSCode.synapse) | None — Loom never executes Spark on the client | 2 | ❌ | ↑ |
| S5 | Dev Container escape hatch (MCR image w/ JDK + Conda + Jupyter) to make setup bearable | [set-up-vs-code-extension-with-docker-image](https://learn.microsoft.com/fabric/data-engineering/set-up-vs-code-extension-with-docker-image) | Optional `.devcontainer` for repo contributors; **never a prerequisite for users** | 5 | ❌ | ↑ |
| S6 | Pipelines require a separate global .NET tool + hand-edited `.vscode/mcp.json` | [pipelines-manage-vs-code](https://learn.microsoft.com/fabric/data-factory/pipelines-manage-vs-code) | MCP servers registered programmatically via `McpServerDefinitionProvider` — no JSON editing, no external tool | 4 | ❌ | ↑ |

### 1.2 Authentication, tenancy, multi-cloud

| # | Fabric capability | Fabric source | Loom equivalent | Ph | Status | Beat |
|---|---|---|---|---|---|---|
| A1 | Sign in with VS Code accounts; credentials in the OS secure store | [set-up-fabric-vs-code-extension#sign-in](https://learn.microsoft.com/fabric/data-engineering/set-up-fabric-vs-code-extension) | Device-code via `POST /api/auth/cli-session` (NDJSON stream) **or** PAT paste; both land in `vscode.SecretStorage` | 1 | ❌ | = |
| A2 | Tenant switcher — one tenant active at a time | [set-up-fabric-vs-code-extension#switch-tenants](https://learn.microsoft.com/fabric/data-engineering/set-up-fabric-vs-code-extension) | **Deployment switcher**: `loom.deployments[]` holds N deployments; the tree shows them **simultaneously**, including a Commercial and a Gov deployment side by side in one window | 1 | ❌ | ↑ |
| A3 | Non-interactive / CI auth from the extension | not documented | Scoped PAT (`lib/auth/pat.ts`) with `read-only` / `read-write` / `admin`; extension defaults to the least scope the active command needs and says so before writing | 1 | ❌ | ↑ |
| A4 | Sovereign-cloud support | n/a — Fabric is *Forecasted*, not GA, in Gov ([roadmap](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap#product-general-availability-roadmap)) | **One binary, all clouds.** Token acquisition is server-side, so the client holds no Entra authority/endpoint matrix; `apiUrl` is the only difference | 1 | ❌ | ↑ |
| A5 | Sign out / session status | implied | `Loom: Sign out`, status-bar item showing deployment + identity from `GET /api/auth/me`, token-expiry warning before the 401 | 1 | ❌ | = |

### 1.3 Workspace and item management (core extension)

| # | Fabric capability | Fabric source | Loom equivalent | Ph | Status |
|---|---|---|---|---|---|
| W1 | View all workspaces in an explorer; filter which ones show | [set-up-fabric-vs-code-extension#manage-your-workspaces-and-item](https://learn.microsoft.com/fabric/data-engineering/set-up-fabric-vs-code-extension) | `GET /api/workspaces` tree, per-deployment filter persisted in workspace state | 1 | ❌ |
| W2 | Group items by type / flat list toggle | same | Same toggle; type groups come from the 98-entry taxonomy already in `apps/loom-cli/src/item-types.ts` | 1 | ❌ |
| W3 | Create any item type (`+` → type → name) | same | Quick-pick over the same taxonomy → `POST /api/cosmos-items/[type]` (the route the Console's `NewItemGate` uses) | 1 | ❌ |
| W4 | Rename an item | same | `PATCH /api/cosmos-items/[type]/[id]` | 1 | ❌ |
| W5 | Delete an item | same | `DELETE` on the item route, with a confirm that names the item and warns on cascade | 1 | ❌ |
| W6 | **Open in Explorer** — edit an item's *definition* locally | [item-definition-overview](https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/item-definition-overview) | `loom:` `FileSystemProvider` over a **new** `GET\|PUT /api/items/[type]/[id]/definition` route (P1.5) | 1 | ❌ |
| W7 | Open the item in the product (portal) | [set-up-fabric-vs-code-extension](https://learn.microsoft.com/fabric/data-engineering/set-up-fabric-vs-code-extension) | `Loom: Open in Console` → `vscode.env.openExternal` to `<apiUrl>/items/<type>/<id>` | 1 | ❌ |
| W8 | Browse workspace **folders** | same | Folder nodes from the same item list (folders are already modelled in `.loomws`) | 3 | ❌ |
| W9 | Clone a Git-enabled workspace | same | `Loom: Clone workspace repo` over `/api/git-integration/status` + the bound repo config | 5 | ❌ |
| W10 | Version control for items | same | `Loom: Git status / Commit / Pull / Resolve` mapped 1:1 onto `/api/git-integration/{status,commit,pull,resolve}` | 5 | ❌ |
| W11 | Multiple workspaces in one window (VFS mode only) | [manage-workspace-with-vs-code-vfs-mode](https://learn.microsoft.com/fabric/data-engineering/manage-workspace-with-vs-code-vfs-mode) | Multi-workspace **and** multi-deployment in **both** modes — not a mode-gated feature | 1 | ❌ |
| W12 | Remove a workspace disconnects only; nothing deleted remotely | same | Identical semantics, stated in the confirm dialog | 1 | ❌ |
| W13 | Cannot create items inside workspace folders (documented limitation) | [set-up-fabric-vs-code-extension](https://learn.microsoft.com/fabric/data-engineering/set-up-fabric-vs-code-extension) | Create *into* a folder supported from day one | 3 | ❌ |
| W14 | — (no equivalent) | — | **Estate search** in the command palette via `GET /api/catalog/find` (the `loom find` backend) | 3 | ❌ |

### 1.4 Notebooks

| # | Fabric capability | Fabric source | Loom equivalent | Ph | Status |
|---|---|---|---|---|---|
| N1 | Create notebook (name + description) → created remotely, appears in tree | [author-notebook-with-vs-code](https://learn.microsoft.com/fabric/data-engineering/author-notebook-with-vs-code) | `POST /api/cosmos-items/notebook` then open through the `loom:` FS | 2 | ❌ |
| N2 | Download to a local work folder (`Set Local Work Folder`) | same | `Loom: Set local work folder` + `Loom: Download item` (mirror mode) | 2 | ❌ |
| N3 | Open Notebook Folder in the notebook editor | same | Open the `.ipynb` from the mirror **or** directly over `loom:` (no mode ceremony) | 2 | ❌ |
| N4 | Delete → prompt "local only" vs "local + remote" | same | Same two-way prompt; docs' "close the editor first to avoid failure" caveat is handled by closing the editor for the user instead of warning | 2 | ❌ |
| N5 | **Publish** local → remote with merge-conflict prompt; portal users get Accept/Reject | same | `Loom: Publish` → `PUT …/definition` with an `If-Match` ETag; a 412 opens the diff instead of clobbering | 2 | ❌ |
| N6 | **Update** remote → local; opens the VS Code **diff editor** (left = workspace, right = local); Merge button, otherwise stays Conflict | same | Same diff/merge flow using `vscode.diff` | 2 | ❌ |
| N7 | **4-state tree decoration** — default (remote-only), **M** yellow (edited, unpublished), **L** green (downloaded, identical), **C** red (conflict) | same | Same four states via `FileDecorationProvider`, same letters and colour semantics — Fabric's decoration model is genuinely good; we copy it | 2 | ❌ |
| N8 | Notebook **resources**: a `builtin/` folder (`.py`, `.csv`, images) as a local filesystem; anything outside `builtin/` is **not** uploaded | [author-notebook-resource-with-vs-code](https://learn.microsoft.com/fabric/data-engineering/author-notebook-resource-with-vs-code) | `builtin/` subtree under the item's `loom:` URI, backed by `GET/PUT /api/notebook/[id]/contents`; out-of-scope writes fail loudly instead of silently not uploading | 2 | ❌ |
| N9 | **Open in VS Code** button from the product page (Desktop / Web variants) | [author-notebook-with-vs-code](https://learn.microsoft.com/fabric/data-engineering/author-notebook-with-vs-code), [-web](https://learn.microsoft.com/fabric/data-engineering/author-notebook-with-vs-code-web) | A Console-side **Open in VS Code** button emitting `vscode://csa-loom.loom-vscode/open?...` handled by a `UriHandler`. *Note the console already has a Commercial-only "Open in VS Code for Web" AML deep-link at `app/api/notebook/[id]/lsp/route.ts` — this is a different, all-cloud surface and must not be confused with it* | 3 | ❌ |
| N10 | Remote execution on the **Microsoft Fabric Runtime** kernel: PySpark, Spark SQL, Scala, Python | [author-notebook-with-vs-code-vfs-mode](https://learn.microsoft.com/fabric/data-engineering/author-notebook-with-vs-code-vfs-mode) | `NotebookController` "CSA Loom Spark" → `POST /api/notebook/[id]/session` (Livy or Databricks context, chosen by `?probe=1`) + `POST …/execute`; same four languages via cell magics | 2 | ❌ |
| N11 | Warm session reuse across cells | implied by Livy/kernel model | Explicit: session id is reused; `DELETE …/session` on "Stop"; the route's own 60–90s cold-pool reality is surfaced as progress, not a hang | 2 | ❌ |
| N12 | **Local execution** — conda envs for Runtime 1.1/1.2 only; **no local env is created for 1.3+** (effectively remote-only today) | [fabric-runtime-in-vscode](https://learn.microsoft.com/fabric/data-engineering/fabric-runtime-in-vscode) | Loom is honest and *narrower on purpose*: **no fake local Spark.** Instead an offline **DuckDB** cell kind (`apps/loom-duckdb` already exists as the sub-second tier) for real disconnected SQL over local Parquet/Delta, plus plain local Python via the user's own interpreter | 3 | ❌ |
| N13 | **View Recent Runs** — run list, per-run detail incl. Spark config, download stdout/stderr/driver logs, open Spark History Server, **Cancel Job** | [author-notebook-with-vs-code-vfs-mode#monitor-the-execution-history-of-the-notebook](https://learn.microsoft.com/fabric/data-engineering/author-notebook-with-vs-code-vfs-mode#monitor-the-execution-history-of-the-notebook) | Same panel over the existing run/monitor routes; Cancel maps to `DELETE …/session` + the Livy kill path | 2 | ❌ |
| N14 | IntelliSense (via Jupyter + the local Python env) | implied | **Local Pylance/Pyright** (already installed for any Python dev) + a published `loom-stubs` typing package for `notebookutils`/`spark` globals. Loom's server-side pylsp bridge (`lib/lsp/pylsp-bridge.mjs`, discovery `GET /api/notebook/[id]/lsp`) stays a **browser-only** surface — reusing it in VS Code would be strictly worse than local Pylance | 3 | ❌ |
| N15 | Live/version history of a notebook | [how-to-use-notebook#version-history](https://learn.microsoft.com/fabric/data-engineering/how-to-use-notebook#version-history) | Loom's item-version store already records versions on save; expose as `Loom: Version history` with diff | 5 | ❌ |

### 1.5 Spark job definitions

| # | Fabric capability | Fabric source | Loom equivalent | Ph | Status |
|---|---|---|---|---|---|
| J1 | **Create Spark Job Definition** (name, referenced lakehouse, default lakehouse) | [author-sjd-with-vs-code](https://learn.microsoft.com/fabric/data-engineering/author-sjd-with-vs-code) | Create the Loom `spark-job-definition` item; lakehouse pickers resolve to Loom lakehouse items (ADLS+Delta), never OneLake | 5 | ❌ |
| J2 | **Files** node — main definition file + referenced libraries; upload new files | same | Same node over the item's definition parts | 5 | ❌ |
| J3 | **Lakehouse** node — all referenced lakehouses, default marked, `Files/…` `Tables/…` relative access | same | Same, resolved against the Azure-native lakehouse | 5 | ❌ |
| J4 | **Run** node — run history + per-run status | same | Same over the Livy batch/job history | 5 | ❌ |
| J5 | Submit a run | same | Real Livy batch submit | 5 | ❌ |
| J6 | Full CRUD | same | Same | 5 | ❌ |

### 1.6 Spark environments

| # | Fabric capability | Fabric source | Loom equivalent | Ph | Status |
|---|---|---|---|---|---|
| E1 | **Environment** tree node listing workspace environments | [manage-environment-with-vs-code](https://learn.microsoft.com/fabric/data-engineering/manage-environment-with-vs-code) | Same, over `/api/spark-environment` | 3 | ❌ |
| E2 | `workspace default` label | same | Same | 3 | ❌ |
| E3 | **Set Default Workspace Environment** | same | Same, a real write | 3 | ❌ |
| E4 | **Inspect** — details rendered as **JSON in the right panel** | same | A **typed read-only detail view** (runtime, hardware profile, libraries, Spark conf) — a raw JSON dump would violate `loom_no_freeform_config`; ↑ over Fabric | 3 | ❌ |
| E5 | Check environment ↔ notebook association on hover | same | Same, plus reverse lookup ("which items use this environment") | 3 | ❌ |

### 1.7 Lakehouse / data explorer

| # | Fabric capability | Fabric source | Loom equivalent | Ph | Status |
|---|---|---|---|---|---|
| L1 | Lakehouse tree with **Tables** and **Files** sections, all workspace lakehouses under one root | [explore-lakehouse-with-vs-code](https://learn.microsoft.com/fabric/data-engineering/explore-lakehouse-with-vs-code) | Same tree over the ADLS Gen2 + Delta backend (`adls-client`, `synapse-sql-client`) — **no OneLake on the default path** | 3 | ❌ |
| L2 | **Preview Table** — first 100 rows | same | Same, executed on the DuckDB tier (`apps/loom-duckdb`) so preview is sub-second, falling back to Synapse serverless; result grid is a Loom-token webview with **type-badged columns + timing status** per `ux-standards.md` | 3 | ❌ |
| L3 | **Download** a file | same | Same, streamed through the BFF (never a client-side storage credential) | 3 | ❌ |
| L4 | Right-click **Copy ABFS path / Copy Relative Path / Copy URL** | same | Same three, `abfss://…dfs.core.windows.net` (Commercial) / `…dfs.core.usgovcloudapi.net` (Gov) resolved per deployment | 3 | ❌ |
| L5 | — | — | ↑ **Ad-hoc query** on any table node: SQL → `POST /api/warehouse/query`, KQL → `POST /api/items/kql-database/[id]/query`, federated → `POST /api/sql/trino`; `EXPLAIN` via `/api/warehouse/explain`, history via `/api/warehouse/history` | 3 | ❌ |

### 1.8 SQL databases (Fabric delegates this to the MSSQL extension)

| # | Fabric capability | Fabric source | Loom equivalent | Ph | Status |
|---|---|---|---|---|---|
| Q1 | Browse Fabric workspaces from the MSSQL extension | [mssql-fabric-integration](https://learn.microsoft.com/sql/tools/visual-studio-code-extensions/mssql/mssql-fabric-integration?view=sql-server-ver17) | Loom's own tree already lists `azure-sql-database` / `warehouse` items | 3 | ❌ |
| Q2 | Connect to a Fabric SQL DB / SQL analytics endpoint | same | `Loom: Open in MSSQL` — hand the connection profile to `ms-mssql.mssql` when installed (**optional** integration, never a prerequisite); otherwise Loom's own query editor | 3 | ❌ |
| Q3 | **Provision** a Fabric SQL DB from VS Code | same | Provision the Azure-native equivalent (`azure-sql-database` item → real ARM) from the same `+` flow | 5 | ❌ |

### 1.9 Serverless functions (Fabric User data functions)

| # | Fabric capability | Fabric source | Loom equivalent | Ph | Status |
|---|---|---|---|---|---|
| F1 | Create a User data functions item | [create-user-data-functions-vs-code](https://learn.microsoft.com/fabric/data-engineering/user-data-functions/create-user-data-functions-vs-code) | Create the Loom `user-data-function` item (Azure Functions-backed) | 5 | ❌ |
| F2 | Open + edit locally | same | Same over the `loom:` FS or mirror mode | 5 | ❌ |
| F3 | Add new functions | same | Same | 5 | ❌ |
| F4 | **Run + debug locally with breakpoints** | same | Real local debug via a contributed `DebugConfigurationProvider`; requires Python + Azure Functions Core Tools — **the same prerequisites Fabric documents** (.NET 8, Python, Core Tools v4), declared as an honest gate with a Fix-it that installs/points at them | 5 | ❌ |
| F5 | Refresh connections + libraries | same | Same | 5 | ❌ |
| F6 | Publish local changes | same | Same | 5 | ❌ |
| F7 | Work across tenants | same | Across **deployments and clouds** | 5 | ❌ |
| F8 | Git-enabled functions | same | Via W10 | 5 | ❌ |

### 1.10 Copilot, MCP, agents

| # | Fabric capability | Fabric source | Loom equivalent | Ph | Status | Beat |
|---|---|---|---|---|---|---|
| M1 | Fabric MCP server auto-registered by a **separate extension** | [get-started-local](https://learn.microsoft.com/rest/api/fabric/articles/mcp-servers/pro-dev-local/get-started-local#install) | Same extension registers Loom's MCP servers via `McpServerDefinitionProvider` — the in-repo Functions server (`POST /api/mcp`, streamable-HTTP JSON, `x-api-key` from `SecretStorage`) and the `loom-mcp-bridge` Container App | 4 | ❌ | ↑ |
| M2 | Fabric agent mode in VS Code Chat: navigate item definitions, invoke REST, read docs, CRUD tenant items | [set-up-fabric-vs-code-extension](https://learn.microsoft.com/fabric/data-engineering/set-up-fabric-vs-code-extension) | Loom tools registered with `vscode.lm.registerTool` so **GitHub Copilot agent mode** can drive Loom (list/create items, run a query, run a notebook cell, read the catalog) — each tool declares its PAT scope and confirms before any write | 4 | ❌ | = |
| M3 | Requires GitHub Copilot Chat | same | ↑ A `@loom` **chat participant** backed by Loom's own orchestrator (`/api/copilot/orchestrate`, `/api/copilot/complete`) so users **without** GitHub Copilot still get in-editor help — and Gov, where Copilot licensing is frequently absent, is covered | 4 | ❌ | ↑ |
| M4 | Fabric Notebook custom agent (preview) — Fabric-aware notebook authoring | [notebook-custom-agent-with-vs-code](https://learn.microsoft.com/fabric/data-engineering/notebook-custom-agent-with-vs-code) | Loom notebook-aware mode of `@loom`, reusing `/api/notebook/[id]/assist` and `/api/copilot/notebook-assist` (both already built) | 4 | ❌ | = |
| M5 | Remote Fabric Core MCP + Data Warehouse MCP (single `executeSQL` tool) | [core-remote](https://learn.microsoft.com/rest/api/fabric/articles/mcp-servers/core-remote/get-started-core), [data-warehouse-mcp-server](https://learn.microsoft.com/fabric/data-warehouse/data-warehouse-mcp-server) | Loom's `REMOTE_BUILTIN_MCP_CATALOG` (13 entries, 2 default-ON and auth-free) surfaced in the picker, filtered by the deployment's cloud via `serversForCloud()` | 4 | ❌ | ↑ |

### 1.11 Data pipelines

| # | Fabric capability | Fabric source | Loom equivalent | Ph | Status | Beat |
|---|---|---|---|---|---|---|
| P1 | **No VS Code UI at all** — pipelines are reachable only through Copilot Chat + the DataFactory MCP global .NET tool behind a `--pipeline` flag | [pipelines-manage-vs-code](https://learn.microsoft.com/fabric/data-factory/pipelines-manage-vs-code) | Read-only pipeline tree + **Run**, run history, and per-activity status over the existing `data-pipeline` / `adf-pipeline` routes; authoring stays in the Console canvas via `Open in Console` (**stated as a deliberate boundary, not a gap** — a canvas in a webview would be a `ui-parity.md` violation, not parity) | 5 | ❌ | ↑ |

---

## 2 — Architecture

### 2.1 Package + repo layout

`apps/loom-vscode/` — a sibling of `apps/loom-cli` and `apps/loom-sdk`, following the same shape (`package.json` + `tsconfig.json` + `vitest.config.ts` + `src/` + `test/`; the repo has **no root `pnpm-workspace.yaml`**, so each app installs independently).

```
apps/loom-vscode/
  package.json          # name @csa-loom/vscode, publisher csa-loom, engines.vscode ^1.95
  src/
    extension.ts        # activate(): register everything, no top-level await
    auth/               # AuthenticationProvider, SecretStorage, device-code flow
    api/                # LoomApi — thin wrapper over the SDK transport
    tree/               # Deployments -> Workspaces -> Types -> Items; Lakehouse tree
    fs/                 # loom: FileSystemProvider + FileDecorationProvider (M/L/C)
    notebook/           # NotebookController, session lifecycle, run history
    query/              # SQL/KQL/Trino execution + result-grid webview host
    mcp/                # McpServerDefinitionProvider, lm tools, @loom participant
    webview/            # the ONLY webview bundle (result grid + run detail)
    gates/              # honest-gate rendering + Fix-it command dispatch
  media/                # webview assets, Loom tokens (no ad-hoc CSS)
  test/                 # vitest unit; @vscode/test-electron integration
```

Build: **esbuild** to a single `dist/extension.js` (VS Code extensions must ship bundled; per-app installs make an unbundled `node_modules` untenable). Package with `@vscode/vsce`, mirror with `ovsx`.

### 2.2 Talking to the Loom BFF

**Transport = `@csa-loom/sdk`.** The SDK already implements exactly what the extension needs: bearer-PAT **or** cookie auth, envelope normalization for Loom's non-uniform route shapes, `LoomApiError`, injectable `fetch`, zero third-party HTTP deps (`apps/loom-sdk/src/http.ts`).

**The unpublished-SDK problem is real and must be solved, not assumed away.** No `loom-sdk-v*` tag exists. Two options; the PRP picks (a):

- **(a) Publish `@csa-loom/sdk` first** (tag `loom-sdk-v0.1.0` → `.github/workflows/publish-loom-sdk.yml`) and depend on the published version. Clean provenance, one source of truth, and it unblocks the `npm i -g @csa-loom/cli` line in the CLI README that is currently a lie. **Requires the operator to confirm the npm publish (R-1).**
- (b) Interim: `"@csa-loom/sdk": "file:../loom-sdk"` + esbuild inlining. Works locally and in CI, but the `.vsix` then carries an unversioned copy — acceptable only for pre-release builds.

**No direct Azure calls, ever.** Every operation goes through the Loom BFF. The extension never holds an ARM token, a storage key, or a Kusto/Synapse credential; file downloads and query results stream through the BFF. This keeps the private-endpoint / VNet posture intact (a Gov deployment is reachable only through Front Door / the P2S VPN) and means the extension inherits every authorization check the routes already enforce.

**Contract pinning.** `GET /api/openapi.json` is served unauthenticated and there is already an `sdk-contract.yml` workflow. The extension adds its consumed paths to that contract test so a BFF shape change breaks CI here rather than in a user's editor.

### 2.3 Extension host vs webview — the boundary rule

> **The extension never re-implements a Loom editor.**

Loom has 98 item types and ~466 parity docs' worth of Fluent v9 editors. Porting them to webviews would produce exactly the thin-form/JSON-textarea outcome `ui-parity.md` forbids. The split is therefore:

| Runs in | What | Why |
|---|---|---|
| **Extension host (Node)** | Auth, `SecretStorage`, all HTTP, tree providers, `FileSystemProvider`, `FileDecorationProvider`, `NotebookController`, `UriHandler`, MCP + LM tools, status bar, commands | Only the host may touch credentials. **No credential, PAT, or session cookie ever crosses into a webview** — webviews receive already-fetched, already-authorized data via `postMessage` only. |
| **VS Code native UI** | Tree views, notebook editor, diff editor, quick picks, `MarkdownString` hovers, progress/notifications | Native beats a bespoke webview on a11y, theming, keyboard nav, and cost. |
| **Webview (exactly one bundle)** | Result grid (type-badged columns + row count + timing status bar), run-detail panel, lakehouse table preview | These have no native VS Code equivalent. Built with Loom design tokens per `web3-ui.md`; `enableScripts` on, strict CSP with a nonce, `localResourceRoots` pinned to `media/`. |
| **External browser** | Every rich editor / canvas / designer | `Loom: Open in Console` → `vscode.env.openExternal`. |

**Deliberate deferral, stated honestly:** embedding the Console in a `WebviewPanel` iframe would require the BFF to emit `frame-ancestors vscode-webview:` in its CSP. Loom's CSP is load-bearing and has broken production before (Front Door caches the HTML; see the `csp_nonce_frontdoor_breaks` incident). This PRP does **not** propose that change. External browser is the answer until an operator explicitly asks otherwise (R-5).

### 2.4 Authentication across Commercial + Government

```
VS Code                          Loom Console (per deployment)        Entra (per cloud)
────────                         ─────────────────────────────        ─────────────────
Loom: Sign in
  └─ POST /api/auth/cli-session ──►  server-side MSAL device-auth  ──►  login.microsoftonline.com
       (NDJSON stream)                grant (RFC 8628)                  OR login.microsoftonline.us
  ◄── {device_code, user_code, verification_uri}
  show modal + copy code, openExternal(verification_uri)
  ◄── {session: <encrypted loom_session cookie>}
  store in vscode.SecretStorage keyed by deployment id
```

The decisive property, verified in `apps/loom-cli/src/commands/auth.ts` + `app/api/auth/cli-session/route.ts`: **token acquisition happens server-side.** The client never picks an authority host, a scope, or a national-cloud endpoint. Consequences:

- **One extension binary serves Commercial, GCC, GCC-High and IL5.** No `AzureCloud`/`AzureUSGovernment` branch in the client, no per-cloud build, no per-cloud marketplace listing.
- Device-code requires the deployment's Entra app to allow **public-client flows**. If it does not, the route fails with a specific error; the extension surfaces it as an honest gate naming the app-registration setting, with a Fix-it that switches the user to PAT sign-in. (This is a known Loom operational hazard — the MSAL-secret outage class — so the gate must distinguish "public-client disabled" from "app credential expired".)
- **PAT is the CI/headless path** and the fallback everywhere: paste `loom_pat_…`, stored in `SecretStorage`, sent as `Authorization: Bearer`. Scope is displayed in the status bar; a `read-only` token makes every write command visibly disabled rather than failing at the 403.
- **Credential storage**: `vscode.SecretStorage` (OS keychain) only. Never a settings value, never a file, never a workspace-state entry — the extension refuses to start a session if `SecretStorage` is unavailable and says why.
- **Multi-deployment is the tenancy model.** `loom.deployments` is `[{ id, name, apiUrl, cloud }]`; each holds an independent secret. A user can hold a Commercial and a Gov session at once — Fabric's tenant switcher is single-active.

### 2.5 The `loom:` virtual file system + the item-definition contract

URI shape: `loom://<deploymentId>/<workspaceId>/<itemType>/<itemId>/<part>`.

Backing routes today: `GET/PATCH /api/cosmos-items/[type]/[id]` (item `state`) and `GET/PUT /api/notebook/[id]/contents` (real `.ipynb` through the Jupyter Server contents API on the AML compute instance). **That is not enough for a general definition surface**, so Phase 1 adds:

**`GET | PUT /api/items/[type]/[id]/definition`** — new BFF route, built on the existing `lib/workspace/workspace-export.ts` serializer so it inherits three properties that are already load-bearing in `.loomws`:
1. **Secret-scrubbing by construction** — any `state` key naming a secret is excluded and the exclusion path is recorded; `…Ref` keys (reference names, not values) survive.
2. **`state.provisioning` excluded** — per-estate Azure backend references must never travel with a definition, or two items end up pointing at one backend.
3. **`schemaVersion` per row** so an older client can refuse a newer definition instead of corrupting it.

Plus, new for the VS Code path: an **ETag / `If-Match`** on `PUT` so concurrent edits produce a 412 → diff editor (N5/N6) instead of a silent clobber. Fabric's own docs warn users to close editors "to avoid failure"; we make the failure impossible instead of documenting it.

**Two authoring modes, both first-class, no remote-window ceremony** (Fabric makes VFS mode reachable only via *Open a Remote Window* → *Open Fabric Data Engineering Workspaces*):

| | Direct mode (default) | Mirror mode |
|---|---|---|
| Storage | nothing on disk; `loom:` URIs | files under `loom.localWorkFolder` |
| Save | write-through on save (`PUT …/definition`) | explicit `Publish` / `Update` |
| Decorations | dirty/clean | full **M / L / C** model (N7) |
| Multi-workspace | yes | yes |
| Multi-deployment | yes | yes |

### 2.6 Offline / disconnected behaviour

Per `no-vaporware.md` an unreachable backend must produce a precise, actionable state — never a blank tree and never fabricated data.

- **Activation never requires the network.** The extension activates on `onStartupFinished`, renders deployments from settings and the last-known tree from `ExtensionContext.globalState`, and marks every stale node with a "last synced <time>" tooltip. Nothing is presented as live when it is not.
- **Reads over `loom:`** fail with `FileSystemError.Unavailable` carrying the deployment name and the underlying reason (DNS, 403, 503-gate).
- **Writes are never queued silently.** A failed publish leaves the local buffer dirty and raises a notification with **Retry** / **Save a copy**; there is no invisible outbox that could later overwrite someone else's change.
- **Genuinely offline work that still functions:** editing any mirrored file, `.ipynb` authoring, local Python execution against the user's own interpreter, and the **DuckDB cell kind** (N12) over local Parquet/Delta. We do **not** claim offline Spark — and we note that Fabric's own local-execution story is effectively gone on Runtime 1.3+ ([fabric-runtime-in-vscode](https://learn.microsoft.com/fabric/data-engineering/fabric-runtime-in-vscode)), so an honest narrow claim beats a false broad one.
- **Air-gapped installs** are a distribution problem, not a runtime one — see §4 Phase 5 and R-3.

### 2.7 Honest gates (G2) inside the editor

Every gate follows the Console's G2 contract, translated to VS Code idiom: a notification or tree-node warning that (a) names the exact env var / role / setting, (b) offers an inline **Fix it** action wired to a command that actually sets it or opens the precise Console admin page, and (c) is registered in the same gate registry (`lib/gates/registry`) the Admin gate page reads, so a gate resolved in VS Code disappears in the browser and vice versa. A bare "not configured" message with no Fix-it is non-compliant here exactly as it is in the Console.

### 2.8 Telemetry posture

**Default OFF.** No independent telemetry endpoint; nothing is sent to Microsoft, to the marketplace, or to us. If `loom.telemetry.enabled` is explicitly turned on **and** `vscode.env.isTelemetryEnabled` is true, events go to the **operator's own** Loom Application Insights through the BFF — the same instance their Console already writes to. Command names and durations only; never file contents, query text, item names, URLs, or identity. This is the only defensible posture for a Gov-targeted tool and it needs an explicit operator sign-off (R-4).

---

## 3 — Per-cloud deltas (explicit, not assumed)

| Concern | Azure Commercial | Azure Government (GCC / GCC-High / IL5) | Handling |
|---|---|---|---|
| **The incumbent** | Full Fabric extension family available | **None.** Fabric is *Forecasted*, not GA, for FedRAMP High / IL4 / IL5 / IL6 ([roadmap](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap#product-general-availability-roadmap)) — there is no tenant for the extension to attach to | Loom is the only in-editor Fabric-class surface in Gov. Say so in the README and the parity doc. |
| **Entra authority** | `login.microsoftonline.com` | `login.microsoftonline.us` | **No client change** — resolved server-side by `/api/auth/cli-session` (§2.4). |
| **Storage / ABFS paths (L4)** | `…dfs.core.windows.net` | `…dfs.core.usgovcloudapi.net` | Copy-path commands read the deployment's resolved suffix from the BFF; never string-built in the client. |
| **Unity Catalog** | Databricks UC available | **No Databricks Unity Catalog.** Loom Unity (`apps/loom-unity`) is the substitute | The catalog tree binds to whichever metastore the deployment reports via `/api/catalog/metastores`; the extension must not assume UC. |
| **Notebook compute** | Synapse Spark (Livy) or Databricks execution contexts | Synapse Spark (Livy). Databricks path may be absent | `GET /api/notebook/[id]/session?probe=1` already returns the backend — the compute picker is driven by the probe, never hardcoded. |
| **VS Code for the Web deep-link** | Available (AML compute-instance) | **Unavailable** — `app/api/notebook/[id]/lsp/route.ts` already gates it on `CSA_LOOM_BOUNDARY === 'Commercial'` | The extension re-uses that same probe; the action is absent (not disabled-with-tooltip) in Gov. |
| **GitHub Copilot** | Commonly licensed | Frequently unlicensed / not permitted | M2 (LM tools) degrades to absent; **M3 (`@loom` participant on Loom's own AOAI)** is the primary path and must not depend on Copilot. |
| **Marketplace egress** | Reachable | Often blocked; some estates use VS Code Server / forks without VS Marketplace | Phase 5 ships an `.vsix` GitHub Release asset, an **Open VSX** mirror, and a Console-served download so a Gov user can `code --install-extension` from inside the boundary (R-3). |
| **MCP servers** | Full catalog | `serversForCloud('gcc'|'gcc-high'|'il5')` already filters to `govSafe` / `airGapSafe`; IL5 is air-gap-safe + an allowlist | The MCP picker calls that selector; Fabric/Power BI MCP entries are `govSafe:false` and stay off every default path. |
| **Network reachability** | Public FQDN | Front Door + private endpoints; often admin VPN (P2S) only | Connection failures must say "unreachable from this network — Loom Gov requires the admin VPN", not "sign-in failed". |
| **Egress from the extension** | BFF only | BFF only | Same rule both clouds; the only hosts contacted are the configured `apiUrl`s (and, if enabled, Open VSX/Marketplace for updates). |

---

## 4 — Phased delivery

Every phase is independently shippable and end-to-end functional per `no-vaporware.md`. **A phase that only adds tree nodes is not a phase.** Each carries a G1 in-editor E2E receipt against a live deployment.

### Phase 1 — Sign in, browse, edit, save (the smallest genuinely useful extension)

A user installs the extension, signs in, sees their real workspaces and items, creates an item, opens its definition, edits it, saves it, and sees the change in the Console. Nothing is stubbed.

- **P1.1** `apps/loom-vscode` scaffold: `package.json` contributions, esbuild bundle, `vitest` unit tests, `@vscode/test-electron` integration harness, and `.github/workflows/publish-loom-vscode.yml` running build + typecheck + test + `vsce package` on every PR touching the app (mirroring the lesson baked into `publish-loom-cli.yml`: a test that only runs on a release tag is a test nobody runs). Publish steps gated on a `loom-vscode-v*` tag.
- **P1.2** Auth: `LoomAuthenticationProvider` (id `loom`), device-code flow over `/api/auth/cli-session`, PAT paste, `SecretStorage`, `loom.deployments` setting + `Loom: Add deployment` wizard, status bar (deployment · identity · PAT scope) from `GET /api/auth/me`.
- **P1.3** Explorer tree: Deployments → Workspaces (`GET /api/workspaces`) → group-by-type toggle → Items (`GET /api/workspaces/:id/items`), with refresh, filter, and the offline/stale contract from §2.6.
- **P1.4** Item lifecycle: create (quick-pick over the 98-type taxonomy → `POST /api/cosmos-items/[type]`), rename (`PATCH`), delete (`DELETE`, with a confirm that names cascades).
- **P1.5** **New BFF route** `GET | PUT /api/items/[type]/[id]/definition` (§2.5) — secret-scrubbed, `schemaVersion`-stamped, ETag/`If-Match`. Unit tests + a route test; added to `lib/openapi/spec.ts` and the `sdk-contract.yml` pin.
- **P1.6** `loom:` `FileSystemProvider` (direct mode) — read, write-through save, stat, delete; `Loom: Open definition`.
- **P1.7** `Loom: Open in Console` (`openExternal`) and `Loom: Find item` (`GET /api/catalog/find`).
- **P1.8** Honest gates + Fix-it plumbing (§2.7); `docs/fiab/parity/loom-vscode.md` created with §1 as its inventory.
- **P1.9** SDK publication (`loom-sdk-v0.1.0`) so the extension depends on a published package — **operator-gated (R-1)**.

**Explicitly not in Phase 1:** notebooks, query, lakehouse, MCP, mirror mode. Their tree nodes do not appear at all — an empty-but-present node is the "tab that renders empty" `ui-parity.md` forbids.

### Phase 2 — Notebooks that actually run

- **P2.1** `NotebookController` "CSA Loom Spark" on the built-in `jupyter-notebook` type (no Jupyter-extension dependency): session create/reuse via `POST /api/notebook/[id]/session`, `?probe=1`-driven compute picker (Spark pool vs Databricks cluster), per-cell `POST …/execute`, streamed output, interrupt → `DELETE …/session`.
- **P2.2** Cold-pool honesty: a 60–90s Livy start renders as determinate progress with the pool name, never a frozen cell.
- **P2.3** Notebook item CRUD + `builtin/` resource subtree over `GET/PUT /api/notebook/[id]/contents`; out-of-scope writes rejected loudly.
- **P2.4** **Mirror mode**: `loom.localWorkFolder`, Download / Publish / Update, `vscode.diff` merge, and the **M / L / C** `FileDecorationProvider`.
- **P2.5** Run history panel: run list, per-run Spark config, stdout/stderr/driver log download, Cancel Job.
- **P2.6** `loom-stubs` typing package published so local Pylance resolves `notebookutils` / `spark` globals.

### Phase 3 — Data explorer, query, environments

- **P3.1** Lakehouse tree (Tables / Files), **Preview Table** (100 rows via the DuckDB tier), **Download file** (streamed through the BFF), **Copy ABFS / Relative / URL** with per-cloud suffix resolution.
- **P3.2** The single result-grid webview: type-badged columns, row count, elapsed-time status bar, Loom tokens, strict CSP, no credentials.
- **P3.3** Query execution: SQL → `/api/warehouse/query` (+ `explain`, `history`), KQL → `/api/items/kql-database/[id]/query`, federated → `/api/sql/trino`. Optional `ms-mssql.mssql` handoff (Q2).
- **P3.4** Spark environments node: list, `workspace default` badge, **Set Default**, typed inspect view, notebook↔environment association + reverse lookup.
- **P3.5** Offline **DuckDB cell kind** (N12) and the `vscode://` `UriHandler` + Console-side **Open in VS Code** button (N9).
- **P3.6** Workspace folders (W8, W13) and estate search polish (W14).

### Phase 4 — Copilot, MCP, agents

- **P4.1** `McpServerDefinitionProvider` registering Loom's in-repo MCP server (`POST /api/mcp`, `x-api-key` from `SecretStorage`) and the `loom-mcp-bridge` Container App — zero `mcp.json` editing.
- **P4.2** Remote built-in MCP picker filtered by `serversForCloud(cloud)`; Fabric-family entries stay `govSafe:false` and off default paths.
- **P4.3** `vscode.lm.registerTool` Loom tools for Copilot agent mode, each declaring its PAT scope and confirming before writes.
- **P4.4** `@loom` chat participant over `/api/copilot/orchestrate` + `/api/copilot/complete` — works with **no** GitHub Copilot licence; notebook-aware mode over `/api/notebook/[id]/assist`.

### Phase 5 — ALM, jobs, functions, distribution

- **P5.1** Git commands (W9, W10) over `/api/git-integration/*`; `.loomws` export/import from the tree.
- **P5.2** Spark job definitions (J1–J6): Files / Lakehouse / Run nodes, submit, history.
- **P5.3** User data functions (F1–F8) including local F5 debug with the honestly-gated Core Tools prerequisite.
- **P5.4** Pipelines: read-only tree + Run + run history, with `Open in Console` for authoring (P1) and item version history (N15).
- **P5.5** Distribution: VS Marketplace listing, **Open VSX** mirror, signed `.vsix` on GitHub Releases, a Console-served in-boundary download for air-gapped installs, `README` + `CHANGELOG` + Learn-style docs under `docs/fiab/`.

---

## 5 — Acceptance criteria (verifiable, per phase)

Common to every phase, per `no-vaporware.md` + `ux-baseline.md` G1: the PR body carries a **real-data receipt** — the endpoint hit, the first 300 chars of the real response, a screenshot or recording of the VS Code surface, and any bicep/route diff. `tsc` + `vitest` are necessary and **not sufficient**. Each phase is verified on a **Commercial** deployment and, where the surface exists there, on **Gov**.

**Phase 1**
1. `code --install-extension loom-vscode-<v>.vsix` on a clean profile with **no** other extension installed (no Jupyter, no MSSQL, no Copilot, no JDK) activates without error — receipt: the extension host log.
2. `Loom: Sign in` completes the device-code flow against a live deployment; the status bar shows the signed-in identity from a real `GET /api/auth/me` body.
3. **Both clouds from one window**: a Commercial and a Gov deployment configured simultaneously, both trees populated, with the same `.vsix` — screenshot showing both roots expanded.
4. The tree lists the *same* workspace and item counts the Console shows for that user — side-by-side screenshot.
5. Create → rename → delete an item from the tree; each verb's real BFF response in the receipt, and the item's appearance/disappearance confirmed in the Console UI.
6. Open an item definition over `loom:`, edit, save; a subsequent `GET …/definition` returns the edited body and the Console renders the change.
7. **Secret-scrub proof**: an item whose `state` holds a secret-named key exports a definition with that key absent and its path listed in the scrub manifest — asserted by a route test *and* shown in the receipt.
8. **Concurrency proof**: edit the same item in the Console and in VS Code; the VS Code save returns 412 and opens the diff editor rather than clobbering.
9. Offline proof: disable the network — the tree still renders with stale markers, and a `loom:` read fails with a message naming the deployment and reason. No blank pane, no fabricated rows.
10. A `read-only` PAT makes every write command visibly disabled with a reason (not a 403 after the click).
11. `docs/fiab/parity/loom-vscode.md` exists with §1's inventory and honest ❌s for unshipped phases.

**Phase 2**
1. A notebook opened from the tree executes a PySpark cell on **real** remote compute — receipt: the Livy session id, the state transition to `idle`, and the real cell output.
2. Spark SQL, Scala, and Python cells each execute (matching Fabric's four languages).
3. Session reuse proven: a variable set in cell 1 is readable in cell 5 with the same session id.
4. Cold start renders as progress; a 90s pool start produces no frozen UI — recording.
5. Cancel Job kills a running cell — receipt: the kill response and the cell's cancelled state.
6. Run history shows real prior runs; stdout/stderr/driver logs download and are non-empty.
7. Mirror-mode round trip: Download → edit → **M** decoration → Publish; then edit remotely → Update → diff → Merge → **L** decoration. Conflict path produces **C**. Screenshots of all four states.
8. `builtin/` resource written from VS Code is visible to the running notebook (a cell reads the file back).
9. `notebookutils` completes in a local editor with `loom-stubs` installed — screenshot.

**Phase 3**
1. Lakehouse tree lists real Tables and Files; **Preview Table** returns 100 real rows with typed column badges and an elapsed-time readout.
2. **Copy ABFS path** on a Gov deployment yields a `…usgovcloudapi.net` path; on Commercial a `…core.windows.net` path — both pasted into the receipt.
3. Download a real file; byte size matches the tree's reported size.
4. A SQL query, a KQL query, and a Trino federated query each return real rows in the grid; `EXPLAIN` returns a real plan; history lists the executed statements.
5. Set Default Workspace Environment is a real write, confirmed by re-reading the environment and by the Console.
6. The DuckDB cell answers a query over a local Parquet file with the network fully disabled — recording.
7. `vscode://` deep link from the Console opens the correct item in VS Code.
8. Webview audit: no credential or session value present in any `postMessage` payload — asserted by a test that inspects the messages.

**Phase 4**
1. Copilot Chat (agent mode) lists Loom MCP tools with **no** hand-edited `mcp.json` — screenshot of the tool list plus a real `tools/call` response.
2. A write-capable LM tool prompts for confirmation and refuses under a `read-only` PAT.
3. On a Gov deployment, the MCP picker shows only `govSafe` entries; a Fabric-family entry is absent — screenshot.
4. `@loom` answers a grounded question with **GitHub Copilot uninstalled**, using Loom's own orchestrator — recording.

**Phase 5**
1. Git status/commit/pull against a real bound repo — receipt: the commit sha.
2. A Spark job definition is created, a library uploaded, a run submitted, and the run appears in history with a real status.
3. A user data function runs locally with a breakpoint hit, then publishes and returns a real HTTP response from the deployed endpoint.
4. `.vsix` installs from the Console-served download on a machine with VS Marketplace blocked — recording.
5. Open VSX listing installs into a VS Code fork.
6. The parity doc `docs/fiab/parity/loom-vscode.md` shows **zero ❌** across §1 rows scoped to Phases 1–5, with every ⚠️ carrying a named remediation.

---

## 6 — Risks and open questions

### Operator decisions required (blocking where noted)

| # | Decision | Why it needs the operator | Blocks |
|---|---|---|---|
| **R-1** | **Publish `@csa-loom/sdk` (and `@csa-loom/cli`) to npm.** No `loom-sdk-v*`/`loom-cli-v*` tag exists; the CLI README's `npm install -g @csa-loom/cli` currently does not work. | Requires the `NPM_TOKEN` secret and a public-package decision for a public repo. | P1.9 (workaround: `file:` dep for pre-release) |
| **R-2** | **Marketplace publisher identity.** VS Marketplace publishers are Entra-backed Azure DevOps identities; verified-publisher status needs domain verification (e.g. `limitlessdata.ai`). Extension id `csa-loom.loom-vscode` is squattable until claimed. | Legal/brand ownership; not an engineering call. | Phase 5 (and claim the id early) |
| **R-3** | **Air-gapped distribution.** Choose: GitHub Release `.vsix` only / Open VSX mirror / a Console-served download. **There is no static-asset route today** — `app/api/downloads/route.ts` is a Cosmos-backed *download ledger*, not a file server, so a Console-served `.vsix` is new work. | Affects whether Gov users can install at all. | Phase 5 |
| **R-4** | **Telemetry posture.** This PRP proposes default-OFF, operator-Application-Insights-only, command names + durations only. Confirm or tighten. | Compliance posture for FedRAMP/IL customers. | Phase 1 (settings shape) |
| **R-5** | **Extension signing / self-hosted `.vsix` trust.** Marketplace-published extensions are signed by the Marketplace; a self-hosted `.vsix` is not, and VS Code surfaces that difference. Decide whether to accept it or to add our own signature + documented verification step. | Security posture; may require a code-signing certificate. | Phase 5 |
| **R-6** | **Console framing.** Confirm we are **not** relaxing CSP `frame-ancestors` for `vscode-webview:`. This PRP assumes external-browser deep links. | CSP changes have caused a production outage before (Front Door HTML caching). | §2.3 (assumed no) |
| **R-7** | **PAT default scope + TTL for the extension.** `read-write` is needed for editing; `admin` never. TTL defaults to 30d (max 90d) — confirm the extension should prompt for re-issue rather than silently degrade. | UX vs. credential-lifetime policy. | Phase 1 |

### Technical risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| T-1 | **No generic item-definition route exists.** `cosmos-items/[type]/[id]` exports only GET + PATCH over `state`. | Phase 1's central feature depends on new BFF work, and definitions differ per item type. | P1.5 builds it on the proven `.loomws` serializer; Phase 1 ships with a **typed allow-list** of item types whose definition round-trips are tested, and types outside it show an honest "edit in Console" node rather than a lossy editor. |
| T-2 | **Round-trip data loss.** A definition that drops a field on `GET`→`PUT` silently destroys configuration. | Data loss — worse than a missing feature. | Property-based round-trip tests per allow-listed type; `PUT` rejects a body whose `schemaVersion` it does not recognise; ETag guards concurrent writes. |
| T-3 | **BFF envelope non-uniformity** (already documented in `apps/loom-sdk/src/http.ts`: some routes return bare arrays, some bare objects, some `{ok,…}`). | Brittle client parsing. | Only consume routes pinned in `lib/openapi/spec.ts`; extend `sdk-contract.yml` to cover every path the extension calls. |
| T-4 | **Device-code needs public-client flows enabled** on the deployment's Entra app; Loom has a history of login-path breakage (AADSTS7000215 class). | Sign-in fails with a cryptic Entra code. | The gate distinguishes "public client disabled" / "credential expired" / "network unreachable" and each has a distinct Fix-it; PAT sign-in always remains available as the escape hatch. |
| T-5 | **`vscode.lm` / MCP provider APIs move fast** and some are recent additions. | A pinned `engines.vscode` too low breaks; too high excludes users. | Phase 4 declares its own minimum `engines.vscode`; MCP/LM registration is behind capability checks so Phases 1–3 keep working on older VS Code. |
| T-6 | **Notebook execution latency.** Livy cold start is 60–90s per the route's own comment; the BFF proxy has a ~30s hard timeout. | Cells appear to hang; naive implementations time out. | Poll-until-idle (the pattern the Console editor already uses), determinate progress with the pool name, and a documented "keep the session warm" affordance. |
| T-7 | **Per-app installs, no root workspace.** Adding a fourth `node_modules` app increases CI cost and the known parallel-install corruption hazard. | Flaky CI. | Its own workflow with path filters; esbuild bundling means the shipped artifact has no runtime deps. |
| T-8 | **Scope creep into re-implementing editors.** The most likely way this ships as vaporware. | 98 thin webview forms — a direct `ui-parity.md` violation. | The §2.3 boundary rule is normative: any PR adding a second webview bundle must justify it against that rule in review. |
| T-9 | **Gov validation is hard** — no local Gov `az`, verification runs through Actions, and the estate is often VPN-only. | Gov acceptance receipts get skipped, and "works in Gov" becomes an unverified claim. | Every phase's Gov receipt is produced by a workflow run (the established Gov-verify-via-Actions pattern), and a phase is not done without it. |
| T-10 | **Marketplace review + name collisions.** "Loom" is a common product name (there is an unrelated well-known Loom). | Listing rejection or user confusion. | Display name **"CSA Loom"**, id `csa-loom.loom-vscode`, and a README that disambiguates in the first line. Claim the id during Phase 1 even though publish is Phase 5. |

### Open questions (non-blocking, needing an answer before the phase that depends on them)

1. Which item types enter the Phase-1 definition allow-list? Proposal: `notebook`, `data-pipeline`, `report`, `semantic-model`, `kql-queryset`, `spark-job-definition` — the six with the most obvious file-shaped definitions.
2. Should the extension expose Loom's server-side pylsp bridge as an optional `LanguageClient` for users **without** local Python? Currently deferred as strictly worse than local Pylance (N14).
3. Does mirror mode belong in `.gitignore` by default, or should the local work folder be commit-friendly (Fabric's model is ambiguous here)?
4. Should `Loom: Find item` search the whole estate (`/api/catalog/find`) or only visible deployments? Estate-wide is more useful and leaks more.
5. Do we ship a `loom-vscode` MCP tool that *drives the extension itself* (open item, run cell), so an agent can operate the editor? Powerful, and a real confused-deputy risk.

---

## 7 — Cross-cutting requirements

- **Bicep sync (`no-vaporware.md` §bicep):** Phases 1–4 add **no** Azure resource. Phase 1 adds one BFF route (no env var). Phase 5's Console-served `.vsix` download adds a storage container + one env var and must land in `platform/fiab/bicep/modules/**` and the `apps[]` env list in `admin-plane/main.bicep` in the same PR.
- **Parity doc:** `docs/fiab/parity/loom-vscode.md`, created in Phase 1 with §1 as its inventory and updated every phase. A-grade requires zero ❌ in the shipped scope.
- **Tests:** `vitest` for pure logic (URI parsing, definition round-trip, decoration state machine, gate resolution); `@vscode/test-electron` for activation, tree population, FS provider, and notebook controller registration; a contract test against `GET /api/openapi.json`.
- **Docs:** `apps/loom-vscode/README.md` (accurate from day one — unlike the CLI README, which today omits four live command groups), a Learn-style guide under `docs/fiab/`, a Console Help-Center entry, and a `CHANGELOG.md`.
- **Security review:** the extension is a new credential holder. Its PR must cover — `SecretStorage` only (never settings/state/disk); no credential in any `postMessage`; strict webview CSP with a nonce and pinned `localResourceRoots`; no `child_process` execution of user-supplied strings; no path traversal in the mirror-mode writer (the CLI's `safe-path.ts` regression suite is the precedent to copy); and no host other than the configured `apiUrl`s contacted at runtime.
- **Sequencing note:** Phase 1 is a prerequisite for everything. Phases 2 and 3 are independent of each other and may run in parallel. Phase 4 depends on Phase 1 only. Phase 5 depends on Phases 1–3 for its ALM surfaces and on R-2/R-3/R-5 for distribution.
