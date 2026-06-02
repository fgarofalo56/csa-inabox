/**
 * Data API builder (DAB) config model — the typed authoring shape the editor
 * mutates, plus a deterministic emit-to-canonical-`dab-config.json` function and
 * a `dab validate`-parity validator (schema + cross-reference checks).
 *
 * Grounded 1:1 in the Microsoft Learn DAB configuration reference:
 *   https://learn.microsoft.com/azure/data-api-builder/configuration/
 *   https://learn.microsoft.com/azure/data-api-builder/configuration/entities
 *   https://learn.microsoft.com/azure/data-api-builder/configuration/runtime
 *
 * Design rules (no-vaporware.md):
 *  - We NEVER persist a literal connection string. The emitted JSON always
 *    references `@env('DATABASE_CONNECTION_STRING')`; the actual secret is
 *    injected as a Container-App secret at deploy time. The authoring model
 *    instead carries a `sourceRef` ({kind, server, database}) used by the BFF
 *    to resolve schema and (later) the connection string.
 *  - The emitted document targets the published draft schema URL so a real
 *    `dab validate` / engine accepts it verbatim.
 *
 * Underscore-prefixed `_lib` folder — Next.js does not treat this as a route.
 */

export const DAB_SCHEMA_URL =
  'https://github.com/Azure/data-api-builder/releases/latest/download/dab.draft.schema.json';

/** The env var the emitted JSON references for the DB connection string. */
export const DAB_CONNECTION_ENV = 'DATABASE_CONNECTION_STRING';

export type DabDatabaseType = 'mssql' | 'dwsql' | 'postgresql' | 'mysql' | 'cosmosdb_nosql';
export type DabSourceType = 'table' | 'view' | 'stored-procedure';
export type DabAction = 'create' | 'read' | 'update' | 'delete' | 'execute' | '*';
export type DabCardinality = 'one' | 'many';
export type DabHostMode = 'development' | 'production';
export type DabAuthProvider =
  | 'Unauthenticated'
  | 'StaticWebApps'
  | 'AppService'
  | 'EntraId'
  | 'Custom'
  | 'Simulator';

/**
 * Which Synapse SQL surface a `dwsql` source points at. Grounded in Learn:
 * DAB's `dwsql` database-type supports the Synapse **Dedicated** SQL pool
 * (tables/views/stored-procedures). The **Serverless** SQL pool is explicitly
 * NOT supported by DAB
 * (https://learn.microsoft.com/azure/data-api-builder/reference-database-specific-features#azure-synapse-analytics-dedicated-sql-pool
 *  — "Serverless SQL pool isn't supported"). We still let the user point at the
 * serverless endpoint to introspect objects for exploration, but the config is
 * flagged non-deployable so we never claim parity we don't have.
 */
export type DabSynapseRole = 'dedicated' | 'serverless';

/** A non-secret reference to a Loom data source, resolved server-side. */
export interface DabSourceRef {
  kind: DabDatabaseType;
  /** Server name / Cosmos account / PG flexible-server name / Synapse SQL FQDN. */
  server?: string;
  /** Database name (or Cosmos database / Synapse dedicated pool name). */
  database?: string;
  /** Cosmos-only: the .gql schema the user supplied (schema-less backend). */
  graphqlSchema?: string;
  /** `dwsql`-only: which Synapse SQL surface this points at. */
  synapseRole?: DabSynapseRole;
}

/** Per-entity field metadata (DAB 2.0 `fields[]` — supersedes mappings + key-fields). */
export interface DabField {
  name: string;
  alias?: string;
  description?: string;
  primaryKey?: boolean;
}

/** A single action entry with optional field- and row-level security. */
export interface DabActionEntry {
  action: DabAction;
  /** Field-level include/exclude. */
  fields?: { include?: string[]; exclude?: string[] };
  /** Row-level OData predicate over @item.* / @claims.*. */
  policyDatabase?: string;
}

export interface DabPermission {
  role: string;
  /** Either bare actions (no field/policy) or rich action entries. */
  actions: DabActionEntry[];
}

export interface DabRelationship {
  name: string;
  cardinality: DabCardinality;
  targetEntity: string;
  sourceFields?: string[];
  targetFields?: string[];
  /** Many-to-many linking object + join fields. */
  linkingObject?: string;
  linkingSourceFields?: string[];
  linkingTargetFields?: string[];
}

