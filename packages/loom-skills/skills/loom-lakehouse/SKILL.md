---
name: loom-lakehouse
description: Azure-native lakehouse in CSA Loom — store data as ADLS Gen2 + Delta and register tables in Synapse, never OneLake/Fabric. Call adls-client.ts + synapse-sql-client.ts via /api/lakehouse and /api/onelake. Triggers on lakehouse, Delta table, ADLS, OneLake, medallion, bronze/silver/gold, shortcut, file upload.
allowed-tools: Read, Grep, Glob, Bash
---

# loom-lakehouse — ADLS Gen2 + Delta (the Azure-native OneLake)

A Loom **lakehouse** is an **ADLS Gen2** storage account holding **Delta** tables
in a medallion layout, with table metadata registered in **Synapse Serverless
SQL**. It is NOT a Fabric/OneLake lakehouse. No Fabric workspace is required.

## Clients

`apps/fiab-console/lib/azure/adls-client.ts` (storage data plane) and
`synapse-sql-client.ts` (table registration / query).

Real exported symbols (quote these, don't invent):

```ts
// adls-client.ts
export const KNOWN_CONTAINERS = ['bronze', 'silver', 'gold', 'landing', 'csv-imports'] as const;
export type KnownContainer = (typeof KNOWN_CONTAINERS)[number];
export function getServiceClient(): DataLakeServiceClient;       // uses LOOM_ADLS_ACCOUNT
export function getServiceClientFor(account: string): DataLakeServiceClient;
export function getAccountName(): string;
export interface ContainerInfo { /* name, ... */ }
export async function listContainers(): Promise<ContainerInfo[]>;
export interface PathEntry { /* name, isDirectory, contentLength, ... */ }
export type BlobAccessTier = 'Hot' | 'Cool' | 'Cold';
export async function uploadBlob(/* container, path, body, ... */): Promise<...>;
export interface ReadSasUrl { /* url, expiresOn */ }

// synapse-sql-client.ts
export function serverlessTarget(database?: string): SynapseTarget;
export function buildDeltaOpenRowsetSql(deltaBulkUrl: string, maxRows?: number): string; // query a Delta folder
export async function executeQuery(target, sqlText, timeoutMs?, parameters?, queryId?): Promise<QueryResult>;
```

The DataLakeServiceClient is built from `dfsUrl(getAccountName())` — the DFS host
comes from `cloud-endpoints.ts` (`dfsSuffix()`), so it is sovereign-correct.
Containers are the **enumerated** `KNOWN_CONTAINERS` allow-list (bronze/silver/
gold/landing/csv-imports) — present these as a dropdown, never a free-form box.

## Auth

UAMI-first chain (see `loom-cloud-endpoints`). The storage `.default` scope is
derived from the cloud; the UAMI needs **Storage Blob Data Contributor** on the
account (granted in `platform/fiab/bicep/modules/landing-zone`).

## BFF routes

`/api/lakehouse/**` and `/api/onelake/**`. Each validates the session, applies a
config gate on `LOOM_ADLS_ACCOUNT`, calls a real ADLS / Synapse operation, and
returns `{ ok, data } | { ok: false, error, code }`. To read a Delta table the
route runs `buildDeltaOpenRowsetSql()` against `serverlessTarget()` — real TDS,
no mock rows.

## Shortcuts

Lakehouse "shortcuts" (the OneLake feature) are implemented Azure-native via
`shortcut-client.ts` (ADLS-to-ADLS / external account references). They do not
call OneLake.

## Do / don't

- DO write files to a `KnownContainer` and register Delta tables via Synapse.
- DO gate honestly on `LOOM_ADLS_ACCOUNT` when unset (HTTP 503, name the var).
- DON'T call `onelake.dfs.fabric.microsoft.com` on the default path — that is the
  opt-in Fabric backend only (`LOOM_LAKEHOUSE_BACKEND=fabric`).
- DON'T hard-code `.dfs.core.windows.net`; use `dfsUrl()`.

## Cross-links

UI parity: `docs/fiab/parity/lakehouse.md`. Backend map row: lakehouse in
`.claude/rules/no-fabric-dependency.md`.
