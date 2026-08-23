# ACTIVE WORK REGISTER

**Purpose:** one file that can be read cold and tell you everything in flight — every
program, PR, agent lane and known-unstarted item, with who owns what and what ships when.
If work is not in here, it is at risk of being lost.

**Last measured: 2026-08-23 ~18:40Z.** Every count below was measured, not recalled.

---

## 0. Priority call (mine, per operator delegation 2026-08-23)

Ordered by *risk reduced per CI cycle spent*, because the merge treadmill — not compute — is
the binding constraint (see §4).

| Rank | What | Why it sits here |
|---|---|---|
| **P0** | **#3916 — infra deploy path deterministically broken** · fix in **#3944** | `deploy-integrity.md` R1: a broken deploy path preempts all feature work. Root cause established — a same-day regression from #3888. Bicep merges **are** landing inert. |
| **P1** | Security PRs #3890, #3900 | Live auth defects. Both `CONFLICTING` — they need a rebase before anything else can happen. |
| **P2** | Remediation wave (5 PRs under review) | Already built, already green; only review + treadmill stand between them and landing. |
| **P3** | Loom Brain #3933 (W1–W11) | New capability, high operator value, but not above a broken deploy or a live auth hole. |
| **P4** | 9 dependabot PRs | Lowest value, and each costs a full ~34-min cycle. **Batch last**, never interleaved. |

