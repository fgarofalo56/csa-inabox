/**
 * snowflake-adf — the Azure-native Snowflake backend for `mirrored-database`.
 *
 * ## Why this module exists
 *
 * `mirror-engine.runMirrorAdfCopy` could already copy Snowflake → ADLS Bronze,
 * but only if the operator had ALREADY hand-created an ADF Snowflake linked
 * service and pinned its name into `LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE`. That
 * is precisely the shape `auto-bind-by-default.md` §5 forbids: infra
 * prerequisites are DEPLOYED, not requested, and a remediation the platform
 * could have performed itself is a defect rather than a helpful message.
 *
 * Loom already holds everything the linked service needs — the Snowflake
 * connection carries accountIdentifier / database / warehouse / role / user, and
 * its credential is in Key Vault. So the platform builds the linked service
 * ITSELF, named after the Loom connection, and re-creates it if it goes missing.
 * No env var, no portal step, no wizard the user has to find.
 *
 * ## Secret handling (absolute)
 *
 * The Cosmos connection document stores only a Key Vault secret NAME. Two ways
 * the credential can reach ADF, in preference order:
 *
 *   1. **Key Vault reference (preferred).** When a Key Vault is configured, Loom
 *      also auto-binds an `AzureKeyVault` linked service (factory MI auth) and
 *      the Snowflake linked service references the secret BY NAME. The secret
 *      value never leaves Key Vault — Loom never reads it, ADF fetches it with
 *      the factory's own managed identity at run time.
 *   2. **Inline SecureString.** Only when no Key Vault linked service can be
 *      bound. The value is read from KV, handed straight to ARM, and never
 *      written to Cosmos, item state, a log line, or an API response.
 *
 * Nothing here returns, logs, or echoes a secret. `describe*` helpers exist so
 * callers can report WHICH credential a run used without touching its value.
 *
 * ## Grounding
 *   https://learn.microsoft.com/azure/data-factory/connector-snowflake
 *     — SnowflakeV2 linked service: accountIdentifier, database, warehouse,
 *       authenticationType (Basic | KeyPair), user, password / privateKey +
 *       privateKeyPassphrase, role. Dataset type SnowflakeV2Table
 *       (schema + table). Copy source type SnowflakeV2Source.
 */
import {
  upsertLinkedService, getLinkedService, upsertDataset, upsertPipeline,
  runPipeline, getPipelineRun, listActivityRuns, adfCdcConfigGate,
  type AdfLinkedService,
} from './adf-client';

import { loadConnection, type LoomConnection } from './connections-store';
import { getKeyVaultSecretValue, vaultUrl } from './kv-secrets-client';
// What a failed Snowflake read actually established. Only ever used to decide
// WHICH remediation (if any) is true of the backend's message — never to alter
// or replace the message itself.
import {
  classifySnowflakeFailure, describeSnowflakeFailure, snowflakeGateMissing,
} from './snowflake-failure-class';

/**
 * ADF object name: letters/digits/_ only, first char a letter.
 *
 * Byte-for-byte the same transform `mirror-engine.adfSafeName()` applies, and
 * deliberately re-implemented rather than imported: importing mirror-engine here
 * would create a cycle (the engine imports THIS module for the Snowflake
 * binding). A test asserts the two agree so they cannot drift.
 */
export function adfSafeName(raw: string): string {
  let n = String(raw || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '').slice(0, 120);
  if (!/^[A-Za-z]/.test(n)) n = `t_${n}`;
  return n || 'loom_mirror';
}


/**
 * The linked-service name for a Loom connection.
 *
 * `auto-bind-by-default.md` §2: the backing Azure object carries the SAME name
 * as the Loom object, sanitized only where the service's naming rules force it,
 * and deterministically — so the mapping is inspectable rather than guessed. The
 * connection id suffix keeps two identically-named connections distinct.
 */
export function snowflakeLinkedServiceName(conn: { id: string; name: string }): string {
  const slug = adfSafeName(conn.name || 'snowflake').slice(0, 60);
  return `${slug}_${(conn.id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`;
}

/** The auto-bound Key Vault linked service — one per factory, MI-authenticated. */
export const LOOM_KV_LINKED_SERVICE = 'loom_key_vault';

