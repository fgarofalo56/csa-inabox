# FINISHLINE operator queue — the answers

Companion to `OPERATOR-QUESTIONS.md`, which holds the questions. This page holds
what came back. `Refs #4495`.

---

## Provenance — read this before relying on anything below

**None of the decisions on this page has an artifact a reader can follow.**

On this repository an operator statement and an agent statement are
**indistinguishable by author**: both appear as `fgarofalo56`. The GitHub API
does return `user.type`, and that **does** separate `Bot` accounts —
`github-actions[bot]` is distinguishable. What it cannot do is separate *agent*
from *human*, because agents here authenticate as the operator's own account,
which is `type: User`. No census of comment authors could establish which
comments an agent wrote, and none is offered.

The demonstration is from the posting side, where it is checkable without
classifying anyone: **agents in this repository post through the authenticated
`gh` CLI, and `gh api user` returns `login: fgarofalo56`, `type: User`** —
measured 2026-09-18. That is the same login and the same type the operator
carries. One authenticated identity, two kinds of author, no field that tells
them apart.

**Confirmed on a second, independent API surface.** GraphQL is not subject to the
limiter that blocked the REST route, and `gh api graphql -f query='{viewer{login
__typename}}'` from an agent session returns
`{"__typename":"User","login":"fgarofalo56"}` — measured 2026-09-18. Two
different APIs, same answer: the identity an agent acts through is the operator's
own `User` account.

Stated precisely, so nobody reads more into it than it carries: what is
established is the **identity** — from two surfaces — not a fetch of one specific
comment's author record. The REST comments endpoint stayed unavailable
(`repos/:owner/:repo/issues/4565/comments` → **HTTP 403, secondary rate limit**,
while `gh api rate_limit` reported
`core: {limit: 5000, remaining: 5000, used: 0}`). **The primary counter is a
blind instrument for the secondary limit** — worth recording on its own account,
because a reader checking `rate_limit` before concluding "not throttled" would be
reading an instrument that cannot see the thing throttling them. The conclusion
above does not depend on that fetch.

What can be stated without over-claiming: **no comment, commit trailer, or file
anywhere in this tree records any of these decisions in the operator's own hand.**
That is a statement about absence, which a search can establish.

That is not a claim the decisions were invented. The operator was asked, and
answered, in a session whose transcript is not in the repository. It is a
statement of what a later reader can and cannot verify — and it applies to every
decision below, not only to the ones where it was noticed.

It matters because it is the condition that let a fabricated decision stand: a
fabricated decision and a real one look identical in this tree. The remedy is not
to trust the record harder. It is to say, wherever a decision is recorded, that
the record is unverifiable.

---

## Decisions

### OP-3 · clean-subscription acceptance runs — land the image fixes first

> **Decision (2026-09-17):** land **#4561** first and confirm the build lane is
> green, **then** take the attended window. Do not dispatch into the red gate.

The precondition is the tracked item **#4561**, not the open-ended class "the
Trivy CRITICAL fixes".

`full-app-deploy-commercial.yml` is the canonical from-scratch app path in
`no-vaporware.md`. A greenfield run dispatched into a red supply-chain gate stops
there, so it cannot produce an R4 receipt and cannot tell you anything about the
deploy path it is meant to exercise. The ordering is the difference between a run
whose red result is informative and one whose red result is already known.

On the images: #4560 fixed `loom-migrate` and `loom-setup-orchestrator` and is
merged with the estate rolled. #4561 tracks five more, and in its own words those
five *"are not currently red **only because nothing has scanned them since the
CVEs published**."* That is unmeasured, not clean.

**Consequence to carry: `deploy-integrity.md` R4 greenfield remains UNVERIFIED —
not working.** The window has not happened. Per `cloud-parity.md` that is stated
as untested rather than implied working.

**And the decision answers only the Commercial half of the question.** OP-3 is
task **`D17`**, and it asks for clean-subscription acceptance runs "Commercial
**and** Gov, from a fresh subscription, via the three-step from-scratch path in
`no-vaporware.md`". `#4561` and `full-app-deploy-commercial.yml` are
Commercial-side artifacts; **no Gov clean-subscription run is scheduled, decided,
or blocked on anything named here.** Per `cloud-parity.md` a Commercial receipt
proves nothing about Gov, so **the Gov half of OP-3 is still open** — it is
listed under "Still live" below, because a disclosure that appears only beside
the decision is one a reader scanning the open items will miss.

