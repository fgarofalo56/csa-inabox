# OMNIBUS — one program for everything open (2026-08-22)

**Status:** DRAFT (execution-ready — 2026-08-22). Author: Claude Code, operator-directed.
**Supersedes:** all 22 PRP units previously in `PRPs/active/`, now in `PRPs/archive/2026-08-22-omnibus-consolidation/`
(disposition table in §8). It also supersedes `program-master-2026-08-18`, which drove
4 rows; this drives everything.

**Role:** the single sequencing, intake, and fan-out authority for **261 open issues**,
the surviving forward work from 22 archived PRP units, and the open PR queue. It **drives**;
it does not re-specify. Task detail lives in the child PRP or the issue. If this file and
a child disagree on **scope**, the child wins. If they disagree on **order, ownership, or
gates**, this file wins.

**Run it with:** `/prp:prp-execute PRPs/active/omnibus-2026-08-22/PRP.md`

---

## 1. What this drives

Nine children, cut by **file ownership** rather than by topic — because in this repo
parallel safety is a file property. Two agents that can touch the same file cannot run
concurrently (CLAUDE.md §8). Every issue is assigned to exactly one lane; verified
disjoint at generation time (0 duplicate assignments across 261).

| Lane | Child | Issues | Wave | Rigor | Max agents |
|---|---|---|---|---|---|
| **L0** | [Deploy & Estate Trust](./L0-deploy-estate-trust.md) | 62 | **0 — blocking** | FULL | 4 |
| **L1** | [Security & AuthZ](./L1-security-authz.md) | 48 | **0 — blocking** | FULL | 3 |
| **L2** | [CI, Gates & Guards](./L2-ci-gates-guards.md) | 45 | 1 | Normal | 4 |
| **L3** | [Console — Item Types & Editors](./L3-console-item-types-editors.md) | 21 | 1 | Normal (FULL on data-loss) | 5 |
| **L4** | [Console — API Routes & Data Path](./L4-console-api-routes-data-path.md) | 8 | 1 | FULL | 3 |
| **L5** | [Console — Admin & UX Surfaces](./L5-console-admin-ux-surfaces.md) | 34 | 1 | Normal | 5 |
| **L6** | [Data Plane & Backends](./L6-data-plane-backends.md) | 34 | 1 | FULL | 4 |
| **L7** | [Docs & Parity Artifacts](./L7-docs-parity-artifacts.md) | 6 | 1 | Normal | 3 |
| **L8** | [Capability Programs](./L8-capability-programs.md) | 3 + archived PRP carry-forward | 2 | Mixed | 3 |
| | **total** | **261** | | | **34 theoretical** |

Rigor tiers are the operator's standing direction, applied verbatim: *full mutation-proof
for deploy paths, auth, and data; normal review — gates plus one independent pass, no
adversarial loop — for CI, docs, and UI.* A third review round on any item stops and asks.

---

## 2. Why Wave 0 blocks

**L0 blocks because a repo that cannot deploy is a repo whose merges do not exist**
(`deploy-integrity.md` R1). This is not hypothetical today: `deploy-fiab-gcch` has failed
6/6 daily scheduled runs, and `deploy-copilot-function` 6/6 — both root-caused
2026-08-22 (#3449 ordering defect, fix in PR #3880; #3429 a misaimed subscription secret
needing an operator repoint). Work merged while those are red is work the operator cannot
see.

**L1 blocks because it decides what other lanes may touch.** L1 owns `lib/auth/**` and an
explicitly declared list of `app/api/**/route.ts` files. L4 cannot safely open until that
list is published in L1's ledger, or the two lanes will collide on the same routes.

Everything else runs concurrently.

---

## 3. Dependency graph

```
WAVE 0  (blocking, run these two together — they share no files)
  L0 Deploy & Estate Trust ──┐
  L1 Security & AuthZ ───────┤  L1 publishes its app/api file list -> unblocks L4
                             │
        ┌────────────────────┘
        ▼
WAVE 1  (six lanes, fully concurrent — ownership is disjoint by construction)
  L2 CI & Guards          (independent)
  L3 Editors              ── coordinates with L4 on #3878 only (see §6)
  L4 API & Data Path      ── needs L1's declared list first
  L5 Admin & UX           (independent)
  L6 Data Plane           (independent)
  L7 Docs                 (independent; can start immediately, lags others by design)
        │
        ▼
WAVE 2
  L8 Capability Programs  — starts only when the defect lanes are demonstrably down.
                            Fix-before-build: do not build a capability on a surface
                            with a known open defect.
```