/**
 * Ensure the factory has a Key Vault linked service pointing at Loom's vault,
 * authenticated with the FACTORY's own managed identity (no credential field).
 * Returns its name, or null when no vault is configured for this deployment —
 * in which case the caller falls back to an inline SecureString.
 *
 * The factory MI needs "Key Vault Secrets User" on that vault; that grant is
 * made in bicep, not asked of the user.
 */
export async function ensureKeyVaultLinkedService(): Promise<string | null> {
  const url = vaultUrl();
  if (!url) return null;
  await upsertLinkedService(LOOM_KV_LINKED_SERVICE, {
    name: LOOM_KV_LINKED_SERVICE,
    properties: {
      type: 'AzureKeyVault',
      description: 'Loom connection secrets (factory managed-identity auth). Auto-bound — never hand-created.',
      typeProperties: { baseUrl: url },
    },
  });
  return LOOM_KV_LINKED_SERVICE;
}


/** A secret as ADF wants it: a KV reference (preferred) or an inline SecureString. */
type AdfSecret =
  | { type: 'AzureKeyVaultSecret'; store: { referenceName: string; type: 'LinkedServiceReference' }; secretName: string }
  | { type: 'SecureString'; value: string };

function kvRef(store: string, secretName: string): AdfSecret {
  return { type: 'AzureKeyVaultSecret', store: { referenceName: store, type: 'LinkedServiceReference' }, secretName };
}

/**
 * Build the `SnowflakeV2` linked-service spec for a Loom Snowflake connection.
 *
 * Pure and secret-free in shape: the credential arrives as an already-resolved
 * `AdfSecret`, so this function is unit-testable without Key Vault and cannot
 * accidentally read one. Exported for the tests, which assert the exact
 * typeProperties the ADF connector documents.
 */
/**
 * Normalise a Snowflake account identifier.
 *
 * Operators reliably paste the full sign-in URL. The ADF connector wants the
 * organization-account form (`myorg-account123`) and fails opaquely on anything
 * else, so the URL wrapping is stripped here rather than left to produce a
 * confusing run-time error. Exported so the normalisation is testable on its own
 * — inline, it could be deleted with the whole suite still green.
 */
