# Activator (Reflex) editor

!!! note "Superseded by the hands-on tutorial"
    This workload overview is superseded by the hands-on
    [Activator tutorial](../tutorials/editor-activator.md) (UAT-dated). See that
    guide for the current step-by-step.

The **Activator** editor is the rules engine over real-time data. Each
activator (also called a "reflex") owns 0..N rules ("triggers"); a rule binds a
data condition to an action. It runs **Azure-native by default — no Microsoft
Fabric required** (per `.claude/rules/no-fabric-dependency.md`).

## Backend

The Azure-native default backs each activator with a Cosmos item plus real
**Azure Monitor** scheduled-query alert rules. The rule source is an
**Eventhouse / KQL database on Azure Data Explorer (ADX)** by default, with
Log Analytics KQL and Event Hub as alternatives.

| Layer | Implementation (Azure-native default) |
|---|---|
| Item store | Cosmos item — the activator definition + its rules |
| Rules surface | `Microsoft.Insights/scheduledQueryRules` (+ action group) per rule |
| Rule source | ADX Eventhouse / KQL database (default); Log Analytics KQL; Event Hub |
| Auth | Console UAMI (`LOOM_UAMI_CLIENT_ID`), Monitoring Contributor on the alert RG |
| BFF routes | `GET/POST /api/items/activator` (list / create), `GET/PUT/DELETE /api/items/activator/[id]` (read / update / delete), `GET/POST /api/items/activator/[id]/rules` (list / add rule), `GET /api/items/activator/[id]/history` (fired-alert instances) |

> **Fabric opt-in:** set `LOOM_ACTIVATOR_BACKEND=fabric` to route to real Fabric
> Reflexes (`/v1/workspaces/{ws}/reflexes`) instead. When that env is unset —
> the default — Loom never calls `api.fabric.microsoft.com`.

## What works today

| Action | Backend call (Azure-native default) | Status |
|---|---|---|
| List activators in workspace | Cosmos query (+ opt-in Fabric reflexes merged on top when enabled) | live |
| Create activator | Cosmos upsert | live |
| Update activator | Cosmos upsert | live |
| Delete activator | Cosmos delete (+ best-effort remove of backing `scheduledQueryRules`) | live |
| List rules | Rules persisted on the Cosmos item | live |
| Add rule (KQL / condition + action) | `PUT Microsoft.Insights/scheduledQueryRules/{n}` (+ action group) | live |
| Trigger rule now | Evaluates the rule query on demand against the source | live |
| Run history | `GET` fired/resolved instances from Azure Monitor Alerts Management | live |

## Pre-requisites for real data

The Azure-native default needs an Azure Monitor target, not a Fabric tenant:

1. Set `LOOM_LOG_ANALYTICS_RESOURCE_ID` + `LOOM_ALERT_RG` on the Console (and
   `LOOM_ADX_ALERT_SCOPE` for hands-off ADX scheduled evaluation).
2. Grant the Console UAMI **Monitoring Contributor** on `LOOM_ALERT_RG` so it
   can create `scheduledQueryRules` + action groups (and **Database Viewer** on
   the ADX cluster for the alert identity).

If a prerequisite is missing, the editor surfaces a precise MessageBar naming
the exact env var / role to set — no mock data is shown, and no Fabric action
is ever required.

## Bicep

- Alert resource group + Log Analytics workspace: `platform/fiab/bicep/modules/admin-plane/monitor.bicep`
- UAMI + role grant: `platform/fiab/bicep/modules/admin-plane/uami.bicep`

## Env vars

| Variable | Purpose |
|---|---|
| `LOOM_UAMI_CLIENT_ID` | Console UAMI client id (workload identity) |
| `LOOM_LOG_ANALYTICS_RESOURCE_ID` | Log Analytics workspace for scheduled-query alert rules |
| `LOOM_ALERT_RG` | Resource group where `scheduledQueryRules` + action groups are created |
| `LOOM_ADX_ALERT_SCOPE` | ADX cluster resource id for hands-off scheduled ADX rule evaluation |
| `LOOM_ACTIVATOR_BACKEND` | Opt-in only — set to `fabric` to use real Fabric Reflexes instead of the Azure-native default |
