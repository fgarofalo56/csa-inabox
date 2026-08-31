# MCP integration — Snowflake ⇄ CSA Loom

**Parent:** [`PRP.md`](./PRP.md) · Wave 2 · Measured 2026-08-24

Two directions, and the framing needs one correction each way.

**Direction B is ~85% built already.** `apps/loom-mcp` is a mature five-server MCP package
with a shared security core (`authorize → run → scrub → audit → normalize`), 10 test files
and a CI workflow. Designing a new Loom MCP server from scratch would duplicate genuinely
good work. **The real gap is one thing: it is stdio-only and is never deployed.**

**Snowflake-in-Gov is not the constraint.** Snowflake *is* on Azure Government (SnowGov,
FedRAMP High). The actual constraint is **Cortex**, and it is sharper — see §5.

---

## 1. Ground truth — four things named "MCP" already exist

Disambiguating them is a prerequisite. Confusing them is how an agent deploys the wrong
image.

| Path | What it actually is | Deployed? |
|---|---|---|
| `apps/loom-mcp` | **Loom-native MCP servers** — 5 TypeScript servers over `@csa-loom/sdk` | **NO** |
| `apps/fiab-mcp-config` | Vendored Microsoft `Azure.Mcp.Server` (.NET), HTTP on :8080 | Yes — **as the image named `loom-mcp`** |
| `apps/fiab-mcp-bridge` | stdio→HTTP/SSE bridge for `npx`/`uvx` servers | Yes, as `loom-mcp-bridge` |
| `lib/mcp/catalog.ts` + `lib/azure/mcp-client.ts` | Loom as an MCP **client** of external HTTP servers | Yes (in-console) |

**The naming trap, verified not assumed.** The Container App named `loom-mcp` at
`admin-plane/main.bicep:6153` does **not** run `apps/loom-mcp`. From
`.github/workflows/build-fiab-images.yml:121-123`:

```yaml
- app: loom-mcp
  context: ./apps/fiab-mcp-config
  dockerfile: Dockerfile
```

`apps/loom-mcp` appears in **zero** bicep files (measured). Its `Dockerfile` has
`ENTRYPOINT ["node", "dist/servers/loom-catalog/bin.js"]` — stdio, no listener — while the
bicep app declares `ingressPort: 8080` and `healthPath: '/.well-known/health'`, which would
be an unhealthy app forever. **Not a bug; two different images sharing a confusing name.**
W0.5 renames it.

### The existing security core is the asset — build on it, not around it

`apps/loom-mcp/src/core/`:

- **`authz.ts`** — one audited decision point, fail-closed ordering, deny-by-default, tuned
  per server by `AuthzPolicy` (`allowMutations`, `requireAdmin`, `rejectPat`, `enabled`).
  It documents itself: *"there is deliberately no second, less-audited authz path."*
- **`scrub.ts`** — fail-closed redaction by key name **and** value pattern (PATs,
  `loom_session=`, `Bearer`, `AccountKey=`, SAS `sig=`, ARM ids, KV refs), mutation-proven.
- **`guards.ts`** (loom-query) — **the template for the Snowflake query tool.** Allow-list
  statement leaders, reject `SELECT … INTO`, `clampLimit` (500 default / 5000 hard max),
  `capResult` 512 KB. A caller may **lower** a limit, never raise it.
- **`audit.ts`** — args as SHA-256 hash only, never raw; writes to **stderr**, explicitly
  never stdout (stdout is the JSON-RPC channel).

**A sibling app would be exactly the "second, less-audited path" `authz.ts` forbids.** So:
**extend `apps/loom-mcp`. Do not create `apps/loom-snowflake-mcp`.**

---

## 2. Direction A — Loom as an MCP client of Snowflake

### 2.1 Research findings (fetched 2026-08-24)

**The Snowflake-managed MCP server is the path.**

