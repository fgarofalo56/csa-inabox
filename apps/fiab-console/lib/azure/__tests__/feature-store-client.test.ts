import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveFeatureStoreBackend,
  validateFeatureTableSpec,
  buildFeatureTableDdl,
  buildPitJoinSql,
  buildOnlineTableDdl,
  buildLatestOfflineSql,
  buildOnlineLookupSql,
  mergeFeaturesIntoPayload,
  defaultOnlineTable,
  pgTypeFor,
  sparkTypeFor,
  featureStoreConfigGate,
  onlineStoreGate,
  FeatureStoreError,
  type FeatureTableSpec,
  type PitSpineSpec,
} from '../feature-store-client';

const SPEC: FeatureTableSpec = {
  fullName: 'main.default.customer_features',
  primaryKeys: ['customer_id'],
  timestampKey: 'event_ts',
  features: [
    { name: 'total_spend_30d', dataType: 'DOUBLE' },
    { name: 'orders_30d', dataType: 'BIGINT' },
  ],
};

const SPINE: PitSpineSpec = {
  fullName: 'main.default.training_labels',
  entityKeys: ['customer_id'],
  timestampKey: 'label_ts',
  carryColumns: ['label'],
  limit: 500,
};

const ENV_KEYS = [
  'LOOM_FEATURE_STORE_BACKEND', 'LOOM_DATABRICKS_HOSTNAME', 'LOOM_DATABRICKS_HOSTNAMES',
  'LOOM_UC_BACKEND', 'LOOM_UNITY_URL', 'LOOM_GCCH', 'LOOM_IL5',
  'LOOM_PGVECTOR_HOST', 'LOOM_POSTGRES_HOST', 'LOOM_POSTGRES_AAD_USER',
];
const saved: Record<string, string | undefined> = {};
function setEnv(patch: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('feature-store: backend resolution', () => {
  it('explicit LOOM_FEATURE_STORE_BACKEND wins', () => {
    setEnv({ LOOM_FEATURE_STORE_BACKEND: 'postgres', LOOM_DATABRICKS_HOSTNAME: 'x.azuredatabricks.net' });
    expect(resolveFeatureStoreBackend()).toBe('postgres');
    setEnv({ LOOM_FEATURE_STORE_BACKEND: 'databricks' });
    expect(resolveFeatureStoreBackend()).toBe('databricks');
  });
  it('defaults to databricks when a workspace is bound', () => {
    setEnv({ LOOM_DATABRICKS_HOSTNAME: 'x.azuredatabricks.net' });
    expect(resolveFeatureStoreBackend()).toBe('databricks');
  });
  it('defaults to postgres (sovereign) with no Databricks workspace', () => {
    setEnv({});
    expect(resolveFeatureStoreBackend()).toBe('postgres');
  });
});

describe('feature-store: spec validation', () => {
  it('accepts a well-formed spec', () => {
    expect(validateFeatureTableSpec(SPEC)).toBeNull();
  });
  it('requires keys, timestamp, and features', () => {
    expect(validateFeatureTableSpec({ ...SPEC, primaryKeys: [] })).toMatch(/entity/i);
    expect(validateFeatureTableSpec({ ...SPEC, timestampKey: '' })).toMatch(/timestamp/i);
    expect(validateFeatureTableSpec({ ...SPEC, features: [] })).toMatch(/feature/i);
  });
  it('rejects a feature that collides with a key/timestamp', () => {
    expect(validateFeatureTableSpec({ ...SPEC, features: [{ name: 'customer_id', dataType: 'STRING' }] })).toMatch(/more than once/i);
  });
  it('rejects SQL-injection-y identifiers', () => {
    expect(validateFeatureTableSpec({ ...SPEC, fullName: 'main.default.x; DROP TABLE y' })).toMatch(/invalid/i);
    expect(validateFeatureTableSpec({ ...SPEC, primaryKeys: ['id"; --'] })).toMatch(/invalid/i);
  });
});

describe('feature-store: type maps', () => {
  it('maps logical types to pg + spark types', () => {
    expect(pgTypeFor('DOUBLE')).toBe('double precision');
    expect(pgTypeFor('BIGINT')).toBe('bigint');
    expect(pgTypeFor('weird')).toBe('text');
    expect(sparkTypeFor('LONG')).toBe('BIGINT');
    expect(sparkTypeFor('weird')).toBe('STRING');
  });
});

describe('feature-store: DDL builders', () => {
  it('builds databricks Delta DDL with backticks + USING DELTA', () => {
    const sql = buildFeatureTableDdl(SPEC, 'databricks');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `main`.`default`.`customer_features`');
    expect(sql).toContain('`customer_id` STRING');
    expect(sql).toContain('`total_spend_30d` DOUBLE');
    expect(sql).toContain('USING DELTA');
  });
  it('builds postgres DDL with double-quotes + timestamptz', () => {
    const sql = buildFeatureTableDdl(SPEC, 'postgres');
    expect(sql).toContain('"customer_id" text');
    expect(sql).toContain('"event_ts" timestamptz');
    expect(sql).not.toContain('USING DELTA');
  });
  it('builds the online table with a composite PK + _feature_ts', () => {
    const sql = buildOnlineTableDdl(SPEC);
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${defaultOnlineTable(SPEC.fullName)}"`);
    expect(sql).toContain('"_feature_ts" timestamptz');
    expect(sql).toContain('PRIMARY KEY ("customer_id")');
  });
});

describe('feature-store: point-in-time join', () => {
  it('builds an AS-OF LATERAL join with the correct key + time predicates', () => {
    const sql = buildPitJoinSql(SPINE, SPEC, 'databricks');
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('f.`customer_id` = s.`customer_id`');
    expect(sql).toContain('f.`event_ts` <= s.`label_ts`');
    expect(sql).toContain('ORDER BY f.`event_ts` DESC');
    expect(sql).toContain('LIMIT 1');
    expect(sql).toContain('s.`label`'); // carry column
    expect(sql).toMatch(/LIMIT 500$/);
  });
  it('rejects a spine whose key count does not match the feature keys', () => {
    expect(() => buildPitJoinSql({ ...SPINE, entityKeys: ['a', 'b'] }, SPEC, 'postgres')).toThrow(FeatureStoreError);
  });
});

describe('feature-store: online read builders', () => {
  it('binds entity key values as parameters (never spliced)', () => {
    const { sql, params } = buildOnlineLookupSql(SPEC, { customer_id: "c1'; DROP" });
    expect(sql).toContain('WHERE "customer_id" = $1');
    expect(params).toEqual(["c1'; DROP"]);
  });
  it('throws on a missing entity key value', () => {
    expect(() => buildOnlineLookupSql(SPEC, {})).toThrow(FeatureStoreError);
  });
  it('collapses offline rows to the latest per entity', () => {
    const sql = buildLatestOfflineSql(SPEC, 'postgres');
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY "customer_id" ORDER BY "event_ts" DESC)');
    expect(sql).toContain('"event_ts" AS "_feature_ts"');
  });
});

