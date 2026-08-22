# PROGRAM MASTER — Fix & Rival (2026-08-18): one driver for the remediation + parity programs

**Status:** DRAFT (execution-ready — 2026-08-18). Author: Claude Code, operator-directed.
**Role of this document:** the single sequencing and intake authority for the two PRPs authored
2026-08-18 and the defect pools they draw on. It **drives**; it does not re-specify. Every task's
detail lives in its child PRP or issue — if this file and a child disagree on scope, the child
wins; if they disagree on ORDER or GATES, this file wins.

## 1. What this master drives

| Child | Where | Thesis | State |
|---|---|---|---|
| **C1 — V&V Sweep Remediation** | [`PRPs/active/vv-sweep-remediation-2026-08-18/PRP.md`](../vv-sweep-remediation-2026-08-18/PRP.md) (PR #3758) | Fix what exists: 28 distinct work items (30 issues, 2 subsumed) across waves 0/R/T/D/F/X/N/B/C/G/G2, from the live-browser sweep of all catalogs + all 52 admin routes + the workspace Settings drawer | Draft PR open |
| **C2 — Fabric + Databricks 2026 Parity ("Rival")** | [`PRPs/active/fabric-databricks-2026-parity/PRP.md`](../fabric-databricks-2026-parity/PRP.md) (PR #3780) | Build what's missing: waves A–G over 17 issues (#3762–#3778), four net-new services (Live Push, Loom Connect, Agent Foundry, Model Gateway), OpenSharing + governed secrets, MAC+MAG doctrine | Draft PR open |
| **P0 — the pre-existing defect pool** | Epic [#3527](https://github.com/fgarofalo56/csa-inabox/issues/3527)'s ~25 filed defects (#3508–#3551 band) + the no-freeform EPIC #3615 | Not authored today, but load-bearing: specific items gate C2 waves (see §3) and share files with C1 items | Open, `sprint:next` |
| **EXT — deploy-chain reliability** | #3676, #3713, #3714 (+ #3730 root cause FIXED on main at `049349a9`, 2026-08-18) | Nothing above ships trustworthily until a merge provably reaches both estates and stays there | Open, P0 |

**Registry position:** this master registers alongside — not above — the finishline register
(`PRPs/active/finishline/AUDIT-2026-08-06.md`, the live authority for pre-08-18 open work). It owns
only the four rows above. The `next-waves/MASTER-ROLLOUT.md` precedent applies verbatim here: **this
file is a SEQUENCE, not a status register** — status lives in the issues and the child PRPs' own
ledgers. Add one row for this master to the finishline register (or its successor audit) at
kickoff so the authority chain has a single entry point to today's programs.

---

## 2. Program invariants (binding on every lane, every sprint)

1. **Fix-before-build on shared files.** Where a C1 fix and a C2 build touch the same surface
   (`evaluation` editor, budgets dialog, mirror editor, workspace Settings drawer), the C1 fix
   merges first. Building new capability on a surface with a known open defect is how the #3753
   pattern (half-fixed siblings) gets minted — this rule exists because that has now happened
   three times.
2. **Deploy trust before deploy-dependent claims.** No milestone below M0 may be declared while
   EXT is open: a "shipped" that the scheduled deploy can silently revert (#3676's proven repro)
   is not shipped. MAG receipts additionally require the Gov estate current per its own readiness
   banner (`check-deploy-staleness.mjs` green).
3. **Receipts or it didn't happen.** Dual-cloud G1 browser receipts per the child PRPs' DoD;
   `tsc`/vitest/DOM-strings are not completion evidence anywhere in this program.
4. **Lane discipline.** Work items carry their repo lane labels (`lane:console`, `lane:dataplane`,
   `lane:bicep`, `lane:ci`). WIP ≤ 2 concurrent items per lane; shared-file items are sequenced
   within one lane, never parallelized across agents (worktree isolation mandatory for all agent
   builds, per this repo's standing practice).
5. **Security §12 of C2 is program-wide.** Its cross-cutting controls (Entra/UAMI-only, KV-only
   secrets, private-link Gov profile, PDP-before-prompt, default-deny agent tools, audit-row
   completeness, threat-model-before-build for new services, two-key for cross-boundary sharing)
   bind C1 fixes too where applicable — a C1 fix that touches an audit writer inherits control 6.
6. **No silent scope growth.** Wave-B (C1) and Wave-G (C2) items enter sprints only through their
   mandated grooming passes. Anything discovered mid-program gets filed and routed here, not
   absorbed into an in-flight item.

---

## 3. Unified dependency graph (the one picture)

```
EXT deploy-chain (#3676 #3713 #3714; #3730 root landed 049349a9)
 │  gates: trustworthy ship + all MAG receipts
 ▼
┌─ M0 ─────────────────────────────────────────────────────────────┐
│ EXT closed; roll verified stable twice on BOTH estates           │
└──────────────────────────────────────────────────────────────────┘
 │
 ├── C1 Wave R (#3753 systemic oid-key sweep; #3729 readiness Fix-it) ─┐
 ├── C1 Wave T (lying-UI ×5)                                          │ M1
 ├── C1 G2-1: land + run PR #3534 click-sweep (measurement backbone) ─┘
 │
 ├── C1 Waves D/F/X/N (data-correctness, freeform, rendering, nav)
 ├── P0 hot items: #3549 #3551 (empty pipelines/activators), #3528 (hydration root, C1-X1 rides it)
 │
 ├── C2 Wave A (Fabric fast-follow; A4 Live Push first; A1–A3 one mirror lane)
 ├── C2 F1 Model Gateway  ──────┬─→ C2 Wave D Analysis Spaces
 │                              └─→ C2 Wave C Agent Foundry
 │        C blocks additionally on: AIF-PRP spine, P0 #3508 + #3543 (evaluation
 │        surface fixes), C2-A7 (#3768 agent UAMI)
 ├── C2 Wave B Loom Connect (independent; after Wave A's Monitor-hub patterns settle)
 │
 ├── C2 Wave E metrics (after D exists to consume it)
 ├── C2 F2 secrets · F3 OpenSharing (two-key; after B's KV/egress patterns) · F4 Lakebase re-audit
 │
 ├── C1 Wave B grooming (4 breadth epics → sized sub-issues) — feeds later sprints
 ├── C1 Wave C docs + C1 Wave G guardrail — background lane, any time after M1
 │
 └── C2 Wave G beyond-parity (G1–G4) — groomed only after their foundations land
```

Cross-PRP hard edges, stated once: **C2-C ← P0(#3508, #3543) + C2-A7 + C2-F1 + AIF-PRP.**
**C2-D ← C2-F1.** **C2-F3 ← C2-B (patterns) + operator two-key.** **C1-X1 ← P0(#3528) root fix.**
**C2-A3 fast lane ← C2-A4.** Everything else is parallelizable within lane WIP limits.

---

## 4. Milestones (program heartbeat — each is a demo, not a date)

| # | Milestone | Exit evidence |
|---|---|---|
| **M0** | **Deploy trust restored** | EXT issues closed; one merge traced to BOTH estates within allowance, twice consecutively; no silent-revert recurrence across a scheduled-deploy cycle |
| **M1** | **The console stops lying & measurement goes durable** | C1 Waves R+T merged with receipts; PR #3534 click-sweep landed and producing per-surface verdicts in CI; readiness Fix-it matches env-config truth |
| **M2** | **Data correct, freeform down, P0 defects dead** | C1 D/F/X/N done; P0 #3549/#3551 fixed (installed pipelines/activators are non-empty, re-verified via app reinstall); no-freeform count strictly below the 2026-08-14 baseline |
| **M3** | **Fabric fast-follow complete** | C2 Wave A: all 8 build items live on MAC, live-or-honest-gated on MAG, per-item better-than markers demonstrated where claimed |
| **M4** | **First leapfrog live in Gov** | EITHER Loom Connect Tier-1 slice 1 (real Salesforce/ServiceNow sync on GCC-High) OR Agent Foundry C1–C4 (brief→eval'd agent, Gov path) — whichever lane lands first; the point is a capability Databricks does not offer that audience |
| **M5** | **Trust primitives + semantics live** | Gateway routing ≥1 migrated copilot both clouds; governed secrets in use by a real notebook; OpenSharing share→consume→revoke receipt; metrics "same number in 3 places" demo |
| **M6** | **Rival grade declared honestly** | The 12 `_TBD_` experience grades in `docs/fiab/prp/README.md` populated FROM click-sweep receipts; `MASTER-SCORECARD.md` + competitive PARITY-MATRIX re-baselined; C2 Wave G groomed with its foundations proven |

Milestones may overlap in execution (M3 lanes can run during M2) but are **declared** in order —
M4 cannot be claimed before M1, because an unmeasured estate can't prove a leapfrog works.

---

## 5. Intake & cadence (how sprints draw from this program)

- **Sprint intake order** while unblocked work exists at a tier: EXT → C1-R → C1-T ∥ G2-1 →
  {C1-D/F/X/N ∥ P0 hot ∥ C2-A} → {C2-F1 → C2-C/D ∥ C2-B} → {C2-E/F2/F3/F4} → grooming outputs
  (C1-B, C2-G) → C1-C docs (background, always eligible).
- **Labels:** program items already carry `sprint:next`. Promotion to `sprint:active` follows the
  intake order above; an item whose §3 edge is unmet is `sprint:blocked` with the blocker named in
  a comment (house convention).
- **Grooming debt rule:** the C1-B and C2-G grooming passes are themselves sprint items (sp:3
  each) — schedule them like work, or the epics silently rot.
- **Scorecard cadence:** at every milestone declaration AND at least once per week of active program
  work, append a dated status comment to THIS master's PR/issue thread: milestone state, items
  merged with receipt links, blockers. This file itself is only edited when SEQUENCE changes.
- **Conflict avoidance:** this repo runs concurrent autonomous agents. Program work claims its
  lane label before starting (issue assignment or a comment), builds in an isolated worktree, and
  commits by explicit pathspec. The mirror-editor lane (C2 A1–A3 + C1's mirror-adjacent fixes) is
  the known hot spot — ONE agent owns it at a time.

---

## 6. Risk register (top 6, with the mitigation that is already in-plan)

| Risk | Mitigation in-plan |
|---|---|
| Deploy chain regresses again mid-program (it has twice: #3676, then #3781/#3782 red-main today) | M0 exit requires two consecutive clean cycles; invariant 2 blocks "shipped" claims while red; `check-deploy-staleness` is the instrument, not vibes |
| MAG model availability blocks C2-C/D outcomes | Gateway (F1) is built BEFORE both; per-cloud registry + honest gates + Agent Framework fallback are the design, not an afterthought |
| Shared-file collisions between C1 fixes, C2 builds, and the autonomous dev-loop | Invariant 1 (fix-before-build) + invariant 4 (lane WIP, worktrees, pathspec commits) + the named mirror-lane single-owner rule |
| Evaluation-surface dependency chain stalls C2-C | The chain is explicit (§3); if P0 #3508/#3543 stall, C2-D proceeds independently — M4 has two candidate lanes on purpose |
| Grading drift recurs (docs say A, live says broken) | M1 makes the click-sweep the standing instrument; M6 forbids grade population from static reads; C1-G guardrail catches sibling-fix omissions |
| Scope creep via Wave G enthusiasm | Invariant 6: G enters only groomed, only after foundations; the operator's two-key holds for cross-boundary sharing regardless of momentum |

---

## 7. Kickoff (paste-able; per the `UNLEASH-KICKOFF.md` precedent)

> Read `PRPs/active/program-master-2026-08-18/PRP.md` in full. Determine current milestone state
> by measurement (issue states, estate readiness banners, click-sweep availability) — not from the
> most recent status comment. Select the highest-priority unblocked items per §5 intake order,
> respecting §2 invariants and §3 edges. Execute via the established sprint workflow
> (`.claude/workflows/loom-sprint.js` conventions: groomed story, isolated worktree, independent
> QA that re-derives acceptance criteria, dual-cloud G1 receipts per the child PRP's DoD). File —
> never absorb — anything discovered out of scope. Close by appending the dated status comment per
> §5 cadence, including what did NOT land and why.

## 8. Program done

This master closes when M6 is declared with evidence, all C1/C2 waves are complete or explicitly
re-registered (grooming outputs and Wave-G items may outlive it as ordinary backlog), EXT has held
green for the duration of M3→M6, and a closing audit comment maps every issue in §1's four rows to
merged-with-receipt / re-registered-where / consciously-dropped-why. Anything less stays open.

---

## Index of everything this program owns

- **C1 issues:** #3718–#3726, #3729, #3733–#3743, #3746–#3753, #3757 (2 subsumed: #3747, #3751)
- **C2 issues:** #3762–#3778 (+ evidence comment on #3719)
- **P0 gating items referenced:** #3508, #3543, #3528, #3549, #3551 (pool: #3527 + #3615)
- **EXT:** #3676, #3713, #3714 (#3730 root landed `049349a9`)
- **PRs:** #3758 (C1), #3780 (C2), #3534 (click-sweep — M1 dependency, pre-existing)
- **Research artifacts:** `temp/databricks-gap-analysis-2026-08-18.md`; #3527 comment thread
  (2026-08-18 supplementary-sweep + rollup comments)
