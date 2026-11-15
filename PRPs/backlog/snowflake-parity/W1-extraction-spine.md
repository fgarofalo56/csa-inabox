---
name: W1-extraction-spine
status: backlog
priority: P1
order: 2
depends_on: [W0-arbitration-and-housekeeping]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
---

# W1 - Extraction spine: get a customer's definitions and data OFF Snowflake

## Goal
Ship the migration-first core (hub decision 1): a deployed read path into a customer's Snowflake account, a transpiler + assessment report over what it finds, an
MCP server exposing it, the ADF Snowflake linked service created automatically, and the existing `loom-mcp` servers reachable over HTTP. Five items, one orchestrated run.

## Why
Hub decisions: MIGRATION-FIRST and transpiler-now. The P0 for the operator demo is a `auto-bind-by-default.md` violation: `loomMirrorSnowflakeLinkedService` defaults to `''`
(`platform/fiab/bicep/modules/admin-plane/main.bicep` ~line 1559, re-measure) and appears in no `.bicepparam`, so mirroring ends in "create an ADF linked service by hand".
Evidence for W1.5's gap: no `loom-mcp` image is built from `./apps/loom-mcp` (`.github/workflows/build-fiab-images.yml:121-123` builds `loom-mcp` from `./apps/fiab-mcp-config`; fixed by W0.D).

## Scope / Non-goals
In: the five items below. Out: any new item type or catalog-file edit (W1 adds none: an MCP server and a container app are not catalog item types, so W0 D1 does not gate it). Out: W2 landing substrate, usage mart, wire-compatible endpoint, Snowflake-managed MCP registration (W9.2), re-specifying mirroring #4024/#4031/#4041 (consume only).

