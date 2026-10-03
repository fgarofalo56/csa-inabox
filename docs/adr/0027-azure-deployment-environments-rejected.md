---
status: accepted
date: 2026-10-03
deciders: csa-inabox platform team
consulted: dev-loop, governance
informed: all
---

# ADR 0027 — Reject Azure Deployment Environments as the structural brownfield adopt mechanism

## Context and Problem Statement

Issue #3355 asked us to evaluate **Azure Deployment Environments (ADE)** as a
structural alternative to the wizard's brownfield-adoption fitness-probe path:
instead of patching the wizard's discover/offer/validate flow
(`deploy-integrity.md` R5), could ADE's project/environment-definition model
*be* the brownfield adopt mechanism — platform engineers curate
environment-definition templates per Azure backing service, brownfield
customers "adopt" an existing estate by mapping it onto an ADE project, and
Loom's provisioners deploy through ADE's catalog + CLI/API surface instead of
directly via Bicep? This ADR records the spike and the recommendation.

## Decision Drivers

- `cloud-parity.md`: no capability may ship Commercial-only; a structural
  mechanism this repo depends on must be available (or have a same-tenancy
  equivalent) in GCC, GCC-High, and IL5.
- `deploy-integrity.md` R4: any replacement mechanism must keep greenfield
  *and* brownfield working, zero-touch, in both clouds.
- Longevity: a *structural* mechanism — one other code depends on — must not
  be built on a service with a known end-of-life date shorter than this
  repo's roadmap horizon.

## Research findings (dated 2026-10-03)

**ADE is being retired by Microsoft.** Per the official retirement guide
(`learn.microsoft.com/azure/deployment-environments/deployment-environments-retirement-guide`,
`ms.date` 2026-09-04, last updated 2026-09-14 — current, not stale):

> "Azure Deployment Environments retires on **22 February 2027**." Create,
> deploy, redeploy, and other write operations are expected to be **blocked**
> on that date; only inventory/read/delete survive a time-bound cleanup
> window. Microsoft's own guidance is to migrate to "Azure Resource Manager
> templates or Bicep," "Azure verified modules," or "Azure DevOps and GitHub
> workflows" — i.e., back to what this repo already does.

This single fact is dispositive on its own: we would not adopt, as a
*structural* mechanism depended on by other code, a service with a published
retirement date under 5 months from this writing.

**Azure Government availability was never established, and is now moot.**
The ADE overview and quickstart docs (`overview-what-is-azure-deployment-environments`,
`quickstart-create-and-configure-devcenter`) contain zero mentions of
Government/sovereign/GCC/GCC-High/IL5. The canonical
`compare-azure-government-global-azure` Learn doc's "Developer tools" section
— the section that would cover ADE if it shipped to Gov — lists
`load-testing, app-configuration, devtest-lab, lab-services, azure-devops` and
omits `azure-deployment-environment` and `dev-box` entirely. We found no Learn
page asserting ADE reached GCC, GCC-High, or IL5 at any point. Per
`cloud-parity.md`'s "supported-in-code is not ever-exercised" discipline, an
unlisted service is not merely unverified here — there is no published claim
of availability to verify in the first place. Per boundary:

| Boundary | GA (Commercial) | Gov availability found |
|---|---|---|
| Commercial | Yes (pre-retirement notice) | n/a |
| GCC | n/a — retiring regardless | Not listed in Gov Developer-tools comparison |
| GCC-High | n/a — retiring regardless | Not listed in Gov Developer-tools comparison |
| IL5 | n/a — retiring regardless | Not listed in Gov Developer-tools comparison |

Given the retirement date, further confirming the negative for each Gov
boundary individually would not change the outcome — the service retires out
from under all boundaries, including Commercial, before this repo's next
major release horizon.

## Considered Options

1. **Adopt ADE as the structural brownfield mechanism.**
2. **Adopt ADE for a narrow, non-structural, Commercial-only convenience path
   (e.g., sandbox exploration), keep the wizard as the real mechanism.**
3. **Reject ADE outright; continue patching the wizard's discover/offer/
   validate fitness-probe path directly in Bicep (chosen).**

## Decision Outcome

**Reject.** Continue evolving the existing wizard brownfield-adoption path
(discover → offer → validate → bind, `deploy-integrity.md` R5) directly on
Bicep/ARM, which is itself Microsoft's own stated migration target for ADE
customers. No new dependency is introduced in any boundary.

Option 2 is also rejected: per `no-fabric-dependency.md`'s and
`auto-bind-by-default.md`'s discipline against building *any* default-path
dependency on a mechanism unavailable in Gov, and per `cloud-parity.md`,
spending engineering time wiring even a non-structural integration to a
service with a 2027-02-22 retirement date is not a good use of the runway
before this repo's next major milestones.

## Consequences

- Positive: zero new dependency, zero migration debt — we never built on a
  service Microsoft is now telling its own customers to migrate *off of*.
- Positive: the research closes out #3355 without opening any new Bicep or
  provisioner work; the real work (hardening the wizard's fitness probe) is
  already tracked separately (the "Sprint 6" wizard-restoration story referenced
  in #3355).
- Negative: none identified — no code was written against ADE, so there is
  nothing to unwind.
- Neutral: if Microsoft ships a non-retiring successor service with Gov
  parity, it would warrant its own fresh spike rather than reopening this one.

## Pros and Cons of the Options

### Option 1 — Adopt ADE structurally
- Pros: would have offered a managed project/catalog model for environment
  templates.
- Cons: retires 2027-02-22 (write ops blocked); no established Gov/GCC/
  GCC-High/IL5 availability; violates `cloud-parity.md` and introduces a
  dead-end structural dependency.

### Option 2 — Adopt ADE narrowly (Commercial-only convenience)
- Pros: limited blast radius.
- Cons: same retirement date; any investment is sunk cost inside 5 months;
  still Commercial-only, which this repo's discipline treats as incomplete
  rather than "fine because it's optional."

### Option 3 — Reject; keep improving the Bicep-based wizard (chosen)
- Pros: zero new dependency; matches Microsoft's own stated retirement
  guidance; keeps full cloud parity; no migration debt.
- Cons: the wizard's fitness-probe path still needs its own hardening work —
  but that work was already scoped separately and is not blocked by this
  decision.

## Validation

We will know this decision was right if no future PR reintroduces an ADE
(`api.deploymentenvironments` / devcenter) dependency on a default path. A
`grep -rn "deploymentenvironments\|devcenter.azure.com" platform/ apps/` stays
at zero hits going forward.

## References

- Retirement guide: <https://learn.microsoft.com/en-us/azure/deployment-environments/deployment-environments-retirement-guide>
  (`ms.date` 2026-09-04, `updated_at` 2026-09-14T17:12:00Z)
- Overview: <https://learn.microsoft.com/en-us/azure/deployment-environments/overview-what-is-azure-deployment-environments>
- Gov comparison doc (Developer tools section, no ADE/Dev Box listing):
  <https://learn.microsoft.com/en-us/azure/azure-government/compare-azure-government-global-azure>
- Related rule: `deploy-integrity.md` R4/R5 (brownfield discover/offer/
  validate), `cloud-parity.md` (per-boundary disposition discipline)
- Issue: #3355
