# PRP — Backlog Drain 2026-08-31

**Status:** active · **Opened:** 2026-08-31 · **Branch:** `docs/drain-prp-2026-08-31`
**Supersedes:** the scope claims in `PRPs/active/REGISTER.md` (rewritten alongside this PRP)

> **Driver (operator, verbatim):** *"track it all, write a complete spec/prp for
> everything you listed here, everything you owe me so nothing is left on planed or
> does not have a complete spec for. do a deep review and make sure the
> spec/plan/prp is built to do complete dev loops and ships as much as possiable in
> parrellel it can use agent workflows, and subagent, multiple models to optimize
> the dev, test, valdatate deploy workflows."*

This PRP is the single register for **every open item** in `csa-inabox` as of
2026-08-31: 243 open GitHub issues, four live operator bug reports, four in-flight
PRPs, and five measured-but-unfiled defects. Nothing is "planned" without a spec —
if it is not built here, it is explicitly **parked with a reason and a date**, and
that parking is itself recorded.

Companion documents, all normative:

| File | Holds |
|---|---|
| `LEDGER.md` | Per-issue register of record — all 243, by number, with verdict or `PENDING-TRIAGE` |
| `OWNERSHIP.md` | File-ownership map, collision matrix, the five serializing artifacts, lane cut |
| `DEV-LOOP.md` | dev→test→validate→deploy loop, rigor tiers, multi-model role assignment |
| `OWED.md` | Everything owed to the operator: live bug reports, Gov parking, receipts, parked features |

---

## 1. The measured population

Source: `gh issue list --state open --limit 500 --json number,title,labels`, captured
2026-08-31 into `temp/open-issues.json`, rendered by `temp/issue-inventory.py`.
**243 open issues.** This is a census, not a sample.

**Label histogram (measured, not estimated):**

```
114 sprint:next     112 lane:console     93 csa-loom        69 bug
 53 sp:3             51 sp:5             37 lane:ci         32 sp:8
 30 lane:bicep       26 csa-bug          23 csa-feature-request
 22 enhancement      21 lane:dataplane   20 security        19 sprint:active
 18 deploy-validation 16 sp:13           12 sprint:blocked   9 epic
  6 sp:1              4 drift-gov         3 documentation     3 bicep-drift
  1 synthetic-monitor 1 drift-commercial
```

**Derived facts that shape the plan:**

- **112 of 243 (46%) are `lane:console`.** The console is the contention point.
  Any lane model that does not sub-partition `apps/fiab-console/**` by file will
  serialize half the backlog behind one lane.
- **85 issues carry no size label** (158 of 243 are sized). Sizes below come from
  triage, not from labels, wherever triage has reached.
- **98 issues carry no sprint label** — they were never scheduled. They are still
  in this register; unscheduled is not the same as closed.
- **43 issues carry no lane label** and must be assigned a lane from their triage
  file list, not guessed from the title.

---

## 2. Scope decision — defects in, features parked

Operator decision (recorded 2026-08-30): **"Defects only, ignore features for now."**
Paired with: **"Defects and deploy first, features after."**

| Class | Count | Disposition |
|---|---|---|
| `bug` + `csa-bug` + `security` + `deploy-validation` + unlabeled defects | ~187 | **IN SCOPE** — waves W0–W5 |
| `csa-feature-request` + `enhancement` + `epic` | ~33 | **PARKED** — enumerated in `OWED.md` §4, unparked at W6 |
| `documentation` | 3 | In scope where a doc is the deliverable of a defect fix |

**Parking is not deletion.** Every parked item appears in `LEDGER.md` with
`PARKED-FEATURE` and the reason. The operator's instruction was to *sequence* them
after defects, not to drop them. W6 exists precisely so nothing is lost.

The parked set (enumerated so it can be audited): #3777, #3776, #3775, #3774,
#3773, #3772, #3771, #3770, #3769, #3768, #3767, #3766, #3765, #3764, #3763,
#3762, #3721, #3719, #3699, #3615, #3589, #3538, #3536, #3535, #3527, #3361,
#3355, #3354, #3352, #3351, #3350, #3343, #1483.

---

## 3. Triage state — honest coverage

Triage is the act of converting an issue title into (verdict, files, size,
evidence). Titles are **not** trustworthy inputs: this program has already found
two materially mis-titled issues (§8) and three issues whose fix had already
landed.

| State | Count | Meaning |
|---|---|---|
| **Triaged** | 85 | A verdict + size + evidence line exists in `LEDGER.md` |
| **PENDING-TRIAGE** | 158 | Carried in `LEDGER.md` by number and title, no verdict yet |

