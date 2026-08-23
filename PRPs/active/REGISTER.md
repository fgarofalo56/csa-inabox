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
| **P0** | **#3916 — infra deploy path failing** | `deploy-integrity.md` R1 makes a broken deploy path preempt all feature work. Bicep merges may be landing **inert**. |
| **P1** | Security PRs #3890, #3900 | Live auth defects. Both `CONFLICTING` — they need a rebase before anything else can happen. |
| **P2** | Remediation wave (5 PRs under review) | Already built, already green; only review + treadmill stand between them and landing. |
| **P3** | Loom Brain #3933 (W1–W11) | New capability, high operator value, but not above a broken deploy or a live auth hole. |
| **P4** | 9 dependabot PRs | Lowest value, and each costs a full ~34-min cycle. **Batch last**, never interleaved. |

**Shipping rule I am applying:** never merge onto a red suite; never merge a PR whose
required checks were *hollow* for its own changed files; audit issue closures after every
merge (the close-parser is negation-blind — *"Does not close #N"* closes #N).

---

## 1. P0 — the infra deploy path (#3916)

**Measured:** `deploy-fiab-commercial` (scheduled daily) — `failure` 08-23, `success` 08-22,
`success` 08-21, `failure` 08-20, `success` 08-19. **Intermittent, not hard-down.**

**Failing step:** *"Resolve the hub DNS resolver's IMMUTABLE IP allocation method (#3786)"*

**The true error** (the `##[error]` line — the `ESC[36;1m` lines above it are echoed script
source, not execution):

    No target subscription, so the live DNS resolver inbound endpoint cannot be
    located. It comes from the topology guard's deploy_sub output; it is empty.

**Upstream cause:** `resolve-dlz-coordinates` exited **UNREADABLE (3)** — the Resource Graph
query itself failed, so whether this estate has a landing zone is **UNKNOWN, not "no"**. The
guard then correctly refused rather than deploying an empty adopt plan that would strip lake
env vars off the console. *The guard behaved correctly; its input was unavailable.*

**Likely root cause:** the deploy identity cannot read Resource Graph across all this
estate's subscriptions (Reader at the DLZ subscription is the named usual gap), **or**
Resource Graph throttled. The alternating pass/fail pattern points at throttling; the
permission gap would fail every time. **Not yet established — do not report either as the
cause until measured** (R7).

**Why it is P0 despite the estate looking healthy:** the app roll chain is separate and
working (live marker `e4dcfd72`, stamped 2026-08-23T18:10:20Z). So **apps deploy and infra
may not.** Any bicep merge in this window is potentially inert — which is precisely
`deploy-integrity.md` R2's "merged is not done".

**Directly gated by this:** PR #3923 (bicep) and PR #3927 (bicep/Gov lanes). Merging them
while this is broken produces a merge, not a deploy.

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
| W1 | Graph substrate | `lib/brain/graph/**`, `lib/brain/types.ts` | #3933 | in flight |
| W2 | Waste detectors | `lib/brain/detectors/**` | #3933 | in flight |
| W3 | Cost pipeline | `lib/brain/cost/**` | #3933 | in flight |
| W4 | Agent layer | `lib/brain/agents/**` | #3933 | in flight |
| W5 | **Visualizer** | `app/admin/brain/**` | #3933 | in flight |
| W6 | Security taxonomy | `docs/fiab/brain/security-taxonomy.md` | #3933 | in flight |
| W7 | Security detectors | `lib/brain/security/**` | #3933 | in flight |
| W8 | **Synapses view** | `app/admin/brain/synapses/**` | **#3934** | blocked on W5 (same directory — §8 conflict) |
| W9 | **Graph versioning** | `lib/brain/history/**` | **#3935** | not started |
| W10 | **Scheduler + lifecycle** | workflow, `lib/brain/run/**` | **#3936** | not started |
| W11 | **Gov parity** | Gov params + workflow | **#3937** | not started |

**W9 and W10 are the ones most likely to be quietly skipped, and both are load-bearing.**
Without W9 there is no history, so *"an edge that should not have formed"* is undetectable and
prune recommendations run off a single snapshot — which would recommend deleting a resource
that is merely mid-deploy. Without W10 the Brain never runs; `lcu-autopilot` is the standing
proof of that failure mode, having shipped a full read→decide→actuate loop with no scheduler.

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

