# @csa-loom/mcp — CSA Loom MCP servers

Deployable [Model Context Protocol](https://modelcontextprotocol.io) servers for
the CSA Loom platform. Point any MCP client (Claude Code, Cursor, the Loom
Console, a custom agent) at a Loom estate and give it typed, governed tools over
your workspaces, items, and catalog.

Azure-native — **no Microsoft Fabric tenant required** (`.claude/rules/no-fabric-dependency.md`).

## Servers

Loom's MCP surface is split into five servers by **blast radius** (PRP
`loom-devtools` §4.2) so a single leaked token never grants everything. This
package ships **M1**, **M2**, and **M4** today; M3/M5 reuse the same shared core
(`src/core/`).

| # | Server | Blast radius | Status |
|---|--------|--------------|--------|
| **M1** | `loom-catalog` | Read metadata | **shipped** |
| **M2** | `loom-query` | Read data rows (bounded, capped) | **shipped** |
| M3 | `loom-author` | Create/modify items | deferred |
| **M4** | `loom-ops` | Read runs/logs, start/cancel runs | **shipped** |
| M5 | `loom-admin` | Provision infra, grant access | deferred |

### M1 · `loom-catalog` (read-only)

The read-only foundation — every downstream workflow starts with "what exists
and what shape is it". Four tools, all calling the [`@csa-loom/sdk`](../loom-sdk)
client (never raw REST), metadata only:

| Tool | SDK call | Loom endpoint | Auth floor |
|------|----------|---------------|-----------|
| `loom.catalog.find` | `catalog.search(q, opts)` | `GET /api/catalog/search` | PAT `read-only` |
| `loom.item.get` | `items.get(type, id)` | `GET /api/cosmos-items/{type}/{id}` | PAT `read-only` |
| `loom.workspaces.list` | `workspaces.list({count})` | `GET /api/workspaces` | PAT `read-only` |
| `loom.item.list` | `items.list(workspaceId)` | `GET /api/workspaces/{id}/items` | PAT `read-only` |

No tool mutates, and none returns data rows, secrets, connection strings, or ARM
ids (see Security).

### M2 · `loom-query` (read-only data, bounded)

The **data-exfiltration surface** — so it is the most locked-down server. Three
tools read *bounded* result sets from a Loom item's data plane, every one
`readOnly` with a `read-only` scope floor:

| Tool | SDK call | Loom endpoint | Auth floor |
|------|----------|---------------|-----------|
| `loom.query.sql` | `query.sql(id, sql, opts)` | `POST /api/items/{type}/{id}/query` (T-SQL) | PAT `read-only` |
| `loom.query.kql` | `query.kql(id, kql, opts)` | `POST /api/items/{type}/{id}/query` (KQL/ADX) | PAT `read-only` |
| `loom.query.preview` | `query.preview(id, opts)` | `GET /api/items/{type}/{id}/preview` | PAT `read-only` |

PRP §5.3 exfiltration controls, enforced in the tool:

- **Read-only by construction.** DDL/DML (SQL) and control commands (KQL, leading
  `.`) are rejected *at parse*, naming the statement class — they never reach the
  engine.
- **Hard caps, server-side.** Rows default to 500, hard max 5000; a serialized
  result is capped at 512 KB. A caller may *lower* a limit; it cannot raise it.
- **Every cell scrubbed.** The result rows pass through the core secret-scrub
  (§5.2) — a secret in a data cell is redacted before it leaves the process.
- **Audited.** The query text is recorded only as the core `args_hash`; the row
  count is on the audit event.

### M4 · `loom-ops` (runs/logs — read + write)

MIXED blast radius: three read tools and two **write** tools. The write tools set
`readOnly:false` + `minScope:'read-write'`, so a `read-only` token is refused by
the core scope gate — this is the shared core's write path.

| Tool | SDK call | Loom endpoint | Auth floor |
|------|----------|---------------|-----------|
| `loom.run.list` | `runs.list(id, opts)` | `GET /api/items/{type}/{id}/runs` | PAT `read-only` |
| `loom.run.get` | `runs.get(id, runId, opts)` | `GET /api/items/{type}/{id}/runs?runId=` | PAT `read-only` |
| `loom.run.logs` | `runs.logs(id, runId, opts)` | `GET /api/items/{type}/{id}/runs/{runId}/log` | PAT `read-only` |
| `loom.run.start` | `runs.start(id, opts)` | `POST /api/items/{type}/{id}/run` | PAT **`read-write`** |
| `loom.run.cancel` | `runs.cancel(id, runId, opts)` | `POST /api/items/{type}/{id}/runs/{runId}/cancel` | PAT **`read-write`** |

Per-item authorization is the BFF's job (the tool calls the same route the
browser does — it does not reimplement the ACL). Run input/output receipts are
scrubbed by the core before they leave the process.

## Authentication

The server needs a Loom credential — **there is no anonymous access**. It
resolves one at startup, first match wins:

1. **PAT** — `LOOM_TOKEN` (a `loom_pat_<id>_<secret>` scoped API token, created
   under *Settings → Developer → API tokens*) plus `LOOM_API_URL`.
2. **CLI session** — the [`loom` CLI](../loom-cli) credential store
   (`~/.loom/credentials.json`, written by `loom auth login`). If you have already
   signed in with the CLI, the MCP server reuses that session — set `LOOM_API_URL`
   to pick the estate when more than one is stored.

