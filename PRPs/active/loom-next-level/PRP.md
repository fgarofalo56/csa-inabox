# PRP — Loom Next Level (2026-07-22)

**Program:** take CSA Loom from "unbelievably broad B+" to "defensible A" by pointing a
full cycle at the five structural gaps identified in the 2026-07-22 brutally-honest
review: verification depth, convention adoption lag, analyst-surface depth,
blast-radius/isolation, and the product having no eyes on itself in production —
plus the approved repo restructure and the capability additions (Copilot evals,
cost intelligence, column-level lineage, DR drills).

**Operator scoping decisions (2026-07-22, recorded verbatim):**

1. **Cloud matrix:** build + validate on the two live estates — **Commercial**
   (centralus, sub `e093f4fd`) and **Azure Government GCC-High** — with
   **IL5/air-gapped as a design constraint**: every item documents its IL5
   adaptation (no public endpoints, offline corpus, alternate services) without
   standing up an IL5 estate now. Azure China out of scope.
2. **Repo restructure:** **in-repo `legacy/` grouping** of the frozen
   CSA-in-a-Box trees (reversible, no new repo), with coordinated
   CI/mkdocs/pyproject path updates. See WS-R Area 5.
3. **Per-workspace identity:** **phased shadow → enforce.** Phase A ships
   provisioning + shadow-mode divergence audit on both clouds; Phase B flips
   enforcement per-workspace behind a gate.

## Workstream index (77 items across 5 appendix files)

| WS | Appendix | Items | One-liner |
|----|----------|-------|-----------|
| **WS-V** Verification depth | [ws-verification-dr.md](ws-verification-dr.md) | V1–V4 | Synthetic in-VNet user journeys (incl. TRUE MSAL login probe), visual regression light+dark × 25 hubs, axe-core contrast ratchet, page.tsx route-smoke ratchet |
| **WS-DR** DR drills as CI | [ws-verification-dr.md](ws-verification-dr.md) | DR0–DR4 | ADLS versioning enablement (found OFF), Cosmos PITR / ADLS / KV restore drills, quarterly orchestration + /admin/dr-drills |
| **WS-R** Convention ratchets | [ws-ratchets.md](ws-ratchets.md) | R1–R27 | Route-toolkit codemod + forbidding ratchet (1,356 hand-rolled routes baselined), editor-size ratchet + decompositions, typed client generation, shared editor-state hook, `legacy/` repo restructure |
| **WS-E** Copilot eval harness | [ws-copilot-cost.md](ws-copilot-cost.md) | E1–E6 | Golden Q/A per surface, copilot-evaluator Function (retrieval hit-rate + LLM-judge grounding), score-floor ratchets, corpus-change gating, /admin/copilot-quality, tier-router evals |
| **WS-C** Cost intelligence | [ws-copilot-cost.md](ws-copilot-cost.md) | C1–C4 | Cost Management hardening, real Forecast API (+fallback), cost-anomaly-monitor Function with alerts, /admin/finops upgrade w/ real Budgets CRUD |
| **WS-L** Column-level lineage | [ws-lineage-depth.md](ws-lineage-depth.md) | L1–L7 | columnMappings schema foundation, OpenLineage Spark listener, ADF Copy-mapping derivation, Purview Atlas columnMapping push, column fan-out canvas + impact analysis, dbt manifest, UC/Gov-OSS rebase |
| **WS-A** Analyst-surface depth | [ws-lineage-depth.md](ws-lineage-depth.md) | A1–A13 | Real DAX parser/AST → SQL folding + 20 functions + golden numeric harness vs Power BI; report depth (small-multiples renderer, analytics pane, Gov map fallback, drill-through); Spark reliability (dashboard, FAULTED auto-recovery, quotas, chaos drill) |
| **WS-I** Per-workspace identity | [ws-identity-cloudmatrix.md](ws-identity-cloudmatrix.md) | I1–I8 | Activate the DORMANT scaffolding (workspace-identity-client.ts + workspace-identity.bicep): provision-on-create/delete-cascade, scoped data-plane grants, shadow divergence audit into the live PDP store, credential-factory adoption ratchet, per-workspace enforce + migration runbook |
| **§X** Cloud matrix (cross-cutting) | [ws-identity-cloudmatrix.md](ws-identity-cloudmatrix.md) | X1–X3 | cloud-endpoints adoption ratchet (module exists, 1,339 lines), Learn-verified per-service availability matrix, structured `availability:{commercial,gccHigh,il5}` on ENV_CHECKS → automatic honest gates |

## Ground-truth corrections the drafting audit surfaced (these override stale memory/docs)

1. **Azure Analysis Services IS GA in Azure Government** (FedRAMP High / IL4 / IL5,
   Learn-verified) — the current `isGovCloud()` block and the "AAS not in Gov"
   assumption are WRONG. A4 lifts the block behind verification.
2. **Per-workspace identity is scaffolded, not greenfield** —
   `lib/azure/workspace-identity-client.ts` and
   `platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep` exist dormant.
