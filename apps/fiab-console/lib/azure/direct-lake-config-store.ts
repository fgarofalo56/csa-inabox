/**
 * direct-lake-config-store — Cosmos read/write for the Direct-Lake-shim's
 * per-semantic-model refresh policy.
 *
 * The C# shim (`apps/fiab-direct-lake-shim`) reads its config from a SEPARATE
 * Cosmos database — `direct-lake-config`, container `refresh-policies` — NOT
 * the main `loom` database that cosmos-client.ts owns. This module is the
 * Console's writer for that same store: the Direct Lake (shim) tab in the
 * SemanticModelEditor PUTs a config here, and the running shim picks it up on
 * its next 60-s cache refresh and starts dispatching partition refreshes on
 * each `_delta_log` Event Grid notification.
 *
 * The document shape is the 1:1 TypeScript mirror of the C# record
 * `SemanticModelConfig` (Models/RefreshPolicy.cs) — same field names (camelCase
 * here, PascalCase in C#; the System.Text.Json default binder is
 * case-insensitive so both bind), same `tables` map keyed by "schema.table".
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) via ManagedIdentityCredential
 * chained with DefaultAzureCredential — the UAMI holds Cosmos DB Built-in Data
 * Contributor at account scope (same grant cosmos-client.ts relies on). The
 * database + container are created on first write (createIfNotExists) so a
 * fresh environment needs no extra ARM/Bicep step beyond the account.
 */

import type { Container } from '@azure/cosmos';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

/** Per-table refresh policy — mirrors C# `RefreshPolicyKind`. */
export type ShimRefreshPolicy = 'Partition' | 'Full' | 'DirectQueryFallback' | 'Composite';

export const SHIM_REFRESH_POLICIES: ShimRefreshPolicy[] = [
  'Partition',
  'Full',
  'DirectQueryFallback',
  'Composite',
];

/** Mirror of C# `TableRefreshConfig`. */
export interface ShimTableConfig {
  tableName: string;
  policy: ShimRefreshPolicy;
  /** For Partition policy: column used to derive the partition key (e.g. "event_date"). */
  partitionColumn?: string;
  /** Max partition refresh staleness — the shim warns if exceeded. */
  maxStalenessSeconds?: number;
}

/** Mirror of C# `SemanticModelConfig` + the shim-wiring fields the Console adds. */
export interface DirectLakeShimConfig {
  /** Document id — the Power BI dataset id (matches the shim's lookup key). */
  id: string;
  workspaceId: string;
  powerBIWorkspaceId: string;
  datasetId: string;
  /** powerbi://{host}/v1.0/myorg/{ws} — handed to the shim's TomRefreshClient. */
  xmlaEndpoint: string;
  /** ADLS Gen2 source path of the Delta table(s) — abfss:// or https://…dfs… */
  deltaSourcePath: string;
  /** Freshness SLA in seconds (300=5m, 900=15m, 3600=1h, -1=on-change). */
  freshnessSlaSeconds: number;
  /** Per-table policy, keyed by "schema.table" (the shim's lookup key). */
  tables: Record<string, ShimTableConfig>;
  updatedAt?: string;
  updatedBy?: string;
}

const DB_ID = process.env.LOOM_DIRECT_LAKE_COSMOS_DB || 'direct-lake-config';
const CONTAINER_ID = process.env.LOOM_DIRECT_LAKE_COSMOS_CONTAINER || 'refresh-policies';

let _client: any = null;
let _container: Container | null = null;

function endpoint(): string {
  const v = process.env.LOOM_COSMOS_ENDPOINT;
  if (!v) throw new Error('LOOM_COSMOS_ENDPOINT not set — cannot reach the Direct-Lake-shim config store');
  return v;
}

// @azure SDKs are dynamic-imported on first use so this module carries no
// top-level Azure-SDK import — the pure exports (SHIM_REFRESH_POLICIES + types)
// stay unit-testable in isolation.
async function credential() {
  const { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } = await import('@azure/identity');
  const clientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const chain: any[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  return new ChainedTokenCredential(new AcaManagedIdentityCredential(), ...chain);
}

async function client(): Promise<any> {
  if (_client) return _client;
  const { CosmosClient } = await import('@azure/cosmos');
  _client = new CosmosClient({ endpoint: endpoint(), aadCredentials: await credential() });
  return _client;
}

async function container(): Promise<Container> {
  if (_container) return _container;
  const { database } = await (await client()).databases.createIfNotExists({ id: DB_ID });
  const { container: c } = await database.containers.createIfNotExists({
    id: CONTAINER_ID,
    partitionKey: { paths: ['/id'] },
  });
  _container = c;
  return c;
}

/** Read the shim config for a dataset id. Returns null when none is stored. */
export async function getShimConfig(datasetId: string): Promise<DirectLakeShimConfig | null> {
  const c = await container();
  try {
    const { resource } = await c.item(datasetId, datasetId).read<DirectLakeShimConfig>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Upsert the shim config (id = datasetId). Stamps updatedAt/updatedBy. */
export async function upsertShimConfig(
  cfg: DirectLakeShimConfig,
  updatedBy?: string,
): Promise<DirectLakeShimConfig> {
  const c = await container();
  const doc: DirectLakeShimConfig = {
    ...cfg,
    updatedAt: new Date().toISOString(),
    ...(updatedBy ? { updatedBy } : {}),
  };
  const { resource } = await c.items.upsert<DirectLakeShimConfig>(doc);
  return (resource as DirectLakeShimConfig) ?? doc;
}