- Endpoint: `https://<account_url>/api/v2/databases/{db}/schemas/{schema}/mcp-servers/{name}`
- Transport: remote HTTP. **Only non-streaming responses are supported.**
- Created as a first-class SQL object: `CREATE MCP SERVER … FROM SPECIFICATION $$ <yaml> $$`
- Tool types: `CORTEX_AGENT_RUN`, `CORTEX_SEARCH_SERVICE_QUERY`, `CORTEX_ANALYST_MESSAGE`,
  `SYSTEM_EXECUTE_SQL` (with `read_only`, `query_timeout`, `warehouse`), and `GENERIC`.
- Limits: 50 tools per server; generic + SQL responses truncated at **250 KB**.
- Auth: Snowflake OAuth (default) or External OAuth. **PATs are possible but explicitly
  discouraged** over token-leakage concerns.
- Privileges: `USAGE ON MCP SERVER` to connect/discover, `MODIFY` for `tools/list` +
  `tools/call`, plus per-tool grants.
- Network: requests originate from the **MCP client provider's** infrastructure, so
  Snowflake network policies must allow those egress IPs.

**The OSS server is dead — this is the single most important research finding.**
`Snowflake-Labs/mcp`, which most integration guides still point at, now reads verbatim:
*"This project is deprecated and no longer maintained."* Bridging it via
`fiab-mcp-bridge` would have been the obvious low-effort move and it is **the wrong one**.

**Snowflake auth is moving off passwords.** Single-factor password sign-in is being
deprecated in phases with a Strong Authentication Hub. For machine identities the
recommended methods are **key-pair** and PATs. **Never model a Snowflake connection as
username+password.** PR #4024 already added `key-pair`; keep `sql-password` available only
because the customer's account may still permit it, and prefer key-pair in the wizard.

### 2.2 The architectural consequence

Because the managed server is **remote HTTPS with OAuth**, Loom does not need to host
anything to be a Snowflake MCP client. The machinery exists: `lib/azure/mcp-client.ts`
speaks Streamable-HTTP JSON-RPC, sends `initialize` first, captures `Mcp-Session-Id`, and
parses both plain-JSON and SSE-framed bodies. `McpServerConfig` carries `endpoint` +
`authMethod: 'none' | 'header' | 'key-vault' | 'entra-obo'`.

**Snowflake registers as an external MCP server. No new transport code.**

The one genuine gap: **no Snowflake OAuth client-credentials mode.** `key-vault` resolves a
**static** Bearer today; a static Snowflake refresh token in KV works but is a long-lived
credential. Add a fifth mode, `oauth2-cc` — mint short-lived, cache to expiry — narrow and
additive, no change to the existing four. **That is W2.3.**

---

## 3. Direction B — Loom as an MCP server

### 3.1 What is already exposed

| Server | Tools | Floor |
|---|---|---|
| `loom-catalog` | `catalog.find`, `item.get`, `workspaces.list`, `item.list` | PAT read-only |
| `loom-query` | `query.sql`, `query.kql`, `query.preview` | PAT read-only + parse guards + caps |
| `loom-author` | `item.create`, `item.update`, `item.definition.update` | PAT read-write, **dry-run by default** |
| `loom-ops` | `run.{list,get,logs,start,cancel}` | read-only / read-write split |
| `loom-admin` | `admin.role.assign`, `admin.grant`, `admin.gate.resolve` | Entra admin, **no PAT ever**, default-OFF |

### 3.2 What is missing — one thing, not many

**No remote endpoint.** Every `bin.ts` uses `StdioServerTransport` (measured: 2 occurrences
in each of the five `bin.ts` files, 0 anywhere else). Grepping
`createServer|listen(|StreamableHTTP` across `src/` returns only false positives. **There is
no HTTP listener in the package and no `transport/` directory.**

Consequence: Claude, Foundry, Agent 365 and Copilot Studio **cannot reach Loom over MCP at
all** unless a developer clones the repo, builds two npm packages and runs a local binary
with a PAT in an env var. Snowflake ships a managed remote endpoint; Loom ships a local dev
tool. **That asymmetry is the whole of direction B's remaining work.**

### 3.3 What Loom should expose that it does not