export function normalizeSnowflakeAccount(raw: string | undefined | null): string {
  return String(raw ?? '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\.snowflakecomputing\.com$/i, '')
    .trim();
}

export function buildSnowflakeLinkedService(

  conn: Pick<LoomConnection, 'host' | 'database' | 'warehouse' | 'role' | 'username' | 'authMethod' | 'name'>,
  credential: AdfSecret | null,
): AdfLinkedService['properties'] {
  const account = normalizeSnowflakeAccount(conn.host);

  const keyPair = conn.authMethod === 'key-pair';
  const typeProperties: Record<string, unknown> = {
    accountIdentifier: account,
    database: (conn.database || '').trim(),
    warehouse: (conn.warehouse || '').trim(),
    authenticationType: keyPair ? 'KeyPair' : 'Basic',
    user: (conn.username || '').trim(),
  };
  if (conn.role && conn.role.trim()) typeProperties.role = conn.role.trim();
  if (credential) {
    // Basic → `password`; KeyPair → `privateKey`. Same secret slot either way,
    // different property name, per the connector's two documented shapes.
    typeProperties[keyPair ? 'privateKey' : 'password'] = credential;
  }
  return {
    type: 'SnowflakeV2',
    description: `Loom connection "${conn.name}" (auto-bound by CSA Loom — do not hand-edit).`,
    typeProperties,
  };
}

/** Why a Snowflake connection cannot yet produce a linked service. Never a secret. */
export interface SnowflakeBindGate {
  missing: string;
  message: string;
}

export interface SnowflakeBinding {
  /** The ADF linked-service name that reaches this Snowflake account. */
  linkedServiceName: string;
  /** How the credential reached ADF — for receipts. Carries no secret material. */
  credential: 'key-vault-reference' | 'inline-secure-string' | 'none';
  /** The Loom connection's display name, for the run note. */
  connectionName: string;
}

/**
 * Resolve a Loom Snowflake connection to a WORKING ADF linked service, creating
 * or repairing it as needed.
 *
 * Self-healing per `auto-bind-by-default.md` §3: the upsert is unconditional, so
 * a linked service that was deleted or edited out-of-band is simply rebuilt on
 * the next call rather than surfacing an error to the user.
 *
 * Returns a gate ONLY for things the platform genuinely cannot do for the user:
 * a connection that is not Snowflake, or one missing a coordinate ADF requires
 * (account / database / warehouse / user) — values only the operator can supply.
 */
export async function ensureSnowflakeBinding(
  tenantId: string,
  connectionId: string | undefined,
): Promise<{ binding: SnowflakeBinding } | { gate: SnowflakeBindGate }> {
  if (!connectionId) {
    return {
      gate: {
        missing: 'connectionId',
        message:
          'This Snowflake mirror has no connection bound. Open the mirror, pick or create a Snowflake connection ' +
          '(account identifier, warehouse, database, user + password or key pair), and save.',
      },
    };
  }
  const conn = await loadConnection(tenantId, connectionId);
  if (!conn) {
    return {
      gate: {
        missing: 'connection',
        message: 'The connection bound to this Snowflake mirror no longer exists. Bind a Snowflake connection and try again.',
      },
    };
  }
  if (conn.type !== 'snowflake') {
    return {
      gate: {
        missing: 'snowflake-connection',
        message:
          `Connection "${conn.name}" is a ${conn.type} connection, which cannot address a Snowflake account ` +
          '(Snowflake needs an account identifier, warehouse and role rather than a server FQDN). ' +
          'Create a Snowflake connection on this mirror instead.',
      },
    };
  }

  const missing: string[] = [];
  if (!conn.host?.trim()) missing.push('account identifier');
  if (!conn.database?.trim()) missing.push('database');
  if (!conn.warehouse?.trim()) missing.push('warehouse');
  if (!conn.username?.trim()) missing.push('user');
  if (missing.length) {
    return {
      gate: {
        missing: missing.join(', '),
        message:
          `Snowflake connection "${conn.name}" is missing ${missing.join(', ')}. ` +
          'Edit the connection and supply them — the ADF Snowflake connector requires all of them to open a session.',
      },
    };
  }

  // Credential: prefer a Key Vault reference so the value never leaves the
  // vault. Fall back to an inline SecureString only when no vault is bound.
  let credential: AdfSecret | null = null;
  let credentialKind: SnowflakeBinding['credential'] = 'none';
  if (conn.secretRef) {
    const kvLs = await ensureKeyVaultLinkedService();
    if (kvLs) {
      credential = kvRef(kvLs, conn.secretRef);
      credentialKind = 'key-vault-reference';
    } else {
      const value = await getKeyVaultSecretValue(conn.secretRef, 'connection-secret');
      credential = { type: 'SecureString', value };
      credentialKind = 'inline-secure-string';
    }
  }

  const lsName = snowflakeLinkedServiceName(conn);
  await upsertLinkedService(lsName, {
    name: lsName,
    properties: buildSnowflakeLinkedService(conn, credential),
  });
  return { binding: { linkedServiceName: lsName, credential: credentialKind, connectionName: conn.name } };
}

/**
 * Resolve the linked service a Snowflake mirror should use.
 *
 * An operator who has DELIBERATELY pinned their own linked service via
 * `LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE` keeps it (brownfield estates have
 * hand-tuned linked services with private endpoints / SHIRs we must not
 * clobber). Everyone else gets the auto-bound one. The env var is now an
 * override, not a prerequisite — which is the whole point of the change.
 */
export async function resolveSnowflakeLinkedService(
  tenantId: string,
  connectionId: string | undefined,
): Promise<{ binding: SnowflakeBinding } | { gate: SnowflakeBindGate }> {
  const pinned = (process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE || '').trim();
  if (pinned) {
    return { binding: { linkedServiceName: pinned, credential: 'none', connectionName: `env-pinned (${pinned})` } };
  }
  return ensureSnowflakeBinding(tenantId, connectionId);
}

/**
 * The dataset type that matches a linked service. An operator-pinned linked
 * service may still be the LEGACY `Snowflake` (V1) connector, and a
 * `SnowflakeV2Table` dataset bound to a V1 linked service is rejected by ADF.
 * So the type is READ from the factory rather than assumed.
 *
 * Falls back to V2 (what Loom auto-binds) when the linked service cannot be
 * read — and says so to the caller rather than silently guessing.
 */
export async function snowflakeDatasetKind(
  linkedServiceName: string,
): Promise<{ dataset: 'SnowflakeV2Table' | 'SnowflakeTable'; source: 'SnowflakeV2Source' | 'SnowflakeSource'; assumed: boolean }> {
  try {
    const ls = await getLinkedService(linkedServiceName);
    if (ls?.properties?.type === 'Snowflake') {
      return { dataset: 'SnowflakeTable', source: 'SnowflakeSource', assumed: false };
    }
    return { dataset: 'SnowflakeV2Table', source: 'SnowflakeV2Source', assumed: false };
  } catch {
    return { dataset: 'SnowflakeV2Table', source: 'SnowflakeV2Source', assumed: true };
  }
}

// ============================================================
// Table enumeration
// ============================================================

/** One Snowflake table, with whether it is a Snowflake-managed Iceberg table. */
export interface SnowflakeTable {
  schema: string;
  table: string;
  /** True for Snowflake-managed Apache Iceberg tables (INFORMATION_SCHEMA.TABLES.IS_ICEBERG = 'YES'). */
  isIceberg: boolean;
}

/**
 * The enumeration query.
 *
 * `IS_ICEBERG` is how Snowflake distinguishes a Snowflake-managed Iceberg table
 * from a standard one in INFORMATION_SCHEMA.TABLES, and it is the ONLY reason
 * the "Include Iceberg tables" toggle can mean anything: without this column the
 * two kinds are indistinguishable and the checkbox would be decorative.
 *
 * Older Snowflake editions do not expose the column at all, so the caller
 * retries without it and reports every table as non-Iceberg rather than failing
 * the whole enumeration.
 */
/**
 * Prove a Snowflake DATABASE NAME is a bare identifier, or throw.
 *
 * SECURITY: the database name is interpolated into the FROM clause of the
 * enumeration query. A Snowflake identifier cannot be parameterized — there is
 * no bind placeholder for `<db>.INFORMATION_SCHEMA.TABLES` — so the only defence
 * is proving the value is an identifier BEFORE it reaches the string. The
 * allowlist is deliberately positive (match the whole of a legal identifier)
 * rather than a denylist of punctuation: a denylist has to anticipate every
 * escape, and Snowflake accepts quoted identifiers, unicode, and `;`-separated
 * statements.
 *
 * Extracted and exported so it can be tested directly with hostile input. It
 * previously lived inline inside `snowflakeTablesQuery`, where deleting it still
 * left the whole suite green — an injection guard nothing exercises is not a
 * guard.
 */
export function assertSnowflakeIdentifier(database: string): string {
  const db = String(database ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(db)) {
    throw new Error(
      `"${db}" is not a valid Snowflake database identifier. Use a bare name such as SALES_DB (no quotes, dots, spaces, or semicolons).`,
    );
  }
  return db;
}

export function snowflakeTablesQuery(database: string, withIceberg = true): string {
  const db = assertSnowflakeIdentifier(database);
  const icebergCol = withIceberg ? ', IS_ICEBERG' : '';
  return (
    `SELECT TABLE_SCHEMA, TABLE_NAME${icebergCol} FROM ${db}.INFORMATION_SCHEMA.TABLES ` +
    "WHERE TABLE_TYPE IN ('BASE TABLE','VIEW') AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA' " +
    'ORDER BY TABLE_SCHEMA, TABLE_NAME'
  );
}


/**
 * Count the schemas the connection's role can actually SEE in the database.
 *
 * The discriminator for the zero-tables case (see the CountSchemas activity).
 * Uses the same identifier validation as the table query — the database name is
 * an identifier, not a bindable value, so it must be proven safe here too.
 */
export function snowflakeSchemaCountQuery(database: string): string {
  const db = assertSnowflakeIdentifier(database);
  return (
    `SELECT COUNT(*) AS VISIBLE_SCHEMAS FROM ${db}.INFORMATION_SCHEMA.SCHEMATA ` +
    "WHERE SCHEMA_NAME <> 'INFORMATION_SCHEMA'"
  );
}

/** Read VISIBLE_SCHEMAS out of the probe's first row. Null when unreadable. */
export function parseSchemaCount(firstRow: unknown): number | null {
  if (!firstRow || typeof firstRow !== 'object') return null;
  const rec = firstRow as Record<string, unknown>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === 'visible_schemas');
  if (key === undefined) return null;
  const n = Number(rec[key]);
  return Number.isFinite(n) ? n : null;
}

