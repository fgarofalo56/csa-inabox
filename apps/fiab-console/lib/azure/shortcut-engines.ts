/**
 * Shortcut engines — resolve a shortcut definition to a real Azure read path
 * and (for Tables shortcuts) register a real external table queryable from the
 * lakehouse's SQL / Notebook surfaces.
 *
 * Engines (per docs/fiab/design/lakehouse-shortcuts.md §2):
 *   - ADLS Gen2 / internal Loom lakehouse  → resolve to abfss:// via the
 *     Console UAMI; Files = registry pointer + listPaths reachability test;
 *     Tables = CREATE EXTERNAL TABLE on Synapse Serverless (preferred when
 *     LOOM_SYNAPSE_WORKSPACE set) else Databricks UC (LOOM_DATABRICKS_HOSTNAME)
 *     else honest-gate.
 *   - S3 / GCS / Dataverse → honest-gate until a Key Vault credentialRef is
 *     configured.
 *
 * NO Fabric dependency. NO mock data. Every call hits a real Azure backend or
 * returns a precise honest-gate { gated, hint }.
 */

import { listPaths } from './adls-client';
import { serverlessTarget, executeQuery } from './synapse-sql-client';
import { listWarehouses, executeStatement, databricksConfigGate } from './databricks-client';
import type { ShortcutTargetType, ShortcutKind, ShortcutEngine } from './lakehouse-shortcuts';

/** An honest-gate result — the control rendered, but a credential/resource is missing. */
export interface EngineGate {
  gated: true;
  /** Machine code for the UI (e.g. 'needs_credential', 'no_tables_engine'). */
  code: string;
  /** Human hint naming the exact env var / KV secret / role to provision. */
  hint: string;
}

export interface ResolveResult {
  abfssUri?: string;
  /** Validated reachable (for ADLS/internal Files). */
  reachable?: boolean;
}

export interface TablesRegistration {
  engine: ShortcutEngine;
  engineObject: string;
}

const ABFSS_RE = /^abfss:\/\/([^@]+)@([^/]+)\.dfs\.core\.windows\.net\/(.*)$/i;
const HTTPS_DFS_RE = /^https:\/\/([^.]+)\.dfs\.core\.windows\.net\/([^/]+)\/(.*)$/i;

export interface AbfssParts {
  container: string;
  account: string;
  path: string;
  abfss: string;
}

/**
 * Resolve any supported ADLS/internal target URI to canonical abfss parts.
 * Accepts:
 *   abfss://<container>@<acct>.dfs.core.windows.net/<path>
 *   https://<acct>.dfs.core.windows.net/<container>/<path>
 *   internal://<container>/<path>  (internal Loom lakehouse, account-relative)
 */
export function parseAbfss(targetUri: string, internalAccount?: () => string): AbfssParts | null {
  const u = (targetUri || '').trim();
  let m = u.match(ABFSS_RE);
  if (m) {
    const [, container, account, path] = m;
    return { container, account, path: path.replace(/^\/+/, ''), abfss: u };
  }
  m = u.match(HTTPS_DFS_RE);
  if (m) {
    const [, account, container, path] = m;
    const clean = path.replace(/^\/+/, '');
    return { container, account, path: clean, abfss: `abfss://${container}@${account}.dfs.core.windows.net/${clean}` };
  }
  const internal = u.match(/^internal:\/\/([^/]+)\/?(.*)$/i);
  if (internal && internalAccount) {
    const [, container, path] = internal;
    const account = internalAccount();
    const clean = (path || '').replace(/^\/+/, '');
    return { container, account, path: clean, abfss: `abfss://${container}@${account}.dfs.core.windows.net/${clean}` };
  }
  return null;
}

/**
 * Test reachability of an ADLS/internal target path via a real listPaths on
 * the Console UAMI. Resolves to { reachable, abfssUri } or throws the raw
 * Azure error (the route maps it to a precise message).
 */
