# Changelog

All notable changes to the CSA Loom VS Code extension are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased] — Phase 3 (data explorer / query grid + estate search)

### Added

- **Query editor + results grid** — `CSA Loom: Query data…` opens a SQL/KQL query
  editor linked to a data item; `CSA Loom: Run query` (▶) executes it into a
  type-badged results grid webview (per-column type badge, row count, elapsed-time
  status bar, cap badge). SQL → `POST /api/items/{type}/{id}/query {sql}`; KQL →
  the same route with `{kql, page}`.
- **Preview data** — `CSA Loom: Preview data` runs a bounded, sampled preview of a
  previewable asset (dataset / materialized-lake-view / synthetic-data) via
  `GET /api/items/{type}/{id}/preview?top=`.
- **Bounded / capped / read-only reads** — the same exfiltration controls the M2
  `loom-query` MCP enforces: DDL/DML (SQL) and control commands (KQL) rejected at
  parse; row cap (default 500, hard 5000, a caller may only lower it); byte cap
  (512 KiB); a 65 s client time cap.
- **Estate-wide search** — `CSA Loom: Find item (estate search)` searches
  `/api/catalog/find` across **all signed-in deployments** (Commercial + Gov
  together), ranks the merged hits, and opens the chosen item.
- The single result-grid webview receives **only** column/row/meta data — no
  credential crosses the boundary (asserted by a test); strict nonce'd CSP,
  `localResourceRoots` pinned to `media/`.

### Deferred (stated, not stubbed)

Lakehouse Tables/Files tree (L1), file download (L3), Copy ABFS/Relative/URL
(L4), Spark environments (E1–E5), the `vscode://` deep-link (N9) and offline
DuckDB cell (N12). These do not appear in the UI at all — no empty node.

## [0.1.0] — 2026-08-04

Phase 1 — Sign in, browse, edit lifecycle (the smallest genuinely useful
extension).

### Added

- **One extension, one sign-in** — a single `csa-loom.loom-vscode` extension with
  one `Loom: Sign in` exposed as a `vscode.AuthenticationProvider` (id `loom`).
- **Authentication** — device-code (over `POST /api/auth/cli-session`, mirroring
  the `loom` CLI) and PAT paste, both stored in `vscode.SecretStorage`. PATs are
  verified against `/api/v1/whoami` before storing; read-only tokens disable write
  commands with a reason.
- **Multi-deployment, multi-cloud** — `loom.deployments[]` renders several
  deployments simultaneously, including Commercial and Government side by side.
  `apiUrl` is the only per-cloud difference.
- **Explorer tree** — deployments → workspaces (`GET /api/workspaces`) → items
  (`GET /api/workspaces/:id/items`), with a group-by-type toggle over the item
  taxonomy, per-type icons, a workspace hide filter, and an honest offline/empty
  contract (cached-and-marked-stale, never fabricated rows).
- **Item lifecycle** — create (quick-pick over 98 types → `POST
  /api/cosmos-items/:type`), rename (`PATCH`), delete (`DELETE`, with a confirm
  that names the item and warns on the lakehouse→SQL-endpoint cascade).
- **Open in Console** — `openExternal(<apiUrl>/items/<type>/<id>)`.
- **Remove workspace from Explorer** — disconnect-only; nothing deleted remotely.
- **Status bar** — deployment + identity (from `GET /api/auth/me`) + PAT scope.
- **Build/CI** — esbuild bundle, vitest unit tests, and a
  `publish-loom-vscode.yml` workflow (build + typecheck + test + `vsce package` on
  every PR; publish gated on a `loom-vscode-v*` tag).

### Not in this release (later phases)

Notebooks, query, lakehouse explorer, MCP, Copilot, mirror mode, Git/ALM, Spark
job definitions, and functions. Their tree nodes do not appear at all — an
empty-but-present node would be a parity violation.
