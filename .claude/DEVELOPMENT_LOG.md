# Development Log

Append-only record of notable work. Newest entries on top. Follows the
end-of-session protocol in `.claude/rules/session-end.md`.

---

## 2026-04-20 (cont.) — Phase-3 Wave 4.8: release pipeline + 2 architectural ADRs

Sixth parallel round of the day. Release automation + 2 architectural
ADRs (mesh federation, dbt canonical). Non-overlapping doc-focused
scopes; no code-breaking changes.

### Commits

- `95acf13` feat(ci): CSA-0072 — release-please + v0.1.0 pipeline
  (AQ-0022). `.release-please-config.json` + manifest +
  release-please.yml workflow + RELEASE.md runbook + rewritten
  CHANGELOG.md in Keep-a-Changelog format. v0.1.0 tag NOT created;
  user cuts via release-please PR or manual `git tag`.
- `4bb868b` docs(adr): CSA-0128 — ADR-0012 data-mesh federation
  (AQ-0027). Contract-driven 4-stage pipeline. CODEOWNERS extended
  for per-domain scoping (finance/inventory/dlz/spark added).
  validate-contracts.yml already thorough — no changes needed.
- `add9794` docs(adr): CSA-0130 — ADR-0013 dbt as canonical
  transformation (AQ-0029). Deprecation banner on
  bronze_to_silver_spark.py; 7 other notebooks correctly out-of-
  scope for dbt; new notebooks README.

### Findings status

  * CSA-0072 → review (release pipeline shipped)
  * CSA-0128 → review (federation ADR + CODEOWNERS scaffold)
  * CSA-0130 → review (dbt canonical ADR + notebook deprecation)

### Approval-queue progress

Shipped 19/35 → **22/35**. Remaining:

Theme A Copilot (XL): CSA-0008, CSA-0100, CSA-0102 — defer to
  dedicated multi-session effort
Theme C breaking (L): CSA-0020 MSAL BFF, CSA-0046 SQLite→Postgres
Theme D operational: CSA-0089 iot-streaming dbt rebuild
Theme E architectural: CSA-0134 git history purge (destructive —
  team coordination required), CSA-0137 streaming spine

### Scorecard

| Metric | Before | After |
|---|---|---|
| Vision alignment | ~84% | ~86% |
| HIGH findings open | 36 | 34 |
| MEDIUM findings open | ~38 | ~37 |
| Approval-queue items shipped | 19/35 | 22/35 |
| Cross-session commits | ~62 | ~66 |
| Findings fully resolved | 38 | 41 |
| Findings partial | 1 | 1 |

### Next session candidates

- **Copilot MVP Phase 0-1** (CSA-0008) — highest strategic value,
  but multi-session XL. Best tackled as its own dedicated effort.
- **Remaining breaking changes** — CSA-0020 MSAL BFF, CSA-0046
  Postgres (each L, one per session).
- **CSA-0137 streaming spine** — L architectural.
- **CSA-0134 git history purge** — destructive, requires team
  coordination + all-devs-notified advance notice.
- ~35 no-approval HIGH/MEDIUM for incremental execution.

---

## 2026-04-20 (cont.) — Phase-3 Wave 4.7: 3 more approved-queue items shipped

Fifth parallel round of the day. All three on non-overlapping scopes;
no working-tree contention.

### Commits

- `e69bb7d` feat(deploy): CSA-0138 — canonical DLQ pattern Bicep
  module + runbook (AQ-0033 Theme E). 235-line shared module with 4
  Azure resources (container / Event Grid system topic + sub /
  diagnostic settings / metric alert); 243-line operator runbook
  with 5-step triage + Replay + Drop + Escalation; ARCHITECTURE +
  PLATFORM_SERVICES cross-refs.
- `7c2c803` docs(adr): CSA-0140 — ADR-0011 multi-cloud scope
  (AQ-0035 Theme E). Scopes multi-cloud to OneLake shortcuts + Purview
  cross-cloud scans; defers Unity Catalog federation, Denodo, Trino,
  cross-cloud compute. 169-line MADR with 4 considered options,
  honest pro/con, validation criterion, NIST control references.
- `1dc7eb0` fix(security): CSA-0025 — IoT Hub + DPS Entra-only
  (AQ-0014 Theme C). Breaking change. `disableLocalAuth: true` on
  both; `listKeys()` call sites removed from routing + Key Vault
  secret; DPS API bump to 2023-03-01-preview; 2 new role assignments
  for MSI-based linking. 253-line iot-hub-entra.md migration doc.

### Findings status

  * CSA-0138 → review (DLQ Bicep + runbook shipped; data_activator
    wiring + FailedOperation Pydantic model + Cosmos persistence
    remain as follow-up)
  * CSA-0140 → review (ADR-0011 complete)
  * CSA-0025 → review (IoT Hub/DPS Entra flip complete; Event Hub
    SAS remains as CSA-0026 follow-up candidate)

### Approval-queue progress

Shipped 16/35 → **19/35**. Remaining after this round:

Theme C breaking changes: CSA-0020 MSAL BFF, CSA-0046 SQLite→Postgres
Theme D operational: CSA-0072 v0.1.0 tag, CSA-0089 iot-streaming dbt
Theme E architectural: CSA-0128 data mesh federation, CSA-0130 dbt
  canonical, CSA-0134 git history purge, CSA-0137 streaming spine
