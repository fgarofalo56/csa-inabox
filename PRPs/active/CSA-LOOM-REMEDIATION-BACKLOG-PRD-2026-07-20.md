# CSA Loom Remediation & Enhancement Backlog PRD

- **Date:** 2026-07-20
- **Author:** PI coding agent (deep-dive synthesis)
- **Status:** Draft for PRP conversion
- **Scope:** Repository-wide remediation plan for gaps, missing features, refactors, and enhancements identified in the deep-dive review
- **Primary path:** `E:\Repos\GitHub\csa-inabox\PRPs\active\CSA-LOOM-REMEDIATION-BACKLOG-PRD-2026-07-20.md`

---

## 1) Executive summary

This PRD defines a **complete, concrete remediation feature backlog** for all issues/opportunities identified in the review:

1. **Docs trust drift** (contradictory/stale counts, thresholds, parity docs)
2. **Feature depth gaps** (deferred/gated surfaces still requiring backend completion)
3. **API sprawl and repeated gate boilerplate**
4. **Monolithic high-LOC files** reducing maintainability
5. **Test/coverage maturity gaps**
6. **Operational health probe gaps**
7. **Copilot corpus indexing/staging scalability improvements**
8. **UX enhancements for readiness/dependency visibility**
9. **Type-safety hardening of platform scripts**
10. **Golden-path local/dev profile for faster onboarding**

This backlog is structured to be directly transformed into one or more PRPs with clear acceptance criteria, dependencies, and sequence.

---

## 2) Problem statement

CSA Loom has broad capability coverage and strong guardrail intent, but current scale introduces risks:

- Product/docs trust degrades when public claims diverge from code/test reality.
- The app has many honest gates (good) but still leaves high-value user paths “configured-but-not-complete.”
- Route and file sprawl increases change risk, review burden, and defect probability.
- Coverage thresholds and ignored suites are not yet aligned with stated maturity targets.
- Missing live probes leave blind spots for operator confidence.

---

## 3) Goals and non-goals

### Goals

- Establish a **single trustworthy narrative** across docs, code, and CI.
- Close high-impact deferred feature paths and operational blind spots.
- Reduce maintenance risk via route architecture and file decomposition.
- Raise quality floors through measurable test/coverage ratchets.
- Improve operator and tenant admin experience with explicit dependency/readiness UX.
- Provide a backlog with enough precision to execute via PRPs without re-discovery.

### Non-goals

- Re-architect the full product into a new framework.
- Deliver complete parity with every external product in one wave.
- Remove honest gates where backend dependencies are genuinely optional/unavailable.

---

## 4) Source observations (what this PRD is based on)

- `README.md` coverage note vs `pyproject.toml` threshold mismatch.
- `apps/fiab-console/README.md` editor count vs live catalog/registry counts.
- Stale parity-gap docs contradicting shipped code (example: report/PBI references).
- `docs/fiab/health-coverage-audit.md` explicitly listing remaining probe gaps.
- High route/file scale in `apps/fiab-console/app/api` and large editor/client files.
- Existing guardrails (`check-health-coverage`, `check-bicep-sync`) are strong and should be extended.

---

## 5) Product principles for remediation

1. **No-vaporware remains mandatory**: honest gates, no fake green states.
2. **Docs are product**: stale docs are production defects.
3. **Guardrails over heroics**: automate drift detection.
4. **Incremental ratchets**: coverage/type strictness only moves forward.
5. **Operator-first reliability**: health and readiness are first-class features.

---

## 6) Workstream map

- **WS-A:** Documentation Trust & Freshness
- **WS-B:** Operational Health Coverage Completion
- **WS-C:** Deferred Feature Completion (High Impact)
- **WS-D:** API Route Architecture & Gate Standardization
- **WS-E:** Monolith Decomposition / Maintainability
- **WS-F:** Test & Coverage Maturity Ratchet
- **WS-G:** Copilot Corpus & Docs Index Performance
- **WS-H:** Readiness UX (Capability Graph + Tenant Score)
- **WS-I:** Type Safety Hardening (Platform scripts)
- **WS-J:** Golden-path Local Profile

---

## 7) Complete backlog (all items called out)

## WS-A — Documentation Trust & Freshness

### A1. Canonical metrics/claims inventory
**Problem:** conflicting claims across README/app docs/parity docs.

