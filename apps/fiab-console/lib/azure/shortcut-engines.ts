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

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { listPaths, containerExistsOn } from './adls-client';
import { getDfsSuffix } from './cloud-endpoints';
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
} from './shortcut-credentials';
// The UC storage-credential + external-location calls come from the AUDITED
// facade, NOT from shortcut-credentials directly: that module's private
// transport writes no Loom audit row, and creating a storage credential is the
// closest thing in Unity Catalog to minting storage access (issue #2622, gap 1).
// `scripts/ci/check-unity-audit-chokepoint.mjs` check 8 enforces this import.
import {
  ensureUcAwsStorageCredential,
  ensureUcGcpStorageCredential,
  ensureUcExternalLocation,
  deleteUcExternalLocation,
  deleteUcStorageCredential,
} from './uc-securable';
import { graphDriveConfigGate, headDriveItem, parseSharepointUri } from './graph-drive-client';
import type {
  ShortcutTargetType,
  ShortcutKind,
  ShortcutEngine,
  ShortcutCredentialRef,
} from './lakehouse-shortcuts';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

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
  /**
   * The account + filesystem are reachable, but the specific target PATH does
   * not exist yet (404 PathNotFound) — e.g. a brand-new folder or a container
   * root with no children. Like Fabric/OneLake, a shortcut to an empty/missing
   * folder under a reachable filesystem is ALLOWED (it resolves data lazily),
   * so this is NOT a hard failure.
   */
  empty?: boolean;
}

export interface TablesRegistration {
  engine: ShortcutEngine;
  engineObject: string;
}

const ABFSS_RE = /^abfss:\/\/([^@]+)@([^/]+)\.dfs\.core\.windows\.net\/(.*)$/i;
const HTTPS_DFS_RE = /^https:\/\/([^.]+)\.dfs\.core\.windows\.net\/([^/]+)\/(.*)$/i;
// ADLS Gen2 accounts expose the SAME data over a blob.core.windows.net endpoint.
// Catalogs / public datasets often hand out the blob URL; normalize it to the dfs
// endpoint (the listPaths/data-plane API is dfs-only) so a blob URL is accepted.
const HTTPS_BLOB_RE = /^https:\/\/([^.]+)\.blob\.core\.windows\.net\/([^/]+)\/(.*)$/i;
// Internal Loom OneLake reference: onelake://<workspace>/<lakehouse>/<path>.
// Same-tenant cross-workspace — resolves against the deployment's internal
// OneLake/ADLS account (internalAccount()), workspace = container, the lakehouse
// + sub-path become the path. Mirrors Fabric's onelake:// scheme, Azure-native.
const ONELAKE_RE = /^onelake:\/\/([^/]+)\/([^/]+)\/?(.*)$/i;

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
 *   https://<acct>.blob.core.windows.net/<container>/<path>  (normalized to dfs)
 *   onelake://<workspace>/<lakehouse>/<path>  (internal Loom OneLake, cross-workspace)
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
  // blob.core.windows.net is the same ADLS Gen2 account over the blob endpoint —
  // normalize to the dfs form the data-plane API requires.
  m = u.match(HTTPS_BLOB_RE);
  if (m) {
    const [, account, container, path] = m;
    const clean = path.replace(/^\/+/, '');
    return { container, account, path: clean, abfss: `abfss://${container}@${account}.dfs.core.windows.net/${clean}` };
  }
  // onelake://<workspace>/<lakehouse>/<path> → internal OneLake/ADLS account,
  // workspace as the container, lakehouse + sub-path as the path.
  const onelake = u.match(ONELAKE_RE);
  if (onelake && internalAccount) {
    const [, workspace, lakehouse, path] = onelake;
    const account = internalAccount();
    const clean = `${lakehouse}/${(path || '')}`.replace(/\/+$/, '').replace(/^\/+/, '');
    return { container: workspace, account, path: clean, abfss: `abfss://${workspace}@${account}.dfs.core.windows.net/${clean}` };
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
  //
  // Reachability semantics (parity with Fabric/OneLake): a shortcut may target
  // a container ROOT or a folder that is empty / not-yet-created. A 404
  // PathNotFound on the PATH is therefore NOT a hard failure — only an
  // unreachable ACCOUNT or a missing FILESYSTEM (container) is. So when the path
  // probe 404s we confirm the filesystem itself exists and, if so, allow the
  // shortcut as reachable-but-empty. Auth (403) and network errors still fail.
  try {
    await listPaths(parts.container, parts.path, 1, parts.account);
    return { abfssUri: parts.abfss, reachable: true };
  } catch (e: any) {
    const status: number | undefined =
      e?.statusCode ?? e?.response?.status ?? e?.details?.statusCode;
    const codeStr = String(e?.code ?? e?.details?.errorCode ?? e?.errorCode ?? '');
    const msg = String(e?.message ?? e ?? '');
    const isAuth = status === 403 || /authorization|forbidden|permission/i.test(codeStr + ' ' + msg);
    // Distinguish a missing PATH (allowed) from a missing FILESYSTEM (real fail).
    const fsMissing = /FilesystemNotFound|ContainerNotFound/i.test(codeStr);
    const pathMissing =
      !fsMissing &&
      (status === 404 || /PathNotFound|SourcePathNotFound/i.test(codeStr) ||
        /the specified path does not exist/i.test(msg));

    if (isAuth) throw e; // real RBAC failure — surface the access-denied message.

    if (pathMissing) {
      // The path doesn't exist yet — confirm the FILESYSTEM (container) is real
      // and reachable before allowing the shortcut. containerExistsOn returns
      // false on auth/network/404, so a true here proves a reachable filesystem.
      const fsReachable = await containerExistsOn(parts.account, parts.container);
      if (fsReachable) {
        return { abfssUri: parts.abfss, reachable: true, empty: true };
      }
      throw Object.assign(
        new Error(
          `Filesystem '${parts.container}' was not found (or is unreachable) on account ` +
            `'${parts.account}'. The target account/container must exist and the Console UAMI ` +
            `must have Storage Blob Data Reader on it. (The target path itself may be empty — ` +
            `that is allowed once the filesystem is reachable.)`,
        ),
        { code: 'FilesystemNotFound', statusCode: 404 },
      );
    }
    // Filesystem explicitly missing, or any other error (network/DNS) → real fail.
    throw e;
  }
}

