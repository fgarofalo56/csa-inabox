# FINISHLINE session notes

## Session 4 — 2026-08-09/10

### THE HEADLINE

Two live outages, **both the same shape**: the detector worked perfectly and the
**reporting channel was silently dead**. Neither appeared in any status.

The estate itself is healthy — `b52cee5b` == `origin/main`, **zero drift**.

### 1. The synthetic-journey alert has NEVER once fired

The six live user journeys have been failing **continuously since
2026-08-07T08:15Z** — 83 of the last 100 workflow runs red, plus the ACA job's
own `*/15` cron. Number of `synthetic-monitor` issues ever filed: **ZERO**.

Cause, in the step the file's own header calls *"the durable signal"*:

    const exec = `${{ steps.run.outputs.execution }}` || '<unknown>';

`exec` is injected by `actions/github-script`, so the body is a redeclaration —
`SyntaxError` at COMPILE time; not one statement ever ran. The sibling
action-group notification swallows its errors with `2>/dev/null`, so both
channels went quiet simultaneously.

Fixed in **#3181**, with a guard (`check-github-script-syntax.mjs`) that compiles
all 20 of the repo's github-script bodies the way the action does. On its first
run the fix filed **#3182** — the first P1 this monitor has ever produced.

### 2. CodeQL has been analysing NOTHING

Dependabot #3103 bumped **only** `codeql-action/init` (4.35.3 → 4.37.6), leaving
`autobuild`/`analyze` behind → *"Loaded a configuration file for version
'4.37.6', but running version '4.35.3'"*.

Not merely a red non-required check. A failed analysis still uploads a
0-rule/0-result SARIF, and **GitHub does not retire alerts from that upload** —
so the code-scanning list FROZE at the last real scan and has been reading as
current while every merge went unscanned. codeql.yml's own assertion step says
exactly this, and it was firing.

**#3183**: align the pins, group `github/codeql-action*` in dependabot so a bump
cannot split again, plus a fail-closed ratchet. **Expect the alert count to JUMP
on the first green run** — that is the backlog becoming visible, not a regression.

### 3. The failing journey is J3 — a Secure cookie against an http BASE

With the pager working, the first run gave the diagnosis 83 red runs never did:

    UAT_RESULT pass=3 fail=1 skip=3 realFails=1 infraGated=0
    UAT_FAIL … synthetic J3 — open editor + primary action (lakehouse tables → ADLS)

Measured cause: the in-VNet job runs `LOOM_URL=http://loom-console` while
`e2e/_lib/uat.ts` `signIn()` minted its cookie with `secure: true`. A Secure
cookie is never sent over http, so the **browser** context was unauthenticated —
every client call 401s (including `/api/telemetry/rum`), which J3 reads as
"editor mount errors". J2/J4 kept passing because the API context authenticates
via `extraHTTPHeaders`, a raw header that bypasses cookie scheme rules.

**OPEN, deliberately not closed:** this explains the CURRENT failure but not why
the last success was 08-07T08:15Z. The job's env history could not be recovered.
Do not record J3 as fixed on this alone — re-measure after the `loom-uat` image
rebuilds (the test-side fixes are merged-not-deployed until then).

### FLAGGED, NOT FIXED

- `admin-plane/main.bicep` hands the job `fdOn ? frontDoorPublicUrl :
  'http://loom-console'`. The job existing proves two of `fdOn`'s three
  conjuncts, so it was deployed with **frontDoorEnabled FALSE** — while the
  estate's Front Door profile is **Active**. Not investigated.
- `check-node-test-suites.mjs` walks `temp/` (gitignored, so CI never sees it);
  any worktree left there makes the LOCAL run unusable.

### REPO HEALTH (found incidentally)

The main `.git` index was **corrupt** (`bad signature 0x00000000`) and
`git status` reported a **clean tree** while reading it. Rebuilt from HEAD,
working tree untouched. The corruption actually lived in an orphaned
`.claude/worktrees/wf_*` tree — `git fsck` reports those repo-wide — now removed
(no unique commits). **316 worktrees remain.** `.git/index.lock` recurs; it is
left behind by git-spawning test suites, not a live holder (verified by removing
it and watching whether it came back).

### DO-NOT-REPEAT (all measured this session)