**Deliverables**
- `docs/fiab/meta/canonical-metrics.md` as single source for:
  - item types
  - editor mappings
  - health check counts
  - coverage thresholds
- Update references in:
  - `README.md`
  - `apps/fiab-console/README.md`
  - relevant parity/health docs

**Acceptance criteria**
- All top-level docs link to canonical metrics doc.
- No contradictory count/threshold claims in core docs.

---

### A2. Fix explicit coverage claim mismatch
**Problem:** README indicates 80% gate language while actual gate is 65 in current config.

**Deliverables**
- Align README wording to current truth + ratchet roadmap.
- Add explicit scope statement: which packages are gated vs measured-only.

**Acceptance criteria**
- README statements match `pyproject.toml` and CI behavior exactly.

---

### A3. Parity-doc staleness detector CI guard
**Problem:** parity-gap docs can become stale after feature shipping.

**Deliverables**
- `scripts/ci/check-parity-doc-freshness.mjs`:
  - maps doc -> source files
  - fails/warns when source modified after doc review date
- Integrate in `.github/workflows/loom-guardrails.yml`.

**Acceptance criteria**
- Guard emits actionable stale-file report.
- New feature PR touching parity surfaces requires doc update or explicit allowlist reason.

---

### A4. Parity-gap docs re-baseline wave
**Problem:** selected parity-gap docs contain outdated “missing” statements.

**Deliverables**
- Re-audit and update priority docs first:
  - `docs/fiab/parity-gap/report.md`
  - `docs/fiab/parity-gap/admin-usage.md`
  - `docs/fiab/parity-gap/operations-agent.md`
- Add `Reviewed-on` and `Validated-against` metadata convention.

**Acceptance criteria**
- Priority docs reflect current code paths and dependencies.
- New metadata convention applied and validated in CI.

---

## WS-B — Operational Health Coverage Completion

### B1. Implement top-priority missing live probes (from health audit)
**Problem:** env-gates exist but live probes still missing for key services.

**Deliverables (probe endpoints/check IDs + UI)**
1. AAS live probe
2. AML workspace live probe
3. Azure SQL live probe
4. PostgreSQL Flexible live probe
5. Grafana reachability probe
6. Stream Analytics ARM probe
7. Event Grid ARM probe
8. Batch ARM probe

**Acceptance criteria**
- `/admin/health` shows pass/fail/remediation for each probe.
- Probe failures include exact RBAC/env remediation.

---

### B2. Deep exercise expansion
**Problem:** self-audit coverage improved, but end-to-end service-exercise coverage still partial.

**Deliverables**
- Extend `service-probes.ts` with:
  - eventstream publish→consume roundtrip
  - Purview scan trigger exercise
  - Databricks SQL warehouse query exercise
  - report render exercise

**Acceptance criteria**
- On-demand exercise panel includes above tests with bounded runtime.

---

### B3. Gates registry wiring completion
**Problem:** bridge exists but full wiring depends on registry landing.

**Deliverables**
- Land and wire `lib/gates/registry.ts` integration.
- Flip bridge flags and enforce coherence via existing CI.

**Acceptance criteria**
- Gate registry active and validated in guardrails.

---

### B4. Safe healer expansion
**Problem:** healer only handles current limited idempotent fixes.

**Deliverables**
- Add runtime-safe healers:
  - `ensure-eventhub-consumer-group`
  - `ensure-adx-default-db`

**Acceptance criteria**
- Healer actions are idempotent, dry-run capable, audited, and role-limited.

---

## WS-C — Deferred Feature Completion (High Impact)

### C1. Lakebase in-database query path completion
**Problem:** editor currently warns “In-database query not yet wired.”

**Deliverables**
- Implement query endpoint + editor integration for bound server/db.
- Include validation, timeout, row cap, and clear failure remediation.

**Acceptance criteria**
- User can run query from Lakebase editor when configured.
- Honest gate remains only for truly unconfigured dependencies.

---

### C2. Report subscriptions operational completion
**Problem:** UI stores subscription data but delivery depends on missing timer/function + logic app wiring.

**Deliverables**
- Deploy and wire report-subscription timer execution path.
- Ensure delivery telemetry and failure history are visible in UI.

**Acceptance criteria**
- End-to-end scheduled delivery works in configured tenant.
- History/status reflects real execution outcomes.

---

### C3. Portal AI demo-stub hardening path
**Problem:** portal AI routes fall back to `demo-stub` when not configured.