/** Which Tables engine is available, in preference order (Synapse, then Databricks). null = none. */
export function pickTablesEngine(): ShortcutEngine | null {
  if (process.env.LOOM_SYNAPSE_WORKSPACE) return 'synapse';
  if (!databricksConfigGate()) return 'databricks';
  return null;
}

/**
 * The ONE schema Synapse shortcut views are created in. Named rather than
 * repeated so `synapseObject` (the mint) and `isMintedEngineObject` (the guard)
 * cannot drift: a change here moves both at once.
 */
const SYNAPSE_SHORTCUT_SCHEMA = 'shortcuts';

/** The ONE Unity Catalog catalog Databricks shortcut tables are created in. */
const UC_CATALOG = 'loom';

/** Synapse Serverless external-table / view object name (2-part: schema.object). */
function synapseObject(name: string): string {
  const safe = name.replace(/[^a-z0-9_]+/gi, '_');
  return `${SYNAPSE_SHORTCUT_SCHEMA}.${safe}`;
}

/**
 * Dedicated Synapse Serverless USER database for shortcut views / external data
 * sources / scoped credentials. Synapse Serverless FORBIDS `CREATE VIEW`,
 * `CREATE EXTERNAL DATA SOURCE`, `CREATE MASTER KEY`, and `CREATE DATABASE
 * SCOPED CREDENTIAL` in the built-in `master` database ("CREATE/ALTER VIEW is
 * not supported in master database") — they must live in a user DB. The view
 * is referenced cross-database with a 3-part name from any context (master
 * included), which serverless supports. Overridable for non-default deployments.
 *
 * Read LIVE rather than captured at module load. `isMintedEngineObject` derives
 * the allowed name-space from this value, so a module-load snapshot would make
 * the SECURITY guard depend on whether the env var happened to be set before
 * this module was first imported. Same reasoning, and same shape, as
 * `kv-secret-purpose.ts:envConfiguredSecretNames`.
 */
function serverlessDb(): string {
  return (process.env.LOOM_SERVERLESS_DB || '').trim() || 'loom_lakehouse';
}

/** 3-part `<db>.schema.object` so the view is queryable cross-database. */
function synapseQualified(twoPartObj: string): string {
  return `${serverlessDb()}.${twoPartObj}`;
}

// CREATE DATABASE is idempotent + cheap once created; cache within the module.
let serverlessDbEnsured = false;
/** Create the serverless user DB if absent. CREATE DATABASE must be its own
 *  batch on serverless, so wrap it in EXEC under an existence guard. */