3. **`lib/azure/cloud-endpoints.ts` already centralizes cloud detection/suffixes**
   (Commercial/GCC/GCC-High/DoD) — X1 is an adoption ratchet, not a build.
4. **The real route-toolkit gap is 1,356 hand-rolled routes** (of 1,541), not ~310.
5. **ADLS `isVersioningEnabled: false` in storage.bicep** — DR0 enables it; Cosmos
   PITR (Continuous7Days) and KV soft-delete + purge protection are already on.
6. **Column lineage exists today only for Databricks UC**; Purview and Weave/Thread
   edges are table-grain (no column fields).
7. **The loom-native DAX "evaluator" is 3 regexes** — everything beyond
   EVALUATE/TOPN/ROW/CALCULATE+simple aggs needs AAS today. WS-A items A1–A5 make
   it a real engine.
8. **The report designer already has 25 visuals + conditional formatting +
   cross-filtering** — depth items target real gaps (small-multiples rendering,
   analytics pane, Gov maps, drill-through), not re-builds.

## Universal acceptance standards (every item, no exceptions)

- **G1:** in-browser E2E receipt with real data (minted session + where auth-path
  relevant, the true MSAL probe). tsc + vitest + DOM strings are NOT completion.
- **G2:** every new env var in `lib/admin/env-checks.ts` ENV_CHECKS **and**
  `lib/gates/registry.ts` with a Fix-it wizard; env-count pin test updated.
- **G3 + ux-baseline:** SplitPane w/ persisted sizingKey on new panes; node
  compactness; tokens only (no raw px/hex); TileGrid/EmptyState primitives.
- **bicep-sync:** every new Azure resource/role/env lands in
  `platform/fiab/bicep/**` + the appropriate orchestrator + bootstrap workflow.
- **Ratchet convention:** every floor/baseline (coverage, a11y, route-toolkit,
  cloud-endpoints, editor size, eval scores) is set from measured reality and
  moves only toward the target; the ratchet file lives in-repo and CI enforces it.
- **Per-cloud contract:** each item ships Commercial (live receipt) + GCC-High
  (live receipt or Learn-cited honest gate w/ fallback) + an IL5 design note
  answering the §X.4 air-gap checklist (7 items).
- **no-vaporware / no-fabric-dependency / ui-parity** die-hard rules apply as written.

## Dependency spine & execution phases

**Phase 0 — foundations (parallel):**
- V1 synthetic journeys (the single highest-value item in the program)
- DR0 ADLS versioning; R1 toolkit gap-fill (withTenantAdmin/withDlzAccess);
  R7 file-size re-baseline; X3 structured availability on ENV_CHECKS;
  E2 copilot-evaluator Function; C1 cost-client hardening; L1 columnMappings schema;
  I1 identity provision-on-create (shadow plumbing prereq)

**Phase 1 — gates online (parallel, after their Phase-0 prereq):**
- V2 visual regression; V3 a11y ratchet; V4 route-smoke ratchet
- R2 codemod → R3 forbidding ratchet; R15 typed client map (Tier 1)
- E1 golden sets + E4 corpus-change gating; C2 forecast; L2 Spark OpenLineage;
  A10 Spark dashboard; I2 scoped grants → I3 shadow audit; DR1–DR3 drills

**Phase 2 — depth + surfaces:**
- A1–A5 DAX engine (A5 golden harness gates A1–A3 merges); A6–A9 report depth;
  L3–L5 (ADF mappings, Purview push, column canvas); E5 admin quality page;
  C3 anomaly monitor → C4 finops hub; I4 shadow UI + I5 credential factory
  (adoption ratchet); DR4 orchestration + admin surface; R4–R6 route batches;
  R8–R12 editor decompositions (R18 editor-state hook BEFORE R10)

**Phase 3 — enforcement + structure:**
- I6 per-workspace enforce + I7 migration runbook (only after ≥2 weeks of clean
  shadow data); L6 dbt + L7 UC rebase; A11–A13 Spark auto-recovery/quota/chaos;
  E6 tier-router evals; R20–R27 `legacy/` restructure (one tree per PR, examples/
  stays at root per recommendation); X1 cloud-endpoints ratchet drain

**Hard ordering constraints:** R1→R2→R3; R18 before R10; A5 harness before A1–A3
merge; I1→I2→I3→I4; I6 gated on shadow-data cleanliness; V2 baselines land only
after #2382 (dark-theme fix) is deployed (else baselines bake the bug in);
serialize items touching `cost-client.ts`, shared admin nav, or the same editor.

## Verification of the program itself

The program is DONE when: all 77 items merged with receipts; the synthetic-journey
job has run green ≥7 consecutive days on BOTH clouds; the visual-regression and
a11y gates have each caught-or-passed a full release cycle; shadow-mode identity
reports zero unexplained divergences for 2 weeks; the DAX golden harness passes
vs Power BI on the seeded models; and a quarterly DR drill has completed green
end-to-end on Commercial + Gov. Grade target: every touched surface A/A+ per
ux-standards §7, zero ❌ parity rows introduced.