- **A guard's own first draft can be blind to a VARIANT.**
  `check-github-script-syntax` anchored on `/^\s*uses:/` and missed the
  `- uses:` spelling — 2 of 20 real blocks. Caught **only** by reconciling its
  count against an independent grep. Always reconcile a scanner's N.
- **stderr non-empty ≠ command failed.** My own new "query FAILED" branch keyed
  on `[[ -s $ERR ]]`, and az writes extension-install notices to stderr — so it
  reported a good query as failed. Use the EXIT CODE.
- **`tr '\n' ' | '` silently collapses to a space** (tr maps CHARACTERS), and the
  tr-to-sentinel + `sed 's/\034/…/'` workaround does not match either — it leaves
  invisible control bytes. Use `awk`, verify with `od -c`.
- **Never interpolate LOG TEXT into a github-script `${{ }}` template literal.**
  A backtick or `${` in a captured line is a SyntaxError that kills the alert —
  reproducing the very outage. Pass via `env:` / `process.env`.
- **Truncating evidence you already collected is a self-inflicted unknown.**
  J3's note capped the console list at 2 entries / 150 chars and cut off mid-way
  through the second error; that cap is why the cause was unreadable for two days.
- **MSYS mangles `git show 'branch:path'`** — prefix `MSYS_NO_PATHCONV=1`.
- **The ledger lives on `harness/finishline-s1-b`.** Read from a branch off main
  it shows a STALE copy with different statuses.

### IN FLIGHT / OWED

- **#3181** (synthetic alert + J3) and **#3183** (CodeQL) — open, CI running.
  Both blocked only by the CodeQL jobs that #3183 itself fixes.
- **#3180** (admin OID + Iceberg `minReplicas`) — branch updated onto main, all
  **required** checks green. It restores the operator's own admin access, which
  every deploy currently reverts.
- **C4** is still `in_progress` and, on the evidence, **never started**: no PR,
  empty evidence, all six gates pending, and its session-3 agent died with that
  session. Resumable as-is; its four parts are independent.

### OPERATOR QUEUE

Unchanged from session 3 (OP-1…OP-12; none resolved this session). New: decide
whether the `frontDoorEnabled=false` deploy of the synthetic job is intended.

---

## Session 2 — 2026-08-08

### THE NUMBER THAT MATTERS

**21 PRs merged.** The estate is still at **`10365e76`**. Everything below is
**merged, not deployed** — the deploy that would carry it has been **queued
~100 minutes** behind this program's own CI (all `ubuntu-latest`, no
concurrency group holding it, no self-hosted dependency; I cancelled 16 queued
dependabot runs to free capacity and stopped adding load).

### THE THREE SECURITY FINDINGS (each verified independently, not taken on report)

