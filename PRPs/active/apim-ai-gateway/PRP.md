# PRP — APIM AI Gateway as the day-one path for every Loom AI endpoint

**Status:** DRAFT (2026-09-10; corrected 2026-09-11) — design unblocked; no wave
started. One question re-opened (Q5) — see §2.
**Issue:** #4442 (`epic`, `sprint:active`, `sp:13`, `lane:bicep`, `lane:console`)
**Created:** 2026-09-10 · **Owner:** autonomous build program
**Related rules:** `auto-bind-by-default.md`, `cloud-parity.md`,
`deploy-integrity.md`, `no-vaporware.md`, `no-fabric-dependency.md`,
`ux-baseline.md` · **Memory:** `loom_default_on_opt_out`,
`csa_loom_region_availability_is_not_audit_scope`,
`csa_loom_the_loom_estate_is_in_dmlz_not_the_default_subscription`
**Predecessor:** `PRPs/completed/model-strategy/PRP.md` (Waves M1–M6 built the
gateway this epic turns on).

> **Read §0 before executing any wave.** A lane executes a PRP verbatim, so a
> wrong premise here becomes wrong code. §0 records the premises that were wrong
> in the 2026-09-10 draft and in #4442's research section, and what replaced
> them.

---

## 0. Corrections to the 2026-09-10 draft (re-measured 2026-09-11 at head)

Every row below was re-measured in-tree or against a live Azure/Learn instrument
on 2026-09-11. Where a measurement came from the live estate it names the
subscription, because the Loom estate is in **DMLZ**
(`e093f4fd-5047-4ee4-968d-a56942c665f3`), not the workstation's default
subscription — the default answers plausibly and wrongly.

| # | The draft (and #4442) said | Measured truth | Where it lands |
|---|---|---|---|
| C1 | `apimSku` / `apimSkuName` "default to `Developer`"; Wave C flips that | `apimSku` (`platform/fiab/bicep/main.bicep:64`) has **no default** and `@allowed(['PremiumV2','Premium'])` — `Developer` is not a legal value. `apimSkuName` (`:922`) is a **deploy-planner cost-estimator knob**, consumed by no `.bicep` at all. | §2 Q1, Wave C |
| C2 | Nothing stated which SKU each boundary runs | **Every** param file already sets `apimSku`: Premium classic in Gov, PremiumV2 in Commercial/GCC/DMLZ. The live estate is PremiumV2. | §2 Q1, §3, Wave C |
| C3 | "v2 … leaves the gateway, management plane and developer portal publicly reachable" as a property of **v2** | True of **VNet integration** (Standard v2 and Premium v2). **Premium v2 also supports VNet injection** for complete inbound+outbound isolation — and the live PremiumV2 estate is `Internal`. | §2 |
| C4 | "No availability zones and no multi-region" as a property of **v2** | **Premium v2 has availability zones.** Multi-region genuinely is on the v2 "currently unavailable features" list. Half right. | §2 |
| C5 | `llm-content-safety` at the gateway in all boundaries (Q3, Waves D/E) | Azure AI Content Safety is **not in DoD IL4/IL5/IL6 audit scope**, and the policy hard-requires a Content Safety resource. **IL5 cannot run this policy.** | §2 Q3, §3.4, Wave D/E |
| C6 | `llm-token-limit` "built, opt-in" with no boundary qualifier | `apim.bicep:423` `aoaiLlmPoliciesSupported = !isSovereign` — the LLM policies are **not authored in GCC-High or IL5 today**. Now tracked independently of this PRP as **#4460**. | §3.2, Wave B2, Wave D |
| C11 | "at IL5 neither layer is Content Safety" *(added 2026-09-11, wrong)* | **False.** `il5.bicepparam:178` → `admin-plane/main.bicep:2077` → `:3665` → `:6224`: the stock IL5 deploy falls back to the AIServices `/contentsafety` data plane, so IL5 **does** screen. | §3.4.1, Wave 0 task 5 |
| C13 | C11's replacement then over-asserted: the exposure stated as **fact**, owned **here**, and "which no other artifact closes" | All three wrong. #4459 (merged 2026-09-11) records it at `il5.bicepparam:378-390` as **UNDETERMINED**, owned by **#4458** — settling it "needs a compliance determination, not a code read". One owner, one confidence level; this PRP now consumes rather than competes. | §3.4.1, risks |
| C14 | The `il5.bicepparam` comment "uses the wrong instrument… tracked separately" | **Stale — #4459 fixed it.** `:347-361` now argues from audit scope and quotes the same table rows with the same positive control. Also `contentSafetyEnabled` moved `:351` → `:412`. | §3.4, §2.1 |
| C15 | Wave 0 task 5 gated task 1 but demanded "an in-boundary Actions run" | **Circular** — IL5 has zero runs and task 1 would produce the first. Task 5 now has per-task acceptance satisfiable **entirely outside the boundary**. | Wave 0 |
| C16 | `llm-emit-token-metric` "boundary-portable… IL5 keeps it in full", because it "is not a Content Safety dependency" | **Non sequitur on no measurement.** `aoaiLlmPoliciesSupported` gates the `llm-*` family, not Content Safety, and `llm-emit-token-metric` is in that family. Measured: **zero** occurrences in `apim.bicep` and under `platform/`. Now UNVERIFIED, folded into Wave 0 task 2. | Wave E, §3.4 |
| C12 | Wave B defaulted the gateway ON in all six param files at once | B before D would route GCC-High and IL5 through a gateway with **no spend control** (C6), and B's Commercial-only receipt would not surface it. | Wave B split into **B1 / B2** |
| C7 | GCC absent from the boundary list | `apim.bicep:18` allows `'GCC'` and `gcc.bicepparam:131` sets the SKU. GCC is in scope — and is **supported-in-code, never exercised**. | §2.1, §5 |
| C8 | Wave acceptance was `build-params` / what-if / cost-delta only | No wave carried a deploy receipt. `deploy-integrity.md` R2: merged is never done. | every wave |
| C9 | The Gov prerequisite check was a Verification/Risks bullet | #4442 states it "gates the rest. It should be the first task". | **Wave 0** |
| C10 | The `azure-api.net` measurement had no command | Now carries the exact `az` invocations, with `--subscription`. | §3.5 |

---

## 1. Goal (operator intent, 2026-09-10)

> "Have Loom integrate directly with APIM for its AI endpoints so it's not tied to
> one Foundry endpoint, but can leverage all AI services and endpoints through
> APIM via an AI Gateway. Make sure the deployment scripts and configuration
> settings cover all things day-one Loom deploy."

**This is not greenfield.** Model-strategy Wave M4 already authored a real GenAI
gateway and deliberately left it OFF "pending operator confirmation of the
APIM-vs-direct direction". #4442 IS that confirmation. The work is to widen the
pool, turn it on, extend it to the other three service families, and make it
deploy day-one in every boundary.

### What "done" means

1. A fresh `az deployment` in **any** supported boundary stands the AI gateway up
   and routes Loom's AI traffic through it, with **no operator action** — the
   platform provisions and binds it (`auto-bind-by-default.md`). "Set
   `LOOM_AOAI_APIM_URL`" as a terminal user-facing state is a defect.
2. The backend pool accepts **N endpoints**, priority-ordered, PTU-primary with
   pay-go spillover, including operator-supplied BYO — not one endpoint derived
   from a single Foundry account.
3. All four service families route through the gateway (§2, Q3) — with the IL5
   content-safety substitution of §3.4 applied, not silently dropped.
