# CSA Loom for VS Code

**CSA Loom** (not the unrelated video tool) — browse, create, rename, delete and
open your CSA Loom **workspaces and items** from inside VS Code. One extension,
one sign-in, one tree. Azure-native: **no Microsoft Fabric tenant required**, and
because Fabric is not GA in Azure Government, this is the only Fabric-class
in-editor data surface that exists there at all.

> Through **Phase 3** — the functional core (sign in, browse, create/rename/
> delete, open in Console), notebooks on remote Spark, and the data explorer
> (query editor + results grid, preview, estate search). MCP, Copilot and Git/ALM
> land in later phases (see the roadmap below). Every shipped surface is real
> end-to-end; no tab shows a stub.

## Why one extension

Microsoft ships **five** VS Code artifacts for Fabric with **two** sign-in
commands that don't share a session, plus a global .NET tool and a hand-edited
`mcp.json`. CSA Loom is **one** extension, **one** `Loom: Sign in` (exposed as a
`vscode.AuthenticationProvider`, id `loom`, that any extension can reuse), and
**zero** non-VS-Code prerequisites (no Jupyter extension, no JDK).

## Install

Until the Marketplace listing is live (Phase 5), install the packaged `.vsix`:

```bash
code --install-extension loom-vscode-0.1.0.vsix
```

## Configure a deployment

A *deployment* points at one Loom Console. Add one via **CSA Loom: Add
deployment…**, or in `settings.json`:

```jsonc
"loom.deployments": [
  { "name": "Commercial", "apiUrl": "https://csa-loom.limitlessdata.ai", "cloud": "commercial" },
  { "name": "Government", "apiUrl": "https://loom.example.us",           "cloud": "gov" }
]
```

`apiUrl` is the **only** per-cloud difference — the same extension talks to
Commercial **and** Government, side by side in one window, because token
acquisition happens server-side.

## Sign in

**CSA Loom: Sign in** offers two methods, both stored in the OS keychain
(`vscode.SecretStorage`) and nowhere else:

- **Your account (device code)** — a browser opens; enter the shown code. Mirrors
  the `loom` CLI's flow over `POST /api/auth/cli-session`.
- **API token (PAT)** — paste a `loom_pat_…` token. It's verified against
  `/api/v1/whoami` before storing; a **read-only** token disables create / rename
  / delete with a reason (no surprise 403).

The status bar shows the signed-in identity (from `GET /api/auth/me`), the
deployment, and the PAT scope.

## What you can do (Phase 1)

| Command | Backend |
|---|---|
| Browse deployments → workspaces → items | `GET /api/workspaces`, `GET /api/workspaces/:id/items` |
| **Toggle group by type** | client-side over the live item taxonomy |
| **Create item…** (quick-pick over 98 types) | `POST /api/cosmos-items/:type` |
| **Rename…** | `PATCH /api/cosmos-items/:type/:id` |
| **Delete…** (confirm names the item + cascade) | `DELETE /api/cosmos-items/:type/:id` |
| **Open in Console** | `openExternal(<apiUrl>/items/<type>/<id>)` |
| **Remove workspace from Explorer** (hide-only) | local — nothing deleted remotely |

Offline is honest: the tree renders the last-synced data marked *offline* plus a
reason; a signed-out deployment shows a Sign-in node; an empty workspace shows a
"create an item" node. Nothing is ever a fabricated row.

## Data explorer, query grid + estate search (Phase 3)

| Command | Backend |
|---|---|
| **Query data…** → **Run query** (▶) — SQL/KQL editor for a data item | `POST /api/items/{type}/{id}/query` (`{sql}` or `{kql, page}`) |
| **Preview data** — bounded sampled preview of a dataset / lake view | `GET /api/items/{type}/{id}/preview?top=` |
| **Find item (estate search)** — search across every signed-in deployment | `GET /api/catalog/find?q=` (merged + ranked client-side) |

Results render in one type-badged grid webview (column type badges, row count,
elapsed-time, cap badge). Reads are **bounded, capped and read-only** — the same
controls the M2 `loom-query` MCP enforces (DDL/DML & KQL-control rejected at
parse; default 500 rows, hard cap 5000 a caller can only *lower*; 512 KiB byte
cap; 65 s client time cap). An unconfigured backend renders the route's exact
remediation, never a mock grid. The webview receives only column/row/meta data —
no credential ever crosses the boundary.

## Architecture

- **Transport** wraps [`@csa-loom/sdk`](../loom-sdk) (`LoomClient` — bearer-PAT or
  cookie auth, envelope normalization, `LoomApiError`). No direct Azure calls; the
  extension holds no ARM/storage/Kusto credential.
- **Auth** mirrors the [`loom` CLI](../loom-cli) device-code + PAT flow.
- **One webview only** — the result grid (type-badged columns, timing status bar),
  built with the host theme's tokens under a strict nonce'd CSP. It receives only
  already-fetched, already-authorized data via `postMessage` — no credential
  crosses the boundary. Every rich editor stays in the Console via **Open in
  Console**; the native tree, notebook editor, quick-picks and notifications do
  the rest.

## Roadmap

- **Phase 2** ✅ — notebooks (remote Spark `NotebookController`, mirror mode, M/L/C).
- **Phase 3** ✅ (this release) — data explorer / query editor + type-badged
  results grid, bounded preview, estate-wide search. Lakehouse Tables/Files tree,
  file download, Copy-path, and Spark environments are stated as deferred.
- **Phase 4** — MCP servers + `@loom` chat participant + LM tools.
- **Phase 5** — Git/ALM, Spark job definitions, functions, Marketplace + Open VSX.

Full spec + parity matrix: `PRPs/active/loom-vscode-extension.md`.

## Develop

```bash
npm install          # scoped to this app; no root workspace
npm run typecheck    # tsc --noEmit → 0 errors
npm run build        # esbuild → dist/extension.js
npm test             # vitest unit tests
npm run package      # vsce package → loom-vscode.vsix
```

The extension resolves `@csa-loom/sdk` from the sibling source (`../loom-sdk`)
and esbuild inlines it — the documented interim until `@csa-loom/sdk` is
published to npm.

## License

MIT.
