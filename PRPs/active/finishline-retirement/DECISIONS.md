# FINISHLINE operator queue — the answers

Companion to `OPERATOR-QUESTIONS.md`, which holds the questions. This page holds
what came back. `Refs #4495`.

---

## Provenance — read this before relying on anything below

**None of the decisions on this page has an artifact a reader can follow.**

On this repository an operator statement and an agent statement are
indistinguishable by author: both appear as `fgarofalo56`. Measured 2026-09-18
via the GitHub API — the comments on issue #4495 and on the pull request that
carried this work are bot comments plus comments under that one account, all of
them agent-posted. No comment, commit trailer, or file anywhere in this tree
records any of these decisions in the operator's own hand.

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

### OP-7 (and OP-9 item 6) · Esri GeoAnalytics license — DECLINED

> **Decision (2026-09-17):** no first-party Esri license. `geo-graph-ml`
> GEO-2/3/4 remain bring-your-own-license.

The program is archived, GEO-2 is sequenced last within it, and the design
already assumes a customer-supplied license. Nothing in the drain waits on this.

Kept distinct so it is not later mistaken for the same call:
`lib/editors/report/map-visual.tsx:28` records a **separate** decision that
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

At that ceiling the evaluator runs roughly **20–25M gpt-4.1 tokens/day**, which
makes this a cost-material opt-in. Under `auto-bind-by-default.md` § Allowed that
is permitted *only with disclosure* — it "must be listed in the gate registry
with that reason".

**Owed:** a gate-registry entry recording the cap, its cost, and that it is a
deliberate ceiling rather than an unreviewed default. That entry does not exist
today. Owed work, not a settled state.

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
(`FunctionExecutionCount` sum = 0 over 13 days); five are superseded by live ACA
replacements. PR #4564 carries the removal.

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
- **OP-19 (a)** · the duplicate timers. Measured on the live estate 2026-09-18:
  `func-secexp-k6mvh5sm6z7do/secretExpiryMonitor`,
  `func-cpeval-k6mvh5sm6z7do/copilotEvaluatorTimer` and `copilotEvaluatorHttp`
  all report `isDisabled=true` with `AzureWebJobs.<fn>.Disabled=true`. **This is
  an app setting applied out of band, not the work of #4564**, which is open and
  unmerged. The fragility is that these hosts sit OUTSIDE IaC — nothing in
  `platform/fiab/bicep` declares `func-secexp-*` or `func-cpeval-*` at all, so
  nothing re-asserts the disable and no gate would notice it being undone.

---

## A finding surfaced on the way, filed not fixed

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

---

## What to do with this page

When a further row is settled, record the decision where the code can see it —
the gate-registry entry for a cost-material opt-in, a workflow allowlist entry
for a parked lane — rather than only here. A decision that lives only in a
retirement doc is the same class of loss this queue was written to prevent.