These are the measured counts from `LEDGER.md`, which is generated from a live
`gh issue list` and is the register of record for the split. **158 issues remain
untriaged and are carried explicitly, not silently omitted** — that is the single
most important honesty property of this document. A plan that quietly covered only
the 85 triaged issues would be the exact failure this PRP exists to prevent.

A second honesty property sits underneath the first: of the 85 triaged, some carry
verdicts **measured in an earlier window and relayed**, not re-measured at head.
`LEDGER.md` flags those rows `INHERITED` and explains why — a carried finding is a
hypothesis, and the lane re-measures before it writes code.

**Verdict vocabulary** (used in `LEDGER.md`):

| Verdict | Meaning | Where it goes |
|---|---|---|
| `REAL` | Defect confirmed at HEAD by source read | A code wave |
| `STALE` | Already fixed at HEAD; issue is out of date | Close with the measurement, no code |
| `NEEDS-ESTATE` | Code is correct; only a live receipt is owed | A batched validation window (§5, W4) |
| `NEEDS-DECISION` | Fix hinges on an operator cost/security/scope call | `OWED.md` §2 — asked, not guessed |
| `DUPLICATE` | Subsumed by another issue | Close, pointing at the survivor |
| `PARKED-FEATURE` | Feature/epic, deferred to W6 | `OWED.md` §4 |
| `PENDING-TRIAGE` | Not yet examined | W0 triage sweep |

---

## 4. Wave structure

Waves are **sequential**; lanes **inside** a wave are parallel. The wave boundary
exists where a dependency or a shared file makes parallelism unsafe — never merely
because two items sound related.

### W0 — Deploy paths (P0, preempts everything)

`deploy-integrity.md` **R1**: *"If any deploy, build, or roll workflow is failing,
fixing it preempts all feature work. Not 'after this PR'. Immediately."* This is not
discretionary and it is why W0 is first.

Measured broken / never-run / reverting deploy paths:

| Issue | Path | Measured state |
|---|---|---|
| #3676 | scheduled deploy | **P0** — silently REVERTS rolled images |
| #3683 | GCC-High + IL5 | carries both halves of #3676 |
| #3754 | infra-deploy | **P0** — only Commercial has a working path |
| #4190 / #4196 | `loom-dataplane-roll` | failing; reverts a HEALTHY roll on unreadable digest |
| #3968 | `console-bluegreen-roll` | 3 consecutive FAILURE, ~3wk unrun |
| #3429 | `deploy-copilot-function` | **P0** — 7 straight failures |
| #4072 / #3449 | `deploy-fiab-gcch` | 16 consecutive failures |
| #4071 | `deploy-fiab-gcc` | `disabled_manually` |
| #4073 | `deploy-fiab-il5` | no `schedule:`/`cron:` in `on:`; never dispatched |
| #3346 | unity / iceberg-catalog / trino | no automated roll at all |
| #4064 | step 27 | manufactured UNKNOWN from a shared ACR repo |
| #4144 | six paths | untracked, stale or never-run |
| #3882 | `loom-drift-check` | **6 consecutive failures, 2026-08-10 → 2026-08-31** (see §8 conflict) |

W0 also runs the **triage sweep** for the 158 `PENDING-TRIAGE` issues, in parallel
with the deploy repair — triage is read-only and collides with nothing.

**W0 exit:** every path above either green on a real run, or **parked with a named
owner and a date** per the operator's Gov decision. A path parked without a date
does not clear W0.

### W1 — The four live operator bug reports

These are the only items with a live, operator-observed symptom. They outrank
everything except a broken deploy path because they are what the operator can *see*.

1. **Iceberg REST catalog + external-engine federation dead in MAC and MAG** —
   #3339, #3110, #3841, #3746. Operator decision: *"chase the audience/credential-
   vending hypothesis in code."*
2. **Estate power button not enabled** — #3922 and the `estate-pause-resume` PRP.
   Operator decision: **arm by default in every boundary.**
3. **Brain not visible** — #4222 (zero inbound links), #3933/#3934/#3937.
4. **Cleanup engine not visible / not wired.**

**W1 exit:** each of the four demonstrated working in a **live browser on a real
estate**, per `ux-baseline.md` G1. Not tsc, not vitest, not a DOM string.

### W2 — Console defect drain

The 112 `lane:console` defects, sub-partitioned by file per `OWNERSHIP.md`.
Gated on the **#3847 bounding pass** (§7).

### W3 — Bicep, auto-bind and provisioner drain

