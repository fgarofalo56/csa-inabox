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
import {
  listWarehouses,
  executeStatement,
  databricksConfigGate,
  writeUcVolumesFile,
  deleteUcVolumesFile,
} from './databricks-client';
import {
  getKeyVaultSecret,
  keyVaultConfigGate,
  ensureUcAwsStorageCredential,
  ensureUcGcpStorageCredential,
  ensureUcExternalLocation,
  deleteUcExternalLocation,
  deleteUcStorageCredential,
} from './shortcut-credentials';
import type {
  ShortcutTargetType,
  ShortcutKind,
  ShortcutEngine,
  ShortcutCredentialRef,
} from './lakehouse-shortcuts';

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
  /**
   * External-source binding (S3/GCS) produced by bindExternalSource(). When
   * present, the engine object is created over this binding instead of an
   * abfss path:
   *   - UC: CREATE TABLE … LOCATION '<s3|gs>://…' (covered by an external location)
   *   - Synapse: an external table over the pre-created EXTERNAL DATA SOURCE
   */
  external?: {
    /** s3:// or gs:// object URI (read path). */
    objectUri: string;
    /** UC external location name (Databricks engine). */
    ucExternalLocation?: string;
    /** Synapse external-data-source name (Synapse engine). */
    synapseDataSource?: string;
    /** Object key under the bucket, for the Synapse OPENROWSET BULK path. */
    objectKey?: string;
    /** Delta Sharing credential + parsed share coordinates (delta_sharing source). */
    deltaSharing?: ExternalBinding['deltaSharing'];
    /** Lakehouse id — needed to derive the Delta Sharing credential file path. */
    lakehouseId?: string;
  };
}): Promise<TablesRegistration | EngineGate> {
  // --- Delta Sharing Tables: register a UC table with the delta_sharing provider. ---
  // This uses the Spark `delta_sharing` data source, which requires the
  // Databricks engine. The credential profile is written to a UC Volume so the
  // workspace can authenticate against the share server, then the table is
  // created over `<credPath>#<share>.<schema>.<table>`.
  if (args.external?.deltaSharing) {
    if (databricksConfigGate()) {
      return {
        gated: true,
        code: 'delta_sharing_needs_databricks',
        hint:
          'Delta Sharing Tables shortcuts use the delta_sharing Spark provider, which requires the ' +
          'Databricks engine. Set LOOM_DATABRICKS_HOSTNAME so the shortcut can be registered as a UC ' +
          'table. A Files shortcut (kind=files) works without Databricks — the credential is validated ' +
          'against the share server on create and the profile is stored in the registry for notebook reads.',
      };
    }
    const ds = args.external.deltaSharing;
    const lhId = args.external.lakehouseId || args.lakehouseId;
    const credPath = deltaSharingCredPath(lhId, args.name);
    try {
      await writeUcVolumesFile(credPath, JSON.stringify(ds.profile));
    } catch (e: any) {
      const v = deltaSharingVolume();
      return {
        gated: true,
        code: 'delta_sharing_needs_uc_volume',
        hint:
          `Could not write the Delta Sharing credential file to the UC Volume ` +
          `${v.catalog}.${v.schema}.${v.volume}. Create it once as a metastore admin ` +
          `(CREATE VOLUME IF NOT EXISTS ${v.catalog}.${v.schema}.${v.volume};) and grant the Console UAMI ` +
          `WRITE VOLUME on it, or set LOOM_DELTA_SHARING_VOLUME to an existing governed volume. (${e?.message || e})`,
      };
    }
    const obj = ucObject(lhId, args.name);
    const warehouses = await listWarehouses();
    const wh = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
    if (!wh) {
      return {
        gated: true,
        code: 'no_warehouse',
        hint:
          'Databricks is configured but the workspace has no SQL Warehouse to run the Delta Sharing ' +
          'table DDL. Create a SQL Warehouse (Compute → SQL Warehouses) and retry.',
      };
    }
    const [cat, sch, tbl] = obj.split('.');
    const loc = `${credPath}#${ds.share}.${ds.schema}.${ds.table}`.replace(/'/g, "''");
    const ddl =
      `CREATE SCHEMA IF NOT EXISTS ${cat}.${sch};\n` +
      `CREATE TABLE IF NOT EXISTS ${cat}.${sch}.${tbl} USING deltaSharing LOCATION '${loc}';`;
    await executeStatement(wh.id, ddl);
    return { engine: 'databricks', engineObject: obj };
  }

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
    const csvOpts = fmt === 'CSV' ? `, PARSER_VERSION = ''2.0'', HEADER_ROW = TRUE` : '';

    // External S3 source on Synapse: OPENROWSET BULK over the pre-created
    // EXTERNAL DATA SOURCE (built by bindExternalSource). The BULK arg is the
    // object key relative to the data source LOCATION.
    if (args.external?.synapseDataSource) {
      const key = (args.external.objectKey || '').replace(/'/g, "''");
      const ddl =
        `IF SCHEMA_ID('shortcuts') IS NULL EXEC('CREATE SCHEMA shortcuts');\n` +
        `IF OBJECT_ID('${obj}','V') IS NOT NULL DROP VIEW ${obj};\n` +
        `EXEC('CREATE VIEW ${obj} AS SELECT * FROM OPENROWSET(BULK ''${key}'', ` +
        `DATA_SOURCE = ''${args.external.synapseDataSource}'', FORMAT = ''${fmt}''${csvOpts}) AS r');`;
      await executeQuery(serverlessTarget('master'), ddl);
      return { engine, engineObject: obj };
    }

    const parts = parseAbfss(args.abfssUri);
    if (!parts) {
      throw Object.assign(new Error(`Cannot resolve abfss for Synapse OPENROWSET: ${args.abfssUri}`), { code: 'bad_target' });
    }
    // Synapse OPENROWSET BULK takes the https DFS endpoint, not abfss://.
    const bulkUrl = `https://${parts.account}.dfs.core.windows.net/${parts.container}/${parts.path}`;
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
  // For external S3/GCS sources the LOCATION is the object URI (covered by the
  // UC external location created in bindExternalSource); otherwise it's abfss.
  const location = (args.external?.objectUri || args.abfssUri).replace(/'/g, "''");
  const ddl =
    `CREATE SCHEMA IF NOT EXISTS ${cat}.${sch};\n` +
    `CREATE TABLE IF NOT EXISTS ${cat}.${sch}.${tbl} ` +
    `USING ${fmt} LOCATION '${location}';`;
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
 * Prove a Tables engine object is readable with a real SELECT TOP 1. Throws the
 * raw engine error on failure (the Test route maps it to a status='error').
 */
export async function testEngineObject(engine: ShortcutEngine, engineObject: string): Promise<void> {
  if (engine === 'synapse') {
    await executeQuery(serverlessTarget('master'), `SELECT TOP 1 * FROM ${engineObject};`);
    return;
  }
  if (engine === 'databricks') {
    const warehouses = await listWarehouses();
    const wh = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
    if (!wh) throw Object.assign(new Error('No SQL Warehouse available to test the engine object'), { code: 'no_warehouse' });
    await executeStatement(wh.id, `SELECT * FROM ${engineObject} LIMIT 1;`);
    return;
  }
  throw Object.assign(new Error(`Cannot test engine object on engine '${engine}'`), { code: 'no_engine' });
}

/**
 * Drop the UC external location + storage credential created for an S3/GCS
 * shortcut. Names are the deterministic ones from ucCredNames (the external
 * location is unconditional; the storage credential prefers the persisted name
 * but falls back to the deterministic one). Best-effort — never deletes bytes.
 */
export async function dropExternalBinding(
  lakehouseId: string,
  name: string,
  storageCredentialName?: string,
): Promise<void> {
  const names = ucCredNames(lakehouseId, name);
  // External location must go first (a storage credential in use can't be dropped).
  await deleteUcExternalLocation(names.loc, true).catch(() => {});
  await deleteUcStorageCredential(storageCredentialName || names.cred, true).catch(() => {});
}

/**
 * Delete the Delta Sharing credential file a Tables shortcut wrote to the UC
 * Volume. Best-effort — never touches the shared source data. Only meaningful
 * for delta_sharing shortcuts on the Databricks engine.
 */
export async function dropDeltaSharingCredential(lakehouseId: string, name: string): Promise<void> {
  if (databricksConfigGate()) return;
  await deleteUcVolumesFile(deltaSharingCredPath(lakehouseId, name)).catch(() => {});
}

/**
 * Re-write the Delta Sharing credential file on the UC Volume from a (refreshed)
 * profile. Called by the Test/Retry route so that, after the operator updates
 * the Key Vault secret with a new bearer token, the UC table backing a Tables
 * shortcut picks up the new token. Requires the Databricks engine.
 */
export async function refreshDeltaSharingCredential(
  lakehouseId: string,
  name: string,
  profile: { endpoint: string; bearerToken: string; expirationTime?: string; shareCredentialsVersion?: number },
): Promise<void> {
  if (databricksConfigGate()) return;
  await writeUcVolumesFile(deltaSharingCredPath(lakehouseId, name), JSON.stringify(profile));
}

/**
 * Pre-flight honest-gate for external cloud sources (S3/GCS/Dataverse).
 *
 * Returns a gate ONLY when:
 *   - the source is external AND no Key Vault credentialRef.keyVaultSecret was
 *     supplied (we cannot resolve a secret that was never provisioned), or
 *   - the Key Vault itself isn't configured on this deployment.
 *
 * When a credentialRef IS present and the vault is configured, this returns
 * null and the route proceeds to bindExternalSource(), which resolves the
 * secret and creates the real engine binding (UC storage credential +
 * external location, or Synapse database-scoped credential + data source).
 *
 * ADLS/internal always returns null (the UAMI path needs no extra credential).
 */
export function externalSourceGate(targetType: ShortcutTargetType, hasCredentialRef: boolean): EngineGate | null {
  if (targetType === 'adls' || targetType === 'internal') return null;

  if (!hasCredentialRef) {
    const secret =
      targetType === 's3' ? 'an AWS IAM role ARN (UC engine) or access key/secret (Synapse engine)' :
      targetType === 'gcs' ? 'a GCS service-account JSON' :
      targetType === 'delta_sharing' ? "the Delta Sharing credential file JSON (endpoint + bearerToken), obtained from the provider's activation link" :
      'the Dataverse Synapse-Link linked ADLS Gen2 storage path';
    return {
      gated: true,
      code: 'needs_credential',
      hint:
        `${labelFor(targetType)} is an external cloud source and requires ${secret}. ` +
        'Store it as a Key Vault secret and reference it via credentialRef.keyVaultSecret, then ' +
        'grant the Console UAMI "Key Vault Secrets User" on the vault. ADLS Gen2 and internal ' +
        'Loom lakehouse shortcuts work today on the UAMI with no extra credential.',
    };
  }

  const kvGate = keyVaultConfigGate();
  if (kvGate) {
    return {
      gated: true,
      code: 'key_vault_not_configured',
      hint:
        `${labelFor(targetType)} shortcuts resolve their credential from Key Vault, but ` +
        `${kvGate.missing} is not set on this deployment. Set it (and grant the Console UAMI ` +
        '"Key Vault Secrets User" on that vault) so the secret can be read.',
    };
  }
  return null;
}

/**
 * Parse an s3://bucket/key or gs://bucket/key URI into a normalised
 * { scheme, bucket, key, prefix } where prefix is the location root used for
 * the UC external location / Synapse data source.
 */
function parseObjectStoreUri(uri: string): { scheme: 's3' | 'gs'; bucket: string; key: string; prefix: string } | null {
  const m = (uri || '').trim().match(/^(s3a?|gs):\/\/([^/]+)\/?(.*)$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase().startsWith('s3') ? 's3' : 'gs';
  const bucket = m[2];
  const key = (m[3] || '').replace(/^\/+/, '');
  // External location is scoped to the bucket root so the external table path
  // is covered (UC requires the table path to fall under an external location).
  const prefix = `${scheme}://${bucket}`;
  return { scheme: scheme as 's3' | 'gs', bucket, key, prefix };
}

/** Stable UC object names for a shortcut's storage credential + external location. */
function ucCredNames(lakehouseId: string, name: string): { cred: string; loc: string } {
  const safe = (s: string) => s.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  const base = `loom_sc_${safe(lakehouseId)}_${safe(name)}`.slice(0, 240);
  return { cred: `${base}_cred`, loc: `${base}_loc` };
}

/**
 * UC Volume that holds Delta Sharing credential files. Overridable via
 * LOOM_DELTA_SHARING_VOLUME (catalog.schema.volume) for tenants that keep
 * shortcut credentials in a different governed volume. Default matches the
 * bootstrap DDL in docs/fiab/v3-tenant-bootstrap.md.
 */
function deltaSharingVolume(): { catalog: string; schema: string; volume: string } {
  const raw = (process.env.LOOM_DELTA_SHARING_VOLUME || 'loom.loom_shortcuts.loom_shortcut_files').trim();
  const [catalog, schema, volume] = raw.split('.');
  return { catalog: catalog || 'loom', schema: schema || 'loom_shortcuts', volume: volume || 'loom_shortcut_files' };
}

/** UC Volume file path for a shortcut's Delta Sharing credential file. */
function deltaSharingCredPath(lakehouseId: string, name: string): string {
  const safe = (s: string) => s.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  const v = deltaSharingVolume();
  return `/Volumes/${v.catalog}/${v.schema}/${v.volume}/loom_${safe(lakehouseId)}_${safe(name)}.share`;
}

/**
 * The real read-through binding for external cloud sources. Resolves the
 * Key Vault secret named by credentialRef.keyVaultSecret, then materialises
 * the engine binding and returns the address the Tables/Files engine reads
 * from. Throws the raw backend error on a real failure; returns an EngineGate
 * only when the engine for that source type isn't configured.
 *
 * Returns:
 *   - { readUri }                 the resolved address (abfss/s3/gs) to read
 *   - { readUri, ucExternalLocation } when a UC external location was created
 *   - { readUri, synapse: {...} }  Synapse scoped-credential + data-source names
 */
export interface ExternalBinding {
  /** The address the engine reads from (s3://… , gs://… , abfss://… for Dataverse, or delta-sharing://… ). */
  readUri: string;
  /** UC external location name (Databricks UC engine), if one was created. */
  ucExternalLocation?: string;
  /** UC storage credential name, if one was created. */
  ucStorageCredential?: string;
  /** Synapse external-data-source + scoped-credential names, if Synapse engine. */
  synapse?: { dataSource: string; scopedCredential: string };
  /**
   * Delta Sharing credential profile + parsed share/schema/table (set when
   * targetType='delta_sharing'). The route passes this through to
   * createTablesShortcut so it can write the credential file to a UC Volume and
   * register the table with the `delta_sharing` provider.
   */
  deltaSharing?: {
    profile: { endpoint: string; bearerToken: string; expirationTime?: string; shareCredentialsVersion?: number };
    share: string;
    schema: string;
    table: string;
  };
}

export async function bindExternalSource(args: {
  lakehouseId: string;
  name: string;
  targetType: 's3' | 'gcs' | 'dataverse' | 'delta_sharing';
  targetUri: string;
  credentialRef: ShortcutCredentialRef;
}): Promise<ExternalBinding | EngineGate> {
  const { lakehouseId, name, targetType, targetUri, credentialRef } = args;
  const secretName = credentialRef.keyVaultSecret;
  if (!secretName) {
    return { gated: true, code: 'needs_credential', hint: `${labelFor(targetType)} requires credentialRef.keyVaultSecret.` };
  }

  // --- Delta Sharing: validate the credential file + test the share server. ---
  // The KV secret holds the open-sharing credential file JSON
  // ({ shareCredentialsVersion, endpoint, bearerToken, expirationTime }) the
  // provider hands out via an activation link. We parse it, then prove the
  // bearer token works by listing shares (GET <endpoint>/shares). A 401/403 =>
  // the token is expired/invalid (the "broken" state — fix the KV secret + Retry).
  // Learn: https://learn.microsoft.com/azure/databricks/delta-sharing/read-data-open
  if (targetType === 'delta_sharing') {
    const raw = (await getKeyVaultSecret(secretName)).trim();
    let profile: { shareCredentialsVersion?: number; endpoint?: string; bearerToken?: string; expirationTime?: string };
    try {
      profile = JSON.parse(raw);
    } catch {
      throw Object.assign(
        new Error(
          `Delta Sharing secret '${secretName}' must be the credential file JSON ` +
          `(shareCredentialsVersion, endpoint, bearerToken). Download it from the provider's ` +
          `activation link and store the raw JSON as the Key Vault secret value.`,
        ),
        { code: 'bad_delta_sharing_secret' },
      );
    }
    if (!profile.endpoint || !profile.bearerToken) {
      throw Object.assign(
        new Error(`Delta Sharing credential file in '${secretName}' is missing 'endpoint' or 'bearerToken'.`),
        { code: 'bad_delta_sharing_secret' },
      );
    }
    // delta-sharing://<share>/<schema>/<table> is the canonical address.
    const dsMatch = (targetUri || '').match(/^delta-sharing:\/\/([^/]+)\/([^/]+)\/(.+)$/i);
    if (!dsMatch) {
      throw Object.assign(
        new Error(`Delta Sharing targetUri must be delta-sharing://<share>/<schema>/<table>; got: ${targetUri}`),
        { code: 'bad_target' },
      );
    }
    // Real HTTP test: list shares with the bearer token. 401/403 => auth failure.
    const sharesUrl = profile.endpoint.replace(/\/+$/, '') + '/shares';
    let testRes: Response;
    try {
      testRes = await fetch(sharesUrl, { headers: { Authorization: `Bearer ${profile.bearerToken}` } });
    } catch (netErr: any) {
      throw Object.assign(
        new Error(`Delta Sharing endpoint unreachable: ${sharesUrl} — ${netErr?.message || netErr}`),
        { code: 'delta_sharing_unreachable' },
      );
    }
    if (testRes.status === 401 || testRes.status === 403) {
      throw Object.assign(
        new Error(
          `Delta Sharing authentication failed (HTTP ${testRes.status}). The bearer token in secret ` +
          `'${secretName}' is invalid or expired (open-sharing tokens expire after at most 1 year). ` +
          `Download a fresh credential file from the provider's activation link, update the Key Vault ` +
          `secret, then Retry.`,
        ),
        { code: 'delta_sharing_auth_failure' },
      );
    }
    if (!testRes.ok) {
      throw Object.assign(
        new Error(`Delta Sharing endpoint returned HTTP ${testRes.status}: ${sharesUrl}`),
        { code: 'delta_sharing_unreachable' },
      );
    }
    return {
      readUri: targetUri,
      deltaSharing: {
        profile: {
          endpoint: profile.endpoint,
          bearerToken: profile.bearerToken,
          expirationTime: profile.expirationTime,
          shareCredentialsVersion: profile.shareCredentialsVersion,
        },
        share: dsMatch[1],
        schema: dsMatch[2],
        table: dsMatch[3],
      },
    };
  }

  // --- Dataverse: bind via the Synapse-Link linked ADLS Gen2 storage. ---
  // The KV secret holds the linked-lake abfss/https path that Synapse Link
  // writes Dataverse tables to. We resolve it, then read it on the UAMI exactly
  // like any internal ADLS shortcut (the UAMI needs Storage Blob Data Reader on
  // that lake — granted as part of Synapse Link setup).
  // Learn: https://learn.microsoft.com/power-apps/maker/data-platform/azure-synapse-link-data-lake
  if (targetType === 'dataverse') {
    const linkedPath = (await getKeyVaultSecret(secretName)).trim();
    const parts = parseAbfss(linkedPath);
    if (!parts) {
      throw Object.assign(
        new Error(
          `Dataverse Synapse-Link secret '${secretName}' must contain the linked ADLS Gen2 path ` +
          `(abfss://<container>@<acct>.dfs.core.windows.net/... or the https DFS form); got: ${linkedPath.slice(0, 80)}`,
        ),
        { code: 'bad_dataverse_secret' },
      );
    }
    // Prove reachability now so the row lands 'active' only when it's real.
    await listPaths(parts.container, parts.path, 1, parts.account);
    return { readUri: parts.abfss };
  }

  // --- S3 / GCS: resolve the secret + create the engine binding. ---
  const obj = parseObjectStoreUri(targetUri);
  if (!obj) {
    throw Object.assign(
      new Error(`${labelFor(targetType)} targetUri must be ${targetType === 's3' ? 's3://bucket/key' : 'gs://bucket/key'}: ${targetUri}`),
      { code: 'bad_target' },
    );
  }

  const engine = pickTablesEngine();

  // GCS is only supported on the Databricks UC engine (Synapse Serverless has no
  // native GCS connector). Gate honestly if UC isn't configured.
  if (targetType === 'gcs') {
    if (engine !== 'databricks') {
      return {
        gated: true,
        code: 'gcs_needs_databricks',
        hint:
          'Google Cloud Storage shortcuts bind through a Unity Catalog storage credential + ' +
          'external location, which requires the Databricks engine. Set LOOM_DATABRICKS_HOSTNAME ' +
          '(Synapse Serverless has no native GCS connector).',
      };
    }
    const secret = await getKeyVaultSecret(secretName);
    let sa: { client_email?: string; private_key_id?: string; private_key?: string };
    try {
      sa = JSON.parse(secret);
    } catch {
      throw Object.assign(
        new Error(`GCS service-account secret '${secretName}' must be the service-account JSON`),
        { code: 'bad_gcs_secret' },
      );
    }
    const names = ucCredNames(lakehouseId, name);
    await ensureUcGcpStorageCredential({ name: names.cred, serviceAccountJson: sa, readOnly: true, comment: `Loom shortcut ${name}` });
    await ensureUcExternalLocation({ name: names.loc, url: obj.prefix, credentialName: names.cred, readOnly: true, comment: `Loom shortcut ${name}` });
    return { readUri: targetUri, ucExternalLocation: names.loc, ucStorageCredential: names.cred };
  }

  // S3 — prefer UC (IAM role) when Databricks is configured; else Synapse (access keys).
  const secret = await getKeyVaultSecret(secretName);
  if (engine === 'databricks') {
    const roleArn = secret.trim();
    if (!/^arn:aws[a-z-]*:iam::\d+:role\//i.test(roleArn)) {
      throw Object.assign(
        new Error(
          `S3 secret '${secretName}' must be an AWS IAM role ARN for the Databricks UC engine ` +
          `(arn:aws:iam::<acct>:role/<name>); got: ${roleArn.slice(0, 60)}`,
        ),
        { code: 'bad_s3_secret' },
      );
    }
    const names = ucCredNames(lakehouseId, name);
    await ensureUcAwsStorageCredential({ name: names.cred, roleArn, readOnly: true, comment: `Loom shortcut ${name}` });
    await ensureUcExternalLocation({ name: names.loc, url: obj.prefix, credentialName: names.cred, readOnly: true, comment: `Loom shortcut ${name}` });
    return { readUri: targetUri, ucExternalLocation: names.loc, ucStorageCredential: names.cred };
  }

  if (engine === 'synapse') {
    // Synapse Serverless S3 via PolyBase: DATABASE SCOPED CREDENTIAL ('S3 Access
    // Key', SECRET = '<AccessKeyID>:<SecretKeyID>') + EXTERNAL DATA SOURCE.
    // Learn: https://learn.microsoft.com/sql/relational-databases/polybase/polybase-configure-s3-compatible
    if (!/^[^:]+:[^:]+$/.test(secret.trim())) {
      throw Object.assign(
        new Error(
          `S3 secret '${secretName}' must be 'AccessKeyID:SecretKeyID' for the Synapse engine; ` +
          `set LOOM_DATABRICKS_HOSTNAME to use an IAM role instead.`,
        ),
        { code: 'bad_s3_secret' },
      );
    }
    const cred = `loom_s3_${name.replace(/[^a-z0-9_]+/gi, '_')}`.toLowerCase();
    const dsName = `${cred}_ds`;
    const ddl =
      `IF NOT EXISTS (SELECT 1 FROM sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##') ` +
      `CREATE MASTER KEY;\n` +
      `IF EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name = '${dsName}') ` +
      `DROP EXTERNAL DATA SOURCE ${dsName};\n` +
      `IF EXISTS (SELECT 1 FROM sys.database_scoped_credentials WHERE name = '${cred}') ` +
      `DROP DATABASE SCOPED CREDENTIAL ${cred};\n` +
      `CREATE DATABASE SCOPED CREDENTIAL ${cred} ` +
      `WITH IDENTITY = 'S3 Access Key', SECRET = '${secret.trim().replace(/'/g, "''")}';\n` +
      `CREATE EXTERNAL DATA SOURCE ${dsName} ` +
      `WITH (LOCATION = '${obj.prefix}', CREDENTIAL = ${cred});`;
    await executeQuery(serverlessTarget('master'), ddl);
    return { readUri: targetUri, synapse: { dataSource: dsName, scopedCredential: cred } };
  }

  return {
    gated: true,
    code: 'no_tables_engine',
    hint:
      `${labelFor(targetType)} shortcuts need a query engine to create the external binding. ` +
      'Set LOOM_DATABRICKS_HOSTNAME (Unity Catalog) or LOOM_SYNAPSE_WORKSPACE (Synapse Serverless).',
  };
}

export function labelFor(t: ShortcutTargetType): string {
  switch (t) {
    case 'adls': return 'ADLS Gen2';
    case 'internal': return 'Internal Loom lakehouse';
    case 's3': return 'Amazon S3';
    case 'gcs': return 'Google Cloud Storage';
    case 'dataverse': return 'Dataverse';
    case 'delta_sharing': return 'Delta Sharing';
    default: return t;
  }
}

export const SHORTCUT_KINDS: ShortcutKind[] = ['files', 'tables'];
