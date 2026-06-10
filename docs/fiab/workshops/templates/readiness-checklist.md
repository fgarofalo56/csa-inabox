# Pre-workshop readiness checklist

Complete **before Day 1**. The Day-1 deploy lab assumes every item below is
done; unchecked items become live blockers during `azd up`. The facilitator
reviews this checklist with the customer 1 week before the workshop.

!!! info "Boundary note"
    Items marked **(Federal)** apply to GCC / GCC-High / IL5 deploys; items
    marked **(Commercial)** apply to Azure Commercial. Unmarked items apply to
    both.

## Azure subscription & roles

- [ ] Target subscription identified (`<sub id>`)
- [ ] Deploying principal has **Contributor**
- [ ] Deploying principal has **User Access Administrator** (required for Loom's
      role assignments — the #1 cause of mid-deploy failures)
- [ ] Subscription resource-provider registrations allowed (or pre-registered)
- [ ] **(Federal)** Azure **Government** subscription confirmed (not Commercial)

## Identity (Entra)

- [ ] **Loom Admins** Entra group created; object ID recorded
- [ ] First workshop admin's user **OID** recorded (set `LOOM_TENANT_ADMIN_OID`
      in case group-claim emission is disabled in the tenant)
- [ ] Participants have Entra accounts in the deploying tenant
- [ ] **(Federal)** M365 GCC-High tenant (IL4) **or** GCC tenant confirmed

## Capacity / BI

- [ ] **(Federal)** Power BI **P-SKU** capacity available (no F-SKU in GCC/GCC-High)
- [ ] **(Commercial)** Power BI F-SKU available **if** native Power BI is desired
      (optional — the Loom-native tabular layer needs none)
- [ ] Capacity SKU baseline agreed (e.g., F8) — see
      [cost breakdown](../../operations/cost.md)

## Networking

- [ ] DLZ CIDR ranges allocated (non-overlapping with existing VNets)
- [ ] **(Federal)** ER/VPN connectivity confirmed; NSG egress allow-list reviewed
- [ ] **(Commercial)** Public + private endpoint policy decided per vertical

## AI / data services

- [ ] Azure OpenAI access approved in the target region (Gov endpoints for
      Federal)
- [ ] **(Commercial)** Foundry Agent Service availability confirmed (GA) if Data
      Agents will use server-side threads
- [ ] ADX (Azure Data Explorer) region availability confirmed for real-time labs

## Workload & data

- [ ] A **real** candidate workload identified for the week's case study
      (source system, rough volume) — used Day 2 onward
- [ ] Confirmed: only [CUI-safe synthetic datasets](../datasets/index.md) used in
      labs; **no real CUI/PHI/PII** brought into the workshop boundary

## People & logistics

- [ ] 4-8 platform engineers committed full week
- [ ] Exec sponsor available Day-1 kickoff + Day-5 readout
- [ ] **(Federal)** ATO/compliance officer available Day 1 + Day 5
- [ ] Security architect available Days 1, 4, 5
- [ ] Venue + AV (on-site) or virtual-classroom links (remote)
- [ ] Git repository available for participants to commit notebooks/dbt models

## Tooling on participant machines

- [ ] Azure CLI + `azd` installed
- [ ] Git installed + access to the workshop repo
- [ ] Modern browser for the Loom Console

## Related

- [Day 1 — Foundation & Deploy](../5-day-federal-coe/day-1-foundation.md)
- [CoE charter template](coe-charter.md) · [Post-survey](post-survey.md)
