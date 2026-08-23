# PRP — Custom bridge services (loom-sql-gateway / loom-onesecurity / loom-gitsync / loom-pulse)

> **Title:** Loom Bridge Services — four custom-built, Loom-native control-plane services that close
> the last *coherence* gaps between Loom and Microsoft Fabric — a single SQL endpoint, a single policy
> truth, a single Git spine, and a single event backbone — all Azure-native, no real Fabric dependency.
> **Date:** 2026-07-10
> **Status:** proposed
> **Owner:** Loom Bridge / Platform-Substrate Architect
> **Sources consulted:** direct code review of `apps/fiab-console/lib/**` with file evidence —
> SQL/engine clients (`synapse-sql-client.ts`, `synapse-livy-client.ts`, `kusto-client.ts`,
> `databricks-client.ts`, `lakebase-databricks-client.ts`, `sql-access-mode.ts`,
> `sql-user-token-store.ts`, `azure-sql-client.ts`), the result-cache tier (`query-cache.ts`,
> `query-result-cache.ts`, `redis-cache-client.ts`), the PDP policy engine (`lib/auth/pdp/evaluate.ts`
> pure decision-algebra compiler + `lib/auth/pdp/enforce.ts` default-**shadow** gate) and its targets
> (`onelake-security-client.ts`, `onelake-rls-reconciler.ts`, `synapse-permissions-client.ts`,
> `kusto-rls-predicate.ts`, `protection-policy-client.ts`), the Git spine (`git-integration-client.ts`
> already serializing items to Fabric-style item folders against ADO/GitHub REST with a KV-stored PAT +
> `lib/components/deployment/deployment-pipelines-pane.tsx` + `app/api/deployment-pipelines/**`), the
> event spine (`business-events-store.ts` governed event-type registry, `eventgrid-client.ts`,
> `eventgrid-topics-client.ts`, `eventhubs-client.ts`, `activator-client.ts`,
> `activator-trigger-model.ts`), the task-flow **Run engine**
> (`app/api/workspaces/[id]/task-flows/[flowId]/run/route.ts` + `lib/taskflow/step-runner.ts` +
> `lib/taskflow/launch-item.ts` — merged PR #1816), publish-as-api
> (`app/api/thread/publish-as-api/route.ts`); the deployable-service template
> `platform/runners/script-runner/**` + `platform/fiab/bicep/modules/admin-plane/script-runner-app.bicep`;
> the H-band shared substrate `platform/fiab/bicep/modules/compute/hband-shared.bicep` + `docs/fiab/hyperscale.md`.
> **Governing rules (die-hard, non-negotiable):** `.claude/rules/no-fabric-dependency.md` (Azure-native
> is the DEFAULT; none of these four services ever call `api.fabric.microsoft.com` /
> `api.powerbi.com` / `onelake.dfs.fabric.microsoft.com` on any default path — Fabric is opt-in only,
> never a gate), `.claude/rules/no-vaporware.md` (real backend + a real-data E2E receipt per merge),
> `.claude/rules/ui-parity.md`, `.claude/rules/ux-baseline.md`, `loom_no_freeform_config`,
> `loom_design_standards`. Dual-cloud (Commercial + Government GCC/GCC-High/DoD IL4-5) mandatory.
> Default-ON / opt-out per the WAVES.md global principle.
> **Relationship to the H-band:** these are the **control-plane** siblings of the Hyperscale
> *data-plane* substrate services (`PRPs/active/next-waves/PRP-loom-hyperscale-custom-components.md`).
> Where the H-band owns *storage namespace / columnar cache / compute admission*, this band owns
> *query routing / policy compilation / source-of-truth Git / event flow*. Both follow the identical
> standalone-service pattern (internal-ingress ACA + dedicated least-privilege UAMI + honest-503 BFF
> gate + default-OFF env wiring). See `docs/fiab/hyperscale.md`.

---

## 1. Executive summary — the coherence gap

Loom is Fabric-class on **features**: every item type, editor, and object runs 100% Azure-native with
no Fabric capacity, no OneLake, no Power BI workspace. The H-band closes the three *structural*
substrate gaps (unified namespace, columnar cache, compute broker). What remains between Loom and
Fabric after that is not features and not substrate — it is **coherence**: the property that the whole
estate behaves like *one* system with one front door, one policy truth, one version-control spine, and
one nervous system, rather than a federation of well-wrapped Azure services.

Fabric gets this coherence for free because it is a single SaaS. Loom, being customer-owned Azure,
reproduces each coherence property today as **per-item glue** invoked from BFF routes. This band
promotes four of those glue layers to owned control-plane services:

1. **One SQL front door.** In Fabric a single SQL connection string (the "SQL analytics endpoint") lets
   any tool query a lakehouse, a warehouse, a KQL database, or a mirrored database through one endpoint
   with one auth. Loom today exposes each engine through its own client
   (`synapse-sql-client.ts` / `kusto-client.ts` / `databricks-client.ts` / `lakebase-databricks-client.ts`)
   from per-item routes — a BI tool must know *which* engine backs *which* item and connect to each
   separately. **loom-sql-gateway** becomes the single Entra-authenticated SQL endpoint (HTTP query API,
   then TDS) that resolves the target item from the Loom catalog, routes to the right engine, enforces
   policy pre-flight, optionally serves from cache, and meters to the broker.

2. **One policy truth.** Loom already has a *pure decision engine* — `lib/auth/pdp/evaluate.ts` composes
   a single allow/deny + obligation set from workspace roles, item shares, OneLake security roles,
   RLS/CLS, and protection policies — and it runs **default-shadow** (`enforce.ts` evaluates every
   request and audits it but does not block until an operator flips `LOOM_PDP_ENFORCE=enforce`). But the
   *outbound* projection of that policy onto the physical engines is scattered
   (`onelake-rls-reconciler.ts`, `synapse-permissions-client.ts`, `kusto-rls-predicate.ts`). **loom-onesecurity**
   becomes the policy **compiler**: it takes the one Loom policy model and continuously compiles +
   reconciles it down to ADLS POSIX ACLs, Synapse SQL GRANTs, Databricks UC grants, and ADX row-level
   policies, with drift detection + repair and an audit of every compilation. It *promotes* the
   shadow-mode PDP from "decide + log" to "decide + enforce everywhere, physically."

3. **One Git spine.** `git-integration-client.ts` already serializes every workspace item to a canonical
   Fabric-style item folder (`<displayName>.<ItemType>/`, TMSL/PBIR/JSON) and commits to Azure DevOps or
   GitHub — but only on an explicit user action, one way, no promotion flow. **loom-gitsync** becomes the
   always-on Git service: commit-on-save (batched), import/clone a workspace *from* Git, bidirectional
   sync with conflict surfacing, and PR-based promotion between workspaces (dev→test→prod) driven by the
   existing `deployment-pipelines` mapping.

4. **One nervous system.** Loom has the *pieces* of an event fabric — `business-events-store.ts` governs
   event *types*, `eventgrid-client.ts` / `eventhubs-client.ts` publish, `activator-client.ts` +
   `activator-trigger-model.ts` react, and the task-flow **Run engine** can already execute any runnable
   item — but nothing publishes the *platform's own* lifecycle (item created / updated / run-started /
   run-failed / data-landed) onto one bus that a rules engine watches. **loom-pulse** becomes that unified
   event backbone: every item/system event to one internal bus, a rules engine (extending the Activator
   model) that can trigger *any* item run via the Run engine, plus notification and webhook sinks.

