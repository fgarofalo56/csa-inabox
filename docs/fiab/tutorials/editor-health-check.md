# Tutorial: Health check editor

> CSA Loom `health-check` editor — the Azure-native equivalent of Palantir
> Foundry **Health Checks**: data-freshness and SLA monitoring backed by real
> **Azure Monitor scheduled-query alert rules** over Log Analytics. **No
> Microsoft Fabric required.**

## What it is

Foundry Health Checks watch pipelines and datasets for freshness and SLA
breaches. The Loom equivalent creates real **Azure Monitor scheduled-query alert
rules** (`Microsoft.Insights/scheduledQueryRules`) over a **Log Analytics**
workspace that fire when an item's data goes stale or a row-count / freshness
threshold is crossed. This is the Azure-native default; Fabric Reflex is opt-in
via `LOOM_ACTIVATOR_BACKEND=fabric`.

## When to use it

- You need to be alerted when a table stops updating, a load produces too few
  rows, or a custom KQL condition trips.
- You want an SLA / freshness monitor that is a real Azure alert rule (visible in
  Azure Monitor, wired to action groups), not an in-app timer.
- You want a single board of checks with open-alert counts and matched-row
  detail.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Health check** (Fabric IQ). The
   editor opens at `/items/health-check/<id>` with five tabs: **Checks**,
   **Status**, **History**, **Notifications**, and **Settings**.
2. **Pick a check type.** Browse the check-type gallery — **21 typed checks**
   across five families: **Time & freshness** (data freshness, maximum age,
   future timestamps), **Size & volume** (min/max row count, distinct count,
   volume drop), **Content & values** (nulls, blanks, duplicates, aggregate
   threshold, out-of-range, allowed values, pattern mismatch, error events),
   **Schema** (column present, column type, column-count drift), and
   **Status & custom** (liveness heartbeat, custom KQL).
3. **Fill the typed wizard.** Each check type opens a structured wizard (table,
   column, operator, threshold — no freeform JSON) with a live **KQL preview**
   of the exact condition the rule will evaluate; **Run live sample** executes
   it against the workspace before you commit.
4. **Set the schedule.** Choose how often the rule evaluates and the lookback
   window (for example, evaluate every 5 minutes over the last 15 minutes).
5. **Wire notifications.** The **Notifications** tab manages Azure Monitor
   **action groups** (email, SMS, webhook receivers) with a real **test-fire**
   so you can verify delivery before an alert ever trips.
6. **Create the rule.** Click **Create rule**. Loom creates the real
   `scheduledQueryRule` on Azure Monitor, or shows exactly which env var / RBAC
   grant is missing (honest gate).
7. **Monitor the board.** The **Status** tab shows **Total checks**, **Open
   alerts**, and each check's status and matched rows; **History** lists fired
   alerts and their resolution state.

## The Azure backend it rides on

- **Alert rules:** **Azure Monitor** `scheduledQueryRules` over a **Log Analytics**
  workspace.
- **Notifications:** Azure Monitor **action groups** (email receivers).
- **RBAC:** the Console UAMI needs **Monitoring Contributor** on the alert scope;
  a missing grant surfaces as a precise remediation message.

## No Fabric required

Health checks are real Azure Monitor alert rules by default — no Fabric Reflex,
capacity, or workspace. Fabric Activator is available only as an explicit opt-in
(`LOOM_ACTIVATOR_BACKEND=fabric`).

## Learn more

- Azure Monitor log alerts:
  <https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-types#log-alerts>
- Scheduled query rules:
  <https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-create-log-alert-rule>
