# Session Knowledge

Live state for the current working session. Updated as work progresses.
The end-of-session protocol (`.claude/rules/session-end.md`) rewrites this at
the close of each session.

---

## Current Session — 2026-04-18

**Focus:** Full forensic audit + vision-alignment assessment + first wave of
remediation for the CSA-in-a-Box codebase, per the "Full Codebase Remediation"
mission prompt.

**Archon projects:**
- `145c8d71-7e54-4135-8ec9-d6300caf4517` — CSA-in-a-Box: Fabric-in-a-Box Vision
  (audit tasks live here under feature `CSA-INABOX-AUDIT-2026-04-18`)
- `1bd59749-db0a-4009-82c7-f1a56d24a820` — CSA-in-a-Box: Cloud-Scale Analytics
  Platform (Session Context doc lives here)

### Outcome

**Phases 0–2 fully delivered.  Phase 3 kicked off: 8 findings resolved.
132 remain; Wave 1+2 is the next-session scope.**

### Artifacts produced (canonical location: `temp/audit/`)

- `temp/VISION_ALIGNMENT_MATRIX.md` — North-Star alignment, 50% overall
- `temp/audit/perspective-1-architect.md` — Senior Data & Analytics
  Architect (20 findings)
- `temp/audit/perspective-2-security.md` — Security & Federal Compliance
  (25 findings)
- `temp/audit/perspective-3-ux.md` — UX / Frontend (30 findings)
- `temp/audit/perspective-4-devops.md` — DevOps / Platform (25 findings)
- `temp/audit/perspective-5-content.md` — Content / Docs (35 findings)
- `temp/audit/perspective-6-new-dev-federal.md` — New Dev / Federal
  Customer (26 findings)
- `temp/audit/perspective-7-ai-copilot.md` — AI / CSA Copilot (30 findings)
- `temp/audit/FINDINGS_REGISTRY.md` — unified 140 CSA-XXXX findings
  (CRITICAL: 17 / HIGH: 59 / MEDIUM: 43 / LOW: 21)
- `temp/audit/APPROVAL_QUEUE.md` — 35 items across 5 themes
- `temp/audit/APPROVAL_LOG_2026-04-18.md` — 35/35 approved (all
  recommendations accepted via ballot)
- `temp/audit/ARCHON_SEEDING_LOG.md` — 140 tasks seeded

### Commits landed this session (2026-04-18 + cont. 2026-04-19)

**Session 1 — Phase 0-3 Wave 0 (8 findings):**

- `bd077cc` fix(security): auth safety gate + JWT validation
  (CSA-0001/0018/0019) — 39 new tests
- `56eecbd` fix(portal): quality_score 0.0-1.0 canonical (CSA-0003)
- `5b7955f` docs: broken repo paths (CSA-0013/0014/0015)
- `c42f800` chore(session): close session 1

**Session 2 — Phase 3 Wave 1 + Wave 2 (12 findings):**

- `ecdbf04` fix(security): access-request authz (CSA-0002/0017)
- `4405d3e` fix(portal): Owner wizard step (CSA-0007)
- `849246a` chore: agent-harness → dev-loop (CSA-0096)
- `9971268` fix(portal): 3 pages — sources/[id], pipelines, access
  (CSA-0004/0005/0006)
- `3f66975` feat(ops): teardown scripts (CSA-0011, 11 scripts)
- `0bd5700` docs: Entra rename + clone URL (CSA-0064/0076)
- `afa9631` feat(security): tamper-evident audit log (CSA-0016,
  9 emit points + hash chain + 18 tests)
- `aee1fe2` feat(governance): Phase 1 compliance matrices
  (CSA-0012, NIST/CMMC/HIPAA — 304 controls / 231 evidence items)

### CSA findings resolved this session (20 total across both loops)

**Phase 3 Wave 0 (8):**

| ID       | Severity | Area    | Summary                                           |
|----------|----------|---------|---------------------------------------------------|
| CSA-0001 | CRITICAL | Auth    | env var rename + fail-closed empty tenant         |
| CSA-0003 | CRITICAL | Portal  | quality_score canonicalisation                    |
| CSA-0013 | HIGH     | Docs    | csa_platform/governance/ broken path              |
| CSA-0014 | HIGH     | Docs    | great_expectations/ phantom dir entry removed     |
| CSA-0015 | MEDIUM   | Docs    | Terraform path marked roadmap                     |
| CSA-0018 | HIGH     | Auth    | JWT claim validation hardening                    |
| CSA-0019 | HIGH     | Auth    | ENVIRONMENT strict allow-list                     |
| CSA-0050 | LOW      | DX      | Azurite artifacts — verified already gitignored   |

**Phase 3 Wave 1 + Wave 2 (12):**

