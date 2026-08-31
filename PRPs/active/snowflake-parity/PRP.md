# SNOWFLAKE PARITY + SNOWFLAKE MCP — migrate customers OFF Snowflake onto Azure-native Loom, in every boundary

**Status:** DRAFT — execution-ready for **W0, W1, W2** immediately; **W3–W8** execution-ready
per-domain (each has a matrix); **W9 and the three unmapped domains gated on §1**.
Created 2026-08-24, rewritten **2026-08-25** against the nine delivered domain matrices.
Author: Claude Code, operator-directed.

**Supersedes** the 2026-08-24 draft of this file, which was written over a **truncated**
research blob — it saw roughly one domain of twelve and said so in its own §11. That §11
coverage table is now wrong in *both* directions (nine domains landed, three did not) and is
replaced by §1 here. The two first-pass matrices (`MATRIX-compute-warehouses.md`,
`MATRIX-storage-optimization.md`) are **SUPERSEDED** — see §15.

**Mandate.** Build one-for-one Snowflake capability parity in CSA Loom on Azure-native and
OSS backends, in Commercial **and** every sovereign boundary, and integrate Snowflake over
MCP — primarily **outbound**, to read a customer's existing account and get their data and
definitions out.

**Run it with:** `/prp:prp-execute PRPs/active/snowflake-parity/PRP.md`

**Measurement provenance.** Every repo claim below was grepped or read at authoring time
against the working tree at **`9a888b58d6`**, which is the same tree the nine matrices were
measured against. That tree is **9 commits behind `origin/main` (`4d4fd0b92c`)** — the local
checkout is on `fix/3971-measure-allowlist-bypass`, not `main`. Where a claim depends on
something that landed in those 9 commits it is re-checked against `origin/main` and said so.
Every Snowflake and Microsoft claim is from documentation fetched in the research or critique
pass, not recall. Where a fact could not be established it is marked **UNVERIFIED** rather
than asserted — `deploy-integrity.md` R7 applies to plans, not only to error strings.

---

## 1. Coverage — read this before planning anything

**Twelve domains were scoped. Nine returned a matrix. Three returned nothing, and the
silence must not read as coverage.**

| # | Domain | Matrix | Rows | Status |
|---|---|---|---:|---|
| 1 | Compute & warehouses | [`MATRIX-compute.md`](./MATRIX-compute.md) | 48 | ✅ delivered |
| 2 | Storage & table types | [`MATRIX-storage.md`](./MATRIX-storage.md) | 41 | ✅ delivered |
| 3 | Governance & data quality | [`MATRIX-governance.md`](./MATRIX-governance.md) | 36 | ✅ delivered |
| 4 | Security & identity | [`MATRIX-security.md`](./MATRIX-security.md) | 41 | ✅ delivered |
| 5 | Operations, cost & observability | [`MATRIX-ops.md`](./MATRIX-ops.md) | 37 | ✅ delivered |
| 6 | Programmability (Snowpark, UDFs, SPCS, Native Apps) | [`MATRIX-programmability.md`](./MATRIX-programmability.md) | 51 | ✅ delivered |
| 7 | AI, ML & Cortex | [`MATRIX-ai.md`](./MATRIX-ai.md) | 41 | ✅ delivered |
| 8 | MCP & agentic surface | [`MATRIX-mcpagentic.md`](./MATRIX-mcpagentic.md) | 30 | ✅ delivered |
| 9 | Snowsight UI surfaces | [`MATRIX-ui.md`](./MATRIX-ui.md) | 40 | ✅ delivered |
| 10 | **Ingestion & pipelines** | — | **0** | ❌ **NO MATRIX** |
| 11 | **Sharing, collaboration & marketplace** | — | **0** | ❌ **NO MATRIX** |
| 12 | **SQL dialect, APIs & ecosystem** | — | **0** | ❌ **NO MATRIX** |
| | **Mapped total** | | **365** | |

**Partial coverage exists at the seams and is worth crediting, but it is not a domain.**
`MATRIX-ui.md` rows 25–28 cover Copy History, Snowpipe, Openflow and task graphs from the
*Snowsight page* angle; `MATRIX-ops.md` row 26 covers Copy History from the observability
angle. Four Snowsight pages is not an ingestion domain, and §6.2 lists exactly what those
four pages do not reach.

**What this means for sequencing.** W0, W1 and W2 are safe to start now — they rest on the
compute, storage, programmability and MCP matrices, all delivered. W3–W8 are per-domain and
each has its matrix. **W9 and the three ingestion/sharing/dialect work items must not be
committed until `WR` closes**, because the largest single capability gap found anywhere in
this review — Snowflake **Streams** — has no owner precisely because it falls between the
ingestion domain (absent) and the storage domain (present but scoped to table types).

---

## 2. The parity matrix — the consolidated view

**The matrix is the deliverable.** It lives in nine files because it is far too long to read
inline, and it is the artifact reviewers grade work against. This table is the index; the
detail, the evidence, the per-boundary verdicts and the semantic deltas are in the linked
files and are **not** restated here.

### 2.1 Where the 365 mapped rows land

| Verdict | Rows | Share | Meaning |
|---|---:|---:|---|
| **Built** | **11** | 3.0% | Real backend today, works end-to-end. Audit only. |
| **Partial** | **206** | 56.4% | A real, often well-engineered mechanism exists; the Snowflake-visible capability, the per-object dimension, the Gov path or the surface does not. |
| **Missing** | **132** | 36.2% | No code. Each row cites the search that found nothing. |
| **Cannot match one-for-one** | **16** | 4.4% | No Azure/OSS equivalent. §6 names each one, its closest honest equivalent, and the exact semantic difference. |

### 2.2 Per domain

| Domain | Rows | Built | Partial | Missing | Cannot match |
|---|---:|---:|---:|---:|---:|
| Compute & warehouses | 48 | 0 | 29 | 17 | 2 |
| Storage & table types | 41 | 0 | 25 | 12 | 4 |
| Governance & data quality | 36 | 7 | 13 | 15 | 1 |
| Security & identity | 41 | 0 | 17 | 23 | 1 |
| Operations, cost & observability | 37 | 0 | 21 | 14 | 2 |
| Programmability | 51 | 0 | 31 | 16 | 4 |
| AI, ML & Cortex | 41 | 4 | 16 | 19 | 2 |
| MCP & agentic | 30 | 0 | 23 | 7 | 0 |
| Snowsight UI | 40 | 0 | 31 | 9 | 0 |
| **Total** | **365** | **11** | **206** | **132** | **16** |

### 2.3 Three readings of that table that matter more than the numbers

**① `Built = 0` in six of nine domains is the honest read, and it is not as bad as it looks.**
Compute, storage, security, programmability, MCP and UI all score zero. But 206 rows are
*Partial*, not *Missing* — the dominant failure mode across this whole program is **a built
mechanism with no user-visible surface**, not an absent mechanism. Programmability's roll-up
states it most sharply: ACA workload profiles validated in code and declared in **zero**
params files; ACA Jobs run 17 times by the platform and absent from `JOB_KINDS`; volumes
mounted by the platform for itself and unreachable by user apps. That is a different, cheaper
class of work than greenfield, and the wave plan is built around it.

**② Six of nine matrices had to correct their own research input.** Compute corrected 4
claims, governance 6, security 6, ui 6, ops 7, ai 5, programmability 3, storage 5. Several of
those corrections were the research asserting something is *missing* when it is built (the
Synapse `GRANT` writer, result-set caching, `includeIcebergTables`, PII redaction, the gate
registry, `/admin/mcp-servers`). **The default assumption "if it isn't in the matrix it isn't
built" is wrong in this repo** and has already produced false "missing" verdicts twice in one
day. Re-measure before you build.

**③ `Partial` frequently means "Commercial only".** The single most repeated correction
across all nine matrices is the same one: **Azure Government supports neither Databricks SQL
nor Databricks Unity Catalog.** `MATRIX-ui.md` alone re-graded 7 rows off Databricks and 5
more off Unity Catalog. Under `cloud-parity.md` a Commercial-only row is **incomplete**, not
"Commercial-first" — so a meaningful fraction of the 206 Partial rows are Partial *because of
a boundary*, not because of a feature.

---

## 3. Binding operator decisions (2026-08-24) — settled, do not re-litigate

These three are the operator's, they are final, and every matrix was rewritten under them.
Where a research lane recommended otherwise, this document follows the decision and records
the divergence.

