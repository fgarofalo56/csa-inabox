# PRP — ZERO-BACKLOG: drain all 297 open issues under an autonomous harness

**Status:** active · **Opened:** 2026-09-11 · **Owner:** the drain harness
**Scope decision (operator, 2026-09-11):** all 297 open issues. Tracked+tested
harness. Autonomy includes live deploys. G1 receipts via Playwright against the
live estate, parking only on auth failure.

---

## 1. Definition of done

**Zero open issues that the harness has not either closed on a measured receipt
or explicitly parked with a named blocker and an owner.**

"Drained" is NOT "worked on". Per `deploy-integrity.md` R2 an issue closes only
on **deployed-and-verified**, so the harness's terminal states are:

| state | means | evidence required |
|---|---|---|
| `closed` | done | a receipt **of the kind §5 requires for its class** — never a merge alone |
| `parked` | genuinely blocked | named blocker + owner + review date |
| `declined` | will not do | recorded decision, operator-confirmed |

Anything else is in flight. A run ends when every issue is in one of the three.

**This is a standing program, not a session.** 297 issues / 842 measured points
with 153 unsized. It will span many sessions and many cold starts. The harness
exists so that surviving a cold start costs at most the cycle in flight.

---

## 2. The measured inventory

Generated, never hand-edited — see **[INVENTORY.md](INVENTORY.md)**, regenerated
by `python tools/drain/build_inventory.py`. Totals at open:

| | |
|---|---|
| open issues | **297** |
| story points on sized issues | **842** across 144 |
| **unsized** | **153 (52%)** |
| **unlaned** (no file-partition key) | **118 (40%)** |
| epics | 10 |
| blocked | 12 |

**The two gaps above are the first work, not an aside.** The harness partitions
lanes by FILE (a shared-file conflict must serialize, never parallelize). An
issue with no lane cannot be safely scheduled, and an unsized issue cannot be
planned. So W9 triage gates most of the parallelism.

### Workstreams, in execution order

| stream | what | issues | pts | unsized |
|---|---|---:|---:|---:|
| `W0-harness` | Harness + gate integrity (the drain's own tooling) | 4 | 0 | 4 |
| `W1-deploy` | Deploy-path integrity — **R1 preempts everything** | 26 | 74 | 15 |
| `W2-security` | Security + authz | 20 | 21 | 15 |
| `W3-gov` | Sovereign / cloud-parity (absorbed by W1 where it overlaps) | 0 | 0 | 0 |
| `W4-receipts` | Owed receipts — merged-not-verified | 15 | 30 | 10 |
| `W5-console` | Console surfaces (ui-parity / ux-baseline) | 84 | 408 | 11 |
| `W6-ci` | CI guards + lanes | 21 | 76 | 8 |
| `W7-bicep` | Bicep / infrastructure | 18 | 102 | 0 |
| `W8-dataplane` | Data plane | 19 | 126 | 1 |
| `W9-rest` | Unclassified remainder — **triage before scheduling** | 90 | 5 | 89 |

Ordering rationale: **W0 first** because the harness must be auditable before it
is trusted to merge 297 issues' worth of work (#4468 — the gate that decides
every merge is currently gitignored). **W1 second** because `deploy-integrity.md`
R1 makes a broken deploy path P0 over all feature work. **W9 triage** runs
continuously alongside, because it unblocks scheduling for everything else.

---

## 3. The cycle protocol

One cycle is one transaction against `tools/drain/state.json`. Nothing
important lives in any agent's context.

```
tick.py
  1 GUARD     refuse a live read that is the wrong repo or a truncated page
  2 REFRESH   re-read live GitHub -> new issues appear; a departed issue goes to
              `needs-audit` (non-terminal), NEVER to `closed`
  3 REAP      --reap returns stranded in-flight lanes to ready
  4 SELECT    next lane set: file-disjoint, WIP<=N, dependency-ordered
  5 EMIT      per-lane briefs + a regenerated cold-start KICKOFF
```

