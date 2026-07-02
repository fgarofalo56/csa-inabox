/**
 * Vitest — Power Platform / ML / Geo / Graph editor family.
 *
 * Exercises every exported helper in lib/editors/_family-utils.ts. Catches
 * the class of bug a UI smoke can't (regex break, off-by-one zoom, geo
 * walker missing nested polygons, etc.) without spinning up a browser.
 *
 * Coverage targets (sweep deliverable):
 *   - splitAdlsPath          [GeoDatasetEditor]
 *   - joinAdlsPath           [GeoDatasetEditor]
 *   - validateVarValue       [VariableLibraryEditor]
 *   - parseOntologyHierarchy [OntologyEditor]
 *   - aiStateLabel           [AiBuilderModelEditor]
 *   - aiStatusLabel          [AiBuilderModelEditor]
 *   - computeGeoBbox         [MapEditor]
 *   - bboxToZoom             [MapEditor]
 */
import { describe, it, expect } from 'vitest';
import {
  splitAdlsPath, joinAdlsPath,
  validateVarValue,
  parseOntologyHierarchy,
  matchClassesToTables,
  buildEntityChangeQuery,
  aiStateLabel, aiStatusLabel,
  computeGeoBbox, bboxToZoom, bboxLabel,
  parseWktGeometry, geoFeaturesFromInspectRows,
  parseUdfFunctions,
  normalizeDaSources, guessDaSourceType, daSupportsExampleQueries,
  shapeDaHistory, canSendDaQuestion,
  safeSqlIdent, buildInsertSql, buildUpdateSql, buildDeleteSql, buildAtelierWhere,
} from '../_family-utils';

// ============================================================
// Atelier (Workshop app) real-CRUD SQL builders
// ============================================================
describe('safeSqlIdent', () => {
  it('accepts a normal identifier', () => { expect(safeSqlIdent('Order')).toBe('Order'); expect(safeSqlIdent('_x1')).toBe('_x1'); });
  it('rejects injection / illegal chars', () => {
    expect(safeSqlIdent('Status; DROP TABLE x')).toBeNull();
    expect(safeSqlIdent('1col')).toBeNull();
    expect(safeSqlIdent('a b')).toBeNull();
    expect(safeSqlIdent('')).toBeNull();
    expect(safeSqlIdent('a'.repeat(129))).toBeNull();
  });
});

describe('buildInsertSql', () => {
  it('builds a parameterised INSERT binding values, not concatenating', () => {
    const r = buildInsertSql('Order', [{ column: 'Status', value: 'open' }, { column: 'Amount', value: '99' }]);
    expect(r.sql).toBe('INSERT INTO [Order] ([Status], [Amount]) VALUES (@p0, @p1)');
    expect(r.params).toEqual([{ name: 'p0', value: 'open' }, { name: 'p1', value: '99' }]);
  });
  it('throws when no columns', () => { expect(() => buildInsertSql('Order', [])).toThrow(); });
});

describe('buildUpdateSql', () => {
  it('builds a parameterised UPDATE keyed on @k', () => {
    const r = buildUpdateSql('Order', [{ column: 'Status', value: 'closed' }], 'Id', '7');
    expect(r.sql).toBe('UPDATE [Order] SET [Status] = @p0 WHERE [Id] = @k');
    expect(r.params).toEqual([{ name: 'p0', value: 'closed' }, { name: 'k', value: '7' }]);
  });
  it('throws when no SET columns', () => { expect(() => buildUpdateSql('Order', [], 'Id', '7')).toThrow(); });
});

describe('buildDeleteSql', () => {
  it('always emits a WHERE clause keyed on @k', () => {
    const r = buildDeleteSql('Order', 'Id', '7');
    expect(r.sql).toBe('DELETE FROM [Order] WHERE [Id] = @k');
    expect(r.params).toEqual([{ name: 'k', value: '7' }]);
  });
});

