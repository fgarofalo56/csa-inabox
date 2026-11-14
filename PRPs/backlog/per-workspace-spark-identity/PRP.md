---
name: per-workspace-spark-identity
status: backlog
priority: P2
order: 1
depends_on: []
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-10-02
---

# PRP (hub): Per-workspace Spark compute identity

Hub for 12 wave PRPs (`spark-id-W00` .. `spark-id-W12`; original W5+W6 are merged into W05, so there is no W06 file). Design, inventory of
the 27 Spark call sites, platform constraints, options and decisions Q1-Q10 live in [REFERENCE.md](REFERENCE.md); do not restate them.
TRACKING ISSUE: to be created by orchestrator per wave.

Status correction 2026-11-14: the previous frontmatter said both `status: backlog` and `shipped: 2026-10-02`. That was wrong. Nothing
is shipped: no W0 receipt, no spike report and no GitHub issue exist, and the product flag and ratchets are absent (see "What exists").

## Goal
Every workspace-scoped Spark job runs as a per-workspace user-assigned identity (`uami-ws-<workspaceId>`) whose storage grants cover only that
workspace's lakehouse roots, bound automatically and self-healing, in Commercial, GCC, GCC-High and IL5, with every stage reversible by flag.

## Why
Today every Spark workload shares one submitter and one Synapse MSI, both with account-scope data roles (REFERENCE.md 2.5): a user-code notebook in
one workspace can read another workspace's lakehouse. Operator decision 2026-09-30 approved option (b): shared pools, per-workspace submitter,
path-scoped grants (REFERENCE.md 4, 10).

## Scope / Non-goals
In: the 27 call sites (REFERENCE.md 2.1), abfss consolidation, client credential seam, token source, scoper, auto-bind, shadow/enforce, narrowing.
Out: BFF-side ADLS access (WS-I program), Spark catalog isolation (Q10), dedicated SQL identity, Databricks Unity Catalog (Q7), per-workspace pools (Q5).

## Acceptance criteria
- W00 report exists with a b1/b2 verdict per boundary. Fails if any boundary has no verdict or `not-exercised` reason.
- `grep -rn "LOOM_SPARK_IDENTITY_MODE" platform/fiab/bicep apps/fiab-console/lib | wc -l` is non-zero after W10; returns 0 today.
- `node scripts/ci/check-abfss-builder.mjs` and `node scripts/ci/check-spark-submit-identity.mjs` exit 0 after W01/W02; both files are absent today.
- Cross-workspace probe: a Spark session submitted as `uami-ws-A` reading workspace B's root returns HTTP 403 in each boundary where enforce is on. Fails on any 2xx.
- Program is done only when W12 receipts exist per boundary, or the boundary is explicitly recorded `not-exercised` (`cloud-parity.md`).

## Read first
`PRPs/backlog/per-workspace-spark-identity/REFERENCE.md`; `.claude/rules/cloud-parity.md`, `auto-bind-by-default.md`, `deploy-integrity.md`;
`docs/fiab/runbooks/workspace-identity-grants.md`, `workspace-identity-migration.md`; `apps/fiab-console/lib/azure/workspace-credential-factory.ts`.

## What exists (confirmed by path, 2026-11-14) and what does not
| Path | State |
|---|---|
| `apps/fiab-console/lib/azure/lakehouse-abfss.ts` | exists (`resolveLakehouseAbfss`, root-owner helpers) |
| `apps/fiab-console/lib/azure/workspace-credential-factory.ts` | exists (`credentialFor`, modes off/shadow/enforce for WS-I) |
| `apps/fiab-console/lib/azure/workspace-bindings.ts`, `workspace-identity-shadow.ts`, `workspace-identity-client.ts`, `workspace-grants.ts` | exist; no spark-lake backend |
| `apps/fiab-console/lib/panes/workspace-identity-panel.tsx` | exists (original text said `components/`) |
| `docs/fiab/runbooks/workspace-identity-{grants,migration}.md` | exist |
| `lib/azure/spark-lake-scoper.ts`, `scripts/ci/check-abfss-builder.mjs`, `scripts/ci/check-spark-submit-identity.mjs`, `LOOM_SPARK_IDENTITY_MODE` | NOT FOUND (no code, no bicep, no ci) |
| W0 receipt / spike report `docs/fiab/spikes/spark-identity-w0.md` / GitHub issue | NOT FOUND |

## Owns
This directory only: `PRP.md`, `REFERENCE.md`, `spark-id-W*.md`. Product files are owned per wave.

## Must NOT touch
Product code from the hub; `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md` (orchestrator). Note: `PRPs/MASTER-INDEX.md` currently points to
`active/per-workspace-spark-identity`; the PRP is in `backlog/` (orchestrator to fix).

## Consumes
WS-I program (`LOOM_WORKSPACE_IDENTITY_MODE`, modes off/shadow/enforce, `check-workspace-credential-adoption.mjs`); constrained RBAC Administrator on the Console UAMI (`storage-rbac-admin.bicep`).

## Provides
Least-privilege Spark storage access per workspace; `SparkLakeScoper`; `LOOM_SPARK_IDENTITY_MODE`; two CI ratchets.

