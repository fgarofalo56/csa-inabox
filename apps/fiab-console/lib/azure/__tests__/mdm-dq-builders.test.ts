/**
 * mdm-dq-builders — unit tests for the network-free core of the MDM match-merge
 * engine + DQ Delta-constraint compiler. These exercise the generated SQL +
 * validation without any Azure call (the real executeStatement path runs against
 * a live Databricks SQL Warehouse in the deployed env — no mocks here).
 */
import { describe, it, expect } from 'vitest';
import {
  buildMatchSql, buildGoldenRecordSql, clusterCrosswalk, buildCrosswalkValues,
  type MdmModel, type CrosswalkPair,
} from '../mdm-match-merge';
import {
  compileDeltaConstraintDdl, granularityToEnum, buildGaMonitorBody, monitorApiMode,
} from '../dq-monitor-client';
import { normalizeModel, normalizeRefSet } from '../mdm-store';
import type { DqRule } from '../data-quality-client';

const model: MdmModel = {
  id: 'm1', name: 'Customer golden', entity: 'Customer',
  sourceTable: 'customers_raw', catalog: 'main', schema: 'mdm',
  recordIdColumn: 'record_id', sourceSystemColumn: 'source_system', timestampColumn: 'updated_at',
  matchAttributes: [
    { column: 'country', matchType: 'exact' },
    { column: 'email', matchType: 'fuzzy', threshold: 85 },
  ],
  survivorship: [
    { column: 'full_name', strategy: 'most-recent' },
    { column: 'credit_score', strategy: 'max' },
  ],
  sourcePriority: ['CRM', 'ERP'],
  goldenTable: 'customers_golden',
};

describe('buildMatchSql', () => {
  it('emits a scored self-join with backtick-quoted identifiers + blocking', () => {
    const sql = buildMatchSql(model, 80);
    expect(sql).toContain('FROM `main`.`mdm`.`customers_raw` a JOIN `main`.`mdm`.`customers_raw` b');
    expect(sql).toContain('levenshtein');     // fuzzy similarity
    expect(sql).toContain('soundex');          // fuzzy blocking
    expect(sql).toContain('>= 80');            // threshold
    expect(sql).toContain('LIMIT');
  });
  it('rejects unsafe identifiers', () => {
    const bad: MdmModel = { ...model, sourceTable: 'cust;DROP TABLE x' };
    expect(() => buildMatchSql(bad)).toThrow(/Unsafe SQL identifier/);
  });
});

describe('buildGoldenRecordSql', () => {
  it('creates the golden table with survivorship windows + source lineage', () => {
    const sql = buildGoldenRecordSql(model);
    expect(sql).toContain('CREATE OR REPLACE TABLE `main`.`mdm`.`customers_golden`');
    expect(sql).toContain('md5(');                       // deterministic cluster key
    expect(sql).toContain('FIRST_VALUE(s.`full_name`) IGNORE NULLS'); // most-recent
    expect(sql).toContain('MAX(s.`credit_score`)');      // max strategy
    expect(sql).toContain('source_systems');             // lineage
    expect(sql).toContain('source_record_count');
  });
  it('requires an exact match attribute for the cluster key', () => {
    const fuzzyOnly: MdmModel = { ...model, matchAttributes: [{ column: 'email', matchType: 'fuzzy' }] };
    expect(() => buildGoldenRecordSql(fuzzyOnly)).toThrow(/exact match attribute/);
  });
});

describe('compileDeltaConstraintDdl', () => {
  const base = { id: 'r1', name: 'r', threshold: 90, enabled: true };
  it('not-null → ALTER COLUMN SET NOT NULL', () => {
    const r: DqRule = { ...base, scope: 'column:customers.email', check: 'not-null' };
    const out = compileDeltaConstraintDdl(r, 'main', 'sales');
    expect('ddl' in out && out.ddl).toContain('ALTER COLUMN `email` SET NOT NULL');
  });
  it('range → CHECK BETWEEN', () => {
    const r: DqRule = { ...base, scope: 'column:customers.age', check: 'range', min: 0, max: 120 };
    const out = compileDeltaConstraintDdl(r, 'main', 'sales');
    expect('ddl' in out && out.ddl).toContain('CHECK (`age` BETWEEN 0 AND 120)');
  });
  it('regex → CHECK RLIKE with escaped literal', () => {
    const r: DqRule = { ...base, scope: 'column:customers.code', check: 'regex', pattern: "^[A-Z]'s$" };
    const out = compileDeltaConstraintDdl(r, 'main', 'sales');
    expect('ddl' in out && out.ddl).toContain('RLIKE');
    expect('ddl' in out && out.ddl).toContain("\\'");   // escaped single quote
  });
  it('unique / freshness are unsupported as enforced constraints', () => {
    const u: DqRule = { ...base, scope: 'column:t.c', check: 'unique' };
    const f: DqRule = { ...base, scope: 'column:t.c', check: 'freshness' };
    expect('unsupported' in compileDeltaConstraintDdl(u)).toBe(true);
    expect('unsupported' in compileDeltaConstraintDdl(f)).toBe(true);
  });
});