export interface DabEntity {
  /** The exposed entity name (GraphQL type / catalog key). */
  name: string;
  description?: string;
  source: {
    object: string;
    type: DabSourceType;
    parameters?: { name: string; required?: boolean; default?: unknown; description?: string }[];
  };
  rest: { enabled: boolean; path?: string; methods?: ('get' | 'post' | 'put' | 'patch' | 'delete')[] };
  graphql: {
    enabled: boolean;
    singular?: string;
    plural?: string;
    operation?: 'query' | 'mutation';
  };
  fields?: DabField[];
  permissions: DabPermission[];
  relationships?: DabRelationship[];
  cache?: { enabled: boolean; ttlSeconds?: number; level?: 'L1' | 'L1L2' };
}

export interface DabRuntime {
  rest: { enabled: boolean; path: string; requestBodyStrict: boolean };
  graphql: { enabled: boolean; path: string; allowIntrospection: boolean };
  host: {
    mode: DabHostMode;
    corsOrigins: string[];
    corsAllowCredentials: boolean;
    authProvider: DabAuthProvider;
    jwtAudience?: string;
    jwtIssuer?: string;
  };
  cache: { enabled: boolean; ttlSeconds: number };
  pagination: { defaultPageSize: number; maxPageSize: number };
}

export interface DabConfig {
  sourceRef: DabSourceRef;
  runtime: DabRuntime;
  entities: DabEntity[];
}

/** A fresh config with Learn-default runtime values. */
export function emptyDabConfig(kind: DabDatabaseType = 'mssql'): DabConfig {
  return {
    sourceRef: { kind },
    runtime: {
      rest: { enabled: true, path: '/api', requestBodyStrict: true },
      graphql: { enabled: true, path: '/graphql', allowIntrospection: true },
      host: {
        mode: 'development',
        corsOrigins: [],
        corsAllowCredentials: false,
        authProvider: 'Simulator',
      },
      cache: { enabled: false, ttlSeconds: 5 },
      pagination: { defaultPageSize: 100, maxPageSize: 100000 },
    },
    entities: [],
  };
}

// ---------------------------------------------------------------------------
// Emit → canonical dab-config.json (the exact shape DAB's engine consumes).
// ---------------------------------------------------------------------------

function emitActions(perm: DabPermission, sourceType: DabSourceType): unknown[] {
  return perm.actions.map((a) => {
    const hasExtras =
      (a.fields && (a.fields.include?.length || a.fields.exclude?.length)) || a.policyDatabase;
    if (!hasExtras) return a.action;
    const entry: Record<string, unknown> = { action: a.action };
    if (a.fields && (a.fields.include?.length || a.fields.exclude?.length)) {
      entry.fields = {
        ...(a.fields.include?.length ? { include: a.fields.include } : {}),
        ...(a.fields.exclude?.length ? { exclude: a.fields.exclude } : {}),
      };
    }
    // Database policies are unsupported for create/execute (per Learn).
    if (a.policyDatabase && a.action !== 'create' && a.action !== 'execute') {
      entry.policy = { database: a.policyDatabase };
    }
    return entry;
  });
}