1. **A dead endpoint scored a PERFECT safety result.** `ai-red-team`
   `run/route.ts:91-95` caught a thrown model call and returned
   `verdict:'refused'`, which renders as success — so a deployment where every
   probe errored reported **100% refusal / 0% attack success**. Fixed (#3130).
2. **`semantic-model/[id]/model` PATCH had NO authorization** while its four
   siblings each call `authorizeItemWorkspace`. It doesn't even take
   `session`/`params`, and reaches XMLA TMSL writes on the shared AAS database —
   a read-only Viewer could author what POST/PUT/DELETE refuse. Four more
   unauthorized handlers alongside it, found *by the fixed checker* (#3134).
3. **Expiry auto-revoke never ran on any estate.** `LOOM_SWEEPER_TOKEN` had zero
   hits in `platform/`/`scripts/`/`.github/` and the routes fail closed without
   it, so time-bound access stayed live as a real ARM role assignment **and** a
   data-plane grant while the ledger showed it as time-bounded (#3129).

### TWO AUDIT PREMISES FALSIFIED — both were real results

- **"160 gates vs 131 Fix-its" does not exist.** It is 131:131, and
  `types.ts` declares `fixit: GateFixit` **non-optional**, so a gate without one
  cannot compile. The real breach is 74 bare remediation bars — and **59 should
  be REMOVED under auto-bind, not given a button** (issue #3133).
- **#3056 was not a rotation clobbering a stable value.**
  `loomGeneratedSecretSeed` defaults to `newGuid()` with no parent passing it, so
  ARM re-mints it **every deploy**. Bicep *was* the rotator. That is why both of
  my re-syncs were correct and temporary.

### FEDERATION (RC-9) — root-caused, fixed, still grade D

`"Invalid issuer"`: the catalog rejected **its own tenant's** v1.0 tokens
against a v2.0-only allow-list. Issuers are now **derived from the tenant's own
discovery document** at the per-cloud authority host, so **the Gov issuer comes
out correct without this repo knowing what it is**. Fails closed. Merged #3121.

**Still owed: the 200.** Needs the **`loom-unity` IMAGE** rebuilt + a roll of
**both** `loom-unity` and `iceberg-catalog` — a console roll will NOT carry it.
Plan is in `meta.rc9_roll_plan_2026-08-08`.

### SOVEREIGN LANES

**`deploy-fiab-gcch` is GREEN on whatif** (run 31245000009) — first green in
16+ days — with Provision/Smoke/**Teardown** skipped. Both lanes remain
`disabled_manually`; the cron never armed.

**GCC's earlier green was HOLLOW** — `deploy-fiab-gcc.yml:125` ran
`2>/dev/null || echo "0"`, so any az failure read as "no existing hub" and the
guard passed. Fixed in #3139 but **never exercised live**, so GCC must not be
re-enabled on any existing receipt. Its cycle was deliberately deferred: at
07:36Z there were only 23 minutes to its 08:00Z cron, and a mis-step there
arms an unattended sovereign **teardown** ring.

### DO-NOT-REPEAT (measured this session)

- **Ask the right SCOPE.** A **branch**-scoped CodeQL query returned zero while
  **PR**-scoped had 5 high alerts. The clean answer was the one that lied.
- **A deny-list cannot catch a lookalike.** The sovereignty check ACCEPTED
  `login.microsoftonline.us.evil.example`, `evil.login.microsoftonline.us` and a
  Commercial lookalike — while a comment above it asserted the opposite. Use an
  allow-list and drive it through poisoned fixtures.
- **A fix's own explanatory COMMENT can keep its guard quiet** after the fix is
  removed (C20 M1b). Blank comments length-preservingly before matching. The
  inverse now exists too: `deploy-fiab-gcc.yml:146` carries the literal unsafe
  pattern *in a comment documenting its removal*, so a count-based guard would
  read that file as unfixed.
- **A bare non-zero command in a bash EXIT trap does NOT change exit status.**
- **`VAR="${VAR:-$(az … 2>/dev/null)}"` under `set -euo pipefail`** aborts the
  step and destroys the message — it made an honest-skip branch unreachable.
- **Guards that scan per-physical-line miss shell continuations**, and one that
  only walks `.github/workflows/` never sees `scripts/`.
- **Secondary rate limits are endpoint-specific.** HTTP 403 on
  `actions/runs/{id}/jobs` while core sat at ~4880/5000. Workaround that held:
  `commits/{sha}/check-runs` + `check-runs/{id}/annotations`.
- **Verify a reported PR number.** One lane reported a PR it had never created;
  the number belonged to another lane.
- **Check which branch the ledger is on** (`harness/finishline-s1-b`) — a stray
  checkout showed a stale 41-task file and briefly looked like data loss.

### OPERATOR QUEUE (highest leverage first)

1. **Re-enable `deploy-fiab-gcch`** — now backed by a green whatif; an empty
   `CSA_LOOM_TARGET_SUBSCRIPTION` is correct for that path. **Do NOT re-enable
   `deploy-fiab-gcc`** until its own cycle is green.
2. **Gov Databricks SQL warehouses** — `TEMPORARILY_UNAVAILABLE` on all 8 list +
   8 create attempts over ~6 min. Not transient; likely a `cloud-parity.md` §3
   case. The old RBAC blocker is genuinely cleared.
3. **The D8 `--apply`** against the real stale `privatelink.azuredatabricks.net`
   zone — the only honest live proof of that destructive path. #3038 closes only
   on a green `deploy-fiab-commercial` after it.
4. **#3078 needs a COMMERCIAL-cloud image producer** (GCC is `AzureCloud`+eastus).
5. **59 auto-bind gate removals** (#3133) · ACR Tag Contributor (OP-15) · #2643 ·
   #2330 · seven idle Function Apps · svc-postgres cost ruling.

### IN FLIGHT

`#3122` (token ownership) rebased twice onto main with the template regenerated
at pinned bicep **0.45.15** — checks running. Deploy run **31243230253** queued.
`gov-provision-trino` **still never run**.