Step 1 exists because both failures exit 0 with valid JSON. `gh issue list`
resolves the repo from the working directory unless `--repo` is passed, so
running the harness from another checkout produced a large, plausible, entirely
disjoint list — which moved every item out of the queue in one atomic save.

Then agents run the briefs and return results; `tick.py` applies them next pass.
**Every pass is independent.** A dead session loses at most one cycle.

### Context rotation

The failure this design exists to prevent: an agent holds the plan in its head,
context fills, the plan is summarized into vagueness, and the run degrades
without anyone noticing.

- The ledger is the only durable state. Briefs are **generated from it**, never
  carried forward.
- A brief is self-contained: it restates the traps, the gates and the acceptance
  for that item. An agent never needs the previous cycle's transcript.
- `KICKOFF.md` is **regenerated every cycle**, so a cold start reads current
  truth rather than a stale handoff.
- Agent output is written to the ledger as structured results, not prose.
  Prose that matters goes into the issue or the PR, where the next reader is.

---

## 4. Autonomy contract

Encoded in `tools/drain/policy.json` — the file is the authority, this table is
the summary.

**Permitted unattended:** open PRs and issues · merge on gate **GO** · close on
a receipt · re-run and **approve parked CI runs** · dispatch deploy workflows
and rolls against the live estate · Playwright walks against the live console.

**STOP and ask** (hard-coded refusals, not conventions):
- publishing a security advisory
- anything that moves live ACR `:latest` / `:v0.1` tags (a branch dispatch of
  `build-fiab-images-acr-tasks` does exactly this for all 13 images)
- data or schema deletion; force-push to a shared branch
- disabling, weakening or baselining a guard to make something green
- `.trivyignore` additions (the file is deliberately empty — fix the image)
- `LOOM_BUILD_SKIP_SUPPLY_CHAIN` / `skip_uat` / `skip_signature_verify`

**Never, regardless:** touch security software · read or echo a credential ·
commit a secret · report a merge as a fix.

---

## 5. Receipts — what closes an issue

| receipt | satisfies | how the harness gets it |
|---|---|---|
| `ci-green` | guard/test-only change | required contexts green **and** hollow-check clean at the merged sha |
| `deploy-run` | deploy-path item | a workflow run whose deploy job **executed steps** against a live subscription |
| `estate` | behaviour on the estate | live `build-marker.txt` contains the merged sha, plus the asserted behaviour |
| `g1-browser` | any UI surface | Playwright walk on the live console: screenshot + an assertion **unreachable from an error path** |
| `operator` | genuinely human | parked with an exact click-script |

**The G1 trap, recorded because it already happened:** an assertion advertised as
"requires a real answer" was satisfied by `Error: HTTP 500`, because the pane
fills its streaming placeholder with the error text on any non-ok response. A G1
assertion must key on something **only a success path can produce** — the
corrected one asserted `copilot-agent-badge`, a testid set only by an SSE `agent`
step. Every `g1-browser` receipt must name why its assertion is unreachable from
an error path.

---

## 6. Gates the harness must pass before merging anything