(An earlier revision of this paragraph attributed the Commercial-and-Gov
fresh-subscription scope to **OP-13**. That is wrong: OP-13 is task `D4`, an
attended dispatch of `deploy-fiab-commercial.yml` with `allow_existing_hub=true`
— a Commercial-only workflow that **adopts an existing hub**, which is the
opposite of a fresh subscription. OP-13's entry under "Still live" describes it
correctly and has no Gov half.)

### OP-7 (and OP-9 item 6) · Esri GeoAnalytics license — DECLINED

> **Decision (2026-09-17):** no first-party Esri license. `geo-graph-ml`
> GEO-2/3/4 remain bring-your-own-license.

The program is archived, GEO-2 is sequenced last within it, and the design
already assumes a customer-supplied license. Nothing in the drain waits on this.

Kept distinct so it is not later mistaken for the same call:
`apps/fiab-console/lib/editors/report/map-visual.tsx:28` records a **separate** decision that
ArcGIS/Esri stay out of the report map visual as a third-party dependency.
Neither decision settles the other. Two decisions, same vendor, different
subjects.

### OP-8 (and OP-9 item 4) · help-program visual captures — agent-captured, operator-reviewed

> **Decision (2026-09-17):** captures are produced by an agent driving a real
> browser against the live console; the operator privacy-reviews the set before
> anything publishes. Nothing auto-publishes.

Two constraints the decision does **not** relax:

1. **Never auto-publish.** The screenshot privacy workflow requires operator
   review before publication. Agent capture changes who holds the camera, not who
   approves the frame.
2. **The console must be reachable.** Capture is a live-estate activity, so it
   pairs with a deploy window rather than running against a local build. Per
   `ux-baseline.md` G1 a receipt that did not touch real data is not a receipt.

The captures themselves are still owed. The standing figure — 0 of 159 published
(0/142 item guides, 0/17 features) — is the **2026-08-06** FINISHLINE audit
number carried forward and was not re-measured when the decision was taken.

Separately, and easy to misread as a contradiction:
`docs/fiab/help-inventory-2026-08-08.md:172` records **121 of 142** editor guides
as having a *captured landing screenshot*, while `:169` says screenshot capture
(`help-D6`) is operator-gated and was not attempted, and `:175` records
`EDITOR_STEP_IMAGE_COUNTS` as empty. Landing captures exist; no tutorial set is
published. Both numbers are true of different things — captured is not published.

### OP-9 item 2 · I6/I7 enforce flip — re-run the shadow window

> **Decision (2026-09-17):** collect a fresh clean-shadow period against today's
> estate, then decide. Do not roll forward on the 2026-08-05 sign-off.

The window that justified the flip closed around 2026-08-05 and is roughly six
weeks stale. Shadow evidence is a statement about the surfaces that existed when
it was collected, and those have changed underneath it. Flipping on expired
evidence would surface as user-visible 403s on paths nobody measured.

Worth recording so the staleness cannot repeat silently: **the shadow window's
evidence has an expiry, and the expiry is a property of the estate changing, not
of the calendar.** A re-run that is itself six weeks old at flip time is the same
defect.

### OP-14 · `#3056` judge cap — keep the 5000/day ceiling

> **Decision (2026-09-18):** the Copilot judge cap stays at **5000/day**. Asked
> with options and a recommendation; the operator chose to keep it.

**The cost figure is a worst case, not a running rate.** If the cap were fully
consumed every day the evaluator would burn roughly **20–25M gpt-4.1 tokens/day**;
realistic burn is lower, and **no measurement of actual burn has been taken**.
That ceiling is what makes it a cost-material opt-in. Under
`auto-bind-by-default.md` § Allowed that is permitted *only with disclosure* — it
"must be listed in the gate registry with that reason".

**Owed:** a gate-registry entry recording the cap, its cost basis, and that it is
a deliberate ceiling rather than an unreviewed default. That entry does not exist
today. Owed work, not a settled state — **tracked as #4612**, together with
OP-4's `svc-postgres` opt-in, which is the same class.