// ============================================================
// buildAtelierWhere — Workshop object-set-filter → parameterised WHERE
// (powers the filter-drives-a-table binding + chart/metric aggregates)
// ============================================================
describe('buildAtelierWhere', () => {
  it('returns an empty clause for no / undefined filters', () => {
    expect(buildAtelierWhere(undefined)).toEqual({ clause: '', params: [] });
    expect(buildAtelierWhere([])).toEqual({ clause: '', params: [] });
  });
  it('builds a parameterised equality predicate (value bound, never concatenated)', () => {
    const r = buildAtelierWhere([{ column: 'Status', op: 'eq', value: 'open' }]);
    expect(r.clause).toBe(' WHERE [Status] = @f0');
    expect(r.params).toEqual([{ name: 'f0', value: 'open' }]);
  });
  it('maps every operator and ANDs multiple predicates with distinct param names', () => {
    const r = buildAtelierWhere([
      { column: 'Amount', op: 'gte', value: '100' },
      { column: 'Region', op: 'ne', value: 'EU' },
    ]);
    expect(r.clause).toBe(' WHERE [Amount] >= @f0 AND [Region] <> @f1');
    expect(r.params).toEqual([{ name: 'f0', value: '100' }, { name: 'f1', value: 'EU' }]);
  });
  it('wraps contains / startsWith in LIKE with bound wildcards', () => {
    expect(buildAtelierWhere([{ column: 'Name', op: 'contains', value: 'ab' }]))
      .toEqual({ clause: ' WHERE [Name] LIKE @f0', params: [{ name: 'f0', value: '%ab%' }] });
    expect(buildAtelierWhere([{ column: 'Name', op: 'startsWith', value: 'ab' }]))
      .toEqual({ clause: ' WHERE [Name] LIKE @f0', params: [{ name: 'f0', value: 'ab%' }] });
  });
  it('skips predicates with an unsafe column identifier (injection-safe) or empty value', () => {
    const r = buildAtelierWhere([
      { column: 'Status; DROP TABLE x', op: 'eq', value: 'open' }, // unsafe ident → skipped
      { column: 'Region', op: 'eq', value: '' },                    // empty value → skipped
      { column: 'Tier', op: 'eq', value: 'gold' },                  // kept
    ]);
    expect(r.clause).toBe(' WHERE [Tier] = @f0');
    expect(r.params).toEqual([{ name: 'f0', value: 'gold' }]);
  });
  it('honours startIndex so callers can compose clauses without param collisions', () => {
    const r = buildAtelierWhere([{ column: 'A', op: 'eq', value: '1' }], 3);
    expect(r.clause).toBe(' WHERE [A] = @f3');
    expect(r.params).toEqual([{ name: 'f3', value: '1' }]);
  });
});

// ============================================================
// parseUdfFunctions (UserDataFunctionEditor explorer + Test panel)
// ============================================================
describe('parseUdfFunctions', () => {
  it('parses a decorated function with typed params + defaults', () => {
    const src = `import fabric.functions as fn\nudf = fn.UserDataFunctions()\n\n@udf.function()\ndef compute_score(user_id: str, weight: float = 1.0) -> dict:\n    return {}`;
    expect(parseUdfFunctions(src)).toEqual([
      { name: 'compute_score', returns: 'dict', params: [
        { name: 'user_id', type: 'str', default: undefined },
        { name: 'weight', type: 'float', default: '1.0' },
      ] },
    ]);
  });

  it('excludes undecorated helper functions', () => {
    const src = `@udf.function()\ndef public_fn(x: int) -> int:\n    return helper(x)\n\ndef helper(x: int) -> int:\n    return x * 2`;
    const fns = parseUdfFunctions(src);
    expect(fns.map((f) => f.name)).toEqual(['public_fn']);
  });

  it('handles a no-arg function', () => {
    const src = `@udf.function()\ndef ping() -> str:\n    return "ok"`;
    expect(parseUdfFunctions(src)).toEqual([{ name: 'ping', returns: 'str', params: [] }]);
  });

  it('returns [] for source with no decorated functions', () => {
    expect(parseUdfFunctions('def x(): pass')).toEqual([]);
  });
});

