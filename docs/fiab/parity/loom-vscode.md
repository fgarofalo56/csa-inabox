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
| L1 | Lakehouse tree with **Tables / Files** sections | ❌ deferred — needs the ADLS list/Delta-catalog surface; query editor + preview cover ad-hoc reads meanwhile | ❌ |
| L3 | **Download** a file (streamed through the BFF) | ❌ deferred (no generic item file-list/stream route wired to the extension yet) | ❌ |
| L4 | Right-click **Copy ABFS / Relative / URL** (per-cloud suffix) | ❌ deferred (depends on L1's path resolution) | ❌ |
| E1–E5 | Spark **environments** node (list, set-default, inspect) | ❌ deferred to a later Phase-3 slice | ❌ |
| N9 | `vscode://` deep-link + Console **Open in VS Code** button | ❌ deferred | ❌ |
| N12 | Offline **DuckDB** cell kind | ❌ deferred | ❌ |

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

- `tsc --noEmit` → 0 · `vitest run` → 85 passing (incl. 3 mutation-proofs) ·
  `vsce package --no-dependencies` → warning-free `.vsix` (media assets included).
- Mutation-proof (query cap cannot be raised): reverting the `clampLimit` ceiling
  guard turns `test/query-caps.test.ts` RED (`expected 9999999 to be 5000`).
- G1 in-browser E2E against a live deployment is pending (no live Loom reachable
  from this worktree); the query/preview/find routes are the same ones the
  shipped Console UI + M2 MCP already exercise end-to-end.
