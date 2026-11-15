---
name: snowflake-parity
status: backlog
priority: P2
order: 5
depends_on: []
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-08-31
---

# PRP (hub): Snowflake parity + Snowflake MCP - migrate customers OFF Snowflake onto Azure-native Loom

Slimmed 2026-11-14 from a ~1134-line draft. The full 2026-08-25 body is kept verbatim as
[`REFERENCE-2026-08-25-full-draft.md`](./REFERENCE-2026-08-25-full-draft.md) (cited below as REF s<N>). This hub holds the goal,
the wave table and the gates. It does **not** restate matrices or the REF sections.
Only **W0** and **W1** have their own PRP files. W2-W9 stay rows in the table below on purpose: the design they rest on
(item-type owner, usage mart, resource-monitor, boundary truth) is not arbitrated yet, so per-wave PRPs would be written on sand.
Operator decision 2026-11-14: split W0 and W1 only.

## Goal
Build one-for-one Snowflake capability parity in CSA Loom on Azure-native and OSS backends, in every boundary Loom claims, and
integrate Snowflake over MCP, primarily **outbound** (read the customer's account, get definitions and data out). Posture,
dialect strategy and parity depth are settled and not re-opened: REF s3 (MIGRATION-FIRST; transpiler now, wire-compatible later;
outcome parity with named differences).

## Why
365 matrix rows across 9 domains: 11 Built, 206 Partial, 132 Missing, 16 cannot-match (REF s2; two matrices carry a 1-row tally mismatch, see W0.E).
Dominant failure mode is a built mechanism with no user-visible surface, and "Partial" often means "Commercial only", which `cloud-parity.md` calls incomplete.

## Scope / Non-goals
In scope: the waves below. Non-goals are REF s14 (no re-spec of mirroring #4024/#4031/#4041, no mechanism parity, no billing emulation,
no wire-compatible endpoint before W9, nothing in W9 or the three unmapped domains committed until WR closes).

## Acceptance criteria
- [ ] Each wave PRP/row ships with a per-boundary, real-backend receipt (REF s11), never tsc + vitest alone.
- [ ] Every boundary named in a verdict is marked exercised or "supported-in-code, never exercised" (GCC is the latter; `cloud-parity.md`).
- [ ] The decisions in W0 are **ratified by the operator** before any wave that depends on them starts. Fails if a W2+ PRP is written while its W0 decision is still labelled RECOMMENDED.
- [ ] Hub stays <= 250 lines; fails if a matrix table or REF section is pasted back in.

## Read first
- [`W0-arbitration-and-housekeeping.md`](./W0-arbitration-and-housekeeping.md), [`W1-extraction-spine.md`](./W1-extraction-spine.md)
- The nine current matrices (below). `MATRIX-compute-warehouses.md` and `MATRIX-storage-optimization.md` are SUPERSEDED (stamped 2026-11-14) - do not read them for claims.
- REF s5 (seams: mirroring #4024, #4025 failure shape, loom-mcp naming), REF s6 (cannot-match list), REF s7 (boundary truth), REF s9 (collisions).
- `.claude/rules/*.md` die-hard rules; REF s4 says what each one forces here.

## Owns
- `PRPs/backlog/snowflake-parity/PRP.md` (this hub)
- `PRPs/backlog/snowflake-parity/REFERENCE-2026-08-25-full-draft.md`
- `PRPs/backlog/snowflake-parity/MCP-INTEGRATION.md`
- `PRPs/backlog/snowflake-parity/MATRIX-ai.md`, `MATRIX-compute.md`, `MATRIX-ops.md`, `MATRIX-programmability.md`, `MATRIX-security.md`, `MATRIX-storage.md`, `MATRIX-ui.md` (W0 owns the governance and mcpagentic matrices and the two superseded matrices; W0 and W1 own their own files)

Code and docs outside that directory are owned by the wave rows below, declared per PRP.

## Must NOT touch
`PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md` (orchestrator). `apps/fiab-mcp-config/README.md` and `apps/loom-mcp/README.md` status text is out of this PRP's directory: follow-up listed in W1 (not edited here).

## Consumes
Merged mirroring lane (#4024/#4031/#4041: `apps/fiab-console/lib/azure/snowflake-adf.ts`, `apps/fiab-mirroring-engine/sources/snowflake_poller.py`), `apps/loom-mcp` (5 stdio servers), `apps/fiab-console/lib/migrate/sql-transpile.ts`, `lib/auth/tenant-boundary.ts`. Cross-program: OMNIBUS lane ownership (REF s12), estate pause (ADX), apigw/LHDS bicep ledger (`PRPs/reference/INTERLOCK.md`, orchestrator-owned).

## Provides
Migration extraction spine (W1), landing substrate (W2), domain parity (W3-W6), in-boundary AI (W7), Snowsight surfaces (W8), interop/DR/sharing (W9).

## Matrices (pointers; row counts as self-declared)
| Domain | File | Rows |
|---|---|---:|
| Compute & warehouses | [`MATRIX-compute.md`](./MATRIX-compute.md) | 48 |
| Storage & table types | [`MATRIX-storage.md`](./MATRIX-storage.md) | 41 |
| Governance & data quality | [`MATRIX-governance.md`](./MATRIX-governance.md) | 36 (parse finds 35) |
| Security & identity | [`MATRIX-security.md`](./MATRIX-security.md) | 41 |
| Ops, cost & observability | [`MATRIX-ops.md`](./MATRIX-ops.md) | 37 |
| Programmability | [`MATRIX-programmability.md`](./MATRIX-programmability.md) | 51 |
| AI, ML & Cortex | [`MATRIX-ai.md`](./MATRIX-ai.md) | 41 |
| MCP & agentic | [`MATRIX-mcpagentic.md`](./MATRIX-mcpagentic.md) | 30 (rollup 0/23/7, parse 0/24/6) |
| Snowsight UI | [`MATRIX-ui.md`](./MATRIX-ui.md) | 40 |
| Ingestion / Sharing / SQL dialect | **no matrix exists** (WR) | 0 |
Companion: [`MCP-INTEGRATION.md`](./MCP-INTEGRATION.md).

## Wave table
`touches_bicep` = the wave edits bicep or params. Only one bicep-touching PR in flight across all programs.

| Wave | What | depends_on | Hot files (serialize) | Bicep | Status of the PRP |
|---|---|---|---|---|---|
| **WR** | Research the 3 unmapped domains (ingestion, sharing, dialect) into `MATRIX-ingestion.md`, `MATRIX-sharing.md`, `MATRIX-dialect.md`. Method decided in W0 (D4). First read the 16 existing guides in `docs/migrations/snowflake/`. | W0 (method) | none (docs only, new files in this dir) | no | row only. NOT started. |
| **W0** | Decision record + truth fixes + housekeeping. Output is a decisions doc, not code. | none | `il5.bicepparam`, `conditional-access.bicep`, `main.bicep`, `build-fiab-images*.yml` (W0.D only) | yes (W0.D) | [`W0-arbitration-and-housekeeping.md`](./W0-arbitration-and-housekeeping.md) |
| **W1** | Extraction spine: 1.1 `loom-snowflake` reader, 1.2 transpiler + assessment, 1.3 M6 MCP (stdio), 1.4 auto-bind ADF linked service, 1.5 loom-mcp over HTTP via bridge | W0 | `main.bicep` (1.4, 1.5), `build-fiab-images.yml` (1.1, 1.5), `params/*.bicepparam` (1.4), `loom-mcp-bridge.json` (1.5) | yes | [`W1-extraction-spine.md`](./W1-extraction-spine.md) |
| **W2.1** | `delta-file-stats` keystone (`lib/azure/delta-file-stats.ts`, new). Capped walk reports a flagged lower bound. | W1 | none | no | row only |
| **W2.2** | Close Loom Unity Gov gate: `postgresQuotaAvailable=false` in `gcc-high.bicepparam` and `il5.bicepparam` (REF s7.4) | W0 (boundary truth) | `params/gcc-high.bicepparam`, `params/il5.bicepparam` | yes | row only |
| **W2.3** | The ONE usage mart (`LOOM_USAGE`) per W0 decision D3; honest-gate when ADX stopped | W0 D3 ratified, W2.1 | `usage-mart.ts` (new), `usage-mart-job.bicep` (new), `main.bicep` | yes | row only |
| **W2.4** | Iceberg federation over copying (`iceberg-catalog-client.ts`, `loom-trino`) | W1.1, W1.3 | `apps/loom-trino/**` | no | row only |
| **W3** | Governance + security domain parity (`MATRIX-governance`, `MATRIX-security`). Role plane + `SHOW GRANTS` importer first. | W2, W0 D1/D5 | `lib/auth/**` (OMNIBUS L1), item-type catalog files (D1 register), gate registry | maybe | row only |
| **W4** | Compute & warehouses (`MATRIX-compute`). Rows 1, 9, 38 substrate; Gov rows 16/17 first. Blocked by capacity-broker wiring (HYP-11). | W2, W0 D2 | `synapse.bicep`, `apps/loom-capacity-broker/**`, item-type files | yes | row only |
| **W5** | Ops, cost, observability (`MATRIX-ops`). Row 19 derived-timeout fix is the highest-urgency single change. | W2.3, W0 D2 | `workspace-monitor.ts`, Event Hubs bicep | yes | row only |
| **W6** | Programmability & runtimes (`MATRIX-programmability`). Rows 4 and 3 first. Trust-tier separation precedes rows 36/42/26. | W2 | `container-platform.bicep`, params (workload profiles) | yes | row only |
| **W7** | In-boundary AI (`MATRIX-ai`). W7.0 engine chokepoint (token budget + `resolveAoaiTarget`) before any AI UDF. GPU decision made once (REF s13 #5). | W2.2, W0 | `apps/loom-trino/**`, `apps/loom-duckdb/**`, `lib/copilot/**` | maybe | row only |
| **W8** | Snowsight surfaces (`MATRIX-ui`), ordered by how early a migrating user hits the gap. G1 browser E2E is completion. | W3-W7 backends | item-type catalog files, route registries | no | row only |
| **W9** | Interop: wire-compatible endpoint, Snowflake-managed MCP registration, DR + `replication-group`, sharing, ingestion/Streams | WR, W2+ | `mcp-client.ts`, `lib/mcp/catalog.ts` | maybe | row only. Gated on WR. |

Waves W3-W6 are mutually independent once W2 and W0 land, but each of them proposes item types or bicep, so they run **serialized on the catalog and bicep files**, not in parallel on them (W0 D1).
Waves W2-W9 each get their own PRP only after the W0 decisions they cite are operator-ratified. Run `/prp:prp-create` per wave then.

## Steps
1. Operator reads W0, ratifies or amends D1-D5. 2. Run W0. 3. Run W1 (W1.5 waits for W0.D). 4. Cut W2 PRP(s) once D3 ratified. 5. Cut W3-W9 PRPs one at a time. Never more than 4 lanes.

## Validation
`python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root <repo>` exits 0 for this directory. Per wave: that wave's own commands. Reported status uses the words "merged, not deployed" until a live receipt exists (`deploy-integrity.md` R2).

## Rollback
Docs-only hub: revert the commit. `REFERENCE-2026-08-25-full-draft.md` holds the prior full text.

## Docs to update
`docs/migrations/snowflake/*` corrections are owned by W0.C. `docs/fiab/boundary-service-matrix.md` (new) is owned by W0.B.

## Wave / Blocked-by / Branch / Worktree
Hub: Wave: n/a · Blocked-by: none · Branch: per child PRP (`feat/snowflake-w0`, `feat/snowflake-w1`) · Worktree: `E:/Repos/_snowflake-w0`, `E:/Repos/_snowflake-w1`

## Hot files
Shared catalog files (`apps/fiab-console/lib/catalog/fabric-item-types.ts`, `lib/catalog/item-types/types.ts`, `item-type-icon.ts`, `app/api/items/_lib/item-crud.ts`), `lib/gates/registry/*.ts`, `platform/fiab/bicep/modules/admin-plane/main.bicep`, `params/*.bicepparam`, build-fiab-images workflows. `touches_bicep: yes` (via W0.D, W1.1, W1.4, W1.5).
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Open items that need an operator call (carried from REF s13; not in W0 unless noted)
W0 covers: ACA at IL5 (D5), DoD meaning (D5). Still open and not yet assigned: which Snowflake Gov deployment the target account is on (#1); editions concept (#4); GPU pool (#5); Synapse dedicated as permanent Gov substrate vs the Fabric forward path (#6); serving `SYSTEM$` functions (#7); `loom-duckdb` replica floor (#8); scope acceptance for four 0-parity domains (#9); widening `synapse.bicep` past DW1500c (#10).

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W0 | todo | | opus | companion PRP | 2026-11-14 |
| W1 | todo | | sonnet | companion PRP; blocked by W0 | 2026-11-14 |
| WR, W2-W9 | todo | | | table rows only, no PRP | 2026-11-14 |

Measured 2026-11-14 on worktree off origin/main: no `apps/loom-snowflake`, no snowflake MCP server under `apps/loom-mcp/src/servers/`; only the pre-existing mirroring files. Nothing in W0-W9 has started.

## Kickoff prompt
Read PRPs/backlog/snowflake-parity/PRP.md (hub), then W0-arbitration-and-housekeeping.md. W0 is a decision record: write RECOMMENDED decisions, never record one as decided.
Do not start W1 until the operator has ratified D1-D5. Proof of done for W0: `python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .` exits 0 and the decisions doc has an operator-ratified line per decision.