export async function resolveAndTestAdls(
  targetType: ShortcutTargetType,
  targetUri: string,
  internalAccount?: () => string,
): Promise<ResolveResult> {
  const parts = parseAbfss(targetUri, internalAccount);
  if (!parts) {
    throw Object.assign(new Error(`Target URI is not a valid ADLS Gen2 / internal path: ${targetUri}`), { code: 'bad_target' });
  }
  // Real listPaths against the target container+path on the TARGET account
  // (NOT Loom's default account) proves the UAMI can read it. Requires the
  // Console UAMI to have Storage Blob Data Reader on parts.account — see
  // scripts/csa-loom/grant-shortcut-storage-rbac.sh.
  await listPaths(parts.container, parts.path, 1, parts.account);
  return { abfssUri: parts.abfss, reachable: true };
}

/** Which Tables engine is available, in preference order (Synapse, then Databricks). null = none. */
export function pickTablesEngine(): ShortcutEngine | null {
  if (process.env.LOOM_SYNAPSE_WORKSPACE) return 'synapse';
  if (!databricksConfigGate()) return 'databricks';
  return null;
}

/** Synapse Serverless external-table / view object name for a shortcut. */
function synapseObject(name: string): string {
  const safe = name.replace(/[^a-z0-9_]+/gi, '_');
  return `shortcuts.${safe}`;
}

/** Databricks UC fully-qualified table for a shortcut. */
function ucObject(lakehouseId: string, name: string): string {
  const cat = 'loom';
  const sch = lakehouseId.replace(/[^a-z0-9_]+/gi, '_').toLowerCase() || 'shortcuts';
  const tbl = name.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  return `${cat}.${sch}.${tbl}`;
}

const FORMAT_SQL: Record<string, string> = {
  delta: 'DELTA',
  parquet: 'PARQUET',
  csv: 'CSV',
  json: 'JSON',
};

/**
 * Register a Tables shortcut as a real external table on the chosen engine.
 * Returns { engine, engineObject } on success, or an EngineGate when no Tables
 * engine is configured. Throws the raw engine error on a real SQL/DDL failure.
 */
export async function createTablesShortcut(args: {
  lakehouseId: string;
  name: string;
  abfssUri: string;
  format?: 'delta' | 'parquet' | 'csv' | 'json';
}): Promise<TablesRegistration | EngineGate> {
  const engine = pickTablesEngine();
  if (!engine) {
    return {
      gated: true,
      code: 'no_tables_engine',
      hint:
        'A Tables shortcut registers a real external table, which needs a query engine. ' +
        'Set LOOM_SYNAPSE_WORKSPACE (Synapse Serverless — preferred) or LOOM_DATABRICKS_HOSTNAME ' +
        '(Databricks Unity Catalog) so the shortcut can be created as an external table. ' +
        'Files shortcuts work without either engine.',
    };
  }
  const fmt = FORMAT_SQL[args.format || 'delta'] || 'DELTA';

  if (engine === 'synapse') {
    const obj = synapseObject(args.name);
    const parts = parseAbfss(args.abfssUri);
    if (!parts) {
      throw Object.assign(new Error(`Cannot resolve abfss for Synapse OPENROWSET: ${args.abfssUri}`), { code: 'bad_target' });
    }
    // Synapse OPENROWSET BULK takes the https DFS endpoint, not abfss://.
    const bulkUrl = `https://${parts.account}.dfs.core.windows.net/${parts.container}/${parts.path}`;
    const csvOpts = fmt === 'CSV' ? `, PARSER_VERSION = ''2.0'', HEADER_ROW = TRUE` : '';
    // Idempotent external view: drop + recreate so re-creating a shortcut is an
    // upsert (matches the registry's deterministic id).
    const ddl =
      `IF SCHEMA_ID('shortcuts') IS NULL EXEC('CREATE SCHEMA shortcuts');\n` +
      `IF OBJECT_ID('${obj}','V') IS NOT NULL DROP VIEW ${obj};\n` +
      `EXEC('CREATE VIEW ${obj} AS SELECT * FROM OPENROWSET(BULK ''${bulkUrl}'', FORMAT = ''${fmt}''${csvOpts}) AS r');`;
    await executeQuery(serverlessTarget('master'), ddl);
    return { engine, engineObject: obj };
  }

  // Databricks Unity Catalog — needs a running SQL Warehouse to run the DDL.
  const obj = ucObject(args.lakehouseId, args.name);
  const warehouses = await listWarehouses();
  const wh = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
  if (!wh) {
    return {
      gated: true,
      code: 'no_warehouse',
      hint:
        'Databricks is configured but the workspace has no SQL Warehouse to run the external-table DDL. ' +
        'Create a SQL Warehouse (Compute → SQL Warehouses) or set LOOM_SYNAPSE_WORKSPACE to use Synapse Serverless instead.',
    };
  }
  const [cat, sch, tbl] = obj.split('.');
  const ddl =
    `CREATE SCHEMA IF NOT EXISTS ${cat}.${sch};\n` +
    `CREATE TABLE IF NOT EXISTS ${cat}.${sch}.${tbl} ` +
    `USING ${fmt} LOCATION '${args.abfssUri}';`;
  await executeStatement(wh.id, ddl);
  return { engine, engineObject: obj };
}

