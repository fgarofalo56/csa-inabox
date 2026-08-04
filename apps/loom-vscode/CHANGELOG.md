# Changelog

All notable changes to the CSA Loom VS Code extension are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased] — Phase 4 (MCP servers + `@loom` chat)

### Added

- **MCP server-definition provider** (`vscode.lm.registerMcpServerDefinitionProvider`,
  contribution `mcpServerDefinitionProviders`) — contributes the shipped
  `@csa-loom/mcp` servers (bundled into `dist/mcp/*.mjs`), wired to the active
  deployment's `apiUrl` + stored PAT with no hand-edited `mcp.json`.
  - **Blast-radius default**: only the read-only `loom-catalog` + `loom-query`
    servers are enabled by default. `loom-author` / `loom-ops` / `loom-admin`
    (write/admin) are opt-in via **CSA Loom: Manage MCP servers** / the
    `loom.mcp.enabledServers` setting — never auto-enabled.
  - The PAT is injected at **resolve** time keyed to the descriptor's deployment,
    so a token never reaches a server pointed at another deployment. Only
    PAT-signed-in deployments produce a server; cookie/signed-out ones name the fix.
- **`@loom` chat participant** (`vscode.chat.createChatParticipant`, contribution
  `chatParticipants`) — answers Loom questions by calling the real backend
  (catalog search, item get, bounded query/preview) against the active deployment
  and streaming grounded results. Works with **no** GitHub Copilot licence. When
  unconfigured/signed-out it shows an honest gate — never a fabricated answer.
- **Commands** — `CSA Loom: Select active deployment` (target for MCP + `@loom`)
  and `CSA Loom: Manage MCP servers` (opt-in picker with a modal confirm before
  enabling any write/admin server).
- **Build** — `build.mjs` now bundles each `apps/loom-mcp` server bin into a
  self-contained `dist/mcp/<id>.mjs` (ESM, node target); the `.vsix` ships them
  with no external runtime dependency.
- **Engine** — minimum `engines.vscode` raised to `^1.102.0` (the MCP provider
  API floor); MCP + chat registration is capability-guarded so it degrades to a
  no-op on hosts without the API.
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
