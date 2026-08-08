# FINISHLINE session notes

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

