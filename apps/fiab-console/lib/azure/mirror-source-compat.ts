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
 * THE SHAPE OF THE REFUSAL (round 4 of review changed this)
 * ---------------------------------------------------------
 * Refusal is a DENYLIST over WIRE PROTOCOL, not an allowlist over catalogued
 * pairings. The first cut was the latter, and cross-producting its two domains
 * refused 143 of 176 pairs — among them
 * `isMirrorConnectionCompatible('SqlServer2025','azure-sql') === false`, a SQL
 * Server mirror bound to an Azure SQL connection: TDS on both sides, creatable,
 * and working. An allowlist also fails in the wrong direction, refusing any
 * newly-added ConnectionType under every source type until someone remembers to
 * list it. `MIRROR_SOURCE_CONN_TYPES` survives as the picker's CATALOG and the
 * source of repair candidates; the predicate is keyed to protocol.
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
 * Source type → the Loom Connection types Loom RECOMMENDS for it.
 *
 * THIS IS A CATALOG, NOT A REFUSAL RULE. It drives two things only:
 *   - the wizard's per-card connection filter (`MIRROR_SOURCES` reads its
 *     `connTypes` from here rather than restating them, so the picker and this
 *     module cannot disagree about what is OFFERED); and
 *   - `mirrorSourceIdsForConnType()`, the repair candidates a Fix-it button is
 *     rendered from.
 *
 * It is deliberately NOT what `isMirrorConnectionCompatible()` refuses on. Round
 * 4 of review measured that: read as an allowlist, cross-producting the two
 * domains refused **143 of 176 pairs**, including
 * `('SqlServer2025','azure-sql')` — a SQL Server mirror bound to an Azure SQL
 * connection, which is TDS on both sides and works today. An allowlist also
 * fails in the wrong DIRECTION: a ConnectionType added to `connections-store`
 * and not added here would be refused under every source type by default, which
 * is the opposite of the default-ON/opt-out posture the platform is held to.
 * Refusal is now a DENYLIST keyed to wire protocol — see `WIRE_PROTOCOL` below.
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

// ── The refusal rule: a WIRE-PROTOCOL denylist ──────────────────────────────
//
// The defect is not "an unlisted pairing". It is that `sourceType` selects WHICH
// CLIENT reads the source, and a client can only speak one wire protocol. The
// incident was a Snowflake account identifier handed to `azure-sql-client`,
// whose `getPool()` does `server.includes('.') ? server : server + sqlSuffix()`
// and then `pool.connect()` — a TDS dial against a hostname Loom constructed.
//
// So the only thing that is ESTABLISHED, and the only thing worth refusing on,
// is: the source type's reader speaks protocol A, the bound connection is an
// endpoint that speaks protocol B, and A !== B. Anything we cannot establish —
// either side unknown — is ALLOWED. That is the direction round 4 required: a
// new ConnectionType, or a new source type, is permitted by default rather than
// refused by default.

/**
 * The wire protocols this module distinguishes. Two things are the SAME protocol
 * only when one client can read both — `azure-sql`, `generic-sql`,
 * `synapse-dedicated` and `synapse-serverless` are all TDS/1433 and are all read
 * by `azure-sql-client`, so they are one family here even though they are four
 * ConnectionTypes and four different Azure services.
 */
export type MirrorWireProtocol =
  | 'tds' | 'postgresql' | 'cosmos-sql' | 'snowflake' | 'bigquery' | 'oracle'
  | 'mysql' | 'databricks-sql' | 'kusto' | 'adls-https' | 'eventhub-amqp'
  | 'servicebus-amqp' | 'keyvault-https';

