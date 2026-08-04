# CSA Loom for VS Code

**CSA Loom** (not the unrelated video tool) — browse, create, rename, delete and
open your CSA Loom **workspaces and items** from inside VS Code. One extension,
one sign-in, one tree. Azure-native: **no Microsoft Fabric tenant required**, and
because Fabric is not GA in Azure Government, this is the only Fabric-class
in-editor data surface that exists there at all.

> Through **Phase 5** — the functional core (sign in, browse, create/rename/
> delete, open in Console), notebooks on remote Spark, the data explorer (query
> editor + results grid, preview, estate search), MCP servers + the `@loom` chat
> participant, and now **Git/ALM** and **Spark job definitions** plus a
> tag-driven **Open VSX / Marketplace / GitHub-Release** distribution path. Every
> shipped surface is real end-to-end; no tab shows a stub.

## Why one extension

Microsoft ships **five** VS Code artifacts for Fabric with **two** sign-in
commands that don't share a session, plus a global .NET tool and a hand-edited
`mcp.json`. CSA Loom is **one** extension, **one** `Loom: Sign in` (exposed as a
`vscode.AuthenticationProvider`, id `loom`, that any extension can reuse), and
**zero** non-VS-Code prerequisites (no Jupyter extension, no JDK).

## Install

Once the Marketplace / Open VSX listing is live, install the usual way. Until
then (and for air-gapped estates where the Marketplace is blocked), grab the
`.vsix` attached to the `loom-vscode-v*` GitHub Release and install it
in-boundary:

```bash
code --install-extension loom-vscode.vsix
```

The [`publish-loom-vscode.yml`](../../.github/workflows/publish-loom-vscode.yml)
workflow builds + type-checks + tests + packages on every PR, and on a
`loom-vscode-v*` tag it publishes to VS Marketplace (`vsce`) and Open VSX
(`ovsx`) **only when the matching token secret is present** and attaches the
`.vsix` to the GitHub Release — so a fork or PR can never publish.

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

## MCP servers + `@loom` chat (Phase 4)

**MCP servers, zero `mcp.json` editing.** The extension contributes the shipped
[`@csa-loom/mcp`](../loom-mcp) servers to VS Code's MCP registry via a
`McpServerDefinitionProvider`, wired to the **active deployment**'s `apiUrl` and
your stored PAT. By **blast radius**, only the two read-only servers are enabled
by default:

| Server | Blast radius | Default |
|---|---|---|
| `loom-catalog` | read metadata (workspaces, items, catalog) | **ON** |
| `loom-query` | read bounded, capped data rows (SQL/KQL/preview) | **ON** |
| `loom-author` | WRITE — create/modify items (dry-run default) | opt-in |
| `loom-ops` | runs/logs + start/cancel | opt-in |
| `loom-admin` | ADMIN — grant access (default-OFF, refuses a PAT) | opt-in |

The write/admin servers appear only after you enable them in **CSA Loom: Manage
MCP servers** (or the `loom.mcp.enabledServers` setting) — the extension never
auto-enables them. A server is contributed only for a deployment you've signed
into **with a PAT** (the MCP servers authenticate with `LOOM_TOKEN`); the PAT is
injected at start time, keyed to that deployment, so a token never reaches a
server pointed at another deployment. The servers ship bundled in the `.vsix`
(`dist/mcp/*.mjs`) — no external tool, no `node` on PATH required.

**`@loom` chat participant.** Type `@loom` in Copilot Chat to ask about your
estate. It answers by calling the **real backend** against the active deployment
and streaming grounded results — never a fabricated answer. Backed by Loom's own
data plane (not GitHub Copilot's model), so it works with no Copilot licence:

- `@loom <question>` / `@loom /find <query>` — catalog search.
- `@loom /item <type>/<id>` — item metadata + definition keys.
- `@loom /query <type>/<id> :: <SQL>` — bounded, read-only query grid.
- `@loom /preview <type>/<id>` — data-asset preview.

When there's no configured deployment or no live session, `@loom` shows an honest
gate naming the fix (add a deployment / sign in) — it does not answer from memory.
Pick which deployment MCP + `@loom` act against with **CSA Loom: Select active
deployment**.
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

## Git/ALM + Spark job definitions (Phase 5)

**Git / ALM** — version-control your workspace items against the connected Azure
DevOps or GitHub repo (Azure-native; no Fabric git surface). On a workspace:

| Command | Backend |
|---|---|
| **Git: status** — repo + changed items | `GET /api/git-integration/status?workspaceId=` |
| **Git: commit…** — pick changed items + message, commit | `POST /api/git-integration/commit` |
| **Git: pull** — pull repo → apply to items | `POST /api/git-integration/pull` |
| **Git: resolve conflict…** (on an item) — keep local / keep remote | `POST /api/git-integration/resolve` |

When no repo is bound (or no PAT / no Key Vault) the route answers `424 {gated}`,
which the extension turns into a **named remediation + a Fix-it** that opens the
Console workspace Git settings — never a fabricated status.

**Spark job definitions** — the real Synapse-Livy **batch** API (Azure-native
Spark; never OneLake). On a `spark-job-definition` item:

| Command | Backend |
|---|---|
| **Configure Spark job…** — guided pool + main file + language | `PUT /api/items/spark-job-definition/:id` (merged `state.spec`) |
| **Upload Spark job file…** — main / reference → ADLS, records `spec.file` | `POST /api/items/spark-job-definition/:id/files` |
| **Run Spark job** — submit a real Livy batch from the spec | `POST /api/items/spark-job-definition/:id/submit` |
| **View Spark job runs** — batch history; a running batch can be cancelled | `GET …/runs`, `POST …/runs/:batch/cancel` |

An unset pool / main file surfaces the route's honest `400` with a **Configure
Spark job** Fix-it; an unconfigured Synapse workspace surfaces its exact `503`
remediation. No fake kernel — nothing is reported as run that did not run.

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

- **Phase 1 ✅** — sign in, browse, create/rename/delete, open definition, Open in Console.
- **Phase 2 ✅** — notebooks (remote Spark `NotebookController`, mirror mode, M/L/C decorations, run history).
- **Phase 3 ✅** — data explorer / query editor + type-badged results grid, bounded preview, estate-wide search.
- **Phase 4 ✅** — MCP servers (`McpServerDefinitionProvider`) + `@loom` chat participant.
- **Phase 5 ✅ (this release)** — Git/ALM (status / commit / pull / resolve), Spark
  job definitions (configure / upload / run / runs+cancel), and the tag-driven
  Open VSX + VS Marketplace + GitHub-Release distribution workflow.

Deferred, stated honestly: the lakehouse Tables/Files tree, file download and
Copy-path (P3); user-data-function local debug and the read-only pipeline tree
(P5). See the parity doc `docs/fiab/parity/loom-vscode.md` for the row-by-row
built / honest-gate / deferred status.

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
