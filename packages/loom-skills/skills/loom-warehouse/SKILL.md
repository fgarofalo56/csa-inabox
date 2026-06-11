---
name: loom-warehouse
description: Azure-native warehouse in CSA Loom — back it with a Synapse dedicated SQL pool, never a Fabric Warehouse. Call synapse-sql-client.ts + synapse-pool-arm.ts via /api/warehouse and /api/synapse. Triggers on warehouse, data warehouse, SQL endpoint, dedicated pool, T-SQL, DWU, scale warehouse.
allowed-tools: Read, Grep, Glob, Bash
---

# loom-warehouse — Synapse dedicated SQL pool (the Azure-native Fabric Warehouse)

A Loom **warehouse** is a **Synapse dedicated SQL pool** (with Serverless for
ad-hoc lakehouse queries). It is NOT a Fabric Warehouse. The backend is selected
by `LOOM_WAREHOUSE_BACKEND` (default = synapse); `fabric` is opt-in only.

## Clients

`apps/fiab-console/lib/azure/synapse-sql-client.ts` (TDS query) and
`synapse-pool-arm.ts` (ARM control plane — create/pause/resume/scale DWU).

Real exported symbols:

```ts
// synapse-sql-client.ts
export interface SynapseTarget { /* server, database, ... */ }
export function getSynapseSqlSuffix(): string;            // from cloud-endpoints synapseSqlSuffix()
export function dedicatedTarget(): SynapseTarget;         // the dedicated pool
export function serverlessTarget(database?: string): SynapseTarget;
export function serverlessEndpoint(): string;
export interface QueryResult { /* columns, rows, rowCount, ... */ }
export interface SynapseQueryParam { /* name, value, type */ }
export async function executeQuery(target: SynapseTarget, sqlText: string, timeoutMs?: number, parameters?: SynapseQueryParam[], queryId?: string): Promise<QueryResult>;
export async function explainQuery(/* ... */): Promise<...>;       // EXPLAIN plan
export async function executeQueryAsUser(/* ... */): Promise<...>; // on-behalf-of
export function cancelActiveQuery(queryId: string): boolean;
```

Queries authenticate with an AAD access token over TDS (mssql driver). The SQL
host suffix is `synapseSqlSuffix()` from `cloud-endpoints.ts` and the JDBC cert
host is `synapseSqlJdbcHostCert()` — both sovereign-correct.

## Auth

UAMI-first chain; token audience is the SQL resource (`getSqlSuffix()`). The
UAMI must be an AAD admin / db user on the pool (granted in bicep `integration`).

## BFF routes

`/api/warehouse/**`, `/api/synapse/**`. Validate session → gate on
`LOOM_SYNAPSE_WORKSPACE` → run real TDS via `executeQuery(dedicatedTarget(), …)`
→ `{ ok, data: { columns, rows } }`. Long queries support `queryId` +
`cancelActiveQuery()`.

## Do / don't

- DO use `dedicatedTarget()` for warehouse T-SQL and `serverlessTarget()` for
  ad-hoc reads over lakehouse Delta.
- DO parameterise via `SynapseQueryParam[]` — never string-concat user input.
- DON'T call the Fabric Warehouse SQL endpoint on the default path.
- DON'T hard-code `sql.azuresynapse.net`; use `getSynapseSqlSuffix()`.

## Cross-links

UI parity: `docs/fiab/parity/warehouse.md` (+ `synapse-*` docs). Backend map row:
warehouse in `.claude/rules/no-fabric-dependency.md`.