**Deliverables**
- Add explicit mode controls:
  - `AI_MODE=disabled|demo|live`
- Improve status endpoint to return readiness + dependency reasons.
- Ensure docs clearly define demo vs production posture.

**Acceptance criteria**
- Production profile cannot silently remain in demo mode.
- `/api/v1/ai/status` includes machine-readable readiness detail.

---

## WS-D — API Route Architecture & Gate Standardization

### D1. Introduce route-handler toolkit
**Problem:** repeated auth/gate/error patterns across many route files.

**Deliverables**
- Create helper framework (examples):
  - `withSession()`
  - `withWorkspaceOwner()`
  - `withBackendGate()`
  - `apiHonestGateError()`
- Apply to top 100 high-traffic routes first.

**Acceptance criteria**
- 30% reduction in boilerplate LOC in migrated route set.
- No regression in existing behavior/tests.

---

### D2. Gate semantics normalization
**Problem:** similar gate scenarios sometimes use different statuses/payload shapes.

**Deliverables**
- Define standard gate envelope schema (status, code, missing, remediation, docsLink).
- Migrate route families incrementally (ADF/APIM/AML/ADX etc.).

**Acceptance criteria**
- Shared schema adopted by migrated families.
- Editor-side gate renderer can consume all migrated routes uniformly.

---

### D3. API registry and route taxonomy
**Problem:** very large API surface is hard to reason about as a system.

**Deliverables**
- Generate/maintain route inventory with metadata tags:
  - owner domain
  - dependency backend
  - auth scope
  - gate behavior
- Publish as docs artifact for maintainers.

**Acceptance criteria**
- Inventory generation runs in CI and is diffable.

---

## WS-E — Monolith Decomposition / Maintainability

### E1. Large-file decomposition program (Phase 1)
**Problem:** multiple 3k–5k+ LOC files impede maintainability.

**Priority targets (initial):**
- `lib/editors/lakehouse/lakehouse-editor-shell.tsx`
- `lib/editors/report-designer.tsx`
- `lib/editors/phase3/semantic-model-editor.tsx`
- `lib/editors/notebook-editor.tsx`
- `lib/editors/apim-editors.tsx`

**Deliverables**
- Split by bounded contexts: UI sections, hooks, service adapters, validators.
- Keep behavior parity and test coverage.

**Acceptance criteria**
- Each target reduced below 1500 LOC in phase 1 (or justified exception).
- New modules have focused unit tests.

---

### E2. Content bundle externalization
**Problem:** very large TS content-bundle files inflate compile/read overhead.

**Deliverables**
- Move static content payloads to versioned JSON/MD artifacts where practical.
- Load through typed adapters.

**Acceptance criteria**
- Reduced TS parse/load burden for largest bundle modules.
- No regressions in seeded app behavior.

---

### E3. Complexity/size guardrail
**Problem:** no preventive guard against files growing monolithic again.

**Deliverables**
- Add CI advisory/fail thresholds for file length and/or complexity for selected paths.

**Acceptance criteria**
- Guard emits actionable report; escalation policy documented.

---

## WS-F — Test & Coverage Maturity Ratchet

### F1. Coverage transparency alignment
**Problem:** mismatch between communicated and actual gates.

**Deliverables**
- Publish current baseline and target ratchet plan (Python + console Vitest).
- Add machine-generated coverage summary doc per release.

**Acceptance criteria**
- Coverage policy docs match CI behavior exactly.

---

### F2. Remove ignored Python suites (incremental)
**Problem:** ignored suites reduce confidence in ungated modules.

**Deliverables**
- Re-enable one ignored suite at a time:
  1. `csa_platform/streaming/tests`
  2. `csa_platform/multi_synapse/tests`
- Fix blockers and stabilize in CI.

**Acceptance criteria**
- `--ignore` entries removed for re-enabled suites.
- CI green with deterministic outcomes.

---

### F3. Ratchet Python `fail_under` with staged targets
**Problem:** current threshold at 65 below target maturity.

**Deliverables**
- Ratchet plan:
  - 65 → 68
  - 68 → 70
  - 70 → 75 (after scope readiness)
- Each bump gated on sustained margin policy.

**Acceptance criteria**
- Threshold only moves upward; each move documented in changelog/PR note.

---

### F4. Vitest threshold progression + route toolkit tests
**Problem:** console thresholds are low by design; need steady upward trend.