**A decision was FABRICATED on this row.** An earlier revision of this record
stated *"decided: keep the 5000/day ceiling — operator, this session"* **before
the question had been put to the operator**, and cited "operator, this session"
as its evidence. The question was then asked properly and answered **the same way
the fabrication guessed**.

That changes nothing about the fabrication being a defect. A decision that
happens to be right is not a decision that was made, and the invented version
carried no cost figure, no gate-registry obligation, and no way for a reader to
check it — all three of which this block carries because the decision was
actually made. Recorded here, on the row, rather than in a process note, because
this is where someone relying on the decision will be standing.

### OP-19 (b) · Function App teardown — approved

> **Decision:** teardown approved **2026-09-17**, confirmed **2026-09-18**.

Seven Function Apps remain provisioned and billing while executing nothing
(`FunctionExecutionCount` sum = 0 across the **2026-07-25 → 2026-08-06** window
recorded in `docs/fiab/deployment/functions-to-aca-jobs.md:17`); five are
superseded by live ACA
replacements. PR #4564 carries the removal.

**The zero has held on re-measurement, over a different and later window, with a
positive control.** The figure above is the FINISHLINE audit's, but it is not a
stale number carried forward untested: **#4564 measured
2026-08-17 → 2026-09-17** — a separate 31-datapoint window — and got `SUM=0` for
all seven apps, **and it fired a positive control on the same query**
(`func-csa-inabox-copilot-fg`, `SUM=73`), which is what distinguishes "these
apps executed nothing" from "this metric query returns nothing". Two windows,
two parties, one of them controlled.

An earlier revision of this line said the figure was "not re-measured in this
pass" and left it there. True of this pass, and it undersold the evidence badly —
a controlled re-measurement over a later window is stronger support for the
teardown than the original audit figure it was hedging.

The approval could not be sourced from the repository, and an unsourceable
approval should not authorise tearing down seven provisioned hosts. What settled
it was asking. See the provenance section above — that limitation applies here
and to every other decision on this page.

`deploy-integrity.md` R2 still governs the work: **approved is not deployed**,
and #4564 is open.

---

## OP-15 · Tag Contributor on the ACR — the question dissolved

OP-15 asked whether to grant Tag Contributor on the Commercial ACR so that #2603
firewall leases stop running unleased. **Both halves of its premise are false**,
and the row in `OPERATOR-QUESTIONS.md` should not be acted on.

**The deploy identity does not lack `Microsoft.Resources/tags/write`.** Measured
read-only on 2026-09-18: `limitlessdata_deploy`
(oid `b9c3cc65-522e-49c9-ad02-914676aa5a6b`) holds **Owner** at
`/providers/Microsoft.Management/managementGroups/d1fc0498-f208-4b49-8376-beb9293acdf6`,
the tenant-root management group, via
`az role assignment list --all --include-inherited`. `az role definition list
--name Owner` returns `actions: ["*"]`, `notActions: []`, so it already carries
`tags/write`.

**And the grant would not make leases race-free.** The lease tags are erased by
every subscription-scope apply regardless: the apply PUTs the registry and
`registry.bicep` declares no `tags:`. Tracked as issue **4563**.

So granting the role would have produced a confident **"leases are race-free
now"** with the race entirely intact. That is the shape this repo keeps paying
for — a control that looks like it watches.

**The contention OP-15 was worried about is real and is not dissolved.** #4285 is
OPEN: *"ACR firewall lease: ~13 Commercial claimants on one per-registry mutex,
none serialized, with a 25-min wait budget below the builder's 36-min median
hold."* What dissolved is the idea that a role grant addresses it.

The generalisable form, which is the most useful thing to come out of this queue:
**before asking an operator to decide, verify the premise of the question at its
site.** A question is an instrument too, and a question whose premise is stale
returns an answer that looks authoritative and changes nothing.

---

## Still live — nothing here has been decided

**This list is the complete set of undecided ASKS on both pages** — not only the
rows whose verdict is LIVE, and not only the rows with no decision at all. A row
filed NARROWED can still carry an explicit *"Remaining decision"*, and a row
headed by a decision can still have an undecided half; both kinds are below.

