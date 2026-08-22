# Wave 0 triage verdicts — 2026-08-22

Two triage agents, read-only, measured not assumed. No issue comments posted, no
issues closed, no files edited by the triage pass (public-repo redaction review
pending — deviation from master §5 recorded in the completion note).

---

## 1. Headline corrections to the PRP itself

1. **The master PRP §4 and L0 §4 are factually wrong about #3880.** Both say #3449
   was "fixed in PR #3880" in the past tense. **PR #3880 is OPEN, not merged**, and
   `deploy-fiab-gcch` failed again today (run `32567019770`) — its **9th** consecutive
   failure, not the 6 the PRP states.

2. **Estate moved mid-session, and a second writer is implicated.**
   - 19:00Z estate = `7ab04a9e` (4 behind main)
   - 19:23–19:25Z estate = `bfd67ed1` (1 behind), stable across **15 samples / ~3 min**
   - The last **successful** `loom-roll-and-validate` run was for `7ab04a9e`; the run
     for `afcf3e6b` was still `in_progress`. **So something other than a successful
     roll put `bfd67ed1` on the estate.**
   - `deploy-fiab-commercial.yml` has **0** `concurrency` blocks across 2364 lines
     (positive control: `jobs:` = 1); `loom-roll-and-validate.yml` has 3. The two
     writers share no concurrency group.
   - The marker's `stamp` (18:36Z) **precedes** the roll — so `stamp` ≠ roll time.
     Diffing stamps to infer "what is serving" gives a wrong answer. This is #3676's
     RECENCY-vs-SERVING confusion in a second guise.

3. **A red lane tracked by no issue in the inventory:** `loom-drift-check.yml` has
   failed **5 consecutive runs over 3 weeks**. #3191 and #2874 are its *outputs*, not
   its health, and both cite run `32008423840` — still the most recent run that
   exists. The drift detector is itself a red lane under `deploy-integrity.md` R1.

---

## 2. Deploy-lane health (measured 2026-08-22)

| lane | state |
|---|---|
| `deploy-fiab-gcch` | **RED — 9 consecutive.** Step 13 `Bicep what-if` → `ClusterNotValidForPrincipals … 'Stopped'` |
| `deploy-fiab-gcc` | **`disabled_manually`** since 2026-08-08 |
| `deploy-fiab-il5` | **ZERO runs, ever** |
| `console-bluegreen-roll` | **RED — last 3 all failure**, no run since 2026-07-31 |
| `loom-drift-check` | **RED — last 5 all failure**, no run since 2026-08-17 |
| `full-app-deploy-commercial` | cancelled 2026-08-13; last success 2026-08-08 |
| `gov-provision-runner-images` | exists, **ZERO runs** |
| `loom-dataplane-roll` | dispatch-only trigger; last run 2026-08-09 |
| green | `deploy-fiab-commercial`, `loom-roll-and-validate`, `build-fiab-images-acr-tasks`, `gov-console-roll`, `gov-build-images`, `gov-gates` |

---

## 3. Verdict counts

| lane | real | stale | already-fixed | UNVERIFIED | not-a-defect |
|---|---|---|---|---|---|
| **L0** (62) | 41 | 7 | 1 | 9 | 4 |
| **L1** (48) | 38 | 1 | 6 | — | 3 |

Zero clean duplicates in either lane. Three L0 clusters collapse to one work item
each: #3449 ⊂ #3754 · #3191 + #2874 · #3633 ⊂ #3857.

**L1 is materially mis-scoped: 27 of 48 are not security defects.** Only ~12 real
true-security items are L1's to fix, and **4 of those touch files L1 does not own**
(`converge-role-assignment.mjs`, `bootstrap-msal-app-reg.sh`, the Python SDK).

L0 stale (7): #3798 #3633 #3519 #3415 #3342 #3341 #2698
L0 already-fixed (1): #3577
L1 already-fixed (6): #3843 #3834 #3751 #3747 #3608 #2622
L1 stale (1): #3525 (refuted on four counts)
L1 not-a-defect → L8 (3): #3776 #3777 #3354

---

## 4. THE L4 UNBLOCK — L1's declared `app/api/**` ownership list

Master §2 states L4 cannot open until this is published. It is published here.

### Tier 1 — L1 owns (19 route files)