Theme A Copilot (XL): CSA-0008 MVP, CSA-0100 agent framework,
  CSA-0102 confirmation broker

### Scorecard

| Metric | Before | After |
|---|---|---|
| Vision alignment | ~82% | ~84% |
| HIGH findings open | 39 | 36 |
| MEDIUM findings open | ~40 | ~38 |
| Approval-queue items shipped | 16/35 | 19/35 |
| Cross-session commits | ~55 | ~62 |
| Findings fully resolved | 35 | 38 |
| Findings partial | 1 | 1 (CSA-0133) |

### Parallel-dispatch protocol

Five consecutive rounds of parallel agents on non-overlapping scopes
under the no-checkout/reset/stash rule. Zero working-tree contention
across all 5 rounds. Protocol is load-bearing.

### Follow-ups surfaced this round

- CSA-0026 candidate: Event Hub SAS → Entra migration (mirror of
  CSA-0025 for the Event Hubs surface)
- CSA-0138-followup: wire the DLQ pattern into data_activator +
  FailedOperation Pydantic model + portal UI surface
- Pre-existing README bug: iot-streaming README line 281 references
  a telemetryHubListenConnectionString.value output that never
  existed in Bicep — separate fix

### Next session candidates

- Theme A Copilot MVP (CSA-0008 XL — Phase 0-1 plausible)
- Theme C remaining: CSA-0020 MSAL BFF (L), CSA-0046 Postgres (L)
- Theme E remaining: CSA-0128 data mesh federation, CSA-0130 dbt
  canonical, CSA-0137 streaming spine, CSA-0134 git history purge
- ~35 remaining no-approval HIGH/MEDIUM for incremental execution

---

## 2026-04-20 (cont.) — Phase-3 Wave 4.6: 3 more approved-queue items shipped

Third parallel round this day. Three independent approved items on
non-overlapping scopes. All three clean; no working-tree contention
(no-checkout/reset rule held).

### Commits

- `27a30d6` refactor: CSA-0131 — promote `portal/cli/` → top-level
  `cli/` (AQ-0030 Theme E). 19 files renamed via git mv, 9 Python
  imports + cli README + pyproject.toml + root README updated.
  156 CLI + 433 csa_platform + 91 portal tests all green.
- `1bf0058` feat(ci): CSA-0073 — quarterly DR drill CI workflow
  (AQ-0021 Theme D). `.github/workflows/dr-drill.yml` with cron
  (1st of Jan/Apr/Jul/Oct @ 10:00 UTC) + workflow_dispatch,
  4 scenario jobs + report aggregator. New
  `docs/runbooks/dr-drill.md` runbook; `docs/DR.md` cross-links.
- `c93c779` docs(multi_synapse): CSA-0139 — mark module legacy /
  migration-only (AQ-0034 Theme E). README banner + new MIGRATION.md
  (257 lines) with capability-mapping matrix + 4-phase sequencing.
  1-line legacy notes added to csa_platform/README + ARCHITECTURE +
  PLATFORM_SERVICES. Decision tree already consistent.

### Findings status

  * CSA-0131 → review (portal/cli promotion complete; parallel
    marketplace deprecation portion still open)
  * CSA-0073 → review (DR drill scope complete)
  * CSA-0139 → review (multi_synapse legacy marking complete;
    workspace abstraction + cost_allocator port wait on CSA-0129)

### Approval-queue progress

Shipped 13/35 → **16/35**. Remaining:

Theme B (vision scope): —
Theme C (breaking changes): CSA-0020 MSAL BFF, CSA-0025 IoT Hub
  Entra-only, CSA-0046 SQLite→Postgres
Theme D (operational): CSA-0072 v0.1.0 tag, CSA-0089 iot-streaming
  dbt rebuild
Theme E (architectural): CSA-0128 data mesh federation, CSA-0130
  dbt canonical, CSA-0134 git history purge, CSA-0137 streaming
  spine, CSA-0138 DLQ pattern, CSA-0140 multi-cloud scope
Theme A (Copilot): CSA-0008 Copilot MVP, CSA-0100 agent framework,
  CSA-0102 confirmation broker

### Scorecard

| Metric | Before | After |
|---|---|---|
| Vision alignment | ~80% | ~82% |
| HIGH findings open | 41 | 39 |
| MEDIUM findings open | ~42 | ~40 |
| Approval-queue items shipped | 13/35 | 16/35 |
| Cross-session commits | ~50 | ~55 |
| Findings fully resolved | 32 | 35 |
| Findings partial | 1 | 1 (CSA-0133) |

### Lesson reinforced

Parallel dispatch on non-overlapping scopes continues to work
reliably when every agent follows the no-checkout/reset/stash rule.
4 rounds of parallel work now under the updated protocol with zero
working-tree contention.

### Next session candidates

- Wave 5 strategic builds (Copilot MVP XL / Fabric module XL /
  streaming spine L / Postgres migration L / MSAL BFF L)
- Remaining Theme E architectural items (data mesh federation,
  streaming spine, DLQ, multi-cloud scope)
- IoT Hub Entra-only (CSA-0025 — breaking change, federal-critical)
- ~38 no-approval HIGH/MEDIUM items

---

## 2026-04-20 (cont.) — Phase-3 Wave 4.5: 3 approved-queue items shipped in parallel