Each is a **standalone deployable** modeled on `platform/runners/script-runner` (internal-ingress ACA,
dedicated least-privilege UAMI, `az acr build` server-side image, honest-503 BFF gate naming the missing
env var + bicep module, env bicep-synced into `admin-plane/main.bicep` `apps[]`), and each **builds on**
a real existing seed rather than starting from zero.

**Honest framing (the whole band is graded against this):** we chase **coherence outcome-equivalence**,
not SaaS-mechanism parity. loom-sql-gateway is a routing/auth/policy proxy, not a new SQL engine;
loom-onesecurity is a compiler over the customer's own RBAC/ACL substrate, not a novel identity plane;
loom-gitsync mirrors Fabric Git integration on ADO/GitHub, not a bespoke VCS; loom-pulse is an event
router over Event Grid/Event Hubs + the Activator model, not a proprietary streaming fabric. Every
service below carries an explicit **HONEST LIMITS** section.

---

## 2. Where each service sits (grounded current state)

| Service | Fabric coherence property | Loom substrate today (file evidence) | Gap this band closes |
|---|---|---|---|
| **loom-sql-gateway** | One SQL analytics endpoint over every item | per-engine clients (`synapse-sql-client.ts`, `kusto-client.ts`, `databricks-client.ts`, `lakebase-databricks-client.ts`) called from **per-item** routes; caller must know the backing engine | One Entra-auth SQL endpoint that resolves item→engine from catalog, routes, enforces policy pre-flight, caches, meters |
| **loom-onesecurity** | One policy compiled to every engine | `lib/auth/pdp/evaluate.ts` = pure one-decision compiler, **default-shadow** (`enforce.ts`); outbound projection scattered across `onelake-rls-reconciler.ts` / `synapse-permissions-client.ts` / `kusto-rls-predicate.ts` | One compiler: Loom policy model → ADLS ACL + Synapse GRANT + UC grant + ADX RLS, continuously reconciled with drift-repair + audit; promotes shadow→enforce physically |
| **loom-gitsync** | Workspace ↔ Git, PR-based promotion | `git-integration-client.ts` = real item serialize + one-way commit to ADO/GitHub (KV PAT); `deployment-pipelines-pane.tsx` + `app/api/deployment-pipelines/**` = stage mapping | Always-on service: commit-on-save (batched), import/clone from Git, bidirectional + conflict UI, PR-based dev→test→prod promotion |
| **loom-pulse** | One event backbone + reactive rules | `business-events-store.ts` (governed event-type registry) + `eventgrid-client.ts`/`eventhubs-client.ts` (publish) + `activator-*` (react) + task-flow Run engine (execute any item) — **not wired to platform lifecycle** | One bus for every item/system event + a rules engine (extends Activator) that triggers any item run / notifies / webhooks |

**Seeds this band builds ON (do not duplicate):**