```
app/api/items/[type]/[id]/security-roles/route.ts               #3855 #3833
app/api/items/[type]/[id]/route.ts                              #3611
app/api/items/[type]/[id]/access-mode/route.ts                  #3840
app/api/items/lakehouse-shortcut/route.ts                       #3611
app/api/items/by-type/route.ts                                  #3843 (fixed+live; reserved)
app/api/onelake/recycle/route.ts                                #3706
app/api/workspaces/[id]/role-assignments/route.ts               #3826 #3840
app/api/workspaces/[id]/role-assignments/[principalId]/route.ts #3826 #3840
app/api/workspaces/[id]/agent-config/route.ts                   #3840
app/api/workspaces/bulk-delete/route.ts                         #3833 (fixed+live; reserved)
app/api/admin/workspaces/route.ts                               #3826 s3
app/api/auth/cli-session/route.ts                               #3845
app/api/data-products/[id]/ports/route.ts                       #3580 #3877-f3
app/api/data-products/route.ts                                  #3501
app/api/data-products/[id]/route.ts                             #3501
app/api/data-products/[id]/status/route.ts                      #3501
app/api/data-products/[id]/certify/route.ts                     #3501
app/api/data-products/[id]/deprecate/route.ts                   #3501
app/api/data-products/[id]/health-actions/route.ts              #3501
```

### Tier 1b — THE TRAP. A non-`route.ts` file under `app/api/` that L1 must own

```
app/api/items/_lib/item-crud.ts                                 #3501 #3706
```

L4's charter says it owns "the rest of `app/api/**`". `_lib/item-crud.ts` is under
`app/api/` but is **not** a `route.ts`, so a literal reading hands it to L4 — while
two L1 true-security fixes must edit it. **It is imported directly or transitively
by 173 route files.** L1 owns it explicitly; L4 must be told to keep off it.

### Tier 3 — L1 explicitly RELEASES these

```
app/api/admin/workspaces/[id]/cmk/route.ts              #3757 → L5
app/api/admin/audit-logs/route.ts                       #3750 → L5
app/api/admin/workspaces/[id]/git/route.ts              #3588 → L4
app/api/admin/workspaces/[id]/git/branch-out/route.ts   #3588 → L4
app/api/items/data-pipeline/[id]/{run,debug,triggers}/route.ts  #3755 → L3
```

Verified needing **no** route.ts: #3717 #3740 #3547 #3512 #3525 #2622 #3741 #3540

---

## 5. Batches

### L0 — 4 batches