Priority order: **(1) lineage/governance** — the highest-value MCP surface for an agent and
the natural counterpart to Snowflake Horizon; **(2) mirroring lifecycle** — directly serves
the operator's demo; (3) deployment & readiness — lets an agent diagnose an estate, which is
what `deploy-integrity.md` R3 asks for; (4) catalog/Iceberg namespace listing. **Defer 3 and
4;** 1 and 2 pay for themselves immediately (W7.5 in `PRP.md`).

---

## 4. Tool signatures

All under the shared core. `readOnly` and `minScope` are the core's existing `ToolSpec`
fields.

### M6 · `loom-snowflake` — Loom as client (W2.1) — read-only server

```ts
// ── Discovery — metadata only, no data rows ────────────────────────────────
loom.snowflake.databases.list({ connectionId })
  → { databases: [{ name, owner, comment, created }] }            readOnly minScope:'read-only'

loom.snowflake.schemas.list({ connectionId, database })
  → { schemas: [{ name, owner, comment }] }                       readOnly minScope:'read-only'

loom.snowflake.tables.list({ connectionId, database, schema,
                             kind?: 'table'|'view'|'iceberg'|'all' })
  → { tables: [{ name, kind, rows, bytes, isIceberg, icebergCatalog?, clusteringKey? }] }
  // kind:'iceberg' is the discovery half of the federation path (§7).
  // Reads INFORMATION_SCHEMA.TABLES.IS_ICEBERG — the same column PR #4024 added.

loom.snowflake.table.describe({ connectionId, database, schema, table })
  → { columns: [{ name, type, nullable, comment, isPrimaryKey }],
      clusteringKey?, isIceberg, icebergMetadataLocation? }

// ── Data — the exfiltration surface. Mirrors loom-query/guards.ts exactly ──
loom.snowflake.query({ connectionId, sql, limit?, warehouse?, timeoutSeconds? })
  → { columns, rows, rowCount, truncated, truncatedByCap?, cappedBy?, warehouse, elapsedMs }
  // assertReadOnlySnowflakeSql() BEFORE dispatch; capResult() AFTER.
  // limit default 500, hard max 5000; serialized cap 512 KB.

// ── Operations — read-only ─────────────────────────────────────────────────
loom.snowflake.warehouses.list({ connectionId })
  → { warehouses: [{ name, size, state, autoSuspend, autoResume, running, queued }] }

loom.snowflake.lineage.get({ connectionId, database, schema, object, direction?, depth? })
  → { nodes, edges, source: 'account_usage'|'information_schema', asOf }
  // `source` is stated because ACCOUNT_USAGE has known latency — the caller must be
  // able to tell a stale answer from a live one (deploy-integrity R7).

loom.snowflake.grants.list({ connectionId, on: 'table'|'schema'|'database', name })
  → { grants: [{ privilege, grantedTo, grantedBy, grantOption }] }

// ── Mirroring — the ONLY mutating tools, dry-run by default (loom-author pattern)
loom.snowflake.mirror.plan({ connectionId, database, schema, tables,
                             includeIceberg?, syncMode })
  → { plan: { tables, estimatedBytes, adfPipeline, sink, cadence }, warnings: string[] }
  // `warnings` states what a mode will ACTUALLY do — see §7.2.

loom.snowflake.mirror.apply({ mirrorId, apply?: boolean })   // apply defaults FALSE
  → { mirrorId, status, applied, tables }        readOnly:false minScope:'read-write'
```

### The Snowflake-specific read-only guard

`loom-query/guards.ts` is T-SQL-shaped and **must not be reused verbatim** — Snowflake's
DDL/DML vocabulary differs.

```ts
const SF_READ_LEADERS = new Set(['select','with','show','describe','desc','explain','list','values']);

// Refusals beyond the leader check — each named so the refusal message is honest:
//   CALL              a stored procedure can write; it leads with none of the above
//   COPY INTO <table> ingest.  COPY INTO <stage> is EGRESS.  Refuse BOTH.
//   PUT | GET         local-filesystem stage transfer.  Refuse.
//   CREATE|DROP|ALTER|MERGE|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|USE
//   SELECT … INTO     same materialization hazard as T-SQL.
```

**Three independent layers, so defeating one does not open the path** (a single guard the
author also controls is not a guard):

