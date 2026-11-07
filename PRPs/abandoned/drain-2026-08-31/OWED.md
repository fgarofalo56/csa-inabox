# OWED — everything owed to the operator

Companion to `PRP.md`. This is the honesty ledger: what has been promised, what has
been measured but not filed, what is parked and until when, and what questions are
outstanding.

Operator requirement, verbatim: *"everything you owe me so nothing is left on planed
or does not have a complete spec for."*

Standing operator instruction, repeated across the program: *"anything you need a
decision on from me, please ask with options and your recommendation and i will
select, for everything else please use the best way to move forward."* §2 is where
those questions live. Everything not in §2 proceeds on my judgement.

---

## 1. Measured defects not yet filed as issues — ALL FILED 2026-08-31

Five defects measured during triage that had **no GitHub issue**. Each was
re-verified at head on 2026-08-31 before filing (a carried finding is a
hypothesis), and each is now tracked:

| # | Defect | Disposition (2026-08-31) | Wave |
|---|---|---|---|
| **U1** | `deploy-fiab-il5.yml` is dispatch-only, zero runs ever | **Already tracked by #4073** — re-measurement comment posted. Two corrections at head: the `il5-deploy` environment now EXISTS (required-reviewer rule 63816614), and adding a bare `schedule:` would reproduce #4233's parked-forever state on IL5 | W0 |
| **U2** | `console-bluegreen-roll` consecutive failures, unrun since 2026-07-31 | **Already tracked by #3968** — re-measurement comment posted; staleness has grown to a month, direction unchanged (needs a dispatch, not a fix) | W0 |
| **U3** | Required-context gap: the security-graph drift check and `jest (node 20.x)` cannot block | Graph half was **already filed as #4029**; jest half filed as **#4234**. Both verified present on the main tip and absent from the 15 live contexts | W5 |
| **U4** | The GCC-High estate-pause declaration has drifted from its observed symptom | Filed as **#4233**, with a sharper measurement than this row carried: since 2026-08-27 every scheduled gcch run parks at `waiting` on the `gcc-high-deploy` approval gate — zero steps, neither red nor green — so the #4117 stand-down machinery is unreachable and the declared symptom is unobservable | W0 |
| **U5** | **Gov has no estate resume path** — `estate-resume.mjs` is all-Commercial by its own header | Filed as **#4235**. #4149's boundary guard refuses correctly (fail-closed); the capability itself is absent | W1 (estate-power lane) |

**U5 remains the sharpest.** The operator's decision was *"arm the estate power
button by default in every boundary."* A resume script that hard-codes the Commercial
RG cannot satisfy that decision in Gov, and `cloud-parity.md` makes Commercial-only
**INCOMPLETE**, not "Commercial-first". #4235 is scheduled into the W1 estate-power
lane with #3922 — filed AND scheduled, not filed-and-deferred.

