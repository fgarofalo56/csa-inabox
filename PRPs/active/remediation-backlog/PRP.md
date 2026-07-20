# PRP — Remediation & Enhancement Backlog (docs-trust, health depth, deferred closures, maintainability, quality ratchets, corpus perf, readiness UX, type-hardening, golden-path)

**Status:** DRAFT (validated, execution-ready — 2026-07-20). Author: prp-author agent.
**Origin:** converts `PRPs/active/CSA-LOOM-REMEDIATION-BACKLOG-PRD-2026-07-20.md` (32 items,
WS-A..WS-J) into a single validated PRP, cross-referenced against what has ALREADY shipped so
nothing is re-planned. This is a **validation + planning** artifact — it plans work; it does
not build features.

**Cross-references (authoritative):** `PRPs/active/OPEN-REGISTER-2026-07-12.md` (RE-BASELINE
2026-07-20), `temp/ask-audit-2026-07-20.md`, `temp/runpath-verdicts-2026-07-20.md`,
`docs/fiab/health-coverage-audit.md`, `PRPs/active/foundry-parity/AUDIT.md`,
`PRPs/active/access-governance/PRP.md`, `PRPs/active/geo-graph-ml/PRP.md`. Every status below
was confirmed by grepping the code on branch `origin/main` at rev 6ad66c4e — not from docs alone.

**Die-hard rules that bind every item here** (`.claude/rules/`):
- `no-vaporware.md` — real backend + bicep sync + real-data E2E receipt per merge; honest gates
  only, never fake green.
- `loom-no-freeform-config` (memory `loom_no_freeform_config`) — wizards / pickers / canvas, no
  raw JSON.
- `ux-baseline.md` — Fabric-grade floor; **G1** (browser E2E before "done"), **G2** (zero
  day-one gates; every gate has an inline Fix-it + gate-registry entry + Admin gate page),
  **G3** (resizable panels via `SplitPane` + `sizingKey`).
- `loom_default_on_opt_out` (memory) — features ON by default; the only gate is an honest Azure
  infra gate.
- `docs_source_of_truth` (memory) + `no-scaffold` — docs update every feature batch; DOM strings
  ≠ parity.
- `no-fabric-dependency.md` — Azure-native default; Fabric strictly opt-in. (Entra/Graph, ARM,
  ADX, Synapse, ASA, AAS, AML, Postgres, APIM are Azure — allowed.)

---

## (a) Current state — grounded in code (what is ALREADY done, so we don't re-plan it)

Two whole workstream areas from the PRD are **substantially already delivered** and must be
dropped or reduced to residuals:

1. **Gates registry (WS-B3) is DONE.** `apps/fiab-console/lib/gates/registry.ts` exists and is
   derived from the `ENV_CHECKS` declarative backbone; `lib/admin/gate-registry.ts` exports
   `GATES_REGISTRY_WIRED = true`; the Admin gate surface (`app/admin/gates/page.tsx`) and its API
   (`app/api/admin/gates/route.ts` + `[id]`) exist; a unit test pins GATE_META ↔ ENV_CHECKS
   coherence. Memory (`csa_loom_gates_zero_infra_push_2026_07_15`) records the registry at ~89
   gates, score 100. **The PRD's B3 "land + wire the registry" is closed.** What remains is
   *incremental normalization of legacy per-route codes* (folded into D2, not B3).

