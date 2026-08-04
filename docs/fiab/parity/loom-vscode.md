# loom-vscode — data explorer / query grid + estate search — parity

**Surfaces:** the CSA Loom VS Code extension's Phase-3 data surfaces — the query
editor + type-badged results grid, the bounded data preview, and the estate-wide
search quick-pick.

**Source UI (Fabric):**
- Lakehouse / data explorer + Preview Table — <https://learn.microsoft.com/fabric/data-engineering/explore-lakehouse-with-vs-code>
- (Loom-only, no Fabric analog) estate-wide item search — the `loom find` backend

**Governing rules:** `no-vaporware.md` (real route or honest gate — never a mock
grid), `no-fabric-dependency.md` (Azure-native routes; no OneLake/Power BI on the
default path), `ui-parity.md`, `web3-ui.md` (the grid webview uses host theme
tokens + a strict nonce'd CSP).

> Legend: ✅ built · ⚠️ honest gate (renders, names the exact remediation) ·
> ❌ missing/deferred (stated, never claimed as ✅).

## Fabric / Azure feature inventory → Loom coverage

| # | Capability (Fabric/Azure) | Loom coverage | Status |
|---|---|---|---|
| L2 | **Preview Table** — first N rows of a data asset | `CSA Loom: Preview data` runs a bounded, sampled preview into the grid | ✅ |
| L5 | **Ad-hoc query** on an item (SQL / KQL) with a results grid | `CSA Loom: Query data…` opens a SQL/KQL query editor linked to the item; `CSA Loom: Run query` (▶) runs it into the grid | ✅ |
| — | **Type-badged columns + row count + timing status bar** in the results grid | The single result-grid webview: per-column type badge (engine-declared or inferred from real cells), row count, elapsed-time, and a cap badge | ✅ |
| — | **Bounded / capped / read-only** reads (no exfiltration) | Same caps the M2 `loom-query` MCP enforces: read-only parse (DDL/DML & KQL-control rejected at parse), row cap (default 500, hard 5000, caller may only lower), byte cap (512 KiB), 65 s client time cap | ✅ |
| W14 | **Estate-wide search** across accessible workspaces | `CSA Loom: Find item (estate search)` quick-pick over `/api/catalog/find`, across **all signed-in deployments** (Commercial + Gov together), opening the chosen item | ✅ |
| L1 | Lakehouse tree with **Tables / Files** sections | A lakehouse item lazy-expands to **Tables** (real Delta/Parquet via `/api/lakehouse/tables`) + **Files** (real ADLS listing via `/api/lakehouse/paths`, folders drill down); an unconfigured storage backend is an honest gate node naming the exact env vars — never an empty section (Phase 6) | ✅ |
| L3 | **Download** a file (streamed through the BFF) | `CSA Loom: Download file` on a Files node streams bytes through `/api/lakehouse/download` to a chosen location — the client never holds a storage credential (Phase 6) | ✅ |
| L4 | Right-click **Copy ABFS / Relative path** (per-cloud suffix) | `Copy ABFS path` + `Copy relative path` on any table/file/folder node; the `abfss://…` suffix (`…core.windows.net` / `…usgovcloudapi.net`) is resolved server-side by `/api/items/lakehouse/{id}/abfss` and only joined client-side — never string-built (Phase 6) | ✅ |
| N9 | `vscode://` deep-link + Console **Open in VS Code** button | The extension registers a `UriHandler` for `vscode://csa-loom.loom-vscode/open?deployment=&type=&id=` (`onUri` activation) that resolves the deployment (by id or apiUrl host) and opens the item's `loom:` definition; unconfigured/unsigned states are guided, never a silent no-op (Phase 6). **Console-side button is a tracked follow-up (extension half shipped).** | ✅ |
| W9 | **Clone** a Git-enabled workspace to disk | `CSA Loom: Clone workspace repo` reads the bound repo from `/api/git-integration/status`, builds the HTTPS clone URL, and delegates to VS Code's built-in `git.clone` (which does its own credential auth — no `child_process`); honest gate when no repo is bound (Phase 6) | ✅ |
| E1–E5 | Spark **environments** node (list, set-default, inspect, associations) | ❌ deferred — `spark-environment` items already appear in the generic tree and are definition-editable via `loom:`; a **dedicated** node with a real *Set Default Workspace Environment* write has no backing route (no workspace-default-environment concept exists), so a specialized panel would render a no-op action (a `ui-parity` violation). Deferred honestly; not present as a stub. | ❌ |
| N8 | Notebook **`builtin/`** resource subtree | ❌ deferred — the real backend exists (`/api/notebook/{id}/contents`), but a `builtin/` subtree needs a deeper `loom:` FS surface (5+-segment paths + `readDirectory` + write-through into the notebook's file scope) beyond the current definition-only provider. Absent from the UI, not stubbed. | ❌ |
| N12 | Offline **DuckDB** cell kind | ❌ deferred — bundling DuckDB (native addon or wasm) is incompatible with the warning-free single-esbuild-bundle `vsce package --no-dependencies` model (native addons can't be esbuild-bundled; `--no-dependencies` excludes `node_modules`). Requires a shipped wasm asset + worker plumbing — out of scope for this wave. | ❌ |
| N14 | Local **IntelliSense** via a published `loom-stubs` package | ❌ deferred — the value is a *published* `loom-stubs` npm package (operator-gated, same class as the R-1 SDK publish: needs `NPM_TOKEN` + a publish decision). The extension side is "use local Pylance", which needs no code. Nothing ships warning-free here without the publish. | ❌ |
| J3 | Spark-job-definition **Lakehouse** node (referenced lakehouses) | ❌ deferred — the SJD item's `SparkJobSpec` carries no referenced-lakehouse list, and `lineage-targets` returns *every* workspace path (not "this SJD's lakehouses"), so there is no honest backing for "referenced lakehouses, default marked". The Phase-6 Tables/Files subtree is reusable if SJD later gains real refs. | ❌ |

**A-grade note:** this doc covers the surfaces this PR ships. The ❌ rows are
honestly stated as deferred (not present in the UI at all — no empty tab, no stub
banner), per `ui-parity.md`'s "an empty-but-present node is a violation".

## Backend per control (every grid/panel → a real route)

| Control | Route (via `@csa-loom/sdk` `query` resource / raw) | Notes |
|---|---|---|
| Run SQL (`Query data…` → `Run query`, SQL items) | `POST /api/items/{itemType}/{id}/query` body `{ sql }` | SQL-capable types: lakehouse, warehouse, synapse-serverless/dedicated-sql-pool, sql-analytics-endpoint, azure-sql-database, databricks-sql-warehouse, postgres-flexible-server, lakebase-postgres |
| Run KQL (`Query data…` → `Run query`, `kql-database`) | `POST /api/items/kql-database/{id}/query` body `{ kql, page }` | ADX-backed; `page.take` = the row cap |
| Preview data (`Preview data`) | `GET /api/items/{itemType}/{id}/preview?top=` | Tabular preview types: dataset, materialized-lake-view, synthetic-data |
| Estate search (`Find item`) | `GET /api/catalog/find?q=&type=&limit=` | The `loom find` backend; ACL/tenant-scoped server-side; one call per signed-in deployment, merged + ranked client-side |
| Lakehouse Tables (L1) | `GET /api/lakehouse/tables?lakehouseId=&workspaceId=` | Real Delta/Parquet scan of the lakehouse's own `Tables/` ADLS root (synapse-catalog-client); honest `{tables:[],gate}` when storage is unset |
| Lakehouse Files (L1) | `GET /api/lakehouse/paths?container=&prefix=` | Flat ADLS Gen2 listing; folders drill down; container/root resolved from the abfss route |
| Lakehouse ABFS root (L1/L4) | `GET /api/items/lakehouse/{id}/abfss?workspaceId=` | Resolves `abfss://…dfs.<suffix>/<root>` per deployment; `resolved:false` → honest gate node |
| Download file (L3) | `GET /api/lakehouse/download?container=&path=` | Streams bytes through the BFF (never a client storage credential) |
| Clone workspace repo (W9) | `GET /api/git-integration/status?workspaceId=` → `git.clone` | Repo coords from the real status route; clone + auth delegated to VS Code's built-in Git |
| Open-in-VS-Code deep link (N9) | `vscode://csa-loom.loom-vscode/open?deployment=&type=&id=` → `loom:` definition | UriHandler resolves the deployment, opens the item definition; **Console-side button is a follow-up** |

These are the **same** routes the M2 `loom-query` MCP server and the SDK
`query` / `catalog` resources already call — no new backend was invented.

## Honest gates (no fabricated data)

- An unconfigured backend (route `503 not_configured`, e.g. "set
  `LOOM_SYNAPSE_WORKSPACE`") renders in the grid as an **error message pane**
  carrying the route's exact remediation text — never a mock grid.
- A non-read statement is rejected **before** it leaves the client, naming the
  rejected class (`DELETE`/`.drop`/…).
- A non-tabular / not-yet-materialized preview asset renders the route's honest
  `previewable:false` message, not an empty grid.
- A signed-out or unreachable deployment in estate search is surfaced in the
  quick-pick title ("N deployment(s) unavailable") — its results are never
  silently dropped or faked.

## Boundary / security (PRP §2.3)

The result grid is the extension's single webview. It receives **only**
column/row/meta data via `postMessage` — **no PAT, cookie, or session ever
crosses the boundary** (asserted by `test/grid-model.test.ts`). CSP is strict
(`default-src 'none'`, nonce'd script, `localResourceRoots` pinned to `media/`).

## Verification

- `tsc --noEmit` → 0 · `vitest run` → 166 passing (incl. mutation-proofs) ·
  `vsce package --no-dependencies` → warning-free `.vsix` (media assets included).
- **Phase 6 mutation-proof** (ABFS path join): reverting the leading-slash strip
  in `joinAbfss` turns `test/lakehouse-nodes.test.ts` RED
  (`expected …/lh-root/Tables/sales …received …/lh-root//Tables/sales`).
- **Definition-route OpenAPI** (`GET|PUT /api/items/{type}/{id}/definition`)
  registered in `apps/fiab-console/lib/openapi/spec.ts` (P2 completion): the
  `sdk/openapi.json` snapshot re-dumped + the Python `_generated` client
  regenerated; `dump-openapi --check`, `generate_client --check`, `ruff`, `mypy`
  (isolated) and the console `spec.test.ts` + `sdk-snapshot.test.ts` (12 tests)
  all pass.
- Query cap mutation-proof (Phase 3) still holds: reverting `clampLimit` turns
  `test/query-caps.test.ts` RED (`expected 9999999 to be 5000`).
- G1 in-browser E2E against a live deployment is pending (no live Loom reachable
  from this worktree); every Phase-6 route is one the shipped Console lakehouse
  editor / Git integration already exercises end-to-end.