1. the parse guard above, **before dispatch**;
2. `read_only: true` in the Snowflake-side `SYSTEM_EXECUTE_SQL` config;
3. the Loom role granted only `SELECT`.

### M7 · `loom-lineage` and M8 · `loom-mirror` — Loom as server (W7.5)

```ts
loom.lineage.get({ itemId, direction?, depth? })      readOnly minScope:'read-only'
loom.lineage.impact({ itemId })                       readOnly minScope:'read-only'
loom.governance.labels.get({ itemId })                readOnly minScope:'read-only'
loom.governance.policies.list({ workspaceId? })       readOnly minScope:'read-only'

loom.mirror.list({ workspaceId })                     readOnly minScope:'read-only'
loom.mirror.status({ mirrorId })
  → { status, tables: [{ schema, table, mode, rows, lastSync, note, error }],
      backend, engine, gate? }
loom.mirror.start({ mirrorId, apply? })               readOnly:false minScope:'read-write'
loom.mirror.stop({ mirrorId, apply? })                readOnly:false minScope:'read-write'
```

---

## 5. Deployment, transport and the tenant boundary

### 5.1 Where it deploys — follow `fiab-mcp-bridge` exactly

| Concern | Value | Precedent |
|---|---|---|
| Image | `loom-mcp-remote:${appImageTags.mcpRemote}` | `admin-plane/main.bicep:591` |
| App entry | `loom-mcp-remote` in the `apps:` array | `main.bicep:6179-6193` |
| Ingress | `ingressPort: 8080`, **`external: false`** | bridge is internal-only |
| Health | `/.well-known/health` | bridge |
| Identity | `uamiMcpRemote*` from `identity.bicep` | bridge's `uamiMcpBridge*` |
| Build | `{"name":"loom-mcp-remote","ctx":"./apps/loom-mcp"}` | `build-fiab-images-acr-tasks.yml:260` |
| Replicas | `minReplicas: 1, maxReplicas: 3`, `tier: 'mcp'` | bridge |

**Not an Azure Function.** MCP Streamable HTTP wants long-lived sessions and SSE — a poor
fit for the Functions execution model. Container Apps is the pattern this repo already uses
for every long-lived MCP surface.

**`external: false` is deliberate and load-bearing.** External-agent exposure goes through
the Console's existing authenticated BFF. A public MCP ingress would be a **new front door
bypassing `middleware.ts`**.

### 5.2 Transport — both, for different callers

- **stdio** stays exactly as-is for local dev (`claude mcp add`, `.mcp.json`, Cursor). Zero
  changes; it works.
- **Streamable HTTP** is the new deployed surface, mounted per server:
  `POST /servers/loom-catalog`, `/servers/loom-query`, `/servers/loom-snowflake`, …

Use `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` (already a dependency
at `^1.12.0`). The bridge hand-rolls SSE because it predates that; **new code must not
repeat it.**

### 5.3 The security crux — per-request auth

In stdio, `resolveAuth()` runs **once at process start**: one process, one credential,
correct by construction. In HTTP, **one process serves many callers.** Resolving auth once
at boot would make every request run as the boot credential — a cross-tenant hole of exactly
the shape `tenant-boundary.ts` exists to eliminate.

**The rule to encode, and to mutation-test:**

> `createLoomMcpServer` must **never** be called once and reused across requests in HTTP
> mode. One server instance per request, or per-request auth injection. A shared instance
> carries a shared credential.

The core already supports this — `ToolHandlerOptions.auth` is a parameter, not a module
global.

### 5.4 The MCP surface must not make an authorization decision at all

The existing servers get this right; state it as an invariant rather than rediscover it.
From `authz.ts`: the gate *"does NOT re-implement per-item ACLs or the live tenant-admin
re-check… the tool calls the Loom BFF via the SDK, and the BFF performs the same
workspace/item ACL + `isTenantAdmin`/`enforceCapability`/PDP check it does for the browser."*

The MCP layer must **never**:

- call `classifyTenantMatch` / `sameTenantConfirmed` itself;
- read a `tid` from a token and compare it to anything;
- **accept a `tenantId` or `workspaceId` as a tool argument used for scoping.**

That last one deserves emphasis: **when the caller picks the scope, even a count leaks.** A
`snowflake.query` tool taking a raw `connectionId` from an agent is that shape — the agent
chooses which stored connection to open. **Mitigation: the BFF resolves `connectionId`
under the caller's session before the driver is touched**, exactly as
`resolveSqlAuthDescribed` already does for mirroring. The MCP tool **passes the id
through; it never resolves it.**

And the default is `unconfirmed`, and **`unconfirmed` is not a grant.** A caller whose
tenancy Loom cannot positively establish gets a refusal, not a fall-through.

### 5.5 Credentials — follow the existing pattern, do not extend it

- **Storage.** `connections-store.ts` persists only a KV secret **name** (`secretRef`); the
  value goes to KV via `putKeyVaultSecret` into the `loom-conn-` namespace. Never Cosmos,
  never item state, never a response body.
- **Read.** `getKeyVaultSecretValue(name, purpose)` — and `purpose` is **mandatory**.
  `kv-secret-purpose.ts` exists because an unpurposed read made every platform secret
  reachable from a tenant-user request; the MSAL client-secret leak on 2026-07-19 caused a
  full sign-in outage. Snowflake connection reads use `'connection-secret'`, which owns the
  `loom-conn-` namespace and can read nothing outside it. Registering a Snowflake **MCP
  server** uses the existing `'mcp-server-credential'` purpose — no new purpose needed.
- **Sovereign-awareness is free** and must not be bypassed: `kvScope()` / `kvUrlFromName()`
  resolve `vault.azure.net` vs `vault.usgovcloudapi.net`. Hard-coding the Commercial host
  silently fails KV auth in Gov.
- **Connection type.** `snowflake` + `key-pair` **already landed in PR #4024** — consume
  them, do not re-add them. Snowflake will **not** appear in `CONNECTABLE_ARM_TYPES` (that
  list is Azure Resource Graph discovery; Snowflake is not an ARM resource).
- **Non-negotiable.** The private key / client secret is never logged, never echoed to an
  MCP response, never in a tool result, never in an error message, never in an audit event.
  `scrub.ts` already redacts `privatekey`, `clientsecret`, `password`, `token` by key name
  and `Bearer …` by value, so the fail-closed backstop is inherited free.
  `describeConnectionAuth()` is the pattern for reporting **which** identity a run used
  without touching the secret.

---

## 6. Cloud parity — and the real Gov constraint

**Snowflake IS in Azure Government.** Snowflake was approved within the FedRAMP High
authorization for Azure Government (2025), and the FedRAMP Marketplace lists "The Data Cloud
on Azure Government (High)". **Do not build a story on "they aren't in Gov".**

**One wrinkle, stated as uncertainty because that is what it is.** Snowflake's supported
regions page shows **two** rows both keyed `usgovvirginia`: *US Gov Virginia (FedRAMP High
Plus)* — current — and *US Gov Virginia* carrying *"This deployment has reached end of life,
and will be decommissioned at the beginning of 2027."* My reading is that the EOL attaches
to the **older** deployment. That was read from a rendered doc page, not a structured API,
and **I did not confirm which deployment any given account sits on. UNVERIFIED** — see
`PRP.md` §12-2.

Documented SnowGov constraints, verbatim from that page:

- *"Certain features that are available in Snowflake's commercial regions might not be
  available or might be different in its SnowGov Regions."*
- *"Self-provisioning of initial Snowflake accounts is not available in the SnowGov
  Regions."*
- *"the government regions of the cloud providers do not allow event notifications to be
  sent to or from other commercial regions."*
- Government-compliance accounts require **Business Critical Edition or higher**.

**The real Gov constraint is Cortex, not Snowflake.** Snowflake documents feature-level Gov
exclusions explicitly, and Cortex AI's FedRAMP Moderate authorization is scoped to **AWS US
East (N. Virginia)**, not Azure Gov. Cross-region inference is the escape hatch, but routing
Gov data to a commercial region is very often exactly what the boundary forbids.

