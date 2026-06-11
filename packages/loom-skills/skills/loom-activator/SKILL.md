---
name: loom-activator
description: Azure-native activator (Reflex) in CSA Loom — back it with an Azure Monitor scheduled-query alert (or Logic App), never Fabric Activator. Call monitor-client.ts via /api/monitor. Triggers on activator, Reflex, alert, trigger, scheduled query rule, action group, notification, data activator.
allowed-tools: Read, Grep, Glob, Bash
---

# loom-activator — Azure Monitor scheduled-query alert (the Azure-native Reflex)

A Loom **activator** is an **Azure Monitor scheduled-query alert rule** (with an
action group), or a Logic App for richer actions. It is NOT a Fabric Activator
(Reflex). The Fabric Activator REST API has no Government endpoint, so the
Azure-native path is the only one available in GCC-High / DoD anyway.

## Client

`apps/fiab-console/lib/azure/monitor-client.ts`.

Real exported symbols:

```ts
export class MonitorError extends Error {}
export class MonitorNotConfiguredError extends Error {}
export interface MonitorConfig { /* subscription, resourceGroup, workspaceId, ... */ }
export function readMonitorConfig(): MonitorConfig;            // honest gate via the Not-Configured error
export function logAnalyticsWorkspaceId(): string | null;
export interface LoomResource { /* id, name, type, ... */ }
export async function listResources(): Promise<LoomResource[]>;
export interface ResourceHealthStatus { /* availabilityState, ... */ }
export async function listResourceHealth(): Promise<Record<string, ResourceHealthStatus>>;
export interface MetricResult { /* series points */ }
export interface FetchMetricsOpts { /* resourceId, metric, timespan, ... */ }
// scheduledQueryRules list/create/delete back the activator rule lifecycle
```

`getMonitorBase()` / `getMonitorScope()` (= `armBase()`/`armScope()`) and
`getLogAnalyticsHost()` keep the hosts sovereign-correct.

## Auth

UAMI-first chain at `armScope()`. The UAMI needs **Monitoring Contributor** to
create scheduled-query rules + action groups, and **Log Analytics Reader** for
the query data plane (bicep `admin-plane`).

## BFF routes

`/api/monitor/**`. Validate session → `readMonitorConfig()` (throws
`MonitorNotConfiguredError` → 503 honest gate) → real ARM
`Microsoft.Insights/scheduledQueryRules` create/list/delete → `{ ok, data }`.
The rule's query is a KQL condition over the Log Analytics workspace; firing
notifies the action group.

## Do / don't

- DO create the alert as `Microsoft.Insights/scheduledQueryRules` with a real
  KQL condition + action group.
- DO gate honestly when the Monitor config / workspace is unset.
- DON'T call the Fabric Activator/Reflex REST API on the default path (and it is
  blocked entirely in Gov via `assertFabricFamilyAvailable('activator')`).

## Cross-links

UI parity: `docs/fiab/parity/activator.md`, `activator-rule-wizard.md`,
`activator-action-editor.md`. Backend map row: activator in
`.claude/rules/no-fabric-dependency.md`.
