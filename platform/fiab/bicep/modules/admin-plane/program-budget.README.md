# program-budget.bicep — loom-next-level run-rate budget (COST0)

A subscription-scoped `Microsoft.Consumption/budgets` ceiling filtered on the
**`loom-next-level`** resource tag, with **Actual 80% / Actual 100% /
Forecasted 100%** notifications through the shared default action group
(`monitoring-default-alerts.bicep::loom-default-alerts`) + the subscription
**Owner** contact role. Wired by the top-level orchestrator
(`platform/fiab/bicep/main.bicep`) off the `observabilityConfig` bag —
default-ON, `~$0` (a budget object is free; it *bounds* spend).

## Config (rides the existing `observabilityConfig` bag — no new top-level params)

| Bag property | Default | Meaning |
|---|---|---|
| `programBudgetEnabled` | `true` | Opt out (e.g. MSDN/sponsored offers where the budgets API is unsupported). |
| `programBudgetAmount` | `1000` | Monthly ceiling (billing currency; USD on the Loom estates). |
| `programBudgetContactEmails` | `[]` | Optional extra emails (finops DL) beyond the action group + Owners. |

## Tag convention (what the budget counts)

Every Azure resource the loom-next-level program deploys carries
**`loom-next-level: 'true'`** in its bicep module
(`tags: union(complianceTags, { 'loom-next-level': 'true' })`). The budget's
tag filter aggregates exactly those resources. **A program resource without
the tag is invisible to the ceiling — adding the tag line is part of the
item's bicep-sync obligation** (see the PRP master's bicep-sync standard).

Tag caveat: tag values take up to ~24h to flow into cost data after first
apply, and the filter counts only *taggable, metered* resources (role
assignments, budgets, and alert rules are free/untaggable — nothing lost).

## Always-on run-rate inventory (what this budget bounds)

The ~8 structurally always-on cost items the program stands up (per the PRP
round-3 F1 cost-note convention). Tagged modules are live today; future items
MUST add the tag when they land:

| # | Item | Resource (bicep module) | Status | Est. run-rate |
|---|------|-------------------------|--------|---------------|
| 1 | V1 synthetic journeys | `synthetic-monitor-job.bicep` ACA Schedule job (4x/hr) + Blob artifacts (30d lifecycle, `landing-zone/storage.bicep`) | **live, tagged** | ~$30–60/mo per cloud |
| 2 | E2 Copilot LLM-judge | `copilot-evaluator-function.bicep` (Y1 ~$0 idle) + AOAI judge tokens, capped 500/day | **live, tagged** | token spend, day-capped |
| 3 | S1 secret-expiry monitor | `secret-expiry-monitor-function.bicep` (Y1) | **live, tagged** | ~$0 idle |
| 4 | N1 `iceberg-catalog` | ACA always-on (future WS-N) | future — tag on land | ~$30–100/mo |
| 5 | N2b `loom-duckdb` | ACA always-on (future WS-N) | future — tag on land | ~$30–100/mo |
| 6 | N3 `loom-flightsql` | ACA always-on (future WS-N) | future — tag on land | ~$30–100/mo |
| 7 | N4 `loom-transform-runner` | ACA always-on (future WS-N) | future — tag on land | ~$30–100/mo |
| 8 | N7a/N7e RisingWave / Trino (opt-in) | ACA always-on (future WS-N) | future — tag on land | ~$50–150/mo |
| + | A14 Azure Web PubSub (when opted in), V2 visual-regression artifacts, RUM1 ingestion | future items | future — tag on land | low |

Default ceiling `$1000/mo` covers the currently-tagged items with ample
headroom; revisit (bump the bag property) as the N-services land — the
Forecasted-100% notification is the early tripwire.

## Where it surfaces

- `/monitor` → **Cost** tab → **Budgets** section: `lib/azure/cost-client.ts`
  `listBudgets()` enumerates subscription-scope Consumption budgets, so
  `loom-next-level-program` renders (ceiling, current burn, % used) with zero
  new UI — the platform monitors its own spend.
- A dedicated "Program run-rate" row on `/admin/finops` rides the C4 finops
  surface when it lands (page does not exist yet).

## Env / ENV_CHECKS

None — infra-only. No runtime env var is read by the console for this item
(the budget is discovered generically by `listBudgets()`), so per the G2
standard no ENV_CHECKS/GATE_META row is added.

## Per-cloud

- **Commercial:** live on the next infra deploy.
- **Gov:** Microsoft.Consumption/budgets is GA in Azure Government (Cost
  Management is in-boundary; C1/C2 findings). Same module; deployed via the
  Gov SP's next `az deployment sub create`.
- **IL5:** in-boundary Cost Management only; notifications terminate at the
  in-boundary action group / subscription Owners — no external egress.

## Rollback

The budget is a free, standalone object: `az consumption budget delete
--budget-name loom-next-level-program` (or set
`observabilityConfig.programBudgetEnabled=false` and redeploy). No dependents.