describe('normalizeModel', () => {
  it('rejects a model with no exact match attribute', () => {
    const { errors } = normalizeModel({ ...model, matchAttributes: [{ column: 'email', matchType: 'fuzzy' }] });
    expect(errors.join(' ')).toMatch(/EXACT match attribute/);
  });
  it('accepts + normalizes a valid model', () => {
    const { model: m, errors } = normalizeModel(model);
    expect(errors).toHaveLength(0);
    expect(m?.matchAttributes).toHaveLength(2);
  });
  it('coerces unknown survivorship strategy to most-complete', () => {
    const { model: m } = normalizeModel({ ...model, survivorship: [{ column: 'x', strategy: 'bogus' }] });
    expect(m?.survivorship[0].strategy).toBe('most-complete');
  });
});

describe('normalizeRefSet', () => {
  it('bumps the version and keeps coded entries', () => {
    const { set, errors } = normalizeRefSet({ name: 'Country', domain: 'Geo', entries: [{ code: 'US', label: 'United States' }, { code: '' }] }, 2);
    expect(errors).toHaveLength(0);
    expect(set?.version).toBe(3);
    expect(set?.entries).toHaveLength(1);
  });
});

describe('GA data-quality monitor builders', () => {
  it('defaults to the GA data-quality API mode', () => {
    delete process.env.LOOM_DBX_DQ_MONITOR_API;
    expect(monitorApiMode()).toBe('data-quality');
    process.env.LOOM_DBX_DQ_MONITOR_API = 'legacy';
    expect(monitorApiMode()).toBe('legacy');
    delete process.env.LOOM_DBX_DQ_MONITOR_API;
  });
  it('maps human granularities onto AGGREGATION_GRANULARITY_* enums', () => {
    expect(granularityToEnum('1 day')).toBe('AGGREGATION_GRANULARITY_1_DAY');
    expect(granularityToEnum('30 minutes')).toBe('AGGREGATION_GRANULARITY_30_MINUTES');
    expect(granularityToEnum('AGGREGATION_GRANULARITY_1_HOUR')).toBe('AGGREGATION_GRANULARITY_1_HOUR'); // passthrough
    expect(granularityToEnum('garbage')).toBe('AGGREGATION_GRANULARITY_1_DAY'); // safe default
  });
  it('builds a snapshot create_monitor body keyed by table UUID', () => {
    const body = buildGaMonitorBody({ objectId: 'tbl-uuid', outputSchemaId: 'sch-uuid', assetsDir: '/Workspace/x', profileType: 'snapshot' });
    expect(body.object_type).toBe('table');
    expect(body.object_id).toBe('tbl-uuid');
    const cfg = body.data_profiling_config as any;
    expect(cfg.output_schema_id).toBe('sch-uuid');
    expect(cfg.snapshot).toEqual({});
    expect(cfg.time_series).toBeUndefined();
  });
  it('builds a time_series body with enum granularities', () => {
    const body = buildGaMonitorBody({ objectId: 't', outputSchemaId: 's', assetsDir: '/a', profileType: 'time_series', timestampCol: 'ts', granularities: ['1 day'] });
    const cfg = body.data_profiling_config as any;
    expect(cfg.time_series.timestamp_column).toBe('ts');
    expect(cfg.time_series.granularities).toEqual(['AGGREGATION_GRANULARITY_1_DAY']);
  });
});

describe('MDM steward crosswalk', () => {
  it('union-finds approved pairs into a stable cluster (smallest id wins)', () => {
    const pairs: CrosswalkPair[] = [{ idA: 'b', idB: 'c' }, { idA: 'a', idB: 'b' }];
    const clusters = clusterCrosswalk(pairs);
    expect(clusters.get('a')).toBe('a');
    expect(clusters.get('b')).toBe('a');
    expect(clusters.get('c')).toBe('a');
  });
  it('emits a VALUES crosswalk relation, or null when empty', () => {
    expect(buildCrosswalkValues([])).toBeNull();
    const v = buildCrosswalkValues([{ idA: 'r1', idB: 'r2' }]);
    expect(v).toContain('VALUES');
    expect(v).toContain('_cw(_cw_record_id, _cw_gid)');
    expect(v).toContain("'cw:r1'"); // representative cluster id, prefixed
  });
  it('unions approved pairs into the golden merge via a LEFT JOIN override', () => {
    const sql = buildGoldenRecordSql(model, [{ idA: 'r1', idB: 'r2' }]);
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('COALESCE(_cw._cw_gid, md5(');
  });
  it('falls back to the deterministic md5 cluster with no approved pairs', () => {
    const sql = buildGoldenRecordSql(model, []);
    expect(sql).not.toContain('LEFT JOIN');
    expect(sql).toContain('md5(');
  });
});