// ============================================================
// splitAdlsPath / joinAdlsPath
// ============================================================

describe('splitAdlsPath', () => {
  it('parses a full abfss path', () => {
    expect(splitAdlsPath('abfss://gold@adls.dfs.core.windows.net/geo/events/'))
      .toEqual({ container: 'gold', suffix: 'geo/events/' });
  });
  it('parses a container-only path', () => {
    expect(splitAdlsPath('abfss://silver@adls.dfs.core.windows.net/'))
      .toEqual({ container: 'silver', suffix: '' });
  });
  it('parses a container-only path with no trailing slash', () => {
    expect(splitAdlsPath('abfss://bronze@adls.dfs.core.windows.net'))
      .toEqual({ container: 'bronze', suffix: '' });
  });
  it('returns the raw input as suffix when malformed', () => {
    expect(splitAdlsPath('not-a-real-path'))
      .toEqual({ container: '', suffix: 'not-a-real-path' });
  });
  it('returns an empty parse for an empty string', () => {
    expect(splitAdlsPath(''))
      .toEqual({ container: '', suffix: '' });
  });
});

describe('joinAdlsPath', () => {
  it('produces a full abfss path when account URL is provided', () => {
    const accountUrl = 'https://csaloomstor.dfs.core.windows.net/';
    expect(joinAdlsPath('gold', 'geo/events/', accountUrl))
      .toBe('abfss://gold@csaloomstor.dfs.core.windows.net/geo/events/');
  });
  it('strips a leading slash in the suffix to avoid double slashes', () => {
    expect(joinAdlsPath('gold', '/geo/events/', 'https://csaloomstor.dfs.core.windows.net/'))
      .toBe('abfss://gold@csaloomstor.dfs.core.windows.net/geo/events/');
  });
  it('emits a placeholder host when no account URL is provided', () => {
    expect(joinAdlsPath('gold', 'geo/'))
      .toBe('abfss://gold@<account>.dfs.core.windows.net/geo/');
  });
  it('returns the suffix unchanged when no container is selected', () => {
    expect(joinAdlsPath('', 'free/form/path')).toBe('free/form/path');
  });
  it('round-trips a parsed path back to its original shape', () => {
    const original = 'abfss://gold@csaloomstor.dfs.core.windows.net/geo/events/';
    const split = splitAdlsPath(original);
    const accountUrl = 'https://csaloomstor.dfs.core.windows.net/';
    expect(joinAdlsPath(split.container, split.suffix, accountUrl)).toBe(original);
  });
});

// ============================================================
// validateVarValue
// ============================================================

describe('validateVarValue', () => {
  it('passes empty values regardless of type', () => {
    expect(validateVarValue('integer', '')).toBeNull();
    expect(validateVarValue('guid', '')).toBeNull();
  });
  it('validates integers', () => {
    expect(validateVarValue('integer', '42')).toBeNull();
    expect(validateVarValue('integer', '-7')).toBeNull();
    expect(validateVarValue('integer', '3.14')).toMatch(/integer/);
    expect(validateVarValue('integer', 'abc')).toMatch(/integer/);
  });
  it('validates numbers (int OR float)', () => {
    expect(validateVarValue('number', '3.14')).toBeNull();
    expect(validateVarValue('number', '42')).toBeNull();
    expect(validateVarValue('number', '-1.5')).toBeNull();
    expect(validateVarValue('number', 'NaN')).toMatch(/number/);
  });
  it('validates booleans', () => {
    expect(validateVarValue('bool', 'true')).toBeNull();
    expect(validateVarValue('bool', 'False')).toBeNull();
    expect(validateVarValue('bool', '1')).toMatch(/true or false/);
  });
  it('validates ISO 8601 datetimes', () => {
    expect(validateVarValue('datetime', '2026-05-27')).toBeNull();
    expect(validateVarValue('datetime', '2026-05-27T14:30:00Z')).toBeNull();
    expect(validateVarValue('datetime', '2026-05-27T14:30:00+05:30')).toBeNull();
    expect(validateVarValue('datetime', 'yesterday')).toMatch(/ISO 8601/);
  });
  it('validates GUIDs', () => {
    expect(validateVarValue('guid', '12345678-1234-1234-1234-123456789012')).toBeNull();
    expect(validateVarValue('guid', 'abc')).toMatch(/GUID/);
  });
  it('passes string / item-ref / connection-ref / secret-ref through', () => {
    expect(validateVarValue('string', 'anything')).toBeNull();
    expect(validateVarValue('item-ref', 'wrk-123')).toBeNull();
    expect(validateVarValue('connection-ref', 'conn-abc')).toBeNull();
    expect(validateVarValue('secret-ref', 'kv:my-secret')).toBeNull();
  });
});