With no credential the server still starts and lists its tools (discovery), but
every tool call is denied with `authentication required`.

Environment:

| Var | Purpose |
|-----|---------|
| `LOOM_API_URL` | Loom base URL, e.g. `https://csa-loom.limitlessdata.ai`. |
| `LOOM_TOKEN` | A `loom_pat_…` PAT (bearer). |
| `LOOM_TOKEN_SCOPE` | Optional hint (`read-only`\|`read-write`\|`admin`); default `read-only`. |
| `LOOM_CONFIG_DIR` | Override the `~/.loom` credential-store location. |

## Register it

### Claude Code (`claude mcp add`)

```bash
# Built locally (see Build):
claude mcp add loom-catalog -- node /abs/path/apps/loom-mcp/dist/servers/loom-catalog/bin.js \
  -e LOOM_API_URL=https://csa-loom.limitlessdata.ai \
  -e LOOM_TOKEN=loom_pat_xxx_yyy
```

### `.mcp.json` (project-scoped)

See [`.mcp.json`](./.mcp.json) in this folder. Minimal form:

```json
{
  "mcpServers": {
    "loom-catalog": {
      "command": "node",
      "args": ["./apps/loom-mcp/dist/servers/loom-catalog/bin.js"],
      "env": {
        "LOOM_API_URL": "https://csa-loom.limitlessdata.ai",
        "LOOM_TOKEN": "loom_pat_xxx_yyy"
      }
    }
  }
}
```

### Docker (deployable)

```bash
# From the repo root (context must include apps/loom-sdk + apps/loom-mcp):
docker build -f apps/loom-mcp/Dockerfile -t loom-catalog-mcp .
```

```json
{
  "mcpServers": {
    "loom-catalog": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "LOOM_API_URL", "-e", "LOOM_TOKEN", "loom-catalog-mcp"]
    }
  }
}
```

## Security

Rigorous per the PRP §5 controls:

- **Token required (no anonymous).** Every tool call goes through the
  authorization gate; a null credential is denied.
- **Mutation floor per server.** A read-only server (`loom-catalog`,
  `loom-query`) only registers `readOnly` tools and the gate refuses to dispatch
  anything else. A write server (`loom-ops`) opts in (`allowMutations`), and its
  write tools additionally require a `read-write` scope — a `read-only` token is
  refused (`loom.run.start` / `loom.run.cancel`).
- **Query caps (§5.3).** `loom-query` rejects DDL/DML/control statements at parse
  and caps rows (default 500, max 5000) + bytes (512 KB) server-side — a caller
  can only lower a limit.
- **Secret-scrub (§5.2).** Every tool result passes through a fail-closed scrub
  (`src/core/scrub.ts`) that strips PATs, `loom_session` cookies, bearer headers,
  storage/SQL connection strings, SAS signatures, full ARM resource ids,
  subscription ids, and Key Vault references — by key name and by value pattern —
  before it leaves the process. Legitimate ids (workspace/item GUIDs) survive.
  Proven (and mutation-proven) by `test/scrub.test.ts`.
- **Audit (§5.7).** Every call emits `{ts, principal, server, tool, args_hash,
  decision, count?, duration_ms, outcome}` — args only as a hash — to a sink
  (stderr JSON by default; swappable for `LoomAudit_CL`).
- **Errors normalized.** Failures become `{ok:false, error, hint}` with no stack
  traces or upstream Azure bodies.
- **Transport.** https required unless the host is `localhost`/`127.0.0.1`.

## Build

This package depends on the sibling [`@csa-loom/sdk`](../loom-sdk), which is not
yet published to npm, so build the SDK first, then this package:

```bash
# 1) build the SDK (its dist/ is what this package's file: dependency resolves)
cd apps/loom-sdk && npm install && npm run build

# 2) build + test this package (isolated; safe to install in place)
cd ../loom-mcp && npm install && npm run typecheck && npm test && npm run build
```

`npm test` builds first, then runs the unit tests (scrub, tools) against the
source and the stdio smoke test against the compiled binary.

## Extending — the shared core

`src/core/` is the seam M2–M5 reuse unchanged:

- `auth.ts` / `credential-store.ts` — resolve a credential into an `AuthContext`.
- `authz.ts` — the per-tool gate (no-anonymous, per-server mutation floor via
  `allowMutations`, scope floor).
- `scrub.ts` — the secret-scrub (§5.2).
- `errors.ts` — `{ok:false,…}` normalization.
- `audit.ts` — the audit hook (§5.7).
- `tool.ts` — wraps a `ToolSpec` with the full pipeline.
- `server.ts` — `createLoomMcpServer(...)`: builds the `McpServer` from a
  `ToolSpec[]` + auth.

A new server supplies a `ToolSpec[]` and (for write/admin) a stricter auth
resolver; it inherits the scrub, audit, gate, and error handling for free.

## Deferred (not in this package)

- M3 `loom-author`, M5 `loom-admin`.
- The four purpose-built agents (`loom-item-builder`, `loom-triage`,
  `loom-rule-auditor`, `loom-parity-analyst`), PRP §4.3.
- npm publish: blocked until `@csa-loom/sdk` is published (PRP D0) and this
  package's dependency is switched from `file:../loom-sdk` to a semver range.