## Steps
Wave graph (sequence by hot files, not just logic):
1. W00 spike (live, 4 boundaries). Everything else waits on it (decision: "only W0 may start").
2. After W00, in parallel (disjoint files): W01 (abfss + a few lakehouse routes), W02 (`synapse-dev-client.ts`, `synapse-livy-client.ts` + tag-only edits at call sites), W04 (token host; bicep).
   ASSUMPTION: W02 tag-only edits to call-site files do not collide with W01 if W01 merges first; if both are in flight, merge W01 before W02.
3. W03 (lakehouse routes; after W01 and W02) and W05 (scoper + Synapse RBAC; after W01; bicep).
4. W07 (auto-bind; after W03, W05) and W08 (pool; after W02, W04).
5. W09 (batch conversion; after W02, W03, W08) and W10 (mode flag; after W03, W07; bicep).
6. W11 (UI; after W07). W12 (narrowing; after W09, W10, W11, plus operational enforce + 14 clean shadow days; bicep).
Only ONE bicep-touching PR at a time across all programs (W04, W05, W10, W12; ledger in `PRPs/reference/INTERLOCK.md`).
Operational phases (shadow, enforce per workspace, boundary order Commercial, GCC, GCC-High, IL5 per Q8) are operator-flipped parameter changes recorded in the Execution state table.

## Validation
Per wave: its own Validation section. Program-level, after W10 and W12:
- `cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json`
- `python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .` exit 0
- Receipts per boundary (REFERENCE.md receipts table, original section 8): deployment name + correlation id, what-if, env-check JSON with the spark row, scope probe (inside OK, outside 403), shadow summary; greenfield AND brownfield.
Rule: Gov receipts come from Actions runs only. A merged wave is "merged, not deployed" until its live receipt exists. GCC is supported-in-code, never exercised; IL5 never produced a deploy receipt: mark both `not-exercised` explicitly.

## Rollback
Flag states of `LOOM_SPARK_IDENTITY_MODE` (introduced W10; before W10 nothing changes behaviour):
| State | Behaviour | Return path |
|---|---|---|
| `off` (default) | all submits as today (shared identity) | n/a |
| `shadow` | submits stay shared; mismatches logged | set `off` |
| `enforce` (allowlisted workspaces only) | submits as `uami-ws-<id>`; unhealable binding returns `spark-identity-binding-pending`, no fallback (Q4) | remove workspace from allowlist -> new sessions shared again; running sessions finish under their identity |
Grants are additive until W12; W12 rolls back by redeploying `account`. Allow hours: role assignment propagation and MI token caches.

## Docs to update
`docs/fiab/runbooks/workspace-identity-grants.md`, `workspace-identity-migration.md`, `docs/fiab/spikes/spark-identity-w0.md` (new), `docs/fiab/parity/spark-identity.md` (W11).

## Wave / Blocked-by / Branch / Worktree
Wave: program hub · Blocked-by: W00 (operator-held: sandbox + Gov Actions access) · Branch: per wave (see table) · Worktree: `E:/Repos/_spark-id-wNN`

## Hot files
`synapse-dev-client.ts`, `synapse-livy-client.ts` (W02 only), `spark-session-pool.ts` (W08 only), `lakehouse/*` routes (W01 then W03), `run-adapters.ts`, `taskflow/launch-item.ts` (W09 only),
`workspace-grants.ts` (W05 only), landing-zone bicep + `admin-plane/main.bicep` + `params/*.bicepparam` (W04, W05, W10, W12: one at a time). touches_bicep: yes (by those waves).

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md (hub) then spark-id-W00-spike.md and REFERENCE.md sections 2.5, 2.6, 3.
Run the nine W0 measurements in a sandbox (Gov only via Actions), filling docs/fiab/spikes/spark-identity-w0.md from the receipt template.
Do not start any other wave until W00 has a b1/b2 verdict per boundary. Proof of done: the report has no empty measurement cells.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W00 spike | todo | spike/spark-identity-w00 | sonnet | no receipt, no issue | 2026-11-14 |
| W01 abfss builder | todo | feat/spark-id-w01-abfss | sonnet | none | 2026-11-14 |
| W02 client credential | todo | feat/spark-id-w02-client | sonnet | none | 2026-11-14 |
| W03 lakehouse roots | todo | feat/spark-id-w03-roots | sonnet | none | 2026-11-14 |
| W04 token source | todo | feat/spark-id-w04-token | sonnet | none | 2026-11-14 |
| W05 scoper + Synapse RBAC (was W5+W6) | todo | feat/spark-id-w05-scoper | sonnet | none | 2026-11-14 |
| W07 auto-bind + backfill | todo | feat/spark-id-w07-autobind | sonnet | none | 2026-11-14 |
| W08 session pool keying | todo | feat/spark-id-w08-pool | sonnet | none | 2026-11-14 |
| W09 batch conversion | todo | feat/spark-id-w09-batch | sonnet | none | 2026-11-14 |
| W10 shadow + mode flag | todo | feat/spark-id-w10-shadow | sonnet | none | 2026-11-14 |
| W11 admin UI + runbook | todo | feat/spark-id-w11-ui | sonnet | none | 2026-11-14 |
| W12 narrow shared grants | todo | feat/spark-id-w12-narrow | sonnet | none | 2026-11-14 |