// ============================================================
// parseOntologyHierarchy
// ============================================================

describe('parseOntologyHierarchy', () => {
  it('parses a simple two-level hierarchy', () => {
    const src = `Thing : -- root\nParty : Thing -- person or org`;
    expect(parseOntologyHierarchy(src)).toEqual([
      { name: 'Thing', parent: undefined, description: 'root' },
      { name: 'Party', parent: 'Thing', description: 'person or org' },
    ]);
  });
  it('ignores blank lines and full-line comments', () => {
    const src = `# this is a comment\n\nThing :\n   # indented comment\nParty : Thing -- p`;
    expect(parseOntologyHierarchy(src)).toEqual([
      { name: 'Thing', parent: undefined, description: undefined },
      { name: 'Party', parent: 'Thing', description: 'p' },
    ]);
  });
  it('strips trailing inline comments', () => {
    const src = `Thing :   # root entity`;
    expect(parseOntologyHierarchy(src)).toEqual([
      { name: 'Thing', parent: undefined, description: undefined },
    ]);
  });
  it('drops malformed lines silently', () => {
    const src = `Thing :\n123-not-an-identifier\nParty : Thing`;
    expect(parseOntologyHierarchy(src)).toEqual([
      { name: 'Thing', parent: undefined, description: undefined },
      { name: 'Party', parent: 'Thing', description: undefined },
    ]);
  });
  it('handles the editor sample without throwing', () => {
    const src = `Thing :  -- root\nParty : Thing -- person or org\nCustomer : Party -- buying party\nVendor : Party -- selling party\nOrder : Thing -- transaction record`;
    const parsed = parseOntologyHierarchy(src);
    expect(parsed).toHaveLength(5);
    expect(parsed.find(c => c.name === 'Customer')?.parent).toBe('Party');
  });
});

// ============================================================
// matchClassesToTables / buildEntityChangeQuery  [OntologyEditor binding]
// ============================================================

describe('matchClassesToTables', () => {
  const classes = [
    { name: 'Customer' }, { name: 'Order' }, { name: 'Vendor' },
  ];
  it('returns only the classes whose name matches a table (case-insensitive)', () => {
    const out = matchClassesToTables(classes, ['dbo.customer', 'ORDER']);
    expect(out.map((c) => c.name).sort()).toEqual(['Customer', 'Order']);
  });
  it('strips a schema prefix before matching', () => {
    const out = matchClassesToTables(classes, ['sales.Vendor']);
    expect(out.map((c) => c.name)).toEqual(['Vendor']);
  });
  it('returns [] when nothing matches', () => {
    expect(matchClassesToTables(classes, ['unrelated', 'misc.table'])).toEqual([]);
  });
  it('tolerates non-array / empty inputs', () => {
    expect(matchClassesToTables(classes, [])).toEqual([]);
    expect(matchClassesToTables([], ['Customer'])).toEqual([]);
    expect(matchClassesToTables(classes, undefined as unknown as string[])).toEqual([]);
  });
});