/** Map a Lookup activity's raw output rows to typed tables. Case-insensitive keys. */
export function parseSnowflakeTableRows(rows: unknown): SnowflakeTable[] {
  if (!Array.isArray(rows)) return [];
  const out: SnowflakeTable[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const pick = (k: string): unknown => {
      const hit = Object.keys(rec).find((x) => x.toLowerCase() === k);
      return hit === undefined ? undefined : rec[hit];
    };
    const schema = String(pick('table_schema') ?? '').trim();
    const table = String(pick('table_name') ?? '').trim();
    if (!schema || !table) continue;
    const ice = pick('is_iceberg');
    out.push({ schema, table, isIceberg: String(ice ?? '').trim().toUpperCase() === 'YES' });
  }
  return out;
}

/** How long to wait for the enumeration pipeline before giving up, in ms. */
const LOOKUP_TIMEOUT_MS = 150_000;
const LOOKUP_POLL_MS = 3_000;

/**
 * Enumerate a Snowflake database's tables through an ADF **Lookup** activity.
 *
 * WHY A PIPELINE AND NOT A DRIVER: Loom has no Snowflake client, and adding one
 * would mean a new npm dependency plus direct outbound egress from the Console
 * to Snowflake with the credential in process — in a deployment whose whole
 * shape is private endpoints and an in-VNet factory. ADF is already the runtime
 * that will do the copying, already holds the credential, and already has the
 * network path. Enumerating through the SAME runtime that replicates means the
 * table list can never disagree with what the mirror can actually read.
 *
 * Returns the tables, or a gate explaining exactly what stopped it. Never a
 * fabricated list.
 */
