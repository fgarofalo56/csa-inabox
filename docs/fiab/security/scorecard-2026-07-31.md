# CSA Loom — security & release scorecard, 2026-07-31

Graded against **this repo's own rubric** (`.claude/rules/no-vaporware.md` §Grading
rubric: F / D / C / B / A / A+), not an invented scale. Every row cites the
measurement it rests on. Numbers are from a CodeQL analysis of `main` taken
AFTER #2714 fixed the scan trigger — see "Why earlier numbers were wrong".

**Overall: A / 9.0 of 10.** Not 10, and the reason is unchanged: #2723 is a
product decision I cannot make, and per-surface G1 receipts are not written.
Both are named in §2. Revised up from 8.5 on 2026-07-31 after the burn-down
below; the revision is recorded here rather than quietly applied.

**Movement since the first cut, same day:** CodeQL alerts 130 → 52 (Trivy
unchanged at 66); runtime-scoped Dependabot 9 → 1; six classes driven to zero
or to a decided state (`py/stack-trace-exposure` 20→0,
`js/user-controlled-bypass` 10→0, `js/sql-injection` 5→0-decided,
`js/insecure-randomness`, `js/incomplete-sanitization`, `js/polynomial-redos`).

---

## 1. Scorecard

| Dimension | Grade | Evidence |
|---|---|---|
| Deployment — both clouds | **A** | Commercial `loom-console--0000482` + Gov `loom-console--0000037` on the same release, `GOV-CONSOLE-ROLL 0d3776ef HEALTHY`, `/api/health` 200 |
| Supply chain | **A** | Every Gov roll passes a Trivy CRITICAL gate + cosign keyless sign & **verify-before-roll**; LIC0 covers Dockerfile-baked *and* bicep-pinned images |
| CI signal integrity | **A** | 27 ratcheting guards; CodeQL now re-analyzes `main` on every merge (#2714); Bicep Lint 30m-timeout → 5m45s pass (#2713) |
| Critical findings | **A** | CodeQL criticals **0** (from 4). Dependabot "8 critical" = **one** dev-only advisory, see §3 |
| Route authorization | **A−** | #2744 closed the credential-disclosure class: 5 routes returning live keys for shared infrastructure now carry the tenant-admin/domain-admin tier, with a CI guard (`check-credential-route-authz`) so the 6th cannot ship. Not A: query EXECUTION still runs as the console MI (#2723) |
| Class closure | **A−** | Six classes at zero or decided (see the movement note above); CodeQL 130 → 52. Every dismissal carries the reasoning and, where a guard is cited, a test that reddens if it disappears |
| Dependency hygiene | **A−** | Runtime-scoped Dependabot 9 → 1. The remaining one is `thrift` (medium) in a Rust `Cargo.lock` the npm tooling cannot reach — a real gap in the tooling, not a resolved risk |
| Tenancy model | **C** | #2723 — the Azure SQL surface is deployment-scoped by construction and nobody has confirmed that is intended |

---

## 2. What "10 of 10" would require

Stated plainly so the gap is auditable rather than rhetorical:

1. **#2723 answered.** `listServers()` is unfiltered and session-only, so any
   signed-in user can enumerate — and query, as the Console MI — every
   `Microsoft.Sql/servers` in the subscription. Either that is the intended
   model (then: document it, drop the decorative `[id]`, note it in the deploy
   guide) or it is not (then: scope `listServers()`; patching `/query` alone
   leaves enumeration open).
2. **The remaining alerts driven to a decided state.** Not necessarily zero —
   decided. 118 remain (52 CodeQL + 66 Trivy), down from 196. The CodeQL side is
   substantially triaged; the 66 Trivy findings are base-image CVEs that move
   with the base image and have not had the same per-finding treatment.
3. ~~**Runtime-scoped Dependabot cleared**~~ — effectively done: 9 → 1. The
   survivor is `thrift` in a Rust `Cargo.lock`; closing it needs Cargo tooling
   in CI, which does not exist yet.
4. **A G1 browser receipt per surface**, not just the Unity Catalog walk done
   on 2026-07-30.

---

## 3. Numbers that mislead if quoted raw

**"8 critical Dependabot alerts."** All 8 are the *same* advisory —
`GHSA-5xrq-8626-4rwp` on **vitest, scope=development** — counted once per
manifest. A dev-only test-runner CVE is not in any shipped image. The honest
sentence is "one dev-only critical", and the runtime-scoped **high** items
(protobufjs ×5, postcss ×3, sharp ×2) deserve attention first despite ranking
lower.

**"118 open code-scanning alerts."** 52 CodeQL + 66 Trivy; 0 critical, 37 high,
49 medium, 32 low (was 196: 130 CodeQL + 66 Trivy). Of the classes examined in
depth, **most were sanitiser-blindness rather than defects** — a guard exists
that the query does not model. Alert count is a workload estimate, not a defect
count.

**A counter-example worth keeping, because it cuts the other way.** In
`fiab-dbt-runner`, CodeQL flagged a path-validation `ValueError` carrying no
credential, and did NOT flag the line that appended dbt's exception text — which
could echo the caller's own DSN — into the returned log. The scanner pointed at
the safe line and missed the leak two functions away. Treat the alert list as a
prompt to read the file, not as the finding itself.

**Hardening can RAISE the count.** Switching `sanitizeButtonStates` to a
null-prototype target (#2742) made CodeQL flag a write it had previously
accepted, because the target's static type widened from a closed key set to
`Record<string, …>`. The code got strictly safer and the alert count went up by
one. Any target that rewards a falling number will eventually punish a real
fix.

**"14 hostname-regexp findings in a CI guard."** The guard greps for forbidden
hostname literals, so it necessarily contains hostname literals; it escapes them
when building the RegExp. Same shape as `check-quadratic-trims.mjs` containing
the regexes it forbids.

---

## 4. Why earlier numbers were wrong

CodeQL's `push` trigger on `main` was path-filtered to `**.py` + `portal/**`
while its `pull_request` trigger covered `**.ts` / `apps/**`. A PR was analyzed;
**merging it never re-analyzed `main`**. JS/TS alerts could only refresh on the
Monday cron.

Measured 2026-07-30: `main` had advanced ~23 merges past the newest JS/TS
analysis. The list still showed 41 `js/incomplete-sanitization` and 31
`js/polynomial-redos` — the two classes #2677 had closed hours earlier.

This mattered beyond tidiness: issues #2652–#2670 are *generated from that list*,
with instance counts in their titles. Re-measured after #2714, **7 of 17 titles
were wrong** — and two were *understated* (#2666 said 1, was 16; #2662 said 3,
was 17), the more dangerous direction.

---

## 5. Controls verified by mutation, not by reading

Each of these was proven by breaking it and watching the right test fail:

| Control | Mutation | Result |
|---|---|---|
| `resolveArmUrl` origin check | — | 27 adversarial tests: suffix-, userinfo-, double-confusable hosts; fail-closed; non-echoing |
| `listOwnedItems` dual-path authz | drop the visibility filter | exactly 2 of 4 red (#2724) |
| copy-job second-order defence | delete both `assertUserLinkedServiceTarget` calls | exactly 2 of 10 red (#2675) |
| lifecycle prototype-injection | remove allowlist + null-prototype bag | 2 of 10 red (#2675) |
| insecure-randomness ratchet | reintroduce one `Math.random()` | 166→167, exit 1 (#2716) |
| Bicep Lint failure detection | inject a `BCP057` file | exit 1 with the file named (#2713) |

---

## 6. The two things blocking A+

1. **#2723 is a product decision.** Three passes were needed to state it
   correctly — the first two framings, including two proposed fixes, were wrong.
   It is not a route that forgot a check; it is a surface that is
   deployment-scoped by construction.
2. **#2720's fix is deployed but unproven in situ.** `consoleAllowedCidrs` is
   now wired into both code-execution hosts (#2721), but those modules choose
   ingress with a *deploy-time* ternary, so compiled ARM carries the conditional
   either way. Compilation proves the wiring; only a deploy with the UDF runtime
   enabled proves the resolved prefix lands as `ipSecurityRestrictions`.

---

## 7. Standing rule this session earned

**A green gate is unverified until you have seen it emit a non-empty
measurement.** Five gates were found reporting success while measuring nothing
(#2585, #2631, #2572, #2713, #2714). The same shape appeared in a *control*:
`consoleAllowedCidrs` existed in three modules and was passed by none (#2720) —
caught only because a dismissal required citing it.

Corollary: **when about to close something, check whether the justification is
true.** Three of this session's most valuable findings came from that check.
Twice the justification was false.
