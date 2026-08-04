# Changelog

All notable changes to the CSA Loom VS Code extension are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

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