async function ensureServerlessDb(): Promise<void> {
  if (serverlessDbEnsured) return;
  await executeQuery(
    serverlessTarget('master'),
    `IF NOT EXISTS (SELECT 1 FROM sys.databases WHERE name = '${serverlessDb()}') EXEC('CREATE DATABASE [${serverlessDb()}]');`,
  );
  serverlessDbEnsured = true;
}

/**
 * #3611 — is `engineObject` inside the NAME-SPACE Loom mints for shortcut engine
 * objects? This is the predicate every sink that interpolates the value into SQL
 * must pass it through.
 *
 * It lives HERE, beside the three functions that mint the name, so the allow-set
 * and the mint cannot drift apart. The minted shapes are, verbatim from those
 * functions:
 *
 *   synapse      `synapseQualified(synapseObject(name))`
 *                = `<serverlessDb()>.shortcuts.<leaf>` — the database is this
 *                  deployment's own `LOOM_SERVERLESS_DB` (default
 *                  `loom_lakehouse`); the schema is the LITERAL `shortcuts`;
 *                  `<leaf>` is `name.replace(/[^a-z0-9_]+/gi,'_')`, so
 *                  `[A-Za-z0-9_]+` and nothing else.
 *   synapse      a 2-part `shortcuts.<leaf>` row predating the cross-database
 *   (legacy)     qualification. `dropShortcutObject` still handles that arity
 *                  explicitly (it substitutes the serverless DB), so refusing it
 *                  here would orphan those views rather than protect anything.
 *   databricks   `ucObject(lakehouseId, name)` = `loom.<schema>.<table>` — the
 *                  catalog is the LITERAL `loom`; both remaining parts are
 *                  `.replace(/[^a-z0-9_]+/gi,'_').toLowerCase()`.
 *
 * WHY A NAME-SPACE CHECK AND NOT AN IDENTIFIER CHECK. The previous revision of
 * this guard tested only "is this a well-formed 1–3 part identifier", and the
 * comment above it claimed that was "the shape registerTablesObject MINTS". It
 * was not: `master.sys.sql_logins`, `finance_db.dbo.payroll` and
 * `loom_lakehouse.dbo.someone_elses_view` are all well-formed identifiers, all
 * passed, and `dropShortcutObject` lets the caller pick the DATABASE from
 * `parts[0]`. Since `engineObject` is item state and item state is caller-
 * writable at create time, that admitted a DROP VIEW / DROP TABLE and a SELECT
 * against objects this surface never created, executed as the Console UAMI —
 * a Synapse SQL admin. Escaping the separators was never the whole problem;
 * WHICH OBJECT is the problem, and only the name-space answers that.
 *
 * `engine` is optional: when it is not known (a row whose `engine` was dropped),
 * a value inside EITHER engine's name-space is accepted, because either is a
 * name this platform could have minted. Passing the engine is strictly tighter.
 */
export function isMintedEngineObject(v: unknown, engine?: ShortcutEngine | 'none' | string): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 260) return false;
  const parts = v.split('.');
  if (parts.length < 2 || parts.length > 3) return false;
  // Every part must be a bare identifier — this is necessary but NOT sufficient,
  // and on its own it is the check that shipped the hole described above.
  if (!parts.every((p) => /^[A-Za-z0-9_]+$/.test(p))) return false;

  const wantSynapse = !engine || engine === 'synapse';
  const wantDatabricks = !engine || engine === 'databricks';

  if (wantSynapse) {
    // 3-part `<serverlessDb()>.shortcuts.<leaf>`, or legacy 2-part `shortcuts.<leaf>`.
    if (parts.length === 3 && parts[0] === serverlessDb() && parts[1] === SYNAPSE_SHORTCUT_SCHEMA) return true;
    if (parts.length === 2 && parts[0] === SYNAPSE_SHORTCUT_SCHEMA) return true;
  }
  if (wantDatabricks) {
    // 3-part `loom.<schema>.<table>`, lower-cased by ucObject.
    if (parts.length === 3 && parts[0] === UC_CATALOG) return true;
  }
  return false;
}

/**
 * Refuse an `engineObject` outside the minted name-space before it is
 * interpolated into SQL. Throws rather than returning, so a sink cannot forget
 * to branch on a boolean.
 *
 * The message states only what the check ESTABLISHED — that the name is outside
 * the name-space this platform mints into. It does NOT claim Loom did not create
 * the object, or that the caller wrote the value: neither is knowable here.
 */