describe('feature-store: merge features into scoring payload', () => {
  const feats = { total_spend_30d: 42.5, orders_30d: 3 };
  it('merges into dataframe_records', () => {
    const out: any = mergeFeaturesIntoPayload({ dataframe_records: [{ base: 1 }] }, feats);
    expect(out.dataframe_records[0]).toMatchObject({ base: 1, total_spend_30d: 42.5, orders_30d: 3 });
  });
  it('appends columns+values for the MLflow split shape', () => {
    const out: any = mergeFeaturesIntoPayload({ input_data: { columns: ['x'], data: [[1]] } }, feats);
    expect(out.input_data.columns).toEqual(['x', 'total_spend_30d', 'orders_30d']);
    expect(out.input_data.data[0]).toEqual([1, 42.5, 3]);
  });
  it('shallow-merges a bare object without overriding caller keys', () => {
    const out: any = mergeFeaturesIntoPayload({ orders_30d: 99 }, feats);
    expect(out.orders_30d).toBe(99); // caller value wins
    expect(out.total_spend_30d).toBe(42.5);
  });
  it('is a no-op for empty features', () => {
    const p = { a: 1 };
    expect(mergeFeaturesIntoPayload(p, {})).toBe(p);
  });
});

describe('feature-store: honest gates', () => {
  it('gates the databricks offline path when no workspace is bound', () => {
    setEnv({ LOOM_FEATURE_STORE_BACKEND: 'databricks' });
    const g = featureStoreConfigGate();
    expect(g?.gateId).toBe('svc-feature-store');
    expect(g?.fixEnvVar).toBe('LOOM_DATABRICKS_HOSTNAME');
  });
  it('gates the postgres path when no server is set', () => {
    setEnv({ LOOM_FEATURE_STORE_BACKEND: 'postgres' });
    expect(featureStoreConfigGate()?.fixEnvVar).toBe('LOOM_PGVECTOR_HOST');
  });
  it('online gate names pgvector host', () => {
    setEnv({});
    expect(onlineStoreGate()?.fixEnvVar).toBe('LOOM_PGVECTOR_HOST');
  });
  it('online gate clears when host + AAD user are set', () => {
    setEnv({ LOOM_PGVECTOR_HOST: 'srv.postgres.database.azure.com', LOOM_POSTGRES_AAD_USER: 'loom-uami' });
    expect(onlineStoreGate()).toBeNull();
  });
});