`platform/fiab/bicep/**` + `apps/fiab-console/lib/install/provisioners/**`.
Anchored by `auto-bind-by-default.md` §5 (*infra is deployed, not requested*) and
§3 (*the binding is self-healing*). Largest single item: **#3513 — 119
`status:'remediation'` sites across 26 provisioner files, zero Fix-it affordances**
(a ~5× undercount vs. the issue's own text; re-measured 2026-08-31).

### W4 — Batched validation windows

Operator decision: **"Batched validation windows."** The estate stays PAUSED
(`csa_loom_estate_pause_resume_mandate`) except inside a declared window. Every
`NEEDS-ESTATE` verdict queues here rather than blocking a code lane.

Known queue: #3327, #3633, #3736, #3525, #4030 (rotation + live log receipt), plus
the G1 receipts listed in `OWED.md` §3.

### W5 — Guard strength

Guards that are green while watching nothing. This wave is scheduled **last among
the defect waves** deliberately: a guard hardened before the defect it guards is
fixed produces a red lane with no fix available, and the measured history of this
repo is that such lanes get disabled rather than fixed
(`csa_loom_red_lane_disabled_not_fixed`).

**Stop rule (binding):** at most **two** rounds of guard hardening per guard. Round
1 fixes the measured bypass; round 2 fixes what round 1's own mutation testing
finds. **At round 3, merge the gain and file the class as an issue — do not
continue enumerating.** Measured basis: `csa_loom_each_guard_fix_was_a_narrower_enumeration`
(three rounds; three of round-2's fixes were *regressions*) and
`csa_loom_a_layer_keyed_control_loses_to_the_next_layer` (round 2 lost to a
44-byte move into another function, log byte-identical).

### W6 — Unpark features

The 33 parked items. Not started until W0–W5 close. Listed in `OWED.md` §4 so the
operator can pull any of them forward by name at any time.

---

## 5. Program invariants

These hold at **every** merge in every wave. They are drawn from measured incidents
in this repo, not from principle.

**I1 — Re-derive generated artifacts; never hand-merge them.** Five committed
generated files serialize every parallel PR that touches them. One merge
re-conflicted *seven* PRs and voided their CI. The five:
`security-graph.json` · `docs/fiab/route-inventory.md` ·
`apps/fiab-console/deploy-templates/main.json` ·
`apps/fiab-console/lib/api-routes.generated.d.ts` / `.json` ·
`scripts/ci/no-freeform-inputs-baseline.json`.
Re-derive in a scripted loop after every base update. See `OWNERSHIP.md` §4.

**I2 — Preflight every merge.** Operator decision: *"Tighten last, preflight every
merge."* Run `temp/merge-eligible.py <PR>` and `temp/hollow-control.py` before
merging. A REQUIRED check can be green over a suite that never executed
(`csa_loom_required_check_green_over_an_unexecuted_suite`). Only **15 of ~35**
checks can block; CodeQL, Checkov, IaC Security Scan, Bicep Lint, `node:test
suites`, `Frontend Tests / jest`, and the `security-graph.json` drift check are
rigorous and **advisory** — a green rollup is not a green build.

**I3 — A verdict returned is not a verdict posted.** Operator decision: *"I review
each, post the verdict, then `--admin` merge."* The reviewer agent's finding must
be `gh pr comment`-ed onto the PR or it does not exist.

**I4 — Merged is not deployed.** `deploy-integrity.md` R2. Read
`/build-marker.txt` before saying anything shipped. The Commercial estate rolls
itself; Gov does not roll on the same trigger. Report state in three distinct
words: **merged** / **deployed** / **verified live**.

**I5 — A lane may not touch a file outside its declared ownership.** If the fix
requires it: **STOP and report a blocker.** Do not widen silently. A file partition
can fence a lane away from its own root cause
(`csa_loom_file_partition_can_exclude_the_root_cause`) — that is a signal to
re-cut the lane, not to reach across it.

**I6 — The estate stays PAUSED outside a declared validation window.** MAC + MAG
both. Gov work runs on an in-boundary runner via GitHub Actions; there is **no
local `az` path to Gov, ever**, and the workstation `az` context is a *different
tenant* — run `az account show` before believing any local Azure output.

**I7 — Capture `RC=$?` on the line immediately after the subject command.** Never
after a pipe; the exit code you read is the wrapper's, not the subject's.

**I8 — Cloud parity is the bar.** `cloud-parity.md`: a fix that lands Commercial-only
is **INCOMPLETE**, not "Commercial-first". Every PR states which boundaries it was
verified against. An untested boundary is *declared* untested, never implied working.

**I9 — Audit issue closure after every merge.** A merge can auto-close an unclaimed
issue; the string *"Does not close #N"* **closes #N**
(`csa_loom_release_merge_auto_closes_unclaimed_issues`).

---

## 6. Parallelism model

**Parallel safety is a property of FILES, not of topics** (CLAUDE.md §8). Lanes are
cut from the measured file lists in triage, never from issue titles.

- **WIP ceiling: 4 concurrent lanes** (CLAUDE.md §9). The ceiling is *review
  capacity*, not compute. Operator decision: *"Big batches, one CI cycle each."*
- **Runner capacity is the real ceiling past ~10 cycling PRs** (24 active / 18
  queued measured). Review-only lanes are free and do not count.
- **Branch protection is `strict: false`** — PRs do not need to be up-to-date to
  merge, which is what makes big batches viable. Do not turn `strict` back on:
  it is quadratic and previously starved the runners into false reds.

Full lane cut, collision matrix and the cross-batch collisions the individual
triage agents could not see: **`OWNERSHIP.md`**.

---

## 7. The #3847 bounding pass — a scheduling constraint, resolved

**#3847** (`exactOptionalPropertyTypes` unset in the console tsconfig) is sized **L**
with scope *"`apps/fiab-console/tsconfig.json` + an unsized sweep of every consumer
the flag flags."* Two triage agents independently sized it that way, and one added:
*"Do not parallelize anything else against `apps/fiab-console` until this lands or
its scope is bounded by a first pass."*

That constraint, taken literally, blocks 112 of 243 issues behind one item.

**Resolution — bound it, do not serialize behind it.** Before W2 opens, run a
single measurement pass:

1. Turn the flag on locally in `apps/fiab-console/tsconfig.json`.
2. Capture the full `tsc` error list. **Do not fix anything.**
3. The set of files in that error list becomes #3847's **declared file ownership**,
   recorded in `OWNERSHIP.md`.
4. Every console file *not* in that list is free to parallelize immediately.
5. Revert the local flag; #3847 then proceeds as a normal lane against its now-bounded
   file set.

This converts an unbounded constraint into a measured file list — which is exactly
the doctrine in I5. It costs one `tsc` run. **This is an assumption I am taking, not
an operator decision**: if the error list turns out to be effectively the whole
console, #3847 falls back to a solo wave and W2 is re-planned behind it. That
outcome is reported, not absorbed.

---

## 8. Known conflicts in the evidence base

Recorded rather than resolved by preference. `csa_loom_agreement_is_not_independence_shared_method`:
two agents using the same method (source inspection) agreeing is a **cross-check**,
never independent confirmation. Each conflict below is resolved by **one fresh
measurement at implementation time**, by the lane that owns the file.

**C1 — #3458 site count: 41 vs 109 vs 33.** Three measurements of three different
populations: 41 *executed* sites across 17 files (direct re-grep); 109 *raw* grep
hits (the issue's own history reads 40→66→109); and the guard's own live output —
*"D3 judged ZERO of 33 executed `az role assignment create` calls."* The direction
is **not** in dispute: zero sites pass `--name`, and the guard judges none of them.
Defining the population is part of the fix, not a precondition to it.

**C2 — #3882 `loom-drift-check`.** A prior window recorded this as *settled STALE by
live measurement*. A 2026-08-31 measurement reports **6 consecutive `failure`
conclusions, 2026-08-10 through today**. The fresh measurement governs; #3882 is
carried as **REAL** into W0 and the earlier note is retired.

**C3 — #4030 `LOOM_INTERNAL_TOKEN`.** One agent: `STALE` — only SHA256-fingerprint
logging present, no raw dump anywhere in the file. Another: `NEEDS-ESTATE` — the
mechanism half landed via #4061 (all four lanes call `resolve-internal-token.sh
--github-env`), leaving the **rotation of the already-published value** plus a live
log receipt. These are compatible: **the code is fixed; the operational residual is
real.** Carried as `STALE-CODE / OWED-ROTATION` → W4.

**C4 — #4035 and #4064 rest on memory, not a fresh grep.** The reporting agent
disclosed this itself. Both are marked `PENDING-REVERIFY` in `LEDGER.md` and must be
re-measured before their lane opens.

**C5 — #4038's two halves have different provenance.** The mirror-stuck-at-14 half is
directly measured (`release-please.yml` has exactly 14 entries; its own comment says
*"Last reconciled against protection: 2026-08-13 (14 contexts)"*). The
*"protection now requires 15"* half was measured live by a **different** agent
(15 contexts, including `changelog parser can read every commit message`). Two
sources, two methods — accepted, with the provenance recorded.

**C6 — #3941 was mischaracterized and is now corrected.** It read as *"owner-only
point read bypasses workspace ACL"* — a live security hole. It is not. The guard's
own `TOUCH_EXEMPT` map documents an intentional, disclosed deferral; `loadItem`
checks `tenantId` inline instead of routing through `authorizeItemWorkspace`, and
the exemption **fails closed**. It leaks nothing today. This is a **guard-strength
gap** (W5), not an authz bypass (W1). Carrying the original framing would have
mis-prioritized it by four waves.

---

## 9. Re-scoped issues — do not copy these titles

Two issues are materially mis-titled. The ledger carries the measured scope, not
the title.

**#3727** — titled *"/browse fetches same 500-item query 8×."* Measured: `browse/page.tsx`
issues no `/api/items/by-type` call at all; the only reachable call site is
`all-items-explorer.tsx:133`, a single `useEffect([])` that pages via continuation
token and **correctly breaks** when none is returned. The "8×" is far more likely N
legitimate pages of a large tenant scan (or a React StrictMode dev double-invoke)
than N duplicate identical queries. **The real defect is narrower and still real: no
cache/dedup across mounts** — navigating away and back re-runs the entire multi-page
scan from zero. One file, size **S**, not the multi-file perf investigation the title
implies.

**#3633** — titled as needing metric-kind hardening. Measured: that hardening
**already exists** at `eval-regression-lib.mjs:100-227` (`deterministicPassRate` vs
`passRate`, `predicate.degraded`). The remaining blocker is diagnosing the **live
judge deployment**. Re-classified `NEEDS-ESTATE` → W4; it is not a code task.

---

## 10. Milestones and exit evidence

No milestone closes on a merge. Each names the artifact that proves it.

| M | Wave | Exit evidence |
|---|---|---|
| **M0** | W0 | Every deploy path green on a real run, or parked with a named owner + date. `gh run list` output attached. |
| **M1** | W1 | Four live-browser receipts — Iceberg/federation, estate power button, Brain, cleanup engine — in **both** MAC and MAG. |
| **M2** | W0 | Triage sweep complete: `LEDGER.md` shows **zero** `PENDING-TRIAGE`. |
| **M3** | W2 | Console defect count ≤ 20 open; each remaining one carries a verdict + owner. |
| **M4** | W3 | `#3513` closed: 119 remediation sites across 26 files each carry a Fix-it affordance or a registry entry with a cost/consent reason. |
| **M5** | W4 | Every `NEEDS-ESTATE` receipt collected in a declared validation window; estate returned to PAUSED afterward. |
| **M6** | W5 | Guard mutation suites pass at parent **and** tip over the same fixtures. Round-3 classes filed as issues, not chased. |
| **M7** | W6 | Parked features unparked or re-parked with a dated reason. `LEDGER.md` has no unexplained rows. |

---

## 11. Definition of done — for this PRP

1. `LEDGER.md` accounts for **all 243** issues. Zero `PENDING-TRIAGE`. Every row has
   a verdict, an owner, and a wave — or an explicit dated park.
2. Every `REAL` defect is **merged AND deployed AND verified live**, in every
   boundary it claims to support (I4, I8).
3. Every `NEEDS-ESTATE` receipt is collected and attached to its issue.
4. Every `NEEDS-DECISION` is in `OWED.md` §2 **as a question with options and a
   recommendation** — never silently defaulted.
5. `OWED.md` has no unanswered rows: each is delivered, or parked with a date.
6. `PRPs/active/REGISTER.md` reflects reality (rewritten with this PRP — the
   operator's finding was that it is *"actively misleading"*).
7. Issue closure audited after every merge (I9). No issue closed on a merge alone.

## 12. Risks

| Risk | Measured basis | Mitigation |
|---|---|---|
| Merge queue starvation | 12/12 PRs BEHIND, false reds, `strict=true` is quadratic | Keep `strict:false`; big batches, one CI cycle each |
| Generated-artifact conflict storm | one merge re-conflicted 7 PRs, voided their CI | I1 — scripted re-derive, never hand-merge |
| Guard hardening becomes an infinite regress | 3 rounds; 3 of round-2's fixes were regressions | W5 two-round stop rule |
| Estate cost while unpaused | ~$3k/mo untagged estate (#3922) | I6 — PAUSED outside declared windows |
| A fix lands Commercial-only and reads as done | `cloud-parity.md`; UC does not exist in MAG | I8 — per-boundary declaration on every PR |
| Triage verdict goes stale before its lane opens | carried findings are hypotheses | Re-verify at head when the lane opens; C4 rows first |
| Reviewer verdict never reaches the PR | measured, repeatedly | I3 — `gh pr comment` or it did not happen |