**So the design must not assume the Snowflake-managed MCP server is reachable in Gov** — its
headline tools (`CORTEX_AGENT_RUN`, `CORTEX_ANALYST_MESSAGE`,
`CORTEX_SEARCH_SERVICE_QUERY`) are Cortex-dependent.

> **A contradiction inside this repo, flagged not resolved.**
> `docs/migrations/snowflake/federal-migration-guide.md:26` states *"Snowflake Government
> holds FedRAMP Moderate authorization as of April 2026"* and `:39` marks FedRAMP High
> **"Not authorized."** That contradicts the 2025 High announcement. One is wrong or
> differently scoped (plausibly Moderate-for-Cortex vs High-for-platform). **A stale
> compliance claim in a migration guide gets quoted into an ATO package** — W0.2 owns
> establishing which is true and correcting it.

### Per-boundary behaviour

| Boundary | Snowflake MCP client | Loom MCP server |
|---|---|---|
| Commercial | Full — managed MCP + Cortex tools | Container App, internal ingress |
| GCC | Full (Commercial Snowflake) | Container App |
| GCC-High / IL5 / DoD | **Degraded, honestly** — see below | AKS workload (ACA thin at IL4+) |

Where Cortex tools are absent, Loom does **not** show a dead card. Per
`no-fabric-dependency.md`'s own logic — supply the Azure-native equivalent — and
`auto-bind-by-default.md`:

1. **Direct connectivity, no MCP.** `SYSTEM_EXECUTE_SQL`-equivalent behaviour via a direct
   Snowflake SQL connection (key-pair auth), giving `query` / `describe` / `list` with **no
   Cortex dependency**. This is the primary Gov path and it is what W2.1 builds.
2. **Iceberg REST Catalog federation** (§7) — engine-level, not Cortex-dependent.
3. **Cortex-analogs served by Loom's own Azure-native AI.** Loom already has
   `aoai-chat-client`, `aisearch-client`, `ai-functions-client`. A `snowflake.nl2sql` tool
   backed by Azure OpenAI **in the Gov boundary** is a genuine 1:1 for
   `CORTEX_ANALYST_MESSAGE` and keeps inference **inside** the boundary rather than
   cross-region-routing it out. **This is the strongest differentiator in the document** —
   `PRP.md` §12-8 asks the operator to approve building it.

`AZURE_CLOUD` already drives per-boundary catalog filtering in the bridge; **reuse that
mechanism** rather than inventing a second one.

---

## 7. Relation to the operator's mirroring lane

**It accelerates it and does not duplicate it.** Mirroring moves bytes; MCP drives control
and discovery.

### 7.1 What Snowflake mirroring does today

From `lib/azure/mirror-engine.ts`: `MIRROR_ADF_COPY_FAMILY = new Set(['Snowflake'])`
(line 77). Snowflake is **not** in the SQL/PG/Cosmos families, so `engineCanSnapshot` is
false — the built-in TDS snapshot engine cannot read it. `runMirrorAdfCopy` builds an ADF
`SnowflakeTable` source + Parquet sink per table with a **delete-then-copy** pair into ADLS
Bronze, gated on `LOOM_ADF_NAME` + `LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE` +
`LOOM_MIRROR_ADLS_LINKED_SERVICE`, with an honest `Gated` result naming all three when
absent.

### 7.2 Sync modes — the demo will hit this

At `mirror-engine.ts:953-954`, `const ongoing = src.syncMode !== 'snapshot'`. For Snowflake,
**`incremental` and `continuous` take the same branch** — both add a schedule trigger at
`LOOM_MIRROR_COPY_CADENCE` (default `1h`) to the **same delete-then-copy full refresh.**

So a demo that picks "incremental" for Snowflake gets **hourly full reloads**, not a delta.
Acceptable for a demo; **not acceptable to discover mid-demo.** `mirror.plan`'s `warnings[]`
is where that gets said out loud.

> Traced from the mode branch, **not** by executing a run. Verify against a live run before
> quoting it as final.

