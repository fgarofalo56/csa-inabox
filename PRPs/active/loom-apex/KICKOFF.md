# loom-apex — KICKOFF (paste this to resume after the Windows reinstall)

> This file is committed to the repo so it survives a machine wipe. Everything
> the resume needs lives in git (PRP + research + DONE ledger) — NOT in local
> `.claude/` memory or `temp/` checkpoints, both of which are wiped on reinstall.

## First, after reinstall (one-time environment sanity)
- Re-clone / confirm `E:\Repos\GitHub\csa-inabox` is present and on `main`.
- `git fetch && git reset --hard origin/main` — main should be at or ahead of
  `59ba312d` (the live-gates report merge). Both estates were live at image
  `11ea763b` (v0.76.0) at pause.
- Confirm tooling: `gh auth status`, `az account show`, `node -v`, `pnpm -v`.
- Local `.claude/` memory is GONE — that's fine. The durable context is the
  three files the kickoff prompt names below.

## The kickoff prompt (paste verbatim)

```
Execute PRPs/active/loom-apex/PRP.md to completion, phase by phase, per its
execution contract. This resumes a large multi-session program after a machine
reinstall — local .claude/ memory is gone, so load context ONLY from the repo:

1. Read PRPs/active/loom-apex/PRP.md in full.
2. Read every file in PRPs/active/loom-apex/research/ — the 7 evidence reports:
   prps-audit.md (the 30-item drain table), canvas-resize.md, help-center.md,
   gates-zero.md, gates-LIVE-state.md (the live gate probe + Model Fabric verdict),
   loom-unity.md (the LU-1..12 flagship spec), page-errors.md.
3. Skim PRPs/active/loom-next-level/DONE.md (the program ledger — what's already
   landed + the FRESH0 boundary table) and PRPs/active/reconcile/PRP.md.

Then verify main is green (git status; gh pr list; run the guard suite:
check-route-guards, check-env-sync, check-sql-quoting, check-health-coverage,
check-prp-freshness --strict) and both estates are live, before starting.

Start Phase A (platform integrity) FIRST — it fixes what users feel today
(the ChunkLoadError deploy-skew that makes pages "open with an error", route
error/loading boundaries, silent-failure pages, the live page-by-page sweep,
and the canvas height+width resize completion). Then B (drain, including the
Function->ACA-jobs migration) in parallel with C (Loom Unity — LU-1 then LU-2
FIRST because the deployed OSS Unity Catalog currently runs authorization-
DISABLED), then D (Help Center deep expansion), then E (the adversarial
industry-grading review), then housekeeping R20-R27 last.

Decisions already made by the operator (do NOT re-ask):
- The catalog platform is named "Loom Unity" (Unity-Catalog-COMPATIBLE in docs;
  not Databricks-branded as a product name).
- Model Fabric reasoning tier: set modelTiers.strong = gpt-5.6-sol
  (Model Fabric is NOT broken/gated — this was its only unconfigured piece).

Operator actions still owed (surface when relevant, do NOT block on them):
- Entra CA exclusion for svc-loom-synthetic@limitlessdata.ai -> V1 login probe.
- Create the shared alert action group (loom-default-alerts) + wire
  LOOM_ALERT_ACTION_GROUP_ID (clears svc-alert-action-group + svc-secret-expiry).
- I6/I7 identity-enforce flip (after I9 sign-off + the ~Aug-5 clean-shadow window).
- S2 FIC credential flip on the prod app registration.

Execution contract (from the PRP, non-negotiable): worktree workflow fan-outs;
integrate every batch with tsc -p tsconfig.build.json + FULL vitest + the guard
suite before push; admin-merge on green required CI (the "Copilot quality evals"
check fails on every PR by design — admin-merge past it); ONE SHA-pinned roll
per batch to BOTH estates (loom-roll-and-validate + gov-console-roll, both now
behind the SC1 cosign verify gate); FRESH0 re-baseline at every phase boundary;
G1 browser receipts for user-visible items; update the DONE ledger + write a
fresh memory at each milestone. Roll cadence gotcha: build the image + let its
main-push vitest conclude BEFORE dispatching a roll, and don't roll a docs-only
HEAD (no image); the SC1 gate rejects any unsigned image.
```

## Known-good recipes to re-learn from the reports (in case a fresh agent needs them)
- **SC1 supply-chain gate**: trivy is scoped to `scanners: vuln` + a reviewed
  `.trivyignore` baseline; base-image CVEs are the B-SC1' burn-down item. A roll
  failing at "cosign signature verify" means the image was never signed (a build
  gate failed) — fix the build, don't skip the gate.
- **runtime-flags.ts merge conflicts** (recur every wave): the array union splice
  can drop the closing `},` between the last HEAD flag and the incoming one —
  always grep the joint + verify `id:` uniqueness after resolving.
- **Stacked-PR rebase**: `git rebase --onto origin/main <old-base-sha> <branch>`
  drops an already-merged base commit.
- **Windows cp1252**: never print em-dash/arrow to stdout in python one-liners;
  write files as utf-8 with `newline=''`. Clear a stale `.git/index.lock` with
  `rm -f .git/index.lock`.

## Status snapshot at pause (2026-07-24 evening)
- loom-next-level: Phases 0-4 + §P2 residual wave COMPLETE and live on BOTH
  estates (image 11ea763b, v0.76.0). The §P2 wave was the last of that program.
- loom-apex: PRP written + merged; NOT started. This is the remaining work.
- Model Fabric: verified working (HTTP 200, not gated); only the reasoning tier
  needs the operator's model pick (decided above).
- Live gates: 10 red of 125 — 5 correct opt-ins, 5 = the B-FN migration +
  operator actions. Full detail in research/gates-LIVE-state.md.