export async function listSnowflakeTables(
  tenantId: string,
  connectionId: string | undefined,
  database: string,
): Promise<{ tables: SnowflakeTable[]; icebergKnown: boolean; visibleSchemas: number | null } | { gate: SnowflakeBindGate }> {

  const adfGate = adfCdcConfigGate();
  if (adfGate) {
    return {
      gate: {
        missing: adfGate.missing,
        message:
          'Snowflake tables are read through the deployment\'s Azure Data Factory, which is not configured on this ' +
          `Console (${adfGate.missing}). It is deployed by platform/fiab/bicep — until it is, leave the table list ` +
          'empty to mirror every table the engine discovers.',
      },
    };
  }
  const resolved = await resolveSnowflakeLinkedService(tenantId, connectionId);
  if ('gate' in resolved) return resolved;
  const lsName = resolved.binding.linkedServiceName;
  const kind = await snowflakeDatasetKind(lsName);

  const stem = adfSafeName(`loom_sflist_${lsName}`).slice(0, 80);
  const dsName = `${stem}_ds`;
  const plName = `${stem}_pl`;

  // Try with IS_ICEBERG first; retry without it if the edition lacks the column.
  for (const withIceberg of [true, false]) {
    let query: string;
    try {
      query = snowflakeTablesQuery(database, withIceberg);
    } catch (e: any) {
      return { gate: { missing: 'database', message: e?.message || String(e) } };
    }
    try {
      await upsertDataset(dsName, {
        name: dsName,
        properties: {
          type: kind.dataset,
          linkedServiceName: { referenceName: lsName, type: 'LinkedServiceReference' },
          schema: [],
          typeProperties: {},
        },
      } as never);
      await upsertPipeline(plName, {
        name: plName,
        properties: {
          annotations: ['loom-mirror', 'loom-snowflake-enumerate'],
          folder: { name: 'loom-mirrors' },
          activities: [{
            name: 'ListTables',
            type: 'Lookup',
            dependsOn: [],
            policy: { timeout: '0.00:05:00', retry: 0 },
            typeProperties: {
              source: { type: kind.source, query },
              dataset: { referenceName: dsName, type: 'DatasetReference' },
              // The whole result set, not just the first row — this IS the list.
              firstRowOnly: false,
            },
          }, {
            // VISIBILITY PROBE. INFORMATION_SCHEMA.TABLES is privilege-filtered:
            // a role with USAGE on the database but no grants on its schemas
            // gets ZERO ROWS, not an error. Reported bare, that is
            // indistinguishable from an empty database and sends the operator
            // to look at the wrong thing. Counting the schemas the same role can
            // see discriminates the two, in the SAME run (one more activity, not
            // one more pipeline), so an empty result can say which it was
            // instead of asserting a cause it never established
            // (deploy-integrity.md R7).
            name: 'CountSchemas',
            type: 'Lookup',
            dependsOn: [],
            policy: { timeout: '0.00:05:00', retry: 0 },
            typeProperties: {
              source: { type: kind.source, query: snowflakeSchemaCountQuery(database) },
              dataset: { referenceName: dsName, type: 'DatasetReference' },
              firstRowOnly: true,
            },
          }],

        },
      } as never);

      const { runId } = await runPipeline(plName);
      const deadline = Date.now() + LOOKUP_TIMEOUT_MS;
      let status = 'Queued';
      let message = '';
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, LOOKUP_POLL_MS));
        const run = await getPipelineRun(runId);
        status = run?.status || status;
        message = run?.message || '';
        if (status === 'Succeeded' || status === 'Failed' || status === 'Cancelled') break;
      }
      if (status !== 'Succeeded') {
        const detail = message || `the run ended as ${status}`;
        // A missing IS_ICEBERG column fails the first attempt — fall through to
        // the retry rather than reporting a gate the operator cannot act on.
        if (withIceberg && /IS_ICEBERG|invalid identifier/i.test(detail)) continue;
        // THE R7 SITE (deploy-integrity.md). This used to append, to EVERY
        // failure whatever it said: "Check that the connection's role has USAGE
        // on database <db> and SELECT on its tables, and that the warehouse can
        // start." Measured live against an MFA rejection, that advice was
        // false — Snowflake had already named the cause and no grant could
        // touch it. The remediation is now derived from what the backend
        // actually said, and an unrecognised failure gets NONE.
        const kind = classifySnowflakeFailure(detail);
        return {
          gate: {
            missing: snowflakeGateMissing(kind),
            message: describeSnowflakeFailure('Snowflake did not return a table list', detail, database),
          },
        };
      }

      const acts = await listActivityRuns(runId);
      const lookup = acts.find((a) => a.activityName === 'ListTables');
      const rows = (lookup?.output as { value?: unknown } | undefined)?.value;
      const tables = parseSnowflakeTableRows(rows);

      // Zero tables is ambiguous — resolve it with the visibility probe rather
      // than reporting "empty database" as though it were established.
      let visibleSchemas: number | null = null;
      const schemaAct = acts.find((a) => a.activityName === 'CountSchemas');
      if (schemaAct) {
        const out = schemaAct.output as { firstRow?: Record<string, unknown> } | undefined;
        visibleSchemas = parseSchemaCount(out?.firstRow);
      }

      return { tables, icebergKnown: withIceberg, visibleSchemas };

    } catch (e: any) {
      const msg = e?.message || String(e);
      if (withIceberg && /IS_ICEBERG|invalid identifier/i.test(msg)) continue;
      // DELIBERATELY NOT run through snowflakeRemediation. Everything inside
      // this try throws from ARM (upsertDataset / upsertPipeline / runPipeline /
      // getPipelineRun), not from Snowflake — the Snowflake driver's words reach
      // us via the pipeline run's `message`, handled above. Attaching Snowflake
      // advice to an ARM fault would be this module's own defect inverted:
      // naming a cause on the wrong system entirely. The message is surfaced
      // verbatim with no cause asserted, which is what it establishes.
      return {
        gate: {
          missing: 'snowflake-read',
          message: `Could not enumerate Snowflake tables: ${msg}`,
        },
      };
    }
  }
  return {
    gate: {
      missing: 'snowflake-read',
      message: 'Snowflake returned no table list on either the Iceberg-aware or the plain enumeration query.',
    },
  };
}