The only hard cross-lane edges in the whole program: **L4 ← L1's declared list**, and
**#3878's envelope decision (L3 ⇄ L4)**. Everything else is parallelisable.

---

## 4. The merge treadmill — read this before planning wall-clock

This is the single biggest operational constraint, and it is measured, not assumed.

Branch protection on `main` is **`strict: true` with 15 required contexts**. That means
every PR must be up to date with `main` at merge time, so **each merge invalidates every
other open PR**. The console `vitest` suite runs ~34 minutes. Naively, N PRs cost N
sequential CI cycles.

Consequences, all of which shape how the lanes should batch their work:

1. **Batch fixes per PR.** One PR carrying six related fixes costs one CI cycle; six PRs
   cost six. Lanes should merge on a *shared-file batch* boundary, not per issue.
2. **Serialize merges deliberately, not accidentally.** Merge one, let the next update,
   merge that. Trying to merge two at once just wastes a cycle.
3. **A PR behind `main` by commits with zero file overlap is a judgement call.** Updating
   costs a full cycle; merging accepts that CI validated a slightly older tree. Taking the
   shortcut is allowed **only** when the delta provably cannot interact (e.g. a workflow
   file vs auth TypeScript), and the reasoning must be stated in the merge.
4. **`vitest (node 20)` can conclude SUCCESS having executed nothing** on workflows- or
   scripts-only PRs (#3783). Gate with `temp/merge-eligible.py <PR>` plus
   `temp/hollow-control.py`, and note that the hollow-check also flags *path-appropriate*
   skips — diff the PR's changed files against what the check covers before accepting or
   dismissing its verdict.
5. **Self-authored PRs cannot be self-approved**, so they sit at `REVIEW_REQUIRED`. The
   `--admin` merge is authorized only at: 0-behind, 0-running, all-green, and a clean
   independent review.

---

## 5. Fan-out procedure (per lane, identical)

1. **Triage first.** One agent walks the lane's inventory and splits it `real` /
   `stale` / `duplicate` / `already-fixed`, verifying by measurement. This repo contains
   issues asserting a current failure that is no longer true, *and* issues asserting a fix
   that never deployed — both directions occur. Record each verdict as an issue comment.
2. **Batch survivors by shared file.** Items touching the same file merge into one work
   item or run sequentially. This is where wall-clock is won.
3. **Fan out** to the lane's agent cap, one worktree per agent, disjoint file sets.
4. **Verify, review, merge** per §4.

Worktree isolation is mandatory for every agent build. Note that `git stash` is
repo-global and a worktree's `node_modules` junction will delete main's if torn down with
`rm -rf` — use reparse-point-only `cmd /c rmdir`.

---

## 6. Cross-lane procedure

If an item needs a file its lane does not own, it does **not** take the file. Instead:

1. Stop; name the file and the owning lane.
2. Route here. The master either (a) reassigns the whole item to the owning lane, or
   (b) declares a temporary ownership transfer recorded in both children's ledgers.
3. Never edit across the boundary silently. That is how a family gets half-fixed.

**The live instance is #3878.** Two response-envelope families are interleaved under one
`/api/` prefix: `cosmos-items` GET/PATCH return the **bare** document while CREATE/DELETE
and the hand-written item routes return `{ok, item}`. Seven confirmed dead `j.ok`
statements across four editor files. The tree already contains a half-fix
(`apim-editors/data-product-editor.tsx` patched its read path at `:226` and left its write
path broken at `:272`) — which is precisely the outcome this procedure exists to prevent.
**Resolution: L3 owns the fix, including the one `cosmos-items` route file, and the sweep
plus a guard land together in one PR.** L4 reviews and does not touch that route.

---

## 7. Open PR intake

| PR | Lane | Disposition |
|---|---|---|
| #3880 | L0 | GCC-High ADX preflight ordering. Merge when green — this unblocks a daily-failing sovereign deploy path. |
| #3863 | — | release-please. Standing release authorization applies; land after the queue drains, branch refreshed 2026-08-22. |
| #3867–#3875 (9) | L2 | Dependabot. Deliberately deferred: strict protection means each merge invalidates the rest, and `upload-artifact` 4→7 and `github-script` 7→9 are major bumps warranting review given this repo's history with injected `github-script` names. Batch them in one L2 sprint. |

---

## 8. Archived PRP disposition

All 22 prior units moved to `PRPs/archive/2026-08-22-omnibus-consolidation/`. Nothing was
deleted; the forward-looking content is carried into **L8**, and open checkbox counts were
measured at archive time.

| Archived PRP | Measured state | Carried to |
|---|---|---|
| `geo-graph-ml` | 29 open boxes | L8 |
| `access-governance` | 9 open (header says BUILT/SHIPPED — reconcile in L8 triage) | L8 |
| `foundry-parity` | 9 open, status ACTIVE | L8 |
| `fabric-databricks-2026-parity` | DRAFT, execution-ready | L8 |
| `vv-sweep-remediation-2026-08-18` | DRAFT, execution-ready; its 28 items are already filed as issues | L0–L6 via the issue inventory |
| `program-master-2026-08-18` | DRAFT; drove 4 rows | superseded by this file |
| `domain-mesh` | DRAFT | L8 |
| `enterprise-hardening` (14 files) | phased roadmap, no checkbox ledger | L8 |
| `next-waves` (14 files) | proposed | L8 |
| `loom-next-level` (10 files) | has a DONE.md | L8 (residue only) |
| `loom-apex` (5 files) | has a DONE.md | L8 (residue only) |
| `loom-competitive-audit-2026-07-20` (4) | findings/matrix — reference | L7 (parity docs) |
| `finishline` (2) | register, pre-08-18 authority | superseded by this file |
| `OPEN-REGISTER-2026-07-12` | register | superseded by this file |
| `CSA-LOOM-REMEDIATION-BACKLOG-PRD` | header: CONVERTED — superseded 2026-08-06 | closed |
| `loom-vscode-extension` | header: SHIPPED | closed |
| `weave-powerbi` | header: SHIPPED | closed |
| `bridge-services`, `docs-sweep`, `loom-devtools`, `reconcile`, `ux-fabric-a` | no ledger | L8 / L7 triage |

**L8's first task is to reconcile that table against reality** — several headers claim
SHIPPED while carrying open boxes, and this program does not inherit unverified claims.

---

## 9. Program invariants (binding on every lane)

1. **Done means DEPLOYED and verified live.** Never merged. Report anything merged and
   not rolled in exactly those words: *"merged, not deployed."*
2. **Receipts or it didn't happen.** `tsc` + `vitest` + DOM strings are not completion
   evidence for any UI surface; a G1 in-browser walk is.
3. **Both clouds, or say which.** Commercial-green proves nothing about Gov. Gov evidence
   comes only from a GitHub Actions run — never local `az`.
4. **Mutate the guard, not the code.** A guard that stays green when its subject is broken
   is the defect. Check the guard's *population*, not its verdict.
5. **Azure-native by default.** No capability may hard-depend on a real Fabric tenant, and
   nothing ships Commercial-only as if complete.
6. **No silent scope growth.** Discoveries get filed and routed here, never absorbed into
   an in-flight item.
7. **Close an issue only on deployed-and-verified evidence** — and audit closures after
   every merge, because merges auto-close unclaimed issues and the close parser is
   negation-blind ("does not close #N" still closes #N).

---

## 10. Milestones

| # | Milestone | Exit evidence |
|---|---|---|
| **M0** | Deploy trust restored | L0 green; `deploy-fiab-gcch` and `deploy-copilot-function` passing; one merge traced to BOTH estates, twice consecutively |
| **M1** | Boundary proven | L1 closed; every authz guard survives a mutation of its subject; the admin-bypass family greps clean on both shapes |
| **M2** | Defect lanes down | L2–L6 inventories closed or explicitly deferred; #3878's envelope unified with a guard |
| **M3** | Truth restored in docs | L7 done; no parity doc self-grades against a fix that has since landed |
| **M4** | Capability build resumes | L8 opened on a reconciled carry-forward table |

Milestones may overlap in execution but are **declared** in order.

---

## 11. Definition of done for the program

Zero open issues that are not explicitly deferred by the operator, every deferral
recorded with its reason, every closure on deployed-and-verified evidence, and
`make validate` green on `main` with the estate at parity with `main` on both clouds.
