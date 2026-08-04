# @csa-loom/mcp — CSA Loom MCP servers

Deployable [Model Context Protocol](https://modelcontextprotocol.io) servers for
the CSA Loom platform. Point any MCP client (Claude Code, Cursor, the Loom
Console, a custom agent) at a Loom estate and give it typed, governed tools over
your workspaces, items, and catalog.

Azure-native — **no Microsoft Fabric tenant required** (`.claude/rules/no-fabric-dependency.md`).

## Servers

Loom's MCP surface is split into five servers by **blast radius** (PRP
`loom-devtools` §4.2) so a single leaked token never grants everything. This
package ships **M1**, **M3**, and **M5** today; M2/M4 reuse the same shared core
(`src/core/`).

| # | Server | Blast radius | Status |
|---|--------|--------------|--------|
| **M1** | `loom-catalog` | Read metadata | **shipped** |
| M2 | `loom-query` | Read data rows | deferred |
| **M3** | `loom-author` | Create/modify items (dry-run default) | **shipped** |
| M4 | `loom-ops` | Read runs/logs, trigger reruns | deferred |
| **M5** | `loom-admin` | Provision/grant access (default-OFF) | **shipped** |

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

### M3 · `loom-author` (write — dry-run by default)

The write surface — create and modify items. Every tool is a mutation
(`readOnly:false`, `minScope:'read-write'`) and is **dry-run by default**: an
`apply` argument (default `false`) returns the PLANNED change WITHOUT calling the
mutating endpoint; only `apply:true` writes. Never deletes, never provisions.

| Tool | SDK call | Loom endpoint | Auth floor |
|------|----------|---------------|-----------|
| `loom.item.create` | `items.createByType(type, input)` | `POST /api/cosmos-items/{type}` | PAT `read-write` |
| `loom.item.update` | `items.update(type, id, patch)` | `PATCH /api/cosmos-items/{type}/{id}` | PAT `read-write` |
| `loom.item.definition.update` | `items.update(type, id, {state})` | `PATCH /api/cosmos-items/{type}/{id}` | PAT `read-write` |

A `read-only` token is refused (`insufficient_scope`). An item's definition is
its structured `state`, so `definition.update` is uniform across all item types —
Azure-native, no Fabric/Power BI workspace required.

### M5 · `loom-admin` (admin / escalation — default-OFF)

The highest-blast-radius server: it grants access and resolves deployment gates.
Its controls are layered and deny-by-default (PRP §5.4):

- **default-OFF** — `LOOM_MCP_ADMIN_ENABLED=1` required, else every call is
  denied (`admin_disabled`);
- **no PAT** — an API token never reaches an admin tool (`forbidden_principal`);
- **admin scope** — the caller must be `admin` (a cookie session must explicitly
  assert `LOOM_TOKEN_SCOPE=admin`);
- **dry-run by default** — `apply` (default false) returns the plan; `apply:true`
  mutates;
- **mandatory audit with the target principal**.

| Tool | SDK call | Loom endpoint (server-guarded) | Auth floor |
|------|----------|--------------------------------|-----------|
| `loom.admin.role.assign` | `admin.assignWorkspaceRole(wsId, input)` | `POST /api/workspaces/{id}/role-assignments` | Entra `admin`, no PAT |
| `loom.admin.grant` | `admin.grantCapability(input)` | `POST /api/admin/permissions/grants` | Entra `admin`, no PAT |
| `loom.admin.gate.resolve` | `admin.resolveGate(gateId, values)` | `POST /api/admin/gates/{id}/resolve` | Entra `admin`, no PAT |

Each route performs its OWN authoritative server-side admin check
(`isTenantAdmin` / `enforceCapability` / PDP) and caps the action to the caller's
own rights — the MCP layer adds a stricter LOCAL floor, it does not re-implement
that check. `gate.resolve` is allow-listed server-side to the gate's own
registered settings (no arbitrary env/secret writes).

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
| `LOOM_TOKEN_SCOPE` | Optional hint (`read-only`\|`read-write`\|`admin`); default `read-only`. M3 needs `read-write`; M5 needs `admin`. |
| `LOOM_MCP_ADMIN_ENABLED` | M5 only — `1`/`true` to enable the admin server (default-OFF). |
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
- **Read-only by construction.** M1 only registers `readOnly` tools and the gate
  refuses to dispatch anything else — no mutating endpoint is reachable.
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
- `authz.ts` — the per-tool gate (no-anonymous, read-only, scope floor).
- `scrub.ts` — the secret-scrub (§5.2).
- `errors.ts` — `{ok:false,…}` normalization.
- `audit.ts` — the audit hook (§5.7).
- `tool.ts` — wraps a `ToolSpec` with the full pipeline.
- `server.ts` — `createLoomMcpServer(...)`: builds the `McpServer` from a
  `ToolSpec[]` + auth.

A new server supplies a `ToolSpec[]` and (for write/admin) a stricter auth
policy; it inherits the scrub, audit, gate, and error handling for free. The
gate is one shared, audited decision point — `AuthzPolicy` tunes it per server
(`allowMutations` for M3; `requireAdmin` + `rejectPat` + `enabled` for M5) with
the M1 read-only behavior as the default.

## Deferred (not in this package)

- M2 `loom-query`, M4 `loom-ops`.
- The four purpose-built agents (`loom-item-builder`, `loom-triage`,
  `loom-rule-auditor`, `loom-parity-analyst`), PRP §4.3.
- npm publish: blocked until `@csa-loom/sdk` is published (PRP D0) and this
  package's dependency is switched from `file:../loom-sdk` to a semver range.