**① POSTURE: MIGRATION-FIRST.** Loom is the destination; customers move **off** Snowflake
onto it. The MCP connector exists mainly to read a customer's existing account and get their
data and definitions out. Interop is the means, not the end state.
*A research lane recommended coexistence. That recommendation is **OVERRULED**.*
**What it changes concretely:** the outbound reader (W1) outranks every interop-deepening
item; `MATRIX-mcpagentic.md` demotes M11/M12/M13 (Glean, Google Workspace, custom connectors)
below M2/M25/M26/M6 (make Loom's own surface real and governable);
`MATRIX-programmability.md` puts row 4 (code inventory) and row 3 (checkpoints) first;
`MATRIX-security.md` puts the `SHOW ROLES` / `SHOW GRANTS` importer ahead of any bidirectional
sync; `MATRIX-ui.md` rewrites the account selector, linked catalogs and Partner Connect as
*get-them-off-Snowflake* surfaces rather than coexistence surfaces.

**② SQL DIALECT: TRANSPILER NOW, WIRE-COMPATIBLE LATER.** Ship an offline converter first
(Snowflake SQL, dbt projects, DDL, stored procedures → Loom's engines). A
Snowflake-wire-compatible endpoint — existing drivers and BI tools connecting to Loom
unchanged — is a **later wave**, after the parity substrate exists. Full wire compatibility
from the start was rejected on cost; Loom-native-only was rejected because it imposes a
rewrite cost a competitor may not.
**Good news the matrices did not lead with:** the transpiler substrate already exists.
`apps/fiab-console/lib/migrate/sql-transpile.ts` declares
`SqlSourceDialect = 'snowflake' | 'tsql'`, carries an exact-1:1 rename table, and classifies
unsupported constructs *honestly* — `LATERAL FLATTEN`, `::` casts, `TO_*` format models,
`PIVOT/UNPIVOT`, `GENERATOR`, `SECURE VIEW`, and Snowflake object DDL each get a named reason
and a "needs review" marker rather than a silent best-effort translation. W1 hardens that
file; it does not create it.

**③ PARITY DEPTH: OUTCOME PARITY, DIFFERENCES DOCUMENTED.** Match what a user can exercise
and observe, using the best Azure/OSS mechanism underneath. Where semantics genuinely differ,
**NAME** the difference so a migrating user meets it in a doc, not in production. Mechanism
parity — replicating micro-partition pruning, Fail-safe, Snowgrid internals — was explicitly
**REJECTED**.
**What it changes concretely:** the *Semantic delta* column is the **contractual** column of
every matrix, not a footnote, and §6 of this document is a first-class deliverable rather
than a caveat.

---

## 4. The die-hard rules, and what each one forces on this program

Every work item in §10 cites the rules it must satisfy. These are the ones that bite hardest
here.

| Rule | What it forces on this program specifically |
|---|---|
| `no-fabric-dependency.md` | No Snowflake-parity capability may route through Fabric or Power BI on a default path. **The live tension to name, not hide:** Microsoft's published forward path for the Synapse dedicated SQL pool is migration to Fabric Data Warehouse, and that pool is Loom's entire Gov warehouse substrate. §13 item 6. |
| `cloud-parity.md` | A capability that works in Commercial and not Gov is **incomplete**. Every matrix row carries five boundary verdicts and **a blank is a defect**. Any `govViable: Yes` resting on a Databricks SQL or Unity Catalog call is **re-graded by rule** — that correction was applied 12+ times in `MATRIX-ui.md` alone. §7 carries a **blocking** open question about ACA at IL5 that this rule makes load-bearing. |
| `auto-bind-by-default.md` | **The P0 for the operator's demo is a violation of this rule, not an MCP gap.** `loomMirrorSnowflakeLinkedService` defaults to `''` (`admin-plane/main.bicep:1559`, `main.bicep:1017`) and appears in **zero** `.bicepparam` files, so Snowflake mirroring reaches an honest gate whose remediation is *"go create an ADF linked service by hand."* Two further live violations: `user-data-function-editor.tsx:702-703` ends at *"deploy to your own Azure Function App"*; `synapse-notebook-editor.tsx` / `launch-item.ts` still require attaching compute before a notebook runs. |
| `no-vaporware.md` | A stored-but-unenforced setting is Grade F. The recurring shape here is a **knob without its actuator**: `QUERY_ACCELERATION_MAX_SCALE_FACTOR` without QAS, `timeTravelDays`/`liquidClustering` as dead Cosmos values with no autotune job, `ACA_WORKLOAD_PROFILES` validated in code and assigned in no params file, `synapse-auto-pause.bicep` which its own header records has **never deployed**. None of these may ship ahead of the thing that makes them do something. |
| `ui-parity.md` | Every surface gets `docs/fiab/parity/<slug>.md` with **zero ❌** before it is called A-grade, and the Snowflake source UI is inventoried from Snowflake's own docs first. `MATRIX-ui.md`'s 40 rows are that inventory for Snowsight. |
| `ux-baseline.md` | **G1** — browser E2E before done; `tsc` + `vitest` are not evidence. **G2** — every gate carries an inline **Fix it** and a gate-registry entry; the registry is **built** (10 modules), so this is available today, not pending. **G3** — resizable panels on every canvas and query pane. |
| `deploy-integrity.md` | **R1** — a broken deploy path preempts feature work; two rows in this program are P0 under it (§5.2, §9.4). **R2** — merged is never done. **R4** — greenfield and brownfield, both clouds, verified independently. **R7** — no error asserts a cause the code did not establish; the whole §6 error discipline and `MCP-INTEGRATION.md` §7 exist for this. |
| `web3-ui.md` | Loom design tokens and shared primitives, never ad-hoc. Applies to all 40 Snowsight-parity surfaces and to every new admin page this program adds. |
| `loom-no-freeform-config` | Snowflake connection, warehouse and policy configuration is typed fields and pickers. No JSON textarea, no hand-typed account URLs where the platform can enumerate. |

---

## 5. The seams — what this PRP consumes and must not duplicate

### 5.1 PR #4024 — Snowflake mirroring: **MERGED and DEPLOYED to Commercial**

Measured 2026-08-25:

| Fact | Value |
|---|---|
| PR #4024 state | **MERGED** at `2026-08-25T01:20:04Z`, merge commit `4d4fd0b92c` |
| `origin/main` | `4d4fd0b92c` — i.e. main **is** the #4024 merge |
| Commercial estate `/build-marker.txt` | `sha=4d4fd0b92c… stamp=20260825T012928Z` |
| Gov estate | **UNVERIFIED.** No Gov build marker was read in this pass. Per the Gov access rule any Gov claim needs a GitHub Actions receipt, never local `az`. |

So the previous draft's hard rule — *"the 28 files are out of bounds until it is merged and
deployed"* — is **satisfied for Commercial** and the gate now reads, per `deploy-integrity.md`
R2, *"deployed and verified?"* rather than *"merged?"*. What #4024 landed, verified on
`origin/main`:

- a creatable `snowflake` `ConnectionType` with `['sql-password', 'key-pair']`
  (`connectable-types.ts:68,91,142`) and a new `key-pair` `AuthMethod`;
- `lib/azure/snowflake-adf.ts` — a real Snowflake enumeration path that **polls** to a
  terminal state;
- `lib/azure/mirror-adf-copy.ts` + `mirror-adf-shared.ts` split out of `mirror-engine.ts`,
  with `mirror-adf-copy.test.ts`, `mirror-adf-cdc.test.ts`, `snowflake-adf.test.ts`;
- the **`includeIcebergTables`** fix. Four separate matrices independently re-verified this
  and all four record the "dead flag" claim as **STALE**. It reads
  `INFORMATION_SCHEMA.TABLES.IS_ICEBERG`, filters on the flag, and distinguishes "this
  Snowflake edition does not expose `IS_ICEBERG`" from "no Iceberg tables". **Do not
  re-file it.**

**The two seams this PRP consumes and never edits:**

| Seam | Owner | This PRP's dependency |
|---|---|---|
| `snowflake` ConnectionType + `key-pair` AuthMethod + the `loom-conn-<uuid>` KV pattern | #4024 | W1.3's MCP server and W1.1's reader resolve connections through it. **No second connection model.** |
| Iceberg discovery (`IS_ICEBERG`) | #4024 | W2.4 federates those tables through the Iceberg REST catalog instead of copying them |

### 5.2 Issue #4025 — the failure shape the MCP mirror tool must not inherit

**#4025 is OPEN:** *"mirroring: ADF Copy reports Running without polling, so every run-time
failure looks like success."* That is a `deploy-integrity.md` R7 violation in miniature — a
status asserted that the code never established.

**Binding on W1.3:** `loom.snowflake.mirror.*` tools are a **thin façade over
`mirror-engine.ts` / `mirror-adf-copy.ts`**, never a parallel engine, and `mirror.status`
**must poll to a terminal state** or return `state:'unknown'` with the reason. A tool that
returns `Running` because it did not look is the same defect with a new caller. The
regression test is explicit: a pipeline run that **failed** must surface as failed through
the MCP tool, not as `Running`.

### 5.3 The MCP work is **NOT** greenfield — and the name lies

This is the single most likely re-scoping error in this program, so it is stated plainly.

**`apps/loom-mcp` already exists and is mature.** Five stdio servers split by blast radius —
`loom-catalog` (read), `loom-query` (bounded read), `loom-author` (write, dry-run default),
`loom-ops` (runs/logs), `loom-admin` (escalation, default-OFF, `rejectPat: true`) — over one
shared security core: `src/core/{auth,authz,tool,types,errors,scrub,audit,credential-store,server,index}.ts`.
`core/tool.ts` runs `authorize → run → scrub → audit → normalizeError` on **every** call, and
`core/authz.ts` is the single fail-closed gate with the right governing principle already
written into it: *"the MCP tool calls the BFF handler, it does not reimplement it."*

**Loom is also already an MCP client**, and a spec-correct one: `lib/azure/mcp-client.ts`
POSTs to the endpoint itself, sends `initialize` first, echoes `Mcp-Session-Id`, advertises
`Accept: application/json, text/event-stream`, and parses plain-JSON *or* SSE. Supporting
pieces exist: `mcp-egress-guard.ts` (SSRF, HTTPS-only, private-IP rejection,
`LOOM_MCP_EGRESS_ALLOW`), `lib/mcp/catalog.ts`, and **11 real routes** under
`app/api/admin/mcp-servers/` including `test-connection`, behind the **already-built**
`/admin/mcp-servers` page.

**The actual gap is two things, and neither is "write an MCP server":**

1. **`apps/loom-mcp` is stdio-only and has never been deployed.** `publish-loom-mcp.yml:20-22`
   states its own publish is **BLOCKED** (`@csa-loom/sdk` is a `file:` dependency npm refuses
   to publish), so the tag path is a no-op.
2. **The name collides with a different artifact.** `build-fiab-images.yml:121-122` maps
   `app: loom-mcp` → `context: ./apps/fiab-mcp-config`. **The Container App called `loom-mcp`
   runs Microsoft's Azure MCP Server, not `apps/loom-mcp`.** An agent that greps for
   `loom-mcp` in bicep and concludes the package is deployed will be wrong, and an agent that
   "fixes" the image target without repointing the Container App in the same PR will
   crash-loop the roll.

`MATRIX-mcpagentic.md` M2 grades this **P0 under `deploy-integrity.md` R1** and it blocks
M3/M4/M5/M20/M23. Its own note is the one to obey: **a green CI gate will not prove this row
— the previous state passed CI while the endpoint did not exist.** The receipt is a live
`tools/list` against the deployed bridge URL.

**The cheapest correct path, per M2, is not a new transport.** `apps/fiab-mcp-bridge` already
speaks the contract (`POST /servers/<id>/tools/list`, `tools/call`, `GET /sse`, internal
`:8080`). Register the five servers in `config/loom-mcp-bridge.json` and auto-register them as
hosted `McpServerConfigDoc`s in post-deploy bootstrap. Write a second transport only if the
bridge genuinely cannot carry it.

---

## 6. The honest list — what Loom CANNOT match one-for-one

Naming these is worth more than a plan that omits them, and under decision ③ this section is
the contract. **16 whole rows** carry a `cannot-match` verdict; roughly 20 more rows ship a
design with a **named cannot-match component** (`MATRIX-ui.md` marks 13 of those ⛔). Every
one below is: the closest honest equivalent, and the exact semantic difference a migrating
user hits.

| # | Snowflake capability | Domain | Closest Loom equivalent | The exact semantic difference |
|---|---|---|---|---|
| 1 | **Adaptive Warehouses** | compute, ops | Per-warehouse windowed control loop | Snowflake resizes **between queries from a shared account pool with no disconnect**, bills per query, and **does not bill an adaptive warehouse for existing**. Loom bills wall-clock, and the only Gov-viable actuator — a Synapse DWU change — **disconnects running queries** and takes minutes (ARM reports `Online` 2–3 min before it can serve). A visible interruption vs never one. |
| 2 | **Replication groups (Snowgrid)** | compute, ops, ui | Coordinated group with **per-plane** consistency | **The atomicity IS the capability.** One transactionally-consistent point in time across databases, warehouses, users and roles with **one** failover verb cannot be layered over Azure SQL failover groups + Cosmos multi-region + ADLS object replication + Event Hubs geo-DR + ADX followers, which fail over **independently to different points in time**. Loom's single headline number is definable only as *the oldest plane's consistency point*. And `restoreToNewPool` **changes the resource name**, so failover breaks every binding unless an AGW/Front Door + Private DNS indirection is in front. |
| 3 | **Cloud-services layer + 10% daily credit** | compute | A visible "platform services" cost line | Azure has no separate control-plane bill, so **there is nothing to credit back**. A metadata-heavy workload effectively free under Snowflake's adjustment incurs real Cosmos RU and ARM cost on Loom. Presenting a synthetic 10% credit would be **fabricating a discount Loom cannot fund** — explicitly out of scope. |
| 4 | **Differential privacy (engine-enforced)** | governance | k-anonymity tier + an opt-in OpenDP aggregate service | Snowflake attaches a privacy policy **to a table**, so any query from any client gets DP automatically. Loom's is an **opt-in query mode against a separate service** — a *different security boundary*, because a user querying the underlying table directly gets **no noise at all**. Must be paired with a `REVOKE` on the direct path, and described as a DP aggregate service, never as equivalent. |
| 5 | **Instance roles / Snowflake classes** | security | Concept mapping onto app install + per-route API gating | `CREATE <CLASS> … INSTANCE` has no analog; a migrating user finds nothing. Real granularity loss: class **instance methods** are procedures with role-gated `EXECUTE`; Loom's equivalent is the app's API surface gated **per route**, so a naive mapping **over-grants a whole route group** where Snowflake gated one method. |
| 6 | **Organizations spanning boundaries** | security, ops, ui | Per-boundary org tiers | A Commercial org and a GCC-High org are **separate organizations with separate directories**. Entra cross-cloud B2B is not a sound basis for an authorization plane. Even within one boundary: a Snowflake org user is **ONE object**; Loom's is **N directory objects reconciled by SCIM**, so an org-level deprovision is not instantaneous in every stamp. |
| 7 | **Periodic rekeying** | security | Lake rekey as a transactional rewrite | Snowflake rekeys yearly with **no data movement the customer sees**. Loom's is a full rewrite with real compute cost and changed file mtimes. Cannot be transparent. |
| 8 | **Multi-party approval (MPA)** | security | In-tenant approver quorum | Snowflake's MPA resists a **fully compromised customer tenant** precisely because Snowflake is outside it. **Every approver Loom can name is inside the customer's tenant.** The threat model does not transfer. |
| 9 | **SQL-callable Python UDAF** | programmability | Spark `GROUPED_AGG` | SQLCLR is absent from Azure SQL and Synapse dedicated, so there is **no `CREATE AGGREGATE` path in any cloud** — not a Gov gap. `GROUPED_AGG` is a **topology change**, materializes each group on one executor (a skewed key OOMs where Snowflake streamed), and `accumulate`/`merge`/`finish` ordering is non-deterministic across partitions. Day-one rewrite. |
| 10 | **`MEMOIZABLE` scalar SQL UDFs** | programmability | Cache at the HTTP invoke boundary | Snowflake caches **inside the engine, per session, per argument tuple, in the query plan** — a function referenced 10M times evaluates once per distinct argument. A T-SQL scalar function inside a warehouse query gets **nothing**. That pattern must be rewritten (join to a cached table, indexed view), not annotated. |
| 11 | **Native App monetization (collection)** | programmability | Metering + chargeback only | Metering, dimensions, price sheets and per-consumer statements all work everywhere; **transactable marketplace collection does not exist in Azure Government.** Microsoft's boundary, not Loom's — but a package depending on it must declare **Commercial-only** or it breaks at install in Gov. |
| 12 | **Snowpark-optimized *warehouse*** | programmability | Memory-optimized handler compute (E-series ACA, Synapse `MemoryOptimized`) | The Loom `warehouse` item has **no Python execution mode at all**, so there is nothing to resize into. A user migrating this workload is **changing topology, not resizing**. |
| 13 | **Iceberg `EXTERNAL_VOLUME = SNOWFLAKE_MANAGED`** | storage | Loom-managed lifecycle on customer-owned storage | **"Managed" means lifecycle, not custody** — permanently and intentionally. A user who chose `SNOWFLAKE_MANAGED` to avoid owning a bucket **will still own the storage account** in Loom. |
| 14 | **Snowflake Open Catalog (managed Polaris)** | storage | Self-hosted `loom-unity` + Iceberg REST | **There is no managed catalog to migrate *to*; the destination is self-hosted, and that is the point.** A migrated Polaris grant script fails where the role model diverges. Worse: `loom-unity`'s own Postgres metadata store is **default-off in GCC-High and IL5** — see §7.4. |
| 15 | **Hybrid tables (Unistore)** | storage | Postgres/Azure SQL row store + CDC to the lake | **No single-store HTAP on Azure and no cross-store ACID transaction.** Seconds of lag is not transactional consistency; a Unistore workload that reads-your-write across the row and analytic sides **will be wrong**. Debezium slot bloat can fill the OLTP disk and take the row store down. |
| 16 | **Search optimization — substring/regex** | storage | Azure AI Search as a separate accelerating index | Point/range classes are buildable. **Substring/regex has no lake-native answer**: the honest route is a separate index with its **own consistency lag and its own ACL surface** — a different mechanism, not transparent file skipping. And it only accelerates engines where **Loom supplies the file list**; a raw Spark or ad-hoc read will not use it. |
| 17 | **Cortex Search replication (Snowgrid)** | ai | N independent AI Search indexes | **These are independent indexes, not a replicated store.** No transactional consistency, no bounded replication lag — two regions can legitimately return **different results** during an indexer window. Cost multiplies linearly and does not scale to zero. |
| 18 | **CoCo Desktop** | ai | An installable PWA | Deliberate non-goal, not a gap. A native binary in GCC-High/IL5/DoD needs code signing + an approved distribution channel + ATO review of a new endpoint binary; a PWA installs nothing and inherits MSAL unchanged. **If the real requirement behind "desktop" is OS integration (global hotkey, filesystem watch, tray), say the PWA does not satisfy it.** |
| 19 | **`USE SECONDARY ROLES ALL`** | mcpagentic, security | Role selection that can only **narrow** | Snowflake **unions** privileges across activated roles. Loom's must intersect with Entra-held roles; the remediation for more reach is an **Entra group grant**, never a Loom role trick. Note the inverse hazard: Entra's union-of-all-groups default is **more permissive** than Snowflake's single current role, which will surprise a migrating security reviewer in the other direction. |
| 20 | **RFC 7591 dynamic client registration** | mcpagentic | `/register` over an approval queue + a bounded Entra app pool | **Entra does not implement DCR.** Approved, not automatic. |
| 21 | **Set-returning agent fan-out in SQL** | mcpagentic | Scalar over a **capped** result set + materialized enrichment | `SELECT DATA_AGENT_RUN(col) FROM big_table` has no path: **ADX has no engine-side HTTP egress, and Synapse has no `sp_invoke_external_rest_endpoint` in any cloud** (§7.5). |
| 22 | **Feature policy blocking app-created agents/MCP servers** | mcpagentic | A runtime kill switch | **Loom has no app-side agent/MCP creation path, so the control has no counterpart.** State the absence rather than shipping a policy over an empty population. |
| 23 | **Query Profile (operator-level actuals)** | ui, ops | Step-level actuals on Synapse dedicated | Snowflake's profile is always actual, post-hoc, **per-operator**. Loom's best case has **no operator-level attribution inside a step**, and Azure SQL needs an opt-in re-run — *a different execution*. **The Snowflake performance engineer's core daily loop does not fully reproduce.** |
| 24 | **Micro-partition telemetry** | ui, storage | Engine-named raw counters | `partitionsScanned/partitionsTotal` and `bytesScanned` are **absent on Synapse dedicated — not zero.** Rendering them as 0 is the UNKNOWN-as-NEGATIVE failure already in this repo's history. Never present a single fabricated "pruned %". |
| 25 | **Cross-boundary anything** | all | *Nothing.* Refuse explicitly. | Sharing, listings, clean rooms, org spanning, replication, reader accounts, Native App distribution and telemetry, Marketplace fulfilment: **Commercial↔Gov does not exist.** Seven lanes each discovered this independently and each wrote its own footnote. §9.5 makes it one program-level refusal with one mechanism. |

Two things are **not** on this list because they are matchable, and saying so is worth as much
as naming the gaps: **clustering depth is computable exactly** (an interval sweep over Delta
per-file min/max reproduces `SYSTEM$CLUSTERING_DEPTH`'s arithmetic including its JSON key
names), and **`AUTO_SUSPEND` / `AUTO_RESUME` are fully matchable in Gov** — they are simply
absent today, which makes them the highest-value Gov rows in the whole program.

---

## 7. Boundary truth — the corrections that must not reach customer copy

A stale compliance or availability claim in a migration guide is the kind of thing that gets
quoted into an ATO package. These are the ones that were wrong.

### 7.1 "Snowflake has no Government region" is **FALSE** — and it came back after being corrected

Three matrix cells assert it (`MATRIX-compute.md:104`, `:128`, `MATRIX-mcpagentic.md:123`).
The previous draft of this PRP already corrected it, in bold, in its §2 ①. **It propagated
anyway** — the exact `csa_loom_stale_audit_items_propagate` shape.

Snowflake's own supported-regions page lists **`usgovvirginia` — "US Gov Virginia (FedRAMP
High Plus)" on Microsoft Azure Government**, plus AWS GovCloud at DoW IL4 and a `us-gov-west-1`
row at **DoW IL5**. Snowflake is on the FedRAMP Marketplace as *The Data Cloud on Azure
Government (High)*.

**The true claims are stronger, and they replace the false one:**

1. **Snowflake's Azure Government deployment is FedRAMP High Plus + ITAR — not IL4, not IL5.
   Snowflake's IL5 offering is AWS GovCloud only.** So an **Azure-resident IL5/DoD customer
   has no in-boundary Snowflake option.** That is the accurate version of what those three
   cells were reaching for, and it is the real differentiator.
2. There are **two** `usgovvirginia` rows. The one carrying *"This deployment has reached end
   of life, and will be decommissioned at the beginning of 2027"* is the plain "US Gov
   Virginia" row, **not** the FedRAMP High Plus row. This **closes** the previous draft's
   UNVERIFIED §12 item 2 — that reading was right. Confirming which deployment a given target
   account sits on is still §13 item 1.
3. Snowflake's documented Gov restrictions that **do** hold: no self-provisioning of initial
   accounts; no event notifications to/from commercial regions; access limited to US
   Government customers/contractors; and **Data Clean Rooms unavailable in government
   deployments**.

**The defensible sovereign differentiator list, in full:**

- **IL5 on Azure** — Snowflake has no in-boundary Azure option there.
- **Data Clean Rooms** — Snowflake documents them as unavailable in Gov. **Loom can build
  them in-boundary and no lane noticed.** `MATRIX-governance.md` row 34 (differential privacy,
  OpenDP-on-ACA) is the nearest neighbour and never connects to it.
- **Cortex in-boundary** — Cortex authorization is scoped away from Azure Gov and its escape
  hatch is cross-region inference, which is frequently the exact thing the boundary forbids.
  This is the strongest one and `MATRIX-ai.md` already has it right.
- **Unity Catalog absence** — five lanes identified this correctly. `loom-unity` is not a
  parity checkbox in Gov; **it IS the catalog**.

### 7.2 **BLOCKING** — Azure Container Apps is not in the DoD IL4 or IL5WI audit scope

From Microsoft's *Azure Government services by audit scope* (last updated February 2026):

| Service | FedRAMP High | IL2 | IL4 | **IL5WI** | IL6 |
|---|---|---|---|---|---|
| **Azure Container Apps** | ✅ | ✅ | — | **—** | — |
| Azure Kubernetes Service | ✅ | ✅ | ✅ | **✅** | ✅ |
| Container Registry · Data Explorer · Azure OpenAI · AI Search · Synapse · Front Door | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Microsoft Purview** | ✅ | ✅ | ✅ | **—** | — |
| **Azure Managed Grafana** | ✅ | ✅ | — | — | — |

Verified in the repo: `platform/fiab/bicep/params/il5.bicepparam:121` reads
`param containerPlatform = 'containerApps' // ACA GA in USGov Virginia/Arizona/Texas (GOV-3)`.
**That comment conflates regional GA (true) with IL5 authorization (not established), and
every lane inherited it.**

Container Apps carries `loom-duckdb`, `loom-trino`, `loom-unity`, the Iceberg REST catalog,
the MCP bridge, `loom-capacity-broker`, Presidio, RisingWave, MAF, the UDF runtime — and
**every ACA Job** this program depends on (auto-suspend, autotune, resource monitors,
replication schedules, serverless tasks, QAS offload workers, budget refresh, DQ runs).

**Three consequences the matrices have backwards:**

1. **AKS is the primary IL5 path, not the fallback.** A dozen rows across five lanes name
   *"if ACA Jobs are absent → a K8s CronJob on the existing `loom-trino` AKS cluster"* as a
   contingency. At IL5 it is **the design**.
2. **The cost argument inverts.** `MATRIX-compute.md` row 10 calls the ACA-hosted DuckDB tier
   *"the strongest Gov row in the domain"* partly on scale-to-zero economics, and
   `MATRIX-ai.md` §9 notes AKS breaks the ~$0-idle property. **At IL5 the $0-idle property
   does not exist.**
3. This is ATO-grade, and `MATRIX-mcpagentic.md` already had the opposite fact from the
   bridge README (*"Container Apps not at IL4+"*) — so the repo contradicts itself in two
   files.

**This is W0.6 and it is flagged to verify FIRST, not as a settled verdict.** "Audit scope"
and "regionally available" are different questions and the operator may hold a risk-acceptance
position. **But no lane distinguishes them**, and the repo comment that produced the
assumption makes exactly that conflation.

Same class, smaller blast radius: **Purview is ✅ only through IL4** — the repo already knows
(`il5.bicepparam:10`: *"Atlas on AKS replaces Purview at IL5"*) while `MATRIX-governance.md`
repeatedly says "Purview classifications are supported in Gov" without it. **Managed Grafana
is ✅ FedRAMP High + IL2 only** — the UI lane substitutes self-hosted Grafana, correctly, for
the wrong stated reason.

### 7.3 "DoD" means two incompatible things and exactly one lane noticed

| Reading | Regions | Services at IL5 PA |
|---|---|---:|
| (i) US Gov regions at IL5WI | US Gov Arizona / Texas / Virginia | **150** |
| (ii) US DoD regions | US DoD Central / East | **60** |

The 60-service US DoD list **excludes** Container Apps, AKS, Data Explorer, Container
Registry, Azure OpenAI, AI Search, Machine Learning, Purview, Data Factory, Databricks,
Defender and Sentinel. It **includes** Synapse, Azure SQL, Functions, App Service, Batch,
HDInsight, Service Fabric, Event Hubs, Event Grid, Key Vault, ADLS Gen2, Redis, Cosmos,
PostgreSQL, APIM, App Gateway, Front Door, Traffic Manager, Logic Apps, Monitor, Site
Recovery.

`MATRIX-ops.md:35` is the **only** place in 365 rows that references US DoD Central/East, and
it handles it correctly. `MATRIX-compute.md:39-43` and `MATRIX-storage.md:39-42` both define
the DoD column as *"IL5 params inherited, no `dod.bicepparam` exists"* — honest about
**deployment**, silent about **audit scope**. Confirmed: `platform/fiab/bicep/params/` holds
`commercial`, `commercial-full`, `dlz-attach`, `gcc`, `gcc-high`, `il5`, `tenant-dmlz`. **No
`dod.bicepparam`.**

Under reading (ii) essentially every DoD ✅ in the AI, MCP, governance, storage,
programmability, security and UI lanes fails. Microsoft itself recommends prioritising US Gov
regions for IL5 workloads, so reading (i) is defensible — **but it must be stated once,
program-wide** (W0.6), and the DoD column must name which regions it means.

**IL6 is a named gap in one lane and silent in ten.** `MATRIX-compute.md:42` says *"A separate
IL6 boundary is an unshipped, named gap for the whole domain."* It is a gap for the whole
**program**, and it is not uniform: AOAI, AI Search, Synapse, ADX, ACR, AKS, Front Door and
Cosmos are ✅ at IL6, while Purview, Databricks, Cost Management, ACA and Managed Grafana are
not. One program-level row, not eleven silences.

### 7.4 The Postgres gate is a **quota** decision Loom controls, not an authorization one

`MATRIX-storage.md` calls `postgresQuotaAvailable=false` *"the highest-value open Gov gap in
the domain"* — correct, and the best-argued Gov finding in the set. Verified:
`gcc-high.bicepparam:354` and `il5.bicepparam:397` both read
`param postgresQuotaAvailable = bool(readEnvironmentVariable('LOOM_POSTGRES_QUOTA_AVAILABLE', 'false'))`.

**Loom Unity exists to replace the Unity Catalog Gov lacks, and its own metadata store is off
there** — priority inverted exactly the way `cloud-parity.md` warns against.

**One refinement the matrix did not make: Azure Database for PostgreSQL is ✅ at IL5WI.** So
this is a quota/params decision inside Loom's control, **cheaper to fix than the row
implies**, and the named substitutes (OSS Postgres on AKS, Azure SQL) may be unnecessary.

### 7.5 Four more claims corrected

| Claim as written | Actually | Consequence if unfixed |
|---|---|---|
| `MATRIX-compute.md` row 5: *"Synapse concurrency **is** `100 / minGrant`"* and min-grant families are `3, 4.5, 6, 10, 25, 50, 75, 100` | Microsoft: `[Max Concurrency] = [CAP_PERCENTAGE_RESOURCE] / [REQUEST_MIN_RESOURCE_GRANT_PERCENT]` — **the numerator is the workload group's cap, not 100**. Per-service-level minimum grants are **25 / 12.5 / 8 / 6.25 / 5 / 3 / 2 / 1.5 / 0.75**. And there is a **hard ceiling that never exceeds 128** at any service level: DW100c=4, DW1000c=32, DW2000c=48, DW3000c=64, DW6000c–DW30000c=128 | A `QUERY_THROUGHPUT_MULTIPLIER` compiled on `100/minGrant` **over-promises concurrency at every rung** and silently caps at 128 on the Gov default warehouse. The previous draft flagged this; **the second-pass matrix carries it with a worse numerator.** |
| `MATRIX-compute.md` row 48: *"Front Door is **not IL5-certified**"* (sourced to `il5.bicepparam:8`) | Microsoft's Azure Government GA roadmap lists **Front Door, Front Door Standard and Premium as GA at FedRAMP High, IL4 and IL5**; the audit-scope table shows Front Door ✅ across High/IL2/IL4/IL5WI/IL6; Front Door Private Link is available in US Gov Arizona, Texas **and** Virginia. Confirmed in the repo: `il5.bicepparam:8` carries the comment and `:419` sets `frontDoorEnabled = false` | **A stale repo comment propagated as external fact — the second instance of the exact pattern `MATRIX-security.md` calls its own highest-leverage correction, and no lane caught this one.** An entire ⚠️-substitute chain (AGW + Private DNS as the only IL5 endpoint indirection for DR) may be unnecessary. |
| `MATRIX-ai.md` row 15: front per-region AI Search with **Traffic Manager** (performance routing, health probe on `/indexes`), *"because its Gov availability is unambiguous"* | Microsoft: *"Traffic Manager doesn't provide an endpoint for a direct connection to Azure AI Search"*, and *"If you reach the same endpoint using a different DNS name in the host header, such as a CNAME, the request is rejected."* Traffic Manager is CNAME-based, so **this design fails on the host header**. `/indexes` also requires auth; `/ping` is the documented probe | The row's **conclusion** (independent indexes, not replication) is right and well argued; the **mechanism is not**. The correct Loom answer is **region selection in the BFF**, which Loom already owns. Microsoft's own sample uses Front Door + Functions. |
| `MATRIX-storage.md` Iceberg v3: gov = Yes, all boundaries, reasoning *"sovereign availability is a build-and-push problem"* | True about deployment, silent about whether the **engines implement v3**. Trino's Iceberg connector documents spec v3 as **experimental** with deletion vectors tracked in open issues; PyIceberg's deletion-vector write path is partial. Apache Iceberg 1.11.0 (May 2026) stabilised v3. **Snowflake shipped Iceberg v3 GA 2026-05-07.** | A customer migrating v3 tables — deletion vectors, row lineage, VARIANT, geospatial, type widening, default column values — **meets an experimental reader on day one.** The row should be ⚠️ with the engine-version constraint named. |

**And two hard limits neither `MATRIX-mcpagentic.md` M17 nor `MATRIX-programmability.md` rows
22/29 carry** about `sp_invoke_external_rest_endpoint`: the allowed-endpoint list applies
**only to Azure SQL Database and Azure SQL Managed Instance** (which is *why* Synapse is out —
it is structural, not a gap to close), and outbound calls are **throttled to 10% of worker
threads, max 150 workers**, raising 10928/10936 at the cap. Every entry in the allow-list is
Commercial-suffixed (`*.azurecontainerapps.io`, `*.azure-api.net`, `*.openai.azure.com`,
`*.search.windows.net`, `*.blob.core.windows.net`, `graph.microsoft.com`) and every one has a
different Gov suffix. **APIM fronting is the documented escape hatch and the right
mitigation — and it needs a live Gov Actions receipt before either row is marked done.**

### 7.6 Claims that were checked and **hold** — recorded so they stop being re-litigated

- **Databricks in Gov.** Verbatim, still: *"The Azure Government regions `usgovaz` and
  `usgovva` do not support any of the following features. Additionally, these regions do not
  support Databricks SQL or Unity Catalog."* Two adjacent facts worth adding: **UC Volumes**
  *"aren't available in Azure Government regions or workspaces with FedRAMP compliance"*, and
  Databricks **temporary tables** *"are not supported in Azure Government regions"* — the
  latter bears directly on `MATRIX-storage.md`'s temp-tables row.
- **Conditional Access via application permissions in Gov.** `MATRIX-security.md`'s headline
  correction is correct: `POST /identity/conditionalAccess/policies` is ✅ Global / US Gov L4 /
  **US Gov L5 (DOD)** with Application permissions `Policy.Read.All` +
  `Policy.ReadWrite.ConditionalAccess`. Confirmed in the repo:
  `conditional-access.bicep:11` still asserts *"SPNs cannot create CA"*. **That one stale
  comment is why five security rows read as impossible. Deleting it is W0.3.**
- **Synapse `QUERY_EXECUTION_TIMEOUT_SEC`** is real and engine-enforced, set on
  `CREATE WORKLOAD GROUP`.
- **Azure AI Search has no built-in geo-replication** — *"a single-region service… doesn't
  provide an automated method of index replication across regions."*

---

## 8. Capability gaps the matrices do not cover at all

These are **not** in any of the 365 rows. Three fall in the unmapped domains; the rest fell
between two mapped ones. **`WR` (§10) closes them; nothing that depends on them may be
committed first.**

### 8.1 Streams / `CHANGE_TRACKING` / the `CHANGES` clause — the single largest omission

`grep -i` across all nine matrices returns **one** hit for the Snowflake `STREAM` object, in a
passing list of object-type tabs (`MATRIX-ui.md:100`). `CHANGE_TRACKING` returns **zero**. No
row, no target architecture, no semantic delta.

Streams are the CDC primitive most Snowflake ELT is built on. Undesigned: `METADATA$ACTION` /
`METADATA$ISUPDATE` / `METADATA$ROW_ID` (updates surface as DELETE+INSERT pairs); **the offset
advances only when the stream is consumed in a DML transaction** and moves to
transaction-start-time on commit, with repeatable-read inside the transaction; standard vs
append-only vs insert-only; staleness, `STALE_AFTER`, `MAX_DATA_EXTENSION_TIME_IN_DAYS`;
streams on views (join-delta semantics), directory tables, external tables, dynamic tables and
event tables; the offset-free `CHANGES` clause.

**Why it fell through:** it is a table property (storage), a pipeline primitive (ingestion —
absent), and a dynamic-table input (storage covered dynamic tables, not their source streams).

**Why it matters more than a missing row — this is a §6 entry waiting to be written.** The
honest Loom mapping is Delta change data feed or Iceberg incremental scan, and **neither has a
transactional offset.** CDF is version-ranged and read-only; there is no *"consume in a
transaction, offset advances atomically on commit."* The honest equivalent is an
**at-least-once watermark**, and **every `MERGE … FROM my_stream` a customer brings over needs
idempotency it did not previously need.** That is a day-one correctness change and nobody has
written it down. Note the repo already ships `docs/migrations/snowflake/streams-tasks-migration.md`
(541 lines) — so a doc exists that this program has not validated.

### 8.2 Snowpipe Streaming — zero mentions

`MATRIX-ui.md` row 26 designs an `ingestion-pipe` item over Event Grid `BlobCreated` + ADF
`BlobEventsTrigger` — i.e. **file-notification Snowpipe only**. Snowpipe Streaming (row-level
channels, offset tokens, exactly-once, the 2026 high-performance server-side architecture)
returns zero hits. A customer on Snowpipe Streaming has **no mapped path at all**, and the
row's own honest note (*"exactly-once is not free"*) is about the wrong mechanism.

### 8.3 The stage / load surface — near-zero coverage of the first hour

| Capability | Hits across all nine matrices |
|---|---:|
| Internal stages (user `@~`, table `@%t`, named) | 0 |
| `PUT` / `GET` file transfer | 0 |
| File format objects | 0 (1, in a superseded file) |
| `INFER_SCHEMA` · `ENABLE_SCHEMA_EVOLUTION` · `MATCH_BY_COLUMN_NAME` | 0 / 0 / 0 |
| `ON_ERROR` / `VALIDATE()` | 0 |
| `COPY INTO <location>` (unload) | 0 |
| Load-metadata dedup (64-day file dedup) | 1, only as a delta |
| Directory tables · Kafka connector · Spark connector | 0 (1 superseded) / 0 / 0 |

`MATRIX-ui.md` row 25 correctly names the dedup delta (*"Loom's ADF path has no equivalent
file-level dedup"*) but **no lane owns building the stage/format/validate surface it
presupposes.**

### 8.4 Data Clean Rooms — zero, and it is a missed Gov argument

`"clean room"` and `"Data Clean Room"` both return zero across 365 rows. See §7.1: Snowflake
documents DCRs as unavailable in Gov, which makes this one of the very few places where *"Loom
builds it in-boundary and Snowflake structurally cannot"* is **true**.

### 8.5 The sharing object model

`"Secure Data Sharing"`, `"data exchange"`, `"auto-fulfillment"`, `"private listing"`,
`"organizational listing"` all return zero. Coverage is one UI row (29, Provider Studio) and
one ops row (9, reader accounts, correctly graded degraded). **Unowned:** the `SHARE` object,
`GRANT … TO SHARE`, share-level secure views, listing lifecycle, provider usage telemetry,
monetized listings, cross-cloud auto-fulfillment. Multiple lanes assert *"Delta Sharing + OSS
Unity Catalog is the Gov answer"* — **without specifying the object model that would be
shared.** The repo ships `docs/migrations/snowflake/data-sharing-migration.md` (385 lines),
unvalidated by this program.

### 8.6 SQL dialect, drivers and APIs — critical, because the binding posture is transpiler-first

Every matrix opens with **"TRANSPILER NOW"**. **No lane owns the dialect surface that
transpiler must cover, or its per-engine target coverage.**

Zero or near-zero: `GEOGRAPHY`/`GEOMETRY` (0), H3 functions (0), `MATCH_RECOGNIZE` (0),
`RESULT_SCAN` (0), unstructured data / scoped URLs / `BUILD_SCOPED_FILE_URL` (0), `SnowSQL`
(0), the Snowflake **SQL REST API** (0), the Node.js/Go/.NET/PHP/SQLAlchemy drivers (0), the
`snow` CLI (0), the Python management APIs beyond one warehouse resource (0), `QUALIFY` (1),
`PIVOT` (1), `FLATTEN` (2). `VARIANT` appears 14 times, always as a datatype mention, never as
a design row.

This is not pedantry — the Loom engines diverge sharply and predictably. Synapse dedicated has
**no sequences, no computed columns, no indexed views, no synonyms, no `MATCH_RECOGNIZE`, no
`QUALIFY`**; DuckDB, Trino and T-SQL have three different `VARIANT`/JSON models, three
collation behaviours and three NULL-ordering defaults. `MATRIX-compute.md` row 12 flags dialect
divergence as *"the real risk, and it can be silent"* — correctly — **but there is no inventory
of what diverges.** `MATRIX-compute.md` row 44 designs a `csa_loom.compute.Warehouse` SDK
deliberately mirroring `snowflake.core.warehouse.WarehouseResource` method names — a good idea
with **no owner for the other ~30 resource types**, and no owner for the connection layer every
BI tool in a migrating estate uses.

### 8.7 Smaller but real

- **`dbt Projects on Snowflake`** (native dbt runtime with Git, scheduling, lineage): 1 hit.
  Loom has `dbt-runner`; nobody mapped the **object**.
- **Snowflake Postgres (Crunchy Data)**: 0 hits. `MATRIX-storage.md`'s Unistore row is
  adjacent but is about hybrid tables, not the Postgres offering.
- **Streamlit in Snowflake / Snowflake Notebooks as item types**: 0/0 as objects.
  `MATRIX-compute.md` row 46 covers `SYSTEM$STREAMLIT_NOTEBOOK_WH` (the *warehouse*); the app
  and notebook object types are unowned.
- **Snowflake Editions.** Snowflake gates **DCR provider on Enterprise**, multi-cluster / QAS
  / Adaptive on Enterprise, and replication on Business Critical. **Every matrix silently
  assumes top tier.** A customer migrating off Standard will be quoted parity for features they
  never had — and will notice. §13 item 4.

---

## 9. Collisions — arbitrate these BEFORE any build

Nine lanes worked independently. Five capabilities were designed more than once, with
incompatible semantics. In this repo parallel safety is a **file** property (CLAUDE.md §8), so
these are not stylistic — they are merge hazards.

### 9.1 `resource-monitor` — designed twice, with **opposite** enforcement semantics

| Source | Suspend trigger |
|---|---|
| `MATRIX-compute.md` row 29 | *"Make **LCU** the primary trigger and dollars the reconciliation"* |
| `MATRIX-ops.md` row 18 | *"NOTIFY on either signal · **SUSPEND only on the dollar signal**"* |

Both lanes independently observe that the two signals disagree by construction (LCU is
real-time and normalized; Cost Management actuals lag hours) — **and resolve it in opposite
directions.** This is the one control that takes a production warehouse offline. Ops' version
fires hours late; compute's fires on a unit that never ties to an invoice. They also propose
three different schemas. **Both lanes call it "the one place a new item type is clearly
correct" and neither knows the other exists.**

**Arbitration (W0.7):** one owner, one schema, one trigger rule. Recommended:
**Notify on either; Suspend on LCU with a dollar reconciliation shown alongside; Suspend
Immediately only on explicit quota exhaustion behind a hard confirmation and a dry-run.**
Label which signal fired on every threshold event, with its as-of time.

### 9.2 `replication-group` — the previous PRP forbids the object the ops lane proposes

- Previous PRP Wave 9, verbatim: *"**Deliberately a runbook, not an item type.** Inventing a
  `replication-group` object would imply an atomicity Loom does not have."*
- `MATRIX-ops.md` row 29: *"**NEW `replication-group` item type**, built deliberately as an
  orchestration plan, not a claim of atomicity."*
- `MATRIX-compute.md` row 48: a declarative bundle of typed `WarehouseSpec`s +
  `POST /api/admin/failover`.
- `MATRIX-ui.md` rows 10 and 36: Workspaces replication + a replication/failover surface.

Four shapes for one capability — and the two that disagree most sharply reach the **same**
conclusion about atomicity, differing only on whether an object should exist. Ops carries **8**
replication rows (29–36) to compute's 1 and UI's 2.
**Arbitration (W0.7):** ops owns it; this PRP's predecessor position is **amended**. The object
ships as a *coordinated group with per-plane consistency*, captioned as such, with a single
headline number defined as the **oldest plane's** consistency point.

### 9.3 Three incompatible `ACCOUNT_USAGE` marts, each called "the spine"

| Lane | Name | Store | Query surface | Dialect a migrating user writes |
|---|---|---|---|---|
| `MATRIX-compute.md` row 36 | `LOOM_USAGE` | Delta/Iceberg on ADLS, in `loom-unity` | "every engine Loom ships" | unspecified |
| `MATRIX-ops.md` row 7 | `loomdb_account_usage` | **ADX** | **KQL functions** over ADX's TDS emulation | **DQL-only T-SQL subset** |
| `MATRIX-governance.md` row 35 | `LOOM_ACCOUNT_USAGE` | Delta on ADLS | **Synapse serverless external views** + ADX external tables | T-SQL and KQL |

They claim overlapping view names (`QUERY_HISTORY`, `WAREHOUSE_METERING_HISTORY`,
`METERING_HISTORY`, `access_history`, `grants_to_users`). Ops calls its version *"the spine
every other row hangs off"* and makes **nine** ops rows publish into it.

**Two second-order problems inside this collision:**

- **Ops' own semantic-delta says its design breaks migrated SQL:** *"Loom's are KQL functions
  surfaced through ADX's SQL emulation, which is DQL-only: no DDL/DML, no correlated
  subqueries, no recursive CTEs, no `EXISTS`/`ANY`/`ALL`, no `AT TIME ZONE`. **A migrating
  user's `ACCOUNT_USAGE` queries will need rewriting on day one.**"* Governance's
  Synapse-serverless design would not. **Under MIGRATION-FIRST that is a decisive argument
  nobody is having.**
- **ADX is under this repo's standing estate-pause mandate.** Governance row 35 spots it (*"the
  KQL path must honest-gate when the cluster is stopped rather than erroring"*); ops, which
  makes ADX the spine of nine rows, does not.

**Arbitration (W0.7):** **one mart, one store, one primary query surface.** Recommended:
Delta-on-ADLS as the store, **Synapse serverless external views as the primary SQL surface**
(migration-first: it does not force a day-one rewrite), ADX external tables as the KQL
surface, honest-gated when the cluster is paused. `LOOM_USAGE` as the single name.

### 9.4 Eleven new item types, one set of shared catalog files, **no owner**

Proposed across lanes: `resource-monitor` (compute **and** ops), `compute-pool` (compute),
`replication-group` (ops), `event-table` (ops), `ingestion-pipe` (ui), `connector-runtime`
(ui), `task-graph` (ui), `docintel-model` (ai), `ai-policy` (ai), the `MCP SERVER` object
(mcpagentic), plus `budget-object`.

`MATRIX-mcpagentic.md` correctly identifies the hazard **for its own row**: M1 is *"a 141st
item type touching the catalog barrel, item-type-icon, provisioner engine, registry pairing and
browse virtualization … **shared-file work — sequence them, never parallelize.**"* **It does
not know ten more are queued behind it.** This is the largest un-sequenced conflict in the
program and it is a P0 sequencing item, not a design item.

**Arbitration (W0.7):** one **item-type register** with a strict serial order and one declared
owner per slot. No two item-type PRs open concurrently.

### 9.5 Cross-boundary refusal — discovered eight times, implemented zero

Sharing, listings, clean rooms, org spanning, replication, reader accounts, Native App
distribution, Native App event telemetry, agent telemetry, Marketplace fulfilment: **Commercial
↔ Gov does not exist.** Seven lanes each discovered this independently and each wrote its own
footnote. `MATRIX-ai.md` and `MATRIX-ui.md` both, separately, ask for an explicit refusal
rather than an obscure failure at token-exchange time.

**Arbitration (W0.7):** **one** program-level statement and **one** refusal mechanism in
`lib/auth/tenant-boundary.ts`'s neighbourhood, so the product refuses explicitly with a named
reason. `tenant-boundary.ts` already refuses correctly (`MATRIX-ui.md` row 1); the gap is that
nothing routes these ten capabilities through it.

### 9.6 Other overlaps — one owner each, assigned at kickoff

| Capability | Contending lanes |
|---|---|
| Event tables + OTel collector | ops 11–13 (`NEW event-table`) · programmability 51 |
| Trust Center | governance 9–12 · ops 28 · ui 30 · mcpagentic M27 |
| Agent identity (`SERVICE_AGENT` / `IS_AGENT_ACTIVATED`) | mcpagentic M25 · security 13 · governance 17 |
| Statement timeout | compute 22/23 · ops 19 (*"the highest-urgency single change here"*) |
| Query History / Profile / Insights | ops 1–3 · ui 20–24 |
| Copy History | ops 26 · ui 25 |
| Budgets | compute 31–32 · ops 15–17 |
| Snowflake Optima | storage 5–8 · ops 4 |
| QAS | compute 26–28 (build) · ops 37 (monitor) |
| `SNOWFLAKE` shared database roles | security 11 · governance 35 |
| Ingestion runtimes | ui 27 (`connector-runtime`/NiFi) · storage (RisingWave Iceberg sink) · the merged #4024 mirroring lane |

---

## 10. Waves — sequencing, dependencies, and declared file ownership

Parallel safety is a **FILE** property (CLAUDE.md §8). Every work item declares what it owns
exclusively; anything not listed is out of bounds and must be routed through the OMNIBUS
master's cross-lane procedure (§12). **Max useful concurrency is 4** (CLAUDE.md §9 — the
ceiling is review capacity, not compute).

Wave order is **MIGRATION-FIRST**: get the customer's definitions and data **out** first, land
them correctly second, reach parity on the surfaces they will use third, and defer interop to
last.

```
WR  Research completion (3 unmapped domains)  ── runs in parallel with W0/W1 ──┐
                                                                              │
W0  Truth, arbitration & P0 deploy defects ── no deps, START NOW              │
        │                                                                     │
W1  EXTRACTION SPINE  (get definitions + data OFF Snowflake)                  │
        │   W1.1 reader · W1.2 transpiler+assessment · W1.3 MCP M6            │
        │   W1.4 auto-bind ADF · W1.5 loom-mcp over HTTP                      │
        │                                                                     │
W2  LANDING SUBSTRATE  (needs W1.1 for shape, W0.7 for the mart decision)     │
        │   W2.1 delta-file-stats keystone · W2.2 catalog Gov gate            │
        │   W2.3 the ONE usage mart · W2.4 Iceberg federation                 │
        ├──────────────┬───────────────┬───────────────┬────────────────┐     │
W3 Governance     W4 Compute      W5 Ops/cost     W6 Programmability    │     │
   & security        (Gov gaps)      & observ.       & runtimes         │     │
        └──────────────┴───────────────┴───────────────┴────────────────┘     │
        │                                                                     │
W7  AI / Cortex in-boundary substitution   (needs W2.2 + the W7.0 chokepoint) │
        │                                                                     │
W8  Snowsight surfaces  (needs W3–W7 backends; UX baseline throughout)        │
        │                                                                     │
W9  Interop deepening · wire-compatible endpoint · DR · sharing ◄─────────────┘
    (decision ② puts wire-compat here; ingestion/sharing/dialect items gated on WR)
```

---

### WR — Research completion · parallel with W0/W1 · 3 lanes · **gates W9 and §8**

Purely investigative; produces matrices, changes no code.

| ID | Work item | OWNS (exclusive) | Rules |
|---|---|---|---|
| **WR.1** | **Ingestion & pipelines matrix.** Must cover §8.1 Streams/`CHANGE_TRACKING`/`CHANGES`, §8.2 Snowpipe Streaming, §8.3 the full stage/format/`COPY INTO`/`VALIDATE`/unload surface, directory tables, Kafka + Spark connectors, Openflow, tasks & task graphs, `dbt Projects on Snowflake` as an **object** | `PRPs/active/snowflake-parity/MATRIX-ingestion.md` *(new)* | `cloud-parity` (5 verdicts, no blanks), `deploy-integrity` R7 |
| **WR.2** | **Sharing, collaboration & marketplace matrix.** `SHARE` object, `GRANT … TO SHARE`, share-level secure views, listings (private/organizational/monetized), data exchanges, auto-fulfillment, reader accounts, provider usage telemetry, **Data Clean Rooms** (§8.4 — the missed Gov argument) | `PRPs/active/snowflake-parity/MATRIX-sharing.md` *(new)* | `cloud-parity`, and §9.5's refusal must be a row |
| **WR.3** | **SQL dialect, APIs & ecosystem matrix.** The §8.6 inventory: every dialect construct with a **per-engine** target column (Synapse dedicated / Synapse serverless / Trino / DuckDB / Spark), `VARIANT`/JSON models, collation, NULL ordering, `GEOGRAPHY`/`GEOMETRY`/H3, `MATCH_RECOGNIZE`, `QUALIFY`, `PIVOT`, `FLATTEN`, `RESULT_SCAN`, unstructured data + scoped URLs; **plus** the SQL REST API, all drivers, SnowSQL, the `snow` CLI, and the `snowflake.core` management API surface | `PRPs/active/snowflake-parity/MATRIX-dialect.md` *(new)* | decision ② — this matrix **is** the transpiler's scope statement |

**Acceptance (measurable):** three files exist; each states its row count, its
built/partial/missing/cannot-match tally, and five boundary verdicts per row with **zero
blanks**; each cites `file:symbol` evidence or the search that returned nothing for every
`missing`; each carries a corrections section re-measuring its research input. §2's
consolidated tally is regenerated to include them and the **new** total is stated.

---

### Wave 0 — Truth, arbitration & P0 deploy defects · no dependencies · up to 4 lanes

| ID | Work item | OWNS (exclusive) | Rules |
|---|---|---|---|
| **W0.1** | Re-grade the Gov-parity column in the Snowflake migration mapping: **Databricks SQL Warehouses are not available in `usgovva`/`usgovaz`**; the Gov answer is the Synapse dedicated pool with the §7.5 concurrency ceiling stated as a number. This guide currently marks those rows **"GA"** | `docs/migrations/snowflake/feature-mapping-complete.md` | `cloud-parity`, `no-vaporware` (docs are product) |
| **W0.2** | Correct the FedRAMP / boundary claims per §7.1: Snowflake **is** on Azure Gov at FedRAMP High Plus + ITAR; its **IL5 offering is AWS GovCloud only**; the EOL notice attaches to the older `usgovvirginia` deployment. Replace "Snowflake isn't in Gov" wherever it appears with the four defensible differentiators | `docs/migrations/snowflake/federal-migration-guide.md`, `docs/migrations/snowflake/why-azure-over-snowflake.md` | `deploy-integrity` R7 |
| **W0.3** | **Delete `conditional-access.bicep`'s stale "SPNs cannot create CA" claim** (line ~11) and replace it with the verified Graph application-permission path. One comment; it currently makes **five** `MATRIX-security.md` rows read as impossible | `platform/fiab/bicep/modules/admin-plane/conditional-access.bicep` | `cloud-parity`, `deploy-integrity` R7 |
| **W0.4** | **Delete `il5.bicepparam`'s "Front Door not IL5-certified" comment** (line 8) and re-decide `frontDoorEnabled` (line 419) against §7.5. If it stays false, the reason must be a real one, stated | `platform/fiab/bicep/params/il5.bicepparam` **(declared edit window — §12)** | `cloud-parity`, `deploy-integrity` R7 |
| **W0.5** | **Fix the `loom-mcp` naming collision (§5.3), in ONE coordinated PR.** Rename the mis-mapped image target to `loom-azmcp` (it *is* Azure.Mcp.Server), add a genuine `loom-mcp` target from `./apps/loom-mcp`, and **repoint the Container App in the same change or the roll crash-loops** | `.github/workflows/build-fiab-images.yml`, `.github/workflows/build-fiab-images-acr-tasks.yml`, `platform/fiab/bicep/modules/admin-plane/main.bicep` **(declared edit window)** | `deploy-integrity` R1/R2 |
| **W0.6** | **Establish the boundary truth table, once, program-wide (§7.2, §7.3).** For each of ACA, AKS, Purview, Managed Grafana, ADX, AOAI, AI Search, Front Door, Postgres Flexible, Cost Management: audit scope at FedRAMP High / IL2 / IL4 / IL5WI / IL6 **and** US DoD Central/East, each with a fetched URL and a date. Declare which reading "DoD" means for this program. **Fix `il5.bicepparam:121`'s comment**, which conflates regional GA with IL5 authorization | `docs/fiab/boundary-service-matrix.md` *(new)*, `platform/fiab/bicep/params/il5.bicepparam` **(sequence with W0.4)** | `cloud-parity` — **BLOCKING for W2–W8's Gov verdicts** |
| **W0.7** | **Arbitrate the five collisions in §9** and publish the decisions: one `resource-monitor` trigger rule + schema; `replication-group` ownership; **the ONE usage mart** (store, primary SQL surface, name); the **serial item-type register** for all eleven proposed types; and the single cross-boundary refusal mechanism | `PRPs/active/snowflake-parity/ARBITRATION.md` *(new)* | CLAUDE.md §8 — **BLOCKING for W2.3, W4, W5** |
| **W0.8** | Stamp the two superseded first-pass matrices, and rewrite §1's coverage table if `WR` lands mid-flight (§15) | `PRPs/active/snowflake-parity/MATRIX-compute-warehouses.md`, `MATRIX-storage-optimization.md` | `csa_loom_stale_audit_items_propagate` |
| **W0.9** | **Re-grade `mirrored-database.md` row 20 on DEPLOYED evidence** — it is graded ✅ on a flag that was inert on the tree the matrices measured. #4024 is now live on Commercial at `4d4fd0b92c`; stamp the grade with that SHA. **Gov remains unverified and must be declared so** | `docs/fiab/parity/mirrored-database.md`, `docs/fiab/parity/mirrored-database-connections.md` | `deploy-integrity` R2/R4 |

**Acceptance (measurable):** `grep -c "GA"` on the compute rows of `feature-mapping-complete.md`
returns the corrected count and **every** Gov cell for a Databricks-backed row reads Synapse or
"not available"; every corrected claim in W0.2/W0.6 cites a fetched URL and a date;
`grep -n "SPNs cannot create CA" platform/fiab/bicep` returns **zero**; W0.5's receipt is a
build run producing **two distinct images** with the Container App resolving to the intended
one; `ARBITRATION.md` states one decision per collision with a named owner;
`mirrored-database.md` row 20 carries the deploy SHA `4d4fd0b92c` and an explicit
*Gov: unverified*.

---

### Wave 1 — **EXTRACTION SPINE** · the migration-first core · needs W0.5 for W1.5 only · 4 lanes

This is where MIGRATION-FIRST cashes out. Everything here serves one sentence: **get a
customer's definitions and data off Snowflake.**

| ID | Work item | OWNS (exclusive) | Rules | Depends |
|---|---|---|---|---|
| **W1.1** | **`loom-snowflake` reader over the Snowflake SQL REST API.** A sibling Container App modeled byte-for-byte on `platform/fiab/bicep/modules/data-plane/loom-migrate-aca.bicep`: `targetScope='resourceGroup'`, one typed config-object bag (ARM 256-param cap), **`external: false`**, **`secrets: []`** (no standing credentials — the BFF resolves each from KV per request), UAMI for ACR pull only, `/health`, `minReplicas: 0`, emits `output fqdn` → `LOOM_SNOWFLAKE_URL`. Reads databases/schemas/tables/columns, warehouses, roles+grants, network/auth/session policies, tags, masking + row-access policies, `OBJECT_DEPENDENCIES`, `ACCESS_HISTORY`. **Default-ON with opt-out** via `loomBackends` | `apps/loom-snowflake/**` *(new)*, `platform/fiab/bicep/modules/data-plane/loom-snowflake-aca.bicep` *(new)*, `.github/workflows/build-fiab-images.yml` **(sequence with W0.5)** | `cloud-parity` (SQL REST **is** FedRAMP High on Azure Gov — this is the parity-compliant path), `auto-bind-by-default`, `no-vaporware` | W0.6 |
| **W1.2** | **Harden the transpiler + assessment on-ramp.** `sql-transpile.ts` already carries `SqlSourceDialect='snowflake'` and an honest unsupported-construct table — extend it against `WR.3`'s inventory as that lands, and wire it to a **migration assessment report** that inventories a customer's account (from W1.1) and scores each object: auto-convertible / needs-review / **cannot match (cite the §6 row)**. dbt project conversion rides the same path | `apps/fiab-console/lib/migrate/sql-transpile.ts`, `lib/migrate/assessment.ts`, `lib/migrate/translate.ts`, `lib/migrate/__tests__/**` | decision ②, `no-vaporware` (a "converted" object that silently changed semantics is worse than a refusal) | — (deepens with WR.3) |
| **W1.3** | **`loom-snowflake` M6 MCP server (stdio first).** Discovery (`databases/schemas/tables/table.describe` incl. `kind:'iceberg'`), `query` with a **Snowflake-specific read-only guard**, `warehouses.list`, `lineage.get`, `grants.list`, `governance.get`, and mirroring `plan`/`apply` as a **thin façade over `mirror-engine.ts`** with apply defaulting **FALSE**. **No `credential.*` tool of any kind.** Inherits `core/tool.ts` unchanged | `apps/loom-mcp/src/servers/loom-snowflake/**` *(new)* | `no-vaporware`, `deploy-integrity` R7, and **#4025's shape is forbidden** | #4024 (met), W1.1 |
| **W1.4** | **Auto-bind the ADF Snowflake linked service — the P0 for the demo.** Creating a Snowflake connection creates the ADF Snowflake linked service itself (name matching the Loom connection, credential referencing the `loom-conn-<uuid>` KV secret through ADF's Key Vault linked-service pattern) **and** the AzureBlobFS sink linked service, then populates the env wiring **from the deploy**. `loomMirrorSnowflakeLinkedService` stops being an operator-supplied pass-through | `apps/fiab-console/lib/install/provisioners/**` *(declared edit window — coordinate with the mirroring seam)*, `platform/fiab/bicep/modules/admin-plane/main.bicep` **(declared edit window)**, `platform/fiab/bicep/params/*.bicepparam` | **`auto-bind-by-default` §5 — this is the rule violation, not a config step**, `ux-baseline` G2 | #4024 (met) |
| **W1.5** | **Serve the five existing `loom-mcp` servers over HTTP — via the bridge, not a new transport.** Register them in `apps/fiab-mcp-bridge`'s `config/loom-mcp-bridge.json` and auto-register hosted `McpServerConfigDoc`s in post-deploy bootstrap. **The security crux:** in stdio, auth resolves once per process; over HTTP one process serves many callers, so `AuthContext` **must** resolve **per request** and the server instance must never be hoisted to module scope. `loom-admin`'s `rejectPat: true` holds over HTTP unchanged | `apps/fiab-mcp-bridge/**`, `apps/loom-mcp/src/transport/**` *(new, only if the bridge genuinely cannot carry it)* | `deploy-integrity` R1 (**M2 is P0**), `cloud-parity` (bridge README: ACA for Commercial/GCC, **AKS for GCC-High/IL5/DoD** — and see W0.6) | W0.5 |

**Acceptance (measurable):**
- **W1.1** — a live browse of a real Snowflake account through the deployed app: database →
  schema → table → describe, with the real response body in the PR, `LOOM_DEFAULT_FABRIC_WORKSPACE`
  **unset**. Plus a Gov receipt from a **GitHub Actions run** (never local `az`).
- **W1.2** — a real customer-shaped Snowflake DDL corpus transpiled, with the report showing
  per-object verdicts and **every** `cannot-match` citing its §6 row number.
- **W1.3** — a real `SELECT` returning rows; a `CREATE TABLE` **refused at parse, never
  dispatched**; a capped result showing `truncated:true` + `cappedBy`; **a failed ADF pipeline
  run surfacing as failed, not `Running`** (the #4025 regression test); a **cross-tenant
  refusal** — caller in tenant A, connection in tenant B → refused, **and refused again when
  the `tid` is absent**, because `unconfirmed` is not a grant.
- **W1.4** — a **clean create**: Snowflake connection created → ADF linked service
  auto-created with the matching name → pipeline running → Parquet landing in ADLS Bronze,
  **with no user binding step**. Plus `grep -rn "LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE" platform/fiab/bicep/params/`
  returning a real value, where it returns nothing today.
- **W1.5** — a live `tools/list` **against the deployed bridge URL**, plus two concurrent HTTP
  callers with different credentials getting **different** authorization outcomes from one
  process, plus the mutation receipt: hoist the server instance to module scope and prove a
  cross-caller test goes **RED**.

---

### Wave 2 — **LANDING SUBSTRATE** · needs W1.1 + W0.7 · 3 lanes

Where the extracted data and definitions land, and the metadata layer everything downstream
reads.

| ID | Work item | OWNS (exclusive) | Rules | Depends |
|---|---|---|---|---|
| **W2.1** | **`delta-file-stats` — the keystone.** `MATRIX-storage.md` names it as the single dependency of clustering depth, pruning prediction, per-table metrics, retention read-back, clone-group detection, staleness triggers and archived-active-set. Parse `add`/`remove` from `_delta_log` keeping `size`, `partitionValues`, `deletionVector` and the `stats` JSON (`numRecords`, `minValues`, `maxValues`, `nullCount`) — today `delta-version-files.ts:83-86` keeps **only the paths**. Hydrate long log tails from `*.checkpoint.parquet` via the deployed DuckDB | `apps/fiab-console/lib/azure/delta-file-stats.ts` *(new)* + tests | `no-vaporware` — **a capped walk must report a lower bound flagged as capped, never a silent truncation**; `deploy-integrity` R7 | — |
| **W2.2** | **Close the Loom Unity Gov gate (§7.4).** `postgresQuotaAvailable=false` in `gcc-high.bicepparam:354` and `il5.bicepparam:397` switches off the metadata store of the catalog that exists **because Gov has no Unity Catalog**. Azure Database for PostgreSQL **is** ✅ at IL5WI, so this is a quota/params decision Loom controls | `platform/fiab/bicep/params/gcc-high.bicepparam`, `platform/fiab/bicep/params/il5.bicepparam` **(sequence with W0.4/W0.6)** | **`cloud-parity` — this is a live violation on the capability whose Gov value is highest** | W0.6 |
| **W2.3** | **Build the ONE `ACCOUNT_USAGE` mart** per W0.7's arbitration (§9.3). Land attribution rows, query history, metering and grants into Delta on ADLS, register in `loom-unity`, expose Snowflake's own view names. **Must honest-gate when ADX is stopped** — the standing estate-pause mandate is not negotiable | `apps/fiab-console/lib/warehouse/usage-mart.ts` *(new)*, `platform/fiab/bicep/modules/admin-plane/usage-mart-job.bicep` *(new)* | `cloud-parity`, `no-vaporware`, decision ① (do not force a day-one SQL rewrite) | **W0.7**, W2.1 |
| **W2.4** | **Iceberg federation over copying.** For Snowflake **Iceberg** tables, read in place through the Iceberg REST catalog into `loom-trino` — no duplication, no staleness window, no egress, **and Gov-viable** because it is engine-level and not Cortex-dependent. Loom already has `iceberg-catalog-client.ts`, `app/api/catalog/iceberg/connect/route.ts` and `iceberg-catalog-aca.bicep`. **Grade the v3 row ⚠️** with the engine-version constraint named (§7.5) | `apps/loom-trino/**`, `apps/fiab-console/lib/azure/iceberg-catalog-client.ts` | `no-fabric-dependency`, `cloud-parity`, `deploy-integrity` R7 | W1.1, W1.3 |

**Acceptance:** a clustering-depth JSON emitted from a **real** `_delta_log` whose
`average_depth` is independently recomputed by hand on a small table and matches; a Gov
Actions run showing `loom-unity` with a live Postgres metadata store; the usage mart queried
through **both** its SQL and KQL surfaces with a recorded honest gate when ADX is paused; a
Snowflake Iceberg table read **in place** with a row count matching Snowflake's own.

---

### Waves 3–6 — domain parity · mutually independent · needs W2 + W0.6 + W0.7

Each of these is scoped by its matrix and is a shippable increment on its own. **Their
detailed row-level content is in the matrices and is not restated here** — that is the point
of having them.

| Wave | Matrix | Start here (the matrix's own stated ordering) | Hard blockers |
|---|---|---|---|
| **W3 — Governance & security** | [`MATRIX-governance.md`](./MATRIX-governance.md) (36) · [`MATRIX-security.md`](./MATRIX-security.md) (41) | Security: **the role plane (rows 1–4) + the `SHOW ROLES`/`SHOW GRANTS` importer first** — nothing else in the domain has a principal model to attach to. Then the Conditional-Access family (network + auth + MFA + session), unblocked by W0.3. **Keycloak is one XL component serving three rows — one decision, not three.** Governance: `13→4`, `5+7 ship together`, `10→8`, `9→24`, `28→3(a)`, and **row 27 is P0** | W0.3, W0.7 (agent identity owner), W2.3 |
| **W4 — Compute & warehouses** | [`MATRIX-compute.md`](./MATRIX-compute.md) (48) | Rows **1, 9, 38** are the substrate (one size ladder, a probe-backed shape catalog, one published service taxonomy) and every other row reads from them. Then the **highest-value Gov rows: 16 (`AUTO_SUSPEND` — the Gov warehouse never auto-pauses at all today) and 17 (`AUTO_RESUME` on the query path)**. Row 42 (tagging — the Gov/Synapse path sends **no tags at all**) blocks 29/31/32. Row 7 blocks 30. Row 26 blocks 27+28. Row 24 has the largest blast radius and ships **last** | **HYP-11** (`apps/loom-capacity-broker/README.md:14` — the broker is not wired into the engine job-submit choke points, so five capabilities are decorative), W0.7 (`resource-monitor`), §7.5's concurrency arithmetic |
| **W5 — Ops, cost & observability** | [`MATRIX-ops.md`](./MATRIX-ops.md) (37) | **Row 7 (the usage mart) is the spine — but it is W2.3 now, arbitrated.** Row 7's Event Hubs namespace must be **deployed by bicep, not requested** (`workspace-monitor.ts:313` ships seeded tables with a dead feed). **Row 19's derived-timeout fix is the highest-urgency single change in the domain** — a migrating user's long statement dies at 60 s against a Snowflake default of two days. Row 17 step (1) is a standalone S-effort defect fix unblocking 16 and 18 | W2.3, HYP-11 (rows 18/19), W0.7 (`replication-group`) |
| **W6 — Programmability & runtimes** | [`MATRIX-programmability.md`](./MATRIX-programmability.md) (51) | Rows **4 (code inventory) and 3 (checkpoints)** first — they are the migration on-ramp under decision ①. Then rows **18 (`stage://`), 44 (packaged runtime), 25 (workload profiles)** as the substrate unblocking the most downstream rows. **Rows 2, 22, 29 are interop and belong in W9** per decision ②. **Three live rule violations land in the same PRs as their family:** row 44 (`auto-bind`), row 11 (`no-vaporware` — "Python (or C#)" where only Python runs), rows 25+47 (`cloud-parity` — `ACA_WORKLOAD_PROFILES` assigned in **no** params file) | **Trust-tier separation is a prerequisite, not a follow-on** for rows 36/42/26: `container-platform.bicep:243` has no ingress rule separating siblings, so third-party code and images need separate environments or AKS NetworkPolicy first |

**Acceptance per wave:** the wave's matrix rows it claims are re-graded with a **real backend
receipt per row**, per boundary, and the wave's parity docs (`docs/fiab/parity/<slug>.md`) show
**zero ❌**. Named examples: a Gov Actions receipt showing a dedicated pool that auto-paused on
idle and **auto-resumed on a query with a served result** (not a status field); an ARM tag
read-back on a Gov `sqlPool` showing the Loom stamps; a `KILL` that terminated a real running
request id; a negative RBAC test where a principal with `USAGE` and not `MODIFY` is refused a
resize **and the refusal names which plane refused**; a monitor bound to two named warehouses
that **denies admission** at 100% naming the quota, the consumption and the reset time.

---

### Wave 7 — AI / Cortex substitution in-boundary · needs W2.2 · 2 lanes

[`MATRIX-ai.md`](./MATRIX-ai.md) (41 rows). **This is the strongest sovereign differentiator in
the program** (§7.1) and it has one blocking prerequisite the matrix itself names.

| ID | Work item | OWNS (exclusive) | Rules |
|---|---|---|---|
| **W7.0** | **The engine chokepoint — build this BEFORE the first AI UDF ships.** `MATRIX-ai.md` §9: rows 2, 3, 4, 7, 8, 9, 10 and 13 all add functions calling AOAI or AI Search from inside `loom-trino` / `loom-duckdb`. Those containers **do not import `token-budget.ts` and do not pass through `resolveAoaiTarget`.** Unless the engines are **structurally unable** to obtain a model token without a Loom policy/budget check, rows 16, 21, 33 and 34 are decorative for anyone who can write SQL. Retrofitting after eight functions exist is how it ends up conventionally called instead of structurally required | `apps/loom-trino/**`, `apps/loom-duckdb/**`, the AOAI token broker | `no-vaporware`, `cloud-parity` |
| **W7.1–n** | The 41 rows, in the matrix's own order. **Databricks `ai_*` push-down is a Commercial/GCC accelerator, never the default** — that inversion is what makes the sovereign verdicts hold. Correct row 15's Traffic Manager mechanism per §7.5 (**region selection in the BFF**). Make the **GPU decision once, explicitly** (§13 item 5) rather than three times inside three rows | `apps/fiab-console/lib/azure/ai-*.ts`, `lib/copilot/**` *(coordinate with OMNIBUS L6)* | `no-fabric-dependency`, `cloud-parity`, `ux-baseline` |

**Acceptance:** a mutation receipt proving an engine **cannot** obtain a model token without
the policy check — break the chokepoint and a test goes RED; an NL→SQL answer produced
**entirely in-boundary** on a Gov Actions run with the model endpoint named and no
cross-region inference; every AI surface stating which engine and which model tier produced
its answer.

---

### Wave 8 — Snowsight surfaces · needs W3–W7 backends · up to 4 lanes

[`MATRIX-ui.md`](./MATRIX-ui.md) (40 rows, 0 built, 31 partial). **Zero rows are wholly
unmatched, but 13 carry a named cannot-match component (⛔) and those are the real content.**
The matrix ranks them by how early a migrating user hits them; W8 ships them in that order
(Query Profile → Snowgrid → micro-partition telemetry → resume latency → transactional DDL →
exactly-once → cross-boundary → NiFi → exchange → partner ecosystem → org span → support
attachments → foreign catalog transactions).

Every surface is graded on `ux-baseline.md` §7 and `ui-parity.md`. **G1 in-browser E2E is the
completion evidence; `tsc` + `vitest` are not.** Boundary tally to hold to: Commercial 38 ✅,
GCC 17 ✅ / 23 ⚠️, GCC-High 12 ✅ / 27 ⚠️ / 1 ❌, IL5 12 ✅ / 28 ⚠️, DoD 11 ✅ / 27 ⚠️ / 2 ❌ —
**every ⚠️ names its substitute in-cell or the row is not done.**

**Acceptance:** per surface, a screenshot (dark **and** light for canvases), a click-walk
receipt on every control, a live side-by-side against the real Snowsight page, and
`docs/fiab/parity/<slug>.md` with zero ❌ — plus a **narrow-width pass for badge overlap** and
a **first-open pass on a freshly created item** (no red banners on an untouched new item).

---

### Wave 9 — Interop deepening, wire compatibility, DR & sharing · **LAST, by decision ②**

Gated on `WR.1`/`WR.2`/`WR.3` for the ingestion, sharing and dialect halves.

| ID | Work item | Notes |
|---|---|---|
| **W9.1** | **Snowflake-wire-compatible endpoint.** Existing drivers and BI tools connect to Loom unchanged. **This is where decision ② puts it — after the parity substrate exists**, and its scope is `MATRIX-dialect.md`, which does not exist yet |
| **W9.2** | **Register the Snowflake-managed MCP server** as an external `McpServerConfigDoc` — Commercial-only, opt-in, with the Gov substitution documented. Needs: a `lib/mcp/catalog.ts` entry under `REMOTE_BUILTIN_MCP` (same shape and opt-in discipline as the existing Power BI remote server), `authMethod:'key-vault'` with purpose `mcp-server-credential` (which already exists), an `LOOM_MCP_EGRESS_ALLOW` suffix for the account host, a gate-registry entry per G2, and **one** small typed addition to `mcp-client.ts`: send `X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN` when the credential is a PAT. **Also add the missing `oauth2-cc` auth mode** — `key-vault` today resolves only a static Bearer. **Surface PAT expiry** (default **15 days**, max 365, **immutable at creation** — rotation means revoke + reissue) on the connection card, or a demo dies silently at day 15 |
| **W9.3** | **DR runbook + `replication-group`** per W0.7's arbitration. Per-plane RPO/RTO stated **separately** for data (ADLS GRS + object replication), compute (re-materialize from spec) and catalog (Unity/Purview sync), plus the `restoreToNewPool` rebind path — **failover changes the pool name and every binding that referenced it**. RPO/RTO from a **real failover drill per boundary**, never from the design. In-boundary only |
| **W9.4** | **Sharing & marketplace** — scope is `MATRIX-sharing.md` (WR.2). Includes the **Data Clean Room** opportunity (§8.4) |
| **W9.5** | **Ingestion & pipelines** — scope is `MATRIX-ingestion.md` (WR.1). **Streams (§8.1) is the row that matters most and its §6 entry must be written before any code**: Delta CDF is an at-least-once watermark, not a transactional offset, and every migrated `MERGE … FROM stream` needs idempotency it did not previously need |

---

## 11. Definition of done — per wave, binding

A wave is done only when, for **every** item in it:

1. **Real backend, per boundary.** Works against real Azure services in Commercial **and** in
   Gov, or carries an honest gate naming the exact remediation with an inline **Fix it** and a
   gate-registry entry (G2 — the registry is **built**, 10 modules, so this is available
   today). **A `govViable` claim that names a Databricks SQL or Unity Catalog call is rejected
   by rule.**
2. **G1 receipts on both estates.** Live in-browser E2E with real data. `tsc` + `vitest` + DOM
   strings are **not** completion evidence. **Gov evidence comes from a GitHub Actions run
   in-boundary — never local `az`.** Commercial green proves nothing about Gov.
3. **Bicep sync.** Every resource, env var and role assignment in `platform/fiab/bicep/**`
   **plus params for every cloud profile**. `ACA_WORKLOAD_PROFILES` declared in code and
   assigned in zero params files is the live example of what this catches. Where a compiled ARM
   artifact exists it is regenerated in the same PR.
4. **Guards mutate RED.** Every guard this program introduces is shown red on a deliberately
   broken subject. **Invent a mutation the author did not try** — a narrow bypass (one
   itemType, one cursor, one page) passes a large suite while a broad one goes red instantly.
   A guard whose verdict does not change when you break it is not watching.
5. **Parity doc.** `docs/fiab/parity/<slug>.md` with the Snowflake feature inventory grounded
   in Snowflake's own docs, Loom coverage, and the backend per control. **Zero ❌** before
   A-grade.
6. **The semantic delta is stated ON THE SURFACE**, not in a footnote, for every §6 row the
   wave touches. Under decision ③ this is the contract, and hiding a day-one behavioural
   difference is the failure mode this whole document exists to prevent.
7. **One engine versus five is stated once, and referenced.** Copy-history "rows loaded",
   pruning percentage, query-profile attribution, metering units, warehouse cache,
   `ACCOUNT_USAGE` freshness, fallback dialect and resource-monitor signal are re-derived as
   separate semantic deltas across 30+ rows. **They are one fact: Snowflake has one engine with
   one definition of everything; Loom has five and must show which produced each number.**
   `MATRIX-ui.md` row 25 says it best. State it once as the program's central honest claim and
   let every row point at it.

---

## 12. Cross-program conflicts — MUST be sequenced

**① OMNIBUS `PRPs/active/omnibus-2026-08-22/` owns most of what this PRP wants to touch.**
L6 owns `apps/fiab-console/lib/azure/**` and `apps/loom-*/**`; L3/L4/L5 own
`apps/fiab-console/app/**`; L1 owns `lib/auth/**`. **Register every work item here against the
OMNIBUS master at kickoff and take a declared ownership transfer** — never edit across the
boundary silently; that is how a family gets half-fixed. Specifically:

- **W1.1, W1.3, W1.5, W2.4, W7.0** need `apps/loom-*/**` → **L6**.
- **W1.2, W2.1, W2.3, W7.1** need `lib/azure/**` or `lib/migrate/**` → **L6**.
- **W3's role plane** needs `lib/auth/**` → **L1**, a Wave-0 blocking lane.
- **W0.4, W0.5, W1.4, W2.2, W2.3** need a declared edit window on
  `modules/admin-plane/main.bicep` and/or the params files, which are **also** contested by the
  estate-pause PRP and by OMNIBUS L0. **Only one may hold it at a time.**

**② The estate-pause-resume PRP shares W4's `AUTO_SUSPEND` subject.** Both want the Synapse
dedicated pool paused when idle. **Reconcile before either builds.** This program's position:
`synapse-auto-pause.bicep` should be **deleted rather than fixed** — its own header records
(measured 2026-08-22, re-verified) that it has **never deployed on any shipped params file**
because `deployLandingZones = topology != 'tenant'` and every params file pins
`topology='tenant'`; and ACA Jobs (or AKS CronJobs at IL5 — see §7.2) are the pattern that
works where Logic Apps Consumption is thin. **A module whose header records that it never
deployed makes an unshipped capability look shipped.**

**③ ADX is under the standing estate-pause mandate.** `MATRIX-ops.md` makes ADX the spine of
nine rows and does not account for it. A stopped ADX cluster also produces
`ClusterNotValidForPrincipals` on bicep What-If — check before paying to make a lane green.

**④ Merge treadmill.** Branch protection is `strict` with 15 required contexts and the console
`vitest` suite runs ~34 minutes, so **N PRs cost N CI cycles.** Batch by shared file, serialize
merges deliberately, and check `vitest (node 20)` has not concluded SUCCESS **having executed
nothing** for the PR's own changed files. Runner capacity becomes the ceiling past ~10 cycling
PRs.

**⑤ Local HEAD is not `main`.** The tree these matrices measured (`9a888b58d6`) is **9 commits
behind** `origin/main` (`4d4fd0b92c`) and on a feature branch. Any agent re-measuring a
"missing" claim must `git fetch` and check `origin/main`, or it will re-derive stale findings —
`snowflake-adf.ts` and `mirror-adf-copy.ts` do not exist locally and **do** exist on main.

---

## 13. Not yet decided — needs an operator call

**Decisions ①, ②, ③ in §3 are settled and are NOT open.** These are.

1. **Which Snowflake deployment is the target account on?** §7.1 establishes that the EOL
   notice attaches to the older `usgovvirginia` deployment, **not** the FedRAMP High Plus one.
   **Which deployment a given account sits on was not confirmed.** Confirm before any Gov
   migration commitment — one deployment is decommissioned at the beginning of 2027.
2. **Is Azure Container Apps acceptable at IL5?** §7.2. Microsoft's audit-scope table does not
   list ACA at IL4 or IL5WI; the repo's `il5.bicepparam:121` comment assumes regional GA is
   sufficient. **If ACA is out at IL5, AKS is the design and the ~$0-idle economics that
   several matrices lean on do not exist there.** *Recommendation: verify first, then either
   accept the risk explicitly in writing or make AKS the IL5 default — but do not leave the
   conflation in a bicep comment where eleven lanes inherit it.*
3. **Does "DoD" mean US Gov regions at IL5WI (150 services) or US DoD Central/East (60)?**
   §7.3. Under the second reading essentially every DoD ✅ in seven matrices fails.
   *Recommendation: US Gov regions at IL5WI, stated once program-wide, with a named IL6 gap.*
4. **Does Loom adopt an edition concept?** §8.7. Snowflake gates DCR provider on Enterprise,
   multi-cluster/QAS/Adaptive on Enterprise, replication on Business Critical; **every matrix
   silently assumes top tier.** *Recommendation: no editions — but then say so in the migration
   docs, because a customer migrating off Standard will otherwise be quoted parity for features
   they never had.*
5. **GPU: build a node pool or accept the ceiling?** `MATRIX-ai.md` §9: there is **no GPU node
   pool anywhere in `platform/fiab/bicep`**, and rows 5, 11 and 40 all assume one or accept a
   CPU throughput ceiling. Adding an AKS GPU pool breaks the ~$0-idle property. **One explicit
   decision, not three inside three rows.**
6. **Is the Synapse dedicated pool an acceptable permanent Gov substrate?** Microsoft lists
   Synapse Analytics as In Support with **no announced retirement date** (this is **not** a
   deprecation claim), but its published forward path is migration to **Fabric Data Warehouse**,
   which `no-fabric-dependency.md` forbids Loom from depending on. Betting the entire sovereign
   compute story on that product deserves a named decision, not silence.
7. **Serve `SYSTEM$`-named SQL functions?** Intercepting `SYSTEM$CLUSTERING_INFORMATION` in the
   query BFF gives literal migration compatibility — a migrated dashboard just works. It also
   invites users to assume full Snowflake semantics for every argument form. *Recommendation:
   serve them, and reject unsupported argument shapes explicitly rather than guessing.* Note
   this is adjacent to decision ② and should not be allowed to become wire-compatibility by
   accretion.
8. **`loom-duckdb` replica floor.** Three designs want three incompatible things: interactive
   routing wants scale-to-zero; attached tables need `minReplicas ≥ 1` for a warm set; the
   warehouse-local cache wants a persistent volume that defeats scale-to-zero. **A standing-cost
   decision that blocks the interactive tier.** *Recommendation: `minReplicas: 1` only for
   warehouses explicitly marked interactive — the cost is then attributable to a user choice.*
9. **Scope acceptance for four zero-parity domains.** Security 0/41, programmability 0/51,
   ui 0/40, mcpagentic 0/30. That is an honest read and the lanes defend it well — but it means
   **the program has no baseline in four whole domains**, and that deserves an explicit
   operator scope decision before any wave beyond W0–W2 is committed.
10. **Widen `synapse.bicep`'s `@allowed` past `DW1500c`?** Required for Gov to reach the upper
    tiers at all, and it exposes SKUs that can burn five figures a day to a declarative apply
    with no human gate. *Recommendation: widen only after the arbitrated `resource-monitor`
    lands, paired with a plan-diff that marks a SKU change destructive.*

---

## 14. Non-goals

- **Not** re-specifying the Snowflake mirroring lane. PR #4024 is merged and live on
  Commercial; issue **#4025** owns the polling defect. This PRP **consumes** those seams
  (§5.1) and forbids inheriting #4025's shape (§5.2).
- **Not** re-scoping the MCP work as greenfield (§5.3). `apps/loom-mcp` is a mature five-server
  package with a shared security core. The gap is **stdio-only + never deployed + a name that
  points at a different artifact**.
- **Not** a Snowflake API compatibility layer *yet*. Decision ② puts the wire-compatible
  endpoint in W9, and its scope statement (`MATRIX-dialect.md`) does not exist.
- **Not** emulating Snowflake's billing. Azure bills; Loom meters (§6 rows 1, 3). Reproducing
  the 10% cloud-services credit would be fabricating a discount Loom cannot fund.
- **Not** claiming Snowflake is absent from Azure Government (§7.1). It is present at FedRAMP
  High Plus + ITAR. The honest differentiators are **IL5-on-Azure, Data Clean Rooms, Cortex
  in-boundary, and Unity Catalog absence** — not presence.
- **Not** mechanism parity. Decision ③. Micro-partition internals, Fail-safe and Snowgrid
  internals are explicitly out of scope; the deliverable is the named difference.
- **Not** committing W9 or the ingestion/sharing/dialect items until `WR` closes (§1).
- **Not** re-litigating the estate pause/resume design. W4 consumes its outcome (§12 ②).

---

## 15. Housekeeping — do these or they cause a re-learn

1. **Two superseded first-pass matrices are still in this directory:**
   `MATRIX-compute-warehouses.md` (2026-08-24 19:55) and `MATRIX-storage-optimization.md`
   (19:56), versus the second-pass files at 23:52–00:02. `MATRIX-compute-warehouses.md` carries
   **pre-correction claims that `MATRIX-compute.md` explicitly overturns.** Delete them or stamp
   them **SUPERSEDED** — W0.8. §7.1 is the proof that corrections in this program *do* come
   back.
2. **The previous PRP's §11 coverage table is wrong in both directions** and is the artifact a
   reader trusts. It is replaced by §1 here. If a stale copy survives anywhere, delete it.
3. **`MATRIX-governance.md` has a one-row discrepancy** — its header and its own Tally both say
   36 rows (7+13+15+1), while a mechanical parse of its eight tables finds 35. §2 uses the
   matrix's self-declared 36. Reconcile at W0.8 so the consolidated total is defensible.
4. **`MATRIX-mcpagentic.md`'s roll-up (0/23/7) and a mechanical parse (0/24/6) differ by one
   row.** §2 uses the self-declared roll-up. Same treatment.
5. **`docs/migrations/snowflake/` already ships 16 guides** — including
   `streams-tasks-migration.md` (541 lines), `data-sharing-migration.md` (385) and
   `warehouse-migration.md` (406) — covering **exactly the three domains that produced no
   matrix**. Those docs were written before this program and **have not been validated against
   it.** `WR.1`/`WR.2` must read them first: they are either a head start or a live
   `no-vaporware` liability, and nobody has checked which.
6. **`apps/fiab-mcp-config/README.md:6` still says "Status: SCAFFOLDED"** over a deployed
   container, and `apps/loom-mcp/README.md` carries two contradictory status tables. Fix both
   with W0.5.