## Acceptance criteria
Each names the value that would break it (assertion-design).
- [ ] **W1.1** Live browse of a real Snowflake account through the deployed app: database -> schema -> table -> describe, real response body in the PR, `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. Fails if the response is empty/mock, or if the Container App has `external: true` or any non-empty `secrets`. Gov: a GitHub Actions receipt (never local `az`); if no Gov deploy runs, state "Gov supported-in-code, unverified".
- [ ] **W1.2** A real customer-shaped Snowflake DDL corpus transpiled; the report gives a per-object verdict (auto-convertible / needs-review / cannot-match) and every cannot-match cites a REF s6 row number. Fails if a construct in the named-unsupported list (`LATERAL FLATTEN`, `::` casts, `PIVOT`, `GENERATOR`, `SECURE VIEW`) comes back "converted" without a needs-review marker.
- [ ] **W1.3** `SELECT` returns rows; `CREATE TABLE` is refused at parse and never dispatched; a capped result shows `truncated:true` + `cappedBy`; a failed ADF run surfaces as failed not `Running` (the #4025 shape is forbidden); caller in tenant A against a connection in tenant B is refused, and refused again when `tid` is absent. No `credential.*` tool exists (assert the tool list lacks the prefix). Fails if apply defaults true.
- [ ] **W1.4** Clean create: Snowflake connection -> ADF linked service created with the matching name -> pipeline running -> Parquet landing in ADLS Bronze, no user binding step. `grep -rn "LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE" platform/fiab/bicep/params/` returns a real value (returns nothing today). Fails if the grep is empty or the linked-service name differs from the connection name.
- [ ] **W1.5** A live `tools/list` against the deployed bridge URL; two concurrent HTTP callers with different credentials get different authorization outcomes from one process; mutation receipt: hoist the server instance to module scope in a sandbox copy and the cross-caller test goes RED (restore proven by `git hash-object` or by using a copy). `loom-admin` `rejectPat: true` still holds over HTTP.

## Read first
- Hub [`PRP.md`](./PRP.md), REF s5 (seams, #4025 shape, naming) and REF s7.2 in [`REFERENCE-2026-08-25-full-draft.md`](./REFERENCE-2026-08-25-full-draft.md), [`MCP-INTEGRATION.md`](./MCP-INTEGRATION.md), [`W0-DECISIONS.md`](./W0-DECISIONS.md) (D5 for the IL5 hosting answer).
- `platform/fiab/bicep/modules/data-plane/loom-migrate-aca.bicep` (the pattern for W1.1). `apps/fiab-console/lib/azure/mirror-engine.ts`, `snowflake-adf.ts`, `mirror-adf-copy.ts`, `snowflake-failure-class.ts` (the mirroring seam; do not duplicate).
- `apps/fiab-console/lib/migrate/sql-transpile.ts` (`SqlSourceDialect`), `assessment.ts`, `translate.ts`. `apps/loom-mcp/src/core/*` and `src/servers/loom-query/guards.ts` (read-only guard pattern). `apps/fiab-mcp-bridge/config/loom-mcp-bridge.json`, `apps/fiab-mcp-bridge/README.md`.
- `apps/fiab-console/lib/install/provisioners/**` (W1.4 pattern).

## Owns
- W1.1: `apps/loom-snowflake/**` (new), `platform/fiab/bicep/modules/data-plane/loom-snowflake-aca.bicep` (new), `.github/workflows/build-fiab-images.yml` (matrix entry only).
- W1.2: `apps/fiab-console/lib/migrate/sql-transpile.ts`, `assessment.ts`, `translate.ts`, `lib/migrate/__tests__/**`.
- W1.3: `apps/loom-mcp/src/servers/loom-snowflake/**` (new).
- W1.4: `apps/fiab-console/lib/install/provisioners/snowflake-connection.ts` (new; the Snowflake connection provisioner only), `platform/fiab/bicep/modules/admin-plane/main.bicep` (edit window), `platform/fiab/bicep/params/*.bicepparam`.
- W1.5: `apps/fiab-mcp-bridge/**`; `apps/loom-mcp/src/transport/**` (new, only if the bridge cannot carry it).

## Must NOT touch
`lib/catalog/fabric-item-types.ts`, `lib/catalog/item-types/types.ts`, `item-type-icon.ts`, `item-crud.ts`, `lib/gates/registry/*.ts` except one registry entry if a gate is unavoidable (G2; serialize with any other registry PR), `health.bicep`, `apim.bicep`, lockfiles outside `apps/loom-snowflake`. Mirroring files in `lib/azure/mirror-*.ts` and `snowflake-*.ts` are consumed, not edited, unless a W1.3 facade needs an exported symbol (then a minimal export-only change, declared in the PR).

## Consumes
W0.D (image rename: `loom-mcp` vs `loom-azmcp`; W1.5 cannot start without it), W0 D5 (ACA vs AKS at IL5 decides W1.1 and W1.5 hosting on GCC-High/IL5; until ratified, ship ACA for Commercial and name the IL5 path as unresolved, do not claim it), merged mirroring lane #4024 (verified in code only: `mirror-engine.ts`, `snowflake-adf.ts` exist), the existing loom-mcp `core/tool.ts` unchanged.

## Provides
`LOOM_SNOWFLAKE_URL` (output `fqdn` of the reader), the `loom-snowflake` MCP server, a migration assessment report format, an ADF-auto-bound Snowflake connection, HTTP-served loom-mcp servers via the bridge. Consumed by W2.4 and W3.

## Steps
1. Branch order matters for hot files: **W1.2 and W1.3 are parallel** (disjoint dirs; W1.3 needs W1.1's contract, mock the reader at the HTTP seam only in tests, never ship a mock). **W1.1, W1.4, W1.5 touch bicep/workflows: run them serialized, one bicep PR in flight** (W1.1, then W1.4, then W1.5).
2. W1.1: model the Container App on `loom-migrate-aca.bicep`: `targetScope='resourceGroup'`, one typed config-object bag (ARM 256-param cap), `external: false`, `secrets: []` (BFF resolves credentials from Key Vault per request), UAMI for ACR pull only, `/health`, `minReplicas: 0`, output `fqdn`. Reads databases/schemas/tables/columns, warehouses, roles+grants, policies, tags, masking + row-access policies, `OBJECT_DEPENDENCIES`, `ACCESS_HISTORY` over the Snowflake SQL REST API. Default ON, opt-out via `loomBackends`. Wire env var in `admin-plane/main.bicep` per `no-vaporware.md` bicep-sync (needs a main.bicep window; coordinate with W1.4's PR).
3. W1.2: extend `sql-transpile.ts` honest-unsupported table; tie to an assessment report over W1.1's inventory. Scope statement for the dialect is `MATRIX-dialect.md` once WR lands; until then use `sql-transpile.ts`'s current table and say so.
4. W1.3: stdio first. Tools: discovery (incl. `kind:'iceberg'`), `query` with a Snowflake-specific read-only guard, `warehouses.list`, `lineage.get`, `grants.list`, `governance.get`, mirroring `plan`/`apply` as a thin facade over `mirror-engine.ts` with apply default FALSE.
5. W1.4: creating a Snowflake connection creates the ADF Snowflake linked service (name = connection name, credential via ADF's Key Vault linked-service pattern on the `loom-conn-<uuid>` secret) and the AzureBlobFS sink linked service; env wiring is produced by the deploy, not supplied by the operator.
6. W1.5: register the five servers in `loom-mcp-bridge.json`; auto-register hosted `McpServerConfigDoc`s in post-deploy bootstrap; `AuthContext` resolves per request; server instance never at module scope. Hosting: ACA for Commercial/GCC; GCC-High/IL5 path per D5 (bridge README says AKS).
7. Run the validations; open PRs per item; reviewer pass (review: required, one pass, approve unless blocking).

## Validation
- `make validate-python` is not relevant; run per item: `cd apps/fiab-console && npx vitest run lib/migrate lib/install` (W1.2/W1.4), `cd apps/loom-mcp && npm test` (W1.3), `cd apps/fiab-mcp-bridge && npm test` (W1.5), `az bicep build -f platform/fiab/bicep/modules/data-plane/loom-snowflake-aca.bicep` and `make validate-bicep` (W1.1/1.4/1.5). Read each package's `package.json` for the real script names first.
- Live receipts as in Acceptance. Per-cloud: Commercial receipt required; GCC-High receipt from a GitHub Actions run (the GCC-High deploy job has executed steps; IL5 `deploy-fiab-il5.yml` has no recorded run, so IL5 is "supported-in-code, never exercised"); GCC is supported-in-code, never exercised. Never claim a boundary not run.
- Reporting rule: merged without a live receipt is written "merged, not deployed", never "fixed" (`deploy-integrity.md` R2).
- Mutation arm for W1.5 and for the W1.3 cross-tenant refusal runs on a sandbox copy; state whether each green arm is blind-test, weak mutation, or equivalent mutant.

## Rollback
Each item is a separate PR: revert independently. W1.1 default-on is reversible via `loomBackends` opt-out without a code revert. W1.4 revert leaves the old pass-through (honest gate) in place. W1.5: remove the bridge JSON entries; stdio use is unaffected.

## Docs to update
`docs/fiab/parity/` entry for the Snowflake connection surface if its UI changes; `docs/migrations/snowflake/` pointer to the assessment report; `docs/fiab/v3-tenant-bootstrap.md` if bootstrap registration changes. **Follow-ups outside this PRP's ownership (listed, not edited by the audit):** `apps/fiab-mcp-config/README.md:6` still says "Status: SCAFFOLDED" over a deployed container; `apps/loom-mcp/README.md` carries two contradictory status tables (REF s15.6); fix with W1.5.

## Wave / Blocked-by / Branch / Worktree
Wave: 1 · Blocked-by: W0-arbitration-and-housekeeping (W0.D for W1.5; D5 ratification before any IL5 hosting claim) · Branch: `feat/snowflake-w1-<item>` (e.g. `feat/snowflake-w1-reader`) · Worktree: `E:/Repos/_snowflake-w1`

> ASSUMPTION: "fits one session" is met as an orchestrated run (one orchestrator session, one implementer worktree per item), not one agent doing all five. If the run exceeds budget, W1.5 is the item to cut to a follow-up; W1.1-W1.4 are the migration-first core.

## Hot files
`admin-plane/main.bicep`, `params/*.bicepparam`, `build-fiab-images.yml`, `apps/fiab-mcp-bridge/config/loom-mcp-bridge.json`. `touches_bicep: yes` (W1.1, W1.4, W1.5; W1.2 and W1.3 no). OMNIBUS ownership of `apps/loom-*/**` (L6), `lib/azure/**`/`lib/migrate/**` (L6) must be re-checked against current state before kickoff (REF s12; the OMNIBUS PRP may be shipped or changed).
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W1.1 loom-snowflake reader | todo | | sonnet | | 2026-11-14 |
| W1.2 transpiler + assessment | todo | | sonnet | | 2026-11-14 |
| W1.3 loom-snowflake MCP (stdio) | todo | | sonnet | | 2026-11-14 |
| W1.4 auto-bind ADF linked service | todo | | sonnet | | 2026-11-14 |
| W1.5 loom-mcp over HTTP (bridge) | todo | | opus | security crux: per-request auth | 2026-11-14 |

## Kickoff prompt
Read PRPs/backlog/snowflake-parity/PRP.md, then this file, then W0-DECISIONS.md (confirm D5 is RATIFIED; if not, ask the operator and do not claim IL5).
Confirm W0.D merged (two images: loom-mcp from apps/loom-mcp, loom-azmcp) before W1.5. Re-measure every "missing" claim against origin/main first.
Run W1.2 and W1.3 in parallel worktrees; run W1.1, W1.4, W1.5 one at a time (one bicep PR in flight).
No credential in any tool, command or file. Done = vitest/npm tests for the touched package pass, bicep builds, PR open, CI green, live receipt per Acceptance; otherwise say "merged, not deployed".
