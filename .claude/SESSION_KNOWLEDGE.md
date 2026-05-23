# Session Knowledge

Live state for the current working session. Updated as work progresses.
The end-of-session protocol (`.claude/rules/session-end.md`) rewrites this at
the close of each session.

---

## Current Session — 2026-05-22

**Focus:** CSA Loom pillar v0.1 — productized Microsoft Fabric parity
layer for Azure Gov tenants. Complete docs + planning + engineering
scaffold shipped on branch `csa-loom-pillar`.

**Branch:** `csa-loom-pillar` (PR #282 → main)

**Public brand:** CSA Loom (`fiab` remains repo-internal nickname).
Tagline: *"The loom that weaves your sovereign data fabric."*

### What landed (10 commits, 173 files, 18,152 lines)

**Docs (DONE — 114 pages under `docs/fiab/`)**
- Foundation: index, what-is, whitepaper, parity-matrix, architecture
- 12 ADRs (fiab-0001..0012) — full architecture decision set
- 11 workload parity pages (OneLake, Direct Lake, Mirroring, Real-Time
  Intelligence, Activator, Data Agents, Copilot, Data Engineering,
  Data Warehouse, Data Science, Fabric IQ family)
- Console (3) + Services (3) + Governance (6) pages
- Deployment (9), Operations (7) + Runbooks (12)
- Compliance (11) — FedRAMP High, DoD SRG IL4/IL5/IL6 maps, ATO
- Tutorials (8), Marketing kit (7), Workshops (3 — Federal + Commercial
  5-day CoE), Use cases (5), Examples (9)
- Sister comparison page `docs/comparison/csa-loom-vs-fabric.md`

**Planning (DONE)**
- 7 research reports `temp/fiab-research/01..07.md` (~3,200 lines)
- 14 PRD section files + AMENDMENTS `temp/fiab-prd/` (~7,000 lines)
- 25 PRPs `PRPs/active/csa-loom/PRP-00..25.md` (PRP-10 deferred)

**Engineering (SCAFFOLDED — real impl tracked in PRPs)**
- `platform/fiab/bicep/main.bicep` + 3 `.bicepparam` (commercial,
  gcc, gcc-high) + admin-plane + landing-zone module stubs
- `platform/fiab/azd/azure.yaml` (6 services registered)
- 6 service scaffolds `apps/fiab-{console,setup-orchestrator,
  mcp-config,activator-engine,mirroring-engine,direct-lake-shim}/`
  (README + Dockerfile; console also has package.json + Next.js 14
  + Fluent v9 + MSAL deps)
- 3 nightly CI workflows `.github/workflows/deploy-fiab-{commercial,
  gcc,gcch}.yml` (gcch with `environment: gcc-high-deploy` gate)
- 2 CI scripts `.github/scripts/fiab-{smoke-test,teardown}.sh`

**Validation**
- `mkdocs build --strict` clean ✓ (exit 0; confirmed by two
  background runs: br9b52bq0, bitd2cwsv)
- 61 link warnings fixed by converting internal cross-refs to absolute
  GitHub URLs on `csa-loom-pillar` branch

### 15 locked decisions

Full text in `temp/fiab-prd/AMENDMENTS.md`. Brand split is critical:
**CSA Loom** is the public brand; **FiaB** is repo-internal only.
Marketplace deferred. v1 scope = Commercial + GCC + GCC-High; IL5 in
v1.1; IL6 explicitly out.

### GitHub issues opened

- **Epic #279** — CSA Loom v1 build roadmap (updated with full wave map)
- **PR #282** — pillar v0.1 ship
- Wave 0 (closed via PR #282): #280 PRP-01, #281 PRP-19
- **Wave 1 (OPEN — 8 issues):** #283 PRP-02 Bicep, #284 PRP-03 Console,
  #285 PRP-04 Setup Wizard, #286 PRP-05 MCP Server, #287 PRP-06
  Activator Engine, #288 PRP-07 Mirroring Engine, #289 PRP-08
  Direct-Lake Shim, #290 PRP-09 Data Agents

### Honest gaps documented openly

- **Direct Lake**: no clean OSS parity. CSA Loom = Premium Import +
  warm-cache, 5-30s freshness vs Fabric's sub-second. See
  `docs/fiab/workloads/direct-lake-parity.md`
- **GCC structural gap**: no F-SKU = no Direct Lake parity in GCC
  (timing-independent)
- **Fabric IQ family** (Ontology, Graph, Plan, Maps): v2 deferred;
  Operations Agent in v1.1

### Next priorities

1. Get PR #282 reviewed + merged
2. Submit "CSA Loom" brand to legal review (TapestryOne fallback per LD-1)
3. Pick first Wave 1 issue to execute — recommend #283 (Bicep platform)
   since it unblocks Wave 2 deploy validation (PRP-11)
4. Build 2026 (Jun 2-3) freshness rescan — week of Jun 8 — before
   Wave 2 starts

### Critical context

- [[fiab-pillar]] memory has full state for future sessions
- [[writing-voice-no-customer-framing]] applies to all Loom docs
- Direct Lake parity is the hardest single workload (LD-7); engineer
  accordingly when picking up PRP-08

---

## Previous Session — 2026-05-06

**Focus:** Wire production telemetry / feedback / backlog-with-autonomous-fix
flow into the live Copilot chat surface, fronted by a security audit of the
existing widget + backend.

**Archon project:** `145c8d71-7e54-4135-8ec9-d6300caf4517` —
CSA-in-a-Box: Fabric-in-a-Box Vision (new feature label
`COPILOT-ANALYTICS-2026-05-06`).

### What landed

**Backend (`azure-functions/copilot-chat/`)**
- `redaction.py` — PII / secret-pattern scrubber (emails, JWTs, provider-
  prefixed keys, bearer tokens, Azure connection strings, IPs, long opaque
  tokens). Salted SHA-256 IP hashing helper.
- `telemetry.py` — Application Insights custom-event emitter via
  OpenCensus `AzureEventHandler`. No-ops if connection string is unset.
- `storage.py` — Cosmos DB persistence: `conversations`, `feedback`,
  `backlog` containers. AAD-only auth via `DefaultAzureCredential`.
  No-ops if `COSMOS_ENDPOINT` is unset.
- `function_app.py` — extended `/api/chat` to emit telemetry + persist
  to Cosmos with redaction; new `/api/feedback`, `/api/backlog`,
  `/api/health` endpoints with the same origin / token / rate-limit
  gates. Uncovered-question detection (off-topic refusal regex OR zero
  grounding hits) auto-files to backlog as `kind=uncovered`.
- Fix: SEC-COPILOT H-4 — `_client_ip` now uses the rightmost
  `X-Forwarded-For` entry instead of the spoofable leftmost.
- `requirements.txt` — `azure-cosmos`, `azure-identity`,
  `opencensus-ext-azure`.
- `tests/` — 39 unit tests covering redaction, IP hashing, origin /
  token gates, injection detection, off-topic detection, and the
  feedback / backlog / health endpoints. **All green.**

**Frontend (`docs/javascripts/copilot-chat.js`)**
- **SEC-COPILOT C-1 fix.** XSS in `md()` renderer closed by escaping
  the input *before* any markdown rule fires; redundant inner `esc()`
  calls dropped to avoid double-escape. The bubble innerHTML sink is
  now safe-by-construction.
- Per-tab session ID (`sessionStorage`); per-turn conversation ID;
  both flow through to backend on every request.
- Privacy banner on first open with **Accept** / **Opt out** /
  **Read details** (linking to `docs/copilot-privacy.md`); decision
  persisted in `localStorage`. Opt-out propagates as
  `X-Copilot-Opt-Out: 1` header — backend skips all persistence /
  telemetry when set.
- 👍 / 👎 strip after every assistant reply. Thumbs-down opens an
  improvement-text modal whose contents are persisted as a feedback
  record AND mirrored to the backlog as a `kind=bug` candidate.
- "Request a use case / Bug / Doc gap" 💡 button in the header opens
  a tabbed modal that POSTs to `/api/backlog`.
- Uncovered detection: when backend `meta.uncovered=true`, widget
  surfaces an inline "Add to backlog" prompt referencing the original
  question.

**Frontend styling (`docs/stylesheets/copilot-chat.css`)**
- ~270 new lines: privacy banner, feedback strip, uncovered prompt,
  modal, system-message bubble, request button. All themes-aware
  (light + slate dark + `prefers-color-scheme: dark` fallback).

**Privacy & docs**
- `docs/copilot-privacy.md` — full notice listing every collected
  field, retention period, redaction patterns, opt-out instructions,
  deletion-request workflow, source-code links. Linked from widget
  banner; added to mkdocs nav.

**GitHub Issue templates**
- `csa-bug.yml`, `csa-feature-request.yml`, `csa-uncovered.yml` — used
  by both manual submitters and the automated drain.

**GitHub workflows**
- `copilot-auto-fix.yml` — triggered when a maintainer adds the
  `auto-fix` label to a `csa-bug` issue. Invokes the official
  `anthropics/claude-code-action@beta` with a tightly scoped prompt
  + tool allowlist; opens a PR titled
  `fix: <title> (auto-fix #<issue>)`.
- `copilot-auto-merge.yml` — watches PRs from the auto-fix bot. If
  the diff is fully contained within `docs/**` / `examples/**` /
  `.github/ISSUE_TEMPLATE/**`, enables GitHub auto-merge so the PR
  lands as soon as required checks pass. Anything outside the safelist
  drops a comment on the PR and waits for a maintainer.
- `copilot-backlog-drain.yml` + `.github/scripts/copilot_backlog_drain.py`
  — hourly drain of Cosmos `copilot.backlog` (status=open) into
  GitHub Issues; flips Cosmos rows to `status=promoted` with the
  filed issue number stamped.

**IaC**
- `azure-functions/copilot-chat/deploy/main.bicep` — Cosmos DB
  account (serverless, AAD-only `disableLocalAuth=true`, continuous
  backup, TLS 1.2 minimum) + database `copilot` + 3 containers
  (TTL 90 days on `conversations`, no TTL on `feedback`/`backlog`)
  + Cosmos DB Built-in Data Contributor role assignment to the
  Function App's system-assigned MI.
- `DEPLOYMENT.md` extended with the analytics pipeline runbook,
  app-setting commands, and a refreshed Known Gaps section.

### Security audit (background agent, 2026-05-06)

Full report: `temp/security-audit-2026-05-06.md`. Headline:

| ID  | Sev      | Status    | Notes                                                |
|-----|----------|-----------|------------------------------------------------------|
| C-1 | CRITICAL | **Fixed** | XSS in `md()` renderer (this PR)                     |
| H-1 | HIGH     | Tracked   | In-memory rate-limit / token budget — Archon `a1e815db` |
| H-2 | HIGH     | Tracked   | Regex injection list bypassable — Archon `45297419`   |
| H-3 | HIGH     | Tracked   | OpenAI key in app setting — Archon `66dd7226`         |
| H-4 | HIGH     | **Fixed** | XFF rightmost-entry parse (this PR)                  |
| H-5 | HIGH     | Tracked   | `Azure/functions-action@v1` mutable tag — Archon `7ac11b22` |

Confirmed clean: no committed secrets, `.gitignore` is
comprehensive, `mkdocs.yml` has no analytics/CDN includes,
`requirements.txt` deps are current.

### Validation at close

- `pytest azure-functions/copilot-chat/tests/` — **39 / 39 green**
- `node --check docs/javascripts/copilot-chat.js` — syntactically valid
- `mkdocs build --strict` — clean (privacy page renders into the site
  as expected)
- Module import smoke test: all four endpoints
  (`chat` / `feedback` / `backlog` / `health`) resolve

### Archon delta

- 7 new tasks created under `COPILOT-ANALYTICS-2026-05-06`; all 7 set
  to `review` at session close (telemetry pipeline, feedback endpoint,
  backlog + uncovered detection, privacy notice, auto-fix workflow,
  Cosmos IaC, security audit).
- 4 follow-up tasks created for the un-fixed audit HIGH findings
  (H-1 / H-2 / H-3 / H-5), all `todo`, assigned to `Coding Agent`.

### Required deployment steps before this is live

1. **Deploy Cosmos**:
   `az deployment group create -g rg-dlz-aiml-stack-dev -f azure-functions/copilot-chat/deploy/main.bicep`
2. **Set Function App settings** (replace endpoint with Bicep output):
   `COSMOS_ENDPOINT`, `COSMOS_DATABASE=copilot`, `COPILOT_IP_HASH_SALT=<rotate-monthly>`.
3. **Configure repo** for the auto-fix + drain flows:
   - secret `ANTHROPIC_API_KEY`
   - variable `COPILOT_COSMOS_ENDPOINT`
   - federated identity secrets for the drain (`AZURE_CLIENT_ID`,
     `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`)
4. **Push** — the existing
   `.github/workflows/deploy-copilot-function.yml` autodeploys backend
   changes; the docs site rebuilds on the same trigger via
   `docs.yml`.

### Next-session candidates

- Burn down the 4 SEC-COPILOT follow-ups (H-1/2/3/5), ideally as
  parallel agents on non-overlapping scope.
- Audit cleanup wave: the 10 visible MEDIUM/LOW audit todos
  (CSA-0117, 0109, 0084, 0081, 0079, 0077, 0071, 0062, 0060, 0113).
- Wave 5 strategic builds: Copilot MVP Phase 0-1 (CSA-0008), real
  Fabric module (CSA-0129), Postgres migration (CSA-0046).

---

## Previous Session — 2026-04-18

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
