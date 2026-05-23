# Marketplace (deferred to backlog)

> **CSA Loom v1 does NOT ship an Azure Marketplace Managed Application
> listing.** Per [ADR fiab-0008](../adr/0008-deployment-shape.md) and
> [AMENDMENTS A4](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md), the Marketplace
> surface + pricing model are explicitly deferred to backlog. v1 ships
> as `azd up` + Deploy-to-Azure button only.

## Why deferred

Pricing model decisions require real-world adoption data CSA Loom
doesn't have in v1. Marketplace publishing engineering (Partner
Center + certifications + per-cloud Entra setup + publisher access
agreements) adds ~6 weeks of v1 effort that doesn't deliver customer
value if pricing isn't decided.

Federal customers in early adoption will run `azd up` against their
own subs anyway (customer-managed deploy is the federal default
regardless of Marketplace plan choice).

## What's deferred

| Item | When |
|---|---|
| Azure Marketplace Managed Application listing | Post-v1.1 — backlog |
| Pricing model decision | Post-v1.1 — backlog |
| `createUiDefinition.json` portal install wizard | Post-v1.1 |
| `mainTemplate.json` ARM rendering for Marketplace | Post-v1.1 |
| `viewDefinition.json` post-install ops UX | Post-v1.1 |
| Publisher-managed vs customer-managed plan choice | Post-v1.1 |
| Update mechanism via MCP-as-update-channel | Already implemented for `azd up` users — just not exposed via Marketplace |

## What you can do today

v1 deployment options:

- [Quick Start (60 minutes)](quickstart.md)
- [azd CLI deployment](azd-cli.md)
- [Deploy to Azure button](deploy-button.md)

All three deploy CSA Loom into your own Azure subscription. You pay
only for Azure consumption underneath; Loom IP is **free in v1**.

## When Marketplace work resumes

Triggers for revisiting Marketplace publishing:

- Loom adoption reaches ~50+ customer installs across `azd up`
  + Deploy-to-Azure paths
- Microsoft federal team requests Marketplace SKU for procurement
  reasons
- Pricing strategy decision is locked (likely flat fee per capacity
  SKU + metered overage per DLZ — see PRD §07.9 for sample)
- Marketplace Managed App publishing in Azure Government has fewer
  open questions (per `research/05-eslz-marketplace.md §2.5`, the Gov
  path is "conditionally yes" with DoD IL5 ambiguity remaining)

When the Marketplace path resumes:
- PRP-10 reopens with the Managed App package work
- PRP-101 (IL5 Marketplace publishing engagement) follows
- Pricing model goes through a separate decision flow

## Architectural readiness

Even though v1 doesn't ship Marketplace, the underlying Bicep
platform is **already Marketplace-ready**:

- `main.bicep` accepts the same parameters a Marketplace
  `createUiDefinition.json` would emit
- Container images pushed to public ACR work as Managed App
  references
- Per-boundary `.bicepparam` files compile cleanly to
  `mainTemplate.json` (`languageVersion: 1.0` constraint respected)

When Marketplace work resumes, it's a **wrapper exercise**, not a
re-architecture.

## Related

- ADR: [fiab-0008 Deployment shape](../adr/0008-deployment-shape.md)
- Amendments: [`temp/fiab-prd/AMENDMENTS.md` §A4](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md)
- Backlog PRP: PRP-10 (Marketplace Managed App package)
- Research: [`temp/fiab-research/05-eslz-marketplace.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-research/05-eslz-marketplace.md) (kept for v1.1+ reference)