| ID       | Severity | Area     | Summary                                          |
|----------|----------|----------|--------------------------------------------------|
| CSA-0002 | CRITICAL | Auth     | access approve/deny domain-scope + self-guard    |
| CSA-0004 | CRITICAL | Frontend | /sources/[id] dynamic route built                |
| CSA-0005 | CRITICAL | Frontend | /pipelines stub → real table + filters + runs   |
| CSA-0006 | CRITICAL | Frontend | /access stub → dual-mode form + admin review    |
| CSA-0007 | CRITICAL | Frontend | Owner wizard step added; owner.team required    |
| CSA-0011 | CRITICAL | Ops      | 11 teardown scripts + Makefile targets + docs   |
| CSA-0012 | CRITICAL | Gov      | Phase 1 compliance matrices (NIST/CMMC/HIPAA)    |
| CSA-0016 | HIGH     | Security | Tamper-evident audit log + 9 router emit points  |
| CSA-0017 | HIGH     | Security | Access-request validation + classification caps |
| CSA-0064 | HIGH     | Docs     | "Azure AD" → "Microsoft Entra ID" (17 files)    |
| CSA-0076 | LOW      | Docs     | clone URL → <CLONE_URL> placeholder              |
| CSA-0096 | Approval | Chore    | agent-harness → dev-loop rename                  |

**Deferred (requires team coordination):**

- CSA-0072 (v0.1.0 tag + release-please workflow). Needs live git
  tag + GitHub Actions release-please config.

All 20 shipped tasks flipped to `review` on the Fabric-Vision
Archon project.

### Validation summary at close (2026-04-19)

- `pytest tests/csa_platform/` — 425 / 425 (includes 39 auth-gate tests)
- `pytest portal/shared/tests/` — 84 / 84 (+17 access tests, +18 audit tests)
- `pytest portal/cli/tests/` — 156 / 156
- `npm test portal/react-webapp` — 86 / 86 (+6 StepOwner + 2 integration)
- **Total: 751 / 751 green**, zero regressions across 12 commits
- `bash -n` clean on all 11 teardown scripts
- compliance validator — clean across 304 controls / 231 evidence items
- `ruff check` — clean on authored code

### Scorecard after both coding loops

| Area                            | Pre-session | Post Wave 0 | Post Wave 1+2 |
|---------------------------------|-------------|-------------|---------------|
| Vision alignment (weighted)     | ~50%        | ~52%        | ~60%          |
| CRITICAL findings open          | 17          | 15          | **8**         |
| HIGH findings open              | 59          | 56          | **48**        |
| Archon approval queue backlog   | 35          | 0 approved  | 2 shipped     |
| Tests green                     | ~475        | 632         | **751**       |
| Compliance framework coverage   | 0 matrices  | 0           | **3 frameworks / 304 controls** |
| Tamper-evident audit log        | None        | None        | **Shipped, 9 emit points** |
| Teardown scripts                | 0           | 0           | **11 (platform + 10 verticals)** |
| Dead frontend nav targets       | 3           | 3           | **0** |
| CSA-Copilot MVP status          | 0%          | Approved    | Approved, ready for Phase 0-1 |

### Approvals persisted 2026-04-18

All 35 approval-queue items approved via "all recommended" ballot across
Themes A–E. Persisted to Archon doc `f64af68b-8d61-4958-b208-1e977c0fc3c2`
(approvals section v1.1) and appended to each underlying CSA task
description with `[APPROVED 2026-04-18 — AQ-XXXX / Theme X]` prefix. XL
items (CSA-0008 Copilot, CSA-0009 Palantir, CSA-0012 compliance,
CSA-0129 Fabric module) reassigned to `Coding Agent`.

### Next session scope — Wave 3 + 4 (content + consolidation)

Wave 1 + 2 fully shipped (12 / 13 items; CSA-0072 release-please
deferred pending team coordination on git tag ops).

**Wave 3 — Vision content buildout (5 items):**
- CSA-0010 — author 8 decision trees (YAML + Mermaid)
- CSA-0063 — Fabric positioning rewrite (README + ARCHITECTURE)
- CSA-0087 — 10 MADR ADRs
- CSA-0009 — Palantir Foundry migration playbook
- CSA-0083 — Snowflake + AWS + GCP migration playbooks

**Wave 4 — Platform consolidation (4 items):**
- CSA-0126 — governance tree merger
  (`csa_platform/purview_governance/` → `csa_platform/governance/`)
- CSA-0127 — shared-services merger to `csa_platform/functions/`
- CSA-0043 — Bicep consolidation to `deploy/bicep/shared/modules/`
- CSA-0132 — rename `onelake_pattern/` → `unity_catalog_pattern/`,
  `direct_lake/` → `semantic_model/`

**Wave 5 — Strategic builds (multi-session):**
- CSA-0008 — Copilot MVP (XL, 10-18 weeks)
- CSA-0129 — real `csa_platform/fabric/` module
- CSA-0093 — cybersecurity vertical
- CSA-0137 — streaming spine
- CSA-0046 — SQLite → Postgres migration

### Open items / notes

- Next.js build artifacts (`portal/react-webapp/.next/`) and Playwright
  cache (`.playwright-mcp/`) and `next-env.d.ts` are currently untracked
  at commit time. Add to `.gitignore` next session if not already.
- Copilot MVP (Wave 5, CSA-0008) approved-in-principle; no kickoff date.
- Git filter-repo for `tools/dbt/dbt-env/` venv (AQ-0031 / CSA-0134)
  approved but will require a team-wide coordination step.
