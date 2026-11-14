---
name: apim-W00-prerequisite-measurements
status: active
priority: P1
order: 60
depends_on: []
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-09-11
issues: [4442]
allow_parallel: true
---

# PRP: APIM AI Gateway - Wave 0: the prerequisite measurements

Hub: `PRPs/active/apim-ai-gateway/PRP.md`. Shared measured context (read the cited section only):
`PRPs/active/apim-ai-gateway/REFERENCE.md`. Rules: no-vaporware, cloud-parity, auto-bind-by-default, deploy-integrity, assertion-design (`.claude/rules/`).

## Goal
Produce the measurements and decisions that every later wave builds on, and record them in one receipt file, without editing any template. Most of the Gov-authoring evidence already exists (apigw W0); this wave closes only what is still unmeasured.

## Why
Finding out late that a boundary lacks a policy, tier or Prompt Shields support invalidates a design (#4442 said this is the cheap first task). Re-scoped 2026-11-14 because apigw W0 (#5188, merged, not deployed) already measured `llm-token-limit` and `llm-emit-token-metric` authoring on Commercial and GCC-High, and Q5 was answered 2026-10-29.

## Scope / Non-goals
**Scope:**
- Task 1 (stand-up of Premium classic in-boundary): GCC-High already deployed Premium classic (`apim-csa-loom-usgovvirginia`, W0-RECEIPT.md). Remaining: IL5 (never deployed) - record "unexercised" unless IL5 first deploys.
- Task 2 residual: runtime ENFORCEMENT of `llm-token-limit` on GCC-High (only authoring + read-back measured), authoring of `llm-semantic-cache-lookup/-store` and `llm-content-safety` on a Gov instance, and IL5/GCC authoring (expected: unmeasurable, declare).
- Task 3: Prompt Shields on AOAI at IL5/GCC-High: a Learn/portal statement naming Azure Government, or an in-boundary observation.
- Task 4 (Q5): DONE 2026-10-29 (stay on PremiumV2). Record it on #4442 if not yet present.
- Task 5: obtain the #4458 compliance determination (IL5 `/contentsafety` fallback in audit scope?) BEFORE any IL5 deploy. Satisfiable with no Azure call.
- Task 6: re-run the private-DNS measurement of REFERENCE.md section 3.5 (`azure-api.net` zone A records) at current head; record the result.

**Non-goals:**
- No bicep, no console code. - No local `az` against Gov (Gov access is GitHub Actions only). - Does not decide #4458; consumes it.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] `PRPs/active/apim-ai-gateway/W0-RECEIPT.md` exists with one row per task 1-6, each naming boundary, instrument, run id/URL and raw result. Fails if any row says "should work" or lacks a run id / Learn URL.
- [ ] Task 2 residual: for `llm-token-limit` runtime on GCC-High the receipt records an observed 429 (or "not measurable from Actions: gateway unreachable", which apigw W0 already found) - value that breaks it: a row with no observed status.
- [ ] Task 3 records `available | unavailable | UNVERIFIED` for Prompt Shields per boundary; `UNVERIFIED` keeps the IL5 gap row open and blocks `apim-WD-service-families` from claiming the substitute is complete.
- [ ] Task 5 records the #4458 determination text and date, or "NO DETERMINATION" - and in that case the receipt states IL5 must not be deployed. Fails if IL5 is deployed while it reads NO DETERMINATION.
- [ ] Task 6 lists every A record in `azure-api.net` (query 2 output); the value that breaks it is any record other than `apim-csa-loom-centralus` that the design needs but lacks.
- [ ] `gh issue comment` text drafted for #4442 and #4460 summarising results (the orchestrator posts; this wave does not run `gh` writes).

## Read first
- `PRPs/active/apim-ai-gateway/REFERENCE.md` sections 3.2, 3.4, 3.4.1, 3.5.
- `PRPs/active/loom-api-gateway-plane/W0-RECEIPT.md` (what is already measured) and `.github/workflows/apiplane-w0-gov-probe.yml`, `apiplane-w0-commercial-probe.yml` (reuse these probes; do not write new ones).
- `apim.bicep` symbols `isSovereign`, `aoaiLlmPoliciesSupported`.
- `platform/fiab/bicep/params/il5.bicepparam` symbol `contentSafetyEnabled` and the comment above it.

## Owns
- `PRPs/active/apim-ai-gateway/W0-RECEIPT.md` (new).
- Optionally one probe-input tweak to the existing `apiplane-w0-*-probe.yml` dispatch inputs ONLY if the probe cannot author `llm-semantic-cache-*` / `llm-content-safety` today (then it also owns that one workflow file and is listed in the PR).

## Must NOT touch
- Any `*.bicep`, `*.bicepparam`, `apps/**`. - `PRPs/active/loom-api-gateway-plane/**` (the sibling owns it; read only). - `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`.

## Consumes
- apigw W0 receipt and probes (#5188, #5181, #5183). - #4458 determination (external). - #4460 (this wave supplies its measurement).

## Provides
- `W0-RECEIPT.md` that gates `apim-WA`, `apim-WB1`, `apim-WB2`, `apim-WD`, `apim-WE`. - The #4460 answer (policies available in Gov authoring-wise). - The Prompt Shields verdict.

## Steps
1. Re-read W0-RECEIPT.md; list which rows of tasks 1-3 are already answered and copy them in short form.
2. Dispatch the existing Gov probe via GitHub Actions for the residual policy elements (semantic cache, content-safety); record run ids. Never local `az` for Gov.
3. Search Learn (`microsoft_docs_search`) for Prompt Shields availability in Azure Government; record URL + `ms.date`.
4. Collect the #4458 determination (ask the operator; if none, record NO DETERMINATION).
5. Run the section 3.5 DNS queries with `--subscription e093f4fd-5047-4ee4-968d-a56942c665f3` (DMLZ); record output.
6. Write `W0-RECEIPT.md`; draft the #4442/#4460 comments.

## Validation
```bash
# Gov measurement - Actions only
gh workflow run apiplane-w0-gov-probe.yml
gh run list --workflow apiplane-w0-gov-probe.yml --limit 1 --json databaseId,conclusion,status
gh api repos/fgarofalo56/csa-inabox/actions/runs/<id>/jobs --jq '.jobs[]|"\(.name) | \(.conclusion) | steps=\(.steps|length)"'   # deploy/probe job must show steps>0
# Commercial DNS
az network private-dns record-set a list --subscription e093f4fd-5047-4ee4-968d-a56942c665f3 --resource-group rg-csa-loom-admin-centralus --zone-name azure-api.net -o table
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root E:/Repos/_prp-audit
```
Per-cloud receipts:
| Boundary | Receipt required | State on 2026-11-14 |
|---|---|---|
| Commercial / DMLZ | deploy run with executed steps + live call | exercised (live DMLZ estate, `apim-csa-loom-centralus`, PremiumV2 x1, Internal) |
| GCC-High | Actions run in-boundary (never local `az`) | exercised 2026-09-01 (run 33519232492, 33 steps); latest 3 runs skipped at 0 steps (estate stand-down) - a fresh receipt needs the pause-declaration file lifted by the operator |
| GCC | `az bicep build-params` parity ONLY | supported-in-code, NEVER exercised (0 deploy steps ever; lane `disabled_manually`). Do not list as covered. |
| IL5 (+DoD via `effectiveBoundary`) | `az bicep build-params` parity; in-boundary receipt only if IL5 first deploys | supported-in-code, NEVER exercised: 10 runs, all `failure` with 0 jobs. DoD is supported-in-code, never exercised. |

Done = `W0-RECEIPT.md` has every row filled with a run id or URL. A probe job at `steps=0` is NOT a receipt.

Merged is not done (`deploy-integrity.md` R2): until a deploy job EXECUTED steps and the behaviour was observed, report "merged, not deployed". Never write "fixed" on a merge.

## Rollback
Nothing in-tree changes except one receipt file; delete `W0-RECEIPT.md`. If a probe workflow input was edited, `git revert` that commit.

## Docs to update
`PRPs/active/apim-ai-gateway/PRP.md` Execution state row; draft #4442 comment. No `docs/` page yet (WA creates it).

## Wave / Blocked-by / Branch / Worktree
Wave: 0 · Blocked-by: none · Branch: feat/apim-w00 · Worktree: E:/Repos/_apim-w00

## Hot files
Only the optional probe workflow; no hot bicep file.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/apim-ai-gateway/PRP.md, REFERENCE.md (sections 3.2, 3.4, 3.5) and
PRPs/active/loom-api-gateway-plane/W0-RECEIPT.md, then PRPs/active/apim-ai-gateway/apim-W00-prerequisite-measurements.md.
Goal: write W0-RECEIPT.md in the apim-ai-gateway folder answering Wave 0 tasks 1-6; only the residual
questions (apigw W0 already covers llm-token-limit/emit-token-metric authoring on Commercial + GCC-High).
Gov = GitHub Actions only, never local az. No bicep edits. Branch feat/apim-w00 in E:/Repos/_apim-w00.
Proof of done: every receipt row has a run id/URL; prp_index.py check exits 0.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W00-1 tasks 1-3 residual (Actions) | todo | | sonnet | apigw W0 #5188 covers GCC-High authoring | 2026-11-14 |
| W00-2 task 4 Q5 | merged | | | answered 2026-10-29 | 2026-11-14 |
| W00-3 task 5 #4458 determination | todo | | | #4458 open | 2026-11-14 |
| W00-4 task 6 DNS re-measure | todo | | sonnet | | 2026-11-14 |