4. **Every supported boundary gets the same capability**, or the gap is declared
   with an owner and a date (`cloud-parity.md`). Three gaps are declared, each
   with an owner, a date and a **substitute** — because `cloud-parity.md` §3
   makes "that Azure service isn't in Gov" the START of the design problem:
   semantic cache in Gov (Q4), `llm-content-safety` at the gateway at IL5
   (Q3 / §3.4), and the sovereign LLM-policy exclusion (§3.2 — **#4460**).
   **A gap recorded only in this file is not tracked**, which is why #4460 was
   filed independently: it outlives this PR either way. Q4 and the gateway
   content-safety gap are owned here because they are design decisions this epic
   makes; #4460 is a pre-existing tree defect this epic merely found.

   Distinct from all three, and **not owned here**: whether IL5's *existing*
   `/contentsafety` fallback is itself in audit scope (§3.4.1). That is an open
   compliance determination owned by **#4458**; this PRP consumes its answer and
   deliberately does not assert one.
5. Greenfield **and** brownfield, Commercial **and** sovereign, each with its own
   receipt (`deploy-integrity.md` R4/R5). A boundary with no receipt is named as
   unexercised, never implied working.
6. **Every wave's acceptance includes a deploy receipt** — a workflow run whose
   deploy job executed steps — not only `az bicep build-params` and what-if.
   `build-params` proves the template compiles; it proves nothing about whether
   it deploys (`deploy-integrity.md` R2, `cloud-parity.md`
   § Supported-in-code is not ever-exercised).

---

## 2. Decisions already recorded — DO NOT RE-ASK

From #4442's decision comments (2026-09-10). Each is the operator's. Q1's
*rationale* is corrected below against the measured tree; its *intent* — never
give up the private posture, the AZ redundancy, or the Gov story to save money —
is untouched and still governs.

| # | Question | Decision |
|---|---|---|
| Q1 | APIM tier | **Never Standard v2.** Premium-family only. Already satisfied in-tree per boundary — see "What the tree actually runs" below. Q5 is the one piece left open. |
| Q2 | Endpoint scope | **Multi-Azure endpoints** — N Foundry/AOAI accounts across regions/subscriptions in one priority-ordered pool, plus BYO. **Multi-vendor (Anthropic/Vertex) explicitly OUT of scope.** |
| Q3 | Service breadth | **All four** — LLM inference, AI Search, Document Intelligence / Speech / Vision, and `llm-content-safety` at the gateway **in every boundary whose impact level authorizes Azure AI Content Safety**. IL5 does not; §3.4 states what IL5 runs instead. |
| Q4 | Semantic cache in Gov | **Find a Gov-capable equivalent.** Do not ship a Commercial-only cache. Path: build on the existing `redisOss` app. |
| **Q5** | **OPEN (2026-09-11)** | **Commercial/GCC/DMLZ are on PremiumV2, not Premium classic. Leave them, or migrate?** Recommendation + options below. Wave C does not start until this is answered. |

### 2.1 Supported boundaries

`apim.bicep:18` — `@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])`. Four, not
three. GCC was missing from the 2026-09-10 draft entirely.

| Boundary | `apimSku` | Deploy receipt (measured 2026-09-11) |
|---|---|---|
| Commercial | `PremiumV2` (`commercial.bicepparam:107`, `commercial-full.bicepparam:17`) | **exercised** — the live DMLZ estate, §3.5 |
| DMLZ (the live estate) | `PremiumV2` (`tenant-dmlz.bicepparam:54`) | **exercised** |
| GCC | `PremiumV2` (`gcc.bicepparam:131`) | **supported-in-code, NEVER exercised** — 0 runs have ever executed a deploy step; lane `disabled_manually`; last run 2026-08-08. Recorded decision: `cloud-parity.md` § Measured example — GCC, and `PRPs/active/drain-2026-08-31/DECISIONS.md` § "#4071 + #3078". |
| GCC-High | `Premium` (`gcc-high.bicepparam:125`) | **exercised** — run 33519232492 (2026-09-01), job `Deploy + validate CSA Loom in GCC-High` = `failure`, **steps=33**. A failing deploy job that ran IS a receipt. The last receipt is dated 2026-09-01, but the lane is **live and one click from a fresh one**: **14 of the last 30 runs are `status=waiting`** (2026-08-27 → 2026-09-10), **9 of them created after that receipt**, all parked on the `gcc-high-deploy` **environment approval gate** (`waitTimer=0`, `current_user_can_approve=true`) with the deploy job at `steps=0` **because it has not started**. That is NOT the GCC skipped-at-zero shape — an approval yields a receipt. |
| IL5 | `Premium` (`il5.bicepparam:123`) | **supported-in-code, NEVER exercised** — `gh run list --workflow deploy-fiab-il5.yml` returns `[]`. Zero runs, ever. Watched by `scripts/ci/check-deploy-staleness.mjs`. |

`dlz-attach.bicepparam` is **not** a boundary. It is `using
'../modules/landing-zone/main.bicep'` (`:33`) — a spoke Data Landing Zone
deploy that never reaches the admin-plane template and declares no APIM params.
Any wave globbing `params/*.bicepparam` must exclude it by name, not by luck.

### 2.2 What the tree actually runs — and why Q1 is already satisfied

`apimSku` (`platform/fiab/bicep/main.bicep:62-64`) is:

```bicep
@description('APIM SKU — PremiumV2 (Commercial/GCC) or Premium (Gov)')
@allowed(['PremiumV2', 'Premium'])
param apimSku string
```

**No default, and `Developer` is not an allowed value.** It is passed to the
admin-plane at `main.bicep:1270` and reaches `apim.bicep:21-23`, whose header
(`:8-10`) states the contract: "PremiumV2 in Commercial/GCC; classic Premium in
Gov boundaries (PremiumV2 Gov-GA pending). Both support VNet integration."

`apimSkuName` (`platform/fiab/bicep/main.bicep:919-922`, default `'Developer'`)
is a **different thing that happens to be spelled similarly**. Measured: across
all 374 tracked `.bicep` / `.bicepparam` files it appears exactly once — its own
declaration. Its only consumers are the console cost estimator
(`apps/fiab-console/lib/components/deploy-planner/service-catalog.ts:454`) and
the generated planner template
(`apps/fiab-console/deploy-templates/main.json:1638`). Zero hits in `.github/`,
`scripts/`, or `docs/`. **It is a cost-estimator knob end to end, and no
deployment has ever been sized by it.**

So: **nothing, in any boundary, deploys APIM on `Developer`.** The premise that
Q1 exists to move Loom off `Developer` is false, and it originates in #4442's
research section ("Loom's current default (`main.bicep:922 apimSkuName =
'Developer'`)"), which read the planner knob as the deployment SKU.

### 2.3 Why Standard v2 was withdrawn — re-grounded, per ground and per tier

The conclusion (never Standard v2) survives. Two of the three stated grounds were
over-generalized from Standard v2 to all of v2, and one instrument was wrong.

**Which instrument answers which question.** These are not interchangeable, and
conflating them is the trap recorded in
`csa_loom_region_availability_is_not_audit_scope`:

- *"Is the service authorized at this impact level?"* → **Azure Government
  services by FedRAMP and DoD CC SRG audit scope**
  (`learn.microsoft.com/azure/azure-government/compliance/azure-services-in-fedramp-auditscope`,
  Azure Government table; `ms.date` 2026-02-25, fetched 2026-09-11).
- *"Does this **tier** exist in this boundary's regions?"* → **Availability of v2
  tiers and workspace gateways**
  (`learn.microsoft.com/azure/api-management/api-management-region-availability`,
  `ms.date` 2026-08-26, page footer "Last updated on 2026-08-27").

The audit-scope table carries a **single `API Management` row** with no tier
breakdown. It therefore **cannot** settle the v2 question — only the availability
page can. Conversely the availability page cannot settle authorization. Both are
needed; the draft cited only the second and called it a `cloud-parity.md`
argument.

| Ground (as drafted) | Standard v2 | Premium v2 | Verdict |
|---|---|---|---|
| 1. No Gov regions | true | true | **Holds, and is dispositive on its own.** The v2 availability table contains zero occurrences of `USGov`, `US Gov`, or `Government` (measured 2026-09-11: 0/0/0). |
| 2. Cannot reproduce Loom's private posture | true | **false** | Learn: "Standard v2 and Premium v2 support virtual network integration… The API Management gateway, management plane, and developer portal remain publicly accessible" — **then** "Premium v2 *also* supports simplified virtual network injection for complete isolation of inbound and outbound gateway traffic". |
| 3. No AZ, no multi-region | true | **AZ: false. Multi-region: true.** | Learn lists "availability zones (zone redundancy)" as a Premium v2 enterprise feature, and lists "Multi-region deployment" under v2 "Currently unavailable features". |

The live estate settles ground 2 empirically. Measured 2026-09-11 in the DMLZ
subscription:

```
apim-csa-loom-centralus | sku=PremiumV2 | capacity=1 | virtualNetworkType=Internal
                        | provisioningState=Succeeded | location=Central US
```

`apim.bicep:363-364` already records the same thing in a comment. A PremiumV2
instance is running `Internal` today — "v2 cannot be private" is false as a
general claim about v2.

**What this changes and does not change.** It does not resurrect Standard v2:
ground 1 alone disqualifies it, and Standard v2 has no AZ. It does mean the
Commercial choice is genuinely between **PremiumV2** (what is deployed) and
**Premium classic** (what Gov deploys), and the only property separating them for
our purposes is multi-region. That is Q5.

### 2.4 Q5 — OPEN. Commercial/GCC/DMLZ: stay on PremiumV2, or migrate to Premium classic?

Q1's decision text asserted "Zero networking rework… no estate migration",
believing the alternative was `Developer`. Against the real tree that assertion
only holds **if Commercial stays on PremiumV2**. Applying Premium classic to
Commercial is a live-estate migration, measured:

- Learn, v2 tiers FAQ: "Q: Can I migrate from my existing API Management instance
  to a new v2 tier instance? **A: No.** Currently, there's no automated tooling to
  migrate an existing API Management instance (in the Consumption, Developer,
  Basic, Standard, or Premium tier) to a new v2 tier instance."
- The v2 "Currently unavailable features" list includes **"Upgrade to v2 tiers
  from classic tiers"** and **"Resource move operation"**.
- There is no in-place conversion in either direction between the classic and v2
  families. A classic target means **standing up a second APIM alongside** —
  which, per §3.5 consequence 3, is unreachable in-VNet until it owns its own
  `azure-api.net` A record, and requires repointing `LOOM_AOAI_APIM_URL`.
- Operational note, measured 2026-09-11: the v2 availability table marks
  **Central US Premium v2 with ⚠️ ¹ = "New instance creation temporarily
  unavailable"**, with "Existing instances aren't affected." The live instance is
  safe; a *new* Central US PremiumV2 may not be creatable right now. This cuts
  both ways and belongs in the Q5 decision.

**Recommendation: stay on PremiumV2 in Commercial/GCC/DMLZ; keep Premium classic
in GCC-High/IL5.** It is the deployed state, it is private (measured), it has AZ,
it needs no migration and no new DNS record, and it preserves exactly the
posture the operator's Q1 was protecting. The cost is classic multi-region, which
Loom does not use today — there is one APIM instance in one region.

**Option B** — migrate Commercial to Premium classic for multi-region. Buys
multi-region at the price of a stand-up-alongside cutover (new instance, new A
record, move APIs/backends/policies, repoint the console, retire the old), proven
greenfield **and** brownfield per R4/R5.

**Option C** — stay on PremiumV2 now, and treat multi-region as its own dated
epic once the gateway carries real traffic and the need is evidenced.

Wave C is blocked on this answer. Do not guess it.

---

## 3. Measured current state (re-verified in-tree 2026-09-11, not carried)

### 3.1 Already built — Wave M4

| Capability | Where | State |
|---|---|---|
| Per-endpoint backends + circuit breaker (429/5xx, honours `Retry-After`) | `apim.bicep:431-461` | built, authored in ALL boundaries (backend *properties*, not policies) |
| Load-balanced backend **pool**, priority LB | `apim.bicep:462-480` | built, all boundaries |
| `llm-token-limit` (per-consumer TPM) | `apim.bicep:506-508` | built, opt-in, **Commercial + GCC only** — see §3.2, #4460 |
| `llm-semantic-cache-lookup` / `-store` | `apim.bicep:509-514` | built, opt-in, **Commercial + GCC only**; needs external Redis + embeddings |
| Managed-identity auth to backends (keyless) | `apim.bicep:66-67`, audience switched per cloud at `:429` | built, all boundaries |
| Console routing switch + graceful fallback | `LOOM_AOAI_VIA_APIM`, `LOOM_AOAI_APIM_URL` | built |
| Brownfield adopt of an existing APIM | `main.bicep:624-626`, `adoptMode(adopt,'apim')` | built |
| `llm-content-safety` | — | **not present in `apim.bicep` at all.** Zero occurrences. Wave D/E is new work, not a flag flip. |

### 3.2 Undeclared parity gap — the LLM policies skip every sovereign boundary

```bicep
// apim.bicep:202
var isSovereign = boundary == 'GCC-High' || boundary == 'IL5'
// apim.bicep:423
var aoaiLlmPoliciesSupported = !isSovereign
```

`aoaiTokenLimitPolicy`, `aoaiSemanticLookup` and `aoaiSemanticStore`
(`apim.bicep:506-514`) each resolve to the **empty string** when
`aoaiLlmPoliciesSupported` is false, so in GCC-High and IL5 the authored policy
XML carries only `authentication-managed-identity` + `set-backend-service`. Note
`isSovereign` excludes GCC — GCC gets the full policy set.

The in-code rationale (`apim.bicep:416-422`) is honest about *why* ("may be
ABSENT in sovereign Azure Government APIM") but it is an **assumption recorded as
a fact**, and it is unqualified: it disables token limiting, which is the
gateway's only spend control, across two boundaries. Under `cloud-parity.md` this
is either a gap that must be declared with an owner and a date, or a limitation
that must be *measured* and then removed. **Wave 0 task 2 measures it** — the LLM
policies' tier support (`Developer | Basic | Basic v2 | Standard | Standard v2 |
Premium | Premium v2`) includes Premium classic, so the open question is
availability in Gov APIM, not tier.

**Tracked as #4460**, filed 2026-09-11 so this gap survives independently of
whether this PRP merges. Before that issue existed the gap was recorded **only**
inside this unmerged draft — which is not tracking. #4460 owns the measurement,
the readiness row, and the substitute-if-absent decision; this PRP consumes its
answer in Wave B2 and Wave D.

It also gates more than token limiting: `aoaiSemanticCacheEnabled` is ANDed with
`aoaiLlmPoliciesSupported` (`apim.bicep:509/512`), so a fully provisioned Gov
RediSearch cache would still author nothing — Q4's whole point defeated by a flag
it never mentions. Wave F must check this, not assume it.

### 3.3 The pool gap — verified at the line

```bicep
// platform/fiab/bicep/modules/admin-plane/main.bicep:2084
var aoaiApimBackendEndpoints =
  (apimEnabled && empty(existingApimName) && aoaiApimGatewayEnabled && !empty(loomAoaiEndpointValue))
    ? [ loomAoaiEndpointValue ] : []
```

The pool **supports N and is passed exactly one**, derived from a single account
(`loomAoaiEndpointValue`, `:2083`). This is literally "tied to one Foundry
endpoint". It is consumed at `:3783` (`aoaiBackendEndpoints:`) by the `apim`
module invoked at `:3763`.

Both switches are OFF
(`platform/fiab/bicep/modules/admin-plane/main.bicep:2591-2592`, inside
`loomBackends` to stay under the ARM 256-param ceiling):

```bicep
aoaiGateway: ''      // 'apim' AUTHORS the gateway
aoaiViaApim: ''      // 'true' ROUTES console traffic through it
```

**They are deliberately separable** so the gateway can be deployed and
smoke-tested before live traffic is flipped. **Preserve that property** — do not
collapse them into one flag.

`redisOss: 'enabled'` is already in the same `loomBackends` object
(`admin-plane/main.bicep:2578`), which is the foundation for Q4; the comment
above it (`:2573-2577`) records that Azure Managed Redis is Azure Public only
with no announced Government date.

Also un-parameterized end to end: **APIM capacity.** `apim.bicep:28` declares
`param capacity int = 1`; the admin-plane invocation at `:3763-3786` never passes
it; no `.bicepparam` sets it. The live estate confirms `capacity=1`. One unit is
about to become the single path for all Loom AI traffic.

### 3.4 IL5 cannot run `llm-content-safety` — declared gap, with a substitute

**The measurement.** Azure Government services by FedRAMP and DoD CC SRG audit
scope, Azure Government table (fetched 2026-09-11; the table's own legend defines
`DoD IL5WI = DoD SRG Impact Level 5 Workload Isolation Provisional Authorization
in Azure Government`):

| Service | FedRAMP High | DoD IL2 | DoD IL4 | DoD IL5WI | DoD IL6 |
|---|---|---|---|---|---|
| **Foundry: Azure AI Content Safety** | ✅ | ✅ | — | — | — |
| Azure OpenAI | ✅ | ✅ | ✅ | ✅ | ✅ |
| API Management | ✅ | ✅ | ✅ | ✅ | ✅ |
| Foundry: Azure AI Search | ✅ | ✅ | ✅ | ✅ | ✅ |
| Document Intelligence | ✅ | ✅ | ✅ | ✅ | — |
| Foundry: Speech | ✅ | ✅ | ✅ | ✅ | — |
| Foundry: Azure AI Computer Vision | ✅ | ✅ | ✅ | ✅ | — |
| Azure Cache for Redis | ✅ | ✅ | ✅ | ✅ | ✅ |

**The blanks are data, not missing data.** Azure OpenAI and API Management are the
positive controls: both carry ✅ through IL6 in the same table, from the same
fetch. So a blank at IL4/IL5/IL6 on the Content Safety row is a real absence.

**Do not reason about this from the region matrix.** GCC-High and IL5 are **both**
`usgovvirginia` (`gcc-high.bicepparam:109`, `il5.bicepparam:106`), so region
cannot distinguish them; the axis is **impact level**.

This is now recorded in the tree as well, and this PRP defers to it rather than
restating it: **#4459 (merged 2026-09-11) rewrote the `il5.bicepparam` comment**
to argue from audit scope instead of region. `il5.bicepparam:347-356` states the
axis explicitly ("REGION AVAILABILITY IS NOT AUDIT SCOPE") and records that the
param was briefly flipped to `true` on 2026-09-10 on exactly the wrong argument;
`:357-362` carries the same table rows measured here, with Azure OpenAI at `:362` as the
same positive control. An earlier revision of this PRP said that comment used the
wrong instrument and was "tracked separately" — **that is stale; #4459 fixed it.**

**The policy is hard-dependent on the resource.** Learn, `llm-content-safety`
policy reference, Prerequisites: "**An Azure AI Content Safety resource.** An API
Management backend configured to route content safety API calls and authenticate
to the Azure AI Content Safety service… The Azure AI Content Safety backend URL,
referenced by `backend-id`… needs to be in the form
`https://<content-safety-service-name>.cognitiveservices.azure.com`." There is no
resource-free mode. **IL5 cannot author this policy.**

**Boundary-by-boundary verdict:**

| Boundary | `llm-content-safety` at the gateway | Basis |
|---|---|---|
| Commercial / DMLZ | ✅ build it | `commercial.bicepparam:135`, `commercial-full.bicepparam:308`, `tenant-dmlz.bicepparam:283` all `contentSafetyEnabled = true` |
| GCC | ✅ build it | `gcc.bicepparam:157` = `true` |
| GCC-High | ⚠️ **conditional** | Content Safety is ✅ at **FedRAMP High** and blank at **DoD IL4**. `gcc-high.bicepparam:377` = `true`, correct for a FedRAMP-High-scoped workload. A GCC-High tenant accrediting at DoD IL4 must fall back to the IL5 substitute. The gateway must therefore key on `contentSafetyEnabled`, never on `boundary == 'IL5'`. |
| IL5 | ❌ **declared gap** | `il5.bicepparam:412` = `false` (line moved by #4459; was `:351`); audit scope blank at IL5. The reasoning is now in-tree at `:347-361`. |

**The substitute IL5 runs instead** (`cloud-parity.md` §3 — supply the
Azure-native equivalent, do not drop the capability):

Moderation moves from the gateway to the **model deployment**. Azure OpenAI's
built-in Responsible AI content filters are on by default for every deployment —
Learn, content filtering: "Models deployed to Microsoft Foundry… include **default
safety settings applied to all models**, excluding Azure OpenAI Whisper. These
configurations provide you with a responsible experience by default." They are
present in Azure Government: Learn's modified-content-filter path names a
Gov-specific route — "For **Azure Government** customers, apply for modified
content filters via this form: *Azure Government - Request Modified Content
Filtering for Azure OpenAI in Foundry Models*" — i.e. in Gov you must apply to
*weaken* the filters, which only makes sense if they are on. And Azure OpenAI is
✅ through IL6 in audit scope.

So at IL5 the gateway authors pool + circuit breaker — **not** `llm-token-limit`
(unauthored in both sovereign boundaries today, §3.2 / #4460), and **not
necessarily** `llm-emit-token-metric` either (Wave E, **unverified in Gov** — it
is an `llm-*` policy from the same family the `!isSovereign` flag excludes) — and
**the AOAI deployment's content filter is the
audit-scope-clean layer that should own the moderation verdict**. This is a
*different layer*, not a missing capability — and it must be stated that way on
the readiness surface, per boundary, so no operator reads "no gateway content
safety" as "no content filtering". Silence here would be the `no-vaporware.md`
failure in reverse: an unstated protection.

#### 3.4.1 What IL5 screens with TODAY — and the open audit-scope question it raises

The sentence above says what IL5 *should* run. It is not what the stock IL5
deploy wires today, and the difference is the whole point of this subsection.
Traced at head:

```bicep
// il5.bicepparam:178
param agentFoundryEnabled = true
// il5.bicepparam:346
param aiFoundryEnabled = false

// platform/fiab/bicep/main.bicep:606
func adoptMode(a object, k string) string => a[?k].?mode ?? 'create'
// platform/fiab/bicep/main.bicep:700
var provisionAgentFoundry = agentFoundryEnabled && adoptMode(adopt, 'foundry') == 'create'

// admin-plane/main.bicep:2077
var agentFoundryCreate = agentFoundryEnabled && provisionAgentFoundry
// admin-plane/main.bicep:3665
var loomAiEnrichEndpoint = agentFoundryCreate
  ? agentFoundry!.outputs.aiServicesEndpoint
  : ((aiFoundryEnabled && empty(existingFoundryAccountName)) ? aiFoundry!.outputs.aiServicesEndpoint : '')

// admin-plane/main.bicep:6224
{ name: 'LOOM_CONTENT_SAFETY_ENDPOINT', value: contentSafetyEnabled ? contentSafety!.outputs.endpoint : loomAiEnrichEndpoint }
```

`adoptMode` defaults an absent key to `'create'`, so on a stock IL5 deploy
`agentFoundryCreate` is **true** and `LOOM_CONTENT_SAFETY_ENDPOINT` falls back to
the multi-service AIServices endpoint. **The stock IL5 deploy therefore DOES
screen prompts, via the `/contentsafety` data plane on the AIServices account** —
even though `contentSafetyEnabled = false`. `admin-plane/main.bicep:170`
documents this fallback as the intended design.

**This corrects an earlier claim in this PRP that "at IL5 neither layer is
Content Safety". That was false.** IL5 does reach a Content Safety surface.

**The question that follows — OPEN, owned by #4458, NOT settled here.** The
audit-scope table enumerates AI capabilities **per capability, not per account
kind**: there is no generic "Azure AI Services (multi-service)" row that would
authorize the `/contentsafety` data plane. The only row covering it is `Foundry:
Azure AI Content Safety`, **blank at IL4 / IL5WI / IL6**. Hosting the call on a
multi-service account does not change which capability is being exercised. So the
stock IL5 deploy **may** carry the same exposure that makes
`contentSafetyEnabled = true` a violation at IL5 — while reading as the
reassuring state.

**It is stated as *may*, not *does*, and that is deliberate.** An earlier
revision of this PRP asserted it as fact and claimed this PRP owned it. Both were
wrong:

- **Settling it needs a compliance determination, not a code read.** The table's
  silence about account kinds is evidence, not proof; whether a capability hosted
  on an authorized multi-service account inherits that account's authorization is
  an accreditation question this PRP cannot answer by reading Learn.
- **The tree already records it, with that same confidence level.**
  `il5.bicepparam:378-390` (merged in #4459) says in terms: "WHETHER THAT DEFAULT
  PATH IS ITSELF IN SCOPE IS UNDETERMINED, and is carried on #4458 rather than
  settled here… this comment claims only that the prompt IS screened — NOT that
  the screening is authorized at IL5."

**One owner, one confidence level: #4458, undetermined.** Two artifacts asserting
different confidence about one compliance question is worse than either answer.
This PRP therefore **consumes** #4458's determination and does not compete with
it. The audit-scope reasoning above was missing from #4458's body — it argued only
the R7 silent-fail-open on the adopt/BYO path — so it has been added there as a
comment, since the owner should carry the argument.

**Not live, either way:** IL5 has **never deployed** —
`gh run list --workflow deploy-fiab-il5.yml` returns `[]`, zero runs ever (§2.1).
The fallback is wired but has never executed. It would activate on IL5's **first**
deploy, which is what Wave 0 task 1 produces — which is why Wave 0 task 5 gates
task 1.

**What Wave 0 task 5 does with the answer.** If the determination is that the
default path is *not* in scope, stop deriving `LOOM_CONTENT_SAFETY_ENDPOINT` from
`loomAiEnrichEndpoint` at IL5 and move the verdict to the AOAI deployment-level
filter — audit-scope-clean, since Azure OpenAI is ✅ through IL6 — surfacing which
layer owns it. If the determination is that it *is* in scope, record that and
leave the wiring alone. Either way the outcome is written down; what is forbidden
is standing IL5 up while the question is open.

Measured alternative, recorded for that decision but **not recommended without
its own check**: `Foundry: Azure AI Content Moderator` is ✅ through IL5WI (blank
at IL6) in the same audit-scope fetch. It is the older, separate service and this
PRP has **not** verified its lifecycle status; treat it as a lead, not an answer.

**Related — the adopt/BYO complement is already tracked.** #4458 covers the other
branch of the same `:6224` expression: on an adopt/BYO Foundry (`EXISTING_AOAI`
set → `provisionAgentFoundry` false) with `aiFoundryEnabled = false`,
`loomAiEnrichEndpoint` is the **empty string**, and
`foundry-client.ts` `shieldPrompt` returns `{ blocked: false }` silently rather
than firing `safetyFailOpen` — a `deploy-integrity.md` R7 violation. #4458's body
states the stock path "is fine" from an R7 standpoint, which is correct on that
axis. The audit-scope question above is a **different axis on the same
expression**, and it is **owned by #4458 too** — routed there by
`il5.bicepparam:379-389` — not by this PRP. The reasoning was missing from that
issue's body, so it has been added there as a comment.

**Declared gap — owner and date (`cloud-parity.md` §1):**

> **Gap:** `llm-content-safety` at the APIM gateway is unavailable at DoD IL5
> (and IL4/IL6) because Azure AI Content Safety is outside those impact levels'
> audit scope. **Substitute:** AOAI deployment-level content filters, default-on.
> **Owner:** autonomous build program, Wave D. **Review by 2026-12-11** — re-read
> the audit-scope table then; if the Content Safety row gains IL4/IL5, delete
> this gap and author the policy at IL5 like everywhere else.

**Unverified, and a Wave 0 task:** whether **Prompt Shields** (the AOAI-side
analogue of `shield-prompt`) is configurable on AOAI deployments in Azure
Government at IL5. Learn documents Prompt Shields as an *optional* filter within
AOAI content filtering but states no per-boundary availability. **This PRP does
not claim it is available.** If it is not, IL5's jailbreak defence is a real
residual gap and must be declared as its own row, not folded into this one.

**Related gap already carried — semantic cache (Q4).** Unchanged, and now with a
data point Wave F should weigh rather than treat as decided: **Azure Cache for
Redis is ✅ through IL6** in the same audit-scope fetch. That does not reopen Q4 —
the classic service retires 2028-10-01 and Azure Managed Redis is Public-only
(`admin-plane/main.bicep:2573-2577`) — but it is the nearest managed alternative
and Wave F should say in one line why `redisOss` beats it rather than leave the
comparison unmade.

### 3.5 The DNS constraint — measured on the live estate 2026-09-11

The Loom estate is in the **DMLZ** subscription
`e093f4fd-5047-4ee4-968d-a56942c665f3`. The workstation's default subscription is
a different one (`Limitlessdata - Main`) and will answer these queries plausibly
and **wrongly**. Pass `--subscription` every time.

```bash
SUB=e093f4fd-5047-4ee4-968d-a56942c665f3
RG=rg-csa-loom-admin-centralus

# 1. The zone exists, and how much is in it.
az network private-dns zone list --subscription "$SUB" \
  --query "[?name=='azure-api.net'].{name:name,rg:resourceGroup,records:numberOfRecordSets,links:numberOfVirtualNetworkLinks}" -o json

# 2. Every A record in the zone — THE measurement.
az network private-dns record-set a list --subscription "$SUB" \
  --resource-group "$RG" --zone-name azure-api.net \
  --query "[].{name:name,ips:join(',',aRecords[].ipv4Address)}" -o table

# 3. Which VNets the zone is authoritative for.
az network private-dns link vnet list --subscription "$SUB" \
  --resource-group "$RG" --zone-name azure-api.net \
  --query "[].{name:name,reg:registrationEnabled,vnet:virtualNetwork.id}" -o json
```

Results, 2026-09-11:

```
(1) name=azure-api.net  rg=rg-csa-loom-admin-centralus  records=2  links=1
(2) Name                     Ips
    -----------------------  --------
    apim-csa-loom-centralus  10.0.4.4
(3) name=link-apim-console  reg=false
    vnet=/subscriptions/e093f4fd-.../virtualNetworks/vnet-csa-loom-hub-centralus
```

`records=2` is **SOA + the one A record** — read it with query (2), not from the
count, or you will believe there are two names.

Because a linked private zone is **authoritative for its whole namespace**, every
other `*.azure-api.net` name returns NXDOMAIN inside the VNet. That is not a
theory — it is the root cause of #4432: `LOOM_CONTENT_SAFETY_ENDPOINT`'s host did
not resolve from `loom-console` at all, every copilot turn threw, and the throw
surfaced as a causeless HTTP 500.

**Three consequences this design MUST honour:**

1. The APIM gateway hostname itself resolves — that A record exists. Routing to
   `apim-csa-loom-centralus.azure-api.net` is safe **today**.
2. **A workspace-gateway design is disqualified as-is.** #4442 measured
   `hzd9c4bdb9e4fng6.ai-gateway.dm1-02.azure-api.net` → ENOTFOUND in-VNet. Any
   hostname of that shape needs its own record in the zone, or it is unreachable.
3. **A second APIM instance** — multi-region, or a Q5 Option-B migration standing
   one up alongside — is unreachable in-VNet until its A record is added. Any
   wave that creates one owns that record.

Pool *backends* are unaffected: they are `*.openai.azure.com` /
`*.cognitiveservices.azure.com`, resolved through their own privatelink zones,
which work today (measured 2026-09-10: 10.0.5.19 / 10.0.5.20 — **carried from the
prior session, not re-measured 2026-09-11**).

---

## 4. Waves

Partitioned **by file** so lanes do not intersect. A wave that needs a file
another wave owns is sequenced, not parallelised.

**Acceptance applies to every wave** (`deploy-integrity.md` R2, and §1 item 6):
`az bicep build-params` and an ARM what-if are the *entry* bar, never the exit
bar. A wave is done when a deploy job **executed steps** against a real
subscription and the behaviour was observed. Name the boundary the receipt came
from; a boundary without one is declared unexercised.

### Wave 0 — the prerequisite measurements (gates every other wave)
**Owns:** nothing in-tree. Produces measurements + a decision record.

#4442 states this is "cheap and gates the rest. It should be the first task —
finding out late that a boundary has no [tier] would invalidate the design." The
2026-09-10 draft demoted it to a Verification bullet. It is restored here as
Wave 0, re-scoped to the questions that are actually still open:

1. **Premium classic in Gov** — confirm an APIM Premium-classic instance stands
   up in `usgovvirginia` in GCC-High and IL5. Per the Gov access rule this comes
   from a **GitHub Actions run in the boundary, never local `az`**. IL5 has never
   had a deploy run at all (§2.1), so this is also IL5's first receipt.
2. **Do the LLM policies exist in Gov APIM?** (§3.2, tracked by **#4460**).
   `aoaiLlmPoliciesSupported = !isSovereign` is an assumption, not a
   measurement. Author `llm-token-limit` on a Gov instance and record whether the
   PUT is accepted. The answer decides whether Wave D removes the sovereign
   exclusion or Loom declares a second dated gap — and it **unblocks Wave B2**.
   **Author `llm-emit-token-metric` in the same pass** (Wave E): it is in the
   same `llm-*` family, is absent from `apim.bicep` today, and its Gov
   availability is equally unmeasured — one run answers both.
3. **Prompt Shields on AOAI at IL5** (§3.4, explicitly unverified). Decides
   whether IL5's jailbreak defence is covered by the substitute or is its own
   declared gap.
4. **Q5** (§2.4) — the operator answers; record it in #4442 as Q1's addendum.
5. **IL5's content-safety audit-scope question** (§3.4.1, owned by **#4458**) —
   the stock IL5 deploy wires `LOOM_CONTENT_SAFETY_ENDPOINT` to the AIServices
   `/contentsafety` data plane, a capability blank at IL4/IL5WI/IL6. **This must
   be settled BEFORE task 1 stands IL5 up**, because task 1 is what makes the
   wiring live for the first time.

   **This task is deliberately satisfiable from OUTSIDE the boundary**, because
   it gates the only task that could get inside it. An earlier revision required
   "a recorded observation from an in-boundary Actions run" for every task, which
   made task 5 circular: IL5 has zero runs, and task 1 is what would produce the
   first. The inputs task 5 actually needs are all obtainable now:
   - the audit-scope table (already measured, §3.4);
   - a **static read** of the wiring — `il5.bicepparam:178`,
     `main.bicep:606/700`, `admin-plane/main.bicep:2077/3665/6224` — already
     traced in §3.4.1 and independently in `il5.bicepparam:370-390`;
   - a **compliance determination** from whoever owns the IL5 accreditation.
     That is a human judgement, not a deploy.

   No Azure call, in any boundary, is required to complete it.

**Cheapest first receipt — GCC-High is one click away.** Measured 2026-09-11:
**14 of the last 30 `deploy-fiab-gcch.yml` runs are `status=waiting`** (the
2026-08-27 → 2026-09-10 nightlies; an earlier revision of this PRP named only the
most recent three). On the newest, `34485799151`, the
`Deploy + validate CSA Loom in GCC-High` job is `status=waiting, steps=0`
**because it has not started** — the run is paused on the `gcc-high-deploy`
environment approval gate (`pending_deployments`: `waitTimer=0`,
`current_user_can_approve=true`). This is **not** the GCC skipped-at-zero shape,
which prints the same `steps=0` for the opposite reason. Approving any one of the
14 yields a fresh receipt for tasks 1 and 2.

- **Acceptance, per task — the evidence each one can actually produce:**
  - **1 and 2** — a recorded observation from an **in-boundary Actions run**.
    These are the only two tasks that need one.
  - **3** — a Learn/portal statement naming Azure Government explicitly, or an
    in-boundary observation if one is cheaper. No deploy required.
  - **4 (Q5)** — an operator answer, recorded in #4442.
  - **5** — the compliance determination on #4458 plus the static wiring read.
    **No Azure call in any boundary** (see the task text — it gates task 1, so it
    cannot depend on it).
- **A negative is a successful Wave 0** — it redirects the design instead of
  invalidating it late.

### Wave A — the multi-endpoint pool (the core of the issue)
**Owns:** `platform/fiab/bicep/modules/admin-plane/main.bicep` (the
`aoaiApimBackendEndpoints` derivation at `:2083-2084` only),
`platform/fiab/bicep/modules/admin-plane/apim.bicep` (pool params).

- Replace the single-element array with a derivation that collects **every**
  Loom-provisioned inference endpoint plus operator-supplied BYO, priority-ordered.
- Preserve `no-vaporware`: an empty pool is still never authored
  (`apim.bicep:414`, `aoaiGatewayActive`).
- Priority-1 = PTU primary where present; the rest priority-2 spillover.
- **Acceptance:** a param set naming three endpoints produces a three-member pool
  with the documented priorities — proven by `az bicep build-params` + what-if,
  **then** by a Commercial deploy receipt showing the three backends present on
  the live instance. Reading the template is not acceptance.

### Wave B — default-ON with opt-out preserved (SPLIT: B1 ships, B2 is gated)
**B1 owns:** the `loomBackends` defaults in
`platform/fiab/bicep/modules/admin-plane/main.bicep:2591-2592`, and these param
files **by name**: `commercial.bicepparam`, `commercial-full.bicepparam`,
`gcc.bicepparam`, `tenant-dmlz.bicepparam`.
**B2 owns:** `gcc-high.bicepparam` and `il5.bicepparam` — **only**, and only once
unblocked.
**Neither owns** `dlz-attach.bicepparam` (§2.1 — different template, no APIM
params). Do not glob.

Splitting ownership this way is what makes the sequencing below enforceable
rather than advisory: B1 and B2 touch disjoint files, so B2 can sit behind Wave D
without holding B1's four files hostage.

- `aoaiGateway` and `aoaiViaApim` default ON; explicit opt-out documented.
- **Keep them separable.** Author-then-cutover must survive.
- Set them in every file **of the owning sub-wave**, with any boundary that must
  differ stating why at the line (the `il5.bicepparam` precedent).

> **⛔ B is SPLIT. B1 ships; B2 is gated.**
>
> Defaulting `aoaiViaApim` ON in `gcc-high.bicepparam` and `il5.bicepparam`
> routes those boundaries' AI traffic through a gateway that authors **no**
> `llm-token-limit` — `aoaiLlmPoliciesSupported = !isSovereign`
> (`apim.bicep:423`, §3.2, #4460). Wave D is where that gets resolved, so a
> plain B-before-D order leaves GCC-High and IL5 carrying traffic with **no
> spend control**. Wave B's receipt is Commercial-only, so it would not surface.
> This is a sequencing hole, not a footnote.
>
> - **B1 — Commercial / GCC (now).** Default ON in `commercial.bicepparam`,
>   `commercial-full.bicepparam`, `gcc.bicepparam`, `tenant-dmlz.bicepparam`.
>   `isSovereign` excludes GCC (`apim.bicep:202`), so all four get the full
>   policy set including `llm-token-limit`. No hole.
> - **B2 — GCC-High / IL5 (BLOCKED on #4460's resolution, i.e. Wave D).**
>   `gcc-high.bicepparam` and `il5.bicepparam` keep `aoaiViaApim` **off** until
>   the sovereign spend control exists — either `llm-token-limit` authored
>   (Wave 0 task 2 says the policy is available in Gov) or a declared Azure-native
>   substitute wired (`rate-limit-by-key` / `quota-by-key`, which counts requests
>   not tokens and must be labelled as such). `aoaiGateway` MAY default ON in B1
>   for those two — authoring the gateway without routing to it is precisely the
>   separability property, and it is what lets Wave 0 smoke-test in-boundary.
>
> B2 is not a deferral of cloud parity: it is a refusal to ship Gov a gateway
> that is *worse* than the direct path it replaces. The parity target is B2
> landing, and it is tracked by #4460, not by this PRP alone.

- **Acceptance (B1):** each of the four B1 `.bicepparam` builds and resolves the
  expected values, **and** a Commercial deploy receipt shows the gateway authored
  and the console routing through it — with the separability preserved (one
  deploy with `aoaiGateway` on and `aoaiViaApim` off, proving the gateway stands
  up without taking traffic).
- **Acceptance (B2):** the same, plus an in-boundary receipt showing a spend
  control actually present in the authored policy XML for that boundary. A Gov
  deploy whose policy XML has no rate/token ceiling fails this wave.

### Wave C — SKU + capacity — BLOCKED on Q5
**Owns:** `apimSku` in the six boundary param files, `capacity` threading from
`platform/fiab/bicep/main.bicep` → `admin-plane/main.bicep:3763-3786` →
`apim.bicep:28`.

**There is no `Developer` to flip.** Every boundary already sets a Premium-family
`apimSku` (§2.1), `apimSku` has no default and cannot be `Developer` (§2.2), and
`apimSkuName` is a cost-estimator knob no deployment reads. The SKU half of this
wave is **already satisfied in-tree** for Gov and — pending Q5 — for Commercial.
Stating that is the deliverable; inventing a flip is not.

What genuinely remains:

1. **Q5's answer, applied.** If the recommendation stands (stay on PremiumV2),
   this is a documentation change: record the per-boundary SKU contract and the
   multi-region trade in `docs/`, and delete nothing. If Option B is chosen, this
   becomes a stand-up-alongside migration wave with its own `azure-api.net` A
   record (§3.5 consequence 3) and both greenfield and brownfield receipts —
   substantially larger than the rest of this epic, and it should be split out.
2. **Capacity.** `apim.bicep:28 param capacity int = 1` is never threaded and the
   live estate runs one unit. Thread it and set it per boundary before the
   gateway becomes the single path for all Loom AI traffic.
3. **The cost delta**, stated explicitly in the PR. It was accepted knowingly and
   must not be smuggled in — but it must also be the *real* delta, measured from
   the deployed SKU, not from a `Developer` baseline that was never deployed.

- **Acceptance:** the per-boundary SKU + capacity contract is stated in `docs/`
  and matches `az apim list` on the live estate; the cost delta is in the PR body;
  a Commercial deploy receipt shows the intended capacity on the instance.

### Wave D — the other three service families (Q3)
**Owns:** `platform/fiab/bicep/modules/admin-plane/apim.bicep` API/policy
definitions.

- AI Search, Document Intelligence / Speech / Vision, and `llm-content-safety` at
  the gateway. Note `llm-content-safety` is **new** — it does not exist in
  `apim.bicep` today (§3.1).
- **Gate `llm-content-safety` on `contentSafetyEnabled`, never on the boundary
  name** (§3.4): IL5 is `false`, GCC-High is `true` today but must be able to be
  `false` for an IL4-scoped tenant, and a boundary-name check would get that
  wrong.
- **Where it is off, wire the substitute and SAY so** — the AOAI deployment's
  default-on content filter owns the verdict, surfaced per boundary on the
  readiness page. An unstated protection is as wrong as an overstated one.
- **At IL5, do NOT touch the `/contentsafety` fallback until Wave 0 task 5
  returns.** `admin-plane/main.bicep:6224` is IL5's **only working screening
  path** today (§3.4.1). Whether it is in audit scope is **UNDETERMINED and owned
  by #4458**, so this wave is conditional on that answer, not on a default:
  - **Determination = not in scope** → stop deriving
    `LOOM_CONTENT_SAFETY_ENDPOINT` from `loomAiEnrichEndpoint` at IL5 and move the
    verdict to the AOAI deployment-level filter, surfacing which layer owns it.
  - **Determination = in scope** → **record it and leave the wiring alone.**
  - **No determination yet** → change nothing here, and do not stand IL5 up
    (Wave 0 task 5 gates task 1).

  An earlier revision of this bullet said undoing the fallback was simply what
  Wave D does. A lane executing that verbatim would **strip IL5's only screening
  on a question nobody has answered** — the precise hazard §0 exists to prevent.
- Act on §3.2 — tracked by **#4460** — with Wave 0 task 2's answer: either delete the
  `!isSovereign` exclusion on `llm-token-limit`, or wire the declared Azure-native
  substitute (`rate-limit-by-key` / `quota-by-key`, labelled as request-counting,
  not token-counting). Do not leave it undeclared. **This is what unblocks Wave
  B2**, so it is the highest-priority item in this wave, not the last.
- The LLM policies (`llm-token-limit`, `llm-semantic-cache-*`) only understand
  OpenAI-shaped traffic, so the other three families get backends + circuit
  breaker + routing, **not** token limiting. Say so rather than implying uniform
  capability.
- **Acceptance:** a Commercial deploy receipt with a real call through each of
  the four families, **plus** a receipt from at least one Gov boundary showing the
  content-safety branch taking the substitute path without erroring. Boundaries
  without a receipt are named unexercised.

### Wave E — observability + gateway-side safety
**Owns:** `apim.bicep` policy fragments, App Insights wiring.

- `llm-emit-token-metric` → per-API/per-dimension token metrics: the cost
  attribution story nearly for free. **Gov availability UNVERIFIED — do not
  promise it to IL5.** An earlier revision of this PRP called it
  "boundary-portable… IL5 keeps it in full" on the grounds that it "is not a
  Content Safety dependency". That reasoning was a non sequitur:
  `aoaiLlmPoliciesSupported` (`apim.bicep:423`) has nothing to do with Content
  Safety — it gates the **`llm-*` GenAI policy family**, and
  `llm-emit-token-metric` is a member of exactly that family. Measured
  2026-09-11: it appears **zero** times in `apim.bicep` and zero times anywhere
  under `platform/`; the only `llm-*` policies present are `llm-token-limit`,
  `llm-semantic-cache-lookup` and `llm-semantic-cache-store` — precisely the
  three `!isSovereign` excludes. So its Gov status is an open question of the
  same shape as #4460's, not an exception to it. **Fold it into Wave 0 task 2's
  measurement** — author it on the same Gov instance and record whether the PUT
  is accepted — and until that returns, treat it as unverified alongside Prompt
  Shields.
- `llm-content-safety` including `shield-prompt`, on the `contentSafetyEnabled`
  branch only (§3.4).
- **Note the interaction with #4432's remediation:** the console already screens
  prompts via Content Safety directly. Gateway-side screening must not
  double-charge or double-block; decide and record which layer owns the verdict —
  and record it **per boundary**. At IL5 that record must reflect §3.4.1: the
  console screens today via the AIServices `/contentsafety` fallback
  (`admin-plane/main.bicep:6224`) — **not**, as an earlier draft of this PRP
  wrongly said, an absence of Content Safety at both layers. Whether that
  screening is *authorized* at IL5 is **undetermined and owned by #4458**; record
  the layer, and record the open question alongside it rather than implying
  either answer.
- **Acceptance:** token metrics visible in App Insights from a live turn
  (Commercial receipt), and the per-boundary verdict-ownership table in `docs/`.

### Wave F — Gov-capable semantic cache (Q4)
**Owns:** the `redisOss` app definition + the cache policy wiring.

- Azure Managed Redis is Azure Public only with no announced Gov date
  (`admin-plane/main.bicep:2573-2577`), so the Commercial answer cannot be the Gov
  answer.
- Build the RediSearch capability on the existing `redisOss` app
  (`admin-plane/main.bicep:2578`).
- State in one line why `redisOss` beats Azure Cache for Redis, which **is** ✅
  through IL6 in audit scope but retires 2028-10-01 (§3.4). Make the comparison;
  do not leave it unmade.
- **Two properties are non-negotiable:** the cache is per-tenant (answers never
  cross tenants), and the UI states that semantic caching returns responses on
  **similarity, not exact match**, so it can surface answers that are incorrect,
  outdated or unsafe — Learn's own caveat.
- **Token counters are per gateway / region / workspace and are NOT aggregated**;
  any multi-region design must state what a "limit" actually means.
- **Acceptance:** a cache hit and a cache miss observed on a live turn, in a Gov
  boundary receipt — not only Commercial, since Gov is the whole point of Q4.

### Wave G — day-one deploy coverage + readiness
**Owns:** the six boundary `.bicepparam` files (sequenced after B), the readiness
gate registry, `docs/`.

- A readiness gate for gateway health, registered so Copilot can discover and
  resolve it (`ux-baseline.md` G2) and visible on the Admin gate page.
- The gate must show **per-boundary capability state**, including the two declared
  gaps (§3.4 content safety at IL5, Q4 semantic cache) and their substitutes. A
  gap the operator cannot see is the `deploy-integrity.md` R3 failure.
- Greenfield **and** brownfield walkthroughs (`deploy-integrity.md` R8).
- Brownfield must honour R5: discover an existing APIM, **offer** it, never
  silently adopt or silently duplicate. `adoptMode(adopt,'apim')` already exists.
- **Acceptance:** a greenfield receipt and a brownfield receipt, each naming its
  boundary; the readiness page screenshot showing the per-boundary state.

---

## 5. Verification

Per `deploy-integrity.md` and `ux-baseline.md` G1, and stated per boundary. The
receipt status below is **measured 2026-09-11** and is the starting position, not
the target:

| Boundary | Receipt today | What this epic must produce |
|---|---|---|
| Commercial / DMLZ | exercised (live estate) | a deploy receipt per wave, then a live AI turn through the gateway |
| GCC | **supported-in-code, NEVER exercised** (0 runs ever executed a deploy step; lane `disabled_manually`; no GCC tenant or `AZURE_GCC_*` secrets exist) | `build-params` parity only. **Do not list GCC as covered.** It cannot gain a receipt without a GCC tenant, which is out of this epic's scope (#3078, #4071). |
| GCC-High | exercised; last receipt **dated 2026-09-01** — run 33519232492, deploy job `failure`, steps=33. **9 later runs** are `status=waiting` on the `gcc-high-deploy` environment approval gate (14 waiting across the last 30), deploy job `steps=0` because **not started** — one approval from a fresh receipt | approve one of the waiting runs; that is the cheapest path to Wave 0 tasks 1 and 2 |
| IL5 | **NEVER exercised** — `gh run list --workflow deploy-fiab-il5.yml` → `[]` | Wave 0 produces IL5's first deploy receipt in the repo's history |

- The bar the copilot work just set applies here too — a test that accepts "a
  real answer OR an honest gate" proves nothing. Require the real answer.
- Confirm Premium classic availability in-boundary via a **GitHub Actions run,
  never local `az`** (the workstation is a Commercial tenant).
- **Brownfield:** prove the adopt path against an existing APIM.
- The `azure-api.net` record for any new instance is part of the acceptance, not
  a follow-up (§3.5).

---

## 6. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Cutover breaks live AI | The gateway becomes the single path for all Loom AI traffic | Keep `aoaiGateway` / `aoaiViaApim` separable; author + smoke-test before routing |
| A lane executes the withdrawn Q1 premise | "Flip the default from `Developer`" would move the **live** PremiumV2 estate to a classic resource shape — a stand-up-alongside migration, against a decision whose own text promised "no estate migration" | §0 C1/C2, §2.2, §2.4; Wave C is BLOCKED on Q5 |
| Undeclared IL5 content-safety gap | Shipping `llm-content-safety` "everywhere" would fail at IL5, or silently drop moderation | §3.4 — declared gap, substitute, owner, review date; gate on `contentSafetyEnabled`, not boundary name |
| Prompt Shields at IL5 unverified | If unavailable, IL5 has no jailbreak defence and the §3.4 substitute is incomplete | Wave 0 task 3; declare a second gap if negative |
| **IL5 may call a capability outside its audit scope** — UNDETERMINED | The stock IL5 deploy wires `LOOM_CONTENT_SAFETY_ENDPOINT` to the AIServices `/contentsafety` data plane (`admin-plane/main.bicep:6224`); `Foundry: Azure AI Content Safety` is blank at IL4/IL5WI/IL6 and the table has no multi-service row. Whether hosting inherits authorization is a **compliance determination, not a code read** | **Owned by #4458**, and recorded in-tree at `il5.bicepparam:378-390` at the same confidence. §3.4.1. Not live — IL5 has **never deployed** (`gh run list` → `[]`). **Wave 0 task 5 settles it BEFORE task 1 stands IL5 up.** |
| Two artifacts, two confidence levels, one compliance question | This PRP once asserted the exposure as fact while `il5.bicepparam` called it undetermined — a lane reading either alone would act on a different belief | Resolved: **one owner (#4458), one confidence level (undetermined)**. This PRP consumes the determination; #4458 now carries the audit-scope argument it previously lacked |
| Token limiting absent in Gov | `!isSovereign` removes the gateway's only spend control in GCC-High + IL5 | **#4460** owns it; §3.2; Wave 0 task 2 measures it; Wave D removes or substitutes it; **Wave B2 is gated on it** |
| Gov routed before the spend control exists | A plain B-before-D order turns the gateway ON in GCC-High + IL5 with no ceiling, and B's Commercial-only receipt would not surface it | Wave B is split **B1 / B2**; B2 blocked on #4460 |
| A gap tracked only in an unmerged draft | If this PR did not land, the `!isSovereign` finding would vanish with it | **#4460** filed 2026-09-11 as an independent issue |
| Capacity = 1 unit | One unit becomes the chokepoint for all AI traffic | Wave C item 2 threads `capacity` before cutover |
| `azure-api.net` shadowing | Already caused #4432 at a smaller blast radius | §3.5 consequences 2/3; any new hostname owns its record |
| Premium cost | Materially the most expensive tier | State the delta per PR, measured from the **deployed** SKU, not a `Developer` baseline |
| Central US Premium v2 ⚠️ | New PremiumV2 instance creation is temporarily unavailable in Central US; existing instances unaffected | Input to Q5; do not plan a new Central US PremiumV2 without re-checking |
| Double content-safety | Console already screens (post-#4432) | Wave E decides which layer owns the verdict, **per boundary** |
| Claiming parity on a Commercial receipt | GCC has never deployed; IL5 has never run | §5 table; name unexercised boundaries as such in every artifact |

---

## 7. Sequencing note

#4442 says to sequence after #4432's diagnosis "so we do not change endpoint
resolution underneath a live defect". **That diagnosis is complete**: root cause
was the authoritative `azure-api.net` zone, the private endpoint has landed, and
the copilot is verified answering end-to-end on the live estate. #4432 remains
open pending an operator-observed G1 walk, but it no longer blocks this design —
and its measurement is now an input to it (§3.5).

Within this epic:

```
Wave 0  →  (A ∥ B1)  →  D  →  B2  →  E  →  F  →  G
                                 ↑
                        C  (blocked on Q5, joins once answered)
```

Three hard edges, each for a measured reason rather than tidiness:

- **Wave 0 is not optional and not parallelisable.** Its **three measurements
  (1, 2, 3) and two decisions (4 = Q5, 5 = the #4458 compliance determination)**
  each change what a later wave builds — and **task 5 must land before task 1**,
  because task 1 is what makes IL5's `/contentsafety` wiring live for the first
  time (§3.4.1). Task 5 is satisfiable without any Azure call precisely so that
  ordering is possible.
- **B2 sits AFTER D, not with B1.** Defaulting `aoaiViaApim` ON in GCC-High and
  IL5 before Wave D lands the #4460 remediation would route those boundaries with
  no spend control, and B's Commercial-only receipt would not catch it.
- **C is blocked on Q5** and, if Q5 lands on Option B, splits out of this epic
  entirely — a live-estate APIM migration is not a sub-task of turning a gateway
  on.
