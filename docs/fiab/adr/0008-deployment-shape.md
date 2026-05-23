# fiab-0008: Deployment shape — two-tier (azd + Deploy-to-Azure); Marketplace deferred

**Status:** Accepted
**Date:** 2026-05-22
**Locked decision ref:** LD-4

## Context

The PRD originally specified a three-tier deployment surface:
1. Azure Marketplace Managed Application — one-click purchase + install
2. `azd` CLI — power-user path
3. Deploy-to-Azure template button — portal-click path

After the 2026-05-22 walkthrough, the user opted to **defer the
Marketplace surface and pricing model entirely to backlog** (per OQ-10
+ OQ-4 final answers). The reasoning:

- Pricing model decision requires real-world adoption data Loom doesn't
  have in v1
- Marketplace publishing flow (Partner Center + certifications + per-
  cloud Entra setup + publisher access agreements) adds ~6 weeks of
  v1 engineering that doesn't deliver customer value if pricing isn't
  decided
- Federal customers in early adoption will run `azd up` against their
  own subs anyway (customer-managed deploy is the federal default
  regardless of Marketplace plan choice)
- Once Loom has proven value + adoption velocity, pricing + Marketplace
  publish becomes a tractable next-step decision

## Decision

**Two-tier deployment shape for v1:**

1. **`azd up` CLI** — power-user path; full Bicep visibility;
   `azd init -t fiab && azd up`
2. **"Deploy to Azure" template button** — embedded in README; opens
   Azure portal with pre-rendered ARM template; evaluator-friendly

Both deploy into the customer's own Azure subscription. Customer pays
only for Azure consumption underneath. Loom IP (Console, Setup Wizard,
parity services, Copilot runtime, docs, workshops) is **free in v1**.

Marketplace Managed Application + pricing model are **deferred to
backlog**:
- PRP-10 (Marketplace Managed App package) → backlog
- PRP-11 reduced scope: per-boundary deploy validation workflows only
  (no Marketplace package validation, no Partner Center publish
  workflows)
- §07.10 first-install timeline unchanged: 60-100 min from "begin" to
  working Console URL

Backlog items revisited after Loom v1 + v1.1 mature:
- Pricing model (flat fee per capacity SKU + metered overage per DLZ
  is the leading candidate from PRD §07.9 but not locked)
- Marketplace Managed App publishing (Commercial + Gov listings)
- Publisher-managed vs customer-managed plan choice
- Update mechanism via MCP-as-update-channel pattern

## Consequences

### Positive

- v1 ships **~6 weeks faster** by removing Marketplace publishing
  engineering
- No Partner Center / Microsoft federal engagement required for IL5 in
  v1 (deferred to v1.1 with the IL5 boundary itself)
- No pricing-model lock-in before adoption data is available
- Customer-managed deploy is the default; matches federal preference
  (no publisher persistent access into Gov subs)
- Loom remains **free in v1** — zero procurement friction beyond the
  customer's existing Azure agreement

### Negative

- No Marketplace discoverability in v1 — Loom needs marketing pull
  (PRP-21) to reach customers
- No publisher-push update channel — customers must `azd up` again or
  Console-pull updates via MCP (still works, but more manual)
- Some federal customers prefer Marketplace procurement for
  budgetary / compliance reasons (Marketplace purchases hit MACC
  commitments differently than direct Azure consumption); Loom can't
  offer that v1
- Loses the "AppSource" / "Microsoft Marketplace" SEO + discovery
  channel

### Neutral

- The Bicep platform underneath is identical to what a Managed App
  package would invoke — so v1.1 Marketplace publish is a wrapper
  exercise, not a rewrite
- All Console + Setup Wizard + parity services design is unchanged
  from the three-tier vision — they're deployed by `azd up` instead
  of by Managed App, but they run identically post-deploy

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Three-tier (Marketplace + azd + Deploy-to-Azure) in v1 | +6 weeks engineering; locks pricing model before adoption data |
| Marketplace-only | Federal customers reject publisher-managed; ~6 weeks engineering for a path they'd then opt out of |
| Single-tier (azd only) | Loses the evaluator-friendly Deploy-to-Azure button path; higher friction for first-time evaluators |
| Skip Marketplace work entirely (never plan a Managed App) | Forecloses on the long-term SaaS distribution path; not the user's preference (defer, not skip) |

## References

- PRD: [`temp/fiab-prd/07-deployment.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/07-deployment.md)
- Amendments: [`temp/fiab-prd/AMENDMENTS.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md) §A4
- Research: [`temp/fiab-research/05-eslz-marketplace.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-research/05-eslz-marketplace.md) (kept for v1.1 reference)
- Backlog: PRP-10 (Marketplace Managed App package) — deferred
- Build: PRP-02 (Platform Bicep) + PRP-11 (Deploy validation workflows)