export class EngineObjectNamespaceError extends Error {
  status = 400;
  code = 'invalid_engine_object';
  constructor(public readonly engineObject: string) {
    super(
      `"${engineObject}" is outside the name-space Loom registers shortcut engine objects into ` +
        `(\`${serverlessDb()}.${SYNAPSE_SHORTCUT_SCHEMA}.<name>\` on Synapse, \`${UC_CATALOG}.<schema>.<table>\` on ` +
        'Databricks), so it is refused before it reaches the query engine. Recreate the shortcut ' +
        '(kind=tables) to re-register it.',
    );
    this.name = 'EngineObjectNamespaceError';
  }
}

export function assertMintedEngineObject(v: unknown, engine?: ShortcutEngine | 'none' | string): asserts v is string {
  if (!isMintedEngineObject(v, engine)) {
    throw new EngineObjectNamespaceError(typeof v === 'string' ? v : String(v));
  }
}

/** Databricks UC fully-qualified table for a shortcut. */
function ucObject(lakehouseId: string, name: string): string {
  const cat = UC_CATALOG;
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
    /** SharePoint/OneDrive drive coordinates (Graph data plane — Files-only). */
    sharepoint?: ExternalBinding['sharepoint'];
    /**
     * SAS-authenticated EXTERNAL ADLS Gen2 binding. When present, a Tables
     * shortcut registers a Synapse Serverless external table over a database
     * scoped credential built from the SAS (the UAMI cannot reach the account).
     */
    adlsSas?: {
      /** Raw SAS (with or without a leading '?'). Used to mint a DSC; never persisted. */
      sas: string;
      /** Bare account name. */
      account: string;
      /** Filesystem / container. */
      container: string;
      /** Object key (path) inside the filesystem for the OPENROWSET BULK arg. */
      path: string;
    };
    /** Lakehouse id — needed to derive the Delta Sharing credential file path. */
    lakehouseId?: string;
  };
}): Promise<TablesRegistration | EngineGate> {
  // --- SharePoint / OneDrive Tables: honest-gate. ---
  // SharePoint/OneDrive content is read through Microsoft Graph, which is a
  // document/file API — there is no abfss path or external-table engine binding
  // for it, so a *Tables* shortcut can't register a real external table. A Files
  // shortcut surfaces the documents zero-copy (Graph read-through). This matches
  // Fabric, where OneDrive/SharePoint shortcuts land under Files, not Tables.
  if (args.external?.sharepoint) {
    return {
      gated: true,
      code: 'sharepoint_files_only',
      hint:
        'SharePoint / OneDrive shortcuts are read through Microsoft Graph (a file API), so they ' +
        'surface as a Files shortcut — there is no external-table engine binding for Graph drive ' +
        'items. Create this as a Files shortcut. (To query SharePoint list/library data as a table, ' +
        'export it to ADLS/Delta first, then create a Tables shortcut over that.)',
    };
  }

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
    const loc = escapeSqlLiteral(`${credPath}#${ds.share}.${ds.schema}.${ds.table}`);
    const ddl =
      `CREATE SCHEMA IF NOT EXISTS ${cat}.${sch};\n` +
      `CREATE TABLE IF NOT EXISTS ${cat}.${sch}.${tbl} USING deltaSharing LOCATION '${loc}';`;
    await executeStatement(wh.id, ddl);
    return { engine: 'databricks', engineObject: obj };
  }

  // --- SAS-authenticated external ADLS Gen2 Tables: Synapse DSC + external view. ---
  // The Console UAMI cannot read the account, so a Tables shortcut binds through
  // a Synapse Serverless DATABASE SCOPED CREDENTIAL built from the SAS (IDENTITY
  // = 'SHARED ACCESS SIGNATURE'), an EXTERNAL DATA SOURCE at the filesystem root,
  // and an OPENROWSET view. This is the documented Azure-native pattern for
  // querying a SAS-protected lake from Synapse Serverless (no Fabric, no UAMI
  // grant). Files shortcuts work without any engine.
  // Learn: https://learn.microsoft.com/azure/synapse-analytics/sql/develop-storage-files-storage-access-control?tabs=shared-access-signature
  if (args.external?.adlsSas) {
    const engine = pickTablesEngine();
    if (engine !== 'synapse') {
      return {
        gated: true,
        code: 'adls_sas_needs_synapse',
        hint:
          'A Tables shortcut over a SAS-authenticated EXTERNAL ADLS Gen2 account binds through a Synapse ' +
          'Serverless database-scoped credential (the Console UAMI cannot read the account). Set ' +
          'LOOM_SYNAPSE_WORKSPACE to enable it. A Files shortcut works today with the SAS and no engine; ' +
          'for a Databricks-backed Tables shortcut, use the in-tenant (AAD) account path instead.',
      };
    }
    const { sas, account, container, path } = args.external.adlsSas;
    const fmt = FORMAT_SQL[args.format || 'delta'] || 'DELTA';
    const obj = synapseObject(args.name);
    const cred = `loom_adls_sas_${args.name.replace(/[^a-z0-9_]+/gi, '_')}`.toLowerCase();
    const dsName = `${cred}_ds`;
    // SECRET must NOT carry a leading '?'; escape single quotes for the T-SQL literal.
    const sasSecret = escapeSqlLiteral(sas.trim().replace(/^\?+/, ''));
    const location = `https://${account.split('.')[0]}.${getDfsSuffix()}/${container}`;
    const key = escapeSqlLiteral((path || '').replace(/^\/+/, ''));
    const csvOpts = fmt === 'CSV' ? `, PARSER_VERSION = ''2.0'', HEADER_ROW = TRUE` : '';
    const ddl =
      `IF NOT EXISTS (SELECT 1 FROM sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##') CREATE MASTER KEY;\n` +
      `IF EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name = '${dsName}') DROP EXTERNAL DATA SOURCE ${dsName};\n` +
      `IF EXISTS (SELECT 1 FROM sys.database_scoped_credentials WHERE name = '${cred}') DROP DATABASE SCOPED CREDENTIAL ${cred};\n` +
      `CREATE DATABASE SCOPED CREDENTIAL ${cred} WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sasSecret}';\n` +
      `CREATE EXTERNAL DATA SOURCE ${dsName} WITH (LOCATION = '${location}', CREDENTIAL = ${cred});\n` +
      `IF SCHEMA_ID('shortcuts') IS NULL EXEC('CREATE SCHEMA shortcuts');\n` +
      `IF OBJECT_ID('${obj}','V') IS NOT NULL DROP VIEW ${obj};\n` +
      `EXEC('CREATE VIEW ${obj} AS SELECT * FROM OPENROWSET(BULK ''${key}'', ` +
      `DATA_SOURCE = ''${dsName}'', FORMAT = ''${fmt}''${csvOpts}) AS r');`;
    await ensureServerlessDb();
    await executeQuery(serverlessTarget(serverlessDb()), ddl);
    return { engine: 'synapse', engineObject: synapseQualified(obj) };
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
      const key = escapeSqlLiteral((args.external.objectKey || ''));
      const ddl =
        `IF SCHEMA_ID('shortcuts') IS NULL EXEC('CREATE SCHEMA shortcuts');\n` +
        `IF OBJECT_ID('${obj}','V') IS NOT NULL DROP VIEW ${obj};\n` +
        `EXEC('CREATE VIEW ${obj} AS SELECT * FROM OPENROWSET(BULK ''${key}'', ` +
        `DATA_SOURCE = ''${args.external.synapseDataSource}'', FORMAT = ''${fmt}''${csvOpts}) AS r');`;
      await ensureServerlessDb();
      await executeQuery(serverlessTarget(serverlessDb()), ddl);
      return { engine, engineObject: synapseQualified(obj) };
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
    await ensureServerlessDb();
    await executeQuery(serverlessTarget(serverlessDb()), ddl);
    return { engine, engineObject: synapseQualified(obj) };
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
  const location = escapeSqlLiteral((args.external?.objectUri || args.abfssUri));
  const ddl =
    `CREATE SCHEMA IF NOT EXISTS ${cat}.${sch};\n` +
    `CREATE TABLE IF NOT EXISTS ${cat}.${sch}.${tbl} ` +
    `USING ${fmt} LOCATION '${location}';`;
  await executeStatement(wh.id, ddl);
  return { engine, engineObject: obj };
}

