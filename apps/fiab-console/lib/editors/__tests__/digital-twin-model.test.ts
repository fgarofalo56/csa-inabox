/**
 * Vitest — Digital Twin Builder pure model + KQL generation (FGC-12).
 *
 * Covers the model normalizers, validation, and the ADX KQL builders that the
 * BFF materialize / query / time-series routes emit — the exact strings that
 * run on Azure Data Explorer, verified without a browser or a live cluster.
 */
import { describe, it, expect } from 'vitest';
import {
  isTwinIdent, safeIdent, escKqlLiteral, bq, keyExpr, kustoType, castFn, twinKey, entityTable, relTable,
  normalizeTwinModel, normalizeTwinEntity, normalizeTwinRelationship, normalizeEntityMapping,
  emptyTwinModel, starterTwinModel, validateTwinModel,
  buildTwinMaterialize, buildTwinGraphPrelude, composeTwinGraphQuery, buildTwinRelationshipCount,
  buildTwinTimeSeriesQuery, SAMPLE_TWIN_MATCH,
  type TwinModel,
} from '../digital-twin-model';

describe('identifiers + kusto helpers', () => {
  it('validates identifiers', () => {
    expect(isTwinIdent('Asset')).toBe(true);
    expect(isTwinIdent('_x1')).toBe(true);
    expect(isTwinIdent('1bad')).toBe(false);
    expect(isTwinIdent('has space')).toBe(false);
    expect(isTwinIdent('')).toBe(false);
  });
  it('sanitizes to KQL-safe idents', () => {
    expect(safeIdent('asset-id.v2')).toBe('asset_id_v2');
  });
  it('maps loose type names to Kusto scalars', () => {
    expect(kustoType('integer')).toBe('int');
    expect(kustoType('double')).toBe('real');
    expect(kustoType('timestamp')).toBe('datetime');
    expect(kustoType('boolean')).toBe('bool');
    expect(kustoType(undefined)).toBe('string');
  });
  it('picks the matching cast function', () => {
    expect(castFn('real')).toBe('toreal');
    expect(castFn('datetime')).toBe('todatetime');
    expect(castFn('string')).toBe('tostring');
  });
  it('builds composite key expressions', () => {
    expect(keyExpr(['id'])).toBe("tostring(['id'])");
    expect(keyExpr(['a', 'b'])).toBe("strcat(tostring(['a']), '|', tostring(['b']))");
    expect(keyExpr([])).toBe("''");
  });
  it('namespaces materialized tables per item', () => {
    const k = twinKey('abc-123');
    expect(k).toBe('abc_123');
    expect(entityTable(k, 'Asset')).toBe('DT_abc_123_E_Asset');
    expect(relTable(k, 'monitors')).toBe('DT_abc_123_R_monitors');
  });
});

describe('normalizers', () => {
  it('drops invalid entities + relationships that dangle', () => {
    const model = normalizeTwinModel({
      entities: [
        { apiName: 'Asset', properties: [{ apiName: 'assetId', baseType: 'string' }], keyProperty: 'assetId' },
        { apiName: '1bad', properties: [] },
        'nope',
      ],
      relationships: [
        { apiName: 'monitors', fromEntity: 'Asset', toEntity: 'Ghost', cardinality: 'one-to-many' },
        { apiName: 'selfless', fromEntity: 'Asset', toEntity: 'Asset', cardinality: 'one-to-one' },
      ],
    });
    expect(model.entities.map((e) => e.apiName)).toEqual(['Asset']);
    // "monitors" dangles (Ghost missing) → dropped; "selfless" kept.
    expect(model.relationships.map((r) => r.apiName)).toEqual(['selfless']);
  });
  it('coerces key property only when it is a real property', () => {
    const e = normalizeTwinEntity({ apiName: 'X', properties: [{ apiName: 'p', baseType: 'long' }], keyProperty: 'missing' });
    expect(e?.keyProperty).toBeUndefined();
    const e2 = normalizeTwinEntity({ apiName: 'X', properties: [{ apiName: 'p', baseType: 'long' }], keyProperty: 'p' });
    expect(e2?.keyProperty).toBe('p');
  });
  it('normalizes a mapping with a filtered column map', () => {
    const m = normalizeEntityMapping({
      kind: 'lakehouse', sourceTable: 'Asset', keyColumns: ['AssetId'],
      columnMap: { name: 'Name', 'bad key': 'X', good: '' },
    });
    expect(m?.kind).toBe('lakehouse');
    expect(m?.keyColumns).toEqual(['AssetId']);
    expect(m?.columnMap).toEqual({ name: 'Name' });
  });
  it('round-trips the starter model through normalize', () => {
    const model = normalizeTwinModel(starterTwinModel() as unknown as Record<string, unknown>);
    expect(model.entities.map((e) => e.apiName)).toEqual(['Asset', 'Sensor']);
    expect(model.relationships.map((r) => r.apiName)).toEqual(['monitors']);
  });
  it('empty model is empty', () => {
    expect(emptyTwinModel()).toEqual({ entities: [], relationships: [] });
  });
});