function emitEntity(e: DabEntity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (e.description) out.description = e.description;

  // Source.
  const source: Record<string, unknown> = { object: e.source.object, type: e.source.type };
  if (e.source.type === 'stored-procedure' && e.source.parameters?.length) {
    source.parameters = e.source.parameters.map((p) => ({
      name: p.name,
      ...(p.required !== undefined ? { required: p.required } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.description ? { description: p.description } : {}),
    }));
  }
  out.source = source;

  // REST.
  const rest: Record<string, unknown> = { enabled: e.rest.enabled };
  if (e.rest.path) rest.path = e.rest.path.startsWith('/') ? e.rest.path : `/${e.rest.path}`;
  if (e.source.type === 'stored-procedure' && e.rest.methods?.length) {
    rest.methods = e.rest.methods.map((m) => m.toUpperCase());
  }
  out.rest = rest;

  // GraphQL.
  const gql: Record<string, unknown> = { enabled: e.graphql.enabled };
  if (e.graphql.singular) {
    gql.type = { singular: e.graphql.singular, ...(e.graphql.plural ? { plural: e.graphql.plural } : {}) };
  }
  if (e.source.type === 'stored-procedure' && e.graphql.operation) {
    gql.operation = e.graphql.operation;
  }
  out.graphql = gql;

  // Fields (2.0 unified — alias + primary-key).
  const fields = (e.fields || []).filter((f) => f.alias || f.primaryKey || f.description);
  if (fields.length) {
    out.fields = fields.map((f) => ({
      name: f.name,
      ...(f.alias ? { alias: f.alias } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...(f.primaryKey ? { 'primary-key': true } : {}),
    }));
  }

  // Permissions.
  out.permissions = e.permissions.map((p) => ({
    role: p.role,
    actions: emitActions(p, e.source.type),
  }));

  // Relationships.
  if (e.relationships?.length) {
    const rels: Record<string, unknown> = {};
    for (const r of e.relationships) {
      const rel: Record<string, unknown> = { cardinality: r.cardinality, 'target.entity': r.targetEntity };
      if (r.sourceFields?.length) rel['source.fields'] = r.sourceFields;
      if (r.targetFields?.length) rel['target.fields'] = r.targetFields;
      if (r.linkingObject) {
        rel['linking.object'] = r.linkingObject;
        if (r.linkingSourceFields?.length) rel['linking.source.fields'] = r.linkingSourceFields;
        if (r.linkingTargetFields?.length) rel['linking.target.fields'] = r.linkingTargetFields;
      }
      rels[r.name] = rel;
    }
    out.relationships = rels;
  }

  // Cache.
  if (e.cache?.enabled) {
    out.cache = {
      enabled: true,
      ...(e.cache.ttlSeconds !== undefined ? { 'ttl-seconds': e.cache.ttlSeconds } : {}),
      ...(e.cache.level ? { level: e.cache.level } : {}),
    };
  }

  return out;
}

/** Emit the canonical dab-config.json object (secrets referenced via @env). */
export function emitDabConfig(cfg: DabConfig): Record<string, unknown> {
  const ds: Record<string, unknown> = {
    'database-type': cfg.sourceRef.kind,
    'connection-string': `@env('${DAB_CONNECTION_ENV}')`,
  };
  if (cfg.sourceRef.kind === 'cosmosdb_nosql') {
    const options: Record<string, unknown> = {};
    if (cfg.sourceRef.database) options.database = cfg.sourceRef.database;
    // DAB expects a graphql-schema FILE path; we stamp the conventional name.
    options['schema'] = 'schema.gql';
    ds.options = options;
  }

  const host: Record<string, unknown> = {
    mode: cfg.runtime.host.mode,
    cors: { origins: cfg.runtime.host.corsOrigins, 'allow-credentials': cfg.runtime.host.corsAllowCredentials },
    authentication: { provider: cfg.runtime.host.authProvider },
  };
  if (
    (cfg.runtime.host.authProvider === 'EntraId' || cfg.runtime.host.authProvider === 'Custom') &&
    (cfg.runtime.host.jwtAudience || cfg.runtime.host.jwtIssuer)
  ) {
    (host.authentication as Record<string, unknown>).jwt = {
      audience: cfg.runtime.host.jwtAudience || '',
      issuer: cfg.runtime.host.jwtIssuer || '',
    };
  }

  const entities: Record<string, unknown> = {};
  for (const e of cfg.entities) entities[e.name] = emitEntity(e);

  return {
    $schema: DAB_SCHEMA_URL,
    'data-source': ds,
    runtime: {
      rest: { enabled: cfg.runtime.rest.enabled, path: cfg.runtime.rest.path, 'request-body-strict': cfg.runtime.rest.requestBodyStrict },
      graphql: { enabled: cfg.runtime.graphql.enabled, path: cfg.runtime.graphql.path, 'allow-introspection': cfg.runtime.graphql.allowIntrospection },
      host,
      cache: { enabled: cfg.runtime.cache.enabled, 'ttl-seconds': cfg.runtime.cache.ttlSeconds },
      pagination: { 'default-page-size': cfg.runtime.pagination.defaultPageSize, 'max-page-size': cfg.runtime.pagination.maxPageSize },
    },
    entities,
  };
}

export function emitDabConfigJson(cfg: DabConfig): string {
  return JSON.stringify(emitDabConfig(cfg), null, 2);
}

// ---------------------------------------------------------------------------
// Validate (dab validate parity — schema + cross-reference checks).
// ---------------------------------------------------------------------------

export interface DabValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** Validate a DabConfig the way `dab validate` would — returns issues (errors block). */
export function validateDabConfig(cfg: DabConfig): DabValidationIssue[] {
  const issues: DabValidationIssue[] = [];

  // Data source.
  if (!cfg.sourceRef.kind) {
    issues.push({ severity: 'error', path: 'data-source.database-type', message: 'A database type is required.' });
  }
  if (!cfg.sourceRef.database) {
    issues.push({ severity: 'warning', path: 'data-source', message: 'No database selected — pick a source database before deploy.' });
  }
  if (cfg.sourceRef.kind === 'cosmosdb_nosql' && !cfg.sourceRef.graphqlSchema) {
    issues.push({
      severity: 'error',
      path: 'data-source.options.schema',
      message: 'Cosmos DB NoSQL is schema-less; a GraphQL schema (.gql) is required for every Cosmos entity.',
    });
  }
  // Synapse: dwsql supports the Dedicated SQL pool only. The Serverless SQL
  // pool is explicitly unsupported by DAB (per Learn), so block deploy honestly.
  if (cfg.sourceRef.kind === 'dwsql' && cfg.sourceRef.synapseRole === 'serverless') {
    issues.push({
      severity: 'error',
      path: 'data-source.database-type',
      message:
        'Data API builder does not support the Synapse Serverless SQL pool. Use the Synapse Dedicated SQL pool (dwsql), or mirror the serverless-queried data into an Azure SQL Database / Dedicated pool and point DAB there.',
    });
  }

  // Runtime.
  if (cfg.runtime.host.mode === 'production' && cfg.runtime.host.authProvider === 'Simulator') {
    issues.push({
      severity: 'error',
      path: 'runtime.host.authentication.provider',
      message: 'The Simulator auth provider only works when host.mode is development. DAB fails to start otherwise.',
    });
  }
  if (
    (cfg.runtime.host.authProvider === 'EntraId' || cfg.runtime.host.authProvider === 'Custom') &&
    (!cfg.runtime.host.jwtIssuer || !cfg.runtime.host.jwtAudience)
  ) {
    issues.push({
      severity: 'error',
      path: 'runtime.host.authentication.jwt',
      message: `Both jwt.audience and jwt.issuer are required when the provider is ${cfg.runtime.host.authProvider}.`,
    });
  }
  if (cfg.runtime.pagination.defaultPageSize > cfg.runtime.pagination.maxPageSize) {
    issues.push({ severity: 'error', path: 'runtime.pagination', message: 'default-page-size must not exceed max-page-size.' });
  }

  // Entities.
  if (cfg.entities.length === 0) {
    issues.push({ severity: 'warning', path: 'entities', message: 'No entities defined — add at least one table, view, or stored procedure.' });
  }
  const names = new Set<string>();
  for (const e of cfg.entities) {
    const p = `entities.${e.name || '(unnamed)'}`;
    if (!e.name) {
      issues.push({ severity: 'error', path: p, message: 'Entity name is required.' });
    } else {
      if (names.has(e.name)) issues.push({ severity: 'error', path: p, message: `Duplicate entity name "${e.name}".` });
      names.add(e.name);
      if (e.graphql.enabled && !GRAPHQL_NAME.test(e.name) && !e.graphql.singular) {
        issues.push({ severity: 'error', path: `${p}.graphql`, message: `Entity name "${e.name}" is not a valid GraphQL type name — set a GraphQL singular alias.` });
      }
    }
    if (!e.source.object) {
      issues.push({ severity: 'error', path: `${p}.source.object`, message: 'A database source object is required.' });
    }
    if (e.permissions.length === 0) {
      issues.push({ severity: 'error', path: `${p}.permissions`, message: 'At least one permission (role + actions) is required or the entity is inaccessible.' });
    }
    // Primary keys: tables/views need at least one PK for by-id REST + mutations.
    const hasPk = (e.fields || []).some((f) => f.primaryKey);
    if ((e.source.type === 'table' || e.source.type === 'view') && !hasPk) {
      issues.push({ severity: 'warning', path: `${p}.fields`, message: 'No primary-key field marked — by-id REST reads and GraphQL mutations require a key.' });
    }
    // SP entities expose execute only.
    if (e.source.type === 'stored-procedure') {
      for (const perm of e.permissions) {
        for (const a of perm.actions) {
          if (a.action !== 'execute' && a.action !== '*') {
            issues.push({ severity: 'error', path: `${p}.permissions`, message: `Stored-procedure entities support only the "execute" action (role "${perm.role}" has "${a.action}").` });
          }
        }
      }
    }
    // Policy actions: create/execute can't carry a database policy.
    for (const perm of e.permissions) {
      for (const a of perm.actions) {
        if (a.policyDatabase && (a.action === 'create' || a.action === 'execute')) {
          issues.push({ severity: 'error', path: `${p}.permissions`, message: `Database policies are not supported for the "${a.action}" action.` });
        }
      }
    }
    // Relationships must point at a real entity.
    for (const r of e.relationships || []) {
      if (!names.has(r.targetEntity) && !cfg.entities.some((x) => x.name === r.targetEntity)) {
        issues.push({ severity: 'error', path: `${p}.relationships.${r.name}`, message: `Relationship target entity "${r.targetEntity}" is not defined.` });
      }
      if (r.cardinality === 'many' && r.linkingObject && !(r.linkingSourceFields?.length && r.linkingTargetFields?.length)) {
        issues.push({ severity: 'warning', path: `${p}.relationships.${r.name}`, message: 'Many-to-many relationship has a linking object but no linking source/target fields.' });
      }
    }
  }

  return issues;
}