describe('buildEntityChangeQuery', () => {
  it('produces column-safe KQL with the entityType filter + the operation filter', () => {
    const q = buildEntityChangeQuery('Customer', 'lakehouse', 'item-123', 'MyEvents_CL');
    expect(q).toContain('MyEvents_CL');
    // column-safe predicate: literal column resolved via column_ifexists, then filtered.
    expect(q).toContain('column_ifexists("entityType"');
    expect(q).toContain('where _entityType == "Customer"');
    expect(q).toContain('_operation in ("INSERT","UPDATE","DELETE")');
    expect(q).toContain('// Loom ontology entity-change trigger — lakehouse item-123');
  });
  it('defaults the table to the real AppEvents table (not the phantom AppEvents_CL) when none is provided', () => {
    const prev = process.env.LOOM_ACTIVATOR_DEFAULT_TABLE;
    delete process.env.LOOM_ACTIVATOR_DEFAULT_TABLE;
    const q = buildEntityChangeQuery('Order', 'warehouse', 'w1');
    expect(q).toContain('AppEvents');
    expect(q).not.toContain('AppEvents_CL');
    if (prev !== undefined) process.env.LOOM_ACTIVATOR_DEFAULT_TABLE = prev;
  });
  it('escapes embedded quotes in the entity type and does not throw on odd input', () => {
    const q = buildEntityChangeQuery('Wei"rd', 'lakehouse', 'x\n y', 'T');
    expect(q).toContain('Wei\\"rd');
    expect(() => buildEntityChangeQuery('', 'lakehouse', '')).not.toThrow();
  });
});

// ============================================================
// aiStateLabel / aiStatusLabel
// ============================================================

describe('aiStateLabel', () => {
  it('maps 0 -> Active', () => { expect(aiStateLabel(0)).toBe('Active'); });
  it('maps 1 -> Inactive', () => { expect(aiStateLabel(1)).toBe('Inactive'); });
  it('falls back to em-dash for unknown / undefined', () => {
    expect(aiStateLabel(undefined)).toBe('—');
    expect(aiStateLabel(99)).toBe('—');
  });
});

describe('aiStatusLabel', () => {
  it('maps the known statuscode values', () => {
    expect(aiStatusLabel(1)).toBe('Draft');
    expect(aiStatusLabel(2)).toBe('Trained');
    expect(aiStatusLabel(3)).toBe('Published');
    expect(aiStatusLabel(4)).toBe('Training');
    expect(aiStatusLabel(5)).toBe('Training failed');
    expect(aiStatusLabel(6)).toBe('Publishing');
  });
  it('stringifies unknown numeric values', () => {
    expect(aiStatusLabel(42)).toBe('42');
  });
  it('returns em-dash for undefined', () => {
    expect(aiStatusLabel(undefined)).toBe('—');
  });
});

// ============================================================
// computeGeoBbox / bboxToZoom
// ============================================================

describe('computeGeoBbox', () => {
  it('returns null for an empty FeatureCollection', () => {
    expect(computeGeoBbox({ type: 'FeatureCollection', features: [] })).toBeNull();
  });
  it('returns null when no `features` array is present', () => {
    expect(computeGeoBbox({})).toBeNull();
    expect(computeGeoBbox(null)).toBeNull();
  });
  it('handles a single point', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-122.33, 47.61] } },
      ],
    };
    expect(computeGeoBbox(fc)).toEqual({ minLon: -122.33, maxLon: -122.33, minLat: 47.61, maxLat: 47.61 });
  });
  it('walks nested polygon coordinates', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature', properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [-122.5, 47.5], [-122.0, 47.5], [-122.0, 47.8], [-122.5, 47.8], [-122.5, 47.5],
            ]],
          },
        },
      ],
    };
    expect(computeGeoBbox(fc)).toEqual({ minLon: -122.5, maxLon: -122.0, minLat: 47.5, maxLat: 47.8 });
  });
  it('combines multiple features into a single bbox', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-122.33, 47.61] } },
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-77.04, 38.91] } },
      ],
    };
    expect(computeGeoBbox(fc)).toEqual({ minLon: -122.33, maxLon: -77.04, minLat: 38.91, maxLat: 47.61 });
  });
});