2. **Copilot corpus COVERAGE is DONE (today, #2249).** `lib/azure/loom-docs-index.ts` and
   `scripts/csa-loom/stage-copilot-corpus.sh` now ingest `PRPs/active/**` (was only
   `PRPs/completed/csa-loom-pillar/**`), and the stale `loom-vs-palantir-foundry.md` gap doc was
   re-baselined. This closes the ask-audit "Wave 0" corpus-content defect. **It does NOT close
   WS-G** — G1 (incremental/hash-based indexing), G2 (freshness guard), G3 (retrieval telemetry)
   are all still absent (`loom-docs-index.ts` has no hash/manifest/incremental path; the only
   hit-rate telemetry is the perf query-result-cache, unrelated to docs retrieval).

3. **Lakebase in-database query (WS-C1) is mostly DONE.**
   `app/api/items/lakebase-postgres/[id]/query/route.ts` executes caller-authored SQL over the
   **real pg wire protocol** with Entra-token auth and an honest 503 gate when
   `LOOM_POSTGRES_AAD_USER` is unset. The residual is a **stale banner-copy defect**:
   `lib/editors/lakebase-editor.tsx:437` still reads "In-database query not yet wired" when the
   config gate fires — misleading copy for what is now an honest, resolvable config gate. C1
   reduces to a copy/Fix-it fix, not a feature build.

4. **The functional-E2E bar the operator set on 07-20 is IN-FLIGHT.** Tasks #12/#13 (e2e-sweeper)
   drive every item type + app create→configure→publish→RUN→USE; `runpath-verdicts-2026-07-20.md`
   is the live ledger (A/B/C per type; 3 honest-gate defects already fixed via #2247; SWA publish
   fixed via #2244). **WS-F5's "expand E2E to newly-completed paths" overlaps this — reduce F5 to
   folding the *remediation-PRP-completed* paths into the existing sweep, do not stand up a new
   E2E program.**

5. **Access-management breadth and the geo engine are already their own PRPs** — do NOT re-scope
   them here. `PRPs/active/access-governance/PRP.md` (task #16) and `PRPs/active/geo-graph-ml/PRP.md`
   (task #14) own those. This PRP's WS-C3 portal-AI and WS-C authored-content work must coordinate
   with **task #17** (content-authoring APIs, in-flight — `runpath-verdicts` "task #17": authored
   items need in-place content-authoring APIs; demo seeder should stamp content at install).

Everything else in the PRD is genuinely OPEN and confirmed absent in code (details in the ledger).

---

## Validation ledger — all 32 items with verified status

Legend: **DONE** (drop) · **PARTIAL** (reduced residual kept) · **IN-FLIGHT** (owned elsewhere) ·
**OPEN** (full scope kept).

| Item | Verdict | Evidence (rev 6ad66c4e) |
|---|---|---|
| **A1** Canonical metrics doc | OPEN | `docs/fiab/meta/` does not exist. Count drift is real: `apps/fiab-console/README.md` says "~117 editors / 22 categories"; health audit says "129 item types / 117 Azure clients". |
| **A2** Coverage claim mismatch | OPEN | `README.md:266` states `fail_under = 80` + "80% coverage gate"; `pyproject.toml:525` is `fail_under = 65`. Genuine contradiction. |
| **A3** Parity-doc freshness CI guard | OPEN | Only `scripts/ci/check-bicep-sync.mjs` + `check-health-coverage.mjs` exist; no `check-parity-doc-freshness.mjs`. |
| **A4** Parity-gap docs re-baseline | PARTIAL | `docs/fiab/parity-gap/**` exists but stale; #2249 re-baselined only the Foundry gap doc + corpus. `report.md`/`admin-usage.md`/`operations-agent.md` + the `Reviewed-on`/`Validated-against` metadata convention still open. |
| **B1** 8 missing live probes | OPEN* | No `probe-aas/aml/azure-sql/postgres/grafana/stream-analytics/eventgrid/batch` in `lib/admin/`. Health audit §5 lists all 8 as "next wave". *pending gov-medic scope reply — may be in-flight.* |
| **B2** Deep-exercise expansion | OPEN | `service-probes.ts` has 8 exercises; the 4 new (eventstream round-trip, Purview scan, Databricks-SQL, report-render) not added (health §5.8). |
| **B3** Gates registry wiring | **DONE** | `lib/gates/registry.ts` + `GATES_REGISTRY_WIRED=true` + `app/admin/gates` + API + coherence test. Memory: ~89 gates, score 100. |
| **B4** Safe healer expansion | OPEN | Healers today = 3 (`ensure-cosmos`, `ensure-search-index`, `ensure-spark-lease-container`). `ensure-eventhub-consumer-group` + `ensure-adx-default-db` absent. |
| **C1** Lakebase in-db query | PARTIAL | Query route wired to real pg wire + honest gate. Residual: stale "not yet wired" banner copy in `lakebase-editor.tsx:437` → reframe as honest Fix-it gate. |
| **C2** Report subscriptions runtime | PARTIAL | UI + Cosmos + `report/[id]/subscriptions` + `[subId]/logs` routes exist; NO delivery timer Function in `azure-functions/` (only `paginated-report-renderer`). Delivery execution path missing. |
| **C3** Portal AI mode controls | OPEN | `portal/shared/api/routers/ai.py` falls back to `model="demo-stub"`; no `AI_MODE=disabled|demo|live`, no machine-readable readiness on `/api/v1/ai/status`. |
| **D1** Route-handler toolkit | OPEN | No `withSession`/`withBackendGate`/`withWorkspaceOwner`/`apiHonestGateError` helpers. Per-item `_shared` (`authItem`, `requireBoundServer`) + `respond.ts` (`apiOk/apiError/apiHonestError`) are partial primitives to build on. |
| **D2** Gate semantics normalization | PARTIAL | Registry carries `legacyCodes` mapping (spec-level normalization); route-level unified envelope not adopted. Keep as incremental route-family migration reusing the registry codes. |
| **D3** API registry / route taxonomy | OPEN | No route-inventory generator in `scripts/`. |
| **E1** Large-file decomposition | OPEN | All 5 targets present & huge: lakehouse-editor-shell 5227, report-designer 5135, semantic-model-editor 4576, notebook-editor 3875, apim-editors 3580 LOC. |
| **E2** Content-bundle externalization | OPEN | `lib/apps/content-bundles/*.ts` are multi-thousand-line TS (e.g. `app-supercharge-gold.ts` >3700 lines of embedded notebook JSON). |
| **E3** Complexity/size guardrail | OPEN | No size/complexity CI guard in `scripts/ci/`. |
| **F1** Coverage transparency | OPEN | Same mismatch as A2 (README 80 vs pyproject 65); no per-release machine-generated coverage summary. |
| **F2** Remove ignored Python suites | OPEN | `pyproject.toml:474` still `--ignore=csa_platform/streaming/tests --ignore=csa_platform/multi_synapse/tests`; both dirs have real tests. |
| **F3** Ratchet `fail_under` | OPEN | Currently 65; staged 65→68→70→75 not started. |
| **F4** Vitest thresholds + toolkit tests | OPEN | Depends on D1; no route-toolkit tests exist yet. |
| **F5** E2E route expansion | IN-FLIGHT | Owned by tasks #12/#13 (e2e-sweeper) + `runpath-verdicts`. Reduce to folding remediation-completed paths into that sweep. |
| **G1** Incremental corpus indexing | OPEN* | `loom-docs-index.ts` has no hash/manifest/incremental path (full rebuild only). *pending corpus-fixer reply.* |
| **G2** Corpus freshness guard | OPEN* | No source-hash vs staged-hash startup/health signal. *pending corpus-fixer reply.* |
| **G3** Retrieval telemetry (docs copilot) | OPEN | Only perf `query-result-cache` hit-rate exists; no docs-retrieval latency/hit-rate/freshness/fallback metrics. |
| **H1** Capability dependency graph | OPEN | No readiness/capability-graph surface. `/admin/health` (104 checks) + gate registry are adjacent but not a feature→backend/env/RBAC/probe graph. |
| **H2** Workload readiness scorecard | OPEN | `health-coverage.ts` derives per-family checks (adjacent) but no go/no-go Ready/Partial/Blocked scorecard. |
| **H3** Ready-to-run tenant profile export | OPEN | No exportable readiness report. |
| **I1** Replace `Any\|None` client TODOs | OPEN | TODO-typed clients present in all 4 target scripts (`generate_semantic_model.py`, `configure_sql_endpoint.py`, `workspace_manager.py`, `cost_allocator.py`). |
| **I2** SDK typing strategy doc | OPEN | `docs/developer/sdk-typing-strategy.md` absent. |
| **J1** One-command local profile | OPEN | No documented minimal golden-path profile. |
| **J2** Local profile validator | OPEN | No `scripts/dev/check-local-profile.*`. |

**Counts:** DONE 1 (B3) · PARTIAL 4 (A4, C1, C2, D2) · IN-FLIGHT 1 (F5) · OPEN 26.
*(B1, G1, G2 flagged OPEN* pending two teammate scope replies; if gov-medic/corpus-fixer own
them, reclassify to IN-FLIGHT — see report.)*

---

## (b) Wave plan (W-A..W-J) — sequenced by PRD P0/P1/P2, adjusted for what's already done

Each wave ships per the binding rules: real backend, bicep sync where infra changes, an inline
Fix-it for any honest gate (registered in `lib/gates/registry` + Admin gate page per G2), a
browser E2E receipt per G1, docs updated per `docs_source_of_truth`, and `ux-standards §7`
checklist green for any touched surface.

### W-A — Documentation Trust & Freshness  *(PRD P0; WS-A + F1)*
- **A1** Author `docs/fiab/meta/canonical-metrics.md` as the single source for item-type count,
  editor→slug map, health-check count, and coverage thresholds; reconcile the 117-vs-129 drift
  by deriving from `lib/catalog/` + `lib/editors/registry.ts` + `ENV_CHECKS`. Link `README.md`,
  `apps/fiab-console/README.md`, and priority parity/health docs to it.
  *Acceptance:* zero contradictory counts across core docs; all link to canonical.
- **A2 / F1** Correct `README.md` coverage wording to match `pyproject.toml` (65) + state the
  ratchet roadmap and gated-vs-measured scope. *Acceptance:* README ≡ CI behavior exactly.
- **A3** Add `scripts/ci/check-parity-doc-freshness.mjs` (doc→source-glob map; **warn-first**,
  hard-fail after a grace window per Q1); wire into `.github/workflows/loom-guardrails.yml`
  beside the existing bicep-sync/health-coverage guards. *Acceptance:* actionable stale-file
  report; parity-touching PR requires a doc update or allowlist reason.
- **A4** Re-audit `docs/fiab/parity-gap/{report,admin-usage,operations-agent}.md` (Foundry gap
  doc already done #2249) + adopt the `Reviewed-on`/`Validated-against` metadata convention that
  A3 enforces. *Acceptance:* the 3 priority docs reflect current code; metadata validated in CI.
- **Rules:** `docs_source_of_truth`, `no-vaporware` (docs are product), `no-scaffold`.

### W-B — Operational Health Depth  *(PRD P1; WS-B minus B3)*
- **B1** Implement the 8 missing live probes (AAS, AML, Azure SQL, Postgres-Flex, Grafana,
  Stream Analytics, Event Grid, Batch) as bounded real calls as the Console UAMI, each on
  `/admin/health` with exact RBAC/env remediation. *(Confirm gov-medic ownership before starting
  — may already be in-flight.)*
- **B2** Extend `service-probes.ts` deep-exercise pane with eventstream publish→consume,
  Purview scan trigger, Databricks-SQL warehouse query, report render — bounded runtime.
- **B4** Add runtime-safe healers `ensure-eventhub-consumer-group`, `ensure-adx-default-db` —
  idempotent, dry-run capable, audited, role-limited (same pattern as the 3 existing healers).
- *(B3 dropped — DONE.)*
- **Acceptance:** each probe shows pass/fail/remediation; healers prove fail→heal→green in a unit
  test against injected SDK failure. **Rules:** `no-vaporware` (real Azure call, no invented
  green), G2 (remediation carries Fix-it), budget-aware probe timeouts (Q4).

### W-C — Deferred Feature Closures  *(PRD P1; WS-C — the two release-relevant ones first)*
- **C2** *(release-gating, Q2)* Stand up the report-subscription delivery path: a timer-triggered
  Function (Linux Y1, in-VNet, Console-UAMI) that executes due subscriptions, renders via the
  existing paginated-report-renderer, delivers, and writes execution telemetry the existing
  `[subId]/logs` route surfaces. Bicep: add the Function + role assignments; wire env; register
  on the Admin gate page. *Acceptance:* end-to-end scheduled delivery in a configured tenant;
  history reflects real outcomes.
- **C1** *(residual)* Reframe the `lakebase-editor.tsx:437` "not yet wired" banner as an honest
  config gate with an inline Fix-it (name `LOOM_POSTGRES_AAD_USER` + the `pgaadauth_create_principal`
  one-time step); register in the gate registry. Query runtime already works. *Acceptance:*
  no "not yet wired" copy on a configured tenant; the gate resolves via Fix-it.
- **C3** Add `AI_MODE=disabled|demo|live` to `portal/shared/api/routers/ai.py`; a production
  profile cannot silently stay in demo; `/api/v1/ai/status` returns machine-readable readiness +
  dependency reasons. Coordinate with **task #17** for the console-side authored-content parallel.
  *Acceptance:* prod profile blocks silent demo; status is machine-readable.
- **Rules:** `no-vaporware` (real delivery, honest gate), G2 (Fix-it), `no-fabric-dependency`
  (Azure-native default).

### W-D — API Route Architecture & Gate Standardization  *(PRD P1)*
- **D1** Build the route-handler toolkit (`withSession`, `withWorkspaceOwner`, `withBackendGate`,
  `apiHonestGateError`) on top of the existing `respond.ts` + per-item `_shared` primitives;
  migrate the top ~100 high-traffic routes first. *Acceptance:* ≥30% boilerplate LOC reduction
  in the migrated set, no behavior/test regression.
- **D2** *(residual)* Define the standard gate envelope (status/code/missing/remediation/docsLink)
  reusing the registry's canonical codes + `legacyCodes` map; migrate route families incrementally
  (ADF/APIM/AML/ADX…). *Acceptance:* migrated families share the schema; the editor gate renderer
  consumes them uniformly.
- **D3** Generate a diffable route inventory (owner-domain / dependency-backend / auth-scope /
  gate-behavior) in CI, published as a maintainer docs artifact. *Acceptance:* inventory
  regenerates in CI and is diffable.
- **Rules:** `no-vaporware` (one shared write path), `loom-no-freeform-config` (gates render as
  Fix-it, not raw errors).

### W-E — Maintainability / Monolith Decomposition  *(PRD P2)*
- **E1** Decompose the 5 targets (lakehouse-editor-shell, report-designer, semantic-model-editor,
  notebook-editor, apim-editors) into bounded contexts (sections / hooks / service adapters /
  validators); each < 1500 LOC or a justified exception; new modules get focused unit tests.
- **E2** Externalize the largest content-bundle payloads to versioned JSON/MD loaded via typed
  adapters. *Acceptance:* reduced TS parse/load; no seeded-app behavior regression.
- **E3** Add a CI file-length/complexity guard (**advisory-first**, Q3) for scoped paths with a
  documented escalation policy.
- **Rules:** behavior parity + test coverage preserved (`no-vaporware`), `ux-baseline` unchanged
  on touched surfaces.

### W-F — Test & Coverage Maturity Ratchet  *(PRD P1/P2)*
- **F2** Re-enable ignored suites one at a time — `csa_platform/streaming/tests`, then
  `csa_platform/multi_synapse/tests` — fixing blockers; remove the `--ignore` entries; CI green
  and deterministic.
- **F3** Ratchet `fail_under` 65→68→70→75, each bump gated on sustained margin and documented in
  the PR note; threshold only moves up.
- **F4** Add focused tests for D1's extracted hooks/utils + the route toolkit; raise Vitest
  thresholds incrementally per wave without a flake spike.
- **F5** *(reduced)* Fold remediation-PRP-completed paths (C2 delivery, B-probes, D1 toolkit
  routes) into the existing e2e-sweeper suites (tasks #12/#13) — do not stand up a new program.
- **Rules:** `no-vaporware` (deterministic tests before raising floors), incremental ratchet.

### W-G — Copilot Corpus & Docs-Index Performance  *(PRD P2 — corpus CONTENT already fixed #2249)*
- **G1** Hash-based incremental corpus staging/indexing in `loom-docs-index.ts` +
  `stage-copilot-corpus.sh`; persist a freshness manifest with build metadata; re-index only
  changed docs. *(Confirm corpus-fixer ownership first.)*
- **G2** Corpus freshness guard: a startup/health signal comparing source commit hash vs staged
  corpus hash; surface state + remediation on `/admin/health`.
- **G3** Docs-copilot retrieval telemetry (latency, hit rate, source freshness, fallback usage)
  via the existing monitoring channels.
- **Rules:** `no-vaporware` (real metrics), G2 (freshness surfaced as a health signal).

### W-H — Readiness UX  *(PRD P2)*
- **H1** Capability dependency graph admin panel: feature → backend services / env vars / RBAC /
  live-probe status; selecting a feature shows exact unmet prerequisites + Fix-it path (reuse the
  gate registry + `/admin/health` data — no invented state).
- **H2** Workload readiness scorecard (Data Factory, RTI, Governance, AI, …) with Ready /
  Partially Ready / Blocked buckets computed **only** from real checks/probes; drill-down to
  failing checks.
- **H3** Exportable ready-to-run tenant profile (JSON + human-readable MD) with timestamp,
  environment, failed dependencies, remediation snippets.
- **Rules:** `no-vaporware` (computed from real probes), `ux-baseline` (G1/G3), `web3-ui`.

### W-I — Type-Safety Hardening (platform scripts)  *(PRD P2)*
- **I1** Replace `Any|None`/TODO-typed SDK clients in the 4 target scripts with typed
  protocol wrappers; mypy-compliant signatures; narrowed exception handling; remove TODO markers.
- **I2** Author `docs/developer/sdk-typing-strategy.md` (protocol wrappers, typed factories,
  fallback patterns); reference it in contributor docs.
- **Rules:** `docs_source_of_truth`, type-check passes with explicit overrides only where
  unavoidable.

### W-J — Golden-Path Local Profile  *(PRD P2)*
- **J1** Documented one-command minimal fully-functional profile (minimal env vars, acceptable
  local fallbacks, deterministic known-good sample workspace state); new contributor reaches a
  known-good run in ≤30 min.
- **J2** `scripts/dev/check-local-profile.(ps1|sh|mjs)` validating node/python versions, required
  env, expected services, optional capabilities — pass/fail + clear fixes.
- **Rules:** `no-vaporware` (fallbacks disclosed), honest capability reporting.

---

## (c) Answers to the PRD's 5 open questions (section 13)

Each is a **RECOMMENDATION — confirm with operator**, chosen to match existing guardrails.

1. **Stale parity docs — hard-fail or warn-only?** → **Warn-first, then hard-fail after a grace
   window.** Matches how existing guardrails (bicep-sync, health-coverage) rolled out — advisory,
   then merge-blocking once the backlog is green. A3 ships warn-only; flip to fail once
   `docs/fiab/parity-gap/**` priority docs carry the metadata convention.
2. **Which deferred closures are release-gating?** → **Only C2 (report-subscription delivery
   runtime).** C1 is already functionally wired (copy residual), and C3 is a portal-side safety
   control, not a data-path. Everything else in WS-C..J is **non-blocking**. Rationale: C2 is the
   one item that presents a UI promise (scheduled delivery) with no working backend — a
   `no-vaporware` exposure. *(The PRD's suggested second blocker, Lakebase query, is already
   wired — so it drops off the release-gate list.)*
3. **Global file-size cap now, or advisory-first?** → **Advisory-first** (E3), with a documented
   escalation policy; convert to fail only for the scoped decomposed paths (E1) after they land,
   so the guard can't block unrelated work before the monoliths are split.
4. **CI budget for new probes / E2E?** → **Bounded per the existing budget-aware patterns.** Live
   probes use short `armGet`/`.show`-class calls with per-probe timeouts (matching the 24 existing
   live probes); deep exercises stay on the on-demand pane (not page-load); E2E additions ride the
   existing UAT/e2e-sweeper pipeline, no new always-on job.
5. **Readiness score gates release eligibility?** → **Advisory, not release-gating initially.**
   The scorecard (H2) is computed from real probes and is informative; making it a hard release
   gate risks environment-specific false-blocks. Revisit once H1/H2 have a few releases of signal.

---

## (d) Non-goals

- **Not** re-planning access-management breadth (owned by `access-governance/PRP.md`, task #16) or
  the geo/ArcGIS engine (owned by `geo-graph-ml/PRP.md`, task #14).
- **Not** re-landing the gates registry (B3 DONE) or re-fixing corpus content coverage (#2249 DONE).
- **Not** a framework re-architecture; decomposition (E1/E2) preserves behavior + tests.
- **Not** removing honest gates where a backend dependency is genuinely optional/unavailable.
- **Not** standing up a parallel E2E program — F5 rides tasks #12/#13.
- **No** raw-JSON config anywhere introduced (`loom-no-freeform-config`); every new gate is a
  wizard/Fix-it.

## Verification per merge (binding)
Real-data E2E receipt in the PR (endpoint + first-300-char response + dark/light screenshot or
Playwright trace + bicep diff for infra), gate-registry + Admin-gate entries for any honest gate,
updated docs, and — for touched surfaces — a green `ux-standards §7` checklist. A wave is done
only when every box is real-backend E2E'd with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.