Implemented in `tools/drain/gates.py` and **composed by `tools/drain/merge_gate.py`**,
which is the production caller (tracked, tested — this *is* W0/#4468):

```bash
python tools/drain/merge_gate.py <PR>     # prints GO / NO-GO with the evidence
```

That caller is load-bearing and was missing at first review: `gates.py` existed,
was tested, and **nothing in the harness called it** — four of the seven gates
below were named here and implemented nowhere, and the briefs restated them as
instructions, so at run time GO/NO-GO was an agent's judgement. A gate with no
caller is prose; so is a `policy.json` key nothing reads.

1. **base == `origin/main`** exactly.
2. **Conjunction, not recency** — a later APPROVE does not discharge an earlier
   block; reduce by conjunction.
3. **Verdict pinned to the head it measured** — any push voids it. `clause5`
   may carry a void APPROVE across an **artifact-only** re-derive, and must
   refuse a source change.
4. **Required contexts** present, none RED, none INCOMPLETE.
5. **Hollow-check** — did each check *measure* anything, or pass over zero files.
6. **Auto-close scan over BOTH the body and the commit trail**, shape-keyed to
   all nine closing verbs plus an optional colon. `closingIssuesReferences` is
   **not** a complete oracle — it read empty while a squash commit carrying
   `fixed: #4361` closed that issue.
7. **Before/after open-issue audit on every merge.** The count delta is what
   actually catches a false close; the scan is prevention, the audit is
   detection, and the audit has caught what the strongest API oracle did not.

---

## 7. Risks — each one measured this session, not hypothetical

| risk | evidence | mitigation in the harness |
|---|---|---|
| The harness mass-closes the queue | `gh` with no `--repo` resolves from cwd; a disjoint live set closed every item with a fabricated `closed-externally` receipt | `--repo` from policy; overlap + retention guards; departures go to non-terminal `needs-audit` |
| A brief tells its agent the wrong receipt | receipt keyed on `lane == 'lane:console'`, so 3 of 5 classes were unreachable and every deploy-path brief said `ci-green` | receipt derived from the item's CLASS; `ledger.transition()` enforces the kind |
| An empty ledger reads as a finished run | `all([])` is True; a deleted scratch file printed `drained: true` over 297 open issues | `drained()` requires items; `--status` refuses a missing file with rc=2 |
| A mutation matrix that measures the author | 6 of 8 reviewer-written arms survived a 6/6-KILLED matrix; all six narrowed the POPULATION, not the check | arms `N*`/`L*`/`T*` are population-narrowing; fixtures are multi-line and multi-element |
| A fix lands on one side of a boundary | 5× in 4 PRs, every one with a green mutation matrix | brief mandates "what is the OTHER side?"; reviewer must mutate the **unpatched** sibling |
| A gate that cannot fail | #4451 — `pass=4 fail=4` printed "UAT-verified roll", 4 measurements, no observed failing input | every gate the harness adds ships with a **negative control**; a gate never observed failing is not trusted |
| A guard satisfied by a comment | #4467 — rewording prose moved the population 1010→1011 | guards match code, not raw source; `codeOnly()` before **all** predicates |
| Push into a CONFLICTING window | zero check-runs **permanently**; same MISSING symptom as a parked run, opposite remedy | clear conflict → confirm MERGEABLE → then push; `total_count==0` is the discriminator |
| Silent auto-close | #4361 closed with `closingIssuesReferences` empty | gate body **and** commits; audit count before/after every merge |
| Shared-checkout contention | 4 lanes collided on one worktree | lanes serialize on the shared checkout; the tool refuses a dirty tree with rc≠0 |
| Host memory pressure | `vmmemWSL` 48 GB + `llama-server` ~18 GB before any agent; 3 kills | WIP cap is a **policy input**, not a constant; a kill is not evidence the command was expensive |
| Unbounded scratch | a heredoc became a REPL and wrote a **65 GB** `.err` | never `python - <<EOF`; scripts are files; bounded redirects |

---

## 8. Acceptance

- [ ] `tools/drain/` is **tracked**, lints clean, and every decision function has
      a unit test **and a negative control** (#4468 closed on that basis).
- [ ] `build_inventory.py` regenerates INVENTORY.md and **refuses on a partition
      that loses an issue** (it asserts totality today).
- [ ] All 153 unsized issues carry a size; all 118 unlaned carry a lane.
- [ ] Every one of the 297 reaches `closed` / `parked` / `declined`.
- [ ] No issue closed without a receipt of the kind §5 requires for its class.
- [ ] A cold start on `README.md` alone can advance the queue with no transcript.
- [ ] The before/after issue audit ran on **every** merge, with deltas explained.
