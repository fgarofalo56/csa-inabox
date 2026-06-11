---
name: loom-eventhouse-kql
description: Azure-native Eventhouse/KQL in CSA Loom — call Azure Data Explorer (ADX) via kusto-client.ts + kusto-arm-client.ts, never Fabric RTI. Use /api/adx routes. Triggers on KQL, Eventhouse, ADX, Kusto, real-time intelligence, KQL database, KQL dashboard, ingestion mapping, materialized view, RLS.
allowed-tools: Read, Grep, Glob, Bash
---

# loom-eventhouse-kql — Azure Data Explorer (the Azure-native Fabric RTI)

A Loom **kql-database / eventhouse** is an **Azure Data Explorer (ADX)** cluster +
database. A **kql-dashboard** is a Loom-native dashboard whose tiles query ADX.
Neither uses Fabric Real-Time Intelligence.

## Clients

`apps/fiab-console/lib/azure/kusto-client.ts` (data plane — query + control
commands) and `kusto-arm-client.ts` (ARM — cluster lifecycle, data connections).

Real exported symbols:

```ts
// kusto-client.ts
export class KustoError extends Error { /* status */ }
export interface KustoQueryResult { /* columns, rows, visualizations, ... */ }
export interface KustoVisualization { /* ... */ }
export function clusterUri(): string;                 // from kustoClusterUri()/LOOM_KUSTO_CLUSTER_URI
export function defaultDatabase(): string;            // LOOM_KUSTO_DATABASE
export function kustoConfigGate(): { missing: string } | null;   // honest gate
export async function executeQuery(database: string, kql: string): Promise<KustoQueryResult>;
export async function executeMgmtCommand(database: string, command: string): Promise<KustoQueryResult>;
export async function listDatabases(): Promise<Array<{ name: string; prettyName?: string; persistentStorage?: string }>>;
// Log Analytics proxy (query LA via the Kusto endpoint):
export function laProxyClusterUri(): string | null;
export function laConfigGate(): { missing: string } | null;

// kusto-arm-client.ts
export class KustoNotConfiguredError extends Error {}
export function readKustoArmConfig(): KustoClusterArmConfig;
export async function getKustoClusterArm(): Promise<KustoClusterArm>;
export async function updateKustoClusterSku(/* ... */): Promise<...>;
export async function startKustoCluster(): Promise<{ provisioningState: string }>;
export async function stopKustoCluster(): Promise<{ provisioningState: string }>;
export type DataConnectionDataFormat = /* ... */;     // Event Hub / IoT ingestion
```

`clusterUri()` is built from `kustoClusterUri(name, region)` (sovereign-correct
`kustoSuffix()`); never write `kusto.windows.net` directly.

## Auth

UAMI-first chain; the ADX SDK takes the cluster URI as the token resource. The
UAMI needs **AllDatabasesViewer/Admin** (or table-level) on the cluster, plus
**Contributor** on the cluster ARM resource for lifecycle ops (bicep `ai`/`integration`).

## BFF routes

`/api/adx/**` — `overview`, `tables`, `functions`, `policies`, `principals`,
`rls`, `ingestion-mappings`, `materialized-views`. The shared guard
(`app/api/adx/_shared.ts`) validates session, applies `kustoConfigGate()`
(`LOOM_KUSTO_CLUSTER_URI`), resolves the per-item database from `?id=<kql-database>`
(falling back to `defaultDatabase()`), then runs a **real** `.show`/`.alter`
control command via `executeMgmtCommand()`. Returns `{ ok, ... }`.

## Do / don't

- DO use `executeQuery()` for KQL reads and `executeMgmtCommand()` for `.show`/`.alter`/`.create` control.
- DO honor `kustoConfigGate()` — return 503 `not_configured` naming `LOOM_KUSTO_CLUSTER_URI` when unset.
- DON'T call the Fabric RTI / Eventhouse REST API on the default path.
- DON'T hard-code the cluster suffix; resolve via `clusterUri()`.

## Cross-links

UI parity: `docs/fiab/parity/eventhouse.md`, `kql-*` docs. Backend map rows:
kql-database / eventhouse / kql-dashboard in `.claude/rules/no-fabric-dependency.md`.