describe('bboxToZoom', () => {
  it('returns the default zoom (8) when bbox is null', () => {
    expect(bboxToZoom(null)).toBe(8);
  });
  it('clamps very small spans to a high zoom', () => {
    const tight: NonNullable<ReturnType<typeof computeGeoBbox>> = {
      minLon: -122.331, maxLon: -122.329, minLat: 47.609, maxLat: 47.611,
    };
    const z = bboxToZoom(tight);
    expect(z).toBeGreaterThanOrEqual(15);
    expect(z).toBeLessThanOrEqual(18);
  });
  it('clamps very wide spans to a low zoom', () => {
    const wide: NonNullable<ReturnType<typeof computeGeoBbox>> = {
      minLon: -180, maxLon: 180, minLat: -85, maxLat: 85,
    };
    const z = bboxToZoom(wide);
    expect(z).toBeGreaterThanOrEqual(1);
    expect(z).toBeLessThanOrEqual(3);
  });
  it('never exceeds 18 or falls below 1', () => {
    expect(bboxToZoom({ minLon: 0, maxLon: 1e-12, minLat: 0, maxLat: 1e-12 })).toBeLessThanOrEqual(18);
    expect(bboxToZoom({ minLon: -180, maxLon: 180, minLat: -90, maxLat: 90 })).toBeGreaterThanOrEqual(1);
  });
});

describe('bboxLabel', () => {
  it('returns null for a null bbox', () => {
    expect(bboxLabel(null)).toBeNull();
  });
  it('formats a bbox to 4 decimals with an arrow', () => {
    expect(bboxLabel({ minLon: -77.0369, maxLon: -77.0, minLat: 38.9072, maxLat: 38.95 }))
      .toBe('[-77.0369, 38.9072] → [-77.0000, 38.9500]');
  });
});

// ============================================================
// parseWktGeometry / geoFeaturesFromInspectRows
// [GeoDatasetEditor geometry inspector → map render]
// ============================================================

describe('parseWktGeometry', () => {
  it('parses a POINT', () => {
    expect(parseWktGeometry('POINT (-77.0369 38.9072)'))
      .toEqual({ type: 'Point', coordinates: [-77.0369, 38.9072] });
  });
  it('parses a POINT with Z ordinate (dropping Z)', () => {
    expect(parseWktGeometry('POINT Z (1 2 3)'))
      .toEqual({ type: 'Point', coordinates: [1, 2] });
  });
  it('parses a LINESTRING', () => {
    expect(parseWktGeometry('LINESTRING (0 0, 1 1, 2 2)'))
      .toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] });
  });
  it('parses a POLYGON with one ring', () => {
    expect(parseWktGeometry('POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))'))
      .toEqual({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] });
  });
  it('parses a POLYGON with a hole (two rings)', () => {
    const g = parseWktGeometry('POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 2 2, 1 2, 1 1))');
    expect(g?.type).toBe('Polygon');
    expect((g?.coordinates as number[][][]).length).toBe(2);
  });
  it('parses a MULTIPOINT in both bracketed and bare forms', () => {
    expect(parseWktGeometry('MULTIPOINT ((1 2), (3 4))'))
      .toEqual({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] });
    expect(parseWktGeometry('MULTIPOINT (1 2, 3 4)'))
      .toEqual({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] });
  });
  it('parses a MULTIPOLYGON', () => {
    const g = parseWktGeometry('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((2 2, 3 2, 3 3, 2 2)))');
    expect(g?.type).toBe('MultiPolygon');
    expect((g?.coordinates as number[][][][]).length).toBe(2);
  });
  it('returns null for WKB hex and non-WKT junk', () => {
    expect(parseWktGeometry('0x01010000001234ABCD')).toBeNull();
    expect(parseWktGeometry('not geometry')).toBeNull();
    expect(parseWktGeometry('' as any)).toBeNull();
    expect(parseWktGeometry(null as any)).toBeNull();
  });
});