/**
 * The protocol the reader for each source type actually speaks, read off the
 * ENGINE's own family dispatch (`mirror-engine.ts`) rather than asserted here:
 *
 *   MIRROR_SQL_FAMILY    → azure-sql-client        → TDS
 *   MIRROR_PG_FAMILY     → postgres-flex-client    → the PostgreSQL wire protocol
 *   MIRROR_COSMOS_FAMILY → the Cosmos SQL data plane
 *   MIRROR_ADF_COPY_FAMILY → an ADF Snowflake linked service
 *
 * `null` means LOOM NEVER DIALS THIS SOURCE, so no protocol claim can be made
 * about it and nothing is refused under it:
 *   - `GoogleBigQuery` / `Oracle` have no reader at all today. They are outside
 *     every engine family, so `engineCanSnapshot()` is false and Start returns
 *     an honest "needs its own copy runtime" gate without contacting anything.
 *     Claiming a protocol mismatch for a source Loom cannot read either way
 *     would be an unestablished claim (deploy-integrity.md R7).
 *   - `GenericMirror` is OPEN MIRRORING: the customer pushes files into the
 *     landing zone and Loom reads no source at all.
 *   - `DatabricksUC` routes to the `mirrored-databricks` item type.
 *
 * NOTE the asymmetry, and that it is deliberate: a bigquery/oracle CONNECTION
 * under a SQL SOURCE TYPE is still refused, because THAT direction dials TDS.
 * It is only the reverse — those source types, which never dial — that makes no
 * claim.
 */
export const MIRROR_SOURCE_READER_PROTOCOL: Record<MirrorSourceId, MirrorWireProtocol | null> = {
  AzureSqlDatabase: 'tds',
  AzureSqlMI: 'tds',
  SqlServer2025: 'tds',
  MSSQL: 'tds',
  AzurePostgreSql: 'postgresql',
  CosmosDb: 'cosmos-sql',
  Snowflake: 'snowflake',
  GoogleBigQuery: null,
  Oracle: null,
  GenericMirror: null,
  DatabricksUC: null,
};

/**
 * The protocol each ConnectionType's endpoint speaks. Every entry is a property
 * of the Azure/third-party service itself, not of Loom — which is what makes a
 * refusal built on it defensible one pair at a time.
 *
 * Exhaustive over `ConnectionType` by type, so adding a ConnectionType without
 * classifying it fails `tsc` rather than silently defaulting to "refuse".
 */
export const MIRROR_CONN_ENDPOINT_PROTOCOL: Record<ConnectionType, MirrorWireProtocol> = {
  // All four are SQL Server-protocol endpoints on 1433, read by azure-sql-client.
  'azure-sql': 'tds',
  'generic-sql': 'tds',
  'synapse-dedicated': 'tds',
  'synapse-serverless': 'tds',
  'postgres': 'postgresql',
  'cosmos': 'cosmos-sql',
  'snowflake': 'snowflake',
  'bigquery': 'bigquery',
  'oracle': 'oracle',
  'mysql': 'mysql',
  'databricks-sql': 'databricks-sql',
  'adx': 'kusto',
  'storage-adls': 'adls-https',
  'event-hub': 'eventhub-amqp',
  'service-bus': 'servicebus-amqp',
  'key-vault': 'keyvault-https',
};

/** How each protocol is named to an operator, in the refusal text. */
const PROTOCOL_LABEL: Record<MirrorWireProtocol, string> = {
  'tds': 'the SQL Server wire protocol (TDS)',
  'postgresql': 'the PostgreSQL wire protocol',
  'cosmos-sql': 'the Cosmos DB SQL data-plane API',
  'snowflake': 'the Snowflake driver protocol',
  'bigquery': 'the BigQuery API',
  'oracle': 'Oracle Net',
  'mysql': 'the MySQL wire protocol',
  'databricks-sql': 'the Databricks SQL warehouse protocol',
  'kusto': 'the Kusto (Azure Data Explorer) query API',
  'adls-https': 'the ADLS Gen2 HTTPS API',
  'eventhub-amqp': 'the Event Hubs AMQP/Kafka protocol',
  'servicebus-amqp': 'the Service Bus AMQP protocol',
  'keyvault-https': 'the Key Vault HTTPS API',
};

function readerProtocolOf(sourceType: string): MirrorWireProtocol | null {
  return isKnownSource(sourceType) ? MIRROR_SOURCE_READER_PROTOCOL[sourceType] : null;
}

function endpointProtocolOf(connType: string): MirrorWireProtocol | null {
  return (MIRROR_CONN_ENDPOINT_PROTOCOL as Record<string, MirrorWireProtocol | undefined>)[connType] ?? null;
}

/**
 * The ConnectionTypes whose endpoint speaks the protocol this source type is
 * read with — i.e. exactly the set that is NOT refused. Used for the second half
 * of the repair ("or bind one of these instead"), so the text names what would
 * actually be accepted rather than what the catalog happens to list.
 */