/** Drop the engine object backing a Tables shortcut. Never deletes source bytes. */
export async function dropShortcutObject(args: {
  engine?: ShortcutEngine;
  engineObject?: string;
}): Promise<void> {
  if (!args.engine || args.engine === 'none' || !args.engineObject) return;
  if (args.engine === 'synapse') {
    await executeQuery(
      serverlessTarget('master'),
      `IF OBJECT_ID('${args.engineObject}','V') IS NOT NULL DROP VIEW ${args.engineObject};`,
    );
    return;
  }
  if (args.engine === 'databricks') {
    const warehouses = await listWarehouses();
    const wh = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
    if (wh) await executeStatement(wh.id, `DROP TABLE IF EXISTS ${args.engineObject};`);
  }
}

/**
 * Honest-gate for external cloud sources (S3/GCS/Dataverse). Returns a gate
 * unless a Key Vault credentialRef is configured. v1 always gates these on
 * create (the full wizard still renders) per the no-vaporware honest-config rule.
 */
export function externalSourceGate(targetType: ShortcutTargetType, hasCredentialRef: boolean): EngineGate | null {
  if (targetType === 'adls' || targetType === 'internal') return null;
  if (hasCredentialRef) {
    // A credentialRef points at a KV secret the operator must have provisioned;
    // resolving + wiring the UC storage credential / Synapse scoped credential
    // is the PR-4 follow-up. Until that lands, gate honestly even WITH a ref.
    return {
      gated: true,
      code: 'external_credential_pending',
      hint:
        `${labelFor(targetType)} shortcuts with a Key Vault credential are tracked for the ` +
        'next build (UC storage-credential / Synapse scoped-credential wiring). The credential ' +
        'reference was saved; the read-through binding lands in a follow-up.',
    };
  }
  const secret =
    targetType === 's3' ? 'an AWS access key/secret (or IAM role ARN)' :
    targetType === 'gcs' ? 'a GCS service-account JSON' :
    'the Dataverse Synapse-Link storage credential';
  return {
    gated: true,
    code: 'needs_credential',
    hint:
      `${labelFor(targetType)} is an external cloud source and requires ${secret}. ` +
      'Store it as a Key Vault secret and reference it via credentialRef.keyVaultSecret, then ' +
      'grant the Console UAMI Key Vault Secrets User. ADLS Gen2 and internal Loom lakehouse ' +
      'shortcuts work today on the UAMI with no extra credential.',
  };
}

export function labelFor(t: ShortcutTargetType): string {
  switch (t) {
    case 'adls': return 'ADLS Gen2';
    case 'internal': return 'Internal Loom lakehouse';
    case 's3': return 'Amazon S3';
    case 'gcs': return 'Google Cloud Storage';
    case 'dataverse': return 'Dataverse';
    default: return t;
  }
}

export const SHORTCUT_KINDS: ShortcutKind[] = ['files', 'tables'];