**A · rank 1 (P0) — unblock the red deploy path.** #3449 #3754 #3786 #3460 #3683
#3380 #3161(verify-only). Files: the four `deploy-fiab-*.yml`. Forced grouping — all
seven touch one or more of the same four files; nothing here parallelises.
*Sequence:* merge #3880 → one green scheduled gcch run → #3683/#3380/#3460/#3786 →
gcc re-enable (blocked on #3416).

**B · rank 2 — Gov roll, notification, producers.** #3844 #3416 #3346 #3060(receipt).
Files: `gov-console-roll.yml`, `gov-provision-runner-images.yml`,
`loom-dataplane-roll.yml`, `deploy-notify-failure.mjs`, repo var
`FIAB_GOV_DEPLOY_TRACKING_ISSUE`. #3416 needs no code — only a **run**.
*Boundary:* #3844's IL5 half needs `deploy-fiab-il5.yml` (Batch A). Take the
repo-variable route and B stays disjoint.

**C · rank 3 — bicep env-wiring / auto-bind §5.** #3317 #3327 #3370 #3372 #3433
#3446 #3078 #3788 #3839. Nine issues converging on the repo's two hottest bicep
files — batching costs 1 CI cycle instead of 9.
*Sequence:* #3078 must land **after** #3416 produces a GCC image, or flipping
`deployAppsEnabled` turns a green-deploy-of-nothing into ACA revisions dying on
`MANIFEST_UNKNOWN`.

**D · rank 4 — isolated guards + leaf modules.** #3787 #3704(partial) #3374 #2642.
Genuinely parallel-safe. **#2642 has an external clock: 2026-10-01, ~6 weeks out.**

#### ⚠️ BLOCKING cross-lane collision — resolve before Batch C starts
`check-deploy-template-sync.mjs` requires `apps/fiab-console/deploy-templates/main.json`
to be **byte-identical** to a fresh `az bicep build` of `platform/fiab/bicep/main.bicep`.
That file is under `apps/fiab-console/**`, which L0 must not touch. **Every Batch C
issue edits `main.bicep`, so every one forces an edit to a file L0 does not own — or
merges an inert change.** Needs the master's §6 procedure. Skipping it is exactly the
inert-fix class the guard was built for.

### L1 — 3 batches + 1 blocked

**1 · blast radius #1 — "the guard and every route it pins".** #3855 #3833 #3877
#3850 #3580. #3855 is the only *currently exploitable cross-tenant write* in the lane
(a tenant admin in A writes ADLS POSIX ACLs against B's lake). Its fix and the guard
that should have caught it are inseparable: the guard's `ADMIN_GRANT_SCOPE` regex
tests `fn.params`, and this route's params are `session, itemId, itemType`, so it
`continue`s at `:2684`. **A guard with an empty population exactly where the bypass sits.**

**2 · blast radius #2 — "the tenant decision and its generator".** #3826 #3840 #3845.
The sharpest structural finding: **#3845 is the live generator of tid-less sessions**
(`cli-session/route.ts:118` mints `{oid,name,upn,email}` with no `tid`, while the
device-code branch at `:161` does stamp it). #3840's residual and #3826's write-side
escalation both *consume* that state. Fix consumers alone and the generator refills
them; fix the generator alone and the residual stays exploitable via a pre-existing
session. One PR. Tightening `workspace-access.ts:335` affects ~270 call sites.

**3 · blast radius #3 — item tenancy + the vault destruction primitive.** #3611 #3501
#3706. #3501+#3706 share `_lib/item-crud.ts` (non-negotiable). #3611 is P1: a generic
PATCH takes `state` wholesale with no field validation and reaches
`deleteShortcutSecret(st.secretRef)` — any authenticated user with a shortcut in their
own workspace can soft-delete an arbitrary vault secret.

**4 · BLOCKED — needs cross-lane ownership extension.** #3861 #3637+#3335 #3717 #3829.
Three are real credential-exposure defects touching files outside L1's §2 list. They
stall silently unless routed.

---

## 6. Needs the operator's hands (no agent can do these)

- **#3429** — `deploy-copilot-function`, **9 consecutive failures**, last success
  2026-06-10. Root cause is a **secret repoint**, not code: the workflow documents a
  DLZ subscription; the run authenticates to a DMLZ one.
- **#3335** — one bootstrap run with `LOOM_MSAL_PRUNE=1`. Prune is dry-run by default
  and no dispatch passes it, so long-lived MSAL secrets may still be accumulating.
- **#3416** — needs a **run** of `gov-provision-runner-images`, not code.
- **Gov receipts generally** — only from Actions runs; this workstation authenticates
  to a different tenant.

---

## 7. Recommend filing (not in the 261)

1. **`workspace-access.ts:490` (`listAccessibleWorkspaces`)** — the last unfiled
   executable copy of the #3823 shape. `if (callerTid && doc.tid && doc.tid !== callerTid) continue;`
   → a tid-less session gets **no filtering at all**. Feeds `items/by-type:121`,
   `workspaces/route.ts:27`, `running-workloads:47`, `catalog-search.ts:121`. It sits
   in the guard's `NON_AUTHORIZERS` with a reason that is true about it not being an
   authorizer and **silent about whether its filter is sound** — the "allowlist reason
   true of a sibling branch" shape. With #3845 proving a live generator, it is reachable.
   Measured: truthiness-guarded tid comparisons — live estate 3, current main 2.
2. **`loom-drift-check` is red** (5 consecutive, 3 weeks) — no issue tracks it.
3. **IL5 carries #3449's defect unmitigated** — `deploy-fiab-il5.yml` is active,
   `adxEnabled = true`, has an `az deployment sub what-if`, **no ADX preflight, zero
   runs ever.** #3786 covers Commercial only.
4. **No CI ratchet catches an ADX-preflight re-inversion** (see §8).
5. **#2678 §5 and #3110 §5 are the same audience-separation defect** — the sign-in
   MSAL app doubling as the Iceberg catalog audience. Cross-link or two lanes fix it twice.

---

## 8. PR #3880 — independent review: APPROVE

Ordering invariant **satisfied**: preflight moved idx 16 → 11; first ADX *read*
(`what-if`) is idx 12; steps 0–10 dumped and none touch Kusto. Blast radius is a
provably pure relocation — 26 steps before and after, `removed: set()`, `added: set()`,
content-identical order-insensitive. All 3 SKIPPED contexts are path/event-appropriate;
`Workflow lane states` carries `if: github.event_name != 'pull_request'` by design and
the equivalent ran in `guardrails` (143 ran, 0 skipped). `merge-eligible.py`'s
`ELIGIBLE:False` is the known path-appropriate false positive.

**Finding 3a (should-fix):** nothing in CI would catch a re-inversion. A real
counterfactual (Arm A = fixed, Arm B = pre-fix ordering) across 8 guards returned
**identical verdicts**, with an embedded liveness control proving the sandbox judges
that exact file (`CONTROL RC=1` vs `CLEAN RC=0`). The idiom already exists in
`check-admin-principal-kind.mjs`, which scans every workflow and already classifies
`what-if` as ARM-reaching.

**Finding 1a (should-fix):** the preflight is gated `schedule || run_mode == full`
while `what-if` is ungated — so a **default `whatif-only` dispatch skips the preflight
and fails identically.** Do not use it to prove the fix.

**Receipt options:** `gh workflow run deploy-fiab-gcch.yml --ref main -f run_mode=full
-f allow_existing_hub=true -f keep_resources=true` (real non-destructive
reconcile-in-place, ~30 min ADX start polling), or the free 10:00 UTC cron on 2026-08-23.

**Merge mechanics:** BEHIND by 2 commits, neither touching this PR's files — update is
mechanically safe. PR body says "Refs #3449", not "Closes" — correct; #3449 stays open
until a Gov Actions run proves it. Report as **merged, not deployed** until then.

---

## 9. Issue bodies that are factually wrong and need a correction pass

- **#3637** documents a workaround the script now **refuses** (`:151` hard-fails when
  `MIN_REMAINING_DAYS >= SECRET_YEARS*365`, default 1). There is currently *no*
  rotate-after-compromise path. Correct before anyone reaches for it in an incident.
- **#3457** names the wrong ecosystem (Rust/`loom-directlake`, not the TS Flight SQL
  surface) and a stale alert count (**7 open, not 1**).