describe('geoFeaturesFromInspectRows', () => {
  it('builds Point features from a WKT geometry column', () => {
    const fc = geoFeaturesFromInspectRows(
      ['id', 'geom'],
      [[1, 'POINT (-77 38)'], [2, 'POINT (-76 39)']],
      'geom',
    );
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [-77, 38] });
    expect(fc.features[0].properties).toEqual({ id: 1 });
  });
  it('uses a GeoJSON literal cell directly (object or string)', () => {
    const fc = geoFeaturesFromInspectRows(
      ['geometry'],
      [
        [{ type: 'Point', coordinates: [1, 2] }],
        ['{"type":"LineString","coordinates":[[0,0],[1,1]]}'],
      ],
      'geometry',
    );
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry.type).toBe('Point');
    expect(fc.features[1].geometry.type).toBe('LineString');
  });
  it('falls back to lon/lat columns when no geometry column is present', () => {
    const fc = geoFeaturesFromInspectRows(
      ['name', 'longitude', 'latitude'],
      [['a', -77.04, 38.91]],
      'geometry',
    );
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [-77.04, 38.91] });
    expect(fc.features[0].properties).toEqual({ name: 'a' });
  });
  it('skips WKB hex blobs (can\'t decode client-side) and keeps a valid FeatureCollection', () => {
    const fc = geoFeaturesFromInspectRows(
      ['id', 'geom'],
      [[1, '0x0101000000ABCD1234'], [2, 'POINT (1 1)']],
      'geom',
    );
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [1, 1] });
  });
  it('tolerates empty / malformed input', () => {
    expect(geoFeaturesFromInspectRows([], [], 'g')).toEqual({ type: 'FeatureCollection', features: [] });
    expect(geoFeaturesFromInspectRows(['g'], null as any, 'g').features).toEqual([]);
  });
  it('bounds output to the max row count', () => {
    const rows = Array.from({ length: 5 }, (_, i) => [i, `POINT (${i} ${i})`]);
    const fc = geoFeaturesFromInspectRows(['id', 'geom'], rows, 'geom', 3);
    expect(fc.features).toHaveLength(3);
  });
});

// ============================================================
// normalizeDaSources / guessDaSourceType  [DataAgentEditor]
// Regression for the confirmed `eo.map is not a function` crash: a legacy
// record persisted `sources` as a comma-separated STRING.
// ============================================================

describe('guessDaSourceType', () => {
  it('maps name keywords to the right typed source', () => {
    expect(guessDaSourceType('fin-warehouse')).toBe('warehouse');
    expect(guessDaSourceType('orders semantic model')).toBe('semantic-model');
    expect(guessDaSourceType('ldn-gold-lakehouse')).toBe('lakehouse');
    expect(guessDaSourceType('telemetry kql db')).toBe('kql');
    expect(guessDaSourceType('docs ai search index')).toBe('ai-search');
    expect(guessDaSourceType('ontology-finance')).toBe('ontology');
    expect(guessDaSourceType('supply-chain graph model')).toBe('graph');
    expect(guessDaSourceType('routes gql')).toBe('graph');
  });
  it('defaults unknown names to warehouse', () => {
    expect(guessDaSourceType('mystery-thing')).toBe('warehouse');
  });
});

describe('daSupportsExampleQueries', () => {
  it('allows few-shot for lakehouse / warehouse / kql / graph / ai-search (per Fabric Learn)', () => {
    for (const t of ['warehouse', 'lakehouse', 'kql', 'graph', 'ai-search'] as const) {
      expect(daSupportsExampleQueries(t)).toBe(true);
    }
  });
  it('disallows few-shot for semantic-model and ontology (per Fabric Learn)', () => {
    expect(daSupportsExampleQueries('semantic-model')).toBe(false);
    expect(daSupportsExampleQueries('ontology')).toBe(false);
  });
});