The genuine incremental path **exists and is unwired**:
`apps/fiab-mirroring-engine/sources/snowflake_poller.py` implements Snowflake **Streams +
Tasks** CDC flushing Parquet with `__rowMarker__` from `METADATA$ACTION`, landing in the
open-mirroring zone. It generates SQL the operator runs by hand and **is not connected to
`mirror-engine.ts` at all.** That is the shortest real path to a credible incremental demo —
and an MCP tool is exactly the right way to run its DDL, because the whole point is
executing SQL in the customer's Snowflake account under an audited, scoped credential.

### 7.3 Iceberg — where MCP and mirroring genuinely converge

Snowflake now exposes **Horizon Iceberg REST Catalog (IRC)** — externally-managed Iceberg
table access, `CREATE CATALOG INTEGRATION … REST` (OAuth / Bearer / SigV4), preview release
note dated 2026-08-18. Trino and Spark both consume IRC natively.

Loom already has the counterpart: `lib/azure/iceberg-catalog-client.ts`,
`app/api/catalog/iceberg/connect/route.ts` (**which already emits copy-paste connect
snippets for Snowflake**), `apps/loom-trino`, `apps/loom-unity`, and
`iceberg-catalog-aca.bicep`.

**For Snowflake Iceberg tables there is a strictly better option than copying them:
federate.** Point Loom's Trino/DuckDB at Snowflake's IRC endpoint and read in place — no ADF
Copy, no duplication, no staleness window, no egress. **And it is the Gov-viable path**,
because it is engine-level and not Cortex-dependent, in a boundary where Unity Catalog does
not exist.