- **#3525** line numbers all wrong; its "does not exist" claim about
  `grant-purview-uc-role.sh` is **false**; live ADX shows `AllDatabasesAdmin` Succeeded.
- Counts measured ≠ claimed: **#3458** 34 not 36 · **#3430** 59/59 not 24/24 ·
  **#3429** 9 not 7 · **#3717** 7 sites not 6 · **#3741** 2 not 1 · **#3463** ~17 not ~20 ·
  **#3370** 3 not 4 · **#3850** 22 not 23 · **#3818** 5 not 8.

---

## 10. Method notes (both agents hit traps and caught them)

- **L0:** `git show origin/main:.github/workflows/X.yml` is MSYS-mangled into
  `origin\main;.github\...` and dies `fatal:` — piped to `grep` that reads as "no
  match". Three early greps were false zeros. Re-ran everything against the working
  tree after proving `git diff --name-only origin/main HEAD` returns only `PRPs/**`
  and `git status --porcelain` is empty.
- **L1:** an `rg -r` where `-n` was meant silently replaced every match, making a
  string look deleted from the tree. Re-ran; present in 4 files.
- L1 used the step-level, not run-level, conclusion for the 59-run sweep, and
  filtered `ESC[36;1m` echoed-source lines before reading `::error::` lines.

## 11. Still UNVERIFIED (18 total) — the shape of what's missing

9 L0 + 8 L1 items rest on evidence no read-only agent can obtain: an authenticated
live-console read, a G1 browser walk, Azure Monitor metrics, or a Gov Actions receipt.
All four newly-deployed L1 verdicts (#3843 #3834 #3751 #3747) are **marker-level only**
— and given #3676 (a deploy that silently reverts rolled images) is itself still real
with a gate that has **never executed**, re-read the marker before acting on them.
