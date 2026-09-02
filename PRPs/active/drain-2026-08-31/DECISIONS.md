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
| 2026-09-02 | #4268 | 34 SUCCESS / 3 SKIPPED, 1 advisory red (CodeQL), 0 pending | `merge-eligible.py`: MISSING none · RED none · INCOMPLETE none. Sole blocker was `REVIEW_REQUIRED` |

### #4268 — why it merged first, and why its one red did not block

Merged **first of the three ready PRs deliberately**, not by convenience. #4268
is the guard fix (`check-env-sync` went green on a shrunken population). A guard
belongs on `main` **before** the PRs it would validate, so that if #4262 or #4266
then fails the stricter check, that failure is a genuine finding. Merging them
first would have let them pass under the guard they were fixing and hidden it.

Its single red is **CodeQL**, which is advisory in this repo — not among the 15
contexts that can block. It was **judged, not waived**: the 11 `useless-escape`
alerts were disproved by execution (`temp/prove-useless-escape.mjs`), where the
suggested fix threw `SyntaxError: Missing } in template expression` on the
template-literal shell fixtures and silently **stopped matching** on the regex
literals. Disposition posted to the PR before merge.

### Close audit for #4268

**Zero issues auto-closed.** Verified by measurement rather than assumed: 25
closed issues scanned (positive control — non-zero proves the query path works),
0 falling inside the merge window.

That is the intended outcome and not luck. #4268's own body states that `#3956`,
`#3344` and `#3940` **stay OPEN on merge**, because the 17 `env[?name==].value`
sites it found live in `.github/workflows/**` and `scripts/csa-loom/**` — files
that lane does not own. They are **ratcheted and enumerated, not fixed**. Per
`deploy-integrity.md` R2 this is a CI-guard change with no deployed artifact and
no runtime behaviour on any estate: **merged, not deployed.**

### Close audit for that batch

One issue closed inside the merge window and it was checked rather than
assumed, because the row two lines above says the opposite:

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