/**
 * Drop the engine object backing a Tables shortcut. Never deletes source bytes.
 *
 * #3611 — `engineObject` is interpolated into `DROP VIEW`/`DROP TABLE` and runs
 * as the Console UAMI (a Synapse SQL admin / a UC-privileged Databricks
 * principal), and on the Synapse arm the caller also picks the DATABASE via
 * `parts[0]`. The name-space assertion is HERE rather than only at the callers
 * because it must hold for every one of them: this function has five call sites
 * across four routes, and a sixth added later inherits the guard for free.
 */
export async function dropShortcutObject(args: {
  engine?: ShortcutEngine;
  engineObject?: string;
}): Promise<void> {
  if (!args.engine || args.engine === 'none' || !args.engineObject) return;
  assertMintedEngineObject(args.engineObject, args.engine);
  if (args.engine === 'synapse') {
    // engineObject is `<db>.schema.object`; DROP VIEW can't take a cross-db
    // 3-part name, so connect to the owning DB and drop the 2-part name there.
    const parts = args.engineObject.split('.');
    const db = parts.length === 3 ? parts[0] : serverlessDb();
    const obj = parts.length === 3 ? `${parts[1]}.${parts[2]}` : args.engineObject;
    await executeQuery(
      serverlessTarget(db),
      `IF OBJECT_ID('${obj}','V') IS NOT NULL DROP VIEW ${obj};`,
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
 *
 * #3611 — same sink class as `dropShortcutObject`: `engineObject` is
 * interpolated into `SELECT TOP 1 * FROM …` / `SELECT * FROM … LIMIT 1` and
 * executed as the Console UAMI, so an object outside the minted name-space is
 * an arbitrary READ of anything that principal can see. Refused here, before
 * the string is built.
 */
export async function testEngineObject(engine: ShortcutEngine, engineObject: string): Promise<void> {
  assertMintedEngineObject(engineObject, engine);
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
  // ADLS/internal resolve on the UAMI; SharePoint/OneDrive resolve on the UAMI
  // via Microsoft Graph (no per-shortcut Key Vault credential) — the feature flag
  // + Graph app-role grant are validated in bindExternalSource() instead.
  if (targetType === 'adls' || targetType === 'internal' || targetType === 'sharepoint') return null;

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
  /** SharePoint/OneDrive drive id + drive-relative path (Graph data plane). */
  sharepoint?: { driveId: string; path: string };
}

export async function bindExternalSource(args: {
  lakehouseId: string;
  name: string;
  targetType: 's3' | 'gcs' | 'dataverse' | 'delta_sharing' | 'sharepoint';
  targetUri: string;
  /** Optional — SharePoint/OneDrive resolves on the UAMI via Graph (no KV secret). */
  credentialRef?: ShortcutCredentialRef;
}): Promise<ExternalBinding | EngineGate> {
  const { lakehouseId, name, targetType, targetUri, credentialRef } = args;

  // --- SharePoint / OneDrive: resolve the drive item on the UAMI via Graph. ---
  // No per-shortcut Key Vault credential — Microsoft Graph is the data plane, on
  // the Console UAMI's Sites.Read.All / Files.Read.All app-roles. We prove the
  // targeted driveItem is readable now so the row only lands 'active' when real.
  // (Azure-native parity with Fabric OneDrive/SharePoint shortcuts; NO Fabric.)
  if (targetType === 'sharepoint') {
    const parsed = parseSharepointUri(targetUri);
    if (!parsed) {
      throw Object.assign(
        new Error(`SharePoint targetUri must be sharepoint://<driveId>/<path>; got: ${targetUri}`),
        { code: 'bad_target' },
      );
    }
    const gate = graphDriveConfigGate();
    if (gate) {
      return { gated: true, code: gate.code, hint: gate.hint.followUp };
    }
    // Real reachability probe — read the drive item (HEAD-equivalent).
    await headDriveItem(parsed.driveId, parsed.path);
    return { readUri: targetUri, sharepoint: { driveId: parsed.driveId, path: parsed.path } };
  }

  const secretName = credentialRef?.keyVaultSecret;
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
      testRes = await fetchWithTimeout(sharesUrl, { headers: { Authorization: `Bearer ${profile.bearerToken}` } });
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
      `WITH IDENTITY = 'S3 Access Key', SECRET = '${escapeSqlLiteral(secret.trim())}';\n` +
      `CREATE EXTERNAL DATA SOURCE ${dsName} ` +
      `WITH (LOCATION = '${obj.prefix}', CREDENTIAL = ${cred});`;
    await ensureServerlessDb();
    await executeQuery(serverlessTarget(serverlessDb()), ddl);
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
    case 'sharepoint': return 'SharePoint / OneDrive';
    default: return t;
  }
}

export const SHORTCUT_KINDS: ShortcutKind[] = ['files', 'tables'];
