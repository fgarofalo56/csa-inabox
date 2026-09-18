# DECISIONS — operator answers, 2026-09-01/02

Twelve `NEEDS-DECISION` items resolved in one sitting. Recorded here because a
decision that lives only in a session transcript gets re-litigated by the next
lane. Each entry states what was asked, what was chosen, and what it obliges.

---

## Governance

### #4047 — `enforce_admins:false`, no override trace
**Chosen: keep `--admin`, record every override.**

The flag stays off. Every use is logged in this register: PR number, the
preflight verdict, which contexts were green, and why the override was taken.
Seven `--admin` merges landed 2026-09-01 (#4229, #4263, #4269, #4260, #4284,
#4261, #4273) — all with zero RED, zero INCOMPLETE, zero HOLLOW and zero MISSING
required contexts at merge time, verified by `temp/merge-eligible.py`.

The gap was never the merges; it was that nothing durable recorded them.

**Obliges:** an override log section in this file, appended per merge.

### #4045 — 155 PRs merged over a hard-red advisory check
**Chosen: keep advisory, require a written per-occurrence assessment.**

Promoting CodeQL to required would have been wrong. Measured 2026-09-01, it bit
three times and was wrong all three:

- `js/useless-escape` ×9 — one is a regex literal where `\$` is the CORRECT
  escape; the other eight are escaped `${...}` inside template-literal shell
  fixtures where **removing the backslash is a SyntaxError**.
- `js/regex/missing-regexp-anchor` — anchoring a `not.toMatch` substring search
  over a multi-line bicep file would make it **never match**, so the negative
  assertion would pass unconditionally. A hollow control.

**Obliges:** a red advisory check must carry a written, per-occurrence
assessment before merge — never a collective wave-through in either direction.

### #3462 — do held release-please runs delete the draft release?
**Chosen: test it deliberately on the next release.**

One data point exists: 11 parked runs approved 2026-09-01 to unblock 0.104.0,
including `commit-message-parses`. The release cut cleanly, nothing was lost.
That was a personal token, so it does not settle the normal path.

**Obliges:** on the next release PR, approve held runs deliberately and record
what happens to the draft — a real observation, not an inference.

### #3985 — CodeQL `js/indirect-command-line-injection` at `measure.mjs`
**Chosen: assess reachability, then dismiss with reasoning.**

Dismissal must be visible in the register, never a silent suppression.

---

## Sovereign / cloud parity

### #4071 + #3078 — GCC disabled, deploys zero Container Apps
**Chosen: record the real reason and correct the docs.**

These were carried as "`deployAppsEnabled` is unset" and "secrets not set". Both
are false. Measured 2026-09-01:

- The operator's sovereign footprint is **MAG and GCC-High**.
- **GCC is a different tenant type** — public-cloud Azure with
  government-community M365 identity. `deploy-fiab-gcc.yml:106` sets
  `AZURE_CLOUD: AzureCloud`; `:934` says "no az cloud set". Its siblings
  `deploy-fiab-gcch.yml:212` and `deploy-fiab-il5.yml:207` both do
  `az cloud set --name AzureUSGovernment`.
- **No GCC tenant exists to authenticate against.** No login unblocks it.
- GCC has **never deployed**. Its three "SUCCESS" runs had both deploy jobs
  `SKIPPED (0 steps)`. The workflow already detects this, fails the cron path
  deliberately (`:137-146`, citing #3219) and is `disabled_manually` — that is
  the fix completed, not neglect.

**Obliges:** correct both issues; correct `cloud-parity.md` to distinguish
**supported-in-code** from **ever-exercised**. Listing an unexercised boundary
beside four live ones overstates coverage.

### #4051 — Gov has no nightly Brain scan
**Chosen: stand up the in-boundary ACA runner.**

No self-hosted runner can reach the Gov Cosmos private endpoint;
`actions/runners` returns `total_count:0`. Prior art exists — `loom-aca` is
already declared in `actionlint.yaml`.

### #3965 — `cost-export.bicep` allowlisted, not wired
**Chosen: wire it and drop the allowlist entry.**

An allowlist entry is a promise to come back. This one was not kept. Removing
the exception is what makes the guard honest again. The Gov receipt half cannot
be satisfied while GCC-High cannot deploy — record it as owed.

### #3778 — lakebase-postgres parity doc
**Chosen: re-audit against Lakebase GA anyway.**

The ledger called the premise stale (doc rebuilt with a 30-row inventory in
#3926). Operator wants a fresh audit regardless, since GA may have moved.

---

## Dependencies and data

### #3982 + #3457 — thrift 0.17.0 in loom-directlake
**Chosen — operator's words: "do whatever you need to, to make the
loom-directlake actually work."**

This is broader than the options offered and reframes the task. The objective is
**a working `loom-directlake`**, not a satisfied Dependabot alert. The thrift
pin is a symptom.

**Obliges:** first establish whether `loom-directlake` works **at all** today —
does it build, deploy, serve, and is it reachable on the estate? Fix what
actually blocks that. The dependency upgrade is in scope only insofar as it
serves that goal. Do not close #3457 on a version bump that leaves the component
non-functional.

Prior measurement (operator, 2026-08-29, real cargo 1.98.0): no published
parquet up to 57.3.1 admits thrift 0.23. So a straight upgrade is blocked
upstream — which is precisely why the goal is the component, not the pin.

### #2642 — migrate the live Commercial cache to AMR
**Chosen: fix #4270 first, then cut over.**

#4270 measured that the capacity broker **cannot authenticate to AMR** under the
module defaults (`managed-redis.bicep:155` provisions Entra-only;
`redis_ledger.go:151-162` has no Entra path) and **falls back to its in-memory
ledger silently**. Cutting over first would leave the estate looking healthy
while the durable ledger is not durable — the exact fallback-hides-the-defect
class this program keeps closing.

Context: the live cache measured **completely unused** — 0 gets, 0 sets, 0 hits,
0 misses, 0 keys over 7 days, memory flat at the empty-server footprint. So the
cutover is provision-and-point, not a data migration.

---

## Operating

### Estate power
**Chosen: pause when the queue quiets.** Running all day was defensible under
paused-unless-validating because validation was continuous. Pause once the
in-flight deploys land; resume for validation windows.

### Autonomy for the remainder of the drain
**Chosen: full autonomy.** Merge on a posted independent review plus a clean
preflight; log every `--admin` use per #4047; stop only for genuinely
destructive or outward-facing actions.

### Review depth (decided earlier the same session)
**Full adversarial rounds for destructive paths only.** Justified by #4261,
which took four rounds and found three distinct data-loss paths. Not the bar for
a docs PR.

### Brain scope (decided earlier the same session)
**`forzelite` and `sentinel` are the operator's, but not Loom's.** They stay in
the observed bucket — visible, never actionable, never tagged.

---

## 2026-09-03 — drain continuation, operator answers

Asked with options and a recommendation; the operator picked in each case.

### Lane width for the backlog fan-out
**Chosen: 8 concurrent implementation lanes** (raised from the standing rule of
4). Each lane is one agent in its own git worktree on a branch from `origin/main`
with `apps/fiab-console/node_modules` junctioned to the main checkout (a parallel
`pnpm install` corrupts the shared store), one batched PR per lane, an
independent reviewer agent that POSTS its verdict on the PR, and one fix round.
Merges still serialize on the generated artifacts. Read-only triage ran wider
(35 batches of 5 issues, re-measured at head `dc40ac2c94b2`).

### #4259 — the GCC wiring PR
**Chosen: close #4259; open a docs-correction lane.** Consistent with the #4071 +
#3078 entry above: no GCC tenant exists, the lane has never deployed, and its
failing `check-workflow-lane-states` is correct. The branch stays on the remote;
the correction lane records GCC as *supported-in-code, never exercised* and
amends `cloud-parity.md` to distinguish the two. Closed 2026-09-03 with the
reasoning posted on the PR.

### HouseGarofalo/atlas — hung `redeploy.cmd`
**Chosen: kill the stuck process tree.** Measured: `cmd.exe /c
atlas\backend\scripts\redeploy.cmd` → `git pull --ff-only` → `git fetch
--update-head-ok` → `git-remote-https` → `git credential-manager get`, all
started 05:19:00 and parked on an interactive credential prompt. `taskkill /T`
on the root ended ten processes; a fetch waiting on auth had written nothing.
The redeploy was **not** re-run — that is the operator's, in that repo.

### Issues the triage confirms STALE
**Chosen: close with evidence.** Each close carries the file:line at head that
shows the fix, the merged PR where found, and the estate marker — both
boundaries read `dc40ac2c94b2` on 2026-09-02, so "fixed at head" is also
"deployed" for anything merged by then (`deploy-integrity.md` R2).

---

## Override log

| date | PR | preflight at merge | note |
|---|---|---|---|
| 2026-09-01 | #4229 | 15/15 required SUCCESS, 0 red, 0 hollow, 0 missing | release 0.104.0; 11 parked bot runs approved rather than bypassed |
| 2026-09-01 | #4263 | 0 red, 0 pending, `closes: 0` after close-parser fix | #4258 deliberately kept open |
| 2026-09-01 | #4269 | 0 red, 0 pending | audit clean, 267→267 |
| 2026-09-01 | #4260 | 0 red, 0 pending | ownership guards untouched; safety chain verified first |
| 2026-09-01 | #4284 | 0 red, 0 pending | closed #4278 + #4280, both intended |
| 2026-09-02 | #4261 | 15/15 required SUCCESS | #4257 kept open — merged is not deployed |
| 2026-09-02 | #4273 | 15/15 required SUCCESS | closed #4238 only; #4287 kept open, still live on main |
| 2026-09-02 | #4281 | 33 SUCCESS / 3 SKIPPED, 0 red, 0 pending | docs-only; registers the 2026-09-01 drain round |
| 2026-09-02 | #4286 | 35 SUCCESS / 3 SKIPPED, 0 red, 0 pending | dependabot: browserslist 4.28.6 -> 4.28.8 (portal) |
| 2026-09-02 | #4289 | 71 SUCCESS / 3 SKIPPED, 0 red, 0 pending | dependabot: pypdf 6.15.0 -> 6.16.1 (platform locks) |
| 2026-09-02 | #4268 | 34 SUCCESS / 3 SKIPPED, 1 advisory red (CodeQL), 0 pending | `merge-eligible.py`: MISSING none · RED none · INCOMPLETE none. Sole blocker was `REVIEW_REQUIRED`, cleared with **`gh pr merge --admin`** (`enforce_admins:false`, `required_approving_review_count:1`, zero formal reviews). No required context was red, so #4047 acceptance item 3 is not triggered |
| 2026-09-02 | #4266 | 34 SUCCESS / 3 SKIPPED, 0 red, 0 pending | Sole blocker was `REVIEW_REQUIRED`, cleared with **`gh pr merge --squash --admin`**. Review blocker fixed first (drain audit asserted a lane "HAS now run" from a `gh run list` that never returned — R7). `#4144`, `#4285`, `#4233` all kept OPEN: the three newly-automatic lanes have never fired, so merged is not deployed |
| 2026-09-02 | #4304 | 32 SUCCESS / 3 SKIPPED, 1 advisory CANCELLED (Copilot evals, queue-displaced), 0 pending | docs-only: the #4268 override record + zero-closure audit. Sole blocker `REVIEW_REQUIRED`, cleared with **`gh pr merge --squash --admin`**. `closingIssuesReferences`: none. Merged 23:44:57Z as `31352275ef11` |
| 2026-09-02 | #4265 | 54 SUCCESS / 4 SKIPPED, 0 red, 0 pending | AMR cutover runbook (Commercial) + OSS Redis on ACA (sovereign). Review blockers fixed first: §5.2 rollback written as an **operator step** (a credential is involved; nothing was executed, no value echoed) and a false bicep comment corrected (R7). `--squash --admin`; closing refs none. Merged 23:46:14Z as `dc40ac2c94b2`. **DEPLOYED**: both estate markers read `dc40ac2c94b2` (Gov 23:50:09Z, Commercial 23:58:07Z) |
| 2026-09-03 | #4262 | At the merged tip `32c6702fd51d`, measured: **45 SUCCESS / 4 SKIPPED / 1 FAILURE / 0 CANCELLED / 0 pending** (50 check-runs, 50 distinct names). 15/15 required SUCCESS; `merge-eligible.py`: MISSING none · RED none · INCOMPLETE none · HOLLOW none; hollow-control PASSED. The single failure is advisory (Copilot evals) | The two **REQUIRED** `guardrails` reds on the **prior** tip `a7ab9949e68a` were **self-inflicted, not flake**: the `LOOM_ADF_FACTORY` env row in `admin-plane/main.bicep` left the committed compiled ARM template stale, and `adf-client.ts` grew 2028 > 2001. Fixed in `32c6702fd51d` (regenerated with the pinned bicep 0.45.15; comments compressed to 2014 and the ceiling re-baselined at the exact LOC). Advisory Copilot-evals red assessed on the PR before merge: estate-side (`loom-docs` reindex stale with no job visible for 909 s), not the diff. **Correction (round-1 review of #4307):** an earlier draft of this row put "1 advisory CANCELLED (Link Check)" in the at-merge column and attributed it to Link Check's 10-minute job timeout. That cancellation is real but belongs to the **prior** tip `a7ab9949e68a` (`check` cancelled after 10m17s, 23:49:01→23:59:18Z); on the merged tip `check` **SUCCEEDED in 1m59s** (02:21:45→02:23:44Z) and `head_sha` returns exactly one Link Check run. A prior-tip observation was carried into a column headed "at merge", and a cause was asserted for an event that did not occur there — the R7 shape this register exists to catch, found by review rather than by the author. `--squash --admin`; closing refs none; close audit **0** (positive control: 5 closures in the prior 24 h). `#3513` kept OPEN at merge time — **merged, not deployed** (markers still `dc40ac2c` at 03:20Z); both estates have since rolled to `c1e194010b95`, which carries it. Merged 03:02:43Z as `ad1184ec899c` |
| 2026-09-03 | #4267 | 15/15 required SUCCESS; `merge-eligible.py`: MISSING none · RED none · INCOMPLETE none; HOLLOW ×3 (`Python Tests` 3.10/3.11/3.12) judged path-appropriate — the diff is 21 console files + 1 doc, zero Python paths; 2 advisory CANCELLED (Copilot evals queue-displaced by `drain/gcc-docs` 24 s later; Link Check 10-min timeout) | Brought up to main by `temp/unblock-git.py` (merge + re-derived security graph / route map / route inventory in ONE commit `f172dd689021`, run from a worktree on the new main after the main checkout's own branch broke the first attempt — the script now tolerates paths the merge tree lacks). `--squash --admin`; closing refs none; close audit: only the seven evidence-closed STALE issues in the window. `#4255` kept OPEN — **merged, not deployed**. Merged 03:50:08Z as `c1e194010b95` |

### #4268 — why it merged first, and why its one red did not block

Merged **first of the three ready PRs deliberately**, not by convenience. #4268
is the guard fix (`check-env-sync` went green on a shrunken population). A guard
belongs on `main` **before** the PRs it would validate, so that if #4262 or #4266
then fails the stricter check, that failure is a genuine finding.

Stated as the ordering principle, which is what was actually established:
merging #4262 or #4266 first **could** have let them pass under the older,
weaker guard — neither fixes `check-env-sync`; **#4268** is the guard fix — and
a pass under the weaker guard would have said nothing. What was verified
materially is that the stricter guard genuinely applies to both: #4262 touches
`apps/fiab-console/lib/**` env reads and #4266 touches `.github/workflows/**` +
`scripts/ci/**`, all inside `check-env-sync`'s examined population. What was
**not** run is the counterfactual itself — neither PR has been re-evaluated
against the merged guard, so this record does not claim they *would* have
passed.

Its single red is **CodeQL**, which is advisory in this repo — not among the 15
contexts that can block. It was **judged, not waived**: the 11 `useless-escape`
alerts were disproved by execution (`temp/prove-useless-escape.mjs`), where the
suggested fix threw `SyntaxError: Missing } in template expression` on the
template-literal shell fixtures and silently **stopped matching** on the regex
literals. Disposition posted to the PR before merge.

### Close audit for #4268

**Zero issues auto-closed.** Verified by measurement rather than assumed.
Window: base `4175977dd30` → merge commit `0bfeb7765795`, merged
**2026-09-02T19:26:42Z**; the scan covered issues closed between that merge and
the audit, with 25 closed issues read as a positive control (a non-zero
population proves the query path works, so the zero below is a measurement and
not an empty response).

Confirmed three independent ways, because a timestamp window alone is weaker
than this file's own bar — the sibling audit below uses the close event's
`commit_id`:

1. The repo's own closing-keyword parser over the merge commit message —
   `node scripts/ci/neutralize-release-close-keywords.mjs --check` → "0 closing
   keywords remain", rc=0. Same result over #4268's body. This is the check that
   matters, because it is the parser that makes "Does not close #N" close #N.
2. GraphQL `closingIssuesReferences` → `[]`.
3. `gh issue list --state closed` over the window → empty, against the 25-issue
   positive control above.

That is the intended outcome and not luck. #4268 **ratchets and enumerates**
rather than fixes: the 17 `env[?name==].value` sites it found live in
`.github/workflows/**` and `scripts/csa-loom/**`, files that lane does not own.

`#3956` and `#3344` are therefore still **OPEN**, correctly.

**Correction to an earlier draft of this record.** It also listed `#3940` as
staying open on merge, taking that from #4268's closing paragraph. That is
false: **#3940 was already CLOSED at 2026-08-30T22:37:42Z**, three days before
this merge. #4268's body is self-contradictory on the point — its own
"#3940 — CLOSED, but only one third fixed" section says so — and this record
propagated the wrong half without checking issue state, which is exactly the R7
failure (asserting a state it did not establish) in exactly the kind of document
that gets cited later as evidence. The **conclusion is unaffected** — zero is
still the correct close-audit result, and #3940 was not closed *by* this merge —
but the supporting sentence was wrong and is corrected here rather than quietly
edited away.

Per `deploy-integrity.md` R2 this is a CI-guard change with no deployed artifact
and no runtime behaviour on any estate: **merged, not deployed.**

### Close audit for the 2026-09-02 #4261 batch

One issue closed inside the merge window and it was checked rather than
assumed, because the **#4261 row in the override-log table above** says the
opposite:

- **#4257** (RisingWave scale-to-zero destroys MVs) closed 2026-09-02T02:14:14Z.
  The #4261 row records it as deliberately KEPT OPEN on the grounds that
  merged is not deployed. That was true when written and is no longer true.
  MEASURED: #4261 merged as `5454ae7f468b` at 01:14:15; the live estate
  marker reads `sha=e9df9169 stamp=20260902T014744Z`, and
  `git merge-base --is-ancestor 5454ae7f468b e9df9169` succeeds — so the fix
  was rolled 33 minutes before the close. The close satisfies
  `deploy-integrity.md` R2 and stands. The estate trails `main` by 3 commits.

Recording the check itself, not only its outcome: an issue closing near a
merge is the shape of an unclaimed-issue auto-close, and the timeline showed
no `commit_id` on the close event, which rules that mechanism out. Had the
ancestry check failed, the correct action would have been to reopen.

---

## Operator decisions, 2026-09-17 — the FINISHLINE live questions

`PRPs/active/finishline-retirement/OPERATOR-QUESTIONS.md` carried **10 LIVE**
rows. A measure-first pass ran against each before any of them was put to the
operator, on the principle that an operator's time is the scarcest input in this
drain and a question whose premise is already false is worse than no question —
it extracts a decision that changes nothing.

**One of the ten dissolved outright. Four carry an operator decision. Six still
carry something live.** Those add to more than ten because OP-9 does both: one
of its seven items was decided and four were never answered.

Two earlier revisions of this line were both wrong, in the same direction. The
first said "seven of the ten dissolved" — reached by counting OP-19's two asks
as two rows and OP-9's items as a third, which
`PRPs/active/finishline-retirement/OPERATOR-QUESTIONS.md:61` forbids in terms:
*"The counts are of questions, not of sub-asks; several rows bundle two or
three."* The second said two dissolved, counting OP-11, which turned out to be
implemented in one of its two creators and not the other. Splitting sub-asks and
accepting a half-implementation are the same error: they make the queue look
emptier than it is. The count is now stated per row with a status, and rows that
are only PARTLY settled say so.

**Dates.** The section heading is 2026-09-17, the date the operator was asked.
Evidence added afterwards is dated 2026-09-18 at each cell. Those are different
days on purpose; neither is a typo.

### Dissolved outright — no decision needed, both halves measured

| row | why it is no longer a question | evidence |
|---|---|---|
| **OP-15** Tag Contributor on the ACR | premise false twice over | the deploy identity does not lack `tags/write`: `limitlessdata_deploy` (oid `b9c3cc65…`) holds **Owner** at `/providers/Microsoft.Management/managementGroups/d1fc0498…`, the tenant-root MG — measured 2026-09-18 via `az role assignment list --all --include-inherited`, and `az role definition list --name Owner` returns `actions: ["*"]`, `notActions: []`, so it does carry `Microsoft.Resources/tags/write`. And per issue 4563 the lease tags are erased by every apply regardless, so the grant would have been a no-op against the stated goal. An earlier revision asserted the first half with no measurement attached |

**One row, not two.** An earlier revision listed OP-11 here as well. It is not
dissolved — see below.

### Still live, in whole or in part — NOT settled by this pass

| row | status | what is actually outstanding |
|---|---|---|
| **OP-5** `task C12` | **untouched** | GOV-3 / model-strategy §7 / TPM raises. Not measured, not asked, not dissolved. An earlier revision of this section omitted it entirely while claiming all ten rows were accounted for — the omission is the reason the arithmetic appeared to close |
| **OP-9** items 1, 3, 5, 7 | **no verdict** | item 2 was decided by the operator (below) and items 4 and 6 are duplicates of OP-8 and OP-7. The remaining four were neither measured nor asked |
| **OP-11** audience registration | **stands as asked** | an earlier revision filed this as dissolved on the grounds that "option (a) is already implemented in code", citing `scripts/csa-loom/bootstrap-msal-app-reg.sh:1052-1058`. That is ONE of the two creators. Issue 2678's option (a) requires the identifier URI in **both** creators plus `az ad sp create` on the bicep path, and `platform/fiab/bicep/modules/admin-plane/entra-app-registration.bicep:138` still runs `az ad app create --display-name … --sign-in-audience AzureADMyOrg` with **zero** `--identifier-uris` and **zero** `az ad sp create` (measured 2026-09-18; the bootstrap script's single `identifierUris` is the positive control showing the probe is not blind). Issue 2678 is OPEN and its body prefers option (b). This PR's own row at `OPERATOR-QUESTIONS.md:322` says "stands exactly as asked" — the dissolution contradicted a line in the same PR |
| **OP-13** attended D4–D6 proving deploy | **partly discharged** | the `#3056` token hazard the watch-list warns about is much narrower than the row implies — `platform/fiab/bicep/main.bicep:568` and `modules/admin-plane/main.bicep:2372` state an adopt-never-mint contract, empty being the greenfield case only. "Cannot occur" was too strong: `deploy-fiab-commercial.yml:1267` is an `else` that WARNS and proceeds with a mint. That is the WATCH-LIST NOTE inside the row. The row's actual ask — an attended `deploy-fiab-commercial.yml` dispatch — is untouched |
| **OP-14** `#3056` owner + judge cap | **never asked** | an earlier revision recorded this as *"decided: keep the 5000/day ceiling — operator, this session"*. **The operator did not decide it.** Four questions were put to the operator and this was not one of them. The row is restored to LIVE. It is also cost-material (~20–25M gpt-4.1 tokens/day at the cap), so under `auto-bind-by-default.md` § Allowed any decision to keep it opt-in needs a gate-registry entry, which it does not have |
| **OP-19 (a)** duplicate timers | **mitigated out-of-band; fragile for the OPPOSITE reason first claimed** | measured on the live estate 2026-09-18: the timers ARE disabled — `func-secexp-k6mvh5sm6z7do/secretExpiryMonitor` and `func-cpeval-k6mvh5sm6z7do/copilotEvaluatorTimer` both report `isDisabled=true` with `AzureWebJobs.<fn>.Disabled=true`, as does a third, `copilotEvaluatorHttp`, which an earlier revision omitted. It is an app setting applied out of band, **not** the result of PR #4564, which is open and unmerged. An earlier revision then said "a bicep re-apply drops out-of-band state" — that mechanism CANNOT operate here: nothing in `platform/fiab/bicep` declares `func-secexp-*` or `func-cpeval-*` at all (their modules were deleted and replaced by Container App Jobs, e.g. `secret-expiry-monitor-job.bicep:24`), and nothing deploys in Complete mode, so an incremental apply cannot touch an undeclared resource. The real fragility is the mirror image: these hosts sit OUTSIDE IaC, so nothing re-asserts the disable either, and no gate would notice it being undone |
| **OP-19 (b)** teardown | approved; PR carries the proof | in flight — `deploy-integrity.md` R2: in flight is not deployed |

**OP-15 is the one worth reading twice.** The question asked whether to grant
Tag Contributor so that ACR firewall leases stop running unleased. Both halves of
its premise are false, and the second is the interesting one: even with the grant,
the lease tags do not survive, because every subscription-scope apply PUTs the
registry and `registry.bicep` declares no `tags:`. Granting the role would have
produced a confident "leases are race-free now" with the race entirely intact.
That is the exact shape this repo keeps paying for — a control that looks like it
watches. Tracked as issue 4563.

### OP-3 · clean-subscription acceptance runs — **land the image fixes first**

> **Decision:** land **#4561** first, confirm the build lane is green, **then**
> take the attended window. Do not dispatch into the red gate.

Recorded as the operator gave it: the precondition is the tracked item **#4561**,
not the open-ended class "the Trivy CRITICAL fixes". An earlier revision wrote
the class, which is wider than what was decided and would have let any unrelated
Trivy work be read as satisfying it.

`full-app-deploy-commercial.yml` is the canonical from-scratch app path in
`no-vaporware.md`. A greenfield run dispatched into a red supply-chain gate stops
there, which means it cannot produce an R4 receipt and cannot tell you anything
about the deploy path it is meant to exercise. The ordering is not caution; it is
the difference between a run whose red result is informative and one whose red
result is already known.

**How many images are red is NOT established here.** An earlier revision said
"at least three images today", which was a transposition of the three-CVE count
from #4560, not an image count. What is measured: #4560 fixed **two** images
(`loom-migrate`, `fiab-setup-orchestrator`) and is merged with the estate rolled;
#4561 tracks five more and says in its own body that they *"are not currently
red"*. Neither of those adds up to three red images, and no count is claimed in
its place — the decision does not rest on one.

Consequence to carry: **R4 remains unverified until that window happens.**
Greenfield is a supported path with no current receipt, and per `cloud-parity.md`
that must be stated as untested rather than implied working.

### OP-9 item 2 · I6/I7 enforce flip — **re-run the shadow window**

> **Decision:** collect a fresh clean-shadow period against today's estate, then
> decide. Do not roll forward on the 2026-08-05 sign-off.

The window that justified the flip closed around 2026-08-05 and is now roughly
six weeks stale. Shadow evidence is a statement about the surfaces that existed
when it was collected; those have changed underneath it. Flipping on expired
evidence would surface as user-visible 403s on paths nobody measured, and the
original ask itself warned this needed a fresh decision rather than a silent
roll-forward.

Recorded so the staleness cannot repeat silently: **the shadow window's evidence
has an expiry, and the expiry is a property of the estate changing, not of the
calendar.** A re-run that is itself six weeks old at flip time is the same defect.

### OP-7 (and OP-9 item 6) · Esri GeoAnalytics license — **DECLINED, stays BYO**

> **Decision:** no first-party Esri license. `geo-graph-ml` GEO-2/3/4 remain
> bring-your-own-license.

The program is archived, GEO-2 is sequenced last within it, and the design
already assumes a customer-supplied license. Nothing in the drain waits on this.

Kept distinct so it is not later mistaken for the same call:
`lib/editors/report/map-visual.tsx:28` records a **separate** decision that
ArcGIS/Esri stay out of the report map visual as a third-party dependency. That
decision does not settle the GeoAnalytics license question and this one does not
settle that. Two decisions, same vendor, different subjects.

### OP-8 (and OP-9 item 4) · help-program visual captures — **agent-captured, operator-reviewed**

> **Decision:** captures are produced by an agent driving a real browser against
> the live console; the operator privacy-reviews the set before anything
> publishes. Nothing auto-publishes.

Standing **as measured 2026-08-06** (the FINISHLINE audit figure, carried
forward, NOT re-measured at decision time): **0 of 159 published** (0/142 item
guides, 0/17 features), against a written half recorded as complete at 33/33
baseline items, 142/142 item guides, 29/29 app tutorials. An earlier revision
presented the 0-of-159 as current; it is six weeks old and nothing in this pass
re-established it. The decision does not depend on the figure being current — it
would read the same at any published count — but the date belongs with it, or
the next reader inherits a stale number as a live one.

Two constraints this decision does **not** relax:

1. **Never auto-publish.** The screenshot privacy workflow requires operator
   review before publication, and agent capture changes who holds the camera, not
   who approves the frame.
2. **The console must be reachable.** Capture is a live-estate activity, so it
   pairs with a deploy window rather than running against a local build — a
   screenshot of a local dev server is not evidence about the estate, and per
   `ux-baseline.md` G1 a receipt that did not touch real data is not a receipt.

### A finding surfaced by the OP-11 measurement, not a decision

`bootstrap-msal-app-reg.sh:1054-1056` sets the Application ID URI as:

```
az ad app update --id "${APP_ID}" --identifier-uris "api://${APP_ID}" -o none \
  && echo "    set Application ID URI api://${APP_ID}" \
  || echo "    WARN: could not set the Application ID URI (app owned elsewhere?) ..."
```

A failure prints a warning and the script **continues at exit 0**. That is the
`|| true` family `deploy-integrity.md` forbids in a deploy path: the bootstrap can
report success while leaving exactly the AADSTS500011 condition OP-11 was written
about. The remediation the script names ("app owned elsewhere?") is also a guess
the code did not establish, which is an R7 problem in the same three lines.
Filed separately rather than fixed here.

### Method note

Two of the fourteen original rows had already been measured earlier in the
session without spending operator time — OP-15's grant (genuinely resolved) and
OP-19(a)'s timers (disabled on the estate, but only by an out-of-band app
setting, so mitigated rather than resolved; the row says so and this line must
not say otherwise).
That result is what motivated running the pass over all ten rather than
forwarding the list as written.

**The ratio did NOT hold, and an earlier revision of this line said it did.**
It read "The ratio held: **7 of 10 dissolved**" — the same claim retracted at the
top of this section, surviving 142 lines below the retraction, in the very commit
whose subject was about closing a finding at every site rather than at its label.
Corrected count: **one row dissolved outright** (OP-15), four carry an operator
decision, and the rest still carry something live. OP-11 was briefly filed as a
second dissolution and is not one — see its row.

The generalisable form, worth more than any individual row here: **before asking
an operator to decide, verify the premise of the question at its site.** A
question is an instrument too, and a question whose premise is stale returns an
answer that looks authoritative and changes nothing.

The second generalisable form, learned the expensive way in this document:
**retracting a claim at its headline does not retract it at its sites.** This
section stated the corrected count at line 321 and the old one at line 463, in
one commit, and a reviewer had to find the survivor. Grep for the retracted
CLAIM, not for the place you remember writing it.
