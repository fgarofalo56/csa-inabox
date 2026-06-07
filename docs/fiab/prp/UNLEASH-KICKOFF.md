# UNLEASH CSA Loom — Autonomous Coding Kickoff

This file contains the **exact prompt** to paste into Claude Code to launch the
autonomous, multi-agent coding workflow that drains the entire PRP backlog in
`docs/fiab/prp/`. Copy everything inside the fenced block below.

---

```
UNLEASH CSA LOOM — autonomous multi-agent coding run.

MISSION
Drain 100% of the backlog across ALL per-experience PRPs in docs/fiab/prp/ until
every task's acceptance criteria pass with zero stubs and zero placeholders. The
end state is 100% Microsoft Fabric feature parity delivered on Azure-native (and
OSS) backends, surfaced through the CSA Loom UI, working across all four cloud
types (Commercial, GCC, GCC-High, IL5), with every experience graded A or A+.

START HERE
1. Read docs/fiab/prp/README.md (master index, cross-cutting rules, sequencing).
2. Read each per-experience PRP: data-engineering.md, data-factory.md,
   real-time-intelligence.md, data-science.md, governance-security.md,
   data-marketplace.md. Build a single ordered task list that respects each
   PRP's internal task order (T1…/Task 0…) AND the cross-experience wave
   sequencing in README.md (Wave 1 Data Engineering + Data Factory → Wave 2
   Real-Time Intelligence → Wave 3 Data Science → Wave 4 Governance & Security +
   Data Marketplace). You MAY run tasks in parallel only when they touch disjoint
   code paths and respect those dependencies.
3. Track the run with TodoWrite (one item per PRP task) and a running ledger so
   any session can resume after compaction. Re-read this prompt and README.md
   after any context reset.

PER-TASK DEV-LOOP (run these agents in order for EVERY task; iterate until pass)
For each task, spawn a chain of subagents and loop until acceptance criteria are
met — do NOT advance to the next task until the current one passes:

  a) RESEARCH agent — ground the work in the REAL Azure portal / Fabric UI and
     Microsoft Learn (microsoft_docs_search / microsoft_docs_fetch) and Context7
     for library/SDK docs. Inventory every capability the source UI exposes for
     this task's surface. Confirm the per-cloud endpoint equivalents
     (Commercial/GCC/GCC-High/IL5). Read the existing Loom code paths it touches.
     Output: a concrete implementation plan + the feature inventory.

  b) CODING agent — implement the task one-for-one against the real Azure-native
     backend. Real REST / Cosmos / TDS / ARM calls only — NO mock arrays, NO
     return []/{}, NO useState(MOCK_DATA), NO dead buttons, NO static tabs, NO
     raw JSON/YAML textarea as primary config (use dropdowns/wizards/WYSIWYG/
     canvas; the only freeform exception is a 1:1 ADF/Synapse expression builder).
     The Azure-native path is the DEFAULT and must work with
     LOOM_DEFAULT_FABRIC_WORKSPACE UNSET; Fabric/Power BI only as opt-in
     (LOOM_<ITEM>_BACKEND=fabric + bound workspace). Sync bicep + post-deploy
     bootstrap in the SAME task: new resource → platform/fiab/bicep/modules/**;
     new env var → apps[] in admin-plane/main.bicep; new role → resource bicep
     module; new Cosmos container → Cosmos init; new tenant action →
     docs/fiab/v3-tenant-bootstrap.md + scripts/csa-loom/*.sh or a *-bootstrap.yml.

  c) VALIDATION/TEST agent — must produce a real-data E2E receipt:
        - tsc clean (filter the known makeStyles/Fluent tsc noise; do not let it
          mask real type errors — only suppress the documented benign lines).
        - vitest passing for the touched code (add/extend tests; the render-test
          harness is flaky repo-wide, so gate UI correctness on `next build` +
          a Playwright walk, not only on render tests).
        - real-data E2E: hit the BFF endpoint with a minted session, capture the
          real response body (first ~300 chars), and a Playwright screenshot or
          trace of the surface. Confirm it works (or shows an honest
          MessageBar infra-gate) with NO Fabric workspace bound.
     If any check fails, loop back to (b). Do NOT fake a receipt.

  d) DOCS agent — update docs/fiab/parity/<slug>.md (every inventory row marked
     built ✅ / honest-gate ⚠️ / MISSING ❌ — target zero ❌), plus any feature
     docs, Learn popups, and the bicep/bootstrap docs. Docs are source-of-truth;
     do not leave doc debt. Never bake clarifying questions or side-conversation
     into product UI or docs.

  e) UAT agent — run the deep-functional walk (pnpm uat where applicable) and a
     click-every-control pass against the surface; compare side-by-side with the
     real Azure/Fabric UI. Grade the surface (F/D/C/B/A/A+). A surface is
     A-grade only when its parity doc shows zero ❌ and zero stub banners. If it
     grades below A, loop back to (b).

ACCEPTANCE CRITERIA (per task — all must hold before the task is "done")
- The task's own acceptance criteria in its PRP pass.
- Cross-cutting rules ALL satisfied: no-fabric-dependency, no-vaporware,
  ui-parity, no-freeform-config, four-cloud portability, bicep + bootstrap sync.
- Real-data E2E receipt attached. Works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
- Zero stubs / placeholders / dead controls / empty tabs / mock data.

PR DISCIPLINE (open ONE PR per task)
- Branch off origin/main fresh for each task: `git fetch origin` then branch from
  origin/main (never stack on a stale local main; never reuse a branch).
- Stage files EXPLICITLY (git add <paths>) — never `git add -A`/`.`; keep the
  diff scoped to the task.
- Do NOT run `pnpm install` in the shared worktree (it corrupts the main
  node_modules / breaks tslib for parallel agents). If deps truly must change,
  isolate it and call it out in the PR.
- Conventional commits, scoped to csa-loom, ending with the co-author trailer:
      Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
- Put the real-data E2E receipt (endpoint, response snippet, screenshot/trace,
  bicep diff if infra changed) in the PR body. Use "Closes #N" if a tracking
  issue exists.
- DO NOT MERGE. The operator merges after CI is green. Open the PR, report it,
  and move to the next task. Mark the PR do-not-merge for the operator.

DRAIN THE BACKLOG
Repeat the per-task dev-loop for every task in every PRP — all 126 tasks across
the six experiences — until 100% of the backlog is drained and every experience
grades A or A+. Keep the TodoWrite ledger and the running notes current so the
run survives compaction. Stop only when the entire backlog is complete or you hit
a genuine operator-gated blocker (a one-time tenant/admin action that no agent
can perform) — in which case record it precisely, open the honest-gate PR, and
continue with the next unblocked task.

Begin now: read README.md and the six PRPs, build the ordered task list, and
start the per-task dev-loop on the first Wave 1 task.
```