Three independent approved items dispatched as parallel subagents
on non-overlapping scopes. All three returned clean; three commits
landed.

### Commits

- `e79800e` fix(portal): CSA-0122 — gate auth by
  `NEXT_PUBLIC_AUTH_ENABLED` not `NODE_ENV`. Coordinates with
  backend CSA-0001/0019 allow-list so staging/preview stop shipping
  unauthenticated. `resolveAuthEnabled()` helper + 5 new tests.
  Frontend suite 91/91 green (+5 tests).
- `382af5c` refactor(portal): CSA-0045 — provisioning returns
  immutable `ProvisioningResult` Pydantic model (frozen=True). Drops
  mutate-at-distance pattern and exception-swallowing; router now
  applies result unidirectionally with distinct audit outcomes
  (success 200 / validation 400 / infra 502). 7 new tests. Portal
  suite 91/91 green.
- `90826ca` refactor(ai): CSA-0133 partial — drop fake-async
  `run_in_executor` wrapper in RAG pipeline. `VectorStore.search_async`
  via `azure.search.documents.aio.SearchClient`; `RAGPipeline` chat
  via `openai.AsyncAzureOpenAI`; per-instance async-client caching
  + idempotent `aclose()`. 8 new tests including concurrency proof.
  csa_platform suite 433/433 green.

### Findings status

  * CSA-0122 → review (complete)
  * CSA-0045 → review (complete)
  * CSA-0133 → doing (partial — RAG async done; service-layer
    extraction + RAG submodule split still open for a future session)

### Scorecard delta

| Metric | Before | After |
|---|---|---|
| Vision alignment | ~78% | ~80% |
| HIGH findings open | 43 | 41 |
| MEDIUM findings open | — | 42 |
| Approval-queue items shipped | 10/35 | 13/35 |
| Approval-queue partial | 0 | 1 (CSA-0133) |

Cross-session tally:
  * ~50 commits on `audit/full-codebase-remediation`
  * 32 findings fully resolved, 1 partial
  * Zero regressions

### Next session candidates

- CSA-0133 remaining scope: RAG submodule split + router/service
  layer extraction (L effort, M-L effort respectively).
- CSA-0008 Copilot MVP phase 0-1 (XL, multi-session — corpus
  indexer + grounding).
- CSA-0129 real `csa_platform/fabric/` module (XL).
- ~40 no-approval HIGH/MEDIUM items ready to execute incrementally.

---

## 2026-04-20 — Phase-3 Wave 4 complete (3 additional findings landed)

**Archon project:** `145c8d71-7e54-4135-8ec9-d6300caf4517`.

Closed out Wave 4 platform consolidation. One inline finish for the
stalled CSA-0043 caller redirects, then two heavy structural refactors
via sequential subagent dispatch (CSA-0126 governance, CSA-0127
shared-services). 4 new commits, 3 Archon tasks flipped to `review`.

### Commits landed

- `716c523` feat(deploy): complete resourceGroup caller redirects
  (CSA-0043 step 2) — 18 call sites in DLZ + landing-zone-alz
  redirected to `../shared/modules/resourceGroup/resourceGroup.bicep`;
  3 duplicate module files deleted. `az bicep build` clean on both
  main.bicep targets.
- `bb6efd5` refactor(governance): consolidate governance trees into
  `csa_platform/governance/` (CSA-0126) — 111 files changed. All
  `governance/{common,contracts,dataquality,finops,compliance,
  keyvault,network,policies,rbac}` + `csa_platform/purview_governance/`
  merged. 35 Python imports + 6 YAML contracts + 4 compliance evidence
  paths + 4 CI workflows + pyproject + Makefile + 15 docs rewritten.
  978 tests pass (broader suite now discoverable), 1 xfail, 1 skip.
- `02d8b51` refactor(functions): merge shared-services trees into
  `csa_platform/functions/` (CSA-0127) — 48 files changed.
  `csa_platform/shared_services/` → `validation/`, `domains/
  sharedServices/{common,aiEnrichment,eventProcessing,secretRotation}`
  all moved under a single canonical namespace. Empty
  `domains/sharedServices/` removed. 767 tests pass across 5 suites;
  ruff clean.

### Findings resolved

  * CSA-0043 → review (complete: scaffold + callers + duplicates deleted)
  * CSA-0126 → review (complete)
  * CSA-0127 → review (complete)

Wave 4 fully shipped:
  ✅ CSA-0043 Bicep resourceGroup consolidation (with 4 new
     follow-up findings tracked for remaining module families)
  ✅ CSA-0126 governance tree merger
  ✅ CSA-0127 shared-services merger
  ✅ CSA-0132 OneLake/DirectLake module renames (from 2026-04-19)

### Lessons from last session incorporated