describe('normalizeDaSources', () => {
  it('parses the confirmed legacy comma-separated STRING without throwing', () => {
    const legacy = 'fin-warehouse, orders semantic model, ldn-gold-lakehouse, mystery-source';
    const out = normalizeDaSources(legacy);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(4);
    expect(out.map((s) => s.type)).toEqual(['warehouse', 'semantic-model', 'lakehouse', 'warehouse']);
    expect(out.map((s) => s.name)).toEqual(['fin-warehouse', 'orders semantic model', 'ldn-gold-lakehouse', 'mystery-source']);
    // Migrated sources carry stable legacy ids + the instruction template.
    expect(out[0].id).toBe('warehouse:fin-warehouse:legacy');
    expect(out.every((s) => typeof s.instructions === 'string' && Array.isArray(s.examples))).toBe(true);
  });

  it('normalizes an already-array value, filling missing id/type', () => {
    const out = normalizeDaSources([
      { name: 'sales warehouse' },                              // missing id+type
      { id: 'x:y:1', type: 'lakehouse', name: 'lh', tables: 't' }, // already shaped
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('warehouse');
    expect(out[0].id).toBe('warehouse:sales-warehouse:legacy');
    expect(out[1]).toMatchObject({ id: 'x:y:1', type: 'lakehouse', name: 'lh', tables: 't' });
  });

  it('returns [] for non-array, non-string shapes (object/null/undefined/number)', () => {
    expect(normalizeDaSources(undefined)).toEqual([]);
    expect(normalizeDaSources(null)).toEqual([]);
    expect(normalizeDaSources({})).toEqual([]);
    expect(normalizeDaSources(42 as unknown)).toEqual([]);
    expect(normalizeDaSources('')).toEqual([]);
  });

  it('drops non-object entries inside an array', () => {
    const out = normalizeDaSources(['just-a-string', null, { name: 'wh' }]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('wh');
  });
});

// ---------------------------------------------------------------------------
// shapeDaHistory / canSendDaQuestion  [DataAgentEditor test chat]
// ---------------------------------------------------------------------------

describe('shapeDaHistory', () => {
  it('keeps only role+content for user/assistant turns', () => {
    const out = shapeDaHistory([
      { role: 'user', content: 'hi', error: false },
      { role: 'assistant', content: 'hello', query: 'SELECT 1' } as any,
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('excludes error bubbles so a failed turn never poisons grounding', () => {
    const out = shapeDaHistory([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: '503 no deployment', error: true },
      { role: 'user', content: 'q2' },
    ]);
    expect(out.map((t) => t.content)).toEqual(['q1', 'q2']);
  });

  it('drops blank / non-string content', () => {
    const out = shapeDaHistory([
      { role: 'user', content: '   ' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'real' },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'real' }]);
  });

  it('caps to the last N turns (default 10)', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
    const out = shapeDaHistory(many);
    expect(out).toHaveLength(10);
    expect(out[0].content).toBe('m4');
    expect(out[9].content).toBe('m13');
  });

  it('honours a custom max and an unbounded max=0', () => {
    const turns = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
      { role: 'user' as const, content: 'c' },
    ];
    expect(shapeDaHistory(turns, 2).map((t) => t.content)).toEqual(['b', 'c']);
    expect(shapeDaHistory(turns, 0)).toHaveLength(3);
  });

  it('tolerates a non-array input', () => {
    expect(shapeDaHistory(undefined as any)).toEqual([]);
    expect(shapeDaHistory(null as any)).toEqual([]);
  });
});

describe('canSendDaQuestion', () => {
  it('is true only for a non-blank question when not asking', () => {
    expect(canSendDaQuestion('hello', false)).toBe(true);
    expect(canSendDaQuestion('  hi  ', false)).toBe(true);
  });

  it('is false when empty / whitespace / asking', () => {
    expect(canSendDaQuestion('', false)).toBe(false);
    expect(canSendDaQuestion('   ', false)).toBe(false);
    expect(canSendDaQuestion('hello', true)).toBe(false);
    expect(canSendDaQuestion(undefined as any, false)).toBe(false);
  });
});