| Snowflake object | Recommended path | Why |
|---|---|---|
| Standard tables | ADF Copy → ADLS Bronze Delta (**exists**, PR #4024) | Works today |
| **Iceberg tables** | **Federate via Horizon IRC** (W7.4) | Read in place; no copy; **Gov-viable** |

### 7.4 Correction to the research: the Iceberg defect is already fixed

The research pass reported `includeIcebergTables` as a live vaporware defect — declared at
`mirror-engine.ts:109` and never read. **That was correct for `main` and is already stale.**
PR #4024 reads `INFORMATION_SCHEMA.TABLES.IS_ICEBERG`, filters on the flag, distinguishes
"this Snowflake edition does not expose `IS_ICEBERG`" from "no Iceberg tables", and carries
three tests. **Do not re-file it.** What remains is W0.4: re-grade
`docs/fiab/parity/mirrored-database.md` row 20 on **deployed** evidence, not on the merge
(`deploy-integrity.md` R2).

Also open and relevant: **issue #4025** — `runMirrorAdfCopy` returns `ok:true,
status:'Running'` immediately after `runPipeline()` **without polling to a terminal state**,
so four distinct failure modes (factory MI lacking Key Vault Secrets User, the Snowflake role
lacking `CREATE STAGE`, a suspended warehouse, an unreachable source) all surface in Loom as
**success** with `rows: 0`. `loom.snowflake.mirror.apply` must **not** inherit that shape:
it reports what it observed, and `unknown` is never reported as success.

---

## 8. Error handling — the R7 contract

`deploy-integrity.md` R7 and the incident behind it (a `2>/dev/null` turned *"I could not
reach the registry"* into *"the tag does not exist"*, sending two investigations down the
wrong path) set the bar. `core/errors.ts` already normalizes to
`{ok:false, error, code?, hint?}` with no stack traces and a scrubbed message. What must be
added is **classification**, so an error names what was actually observed:

| Code | Means | Must NOT say |
|---|---|---|
| `snowflake_unreachable` | Network/DNS/timeout before any response | "the table does not exist" |
| `snowflake_auth_failed` | 401 / 390xxx — credential rejected | "no permission" (that is authz, not authn) |
| `snowflake_insufficient_privilege` | Snowflake returned a privilege error | "the object does not exist" |
| `snowflake_object_not_found` | Snowflake **positively** said it does not exist | anything, unless Snowflake said so |
| `snowflake_warehouse_suspended` | Warehouse not running, auto-resume off | "query failed" |
| `snowflake_query_not_read_only` | Rejected **at parse**, never dispatched | that it ran |
| `snowflake_result_capped` | Loom truncated (rows or bytes) | that the result is complete |
| `snowflake_cortex_unavailable` | Cortex tool absent in this region | "Snowflake is unavailable" |
| `snowflake_unknown` | Loom could not classify | **must say so explicitly** |

Two rules that encode the incident:

1. **Never collapse UNKNOWN into a negative.** If `SHOW TABLES` returns empty *because the
   role lacks `USAGE` on the schema*, the tool must **not** report "no tables" — it reports
   that it could not establish the table list and **names the missing grant**.
2. **No `2>/dev/null`, no `|| true`, no `catch {}` that discards a cause** anywhere on this
   path. A swallowed stderr is how a permission denial became a false factual claim.

The **250 KB** Snowflake-side truncation and Loom's own **512 KB** cap can both fire. When
either does, `truncated: true` plus `cappedBy` must be set — a silently truncated result an
agent then reasons over as complete is a **correctness** bug, not a display bug.

---

## 9. Verification bar

Per `no-vaporware.md` and `ux-baseline.md` G1, none of this is done on `tsc` + `vitest`:

- A real query against a real Snowflake account, response body in the PR.
- A **refused** write statement, shown rejected **at parse** and never dispatched.
- A capped result showing `truncated: true` + `cappedBy`.
- A KV round-trip proving the credential never appears in a response, log line or audit
  event — verified by **presence** (`grep -c`), never by value.
- A **cross-tenant refusal**: caller in tenant A, connection in tenant B → refused; and
  refused **again** when the `tid` is absent, because `unconfirmed` is not a grant.
- A **shared-instance mutation**: hoist the server instance to module scope in HTTP mode and
  prove a cross-caller test goes RED (§5.3).
- **Per-boundary receipts.** Commercial green proves nothing about Gov; Gov evidence comes
  from a GitHub Actions run in-boundary, never local `az`.
- If W7.4 lands: an Iceberg table read **in place** through IRC, row count matching
  Snowflake's own.

---

## 10. Files that matter

**Design inputs (read, do not edit unless the work item owns them):**

- `apps/loom-mcp/src/core/{authz,scrub,auth,tool,server,errors,audit,types}.ts` — the core
- `apps/loom-mcp/src/servers/loom-query/guards.ts` — the guard template
- `apps/fiab-console/lib/auth/tenant-boundary.ts` — the boundary MCP must not re-implement
- `apps/fiab-console/lib/azure/{kv-secrets-client,kv-secret-purpose,connection-auth,connections-store,mcp-client}.ts`
- `apps/fiab-mcp-bridge/README.md` — the deployment precedent
- `platform/fiab/bicep/modules/admin-plane/main.bicep` (~6153–6193) — the app-array pattern

**Stale or contradictory (Wave 0):**

- `apps/loom-mcp/README.md` — two contradictory status tables (W0.3)
- `docs/migrations/snowflake/federal-migration-guide.md:26,39` — FedRAMP claim (W0.2)
- `docs/fiab/parity/mirrored-database.md:84` — re-grade on deployed evidence (W0.4)

**Unwired asset:**

- `apps/fiab-mirroring-engine/sources/snowflake_poller.py` — real Streams+Tasks CDC, not
  connected to `mirror-engine.ts`

---

## 11. Sources

Snowflake-managed MCP server · Cortex Agents · Native Apps agents+MCP GA (2026-08-07) ·
`Snowflake-Labs/mcp` (deprecated) · supported cloud regions · FedRAMP High on Azure
Government · FedRAMP Marketplace · Cortex AI FedRAMP Moderate · cross-region inference ·
CoCo cloud-sandbox gov exclusion · password deprecation / MFA rollout · key-pair auth ·
programmatic access tokens · Horizon IRC · `CREATE CATALOG INTEGRATION … REST` · Horizon IRC
release note (2026-08-18) · Trino Iceberg connector · Azure Databricks feature region
support (verified 2026-08-24: `usgovaz`/`usgovva` do not support Databricks SQL or Unity
Catalog).
