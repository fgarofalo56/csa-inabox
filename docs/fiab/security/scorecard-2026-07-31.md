# CSA Loom — security & release scorecard, 2026-07-31

Graded against **this repo's own rubric** (`.claude/rules/no-vaporware.md` §Grading
rubric: F / D / C / B / A / A+), not an invented scale. Every row cites the
measurement it rests on. Numbers are from a CodeQL analysis of `main` taken
AFTER #2714 fixed the scan trigger — see "Why earlier numbers were wrong".

**Overall: A− / 8.5 of 10.** Not 10. The two gaps holding it there are named in
§6 and neither is closable by code alone.

---

## 1. Scorecard

| Dimension | Grade | Evidence |
|---|---|---|
| Deployment — both clouds | **A** | Commercial `loom-console--0000482` + Gov `loom-console--0000037` on the same release, `GOV-CONSOLE-ROLL 0d3776ef HEALTHY`, `/api/health` 200 |
| Supply chain | **A** | Every Gov roll passes a Trivy CRITICAL gate + cosign keyless sign & **verify-before-roll**; LIC0 covers Dockerfile-baked *and* bicep-pinned images |
| CI signal integrity | **A** | 27 ratcheting guards; CodeQL now re-analyzes `main` on every merge (#2714); Bicep Lint 30m-timeout → 5m45s pass (#2713) |
| Critical findings | **A** | CodeQL criticals **0** (from 4). Dependabot "8 critical" = **one** dev-only advisory, see §3 |
| Route authorization | **B+** | 1661 routes inventoried; 101 public — each is a deliberate unauthenticated surface, but the inventory itself misreported ~16 protected routes as public until #2677 |
| Class closure | **B+** | 2 classes at zero (`js/incomplete-sanitization` 42→0, `js/polynomial-redos` 35→0); 196 alerts remain, triaged but not all resolved |
| Dependency hygiene | **B** | 46 Dependabot open; runtime-scoped ones (protobufjs ×5, postcss ×3, sharp ×2) are the real queue |
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
2. **196 alerts driven to a decided state.** Not necessarily zero — decided.
   Every remaining alert either fixed, or dismissed with a test that goes red
   if the cited guard disappears. 23 are already in that state.
3. **Runtime-scoped Dependabot cleared** (protobufjs, postcss, sharp).
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

**"196 open code-scanning alerts."** 130 CodeQL + 66 Trivy; 0 critical, 95 high,
69 medium, 32 low. Of the classes examined in depth, **four of five were
sanitiser-blindness rather than defects** — a guard exists that the query does
not model. Alert count is a workload estimate, not a defect count.

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