describe('validation', () => {
  it('flags missing keys, dangling endpoints, and unbound keys', () => {
    const issues = validateTwinModel({
      entities: [
        { apiName: 'Asset', properties: [{ apiName: 'assetId', baseType: 'string' }] }, // no keyProperty
        {
          apiName: 'Sensor', keyProperty: 'sensorId',
          properties: [{ apiName: 'sensorId', baseType: 'string' }],
          mapping: { kind: 'adx', sourceTable: 'Sensors' }, // bound, no key columns
        },
      ],
      relationships: [
        { apiName: 'links', fromEntity: 'Asset', toEntity: 'Ghost', cardinality: 'one-to-many', properties: [] },
      ],
    });
    const msgs = issues.map((i) => i.message).join(' | ');
    expect(msgs).toMatch(/Asset" has no key property/);
    expect(msgs).toMatch(/Sensor" is bound to Sensors but has no key column/);
    expect(msgs).toMatch(/target "Ghost" is not a defined entity/);
  });
  it('a well-formed model has no errors', () => {
    const model: TwinModel = {
      entities: [
        { apiName: 'Asset', keyProperty: 'id', properties: [{ apiName: 'id', baseType: 'string' }] },
        { apiName: 'Sensor', keyProperty: 'id', properties: [{ apiName: 'id', baseType: 'string' }] },
      ],
      relationships: [{ apiName: 'monitors', fromEntity: 'Asset', toEntity: 'Sensor', cardinality: 'one-to-many', properties: [] }],
    };
    expect(validateTwinModel(model).filter((i) => i.level === 'error')).toHaveLength(0);
  });
});

describe('materialize KQL', () => {
  const model: TwinModel = {
    entities: [
      {
        apiName: 'Asset', keyProperty: 'assetId',
        properties: [
          { apiName: 'assetId', baseType: 'string' },
          { apiName: 'temp', baseType: 'real' },
        ],
        mapping: { kind: 'lakehouse', sourceDatabase: 'lake', sourceTable: 'Assets', keyColumns: ['AssetKey'], columnMap: { temp: 'Temperature' } },
      },
      { apiName: 'Sensor', keyProperty: 'sensorId', properties: [{ apiName: 'sensorId', baseType: 'string' }] },
    ],
    relationships: [
      {
        apiName: 'monitors', fromEntity: 'Asset', toEntity: 'Sensor', cardinality: 'one-to-many',
        properties: [{ apiName: 'since', baseType: 'datetime' }],
        mapping: { kind: 'adx', sourceTable: 'Edges', originKeyColumns: ['AssetKey'], targetKeyColumns: ['SensorKey'], columnMap: {} },
      },
    ],
  };

  it('creates namespaced typed tables', () => {
    const plan = buildTwinMaterialize(model, 'k1');
    expect(plan.nodeTables).toEqual(['DT_k1_E_Asset', 'DT_k1_E_Sensor']);
    expect(plan.edgeTables).toEqual(['DT_k1_R_monitors']);
    const assetCreate = plan.creates.find((c) => c.name === 'Asset' && c.op === 'create')!;
    expect(assetCreate.command).toBe('.create-merge table DT_k1_E_Asset (id:string, assetId:string, temp:real)');
    const relCreate = plan.creates.find((c) => c.name === 'monitors' && c.op === 'create')!;
    expect(relCreate.command).toBe('.create-merge table DT_k1_R_monitors (src:string, dst:string, rel:string, since:datetime)');
  });

  it('loads mapped entities with cast projections + column remap', () => {
    const plan = buildTwinMaterialize(model, 'k1');
    const load = plan.loads.find((l) => l.name === 'Asset')!;
    expect(load.command).toContain(".set-or-append DT_k1_E_Asset <| database('lake').['Assets']");
    expect(load.command).toContain("id = tostring(['AssetKey'])");
    expect(load.command).toContain("temp = toreal(['Temperature'])");
  });

  it('loads mapped relationships with src/dst/rel projections', () => {
    const plan = buildTwinMaterialize(model, 'k1');
    const load = plan.loads.find((l) => l.name === 'monitors')!;
    expect(load.command).toContain("src = tostring(['AssetKey'])");
    expect(load.command).toContain("dst = tostring(['SensorKey'])");
    expect(load.command).toContain("rel = 'monitors'");
  });

  it('does not emit a load for an unmapped entity', () => {
    const plan = buildTwinMaterialize(model, 'k1');
    expect(plan.loads.some((l) => l.name === 'Sensor')).toBe(false);
  });
});

describe('graph explorer KQL', () => {
  it('builds a make-graph prelude over the twin tables', () => {
    const prelude = buildTwinGraphPrelude(['DT_k_E_Asset', 'DT_k_E_Sensor'], ['DT_k_R_monitors']);
    expect(prelude).toContain('let TwinNodes = union (DT_k_E_Asset), (DT_k_E_Sensor);');
    expect(prelude).toContain('let TwinEdges = union (DT_k_R_monitors);');
    expect(prelude).toContain('make-graph src --> dst with TwinNodes on id;');
  });
  it('empty when no nodes or edges', () => {
    expect(buildTwinGraphPrelude([], ['e'])).toBe('');
    expect(buildTwinGraphPrelude(['n'], [])).toBe('');
  });
  it('composes prelude + pattern', () => {
    const q = composeTwinGraphQuery('let G = ...;', SAMPLE_TWIN_MATCH);
    expect(q.startsWith('let G = ...;')).toBe(true);
    expect(q).toContain('graph-match (a)-[e]->(b)');
  });
  it('builds a relationship count receipt', () => {
    const c = buildTwinRelationshipCount(['DT_k_E_Asset'], ['DT_k_R_monitors'])!;
    expect(c).toContain('make-graph src --> dst');
    expect(c).toContain('| count');
    expect(buildTwinRelationshipCount([], ['e'])).toBeNull();
  });
});

describe('time-series KQL', () => {
  it('builds a binned aggregate with lookback + escaped key filter', () => {
    const q = buildTwinTimeSeriesQuery({
      sourceDatabase: 'lake', sourceTable: 'Readings', timestampColumn: 'ts', valueColumn: 'reading',
      agg: 'avg', bin: '1h', lookback: '7d', keyColumn: 'sensorId', keyValue: "S-1'; drop",
    });
    expect(q).toContain("database('lake').['Readings']");
    expect(q).toContain("| where ['ts'] > ago(7d)");
    expect(q).toContain("| where ['sensorId'] == 'S-1\\'; drop'");
    expect(q).toContain("| summarize value = avg(toreal(['reading'])) by bin(['ts'], 1h)");
  });
  it('escapes backslashes before quotes so a value cannot break out of the literal', () => {
    // Backslash MUST be doubled first; otherwise `\` + our added `\'` would form
    // an escaped-quote-then-quote and let the value escape the KQL string.
    expect(escKqlLiteral("a\\b")).toBe("a\\\\b");
    expect(escKqlLiteral("a\\'; drop")).toBe("a\\\\\\'; drop");
    expect(bq("t\\'x")).toBe("['t\\\\\\'x']");
    const q = buildTwinTimeSeriesQuery({
      sourceTable: 'R', timestampColumn: 'ts', valueColumn: 'v', agg: 'avg', bin: '1h', lookback: '1d',
      keyColumn: 'k', keyValue: "x\\'; drop",
    });
    expect(q).toContain("| where ['k'] == 'x\\\\\\'; drop'");
  });
  it('count agg ignores the value column', () => {
    const q = buildTwinTimeSeriesQuery({ sourceTable: 'R', timestampColumn: 'ts', valueColumn: 'x', agg: 'count', bin: '5m', lookback: '1d' });
    expect(q).toContain("summarize value = count() by bin(['ts'], 5m)");
  });
  it('falls back to safe defaults for bad structural inputs', () => {
    const q = buildTwinTimeSeriesQuery({ sourceTable: 'R', timestampColumn: 'ts', valueColumn: 'x', agg: 'bogus' as any, bin: 'evil' as any, lookback: 'x' as any });
    expect(q).toContain('avg(');
    expect(q).toContain("bin(['ts'], 1h)");
    expect(q).toContain('ago(1d)');
  });
});