- Parallel agents must not invoke `git checkout`, `git reset`, or
  `git stash` on any path — the CSA-0132 agent's `git checkout HEAD
  -- deploy/` last session clobbered the parallel CSA-0043 agent's
  work. This session used sequential dispatch for the final two
  heavy refactors (CSA-0126 then CSA-0127) to eliminate working-tree
  contention. Rule now baked into agent prompts.

### Scorecard

| Metric | Pre-Wave-4 | Post-Wave-4 |
|---|---|---|
| Vision alignment | ~72% | ~78% |
| CRITICAL findings open | 5 | 3 |
| HIGH findings open | 46 | 43 |
| Approval-queue items shipped | 7/35 | 10/35 |
| Platform consolidation | Forked trees | Single canonical |
| Governance tree count | 2 (forked) | 1 (merged) |
| Shared-services tree count | 2 (forked) | 1 (merged) |
| Bicep shared-module library | Dead | Active (resourceGroup) |
| Tests green | 751 | 978 (broader discovery) |

### Next session

Wave 5 strategic builds (multi-session scope):
  * CSA-0008 Copilot MVP (XL — 10-18 weeks of 3-engineer work)
  * CSA-0129 real `csa_platform/fabric/` module (XL)
  * CSA-0093 cybersecurity vertical (XL)
  * CSA-0137 streaming spine (L)
  * CSA-0046 Postgres migration for portal (L)
  * CSA-0020 MSAL BFF pattern (L)

Also open: ~40 no-approval HIGH/MEDIUM findings that can execute
incrementally; 2 Wave-1/2 deferrals (CSA-0072 release-please).

---

## 2026-04-19 (cont.) — Phase-3 Wave 4 partial (1 complete, 1 partial)

Two parallel agents on Wave 4 platform-consolidation work. CSA-0132
landed clean; CSA-0043 shipped scaffold-only due to working-tree
interaction between the two parallel agents (the CSA-0132 rename
agent invoked `git checkout HEAD -- deploy/` during its validation,
which reverted the CSA-0043 caller-redirection edits before they
could be staged).

Commits:
  ce0b113 refactor(csa_platform): CSA-0132 — rename onelake_pattern/
    → unity_catalog_pattern/ and direct_lake/ → semantic_model/.
    16 files renamed via git mv (history preserved); 14 cross-ref
    files updated; disambiguation READMEs; all 665 tests green.
  5da2e80 feat(deploy): CSA-0043 partial — canonical shared/modules/
    resourceGroup/resourceGroup.bicep scaffold with consolidation
    banner. Caller redirects deferred.

Findings:
  * CSA-0132 → review (complete)
  * CSA-0043 → doing (partial; follow-ups documented)

Wave 4 remaining (not started this session):
  * CSA-0126 governance tree merger
  * CSA-0127 shared-services merger

Scorecard:
  * Vision alignment ~72% → ~74%
  * Audit tasks in review: 26 (across all loops)
  * Audit tasks in doing: 1 (CSA-0043 partial)
  * Tests: 665 green (no regressions)

Next session: complete CSA-0043 caller redirects (15-line edit
across 3 main.bicep files), then tackle CSA-0126 + CSA-0127.

---

## 2026-04-19 (cont.) — Phase-3 Wave 3 (5 findings landed)

**Archon project:** `145c8d71-7e54-4135-8ec9-d6300caf4517`.

Executed Wave 3 vision-content buildout via two rounds of parallel
subagents on non-overlapping scopes, then central commits. 5 new
commits, 5 CSA tasks flipped to `review`. Doc-only changes; no code
touched; no test regressions possible.

### Commits landed

- `0513dc8` feat(docs): 8 decision trees + Primary Tech Choices
  rename (CSA-0010) — 19 files
- `fe6ca97` feat(docs): 10 MADR ADRs (CSA-0087) — 11 files
- `33f32e2` feat(docs): Palantir Foundry migration playbook
  (CSA-0009) — 3 files, 4,325-word playbook + 184-line ontology YAML
- `595c6b1` docs: reframe as Fabric-parity reference (CSA-0063) —
  7 files (README, ARCHITECTURE, PLATFORM_SERVICES, GETTING_STARTED,
  QUICKSTART, gov README, pyproject)
- `08a7bcc` feat(docs): Snowflake + AWS + GCP migration playbooks
  (CSA-0083) — 4 files totaling 12,659 words across 3 playbooks

### Findings resolved (5)

CSA-0009 (Palantir), CSA-0010 (decision trees), CSA-0063 (Fabric
positioning), CSA-0083 (Snowflake/AWS/GCP), CSA-0087 (10 ADRs).

### Scorecard at close

| Metric | Pre-Wave-3 | Post-Wave-3 |
|---|---|---|
| Vision alignment (weighted) | ~60% | ~72% |
| CRITICAL findings open | 8 | 5 |
| HIGH findings open | 48 | 46 |
| Approval-queue items shipped | 2/35 | 7/35 |
| Decision trees | 0/8 | 8/8 |
| ADRs | 0 | 10 |
| Migration playbooks | 0 | 4 (Palantir, Snowflake, AWS, GCP) |
| Section §7 (Copilot) | 0% | 0% — not in Wave 3 scope |

### Next session

Wave 4 (platform consolidation): CSA-0126 governance merger,
CSA-0127 shared-services merger, CSA-0043 Bicep consolidation,
CSA-0132 OneLake/DirectLake renames.

Wave 5 (strategic builds — multi-session): CSA-0008 Copilot MVP,
CSA-0129 real Fabric module, CSA-0093 cybersecurity vertical,
CSA-0137 streaming spine, CSA-0046 Postgres migration.

---

## 2026-04-18/19 (cont.) — Phase-3 Wave 1 + Wave 2 (12 findings landed)

**Archon project:** `145c8d71-7e54-4135-8ec9-d6300caf4517`.

Executed the post-approval remediation loop using three rounds of
parallel coding-agent dispatch (non-overlapping file scopes) followed
by central commits. 8 new commits, 12 Archon tasks flipped to `review`.
665 tests green across csa_platform / portal / CLI; zero regressions.

### Commits landed

- `ecdbf04` fix(security): access-request workflow CSA-0002/0017
- `4405d3e` fix(portal): Owner wizard step CSA-0007
- `849246a` chore: agent-harness → dev-loop CSA-0096
- `9971268` fix(portal): 3 missing/stub pages CSA-0004/0005/0006
- `3f66975` feat(ops): teardown scripts CSA-0011 (11 scripts)
- `0bd5700` docs: Entra rename + clone URL CSA-0064/0076
- `afa9631` feat(security): tamper-evident audit logger CSA-0016
- `aee1fe2` feat(governance): Phase 1 compliance matrices CSA-0012
  (NIST 800-53, CMMC 2.0 L2, HIPAA Security — 304 controls / 231
  evidence items, validator clean)

### Findings resolved (12)

CSA-0002, 0004, 0005, 0006, 0007, 0011, 0012 (Phase 1), 0016, 0017,
0064, 0076, 0096.

### Deferred

- **CSA-0072** (v0.1.0 tag + release-please) — requires actual git
  tag + GitHub Actions release-please workflow config + team
  coordination for release semantics. Stays in `todo`.

### Validation at close

- `pytest tests/csa_platform/` — 425 / 425
- `pytest portal/shared/tests/` — 84 / 84 (18 new audit-log tests,
  17 new access-router tests)
- `pytest portal/cli/tests/` — 156 / 156
- `npm test` (portal/react-webapp) — 86 / 86 (6 new StepOwner tests,
  2 new integration tests)
- Teardown scripts — bash -n clean across all 11
- Compliance validator — clean across 304 controls / 231 evidence
  items; every referenced file path resolves

### Scorecard at close (2026-04-19)

| Metric | Session 1 close | Now | Δ |
|---|---|---|---|
| Vision alignment (weighted) | ~52% | ~60% | +8pp |
| CRITICAL findings open | 15 | 8 | −7 |
| HIGH findings open | 56 | 48 | −8 |
| Approval-queue items shipped | 0/35 | 2/35 | +2 (0096 rename + 0012 Phase 1) |
| Tests green | 632 | 665 | +33 |

### Next session

Wave 3 (vision content buildout): CSA-0010 decision trees,
CSA-0063 Fabric positioning rewrite, CSA-0087 10 ADRs, CSA-0009
Palantir playbook, CSA-0083 Snowflake/AWS/GCP playbooks.

Wave 4 (platform consolidation): CSA-0126 governance merger,
CSA-0127 shared-services merger, CSA-0043 Bicep consolidation,
CSA-0132 OneLake/DirectLake renames.

Wave 5 (strategic builds) — CSA-0008 Copilot MVP, CSA-0129 Fabric
module, CSA-0093 cybersecurity vertical — is multi-session scope.

---

## 2026-04-18 — Full forensic audit + vision alignment + Phase-3 Wave 0

**Archon projects:** `145c8d71-7e54-4135-8ec9-d6300caf4517` (Fabric-in-a-Box
Vision — audit tasks) + `1bd59749-db0a-4009-82c7-f1a56d24a820` (Cloud-Scale
Analytics Platform — session context).

Executed the mission-prompt audit pipeline end-to-end through Phase 3 Wave 0.
Delivered the Vision Alignment Matrix, 7 parallel perspective audits, a
unified 140-finding registry, a 35-item approval queue (all approved via
ballot), and shipped 8 CRITICAL / HIGH fixes across 3 commits with zero
test regressions.

### Phases

**Phase 0 — Discovery & Vision Alignment (1 hr)**
- Produced `temp/VISION_ALIGNMENT_MATRIX.md` scoring the codebase against
  all 7 North-Star sections. Overall: ~50%.
- Key findings: Fabric primacy is token gesture, CSA Copilot 0%, decision
  trees 0/8, Palantir migration playbook missing, multi-cloud ~10%.

**Phase 1 — 7 parallel perspective audits (~10 min wall-clock, parallel)**
- Dispatched 7 subagents (architect, security, UX, devops, content,
  new-dev/federal, AI/Copilot). Each produced a structured findings
  report under `temp/audit/perspective-<N>-*.md` with 20–35 findings.
- Architect perspective initially stalled twice (scaffold but no
  findings); recovered on the third attempt via general-purpose agent.

**Phase 2 — Synthesis**
- Merged 191 raw per-perspective findings → 140 unique CSA-XXXX entries
  with deduplicated cross-perspective attribution.
- Produced `temp/audit/FINDINGS_REGISTRY.md` (17 CRITICAL / 59 HIGH /
  43 MEDIUM / 21 LOW) and `temp/audit/APPROVAL_QUEUE.md` (35 items
  across 5 themes).
- Seeded all 140 findings as Archon tasks under feature
  `CSA-INABOX-AUDIT-2026-04-18` with priority-aware task_order.
- Created Archon approval-queue doc `f64af68b-8d61-4958-b208-1e977c0fc3c2`.

**Phase 3 Wave 0 — Fixed 8 findings**
| ID       | Severity | Area    | Fix |
|----------|----------|---------|-----|
| CSA-0001 | CRITICAL | Auth    | env var rename + fail-closed empty tenant |
| CSA-0003 | CRITICAL | Portal  | quality_score 0-100 → 0.0-1.0 canonical  |
| CSA-0013 | HIGH     | Docs    | csa_platform/governance/ path repair       |
| CSA-0014 | HIGH     | Docs    | phantom great_expectations/ entry removed  |
| CSA-0015 | MEDIUM   | Docs    | Terraform path marked roadmap              |
| CSA-0018 | HIGH     | Auth    | JWT claim validation hardening             |
| CSA-0019 | HIGH     | Auth    | strict {local,demo} env allow-list         |
| CSA-0050 | LOW      | DX      | Azurite artifacts already gitignored       |

**Approval ballot**
- All 35 approval-queue items approved (A1–A4, B1–B7, C1–C9, D1–D4,
  E1–E11) via iterative theme-by-theme "all recommended" shortcut.
- Persisted to approval-queue doc (v1.1 with 35-decision ledger).
- All 35 underlying CSA tasks tagged `[APPROVED 2026-04-18 — AQ-XXXX /
  Theme X]` in their descriptions; 4 XL items reassigned to Coding Agent.
- Full log: `temp/audit/APPROVAL_LOG_2026-04-18.md`.

### Commits

- `bd077cc` fix(security): harden auth safety gate + input validation
  (CSA-0001/0018/0019) — 11 files, +455/-48, 39 new tests
- `56eecbd` fix(portal): canonicalize quality_score as 0.0-1.0 ratio
  (CSA-0003) — 12 files, +105/-58
- `5b7955f` docs: repair broken repo-structure references
  (CSA-0013/0014/0015) — 6 files, +22/-17

### Validation

- `pytest tests/csa_platform/` — **425 passed** (includes 39 new
  auth-safety-gate tests)
- `pytest portal/shared/tests/` — **51 passed**
- `pytest portal/cli/tests/` — **156 passed**
- **Total 632/632 green, zero regressions**
- `ruff check <edited files>` — clean on authored code

### Archon state at session close

- Fabric-Vision project: 140 new todo tasks + 8 flipped to review + 35
  approvals tagged. Backlog = 132 open (17 CRITICAL / 59 HIGH).
- Approval queue doc v1.1 with full decision ledger.
- Cloud-Scale Analytics project: Session Context doc updated with
  2026-04-18 snapshot, open questions, next-session scope.

### Next session scope (Wave 1 + Wave 2, ~14 items)

Wave 1 (no-approval CRITICAL/HIGH): CSA-0002, 0004, 0005, 0006, 0007,
0011, 0012 Phase 1, 0016, 0017.
Wave 2 (quick-win approvals): CSA-0096 rename, 0064 Entra rename,
0072 v0.1.0 tag, 0076 clone URL.

---

## 2026-04-13 (cont.) — Cleanup, tests, and full commit

**Archon project:** `1bd59749-db0a-4009-82c7-f1a56d24a820`

Addressed all remaining minor issues after the 7-gap fill. 7 new files,
4 modified. 451 tests pass, 85.17% coverage. 6 structured commits
landed. Working tree clean.

### Summary of work

1. **dbt analyses/ directories** — Created `.gitkeep` in all 4 dbt
   projects (shared, finance, inventory, sales) to match `dbt_project.yml`
   `analysis-paths` references.
2. **Empty legacy files** — Deprecated `Create_WHL.ps1` with notice
   pointing to `DATABRICKS_GUIDE.md`. Added ARM → Bicep migration guide
   to `deploy/arm/README.md`.
3. **README.md** — Updated repository structure to list all 7 domain
   directories and new top-level directories (governance, docs, tests,
   great_expectations).
4. **Utility script tests** — 36 new tests: `test_parse_ips.py` (15),
   `test_load_sample_data.py` (5), `test_produce_events.py` (16).
   Covers IP extraction/merging/collapse, sample data dry-run, and
   streaming event generation with field validation.
5. **Deleted macro verification** — Confirmed `audit_columns.sql` has
   zero callers and `generate_surrogate_key.sql` callers all use
   `dbt_utils` directly. Deletions are safe.
6. **Git hygiene** — Added `.infracost/` and compiled Bicep to
   `.gitignore`. Committed all 136 changed files in 6 logical commits.

### Validation summary

- `pytest tests/ --cov --cov-fail-under=80` — 451 passed, 1 skipped, 85.17%
- Working tree: clean

---

## 2026-04-13 — Fill all remaining gaps (7/7 complete)

**Archon project:** `1bd59749-db0a-4009-82c7-f1a56d24a820`

Addressed all 7 identified gaps to bring the platform from 90% to 100%
completion. 16 new files created, 7 modified. All 415 tests pass,
85.17% coverage, mypy clean, Bicep clean.

### Summary of work

1. **ADF deployment automation** — `deploy-adf.sh` script, hourly and
   daily trigger JSONs, Makefile target, `ADF_SETUP.md` documentation.
2. **Great Expectations checkpoints** — `great_expectations/` directory
   with DataContext config and 3 checkpoint YAMLs (bronze/silver/gold).
   Updated `ge_runner.py` with checkpoint discovery.
3. **Purview lineage** — `purviewAccountId` parameter on ADF Bicep,
   `register_lineage.py` Atlas API script (4 process entities),
   `--schedule-scans` flag on bootstrap, OpenLineage config for Databricks.
4. **dbt snapshots + exposures** — 2 SCD Type 2 snapshot models
   (customers, products), 4 exposure definitions on Gold schema.yml.
5. **Documentation** — `DATABRICKS_GUIDE.md`, expanded security runbook
   (3 new scenarios + evidence checklist + comms templates), expanded
   `TROUBLESHOOTING.md` (86 -> 230+ lines, 8 new sections).
6. **Tests** — 9 new lineage tests, all 415 pass, coverage maintained.

### Files created
- `scripts/deploy/deploy-adf.sh`
- `domains/shared/pipelines/adf/triggers/tr_daily_medallion.json`
- `domains/shared/pipelines/adf/triggers/tr_hourly_ingest.json`
- `docs/ADF_SETUP.md`
- `great_expectations/great_expectations.yml`
- `great_expectations/checkpoints/bronze_customers_checkpoint.yml`
- `great_expectations/checkpoints/silver_sales_orders_checkpoint.yml`
- `great_expectations/checkpoints/gold_clv_checkpoint.yml`
- `great_expectations/expectations/.gitkeep`
- `scripts/purview/register_lineage.py`
- `domains/shared/notebooks/databricks/config/openlineage.json`
- `domains/shared/dbt/snapshots/snp_customers_history.sql`
- `domains/shared/dbt/snapshots/snp_products_history.sql`
- `domains/shared/dbt/snapshots/schema.yml`
- `docs/DATABRICKS_GUIDE.md`
- `tests/purview/test_register_lineage.py`

### Files modified
- `Makefile` (+deploy-adf target)
- `governance/dataquality/ge_runner.py` (+checkpoint loading)
- `deploy/bicep/DLZ/modules/datafactory/datafactory.bicep` (+purviewConfiguration)
- `scripts/purview/bootstrap_catalog.py` (+create_scans, --schedule-scans)
- `domains/shared/dbt/models/gold/schema.yml` (+exposures)
- `docs/runbooks/security-incident.md` (+3 scenarios, evidence, comms)
- `docs/TROUBLESHOOTING.md` (+8 sections, 150+ lines)

---

## 2026-04-10 — Audit remediation sweep + Archon todo batch 1 (complete)

**Archon project:** `1bd59749-db0a-4009-82c7-f1a56d24a820`

Landed 15 commits on `main` in a single session. Working tree is clean,
strict mypy passes (16 source files + 2 Function apps checked
separately), pytest green (61 tests, 93.10% coverage).

### Phase A — Triage + hygiene (5 commits)

Took the 26 in-progress modifications left over from the audit sweep
and committed them in logical groups alongside the audit-artifact
reorganisation and the `.claude/` tracking bootstrap.

- `84aa05b` repo hygiene — audit reports moved to `docs/audit/`, stray
  portal export deleted, Azure policy CSV references relocated to
  `governance/policies/reference/`, `.claude/SESSION_KNOWLEDGE.md` and
  friends bootstrapped, `.claude/settings.json` description fixed
  (had been copied from a different repo).
- `d998c6e` CI/CD safety — auto_commit off, timeouts on every job,
  environment approval gates on deploy.yml, Makefile early-exit,
  `.pre-commit-config.yaml`, `deploy/bicep/bicepconfig.json`,
  enriched pyproject ruff + mypy config.
- `e75d85e` docs — `docs/GETTING_STARTED.md`, `docs/TROUBLESHOOTING.md`,
  `tests/` scaffold.
- `6a8bff5` infra lockdown — public network access closed on Cosmos,
  AppInsights query, Purview, ALZ Log Analytics; Synapse admin
  username made unique; storage infrastructure encryption on; dbt
  models converted to incremental; SQL injection hardening in the
  Databricks notebook and run_dbt.py; ADF retry policies; Function
  error sanitisation; RBAC script wiring + narrowed scopes.
- `243d8a4` `.claude/` project rules + hooks committed; globals-synced
  dirs (agents/commands/skills/agent-memory) gitignored.

### Phase B — Archon todo backlog batch 1 (10 commits, 10 tasks)

All 10 todos visible on the first `find_tasks` page (task_order 45–80)
are now `done` in Archon:

1. `d0cb142` **Email regex consolidation** (`b9b4f126`). Created
   `governance/common/validation.py` as the canonical source. Wired
   `substitute_common_patterns` into the data-quality YAML loader;
   replaced the dbt inline in `slv_customers.sql` with the existing
   `flag_invalid_email` macro; added an `email_regex` var in
   `dbt_project.yml` mirroring the Python constant; 15 pytest cases.
2. `e0fcb4a` **Bicep API version refresh** (`57ed2e42`). Synapse
   (5 resource types) to 2021-06-01, Key Vault (both ALZ + DMLZ
   copies) to 2024-11-01 with softDeleteRetentionInDays 90 and
   explicit publicNetworkAccess Disabled, Container Registry (DMLZ
   + ALZ CRML) to 2023-07-01 GA with anonymousPullEnabled corrected
   to false. All modules `az bicep build`-clean.
3. `7e8174a` **Coverage threshold in CI** (`8b735520`). Replaced the
   broken `pytest --co` placeholder with a real `pytest --cov
   --cov-fail-under=80` run. Added `[tool.coverage.run|report|xml]`
   to pyproject, PR-comment via py-cov-action, coverage XML + HTML
   artifacts.
4. `c6e2d8f` **Rollback workflow + PITR** (`74b1d983`). Cosmos
   default backupPolicy flipped to Continuous30Days. Storage blob
   service gains deleteRetentionPolicy, versioning, changeFeed, and
   restorePolicy (6d window). New `.github/workflows/rollback.yml`
   with ROLLBACK confirmation + ref preflight + three
   landing-zone jobs + post-rollback verification. `deploy.yml`
   emits `deploy/<env>-<sha>-<run>` tags on success. New
   `docs/ROLLBACK.md` covering Bicep, ADF, dbt, Cosmos PITR, and
   storage recovery.
5. `5487848` **Structured JSON logging with trace IDs** (`7c36dbc6`).
   `governance/common/logging.py` wraps structlog with
   `configure_structlog` / `get_logger` / `bind_trace_context` /
   `extract_trace_id_from_headers`. Wired into the data-quality
   runner (run-scoped correlation_id) and both Function apps
   (traceparent header extraction + per-trigger binding).
   `docs/LOG_SCHEMA.md` documents the baseline fields, canonical
   events per service, and ready-to-run KQL queries. 14 test cases.
6. `7494e38` **Type hints + mypy strict** (`43511368`). Turned on
   `strict = true` globally. Added `governance/__init__.py` +
   `governance/dataquality/__init__.py` so the package resolves.
   Typed run_quality_checks, both function_app files, tests, and the
   Databricks notebook (the notebook remains excluded from mypy via
   overrides because spark/dbutils globals are unresolvable). New
   `make typecheck` target. Three-way mypy invocation in CI
   (default target + one per Function app) because the two
   `function_app.py` files collide on module path.
7. `a40dbb1` **Async Functions** (`02179890`). aiEnrichment function
   rewritten to use `azure.ai.textanalytics.aio` and
   `azure.ai.formrecognizer.aio` inside `async with` blocks.
   Dropped the synchronous `_get_ai_client` singletons; replaced
   with cheap capability probes for the health check. Every trigger
   is `async def`. eventProcessing function triggers are also
   `async def` for event-loop fairness, with the Cosmos output
   still flowing through the host-managed binding (docstring
   explains why).
8. `e0c1da9` **Great Expectations wiring** (`a211e42f`). New
   `governance/dataquality/ge_runner.py` with an in-memory
   fallback evaluator covering every expectation type in
   `quality-rules.yaml`. `DataQualityRunner.run_ge_checkpoints()`
   bridges the config to the runner and surfaces results as
   `QualityCheckResult` entries. New `--ge-only` CLI flag. 18
   parametrised tests covering every expectation type.
9. `3ed82e4` **Load test scaffold** (`a7a82cb2`). `tests/load/`
   directory with Locust + k6 HTTP-trigger harnesses, a dbt
   benchmark script with regression gate, and a README documenting
   the acceptance targets + baseline capture procedure. New
   `.github/workflows/load-tests.yml` (workflow_dispatch only) with
   four target options (locust, k6, dbt bench silver, dbt bench
   gold). `reports/` added to `.gitignore`.
10. `ac00139` **Multi-region DR strategy** (`3c27e17d`). New
    `storageSku` parameter on storage.bicep (defaults to the
    existing logic; callers can opt into Standard_RAGRS for
    critical workloads). New `secondaryLocation` parameter on
    cosmosdb.bicep (empty default; when set, builds a two-region
    `locations` array with failoverPriority 0 + 1). New
    `docs/DR.md` with the RPO/RTO tier matrix, primary/secondary
    region pairs, step-by-step failover + failback procedure, and
    a quarterly drill cadence.

### Discovered mid-session

- **Archon pagination hid half the backlog.** The `find_tasks`
  `per_page` default is 10, and the project has 20 todos. The
  second page (task_order 83–107) was invisible during the initial
  status briefing. Those 10 tasks remain `todo` — see
  `.claude/SESSION_KNOWLEDGE.md` for the list. Decision punted to
  the user.
- **great_expectations is already installed** in this dev env
  (pulled in by another tool), which meant the `ge_runner` tests
  caught a real behaviour difference between the "GE present but no
  sample data" skip path and the "GE absent" skip path.
- **Two Function apps + flat `function_app.py` module names** are
  incompatible with a single mypy invocation. Documented the
  workaround (three mypy calls) in the Makefile and CI.

### Validation summary at session close

- `mypy` (default target) — 16 files, no issues
- `mypy domains/sharedServices/aiEnrichment/functions/function_app.py` — no issues
- `mypy domains/sharedServices/eventProcessing/functions/function_app.py` — no issues
- `pytest tests/ --cov --cov-fail-under=80` — 61 passed, 93.10% coverage, gate met
- `az bicep build` — clean on every module touched (cosmos, storage, keyvault×2, containerregistry×2, synapse)

### Not touched this session (still todo)

See the 10 task backlog in `.claude/SESSION_KNOWLEDGE.md` — Unity
Catalog RBAC, ML approval gate, data-contract enforcement, GitHub
environment protection rules, Bronze/Silver surrogate-key refactor,
Silver flag-vs-filter semantics, Customer-Managed Keys, secret
rotation automation, extended audit log retention, and VNet/subnet
Bicep modules (flagged as "most critical infrastructure gap").
