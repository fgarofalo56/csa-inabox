/**
 * mirror-source-compat — which Loom Connection types can back which mirrored-
 * database SOURCE TYPE, and the honest refusal when a mirror is typed as one
 * backend while the connection bound to it addresses another.
 *
 * WHY THIS MODULE EXISTS (the incident it fixes)
 * ---------------------------------------------
 * An operator created a Snowflake connection, left the wizard's source type on
 * its hardcoded default (`AzureSqlDatabase`), and hit "Load tables". The route
 * dispatches on `sourceType`, so it took the SQL/TDS branch and handed the
 * Snowflake ACCOUNT IDENTIFIER to the Azure SQL client — which appends the
 * Azure SQL host suffix to any server name with no dot in it
 * (`azure-sql-client.ts`: `server.includes('.') ? server : ${server}.${suffix}`).
 * The operator was then shown a connect failure naming
 * `<their-account-id>.<the deployment's Azure SQL suffix>` on the TDS port,
 * with a `getaddrinfo ENOTFOUND` for it — a DNS failure for a hostname LOOM
 * ITSELF INVENTED, naming a domain they had never typed. They reasonably read
 * it as a network problem and opened their Snowflake firewall wide open, which
 * changed nothing, because no packet had ever been sent toward Snowflake. That
 * message asserted a cause the code had not established, which is precisely
 * what deploy-integrity.md R7 forbids.
 *
 * CLOUD-INDEPENDENT BY CONSTRUCTION. This module decides using ONLY the
 * declared `sourceType` and the bound connection's `type`. It never inspects,
 * parses, or matches a hostname, so it behaves identically in Commercial, GCC,
 * GCC-High, IL5 and DoD — which matters because the suffix `azure-sql-client`
 * appends is cloud-dependent (`cloud-endpoints.getSqlSuffix`), and a detector
 * keyed to one cloud's suffix would be blind in the others (cloud-parity.md).
 * The verbatim Commercial-suffix error text lives in
 * `__tests__/mirror-source-compat.test.ts`, where a host literal is in scope for
 * assertions; keeping it out of this module keeps the module suffix-free.
 *
 * The mismatch is refused HERE, before anything is dialled, so the message can
 * say truthfully that nothing was contacted and that this is not a network
 * problem. Both enumeration routes and the replication engine consult this one
 * module: a check that lives in a helper only its original caller adopts is the
 * recurring guard-adoption gap in this repo (see connection-auth.ts's header
 * for the last time that happened on this exact item type).
 *
 * The module is deliberately free of the Azure SDK / Cosmos chain — same
 * contract as `connectable-types.ts` — so the CLIENT wizard and the SERVER
 * routes share one source of truth rather than two that can drift.
 */
import type { ConnectionType } from './connections-store';
import { CONN_TYPE_LABEL } from './connectable-types';

/** Every mirrored-database source type the wizard offers. */
export type MirrorSourceId =
  | 'AzureSqlDatabase' | 'AzureSqlMI' | 'AzurePostgreSql' | 'CosmosDb'
  | 'Snowflake' | 'GoogleBigQuery' | 'Oracle'
  | 'SqlServer2025' | 'MSSQL' | 'GenericMirror' | 'DatabricksUC';

/**
 * Source type → the Loom Connection types that can legitimately back it.
 *
 * THE single source of truth: `MIRROR_SOURCES` in the wizard reads its
 * `connTypes` from here rather than restating them, so the picker and the
 * server-side refusal cannot disagree about what is compatible.
 *
 * `DatabricksUC` is intentionally empty — that card routes to the dedicated
 * `mirrored-databricks` item type and never binds a connection here.
 */
export const MIRROR_SOURCE_CONN_TYPES: Record<MirrorSourceId, ConnectionType[]> = {
  AzureSqlDatabase: ['azure-sql', 'generic-sql'],
  AzureSqlMI: ['azure-sql', 'generic-sql'],
  AzurePostgreSql: ['postgres'],
  CosmosDb: ['cosmos'],
  Snowflake: ['snowflake'],
  GoogleBigQuery: ['bigquery'],
  Oracle: ['oracle', 'generic-sql'],
  SqlServer2025: ['generic-sql'],
  MSSQL: ['generic-sql'],
  GenericMirror: ['azure-sql', 'postgres', 'cosmos', 'storage-adls', 'generic-sql'],
  DatabricksUC: [],
};

/** Display name per source type — shared with the wizard's cards. */
export const MIRROR_SOURCE_LABEL: Record<MirrorSourceId, string> = {
  AzureSqlDatabase: 'Azure SQL Database',
  AzureSqlMI: 'Azure SQL Managed Instance',
  AzurePostgreSql: 'Azure Database for PostgreSQL',
  CosmosDb: 'Azure Cosmos DB',
  Snowflake: 'Snowflake',
  GoogleBigQuery: 'Google BigQuery',
  Oracle: 'Oracle Database',
  SqlServer2025: 'SQL Server 2025',
  MSSQL: 'SQL Server 2016-2022',
  GenericMirror: 'Open mirroring',
  DatabricksUC: 'Databricks Unity Catalog',
};