The duplicate-check before filing did real work: two of the five (U1, U2) were
already tracked, and half of U3 was (#4029) — filing blind would have minted three
duplicates, the #4055 mistake repeated.

---

## 2. Open questions — decisions I will not guess

Per the standing instruction, each carries options and a recommendation.

### Q1 — #3915: Copilot corpus has zero `repo`-kind chunks in production

Verdict `REAL`, plus a genuine scope decision. The stage script is markdown-only and
never globs `lib/`; the Dockerfile runner stage copies `public`, `.next/standalone`,
`.next/static`, `samples`, `copilot-corpus`, `deploy-templates` — **no raw `lib/`**.
So `detectRoots()`'s `consoleLibRoot` (the `repo`-kind root) is unreachable in the
shipped image. The parity test checks the two hand-maintained lists agree **with each
other**, not that either path exists at runtime — it has already drifted once (#3881).

| Option | Cost | Effect |
|---|---|---|
| **A (recommended) — stage `repo` chunks at build time into `copilot-corpus`** | M | Keeps the image lean; the corpus stays a build artifact; kills the hand-maintained-list class by making the corpus the single source |
| B — copy `lib/` into the runner image | S | Fast, but ships source into the runtime image and grows it |
| C — drop `repo`-kind entirely | S | Honest, but silently reduces Copilot's grounding |

**Recommendation: A.** It removes the drift class rather than re-synchronizing two
lists that have already drifted once.

### Q2 — #4035: `configure-branch-protection.sh` is itself stale

**Re-measured at head 2026-08-31** (this closes the `PENDING-REVERIFY` that
`OWNERSHIP.md` §5 C4 flagged). The script is at `scripts/github/configure-branch-protection.sh`
— *not* `scripts/csa-loom/`, as earlier notes implied. Reading it turned up **three**
regressions, not the one this question was originally raised for:

| # | What it sets | Live truth | Effect of running it |
|---|---|---|---|
| 1 | `contexts: [validate, test, security-scan]` | protection carries **15** contexts | Protection **reduced**. A required context must exist on main to block, so these three likely register as nothing |
| 2 | `"strict": true` | `strict: false` is a deliberate standing decision (§8) | Reinstates the quadratic setting that starved the runners into **false reds across 12/12 PRs** |
| 3 | `"enforce_admins": true` | `--admin` merge is standing-authorized | Revokes the merge authorization the drain's merge stage depends on |

| Option | Cost | Effect |
|---|---|---|
| **A (recommended) — regenerate the script from live protection, add a drift guard** | S | Script becomes truth-derived; a guard catches the next drift |
| B — delete the script | XS | Removes the footgun, loses the reproducible-protection capability |
| C — hand-edit to today's 15 | XS | Fixes today, drifts again by definition |

**Recommendation: A, unchanged and now better supported.** The measurement did not
move the recommendation — it moved the cost of *not* acting. Same shape as #4038 (a
mirror stuck at 14 while live is 15); one guard should cover both.

### Q3 — #3847 fallback if the bounding pass is unbounded

PRP §7 converts #3847 into a measured file list via one `tsc` run. **If that error
list is effectively the whole console**, the bounding fails and W2 must be re-planned.

| Option | Cost | Effect |
|---|---|---|
| **A (recommended) — #3847 becomes a solo wave; W2 opens after it** | L | Correct, serializes 112 issues behind one item |
| B — enable the flag per-directory via project references | L+ | Preserves parallelism, adds build complexity |
| C — defer #3847 to W6 | XS | Keeps the drain fast; leaves the typo class open |

**Recommendation: A**, and I will report the measured error-list size before choosing —
this question only activates if the measurement says it must.

### Q4 — #4071: deploy-fiab-gcc is NOT free to re-enable (added 2026-08-31)

The ledger carried this as *"FREE — re-enable, then measure."* Measured at head:
the disable is a **recorded decision** in `scripts/ci/workflow-lane-states-allowlist.json`
(owner, measured reason, reviewBy 2026-11-11), whose reason establishes the lane's 20/20 greens were hollow three independent
ways (no `AZURE_GCC_*` secrets · a since-fixed blind hub guard · `deployAppsEnabled`
never set, #3078). Re-enabling also trips allowlist rule 5 (an active lane with an
entry FAILS the guard) and produces a **daily correctly-attributed RED** until the
fork is decided. The entry itself records the fork as *"not an agent's call."*

| Option | Cost | Effect |
|---|---|---|
| **A (recommended if a GCC subscription exists to wire)** — wire `AZURE_GCC_*` + a GCC ACR image producer, then re-enable + delete the allowlist entry | M | Lane turns honest-green; also unblocks #3078 |
| B — re-enable now, secrets absent | XS | Daily honest RED naming the four missing secrets (the entry's own "recommended first step" per cloud-parity clause 1); standing dashboard noise until A or C |
| C — record GCC out of scope, with a date | XS | A cloud-parity violation that must be recorded, never implied |

Options + recommendation posted on the issue 2026-08-31; the ledger row is
`NEEDS-DECISION` until the operator picks.

### Q5 — the agent-triage sweep's decision queue (added 2026-08-31)

The 2026-08-31 sweep returned **11 further `NEEDS-DECISION` rows**. Each carries
its crisp question in its ledger note (`triage-agent-verdicts.json`); they are
queued here rather than expanded, and none blocks W0:

- **#3078** — same fork as Q4 (does a GCC estate exist to wire?). Resolve together.
- **#2642** — schedule the Commercial Redis→AMR cutover window; pick the Gov path
  (wait for AMR-in-Gov vs OSS-Redis-on-ACA).
- **#3457 / #3982** — thrift: no published parquet admits thrift≥0.18, so the fix
  is blocked upstream; accept-and-monitor or fork.
- **#3462** — release-please held runs: settle the premise before touching them.
- **#3778** — Lakebase parity doc: accept the declined GA rows or re-scope.
- **#3965** — cost-export.bicep: wire it or retire the allowlist entry.
- **#3985** — CodeQL alert at the measure.mjs spawnSync sink: model the sanitizer.
- **#4045 / #4047** — make CodeQL (and which advisory lanes) blocking; whether an
  admin-merge override trace is wanted. Belongs to W5 "tighten last".
- **#4051** — Gov nightly Brain scan needs an in-boundary runner: owner + date.

---

## 3. Owed receipts

Evidence promised but not yet collected. Each is a **W4 validation-window** item
unless noted.

| Receipt | For | Why owed |
|---|---|---|
| **LIN-GC-2 live scan on a real estate** | PR #4226 | #4226 explicitly did **not** claim it |
| `/admin/readiness` showing `svc-s3-gateway` | #3327 | All three code fixes are on main; only the live receipt remains |
| Live judge deployment diagnosis | #3633 | The metric-kind hardening already exists at `eval-regression-lib.mjs:100-227`; the blocker is the live Container App Job |
| `LOOM_INTERNAL_TOKEN` rotation + a live log receipt | #4030 | Code is fixed (SHA256 fingerprint only, no raw dump). The **already-published value must still be rotated** — a push publishes; treat it as compromised |
| Synthetic-run drop root cause | #3736 | Needs `ContainerAppConsoleLogs_CL`; the issue admits it cannot assert root cause without it |
| Kql-db remediation walk | #3525 | 5 confirmed sites at `provisioners/kql-db.ts:81,105,131,147,173` |
| Four G1 browser receipts, MAC **and** MAG | W1 | Iceberg/federation · estate power button · Brain · cleanup engine |

**#4030's rotation is a security item, not a cleanup item.** The value reached a
remote. Rotate first, then confirm by presence and behaviour only — never by value.

---

## 4. Parked features — 33 items, not lost

Operator decision: *"Defects only, ignore features for now"* and *"Defects and
deploy first, features after."* Parked ≠ dropped. W6 unparks them; any can be pulled
forward by name at any time.

```
#3777  #3776  #3775  #3774  #3773  #3772  #3771  #3770  #3769  #3768
#3767  #3766  #3765  #3764  #3763  #3762  #3721  #3719  #3699  #3615
#3589  #3538  #3536  #3535  #3527  #3361  #3355  #3354  #3352  #3351
#3350  #3343  #1483
```

Each appears in `LEDGER.md` as `PARKED-FEATURE` with its title, so the park is
auditable rather than implicit.

---

## 5. Gov parking — with dates, per the operator's decision

Operator decision: *"Fix what's free, park the rest with a date."* A Gov item parked
**without a date does not clear W0**.

| Item | Free or parked | Date |
|---|---|---|
| #4073 `deploy-fiab-il5` never dispatched | **Free** — add `schedule:` to `on:` | W0 |
| #4071 `deploy-fiab-gcc` `disabled_manually` | **Free** — re-enable, then measure | W0 |
| #4072 / #3449 `deploy-fiab-gcch` 16 consecutive failures | **Parked** — needs an in-boundary run to diagnose | W4 window |
| #3683 GCC-High + IL5 carry both halves of #3676 | **Free** — same fix as #3676 | W0 |
| U5 Gov estate-resume hard-codes Commercial RG | **Free** — parameterize the RG | W1 |
| Gov G1 receipts (all four W1 bugs) | **Parked** — in-boundary only | W4 window |
| 4 `drift-gov` issues | **Parked** pending the Gov drift lane | W4 window |

**Constraint that shapes all of the above:** there is **no local `az` path to Gov,
ever.** Every Gov receipt comes from a GitHub Actions run on an in-boundary runner.
The workstation `az` context is a *different tenant* — `az account show` before
believing any local Azure output.

A note on a retired premise: the claim *"Gov is 251 commits behind"* is **stale and
contagious**; Gov continuous deploy was fixed 2026-08-18. Read **Gov's own**
`/build-marker.txt` before repeating any Gov drift number.

---

## 6. In-flight PRPs

| PRP | State | Disposition |
|---|---|---|
| `PRPs/active/estate-pause-resume/` | In flight | Folds into W1 estate-power lane; U5 is its Gov half |
| `PRPs/active/loom-brain/` | In flight | Folds into W1 brain lane (#4222 = zero inbound links) |
| `PRPs/active/omnibus-2026-08-22/` | Superseded in scope | Its open items are absorbed into `LEDGER.md`; keep for history |
| `PRPs/active/snowflake-parity/` | In flight — committed on this branch by `fe7141df74` (PR #4232) | Feature-class → W6. Decisions recorded: migration-first, transpiler now / wire-compat later, **outcome** parity |
| `PRPs/active/REGISTER.md` | **Actively misleading** | Rewritten alongside this PRP (operator-authorized) |

---

## 7. Program hygiene owed

| Item | Why |
|---|---|
| ~~**Recover the per-issue file lists (§7.1)**~~ | **DONE 2026-08-31 — `FILES.md`.** Was the program's one scheduling blocker; the unpinned remainder is #3540 and #3518 only (§7.2) |
| Re-run triage lane `a25004b5070e553ee` in smaller batches | Died on *"Prompt is too long"*; produced nothing |
| Re-run triage lane `a64bbc96948b63d6d` ("unclassified batch A") | Reported `completed`, wrote a **zero-byte** output |
| Re-run triage lane `adeaa344753d4cbbb` | Reported `completed`, wrote a zero-byte output **twice** before its third run succeeded (6270 bytes, 85 lines); #4035 and #4064 still rest on memory as a result |
| ~~Confirm tip `7ac7153e4c`'s `CSA Loom Console Build` completes~~ | **DONE 2026-08-31.** Run 33432196477 went green rolling tag `00018977aa` (the LIN-GC-2 commit), and `/build-marker.txt` served `sha=00018977aa… stamp=20260831T192134Z` at HTTP 200 — the estate is live on it. The run's `displayTitle` SHA is the image tag rolled; its `headSha` is the workflow-file commit — two different things, reconciled, not a defect. The failing run before it is analyzed in #4231 |
| Fix or retire `temp/extract-agent-reports.py` (working-tree only, not committed) | Its `texts[-3:]` tail heuristic **truncated a 27-issue report to 818 chars**; prefer the task-notification `<result>` payload |
| Audit issue closure after every merge | The string *"Does not close #N"* **closes #N** |

### 7.1 The file-list recovery gap — unmet, not deferred

The re-verification lane was asked for a file-collision map and a batch proposal.
It delivered neither, and said so plainly rather than improvising: *"I left the
`files` column as `not carried` for 22 of 23. Both deliverables depend on that
column, so neither can be built from this report."*

This is a **structural** gap, not a cosmetic one. Per-issue file paths were measured
in the original triage lanes but did not survive into the re-verification lane's
context. `OWNERSHIP.md` §8 requires every lane to declare an enumerated file list in
its PR body **before the first commit**; a row with no file list cannot be assigned
to a lane, cannot be checked for collision, and therefore cannot be scheduled.

Recovery has two tiers:

| Tier | Rows | Source | Cost |
|---|---|---|---|
| **Recoverable** — paths exist in an earlier transcript | 18 | `a180c4bb41d203c86` (7 issues) · `ac1e14e9738b1fd7f` (4) · `a09698528a0ad151c` (5) · `ac5ca417c6484a274` (2, delivered by `SendMessage` — check the message, not a file) | Re-read, extract the `files` column |
| **Unpinned** — no source anywhere | 5 | **#3543, #3540, #3525, #3519, #3518** | Fresh measurement required |

**Transcript-reading caveat:** those `.output` files are full JSONL agent
transcripts (200KB–980KB). Do **not** `Read` them directly — that is how a context
window gets burned for four table columns. Extract the `files` field with a script,
and do not reuse `temp/extract-agent-reports.py`'s tail heuristic (it truncated a
27-issue report to 818 chars).

### 7.2 RESOLVED 2026-08-31 — see `FILES.md`

**The gap above is closed.** The register is written: `FILES.md`.

It cost **zero transcript reads**. The `a180c4bb41d203c86` task-notification re-fired
carrying its full `Files` column, which satisfied the recoverable tier outright — the
exact source §7.1 names, delivered without paying the caveat it warns about. Every
recovered path was then verified to exist with `git ls-files` before being written
into the register.

**The unpinned set is two, not five.** The estimate above was wrong in three ways,
each corrected in `FILES.md` §3:

- **#3543** is pinned — `lib/editors/foundry-sub-editors.tsx ~744-745`.
- **#3525** is pinned — `lib/install/provisioners/kql-db.ts:81,105,131,147,173`.
- **#3519** is `STALE` at head; it needs a **closure receipt**, not a file list.

Genuinely unpinned: **#3540 and #3518** only. Both are freeform-input defects, so
`scripts/ci/no-freeform-inputs-baseline.json` should name their files directly.

**Verifying the paths was not ceremony — it caught two errors that would otherwise
have been written into an ownership register as fact:**

| Error | Consequence had it stood |
|---|---|
| #4035's script is at `scripts/github/`, not `scripts/csa-loom/` | A lane would have opened on a path that does not exist |
| #3684's file is `apps/loom-vscode/src/auth/device-code.ts`, not the console | An item sat on W2's critical path, gated on the #3847 bounding pass, that shares **no tree** with the console (97 files vs 6283) and can run fully parallel to it |

Two further corrections propagated from the same sweep: the #3846 ∩ #3633 eval
collision is **three** files wide (`eval-regression-lib.mjs` is the third, and is
where the metric-kind hardening actually lives), and **#3344 does not write bicep** —
its checker *parses* bicep but emits none, so reading is not a write collision and it
does not contend with #4036.

**Scheduling consequence:** W2's gate is now the #3847 bounding pass alone. The
file-list recovery no longer blocks it.

---

## 8. What this document does not owe

Stated so the absence is deliberate, not an oversight:

- **No performance program.** No perf regression has been measured this cycle.
- **No new capability.** Everything here is a defect, a receipt, or a park.
- **No estate cost work beyond the pause.** The ~$3k/mo untagged estate (#3922) is
  addressed by the pause mandate and the power button, not by a costing exercise.
- **No `strict` branch-protection change.** Keeping `strict: false` is a deliberate
  standing decision, not an outstanding item.
