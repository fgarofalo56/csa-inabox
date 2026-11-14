---
name: W0-arbitration-and-housekeeping
status: backlog
priority: P1
order: 1
depends_on: []
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
---

# W0 - Arbitration, boundary truth and housekeeping (decision-record PRP)

## Goal
Produce one decisions document, [`W0-DECISIONS.md`](./W0-DECISIONS.md), that resolves the collisions the hub's waves cannot start without,
plus the truth fixes and housekeeping that stop wrong claims propagating. **The output is a decision record. No decision here is
decided until the operator ratifies it**; every recommendation below carries the label `RECOMMENDED - operator must ratify` and the
implementer must keep that label until the operator's ratification line is added by the operator.

## Why
REF s9 (collision evidence) found five capabilities designed more than once with incompatible semantics, and 11 proposed item types with no
owner of the shared catalog files. REF s7.2 flags ACA at IL4/IL5 as BLOCKING for every Gov verdict. W2.3, W3, W4, W5 and the item-type waves
cannot be written until these are settled. REF s15 housekeeping is also undone.

## Scope / Non-goals
In: D1-D5 decisions, boundary truth table, doc and bicep-comment corrections, matrix housekeeping.
Out: building any resource-monitor, usage mart, item type or refusal mechanism (later waves). Out: re-litigating REF s3 decisions (settled).
Out: the remaining REF s13 items (#1, #4-#10), listed in the hub as still open.

> ASSUMPTION: the operator ratifies in `W0-DECISIONS.md` by adding a line `RATIFIED <date> by <operator>` under each decision (or an amended
> decision). No agent writes that line.

## Acceptance criteria
- [ ] `W0-DECISIONS.md` has exactly five decision sections D1-D5, each with: options, evidence (path + symbol or fetched URL + date), a RECOMMENDED line, an empty `RATIFIED` line. Fails if any section is missing a RECOMMENDED label or has a pre-filled RATIFIED line.
- [ ] `docs/fiab/boundary-service-matrix.md` exists; each of ACA, AKS, Purview, Managed Grafana, ADX, AOAI, AI Search, Front Door, Postgres Flexible, Cost Management has a row at FedRAMP High / IL2 / IL4 / IL5WI / IL6 with a fetched URL + date. Fails on any blank cell or any cell without a source.
- [ ] `grep -rn "SPNs cannot create CA" platform/fiab/bicep` returns 0 hits. `il5.bicepparam` line 121 comment no longer equates regional GA with IL5 authorization (grep the old text `ACA GA in USGov Virginia/Arizona/Texas (GOV-3)` returns 0 or is qualified in-line).
- [ ] A build run yields two distinct images (`loom-mcp` from `./apps/loom-mcp`, `loom-azmcp` for Azure.Mcp.Server) and the Container App resolves to the intended one (W0.D).
- [ ] Both superseded matrices open with a SUPERSEDED line (`head -1`), and the governance and mcpagentic tallies each state one number that a mechanical row parse reproduces. Fails if the parse count differs from the stated count.

## Read first
- Hub [`PRP.md`](./PRP.md); REF s9 (all of it), s7.1-7.3, s13, s15 in [`REFERENCE-2026-08-25-full-draft.md`](./REFERENCE-2026-08-25-full-draft.md).
- `MATRIX-compute.md` row 29 vs `MATRIX-ops.md` row 18 (resource-monitor); `MATRIX-ops.md` row 7, `MATRIX-compute.md` row 36, `MATRIX-governance.md` row 35 (usage mart).
- `apps/fiab-console/lib/catalog/fabric-item-types.ts`, `lib/catalog/item-types/types.ts`, `lib/catalog/item-type-icon.ts`, `app/api/items/_lib/item-crud.ts` (shared catalog files, all exist).
- `apps/fiab-console/lib/auth/tenant-boundary.ts` (existing refusal point). `platform/fiab/bicep/params/il5.bicepparam` line 121. `apps/fiab-mcp-bridge/README.md` line 75 ("Container Apps not at IL4+").

## Owns
`PRPs/backlog/snowflake-parity/W0-DECISIONS.md` (new), `docs/fiab/boundary-service-matrix.md` (new), `docs/migrations/snowflake/feature-mapping-complete.md`, `federal-migration-guide.md`, `why-azure-over-snowflake.md`, `docs/fiab/parity/mirrored-database.md`, `mirrored-database-connections.md`,
`platform/fiab/bicep/modules/admin-plane/conditional-access.bicep`, `platform/fiab/bicep/params/il5.bicepparam`, `.github/workflows/build-fiab-images.yml`, `build-fiab-images-acr-tasks.yml`, `modules/admin-plane/main.bicep` (W0.D only, declared edit window), `MATRIX-governance.md`, `MATRIX-mcpagentic.md`, the two superseded matrices.

## Must NOT touch
`apps/**` source (README status lines in `apps/fiab-mcp-config/README.md`, `apps/loom-mcp/README.md` are listed as follow-ups in W1, owned there). The hub's wave table beyond status words. Any `PRPs/INDEX.md` / `MASTER-INDEX.md` / `REGISTER.md`.

## Consumes
OMNIBUS ownership map (REF s12) for the `main.bicep` edit window; `PRPs/reference/INTERLOCK.md` bicep ledger (orchestrator-owned): W0.D takes one slot.

## Provides
Ratified D1-D5 that unblock W2.3 (D3), W3-W8 (D1, D2), WR (D4), every Gov verdict (D5). A boundary truth table cited by all later waves.

## Steps
Five work items. W0.A-W0.C and W0.E are docs-only and parallel-safe (disjoint files). W0.D touches bicep and params and runs alone in its PR.

**W0.A - Write `W0-DECISIONS.md` D1-D4** (docs). Each decision lists options, evidence, RECOMMENDED.
- **D1 owner of shared catalog files + item-type register.** Options: (a) one serial register, one declared owner per slot, no two item-type PRs open at once; (b) per-wave ownership with merge-time conflict resolution. Evidence: REF s9.4 (11 proposed types: resource-monitor, compute-pool, replication-group, event-table, ingestion-pipe, connector-runtime, task-graph, docintel-model, ai-policy, MCP SERVER object, budget-object) and `MATRIX-mcpagentic.md` M1 already says "sequence, never parallelize". **RECOMMENDED - operator must ratify: (a). The owner of `fabric-item-types.ts` and `item-types/types.ts` is whichever single PRP holds the register slot; slots are granted in wave order W3, W4, W5, W6, W7, W8; W1 adds no item types (it adds an MCP server and a container app, neither is a catalog item type).** Operator also names the register's keeper.
- **D2 resource-monitor single design.** Options: LCU-primary suspend (`MATRIX-compute.md` row 29); dollar-only suspend (`MATRIX-ops.md` row 18); notify-on-either, suspend on LCU with dollar reconciliation. Evidence: REF s9.1. **RECOMMENDED - operator must ratify: notify on either signal; suspend on LCU with the dollar reconciliation shown beside it; suspend-immediately only on explicit quota exhaustion behind a hard confirmation and a dry-run; every threshold event labels which signal fired and its as-of time. One schema, one owner (the W4 PRP), `MATRIX-ops.md` row 18 defers to it.** Replication-group follows the same rule: **RECOMMENDED - operator must ratify: ops owns it, object exists as a coordinated group with per-plane consistency, headline number = oldest plane's consistency point** (REF s9.2; amends the earlier "runbook, not an item type" position).
- **D3 single usage mart.** Options: `LOOM_USAGE` Delta/Iceberg in `loom-unity` (compute row 36); `loomdb_account_usage` on ADX with KQL functions (ops row 7); `LOOM_ACCOUNT_USAGE` Delta + Synapse serverless external views + ADX external tables (governance row 35). Evidence: REF s9.3; ops' own semantic-delta says its design is DQL-only and breaks migrated SQL on day one; ADX is under the standing estate-pause mandate (`MEMORY` estate pause; stopped ADX also breaks bicep What-If). **RECOMMENDED - operator must ratify: Delta on ADLS as the store, Synapse serverless external views as the primary SQL surface, ADX external tables as the KQL surface honest-gated when the cluster is paused, single name `LOOM_USAGE`.** Re-measure the three rows against `origin/main` first (REF s2.3 reading 2: matrices produced false "missing").
- **D4 WR mapping method** (how the three unmapped domains get researched, not the matrices themselves). **RECOMMENDED - operator must ratify: three parallel research lanes (ingestion, sharing, dialect), each starting by reading the existing 16 guides in `docs/migrations/snowflake/` (REF s15.5 says none were validated against the program), using the existing matrix row schema with five boundary verdicts and zero blanks, each row citing `file:symbol` or the search that found nothing, plus a corrections section re-measuring the lane's own input; `MATRIX-dialect.md` is explicitly the transpiler's scope statement. The cross-boundary refusal mechanism (REF s9.5) is decided here too: one program statement and one refusal point next to `lib/auth/tenant-boundary.ts`, with sharing/listings/clean-rooms/replication/reader-accounts routed through it, and a WR.2 row requiring it.**

**W0.B - D5 boundary truth + `docs/fiab/boundary-service-matrix.md`** (docs, needs web fetch of Microsoft audit-scope pages; every cell gets URL + date). D5 asks: is Azure Container Apps acceptable at IL4/IL5, and which reading of "DoD" does the program use? Evidence in repo: `il5.bicepparam:121` sets `containerPlatform = 'containerApps'` with a comment citing regional GA only, while `apps/fiab-mcp-bridge/README.md:75` says "Container Apps not at IL4+". Two repo files already contradict each other. REF s7.2 cites Microsoft's Feb 2026 audit-scope table listing ACA at FedRAMP High and IL2 but not IL4/IL5WI; AKS in all columns. **RECOMMENDED - operator must ratify, after W0.B re-fetches the table: treat ACA as not established at IL5 until the fetched table says otherwise; make AKS the IL5 design (so no $0-idle assumption at IL5) unless the operator accepts the risk in writing; "DoD" means US Gov regions at IL5WI with a named IL6 gap (REF s13 #3).** If the fetched table disagrees with REF s7.2, write what was fetched, not the REF.

**W0.C - Docs corrections** (docs). `feature-mapping-complete.md`: Databricks SQL warehouses are not available in `usgovva`/`usgovaz`; Gov cell reads Synapse dedicated pool with the concurrency ceiling as a number, or "not available" (REF s7.5). `federal-migration-guide.md` + `why-azure-over-snowflake.md`: replace "Snowflake isn't in Gov" with the four differentiators in REF s7.1 / s14. `mirrored-database*.md`: re-grade row 20 on deployed evidence, Gov stays "unverified" (confirm the Commercial deploy SHA from `gh` before writing it; REF cites `4d4fd0b92c`).

**W0.D - Bicep truth fixes, one PR, serialized** (`touches_bicep: yes`). (1) Delete the stale "SPNs cannot create CA" claim in `conditional-access.bicep` (~line 11) and replace with the verified Graph application-permission path. (2) `il5.bicepparam`: remove the "Front Door not IL5-certified" comment (line ~8), re-decide `frontDoorEnabled` against the fetched table (W0.B), fix the line-121 comment per D5. (3) Fix the `loom-mcp` naming collision in ONE change: rename the mis-mapped image target to `loom-azmcp`, add a real `loom-mcp` target from `./apps/loom-mcp`, repoint the Container App in `main.bicep` in the same PR or the roll crash-loops. Receipt: a build run with two distinct images. Merged is not done: report "merged, not deployed" until the roll is verified on the estate (the operator runs stale-estate deploys; REF memory).

**W0.E - Housekeeping** (docs). (1) The two superseded matrices are stamped (`MATRIX-compute-warehouses.md`, `MATRIX-storage-optimization.md` carry a first-line SUPERSEDED pointer; this was applied in the 2026-11-14 audit draft, W0.E verifies it with `head -1` and fixes any drift). (2) Reconcile `MATRIX-governance.md` (declared 36, parse finds 35) and `MATRIX-mcpagentic.md` (rollup 0/23/7, parse 0/24/6): find the row, fix the matrix, state one number. (3) Regenerate the hub's matrix table and the REF s2 totals (365 changes if either matrix changes). (4) If any `WR` matrix lands, update the hub coverage table.

## Validation
- `python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root <repo>` exits 0.
- `grep -c "RECOMMENDED - operator must ratify" PRPs/backlog/snowflake-parity/W0-DECISIONS.md` returns >= 5 (D1, D2, replication-group, D3, D4, D5 give 6; fails at < 5). `grep -c "^RATIFIED" ...` returns 0 until the operator adds lines.
- `grep -rn "SPNs cannot create CA" platform/fiab/bicep` returns 0. `az bicep build` on the edited modules passes (`make validate-bicep`).
- Tally check: a mechanical row count of each corrected matrix equals the number in its header (name the command used in the PR).
- Boundary receipts: no Gov run is needed (docs + comments); the one deploy-touching item (W0.D) states "merged, not deployed" until the Commercial roll shows two images. GCC is supported-in-code, never exercised; do not list it as verified.

## Rollback
Docs and comments: `git revert`. W0.D image rename: revert the single PR (workflow + bicep repoint together; do not revert only one half).

## Docs to update
`docs/migrations/snowflake/*` (W0.C), `docs/fiab/boundary-service-matrix.md` (new), `docs/fiab/parity/mirrored-database*.md`. If D1-D5 are ratified, `docs/adr/` gets a short record per decision pointing at `W0-DECISIONS.md`.

## Wave / Blocked-by / Branch / Worktree
Wave: 0 · Blocked-by: none (operator ratification gates the *downstream* waves, not this PRP's drafting) · Branch: `docs/snowflake-w0-decisions` (W0.A-C, E) and `fix/snowflake-w0-bicep-truth` (W0.D) · Worktree: `E:/Repos/_snowflake-w0`

## Hot files
`il5.bicepparam`, `conditional-access.bicep`, `admin-plane/main.bicep`, both build-fiab-images workflows (all W0.D only). `touches_bicep: yes` (W0.D only; W0.A-C, E: no).

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W0.A decisions D1-D4 | todo | | opus | | 2026-11-14 |
| W0.B boundary table + D5 | todo | | sonnet | | 2026-11-14 |
| W0.C docs corrections | todo | | sonnet | | 2026-11-14 |
| W0.D bicep truth fixes | todo | | sonnet | | 2026-11-14 |
| W0.E housekeeping | todo | | sonnet | stamps drafted 2026-11-14, unverified | 2026-11-14 |

## Kickoff prompt
Read PRPs/backlog/snowflake-parity/PRP.md, this file, then REFERENCE-2026-08-25-full-draft.md sections 9, 7.2, 13 and 15 only.
Run W0.A first: write W0-DECISIONS.md with D1-D4, each labelled "RECOMMENDED - operator must ratify" and an empty RATIFIED line; never record anything as decided.
Re-measure each cited row against origin/main before using it. W0.B must fetch Microsoft's audit-scope pages; cite URL + date per cell.
Stop and ask the operator before W0.D touches main.bicep (bicep ledger slot).
Proof of done: prp_index.py check exits 0, grep for "SPNs cannot create CA" in platform/fiab/bicep returns 0, W0-DECISIONS.md has >= 5 RECOMMENDED labels.