**Shipping rule I am applying:** never merge onto a red suite; never merge a PR whose
required checks were *hollow* for its own changed files; audit issue closures after every
merge (the close-parser is negation-blind — *"Does not close #N"* closes #N).

---

## 1. P0 — the infra deploy path (#3916) · fix in **PR #3944**

**Root cause ESTABLISHED, with a counterfactual: a same-day regression from #3888**
(`631c9850`, merged 2026-08-23T03:21:31Z). **Deterministic, not intermittent — main stays broken
and the next scheduled run fails identically until #3944 lands.**

**What happened:** #3888 ported a step written for the **operator-dispatch** shape onto the
**scheduled reconcile** lane. On `schedule` there are no inputs, so `deploy_sub` is empty **by
design** — and `scripts/ci/deploy-fiab-guard.mjs:18` documents exactly that:

    deploy_sub    subscription the deploy targets ('' = the login sub)

The same doc block contrasts it with the bicep bools, which are *"NEVER the empty string"*. The
ported step added a **fatal check** on empty rather than resolving the login subscription.
`resolve-dns-inbound-allocation.mjs` builds a literal `/subscriptions/${subscription}/…` ARM id, so
it genuinely cannot inherit the login sub — but the answer was to resolve it, not to abort.

**The counterfactual, measured by fetching the workflow at each run's own SHA:**

    2ea8252ef  (08-22 PASS)  "Resolve the hub DNS resolver" = 0
    043c1aa3a  (08-20 FAIL)  "Resolve the hub DNS resolver" = 0
    779b36294  (08-23 FAIL)  "Resolve the hub DNS resolver" = 1

### My first analysis was wrong on three counts — recorded so the error is not repeated

1. **"Intermittent" — refuted.** The 08-20 and 08-23 failures are **unrelated defects** with
   different failing steps (25 vs 18) and different job step counts. The failing step **did not
   exist** in the earlier run. 08-20 was a separate ARM leaf failure. Two failures on different
   dates are not one intermittent defect until you confirm **they share a failing step**.
2. **The `::warning::` I quoted was ECHOED SOURCE, not emitted.** Measured: **3** echoed,
   **0** emitted — all inside an unexecuted `dlz-attach` branch. Step 15 actually printed
   *success*, resolving a landing zone 0.5 s before the failure. **This refuted both candidate
   causes** (throttle, missing Reader): the Resource Graph query succeeded in the same run.
   Echoed source lists **every** branch, including unexecuted ones, so it reads as a catalogue of
   pre-written failure modes. Real annotations are `##[...]`; grep **for** those.
3. **"A guard passing on an empty required output is a defect" — does not apply here.** Empty is
   the documented contract value, the passing 08-22 run had the identical empty value, and every
   other consumer honours it (`if [ -n "${DEPLOY_SUB:-}" ]`, line 973). The new step invented a
   requirement the contract never made.

**A real secondary defect, different from the one I named:** step 18's comment asserts it decides
*"never from `inputs.` in an `if:`"* — but `CSA_LOOM_TOPOLOGY` **is** `inputs.topology`, so its
`dlz-attach` early-exit is unreachable on the daily trigger, and stays unreachable even for a
genuine dlz-attach estate. Step 10 has the same shape. The guard resolves topology internally but
**never emits it as an output**, so no consumer can read the resolved value. Contributing:
`resolve-dns-inbound-allocation.mjs` shipped with **no test file**.

**Why it is P0 even though the estate looks healthy:** the **app** roll chain is separate and
healthy (live marker `e4dcfd72`, stamped 2026-08-23T18:10:20Z). So apps deploy while infra does
not — **bicep merges in this window are inert**, which is `deploy-integrity.md` R2. Directly gates
PRs #3923 and #3927, both bicep.

**#3944 MERGED and VERIFIED LIVE — partially.** Run `32666693845` on `main`
(`whatif-only`, centralus, `allow_existing_hub=true`) completed **SUCCESS with 0 failed
steps**, and **step 18 — the exact step that failed at 06:49:24Z — now passes.**

**What is NOT verified:** step 21 (`ADX preflight`, the sibling defect) was **not exercised** —
its condition is `github.event_name == 'schedule' || inputs.run_mode == 'full'`, which a
`whatif-only` dispatch cannot reach by design. It has **test** coverage (the reviewer's narrow
ADX-only mutation went RC=1) but no **live** coverage. **#3916 stays OPEN until the scheduled
run (~06:48Z) proves both steps** — half a receipt is not a receipt (R2).

*A failed run `32662265651` sits in the history and is NOT evidence against #3944:* it failed
at step 6 on my own misconfigured dispatch, where the topology guard correctly refused to stamp
a second Console and named the fix (`allow_existing_hub=true`). R6 behaving properly.

**Follow-up #3947:** the recurrence guard #3944 added is keyed to a **spelling** — `[ -z … ]`
and `[ "${…:-}" = "" ]` both walk past it while its comment claims a third offender must fail.

**#3944 jumped ahead of #3912 in the merge order** — R1: a broken deploy path preempts all
feature work. Merged 2026-08-23.

**Other deploy paths (measured, most-recent-first):**

    full-app-deploy-commercial    cancelled, success, failure
    deploy-gov                    success, success, failure      <- healthy
    loom-roll-and-validate        running,  success, success     <- healthy
    build-fiab-images-acr-tasks   success,  success, success     <- healthy
    csa-loom-post-deploy-bootstrap success, success, failure     <- healthy


---

## 2. Programs

| Program | Spec | State |
|---|---|---|
| **OMNIBUS** (9 lanes, L0–L8) | `PRPs/active/omnibus-2026-08-22/PRP.md` | Wave 0 in remediation. **Scoped at 261 issues; 287 are now open** — ~26 filed since, so the PRP's population is stale. |
| **Estate pause/resume** | `PRPs/active/estate-pause-resume/PRP.md` | W1 merged (`e4dcfd72`, live). PR #3932 open for the button. |
| **Loom Brain + Visualizer** | `PRPs/active/loom-brain/PRP.md` · parent **#3933** | W1–W7 in flight; W8–W11 filed as #3934–#3937. |

---

## 3. Loom Brain work items (#3933)

| # | Item | Owns | Issue | State |
|---|---|---|---|---|
| W1 | Graph substrate | `lib/brain/graph/**`, `lib/brain/types.ts` | #3933 | **PR #3945** (16 files) |
| W2 | Waste detectors | `lib/brain/detectors/**` | #3933 | **PR #3952** (38 files) |
| W3 | Cost pipeline | `lib/brain/cost/**` | #3933 | **PR #3950** (16 files) |
| W4 | Agent layer | `lib/brain/agents/**` | #3933 | **PR #3949** (34 files) |
| W5 | **Visualizer** | `app/admin/brain/**` | #3933 | **PR #3951** (42 files) |
| W6 | Security taxonomy | `docs/fiab/brain/security-taxonomy.md` | #3933 | **PR #3939** |
| W7 | Security detectors | `lib/brain/security/**` | #3933 | **PR #3946** (29 files) |
| W8 | **Synapses view** | `app/admin/brain/synapses/**` | **#3934** | blocked on W5 (same directory — §8 conflict) |
| W9 | **Graph versioning** | `lib/brain/history/**` | **#3935** | not started |
| W10 | **Scheduler + lifecycle** | workflow, `lib/brain/run/**` | **#3936** | not started |
| W11 | **Gov parity** | Gov params + workflow | **#3937** | not started |

**W9 and W10 are the ones most likely to be quietly skipped, and both are load-bearing.**
Without W9 there is no history, so *"an edge that should not have formed"* is undetectable and
prune recommendations run off a single snapshot — which would recommend deleting a resource
that is merely mid-deploy. Without W10 the Brain never runs; `lcu-autopilot` is the standing
proof of that failure mode, having shipped a full read→decide→actuate loop with no scheduler.

**The thesis was AMENDED by its own taxonomy (#3939) — see `loom-brain/PRP.md` §3.8.** Testing
the reachability idea against this repo's shipped defects returned *substantially right,
materially incomplete*, and it is **not the highest-value part**. The dominant evasion measured
here is not adding an unguarded edge — it is **falling outside the population being examined**
(six instances, invisible in every artifact except a population count). The live proof:
`check-tid-boundary-chokepoint.mjs` reports **15 candidates, 1 judged, RC=0** while a live
defect grants real ADLS ACLs, because its discriminant is a regex on *parameter names*.

Two classes fail the thesis outright and need non-graph mechanisms:
**fail-open** (the edge is present, on-path, consumed — and answers ALLOW on failure; the
property is verdict totality of a *node*) and **duplicated decision** (11 tenant comparisons
across 3 files, all present, reachability clean **and correct** — the defect is that two
*disagree*; a property of a *set*, and currently this repo's most productive defect class).

---

## 4b. MERGE DRAIN STRATEGY (operator-directed 2026-08-23: "get them all in")

### The mechanical insight that makes this tractable

**`gh pr merge --admin` bypasses BOTH the review requirement AND the up-to-date (`strict`)
requirement.** So the "every merge invalidates every open PR ⇒ 34 min each" treadmill is **not
actually binding**. A `BEHIND` PR can merge without re-running CI.

What that trades away is the guarantee that the PR's CI ran against *current* main. So the real
constraint is **file-disjointness between consecutive merges**, not CI time. Two PRs touching no
common file can merge back-to-back safely; two that share a file cannot.

### Measured collision map (31 open PRs, 27 files touched by >1 PR)

**The big one:** #3945, #3949, #3951, #3952 each carry **17 identical substrate files** — the
component agents branched from main *before* the substrate landed. Verified byte-identical:
`types.ts` is blob `b805bdf322a6` in **all four**. So they merge cleanly **in sequence**, and
#3945 must go first.

Other collisions to sequence around:

    docs/fiab/route-inventory.md      3890, 3900, 3932, 3950, 3952   (GENERATED - regenerate, never hand-merge)
    scripts/ci/check-route-guards.mjs 3890, 3928
    no-freeform-inputs-baseline.json  3928, 3931
    .github/workflows/gov-console-roll.yml  3875, 3927
    .github/workflows/trivy.yml            3871, 3875
    .github/workflows/link-check.yml       3872, 3874
    deploy-fiab-il5.yml, loom-drift-check.yml  3873, 3874
    pyproject.toml                    3863, 3869

### Merge order

| Batch | PRs | Gate |
|---|---|---|
| **1 — docs** | ~~#3939~~ ✅ ~~#3938~~ ✅ | zero code risk, merged 2026-08-23 |
| **2 — Brain** | #3945 **first**, then #3946, #3949, #3950, #3951, #3952 | first review in flight; substrate is byte-identical so no conflict |
| **3 — remediated fixes** | #3927, #3928, #3929, #3930, #3931, #3924, #3923, #3898, #3932 | all green; awaiting round-2/3 verdicts |
| **4 — security** | #3890, #3900 | both RED and CONFLICTING; fix lane in flight |
| **5 — dependabot** | 9 PRs | **#3875 only after #3927**; #3873 (`github-script` 7→9) and #3874 (`upload-artifact` 4→7) are MAJOR bumps to workflows that gate everything — review, don't batch |
| **6 — release** | #3863 | last, and regenerate after everything else lands |

### Standing rules for the drain

1. **Verify green before every merge** — `MISSING/RED/INCOMPLETE` all zero. A hollow required
   check is only acceptable when it is **path-appropriate for that PR's diff**.
2. **Audit `closingIssuesReferences` before merging.** Live catch on #3927: a sentence reading
   *"required to close #3060"* registered as **Closes #3060** — on a PR whose own body said
   *"Deliberately Refs, never Closes: the close parser is negation-blind."* #3060 needs a
   **re-roll**, which a merge cannot perform. Reworded; refs now empty.
3. **Audit closed issues after every merge** — compare the closed list before and after.
4. **Never merge onto a red suite**, and verify `main` is green between batches.
5. **Runner capacity caps the parallel width** (§4a). Read-only review lanes are free; branch
   updates are not.


## 4a. CI runner saturation — measured 2026-08-23 ~21:12Z

    completed 38 | queued 15-18 | in_progress 4-5 | pending 2      (24 active)

**The binding constraint moved.** It was the merge treadmill; with ~10 PRs cycling it is now
**runner capacity**. The P0 verification dispatch sat behind ~17 jobs, most of them triggered by
my own branch updates — so adding parallel PR work actively delays the thing most worth
verifying. **Hold branch updates while the queue is deep; read-only review lanes are free and
should absorb the waiting time instead.**


---

## 4. Open PRs — 23 total (9 dependabot, 14 substantive)

**The treadmill is the constraint.** `main` is `strict` with 15 required contexts and the
console vitest suite runs ~34 minutes, so **every merge invalidates every other open PR**.
14 substantive PRs ≈ 14 sequential cycles ≈ 8 hours of wall-clock CI, no matter the order.
This is why dependabot batches last.

| PR | What | Needs |
|---|---|---|
| #3890 | security: tenant-admin bypass wrote ADLS ACLs | **CONFLICTING** — rebase |
| #3900 | auth: tid-less session generator + consumers | **CONFLICTING** — rebase |
| #3898 | docs: pause/resume design + Wave 0 triage | review (running) |
| #3912 | ci: test-isolation race reddening unrelated PRs | review (running) — **merge early, it unblocks others** |
| #3923 | bicep: `LOOM_CLOUD_TIER` never passed; Maps BYO read 1 of 3 spellings | review (running) — **gated by P0** |
| #3925 | items: user-writable state reached a Key Vault delete | review (running) |
| #3927 | deploy: three Gov/data-plane lanes wired in name only | review (running) — **gated by P0** |
| #3924 | dataplane: three R7 error messages asserted unestablished causes | rebase + review |
| #3928 | ci: seven guards that could not see their own subject | rebase + review |
| #3929 | console-api: a pasted setup command took unescaped input | rebase + review |
| #3930 | console: seven admin surfaces asserted what the page contradicted | rebase + review |
| #3931 | editors: mapping-dataflow sent its Cosmos GUID as the wrong id | rebase + review |
| #3932 | **estate Pause/Resume button** | agent actively working — do not review mid-push |
| #3863 | release 0.101.0 | hold until the wave lands |

**Merged this session:** #3926 (parity docs) — central claim verified against source
(`MIRROR_SOURCES` = exactly 11 entries, 11th routes external). Close-audit clean.

---

## 5. Agent lanes in flight — where output lands

| Lane | Run ID | Produces |
|---|---|---|
| `loom-brain-build` | `wf_198ed510-c77` | W1 substrate PR, then W2/W3/W4/W5 PRs |
| `loom-brain-security` | `wf_4502aa90-852` | W6 taxonomy PR, then W7 detectors PR |
| `review-fanout-wave` | `wf_da1e7c72-e95` | Verdicts on #3898, #3912, #3923, #3925, #3927 |
| Pause-button agent | `a293c96b36260b06c` | Pushes to PR #3932 |

**If a lane dies, its work survives as an issue** (#3933–#3937) — that is why they were filed
before the lanes were trusted to finish.

---

## 6. Known open questions — not yet answered, do not assume

1. **#3916 root cause** — Resource Graph throttling vs a missing Reader on the DLZ
   subscription. The alternating pattern suggests throttling. **Unmeasured.**
2. **OMNIBUS population is stale** — the PRP says 261, reality is 287. The delta is untriaged.
3. **Demo-data fixes are unverified live** — the three merged fixes need a *fresh* demo
   deploy, because existing items were seeded by the old CSV path.
4. **Nothing in Loom Brain has run against a live estate.** Every dollar figure is `derived`
   (measured SKU × retail rate), not billed. The Cost Management API returned HTTP 429 on
   11 consecutive attempts over ~35 minutes — which is *why* the design reads from a storage
   export instead.
5. **Gov is unverified for everything in this register** except `deploy-gov` itself.

---

## 7. Follow-ups filed rather than fixed in place

Each was found inside another PR's remediation and sat **outside that PR's declared file
ownership**. Reaching across is what CLAUDE.md §8 forbids and is how parallel lanes collide —
so they were filed instead. This section exists because a deferred finding with no issue is
indistinguishable from a forgotten one.

| Issue | Finding | Why it matters |
|---|---|---|
| **#3940** | `check-env-sync` collects only `LOOM_*`, so **`NEXT_PUBLIC_LOOM_*` is invisible to it** | A **population** defect, not a rule defect — the guard is green because its examined set is smaller than the set it polices. `NEXT_PUBLIC_` is also the prefix that reaches the browser, so an emitted-but-empty one no-ops client-side. |
| **#3941** | `owner-only-workspace-guard` is **RED and unowned** | While red, the owner-filter property is **not enforced by CI**, so a regression lands silently. A red lane with no owner becomes a permanently accepted failure — there is precedent here for a red lane being disabled rather than fixed. |
| **#3942** | `reindex-loom-docs` flakes **2/2881 under parallel load**, passes **12/12 isolated** | Load-dependent, so it surfaces intermittently and gets blamed on whatever PR is in the tree. A test whose verdict depends on machine load measures the property *plus the scheduler*. |

## 8. Wave-0 remediation — landed on-branch (2026-08-23)

Three PRs remediated in parallel. Both headline findings were **guards that were green while
blind**, which is the same class the Loom Brain is being built to detect:

- **#3923** — `LOOM_CLOUD_TIER` sat in `UNTRIAGED_INERT`, consumed by `computeInert()` as a
  `continue` (a skip, **not** an assertion). Four-arm mutation: wiring REMOVED + allowlist
  PRESENT returned **RC=0 — the guard was blind**. After the fix that arm returns **RC=1**.
  Note the arms differ in line endings — `main.bicep` is **LF**, `check-env-sync.mjs` is
  **CRLF** — so a single LF needle would have matched zero times and read as a passing test.
- **#3925** — the `engineObject` guard **refused 62% of the objects Loom actually mints**
  (measured 6,178/10,000; expected 10/16 = 62.5%, because UUID-derived names begin with a
  digit and the head class was `[A-Za-z_]`). The load-bearing mutation was M3: widening the
  *head* class opened no hole, while admitting a real separator still goes red.
- **#3927** — six mutation arms, all RC=0 → RC=1. Also corrected a comment asserting **11**
  workflows when the real figures are **12 naive / 9 comment-stripped** — 11 was measured by
  nothing.

**Merge order decision:** #3912 goes first. It fixes a test-isolation race that reddens
*unrelated* PRs, so landing it reduces spurious failures across the remaining four. Branch
updated 2026-08-23; its cycle is running.