**Deliverables**
- Add focused tests for extracted hooks/utils and route toolkit.
- Raise thresholds incrementally with each successful wave.

**Acceptance criteria**
- Thresholds increased without spike in flakiness.

---

### F5. E2E a11y/load-bearing route expansion
**Problem:** major surfaces tested, but coverage should track feature growth.

**Deliverables**
- Expand Playwright suites for newly completed deferred paths and admin readiness surfaces.

**Acceptance criteria**
- New scenarios run in CI/UAT pipelines and produce artifacts.

---

## WS-G — Copilot Corpus & Docs Index Performance

### G1. Incremental corpus staging/indexing
**Problem:** large staged corpus can cause expensive rebuild/index cycles.

**Deliverables**
- Hash-based incremental corpus sync/index build.
- Freshness manifest persisted with build metadata.

**Acceptance criteria**
- Re-index only changed docs on incremental runs.
- Staleness/freshness visible in diagnostics.

---

### G2. Corpus freshness guard
**Problem:** runtime corpus can lag source docs without obvious signal.

**Deliverables**
- Add startup/health signal comparing source commit hash vs staged corpus hash.

**Acceptance criteria**
- Admin health indicates corpus freshness state and remediation.

---

### G3. Retrieval telemetry for docs copilot
**Problem:** difficult to tune docs retrieval quality without operational telemetry.

**Deliverables**
- Add metrics: retrieval latency, hit rate, source freshness, fallback usage.

**Acceptance criteria**
- Metrics exposed via existing monitoring channels.

---

## WS-H — Readiness UX (Capability Graph + Tenant Score)

### H1. Capability dependency graph
**Problem:** users/operators can’t easily see per-feature dependency chain.

**Deliverables**
- New admin/readiness panel visualizing:
  - feature -> backend services
  - env vars
  - RBAC requirements
  - live probe status

**Acceptance criteria**
- Selecting a feature shows exact unmet prerequisites and fix path.

---

### H2. Workload readiness scorecard
**Problem:** health checks exist but no workload-level “go/no-go” summary.

**Deliverables**
- Introduce workload readiness scores (Data Factory, RTI, Governance, AI, etc.).
- Include confidence buckets: Ready / Partially Ready / Blocked.

**Acceptance criteria**
- Scorecard computed from real checks/probes only.
- Drill-down links to failing checks and remediations.

---

### H3. “Ready-to-run” tenant profile export
**Problem:** difficult to share readiness posture across teams.

**Deliverables**
- Exportable readiness report (JSON + human-readable markdown/pdf).

**Acceptance criteria**
- Report includes timestamp, environment, failed dependencies, remediation snippets.

---

## WS-I — Type Safety Hardening (Platform Scripts)

### I1. Replace `Any|None` client TODOs in target scripts
**Problem:** TODO-typed SDK clients in critical scripts increase runtime risk.

**Priority targets**
- `csa_platform/semantic_model/scripts/generate_semantic_model.py`
- `csa_platform/semantic_model/scripts/configure_sql_endpoint.py`
- `csa_platform/multi_synapse/scripts/workspace_manager.py`
- `csa_platform/multi_synapse/scripts/cost_allocator.py`

**Deliverables**
- Typed client protocols/wrappers.
- Mypy-compliant signatures and narrowed exception handling.

**Acceptance criteria**
- TODO markers removed in target files.
- Type-check passes with explicit stubs/overrides only where unavoidable.

---

### I2. SDK typing strategy doc
**Problem:** ad hoc typing workarounds cause inconsistency.

**Deliverables**
- `docs/developer/sdk-typing-strategy.md` with guidance:
  - Protocol wrappers
  - Typed factories
  - fallback patterns

**Acceptance criteria**
- Referenced in contributor/dev docs.

---

## WS-J — Golden-path Local Profile

### J1. One-command minimal fully-functional profile
**Problem:** local setup friction and dependency ambiguity.

**Deliverables**
- Provide a documented command/profile for:
  - required minimal env vars
  - local fallback services where acceptable
  - deterministic “known-good” sample workspace state

**Acceptance criteria**
- New contributor can reach known-good local run path in <=30 minutes.
- Includes validation script and readiness check output.

---

### J2. Local profile validator
**Problem:** setup issues discovered too late.

**Deliverables**
- `scripts/dev/check-local-profile.(ps1|sh|mjs)` validating:
  - node/python versions
  - required env
  - expected services/processes
  - optional capabilities