| Seed | File | Consumed by |
|---|---|---|
| Task-flow **Run engine** (topo-order steps, launch any runnable item, poll to terminal) | `lib/taskflow/step-runner.ts` + `lib/taskflow/launch-item.ts` + `.../run/route.ts` (PR #1816) | loom-pulse rules → item run |
| PDP **shadow-mode** decision engine | `lib/auth/pdp/evaluate.ts` + `enforce.ts` | loom-onesecurity (promote to enforce), loom-sql-gateway (pre-flight `/decide`) |
| **publish-as-api** (Weave) | `app/api/thread/publish-as-api/route.ts` | loom-sql-gateway (REST query surface pattern) |
| **query-result-cache** | `query-result-cache.ts` + `query-cache.ts` + `redis-cache-client.ts` | loom-sql-gateway cache serve path |
| **onelake-security** reconcilers | `onelake-security-client.ts` + `onelake-rls-reconciler.ts` | loom-onesecurity compile targets |
| **git-integration** serialize + commit | `git-integration-client.ts` | loom-gitsync (promote to always-on) |
| **deployment-pipelines** stage mapping | `deployment-pipelines-pane.tsx` + `app/api/deployment-pipelines/**` | loom-gitsync PR-based promotion |
| **business-events** governed registry | `business-events-store.ts` | loom-pulse event catalog |

---

## 3. Architecture — four control-plane services on the shared substrate

```
                        ┌──────────────────────────────────────────────────────────────┐
                        │              apps/fiab-console (Next.js BFF)                   │
    BI tools ───TDS/HTTP─┤  editors · admin pages · /api/** honest-503 gates             │
                        └──┬──────────────┬───────────────┬───────────────┬─────────────┘
                           │ lib client   │ lib client    │ lib client    │ lib client
              ┌────────────▼───┐  ┌────────▼────────┐  ┌───▼───────────┐  ┌▼─────────────────┐
              │ loom-sql-      │  │ loom-onesecurity│  │ loom-gitsync   │  │ loom-pulse        │
              │ gateway (BR-SQL)│ │ (BR-SEC)        │  │ (BR-GIT)       │  │ (BR-PULSE)        │
              │ ACA · Rust/Go  │  │ ACA · Go/.NET   │  │ ACA · Go/.NET  │  │ ACA · Go/.NET     │
              │ item→engine    │  │ policy compiler │  │ commit-on-save │  │ event router +    │
              │ route+authz+   │  │ + reconcile loop│  │ + promotion +  │  │ rules → item run  │
              │ cache+meter    │  │ + drift-repair  │  │ conflict UI    │  │ (via Run engine)  │
              └─┬───┬───┬───┬──┘  └──┬────┬────┬─────┘  └──┬─────────────┘  └─┬────────┬────────┘
      resolve   │   │   │   │  preflight│    │    │compile   │ commit/PR        │ emit   │ trigger
      item→eng  │   │   │   │  /decide  ▼    ▼    ▼          ▼                  ▼        ▼
        ┌───────▼───▼───▼───▼──┐   ┌─────────┐┌────────┐┌────────┐   ┌─────────────┐ ┌──────────────┐
        │ Synapse SQL · ADX ·  │   │ ADLS    ││ Synapse││ UC /   │   │ ADO / GitHub│ │ Event Grid   │
        │ Databricks SQL ·     │   │ POSIX   ││ SQL    ││ ADX    │   │ Repos (REST)│ │ namespace /  │
        │ Lakebase             │   │ ACL     ││ GRANT  ││ RLS    │   │ (KV PAT)    │ │ Event Hubs   │
        └──────────┬───────────┘   └─────────┘└────────┘└────────┘   └─────────────┘ └──────┬───────┘
                   │                     ▲  (loom-onesecurity is the shared PDP the           │ rules
       query cache │                     │   gateway calls pre-flight)                        ▼
             ┌─────▼─────────┐     ┌──────┴────────┐                                  ┌───────────────┐
             │ Azure Cache   │     │ Cosmos: PDP    │                                  │ task-flow Run  │
             │ for Redis     │     │ policy bundle +│                                  │ engine → any   │
             │ (shared,H-band)│    │ audit-log +    │                                  │ runnable item  │
             └───────────────┘     │ compile ledger │                                  └───────────────┘
                                   └────────────────┘
```

**Shared infra (amortized with the H-band).** These services reuse the H-band's shared Azure Cache for
Redis Premium (`hband-shared.bicep`) — loom-sql-gateway's cache serve path is the same `redis-cache-client.ts`
tier, and loom-pulse's rule-dedup/debounce state lives there too — plus the existing Cosmos account
(PDP policy bundle, audit-log, compile ledger, gitsync commit-batch state, pulse event catalog) and the
existing Event Grid custom topic / Event Hubs namespace. **No net-new metered Azure resource is required
by this band beyond the four ACA apps** (loom-pulse may add an Event Grid *namespace* only if the
existing custom-topic transport is insufficient for phase 2 fan-out — honest-gated, see §7).

---

## 4. Work items

| # | Item | Service | State | Phase | Priority | Effort |
|---|------|---------|-------|-------|----------|--------|
| BR-SQL-1  | Gateway skeleton — HTTP query API + Entra auth + catalog item→engine resolution | sql-gateway | NEW | 1 | **P0** | XL |
| BR-SQL-2  | Engine adapters — Synapse Serverless, Synapse dedicated, ADX (unified result-set shape) | sql-gateway | PARTIAL→svc | 1 | **P0** | L |
| BR-SQL-3  | OneSecurity pre-flight — call loom-onesecurity `/decide` before every query, apply obligations | sql-gateway | NEW | 1 | P1 | M |
| BR-SQL-4  | Cache serve path — `query-result-cache` lookup/populate keyed by `{item,query,principal-obligations}` | sql-gateway | PARTIAL→svc | 3 | P1 | M |
| BR-SQL-5  | Broker telemetry — emit per-query CU/LCU + latency to the Capacity Broker `/report` | sql-gateway | NEW | 3 | P1 | S |
| BR-SQL-6  | TDS wire-protocol listener — real TDS endpoint so Power BI / SSMS / any driver connects | sql-gateway | NEW | 2 | P2 | XL |
| BR-SQL-7  | Databricks SQL + Lakebase engine adapters (extend the routing table) | sql-gateway | PARTIAL→svc | 2 | P2 | M |
| BR-SEC-1  | Compiler service skeleton — Loom policy model → per-engine compilation plan (dry-run diff) | onesecurity | NEW | 1 | **P0** | XL |
| BR-SEC-2  | ADLS ACL + Synapse SQL GRANT compilers (real writes, idempotent) | onesecurity | PARTIAL→svc | 1 | **P0** | L |
| BR-SEC-3  | Databricks UC grant + ADX row-level-policy compilers | onesecurity | PARTIAL→svc | 1 | P1 | L |
| BR-SEC-4  | Promote PDP shadow→enforce — reconcile decisions to physical grants, `/decide` API for the gateway | onesecurity | NEW | 1 | P1 | M |
| BR-SEC-5  | Drift detection + repair loop — periodic reconcile, diff physical vs desired, auto-repair | onesecurity | NEW | 2 | P1 | L |
| BR-SEC-6  | Compilation audit — every compile → audit-log; `/admin/onesecurity` reconcile/diff surface | onesecurity | PARTIAL | 2 | P2 | M |
| BR-GIT-1  | gitsync service skeleton — item serialize/deserialize stable folder+file format (JSON + ipynb) | gitsync | PARTIAL→svc | 1 | **P0** | L |
| BR-GIT-2  | Commit-on-save — debounced/batched one-way workspace→Git commit on item save | gitsync | NEW | 1 | **P0** | M |
| BR-GIT-3  | Import/clone — build a workspace *from* a Git folder (export/import round-trip) | gitsync | NEW | 1 | P1 | M |
| BR-GIT-4  | Bidirectional sync + conflict surface — pull remote changes, 3-way diff, conflict UI | gitsync | NEW | 2 | P1 | L |
| BR-GIT-5  | PR-based promotion — dev→test→prod via deployment-pipelines mapping, opens a real PR | gitsync | PARTIAL | 2 | P2 | L |
| BR-PULSE-1 | Event backbone skeleton — internal bus + event emission API (`POST /emit`) + subscription | pulse | PARTIAL→svc | 1 | **P0** | XL |
| BR-PULSE-2 | Governed event catalog + item-lifecycle emitters (created/updated/run-started/run-failed) | pulse | PARTIAL→svc | 1 | **P0** | L |
| BR-PULSE-3 | Rules engine — extend Activator model; a rule triggers any item run via the Run engine | pulse | PARTIAL→svc | 1 | P1 | L |
| BR-PULSE-4 | Notification + webhook sinks — a rule fans out to email/Teams-webhook/generic webhook | pulse | NEW | 1 | P1 | M |
| BR-PULSE-5 | Data-landed events — storage/eventstream landing → `data-landed` event onto the bus | pulse | NEW | 2 | P2 | L |

**Counts:** sql-gateway **7** · onesecurity **6** · gitsync **5** · pulse **5** = **23 items**.

**Sequencing.** BR-SQL-1, BR-SEC-1, BR-GIT-1, BR-PULSE-1 are the four P0 skeletons (each executes its
core path at skeleton stage per `no-vaporware.md` — no stubbed route, no mock result). **loom-onesecurity
lands first among the pair that couple** because loom-sql-gateway's BR-SQL-3 pre-flight calls
onesecurity's BR-SEC-4 `/decide`; the gateway degrades to its own in-process PDP call if onesecurity is
absent (honest fallback, no hard dependency). Within each service, phase-1 items precede phase-2/3.

---

## 5. Service 1 — loom-sql-gateway (single SQL front door)

### 5.1 What it is

One Entra-authenticated query endpoint for the whole estate. A caller authenticates once, issues a query
against a logical item (`workspace/item` or a `loom://` path), and the gateway resolves which engine
backs that item from the Loom catalog, routes the query to the correct engine client, enforces
OneSecurity policy pre-flight, optionally serves from the result cache, and returns a unified result set
+ telemetry. It is the coherence-outcome-equivalent of Fabric's **SQL analytics endpoint** — one
connection surface over lakehouse SQL, warehouse, KQL, Databricks SQL, and Lakebase — but as a routing +
authz + cache + metering proxy, not a new SQL engine.

### 5.2 Architecture

- **Two front surfaces.** Phase 1: an **HTTP/REST query API** (`POST /query {target, sql, params}` →
  unified `{columns, rows, stats}`), the same shape `app/api/thread/publish-as-api/route.ts` already
  exposes for published queries. Phase 2 (BR-SQL-6): a **TDS wire-protocol listener** so unmodified BI
  tools (Power BI Desktop, SSMS, any TDS driver) connect with a normal SQL connection string.
- **Catalog routing.** The gateway reads the Loom item catalog (Cosmos `items`) to resolve
  `target → {engine, connectionDescriptor}`: lakehouse SQL / warehouse → Synapse
  (`synapse-sql-client.ts`), kql-database → ADX (`kusto-client.ts`), Databricks SQL →
  (`databricks-client.ts`), Lakebase → (`lakebase-databricks-client.ts`). The routing table is the one
  place that knows the item↔engine mapping so no caller has to.
- **Policy pre-flight.** Before dispatch, the gateway calls loom-onesecurity `/decide` (BR-SEC-4) with
  `{principal, target, action:'query'}`; a `deny` short-circuits to 403, an `allow` with obligations
  (RLS predicate, CLS allowed-columns) rewrites the query / result projection before dispatch. If
  onesecurity is absent, it falls back to an **in-process** `lib/auth/pdp/evaluate.ts` call (no hard
  dependency).
- **Cache + meter.** On a cacheable read the gateway consults `query-result-cache` keyed by
  `{itemId, normalizedSql, principalObligationsHash}` (obligations in the key so RLS/CLS never leak
  across principals); on a miss it dispatches, populates, and emits per-query LCU + latency to the
  Capacity Broker `/report`.

### 5.3 Azure infra + bicep

- `platform/fiab/bicep/modules/compute/loom-sql-gateway-app.bicep` — internal-ingress ACA app,
  `minReplicas: 1` (query routing is on the hot path; not scale-to-zero), dedicated UAMI
  `uami-loom-sql-gateway` with the **narrowest** grants: Synapse SQL query rights, ADX Viewer/Database
  User, Databricks SQL access, Cosmos data-plane on the `items` catalog container, and Redis Data
  Contributor (cache). It executes queries **as a service principal with pass-through obligations**, not
  as the end user — the OneSecurity pre-flight is what scopes the result, mirroring the existing
  `sql-user-token-store.ts` / `sql-access-mode.ts` posture. `az acr build` server-side image.
- Env into `admin-plane/main.bicep` `apps[]`: `LOOM_SQL_GATEWAY_URL` (empty default). Absent ⇒
  honest-503 gate; the console falls back to the **current per-item engine-client path** silently (no
  regression, no Fabric gate).
- **Gov:** full parity today — Synapse, ADX, Databricks, Cosmos, Redis are all GCC-High/IL5 GA.

### 5.4 Service impl

- **Language/runtime:** **Rust or Go** (the query hot path + eventual TDS listener want a tight,
  low-latency, predictable-GC loop; a Node BFF route is too heavy for a TDS server). Distroless
  multi-stage, non-root, internal ingress — same shape as `platform/runners/script-runner`.
- **Libs:** the TDS listener uses an OSS TDS server implementation (e.g. a Rust `tiberius`-server-side or
  a Go TDS shim); engine dispatch reuses the REST/ODBC contracts the existing TS clients already prove.
- **Endpoints:** `POST /query` (HTTP path), `GET /catalog/route/{target}` (resolve item→engine), TDS
  listener on port 1433-analog (phase 2), `GET /healthz`.

### 5.5 Loom lib client + BFF + surface

- **Client:** `lib/azure/loom-sql-gateway-client.ts` — thin wrapper the existing SQL query editors call
  instead of the per-engine clients (which become the in-process fallback when the service is absent).
- **BFF:** the existing per-item SQL query routes re-pointed at the client; honest-503 when
  `LOOM_SQL_GATEWAY_URL` unset.
- **Surface:** a single **"SQL endpoint"** connection panel (per workspace) showing the one HTTP endpoint
  + (phase 2) the TDS connection string, a copy-connection-string affordance, and a query console that
  hits `/query` — 1:1 with Fabric's "SQL analytics endpoint" surface, themed with Loom tokens.

### 5.6 Item-model integration

Not a new item type. Every SQL-queryable item (lakehouse, warehouse, kql-database, mirrored-database,
Databricks SQL, Lakebase) becomes reachable through the one endpoint; the item's `connectionDescriptor`
in the catalog is what the gateway routes on.

### 5.7 Acceptance criteria (per item)

- **BR-SQL-1:** `POST /query` against a lakehouse SQL target returns real rows from Synapse Serverless
  with the item resolved from the catalog — **`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET**; a bad target →
  precise 404; unauthenticated → 401.
- **BR-SQL-2:** the *same* `/query` call, retargeted, returns real rows from Synapse dedicated **and**
  from ADX, all in the one unified `{columns, rows, stats}` shape.
- **BR-SQL-3:** a principal with a RLS obligation sees only their rows; a CLS obligation drops the
  restricted column — both applied pre-flight via onesecurity `/decide`, proven with two principals.
- **BR-SQL-4:** a repeat query returns from cache (`stats.cached=true`) with a lower latency, and a
  different principal's obligations produce a **cache miss** (no cross-principal leak).
- **BR-SQL-5:** a `/report` row lands in the broker ledger with the query's LCU + latency.
- **BR-SQL-6:** Power BI Desktop (or `sqlcmd`) connects to the TDS endpoint with a connection string and
  runs a `SELECT` returning real rows.
- **BR-SQL-7:** the routing table resolves a Databricks SQL target and a Lakebase target to real rows.

### 5.8 HONEST LIMITS

- **A router, not an engine.** The gateway does not execute SQL itself — it dispatches to the real
  engine. Cross-engine JOINs (a warehouse table joined to an ADX table in one query) are **not** magically
  federated; that requires a federation engine and is a non-goal (§9). One query targets one engine.
- **TDS surface is a subset.** The phase-2 TDS listener speaks enough TDS for query + result + auth
  handshake; it is not a full SQL Server (no T-SQL DDL passthrough beyond what the backing engine
  supports, no stored-proc semantics the engine lacks). Documented per-engine.
- **Obligations are pre-flight rewrites, not kernel enforcement.** RLS/CLS are applied by rewriting the
  query / projecting the result before dispatch. A caller who bypasses the gateway and hits the engine
  directly is governed by that engine's own grants (which loom-onesecurity compiles) — the gateway is the
  *coherent* path, onesecurity is the *physical* backstop.

---

## 6. Service 2 — loom-onesecurity (the policy compiler)

### 6.1 What it is

A policy-compilation + continuous-reconciliation service. It takes the **one** Loom policy model — the
same inputs `lib/auth/pdp/evaluate.ts` already composes (workspace/domain roles, item share grants,
explicit allow/deny ACL grants, OneLake security roles with OLS/RLS/CLS obligations, protection
policies) — and compiles it down to the **physical** access controls of every backing engine, then keeps
them reconciled: ADLS Gen2 POSIX ACLs, Synapse SQL GRANTs, Databricks Unity Catalog grants, and ADX
row-level security policies. It is the coherence-outcome-equivalent of Fabric's **OneSecurity** (define
once at the item/table/column/row level, enforced across every engine that reads the data) — built by
*promoting* Loom's existing default-shadow PDP from "decide + audit" to "decide + physically enforce."

### 6.2 Architecture

- **Input = the PDP policy bundle.** onesecurity reads the same Cosmos-persisted policy bundle
  `context-loader.ts` assembles and `evaluate.ts` consumes. The **desired state** is: for each
  principal×resource×action, the decision + obligations `evaluate()` already computes — this service does
  not re-invent the decision algebra, it **projects** it.
- **Compilers (one per target).** Each compiler turns the desired grant set into idempotent physical
  operations:
  - **ADLS ACL** — recursive POSIX ACL set (reuses `onelake-rls-reconciler.ts` / `onelake-security-client.ts`).
  - **Synapse SQL GRANT** — `GRANT SELECT ...` / RLS `SECURITY POLICY` + `PREDICATE` (reuses
    `synapse-permissions-client.ts`).
  - **Databricks UC** — `GRANT SELECT ON TABLE`, column masks, row filters.
  - **ADX RLS** — `.alter table policy row_level_security` (reuses `kusto-rls-predicate.ts`).
- **Compile = dry-run diff → apply.** A compile pass computes the *diff* between desired and physical for
  each target, emits a plan, then applies idempotently. `/decide` (BR-SEC-4) serves the gateway's
  pre-flight from the same in-memory desired-state.
- **Drift loop (BR-SEC-5).** A periodic reconcile re-reads physical grants, diffs against desired, and
  auto-repairs drift (someone hand-edited an ADLS ACL, a Synapse GRANT rotted) — logging every repair.
- **Promote shadow→enforce.** `enforce.ts` today evaluates + audits but does not block until
  `LOOM_PDP_ENFORCE=enforce`. onesecurity is what makes "enforce" *physically real* across engines rather
  than only gating the BFF request — flipping enforce with onesecurity deployed means the ADLS/Synapse/UC/ADX
  grants actually match the policy.

### 6.3 Azure infra + bicep

- `platform/fiab/bicep/modules/compute/loom-onesecurity-app.bicep` — internal-ingress ACA app,
  `minReplicas: 1` (the `/decide` path is on the gateway hot path), dedicated UAMI `uami-loom-onesecurity`
  with the grants needed to *write* access control on each target: **Storage Blob Data Owner** (ACL
  write) on the DLZ lake, Synapse SQL admin (GRANT), Databricks UC metastore admin (grant), ADX Database
  Admin (RLS policy), Cosmos data-plane on the policy-bundle + audit-log + compile-ledger containers.
  This is a **privileged** identity — least-privilege-*scoped* but necessarily grant-capable; the bicep
  documents the threat model. `az acr build` server-side image.
- Env into `admin-plane/main.bicep` `apps[]`: `LOOM_ONESECURITY_URL` (empty default). Absent ⇒
  honest-503; the gateway falls back to **in-process PDP** and the physical grants stay whatever the
  existing per-item reconcilers set (no regression, no Fabric gate).
- **Gov:** full parity — ADLS, Synapse, Databricks, ADX, Cosmos all GCC-High/IL5 GA.

### 6.4 Service impl

- **Language/runtime:** Go or .NET (mature ADLS DFS + Synapse TDS + Kusto + Databricks SDKs; the
  compilation logic is I/O-bound, not a tight CPU loop). Distroless, internal ingress.
- **Libs:** Azure Storage Files DataLake SDK, a TDS/SQL client for Synapse, Kusto management SDK,
  Databricks SDK, Cosmos SDK.
- **Endpoints:** `POST /compile {scope}` (dry-run diff → apply), `POST /decide` (the gateway pre-flight),
  `GET /drift/{scope}` (current drift report), `POST /reconcile` (force a repair pass), `GET /healthz`.

### 6.5 Loom lib client + BFF + surface

- **Client:** `lib/azure/loom-onesecurity-client.ts` — the security editors + the gateway call it; the
  per-item reconcilers become the in-process fallback.
- **BFF:** the existing OneLake-security / permissions routes re-pointed; honest-503 when
  `LOOM_ONESECURITY_URL` unset.
- **Surface:** an `/admin/onesecurity` page — a **compile/diff/reconcile** surface showing, per scope, the
  desired vs physical grant diff across all four engines, a "reconcile now" action, a drift indicator, and
  the compilation audit trail (BR-SEC-6). Themed to match `onelake-security-tab.tsx`.

### 6.6 Item-model integration

Not an item type — a cross-cutting control plane. Every governed item's grants flow through the compiler;
the semantic-model / lakehouse / warehouse / kql-database security tabs write to the Loom policy model,
and onesecurity projects it physically.

### 6.7 Acceptance criteria (per item)

- **BR-SEC-1:** `POST /compile` for a scope returns a **real dry-run diff** (desired vs physical) across
  the targets present, with zero side effects until apply.
- **BR-SEC-2:** applying the plan sets a real recursive ADLS ACL **and** a real Synapse `GRANT`; re-running
  is idempotent (empty diff).
- **BR-SEC-3:** the same policy compiles to a real Databricks UC grant **and** a real ADX row-level-security
  policy, verified by querying as a restricted principal.
- **BR-SEC-4:** `/decide` returns the same allow/deny + obligations as the in-process `evaluate.ts` for a
  battery of principal×resource cases (golden parity test); flipping `LOOM_PDP_ENFORCE=enforce` with
  onesecurity deployed makes a denied principal's physical query actually fail.
- **BR-SEC-5:** hand-editing an ADLS ACL out-of-band is detected as drift within one reconcile window and
  auto-repaired; the repair is logged.
- **BR-SEC-6:** every compile writes an audit-log row (who/what/scope/diff); `/admin/onesecurity` renders
  the live diff + audit trail.

### 6.8 HONEST LIMITS

- **Compiles over the customer's own RBAC/ACL substrate.** onesecurity does not introduce a new identity
  plane — it projects the Loom policy model onto ADLS POSIX ACLs, Synapse GRANTs, UC grants, ADX RLS. It
  cannot enforce a grant an engine cannot express (e.g. an engine with no column-mask primitive gets the
  nearest equivalent + an honest note), and it governs the engines Loom knows about, not arbitrary
  customer-attached compute.
- **Reconcile is periodic, not instantaneous.** Drift repair runs on a loop; between passes a hand-edited
  physical grant can diverge from desired. The window is tunable but non-zero — the coherent path
  (edit policy in Loom) is always immediate; only *out-of-band* physical edits wait for a reconcile.
- **Privileged identity is real.** To write grants on every engine the UAMI must hold grant-capable roles.
  This is least-privilege-*scoped* (only the resources in scope) but is genuinely powerful; it is
  documented, audited, and the single most security-sensitive identity in the band.

---

## 7. Service 3 — loom-gitsync (workspace ↔ Git spine)

### 7.1 What it is

An always-on bidirectional sync service between a Loom workspace and a Git repository (Azure DevOps Repos
or GitHub / GitHub Enterprise). Items are serialized to a stable folder/file format, committed on save
(batched), and promoted between workspaces (dev→test→prod) via PRs driven by the deployment-pipelines
mapping — with conflicts surfaced in the UI. It is the coherence-outcome-equivalent of Fabric's **Git
integration + deployment pipelines**, built by promoting the existing `git-integration-client.ts`
(already serializing items to Fabric-style item folders and committing to ADO/GitHub) from an
explicit-one-way-action to an owned service.

### 7.2 Architecture

- **Serialization = the existing canonical form.** `git-integration-client.ts` already serializes each
  item to `<directory>/<displayName>.<ItemType>/` with TMSL `model.bim` (semantic models), PBIR
  (reports), and `<itemType>.json` for everything else. gitsync **adds notebooks as `.ipynb`** and
  formalizes this as the stable on-disk contract (BR-GIT-1).
- **Commit-on-save (BR-GIT-2).** An item-save event (from loom-pulse, or a direct hook) enqueues the item;
  a debounce window batches saves into one commit (avoids a commit per keystroke), then pushes with the
  workspace-scoped PAT from Key Vault (the existing `git-integration-client.ts` KV posture — the PAT is
  never in Cosmos or the browser).
- **Import/clone (BR-GIT-3).** Deserialize a Git folder back into workspace items — the inverse of the
  serializer — so a workspace can be *built from* Git (fresh-clone bootstrap, disaster recovery).
- **Bidirectional + conflict (BR-GIT-4).** Pull remote commits, 3-way diff (base / local / remote) per
  item, and surface conflicts in the UI for resolution rather than silently overwriting.
- **PR-based promotion (BR-GIT-5).** The `deployment-pipelines` stage mapping (dev→test→prod workspace
  pairs, from `deployment-pipelines-pane.tsx` + `app/api/deployment-pipelines/**`) drives a real PR from
  the source stage's branch/folder to the target's — promotion is a reviewable PR, not a blind copy.

### 7.3 Azure infra + bicep

- `platform/fiab/bicep/modules/compute/loom-gitsync-app.bicep` — internal-ingress ACA app, **scale-to-zero
  capable** (sync is event-driven, not hot-path), dedicated UAMI `uami-loom-gitsync` with Cosmos
  data-plane on the commit-batch/sync-state containers + **Key Vault Secrets User** on the
  `loom-git-pat-*` secrets. No storage/engine grants — gitsync only reads item *definitions* (via the BFF
  item API), never item *data*. `az acr build` server-side image.
- Env into `admin-plane/main.bicep` `apps[]`: `LOOM_GITSYNC_URL` (empty default), plus the existing
  `LOOM_ADO_HOST` / `LOOM_GITHUB_HOST` / `LOOM_GIT_PAT_KV_PREFIX` that `git-integration-client.ts` already
  reads. Absent ⇒ honest-503; the existing explicit one-way `git-integration` action remains available
  (no regression, no Fabric gate).
- **Gov:** Azure DevOps Services is **commercial-only** (Learn: not available in GCC) — for GCC-High/IL5/DoD,
  `LOOM_ADO_HOST` points at an on-prem Azure DevOps Server and `LOOM_GITHUB_HOST` at a GitHub Enterprise
  Server `/api/v3` base, exactly as `git-integration-client.ts` already documents. Honest Gov gate, not a
  Fabric one.

### 7.4 Service impl

- **Language/runtime:** Go or .NET (Git REST + serialization is I/O-bound). Distroless, internal ingress,
  scale-to-zero.
- **Libs:** ADO Repos REST 7.1 / GitHub REST v3 (the contracts `git-integration-client.ts` proves), KV
  secrets client, Cosmos SDK, a git-tree/3-way-merge helper.
- **Endpoints:** `POST /commit {workspaceId, itemIds}` (batched), `POST /import {workspaceId, ref}`,
  `POST /sync {workspaceId}` (pull + diff), `GET /conflicts/{workspaceId}`, `POST /promote {pipelineId,
  fromStage, toStage}` (opens a PR), `GET /healthz`.

### 7.5 Loom lib client + BFF + surface

- **Client:** `lib/azure/loom-gitsync-client.ts` — the workspace settings drawer + a new "Source control"
  panel call it; `git-integration-client.ts` remains the in-process fallback.
- **BFF:** the existing SCM routes + `app/api/deployment-pipelines/**` re-pointed / extended; honest-503
  when `LOOM_GITSYNC_URL` unset.
- **Surface:** a **"Source control"** panel per workspace — connect repo, commit status, uncommitted-items
  list, a diff/conflict view, and a **"Promote"** action wired to the deployment-pipelines mapping — 1:1
  with Fabric's Git-integration + deployment-pipelines surfaces, Loom-themed.

### 7.6 Item-model integration

Every item gains a stable serialized form + a `gitStatus` (synced / modified / conflicted) shown in the
explorer. No new item type.

### 7.7 Acceptance criteria (per item)

- **BR-GIT-1:** every item type round-trips — serialize to the folder format and deserialize back to an
  identical item (notebooks as valid `.ipynb`), proven byte-stable for a mixed-type workspace.
- **BR-GIT-2:** saving three items within the debounce window produces **one** real commit in the target
  repo (ADO or GitHub) with all three item folders updated.
- **BR-GIT-3:** cloning a Git folder into an empty workspace reconstructs the items and they open in their
  editors with real content.
- **BR-GIT-4:** a remote edit + a local edit to the same item is detected as a conflict and surfaced in the
  UI (not silently overwritten); resolving it commits the chosen version.
- **BR-GIT-5:** a promote from dev→test opens a **real PR** in the repo with the item diffs; merging it
  updates the test workspace on next sync.

### 7.8 HONEST LIMITS

- **Item-definition sync, not data sync.** gitsync versions item *definitions* (models, reports,
  notebooks, pipeline JSON) — it does **not** put lakehouse table data or warehouse rows in Git. Same
  boundary as Fabric Git integration.
- **ADO Services is commercial-only.** Gov high-side requires an on-prem ADO Server or GitHub Enterprise
  Server (honest env gate, documented above) — this is an Azure/Gov reality, not a Loom shortfall.
- **Merge is 3-way on serialized text.** Conflict resolution operates on the serialized files; a semantic
  conflict that is text-clean but model-invalid (two compatible-looking edits that break a relationship)
  is caught at item-load validation, not at merge — surfaced honestly, not silently accepted.

---

## 8. Service 4 — loom-pulse (unified event backbone)

### 8.1 What it is

One event backbone for the whole platform. Every item and system event — created, updated, run-started,
run-succeeded, run-failed, data-landed — is published to an internal bus; a rules engine (extending the
Activator trigger model) watches the bus and can trigger **any** item run (via the task-flow Run engine),
send notifications, or call webhooks. It is the coherence-outcome-equivalent of Fabric's **Real-Time hub +
Activator + Data Activator "reflexes"** over the platform's own lifecycle — built by wiring three existing
seeds (`business-events-store.ts` governed registry + Event Grid/Event Hubs publish + the Activator model +
the Run engine) into one backbone.

### 8.2 Architecture

- **The bus.** Phase 1 reuses the existing Event Grid custom topic / Event Hubs namespace (the same
  transport `eventgrid-client.ts` / `eventhubs-client.ts` already use); a dedicated Event Grid **namespace**
  is added only if phase-2 fan-out exceeds the custom-topic model (honest-gated, not assumed).
- **Governed event catalog (BR-PULSE-2).** Extends `business-events-store.ts` — every platform event TYPE
  (name, category, typed field schema, owner) is registered and every `emit` is validated against it, so
  the backbone is governed, not a firehose. Loom emits its own lifecycle events through the same gate.
- **Lifecycle emitters (BR-PULSE-2).** Item CRUD + run routes emit `item.created` / `item.updated` /
  `run.started` / `run.succeeded` / `run.failed` to the bus. (`run.*` come naturally from the task-flow
  Run engine, which already tracks each launched item to a terminal state.)
- **Rules engine (BR-PULSE-3).** Extends `activator-trigger-model.ts`: a rule is `{on: eventType, where:
  condition, then: action}` where `action` can be **trigger an item run** (call the Run engine's
  `launchItemRun`), **notify**, or **webhook**. This is what turns "an event happened" into "so run the
  downstream pipeline" — the reactive spine Fabric's Activator provides.
- **Sinks (BR-PULSE-4).** Notification (email / Teams-webhook) + generic webhook fan-out from a rule.
- **Data-landed (BR-PULSE-5, phase 2).** Storage blob-created / eventstream landing events are normalized
  into a `data-landed` event on the bus so rules can react to *data arrival*, not just item lifecycle.

### 8.3 Azure infra + bicep

- `platform/fiab/bicep/modules/compute/loom-pulse-app.bicep` — internal-ingress ACA app, `minReplicas: 1`
  (the rules engine must be listening), dedicated UAMI `uami-loom-pulse` with: Event Grid Data Sender +
  Event Hubs Data Sender/Receiver on the existing topic/namespace, Cosmos data-plane on the event-catalog
  + rules + rule-run-log containers, Redis Data Contributor (dedup/debounce state, shared H-band cache).
  It triggers item runs **through the BFF Run engine** (a service-to-service call), not by holding
  engine grants itself — least-privilege. `az acr build` server-side image.
- Env into `admin-plane/main.bicep` `apps[]`: `LOOM_PULSE_URL` (empty default), reuse existing
  `LOOM_EVENTGRID_*` / `LOOM_EVENTHUBS_*`. Absent ⇒ honest-503; item lifecycle proceeds unaffected
  (events simply aren't emitted; nothing blocks — default-ON posture). A rule targeting an unset sink
  shows an honest MessageBar naming the env var.
- **Gov:** Event Grid, Event Hubs, Cosmos, Redis all GCC-High/IL5 GA. Teams-webhook sink documents egress
  for Gov review; the internal-bus + item-run-trigger path is fully in-tenant.

### 8.4 Service impl

- **Language/runtime:** Go or .NET (event fan-in/out + rule evaluation is I/O-bound). Distroless,
  internal ingress.
- **Libs:** Event Grid / Event Hubs SDK, Cosmos SDK, `redis` client, an HTTP webhook sender.
- **Endpoints:** `POST /emit {eventType, payload}` (validated against the catalog), `GET/POST/PUT
  /rules`, `POST /rules/{id}/test` (dry-run a rule against a sample event), `GET /rule-runs`,
  `GET /healthz`.

### 8.5 Loom lib client + BFF + surface

- **Client:** `lib/azure/loom-pulse-client.ts` — item CRUD/run routes call `emit()`; the rules admin +
  the Activator editor call the rules API.
- **BFF:** item + run routes gain a fire-and-forget `pulse.emit()`; a new `app/api/pulse/**` for rules;
  honest-503 when `LOOM_PULSE_URL` unset.
- **Surface:** an **event catalog** page (registered event types + schemas) and a **rules** surface that
  extends the Activator editor — `on <event> where <condition> then <run item | notify | webhook>` — with
  a live rule-run log. 1:1 with Fabric Activator/Real-Time-hub reactivity, Loom-themed.

### 8.6 Item-model integration

Not an item type — a cross-cutting backbone. The activator item's rules become pulse rules; every item's
lifecycle + run emit onto the bus. A rule can trigger any runnable item through the Run engine (which
Fabric cannot do for task flows at all — this **exceeds** Fabric).

### 8.7 Acceptance criteria (per item)

- **BR-PULSE-1:** `POST /emit` publishes a real event to the bus and a test subscriber receives it;
  emitting an event not in the catalog is rejected with a precise error.
- **BR-PULSE-2:** saving an item and running an item both produce real `item.updated` / `run.started` /
  `run.succeeded|failed` events on the bus, validated against their registered schemas.
- **BR-PULSE-3:** a rule `on run.failed where item=X then run item Y` **actually launches item Y** via the
  Run engine when X fails — proven end-to-end with a real run receipt.
- **BR-PULSE-4:** a rule fires a real webhook (200 from a test receiver) and a real notification.
- **BR-PULSE-5:** landing a blob in a watched container produces a `data-landed` event that a rule reacts
  to.

### 8.8 HONEST LIMITS

- **A router over Event Grid/Event Hubs, not a streaming fabric.** pulse orchestrates events and reactions;
  it is not a stream-processing engine (that's eventstream / Stream Analytics). Complex windowed stream
  analytics stay in the eventstream item — pulse reacts to *discrete* events.
- **At-least-once, idempotency on the consumer.** The bus is at-least-once; rules must be
  idempotent-safe (dedup state in Redis). A rule that triggers a non-idempotent side effect can double-fire
  on redelivery — documented, with dedup guidance.
- **Rule actions run through Loom.** A rule triggers item runs via the Run engine and webhooks via the
  service — it governs Loom-mediated reactions, not arbitrary external automation. Same posture as the
  gateway/onesecurity boundary.

---

## 9. Wave slotting & sequencing

This is a **multi-wave XL band** slotted as a **control-plane band alongside/after the H-band** (both are
substrate services that make existing features more coherent, not new user features). Recommended
ordering:

```
   ... Phase 12 H-band (OneLake / Direct Lake / Capacity Broker) ...
                                   │
                                   ▼
   Wave B1 — SQL front door + policy truth        Wave B2 — Git spine + nervous system
   BR-SQL-1,2,3 · BR-SEC-1,2,3,4                  BR-GIT-1,2,3 · BR-PULSE-1,2,3,4
   (SQL gateway phase 1 FIRST; onesecurity        (gitsync phase 1 + pulse phase 1)
    lands with it — the gateway calls /decide)
                                   │
                                   ▼
   Wave B3 — depth / phase-2
   BR-SQL-4,5,6,7 · BR-SEC-5,6 · BR-GIT-4,5 · BR-PULSE-5
```

- **SQL gateway phase 1 first** (BR-SQL-1/2), per the operator direction. loom-onesecurity BR-SEC-1..4
  lands in the **same wave** because BR-SQL-3's pre-flight calls onesecurity `/decide` — but the gateway
  has a working in-process PDP fallback, so it is not a hard blocker.
- **Each P0 skeleton executes its core path at skeleton stage** (real query, real compile diff, real
  commit, real emit — no stubs), per `no-vaporware.md`.
- **Wave sizing:** each of B1/B2/B3 is one multi-agent build session (one agent per BR item, parallel,
  single build-gate + roll at wave end), matching the WAVES.md convention.
- **Prerequisite:** the H-band's `hband-shared.bicep` Redis + the Capacity Broker (BR-SQL-5 meters to it)
  should exist for the *phase-3* metering/cache items; phase-1 items do not hard-depend on the H-band
  (the gateway/cache degrade gracefully).

**Total: 3 waves (B1–B3), 23 work items.** Adds a Bridge band without renumbering the H-band.

---

## 10. Non-goals (explicit)

- **No cross-engine query federation.** loom-sql-gateway routes one query to one engine; it does not join
  a warehouse table to an ADX table in a single federated query. (A federation engine is a separate,
  much larger effort — out of scope.)
- **No new identity plane.** loom-onesecurity compiles the Loom policy model onto the customer's own
  ADLS/Synapse/UC/ADX access controls; it does not introduce a Loom-proprietary identity or a SaaS
  no-Subscription-ID model.
- **No bespoke VCS.** loom-gitsync syncs to Azure DevOps / GitHub; it does not implement its own version
  control, and it versions item *definitions*, not table *data*.
- **No stream-processing engine.** loom-pulse routes discrete events + reactions; windowed stream
  analytics stay in the eventstream item.
- **No real Fabric dependency anywhere.** No default path calls `api.fabric.microsoft.com` /
  `api.powerbi.com` / `onelake.dfs.fabric.microsoft.com`. Fabric Git integration / Activator / SQL
  endpoint are *reference parity targets*, never runtime dependencies.
- **No hard cross-service dependency.** Each service honest-503 degrades to the current per-item glue when
  its sibling (or itself) is absent — the four are independently deployable.

---

## 11. Env-var / bicep sync appendix

Per `no-vaporware.md` "Bicep sync requirement." Every service ships behind a `LOOM_<SERVICE>_URL` with an
**empty default** so a from-scratch deploy is coherent (the env-sync guard is satisfied) and the band
defaults OFF; an unset URL honest-503 gates and silently falls back to the existing per-item path — never
to a Fabric requirement.

| Service | New bicep module (`modules/compute/`) | Dedicated UAMI | Key grants (least-privilege) | New env (`admin-plane/main.bicep` `apps[]` + `self-audit.ts` `ENV_CHECKS`) | Unset → fallback |
|---|---|---|---|---|---|
| loom-sql-gateway | `loom-sql-gateway-app.bicep` | `uami-loom-sql-gateway` | Synapse SQL query, ADX DB User, Databricks SQL, Cosmos data-plane (`items`), Redis Data Contributor | `LOOM_SQL_GATEWAY_URL` | per-item engine clients |
| loom-onesecurity | `loom-onesecurity-app.bicep` | `uami-loom-onesecurity` | Storage Blob Data **Owner** (ACL write), Synapse SQL admin, Databricks UC admin, ADX DB Admin, Cosmos data-plane (policy/audit/ledger) | `LOOM_ONESECURITY_URL` | in-process PDP + per-item reconcilers |
| loom-gitsync | `loom-gitsync-app.bicep` | `uami-loom-gitsync` | Cosmos data-plane (sync-state), **Key Vault Secrets User** (`loom-git-pat-*`) | `LOOM_GITSYNC_URL` (reuses `LOOM_ADO_HOST` / `LOOM_GITHUB_HOST` / `LOOM_GIT_PAT_KV_PREFIX`) | explicit one-way `git-integration` action |
| loom-pulse | `loom-pulse-app.bicep` | `uami-loom-pulse` | Event Grid Data Sender + Event Hubs Data Sender/Receiver, Cosmos data-plane (catalog/rules/log), Redis Data Contributor | `LOOM_PULSE_URL` (reuses `LOOM_EVENTGRID_*` / `LOOM_EVENTHUBS_*`) | no emission; lifecycle unaffected |

**Deploy pattern (all four, following `hband-shared.bicep` / `docs/fiab/hyperscale.md`):** because
`admin-plane/main.bicep` is at the ARM 256-parameter ceiling, each service app is a **standalone
out-of-band entrypoint** (orphan-allowlisted in `scripts/ci/check-bicep-sync.mjs`), `az acr build`
server-side into the two-phase-image ACR, then its URL set on the Console app via `/admin/env-config` or
`az containerapp update --set-env-vars`. UAMI grants that reach cross-RG/cross-sub to the DLZ (onesecurity
ACL-write, gateway Synapse/ADX) are applied by the per-service module or a bootstrap grant, exactly as the
H-band's cross-RG grants are.

**Shared-substrate reuse (no net-new metered resource for phase 1):** the shared Azure Cache for Redis
Premium (`hband-shared.bicep`), the existing Cosmos account, and the existing Event Grid custom topic /
Event Hubs namespace back this band. The only net-new phase-1 Azure resources are the four ACA apps
themselves.

---

## 12. Acceptance (band-level, no-vaporware)

- **loom-sql-gateway:** one `POST /query` returns real rows from Synapse **and** ADX via catalog routing,
  RLS/CLS applied pre-flight, **`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET**; phase 2 a real TDS connection
  from Power BI Desktop.
- **loom-onesecurity:** one policy compiles to a real ADLS ACL + Synapse GRANT + UC grant + ADX RLS;
  `/decide` matches in-process `evaluate.ts` (golden parity); drift is auto-repaired; every compile
  audited.
- **loom-gitsync:** items round-trip to the folder format, commit-on-save produces one batched real commit,
  a promote opens a real PR — no `api.fabric.microsoft.com`.
- **loom-pulse:** item lifecycle + run events land on the bus, and a rule `on run.failed then run item Y`
  **actually runs Y** via the Run engine — a reactive path Fabric cannot do for task flows.
- **Every merge** attaches a real-data E2E receipt (endpoint hit + real response body + browser
  screenshot / trace) + the honest-503 gate proof (service env unset ⇒ silent fallback, no Fabric gate,
  no regression), per `no-vaporware.md`.

---

## 13. Cross-references

- `docs/fiab/hyperscale.md` — the shared-substrate deploy pattern (standalone service apps + honest-503
  gates + default-OFF env wiring) this band follows exactly; the H-band's shared Redis/UAMI model.
- `PRPs/active/next-waves/PRP-loom-hyperscale-custom-components.md` — the **data-plane** sibling band
  (OneLake / Direct Lake / Capacity Broker); loom-sql-gateway meters to the Capacity Broker and both
  bands share the one Azure Cache for Redis Premium.
- `PRPs/active/next-waves/MASTER-ROLLOUT.md` — the phase plan; this band slots after Phase 12 (H-band).
- `platform/runners/script-runner/**` + `platform/fiab/bicep/modules/admin-plane/script-runner-app.bicep`
  — the deployable-service template all four services follow.
- Seeds built on: `lib/taskflow/step-runner.ts` + `launch-item.ts` (Run engine, PR #1816),
  `lib/auth/pdp/evaluate.ts` + `enforce.ts` (shadow-mode PDP), `git-integration-client.ts` +
  `deployment-pipelines-pane.tsx` (Git spine), `business-events-store.ts` + `activator-trigger-model.ts`
  (event spine), `query-result-cache.ts` + `redis-cache-client.ts` (cache).