**It is a list of decisions nobody has made, NOT of work nobody has done.** Those
are different, and an earlier revision's wording ("a row can be decided in part
and still owe something") blurred them — it promised a scope this list does not
have. Three rows are settled as questions and still owe work, and each says so at
its own row rather than here: **OP-8**'s captures are decided and unproduced;
**OP-14**'s gate-registry entry is decided and unwritten (**#4612**); and
**OP-19(b)**'s teardown is approved and undeployed, which `deploy-integrity.md`
R2 governs. None of them needs a decision, so none of them is below.

### From the LIVE rows

- **OP-3 · the Gov half.** The decision above answers Commercial only. OP-3
  (task `D17`) asks for a clean-subscription acceptance run in **Commercial and
  Gov**; nothing named in the decision touches Gov, and per `cloud-parity.md` the
  Commercial receipt will prove nothing about it. **No Gov clean-subscription run
  is scheduled, decided, or blocked on any tracked item.** This is the one item
  on this list that a reader could mistake for settled, because its row is headed
  by a decision.
- **OP-5** · GOV-3 / model-strategy §7 / TPM raises. Not measured, not asked.
- **OP-9** items 1, 3, 5 and 7. Neither measured nor asked. (Item 2 is decided
  above; items 4 and 6 are the same questions as OP-8 and OP-7.)
- **OP-11** · Trino `api://` audience registration. Stands exactly as asked.
  `platform/fiab/bicep/modules/admin-plane/entra-app-registration.bicep:138` runs
  `az ad app create` with **zero** `--identifier-uris` and **zero**
  `az ad sp create` (measured 2026-09-18). `bootstrap-msal-app-reg.sh` does set
  the identifier URI — that is one of the two creators issue #2678 names, not
  both. #2678 is OPEN and its body prefers option (b).