/** Ordered ids, so the wizard renders a stable card order. */
export const MIRROR_SOURCE_IDS = Object.keys(MIRROR_SOURCE_CONN_TYPES) as MirrorSourceId[];

function isKnownSource(t: string): t is MirrorSourceId {
  return Object.prototype.hasOwnProperty.call(MIRROR_SOURCE_CONN_TYPES, t);
}

/**
 * The source types a connection of this type can back, in catalog order.
 * `DatabricksUC` is excluded — it declares no connTypes, so it can never match.
 */
export function mirrorSourceIdsForConnType(connType: string): MirrorSourceId[] {
  return MIRROR_SOURCE_IDS.filter((id) => (MIRROR_SOURCE_CONN_TYPES[id] as string[]).includes(connType));
}

/**
 * Is this connection type a legitimate backing for this source type?
 *
 * Returns TRUE whenever the answer cannot be ESTABLISHED — an unknown source
 * type, or a connection whose type we could not read (deleted connection, no
 * connection bound at all). Per deploy-integrity.md R7 an unknown must never be
 * reported as a negative: refusing a mirror because a lookup failed would be
 * the same class of false claim this module exists to remove.
 */
export function isMirrorConnectionCompatible(sourceType: string, connType?: string): boolean {
  if (!connType) return true;
  if (!isKnownSource(sourceType)) return true;
  const allowed = MIRROR_SOURCE_CONN_TYPES[sourceType] as string[];
  // A source that declares no connection types makes no claim either way.
  if (!allowed.length) return true;
  return allowed.includes(connType);
}

export interface MirrorConnMismatch {
  sourceType: string;
  connType: string;
  /** Source types this connection COULD back — the offered repair. */
  candidates: MirrorSourceId[];
  /** Operator-facing text. Contains no constructed hostname (R7). */
  message: string;
}

function connLabelOf(connType: string): string {
  return (CONN_TYPE_LABEL as Record<string, string>)[connType] || connType;
}

function sourceLabelOf(sourceType: string): string {
  return isKnownSource(sourceType) ? MIRROR_SOURCE_LABEL[sourceType] : sourceType;
}

/**
 * Describe a source-type / connection-type mismatch, or `null` when the pair is
 * compatible (or when compatibility could not be established).
 *
 * The message states ONLY what is established at the point of refusal:
 *   - what the mirror is typed as, and what the bound connection actually is;
 *   - that NO request was sent to either system — true because every caller
 *     consults this before it dials anything, which is the whole point;
 *   - the concrete repair, naming the source type to switch to.
 *
 * It never contains a hostname, a port, or a DNS result. Loom constructs the
 * Azure SQL hostname from the source's server field, so echoing it back reports
 * a name the user never supplied as though they had — the original defect.
 */
export function describeMirrorConnMismatch(args: {
  sourceType: string;
  connType?: string;
  connName?: string;
}): MirrorConnMismatch | null {
  const { sourceType, connType, connName } = args;
  if (!connType) return null;
  if (isMirrorConnectionCompatible(sourceType, connType)) return null;

  const candidates = mirrorSourceIdsForConnType(connType);
  const srcLabel = sourceLabelOf(sourceType);
  const connLabel = connLabelOf(connType);
  const who = connName ? `the connection bound to it ("${connName}")` : 'the connection bound to it';

  // What "${srcLabel}" WOULD accept, named by connection-type label, so the
  // second half of the repair is as concrete as the first.
  const acceptedHere = (isKnownSource(sourceType) ? MIRROR_SOURCE_CONN_TYPES[sourceType] : [])
    .map(connLabelOf).join(' / ');
  const swapConnection = acceptedHere
    ? `bind a connection "${srcLabel}" can read instead (${acceptedHere})`
    : 'bind a different connection';

  const repair = candidates.length === 1
    ? `Set this mirror's source type to "${MIRROR_SOURCE_LABEL[candidates[0]]}" (Edit the mirror → Choose a source), or ${swapConnection}.`
    : candidates.length > 1
      ? `Set this mirror's source type to one of ${candidates.map((c) => `"${MIRROR_SOURCE_LABEL[c]}"`).join(', ')}, or ${swapConnection}.`
      : `No mirrored-database source type can be backed by a ${connLabel} connection — ${swapConnection}.`;

  const message =
    `Source type does not match the bound connection, so no request was sent to either system — ` +
    `this is not a network, DNS, or firewall problem. ` +
    `This mirror's source type is "${srcLabel}", but ${who} is a ${connLabel} connection, ` +
    `which that source type cannot read. ${repair}`;

  return { sourceType, connType, candidates, message };
}