**Acceptance criteria**
- Validator outputs pass/fail + clear fixes.

---

## 8) Priority and sequencing

## P0 (Immediate: 0–2 weeks)
- A1, A2, A3, A4 (docs trust + freshness guard)
- B1 (top probe set)
- F1 (coverage policy clarity)
- D1 design + first migration slice

## P1 (Near-term: 2–6 weeks)
- B2, B3, B4
- C1, C2, C3
- D2, D3
- E1 phase 1
- F2, F3 initial bump, F4 initial bump
- G1

## P2 (Quarter)
- E2, E3
- G2, G3
- H1, H2, H3
- I1, I2
- J1, J2

---

## 9) Dependencies and risks

### Dependencies
- Existing guardrail workflows (`loom-guardrails.yml`, CI jobs)
- Platform env/bicep alignment for probes and deferred feature completion
- Team ownership across app/api, docs, platform scripts, dev tooling

### Risks
- Large-scale refactors can introduce regressions.
- Coverage ratchets may destabilize CI if rushed.
- Probe additions can increase runtime/API cost if not bounded.

### Mitigations
- Incremental rollout with feature flags and scoped migrations.
- Add deterministic unit/integration tests before raising thresholds.
- Budget-aware probe intervals/timeouts.

---

## 10) Success metrics (program-level)

1. **Docs trust**
   - 0 contradictory core claims in README/app docs/canonical metrics
   - parity freshness guard passing on main

2. **Operational readiness**
   - Missing priority probe list closed
   - increased % of workload families with live probe-backed readiness

3. **Code maintainability**
   - reduce number of >2000 LOC target files in scoped set
   - reduce duplicate gate boilerplate in migrated routes

4. **Quality**
   - Python `fail_under` ratcheted upward per plan
   - ignored suites reduced
   - Vitest thresholds ratcheted upward without major flake increase

5. **User/operator experience**
   - deferred high-impact flows completed (Lakebase query, report subscription runtime)
   - readiness UX adopted (dependency graph + scorecard)

---

## 11) Definition of done (for PRP completion)

This remediation PRP (or PRP set) is complete when:

- All WS items are either:
  - delivered, or
  - explicitly deferred with approved rationale + tracked follow-up ticket
- CI guardrails for docs freshness, health coverage, and route/gate consistency are active.
- Core docs are synchronized with real code/CI behavior.
- Program metrics are reported and baselined for the next release.

---

## 12) Suggested PRP slicing strategy

To avoid overloading one giant PRP, split into coordinated PRPs:

1. **PRP-Docs-Trust** (WS-A + F1)
2. **PRP-Health-Depth** (WS-B)
3. **PRP-Feature-Closures** (WS-C)
4. **PRP-API-Architecture** (WS-D)
5. **PRP-Maintainability** (WS-E)
6. **PRP-Quality-Ratchet** (WS-F)
7. **PRP-Corpus-Performance** (WS-G)
8. **PRP-Readiness-UX** (WS-H)
9. **PRP-Type-Hardening** (WS-I)
10. **PRP-Local-Golden-Path** (WS-J)

---

## 13) Open questions for PRP drafting

1. Should stale parity docs be **hard-fail** or **warn-only** initially?
2. Which deferred feature closures are required before next release gate?
3. Do we want a global file-size cap now, or advisory-only first?
4. What CI budget is acceptable for new live probes and E2E expansions?
5. Should readiness score influence release eligibility (yes/no)?

---

## 14) Backlog index (compact)

- **WS-A:** A1 A2 A3 A4
- **WS-B:** B1 B2 B3 B4
- **WS-C:** C1 C2 C3
- **WS-D:** D1 D2 D3
- **WS-E:** E1 E2 E3
- **WS-F:** F1 F2 F3 F4 F5
- **WS-G:** G1 G2 G3
- **WS-H:** H1 H2 H3
- **WS-I:** I1 I2
- **WS-J:** J1 J2

**Total backlog items:** 32

---

## 15) Notes on completeness

This PRD intentionally includes **every gap/opportunity** explicitly called out in the deep-dive summary:
- docs contradictions/staleness,
- deferred/gated high-impact features,
- route sprawl/refactor,
- oversized file decomposition,
- test/coverage ratchets and ignored suites,
- health probe completion,
- corpus/index optimization,
- readiness UX enhancements,
- typed client hardening,
- local golden path onboarding.