export function mirrorConnTypesSpeaking(sourceType: string): ConnectionType[] {
  const want = readerProtocolOf(sourceType);
  if (!want) return [];
  return (Object.keys(MIRROR_CONN_ENDPOINT_PROTOCOL) as ConnectionType[])
    .filter((c) => MIRROR_CONN_ENDPOINT_PROTOCOL[c] === want);
}

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
 * A DENYLIST, not an allowlist: `false` ONLY when both protocols are known and
 * they differ. Everything else is `true`.
 *
 * Returns TRUE whenever the answer cannot be ESTABLISHED — an unknown source
 * type, an unclassified connection type, a connection whose type we could not
 * read (deleted connection, no connection bound at all), or a source Loom never
 * dials. Per deploy-integrity.md R7 an unknown must never be reported as a
 * negative: refusing a mirror because a lookup failed, or because a pairing was
 * merely not in a catalog, is the same class of false claim this module exists
 * to remove.
 */
export function isMirrorConnectionCompatible(sourceType: string, connType?: string): boolean {
  if (!connType) return true;
  const reader = readerProtocolOf(sourceType);
  if (!reader) return true;
  const endpoint = endpointProtocolOf(connType);
  if (!endpoint) return true;
  return reader === endpoint;
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
 *   - what the mirror is typed as, and WHICH WIRE PROTOCOL that selects — a
 *     fact about Loom's own dispatch, not a prediction about the remote system;
 *   - what the bound connection actually is, and what protocol its endpoint
 *     speaks;
 *   - that NO request was sent to either system — true because every caller
 *     consults this before it dials anything, which is the whole point;
 *   - the concrete repair.
 *
 * WHAT IT DELIBERATELY NO LONGER SAYS (round 4, deploy-integrity.md R7):
 *
 *   - "…which that source type CANNOT READ." That was an inferred cause, and it
 *     was sometimes false: it was emitted for `('SqlServer2025','azure-sql')`,
 *     where TDS reads Azure SQL perfectly well. The refusal now reports the
 *     protocol disagreement it actually established and stops there.
 *   - "(Edit the mirror → Choose a source)". A navigation instruction to a route
 *     that does not exist for every consumer of this text: `app/api/cdc/
 *     connectors/[id]/route.ts` exports GET and DELETE only, and there is no
 *     PATCH or PUT anywhere under `app/api/cdc/`. Sending an operator to an edit
 *     surface that is not there is the dead end `auto-bind-by-default.md` names
 *     explicitly. The repair is stated as the CHANGE to make; the in-product
 *     one-click path is the wizard's Fix-it bar, which renders from `candidates`
 *     below rather than from a sentence.
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

  // Both protocols are non-null here — `isMirrorConnectionCompatible` returned
  // false, which it only does when both are known and they differ.
  const readerLabel = PROTOCOL_LABEL[readerProtocolOf(sourceType)!];
  const endpointLabel = PROTOCOL_LABEL[endpointProtocolOf(connType)!];

  // What WOULD be accepted here, named by connection-type label. Derived from
  // the protocol map, so this half of the repair is exactly the set that would
  // pass the check — not a catalog that could disagree with it.
  const acceptedHere = mirrorConnTypesSpeaking(sourceType).map(connLabelOf).join(' / ');
  const swapConnection = acceptedHere
    ? `bind a connection that speaks it instead (${acceptedHere})`
    : 'bind a different connection';

  const repair = candidates.length === 1
    ? `Set this mirror's source type to "${MIRROR_SOURCE_LABEL[candidates[0]]}", or ${swapConnection}.`
    : candidates.length > 1
      ? `Set this mirror's source type to one of ${candidates.map((c) => `"${MIRROR_SOURCE_LABEL[c]}"`).join(', ')}, or ${swapConnection}.`
      : `No mirrored-database source type is backed by a ${connLabel} connection — ${swapConnection}.`;

  const message =
    `Source type does not match the bound connection, so no request was sent to either system — ` +
    `this is not a network, DNS, or firewall problem. ` +
    `This mirror's source type is "${srcLabel}", which Loom reads over ${readerLabel}, ` +
    `but ${who} is a ${connLabel} connection, whose endpoint speaks ${endpointLabel}. ${repair}`;

  return { sourceType, connType, candidates, message };
}