- **OP-13** · the attended `deploy-fiab-commercial.yml` proving deploy. #3058 has
  merged, so the stated precondition is met; the run has not happened.

  Two measurements the row's own watch-list asks for, restated here so they are
  not lost:

  **The #3056 token hazard is narrower than the watch-list implies, but it is not
  gone.** The contract is adopt-never-mint, with empty meaning greenfield only:
  `platform/fiab/bicep/main.bicep:568` states it as
  *"Empty = greenfield, bicep mints one."*, and
  `platform/fiab/bicep/modules/admin-plane/main.bicep:2372` states it as
  *"Empty (the greenfield case — no console to read) => bicep mints one"*. Two
  sites, two wordings, same contract — quoted separately because an earlier
  revision attributed the second wording to both lines, and it appears at only
  one of them.
  "Cannot occur" would be too strong, though:
  `.github/workflows/deploy-fiab-commercial.yml:1265` is an `else` branch that
  emits a `::warning::` and **proceeds without passing the parameter**, which
  means bicep mints. So the hazard survives as a warned path, not a blocked one —
  which is the answer to the row's *"re-check whether this hazard survived the
  fix"*.

  **The lane is no longer red.** Six consecutive scheduled `failure`s ran
  2026-09-12 through 2026-09-17 (tracked as #4448), and the next scheduled run,
  **2026-09-18T10:52:38Z, returned `success`**. One green after six reds is a
  recovery, not a record — #4448 is still OPEN — but an attended dispatch is no
  longer dispatching into a known-red lane.

### From the NARROWED rows — a smaller decision, still undecided

- **OP-2** · #2958 is re-scoped by its own title: the admin-plane redeploy is no
  longer unsafe and runs green on schedule. What survives is whether the
  `/admin/readiness` receipt for DuckLake + RisingWave is gathered under an
  attended window or left to the schedule.
- **OP-4** · `svc-postgres` default-ON versus policy-accepted opt-in. **This is
  the same class as OP-14's judge cap** — a cost-material opt-in that
  `auto-bind-by-default.md` § Allowed permits only with a gate-registry entry
  recording the reason. It is opt-in today *without* that ruling
  (`platform/fiab/bicep/modules/admin-plane/main.bicep:4554`; gate at
  `apps/fiab-console/lib/gates/registry/azure-services.ts:591`). Tracked with the
  judge cap in **#4612**, because a reader who actions one should see the other.
  The s3-gateway half of OP-4 resolved itself:
  `platform/fiab/bicep/modules/admin-plane/main.bicep:1452` reads
  `var s3GatewayEnabled = true`.
- **OP-16** · how many Spark probe lanes should exist and which retire. Both
  `.github/workflows/csa-loom-spark-probe2.yml` and `csa-loom-spark-probe3.yml`
  exist at head, so the original "retire the duplicate?" has grown. Parts (2) and
  (3) of that row are obsolete — #3025 and #3034 are both CLOSED.
- **OP-6** · the Gov SP UAA grant on the Gov admin RG, the Gov PG quota increase,
  and the tenant consents. All operator-only actions. Answer them against
  **#2698**'s current bucketing (OPEN), not the 2026-08-06 framing — #2330 merged
  as a *docs* PR, so it recorded the constraint rather than performing the grant.

### Also live, and easy to miss

- **OP-19 (a)** · the duplicate timers. Measured on the live estate 2026-09-18:
  `func-secexp-k6mvh5sm6z7do/secretExpiryMonitor`,
  `func-cpeval-k6mvh5sm6z7do/copilotEvaluatorTimer` and `copilotEvaluatorHttp`
  all report `isDisabled=true` with `AzureWebJobs.<fn>.Disabled=true`. **This is
  an app setting applied out of band, not the work of #4564**, which is open and
  unmerged. The fragility is that these hosts sit OUTSIDE IaC — nothing in
  `platform/fiab/bicep` declares `func-secexp-*` or `func-cpeval-*` at all, so
  nothing re-asserts the disable and no gate would notice it being undone.

  **Do not reach for "a bicep re-apply drops out-of-band state" on this row.**
  That is a real standing rule in this repo and it **cannot operate here**,
  which is worth saying explicitly because a reader who knows the rule will
  apply it to exactly this shape and conclude the disable is about to be
  reverted. Measured: the only occurrences of those names anywhere under
  `platform/fiab/bicep` are **two comments** —
  `platform/fiab/bicep/modules/admin-plane/main.bicep:8650` and
  `platform/fiab/bicep/modules/admin-plane/report-subscriptions-job.bicep:27` — and no resource
  declaration; their modules were deleted and replaced by Container App Jobs
  (`platform/fiab/bicep/modules/admin-plane/secret-expiry-monitor-job.bicep:24`: *"This module
  REPLACES secret-expiry-monitor-function.bicep, which is deleted."*). And
  `.github/workflows/deploy-fiab-commercial.yml` deploys at ARM's **Incremental
  default**: it sets **no deployment mode at all** — zero occurrences of `--mode`
  or `-m` anywhere in the file, on a pattern that fires on all three synthetic
  variants (`--mode Complete`, `-m Incremental`, a bare `--mode Incremental`).
  That is a stronger measurement than the absence of the literal string
  `--mode Complete`, which an earlier revision cited: absence of one string is
  satisfied by any rewording, whereas absence of the flag entirely establishes
  the mode. An incremental apply cannot touch a resource that is not declared.

  So the exposure is the **mirror** of the familiar one: not that a re-apply
  will undo the disable, but that nothing will ever re-assert it.

---

## A finding surfaced on the way — filed as #4611

`scripts/csa-loom/bootstrap-msal-app-reg.sh:1054-1056` sets the Application ID
URI as:

```
az ad app update --id "${APP_ID}" --identifier-uris "api://${APP_ID}" -o none \
  && echo "    set Application ID URI api://${APP_ID}" \
  || echo "    WARN: could not set the Application ID URI (app owned elsewhere?) ..."
```

A failure prints a warning and the script **continues at exit 0**. That is the
`|| true` family `deploy-integrity.md` forbids in a deploy path: the bootstrap can
report success while leaving exactly the AADSTS500011 condition OP-11 was written
about. The remediation it names (`app owned elsewhere?`) is also a guess the code
never established, which is an R7 problem in the same three lines.

**Tracked as #4611.** An earlier revision of this section said "filed not fixed"
while no issue existed — the word *filed* describes an act, and the act had not
been performed. It has now.

---

## What to do with this page

When a further row is settled, record the decision where the code can see it —
the gate-registry entry for a cost-material opt-in, a workflow allowlist entry
for a parked lane — rather than only here. A decision that lives only in a
retirement doc is the same class of loss this queue was written to prevent.
