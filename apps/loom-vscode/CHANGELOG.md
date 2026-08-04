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
