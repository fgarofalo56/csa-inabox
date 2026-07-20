/**
 * geo-sql — unit tests for the eventstream geospatial operators' Stream
 * Analytics SQL emission (PRP geo-graph-ml GEO-1). Pure builders + the
 * end-to-end compile through the shared ASA compiler (compileToSaql), so the
 * canvas nodes, the guided inspector, and the generated SAQL cannot drift.
 */
import { describe, it, expect } from 'vitest';
import {
  isGeoTransformKind, thresholdMeters, pointExpr, fencePolygonExpr,
  geoPointSelectList, geoFenceSelectList, geoFenceTail,
  geoProximitySelectList, geoProximityTail,
  geoAggregateSelectList, geoAggregateTail,
  geoSelectList, geoTail, geoDefaultOperator, geoNodeSubtitle,
  parseGeoJsonFences, parseWktFences,
  type GeoTransformNode, type GeoFenceDef,
} from '../geo-sql';
import { compileToSaql, type SourceNode, type SinkNode, type TransformNode } from '@/lib/azure/asa-query-compiler';

const src = (name: string): SourceNode => ({ kind: 'eventhub', name });
const sink = (name: string): SinkNode => ({ kind: 'kusto', name });

const triangle: GeoFenceDef = {
  name: 'depot',
  vertices: [
    { lat: 47.6, lon: -122.33 },
    { lat: 47.61, lon: -122.33 },
    { lat: 47.61, lon: -122.32 },
  ],
};

describe('isGeoTransformKind', () => {
  it('recognizes the four geo kinds and nothing else', () => {
    expect(isGeoTransformKind('geo-point')).toBe(true);
    expect(isGeoTransformKind('geo-fence')).toBe(true);
    expect(isGeoTransformKind('geo-proximity')).toBe(true);
    expect(isGeoTransformKind('geo-aggregate')).toBe(true);
    expect(isGeoTransformKind('filter')).toBe(false);
    expect(isGeoTransformKind(undefined)).toBe(false);
  });
});

describe('thresholdMeters', () => {
  it('converts km and miles to meters', () => {
    expect(thresholdMeters(500, 'm')).toBe(500);
    expect(thresholdMeters(2, 'km')).toBe(2000);
    expect(thresholdMeters(1, 'mi')).toBe(1609.344);
    expect(thresholdMeters(undefined, 'km')).toBe(0);
  });
});

describe('pointExpr', () => {
  it('builds CreatePoint over CAST-to-float lat/lon columns', () => {
    expect(pointExpr({ latColumn: 'lat', lonColumn: 'lng' }))
      .toBe('CreatePoint(CAST(lat AS float), CAST(lng AS float))');
  });
  it('qualifies columns with the join prefix', () => {
    expect(pointExpr({ latColumn: 'lat', lonColumn: 'lon' }, 'L.'))
      .toBe('CreatePoint(CAST(L.lat AS float), CAST(L.lon AS float))');
  });
  it('uses an existing point column when pointMode=column', () => {
    expect(pointExpr({ pointMode: 'column', pointColumn: 'geo' }, 'L.')).toBe('L.geo');
  });
});

describe('fencePolygonExpr', () => {
  it('emits CreatePolygon with an auto-closed ring', () => {
    const expr = fencePolygonExpr(triangle)!;
    expect(expr.startsWith('CreatePolygon(')).toBe(true);
    // 3 vertices + 1 closing duplicate = 4 CreatePoint calls.
    expect(expr.match(/CreatePoint\(/g)).toHaveLength(4);
    expect(expr).toContain('CreatePoint(47.6, -122.33)');
    // Ring closes back on the first vertex.
    expect(expr.endsWith('CreatePoint(47.6, -122.33))')).toBe(true);
  });
  it('keeps an already-closed ring intact', () => {
    const closed: GeoFenceDef = { name: 'x', vertices: [...triangle.vertices, triangle.vertices[0]] };
    expect(fencePolygonExpr(closed)!.match(/CreatePoint\(/g)).toHaveLength(4);
  });
  it('returns null for fewer than 3 vertices', () => {
    expect(fencePolygonExpr({ name: 'x', vertices: triangle.vertices.slice(0, 2) })).toBeNull();
  });
});

describe('geo-point', () => {
  it('passes rows through and appends the built point', () => {
    const n: GeoTransformNode = { kind: 'geo-point', latColumn: 'lat', lonColumn: 'lon', pointAlias: 'pos' };
    expect(geoPointSelectList(n)).toBe('*, CreatePoint(CAST(lat AS float), CAST(lon AS float)) AS pos');
    expect(geoTail(n, '[in]', ' TIMESTAMP BY ts')).toBe('FROM [in] TIMESTAMP BY ts');
  });
});

describe('geo-fence (inline)', () => {
  const base: GeoTransformNode = {
    kind: 'geo-fence', latColumn: 'lat', lonColumn: 'lon',
    fenceSource: 'inline', fenceMode: 'inside', fences: [triangle],
    fenceOutputColumn: 'matchedFence',
  };
  it('inside mode: CASE-projects the matched fence and filters ST_WITHIN = 1', () => {
    const sel = geoFenceSelectList(base);
    expect(sel).toContain("CASE WHEN ST_WITHIN(CreatePoint(CAST(lat AS float), CAST(lon AS float)), CreatePolygon(");
    expect(sel).toContain("THEN 'depot'");
    expect(sel).toContain('AS matchedFence');
    const tail = geoFenceTail(base, '[in]');
    expect(tail).toContain('WHERE ST_WITHIN(');
    expect(tail).toContain(') = 1');
  });
  it('outside mode: keeps events in NO fence (AND of = 0)', () => {
    const n = { ...base, fenceMode: 'outside' as const, fences: [triangle, { ...triangle, name: 'hq' }] };
    expect(geoFenceSelectList(n)).toBe('*');
    const tail = geoFenceTail(n, '[in]');
    expect(tail.match(/ST_WITHIN\(/g)).toHaveLength(2);
    expect(tail).toContain(') = 0');
    expect(tail).toContain('AND ');
  });
  it('multi-fence inside mode ORs the fences', () => {
    const n = { ...base, fences: [triangle, { ...triangle, name: 'hq' }] };
    const tail = geoFenceTail(n, '[in]');
    expect(tail).toContain('OR ');
    expect(geoFenceSelectList(n)).toContain("THEN 'hq'");
  });
  it('escapes quotes in fence names', () => {
    const n = { ...base, fences: [{ ...triangle, name: "o'hare" }] };
    expect(geoFenceSelectList(n)).toContain("'o''hare'");
  });
  it('passes through when no valid fence exists (lint catches it)', () => {
    const n = { ...base, fences: [{ name: 'tiny', vertices: triangle.vertices.slice(0, 2) }] };
    expect(geoFenceSelectList(n)).toBe('*');
    expect(geoFenceTail(n, '[in]')).toBe('FROM [in]');
  });
});

describe('geo-fence (reference data)', () => {
  const base: GeoTransformNode = {
    kind: 'geo-fence', latColumn: 'lat', lonColumn: 'lon',
    fenceSource: 'reference', fenceMode: 'inside',
    fenceRefInput: 'geofences', fenceRefNameColumn: 'fenceName', fenceRefPolygonColumn: 'polygon',
    fenceOutputColumn: 'matchedFence',
  };
  it('inside mode: joins the reference input on ST_WITHIN = 1 (no DATEDIFF)', () => {
    expect(geoFenceSelectList(base)).toBe('L.*, R.fenceName AS matchedFence');
    const tail = geoFenceTail(base, '[in]', ' TIMESTAMP BY ts');
    expect(tail).toBe(
      'FROM [in] L TIMESTAMP BY ts\n' +
      'JOIN [geofences] R\n' +
      'ON ST_WITHIN(CreatePoint(CAST(L.lat AS float), CAST(L.lon AS float)), R.polygon) = 1',
    );
    expect(tail).not.toContain('DATEDIFF');
  });
  it('outside mode: LEFT OUTER JOIN + IS NULL anti-join', () => {
    const n = { ...base, fenceMode: 'outside' as const };
    expect(geoFenceSelectList(n)).toBe('L.*');
    const tail = geoFenceTail(n, '[in]');
    expect(tail).toContain('LEFT OUTER JOIN [geofences] R');
    expect(tail).toContain('WHERE R.fenceName IS NULL');
  });
});

describe('geo-proximity', () => {
  it('static mode: WHERE ST_DISTANCE to the fixed point, threshold in meters', () => {
    const n: GeoTransformNode = {
      kind: 'geo-proximity', latColumn: 'lat', lonColumn: 'lon',
      proximityTarget: 'static', staticLat: 47.6, staticLon: -122.33,
      thresholdValue: 2, thresholdUnit: 'km', distanceAlias: 'distanceMeters',
    };
    expect(geoProximitySelectList(n)).toBe(
      '*, ST_DISTANCE(CreatePoint(CAST(lat AS float), CAST(lon AS float)), CreatePoint(47.6, -122.33)) AS distanceMeters',
    );
    const tail = geoProximityTail(n, '[in]');
    expect(tail).toContain('WHERE ST_DISTANCE(');
    expect(tail).toContain('< 2000');
  });
  it('stream mode: DATEDIFF-bounded temporal join + distance WHERE', () => {
    const n: GeoTransformNode = {
      kind: 'geo-proximity', latColumn: 'vLat', lonColumn: 'vLon',
      proximityTarget: 'stream', joinSource: 'depots', joinDurationSeconds: 30,
      rightPointMode: 'latlon', rightLatColumn: 'dLat', rightLonColumn: 'dLon',
      thresholdValue: 500, thresholdUnit: 'm',
    };
    expect(geoProximitySelectList(n)).toContain('L.*, R.*, ST_DISTANCE(');
    const tail = geoProximityTail(n, '[in]', ' TIMESTAMP BY ts');
    expect(tail).toContain('INNER JOIN [depots] R');
    expect(tail).toContain('ON DATEDIFF(second, L, R) BETWEEN 0 AND 30');
    expect(tail).toContain('WHERE ST_DISTANCE(CreatePoint(CAST(L.vLat AS float), CAST(L.vLon AS float)), CreatePoint(CAST(R.dLat AS float), CAST(R.dLon AS float))) < 500');
  });
});

describe('geo-aggregate', () => {
  const n: GeoTransformNode = {
    kind: 'geo-aggregate', regionColumn: 'matchedFence', timestampBy: 'ts',
    aggregates: [{ func: 'COUNT', field: '*', alias: 'requests' }],
    windowSize: 5, windowUnit: 'minute', hopSize: 1,
  };
  it('groups by region + HoppingWindow with the window-end timestamp', () => {
    expect(geoAggregateSelectList(n)).toBe('matchedFence, COUNT(*) AS requests, System.Timestamp() AS windowEnd');
    expect(geoAggregateTail(n, '[in]', ' TIMESTAMP BY ts')).toBe(
      'FROM [in] TIMESTAMP BY ts\nGROUP BY matchedFence, HoppingWindow(minute, 5, 1)',
    );
  });
  it('defaults to COUNT(*) AS eventCount when no aggregations are listed', () => {
    expect(geoAggregateSelectList({ kind: 'geo-aggregate' })).toContain('COUNT(*) AS eventCount');
  });
  it('window-only grouping when no region column is set', () => {
    expect(geoAggregateTail({ kind: 'geo-aggregate' }, '[in]')).toBe(
      'FROM [in]\nGROUP BY HoppingWindow(minute, 5, 5)',
    );
  });
});

describe('geoSelectList / geoTail dispatchers', () => {
  it('dispatch every geo kind', () => {
    for (const kind of ['geo-point', 'geo-fence', 'geo-proximity', 'geo-aggregate'] as const) {
      const node = geoDefaultOperator(kind, 1) as GeoTransformNode;
      expect(typeof geoSelectList(node)).toBe('string');
      expect(geoTail(node, '[in]')).toContain('FROM [in]');
    }
  });
});

describe('compileToSaql end-to-end with geo operators', () => {
  it('compiles a single geo-fence transform into a full INTO statement', () => {
    const t: TransformNode = {
      kind: 'geo-fence', name: 'fence', latColumn: 'lat', lonColumn: 'lon',
      fenceSource: 'inline', fenceMode: 'inside', fences: [triangle],
      timestampBy: 'eventTime',
    } as TransformNode;
    const q = compileToSaql([src('gps-in')], [t], [sink('violations')]);
    expect(q).toContain('INTO [violations]');
    expect(q).toContain('FROM [gps-in] TIMESTAMP BY eventTime');
    expect(q).toContain('ST_WITHIN(');
    expect(q).toContain('CreatePolygon(');
  });

  it('compiles the point → fence → aggregate chain as a WITH chain over the point column', () => {
    const point: TransformNode = { kind: 'geo-point', name: 'pt', latColumn: 'lat', lonColumn: 'lon', pointAlias: 'pos' } as TransformNode;
    const fence: TransformNode = {
      kind: 'geo-fence', name: 'zones', pointMode: 'column', pointColumn: 'pos',
      fenceSource: 'reference', fenceRefInput: 'zones-ref',
    } as TransformNode;
    const agg: TransformNode = {
      kind: 'geo-aggregate', name: 'per-region', regionColumn: 'matchedFence',
      aggregates: [{ func: 'COUNT', field: '*', alias: 'requests' }],
      windowSize: 5, windowUnit: 'minute', hopSize: 1,
    } as TransformNode;
    const q = compileToSaql([src('gps-in')], [point, fence, agg], [sink('per-region-out')]);
    expect(q).toContain('WITH step1 AS');
    expect(q).toContain('CreatePoint(CAST(lat AS float), CAST(lon AS float)) AS pos');
    expect(q).toContain('ST_WITHIN(L.pos, R.polygon) = 1');
    expect(q).toContain('GROUP BY matchedFence, HoppingWindow(minute, 5, 1)');
    expect(q).toContain('INTO [per-region-out]');
  });

  it('compiles a static proximity transform with unit conversion', () => {
    const t: TransformNode = {
      kind: 'geo-proximity', name: 'near-depot', latColumn: 'lat', lonColumn: 'lon',
      proximityTarget: 'static', staticLat: 38.9, staticLon: -77.03,
      thresholdValue: 1, thresholdUnit: 'mi',
    } as TransformNode;
    const q = compileToSaql([src('fleet')], [t], [sink('near')]);
    expect(q).toContain('< 1609.344');
    expect(q).toContain('AS distanceMeters');
  });
});

describe('geoDefaultOperator', () => {
  it('seeds typed defaults per kind', () => {
    expect(geoDefaultOperator('geo-point', 2)).toMatchObject({ kind: 'geo-point', name: 'geo-point-2', pointAlias: 'point' });
    expect(geoDefaultOperator('geo-fence', 1)).toMatchObject({ fenceSource: 'inline', fenceMode: 'inside' });
    expect(geoDefaultOperator('geo-proximity', 1)).toMatchObject({ proximityTarget: 'static', thresholdUnit: 'm' });
    expect(geoDefaultOperator('geo-aggregate', 1)).toMatchObject({ windowUnit: 'minute', windowSize: 5 });
  });
});

describe('geoNodeSubtitle (compact canvas caption)', () => {
  it('captions each kind', () => {
    expect(geoNodeSubtitle({ kind: 'geo-point', latColumn: 'lat', lonColumn: 'lon' })).toBe('lat, lon → point');
    expect(geoNodeSubtitle({ kind: 'geo-fence', fences: [triangle] })).toBe('1 fence · inside');
    expect(geoNodeSubtitle({ kind: 'geo-fence', fenceSource: 'reference', fenceRefInput: 'zones' })).toBe('ref zones · inside');
    expect(geoNodeSubtitle({ kind: 'geo-proximity', thresholdValue: 2, thresholdUnit: 'km' })).toBe('< 2000 m ↔ fixed point');
    expect(geoNodeSubtitle({ kind: 'geo-aggregate', regionColumn: 'region', windowSize: 5, hopSize: 1 }))
      .toBe('by region · Hopping(minute, 5, 1)');
  });
});

describe('fence import parsers', () => {
  it('parses a GeoJSON FeatureCollection with named polygons', () => {
    const gj = JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'depot' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-122.33, 47.6], [-122.33, 47.61], [-122.32, 47.61], [-122.33, 47.6]]],
        },
      }],
    });
    const fences = parseGeoJsonFences(gj);
    expect(fences).toHaveLength(1);
    expect(fences[0].name).toBe('depot');
    // Closing duplicate dropped; GeoJSON [lon, lat] order flipped to {lat, lon}.
    expect(fences[0].vertices).toEqual([
      { lat: 47.6, lon: -122.33 },
      { lat: 47.61, lon: -122.33 },
      { lat: 47.61, lon: -122.32 },
    ]);
  });
  it('parses a bare MultiPolygon into indexed fences', () => {
    const gj = JSON.stringify({
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [0, 1], [1, 1], [0, 0]]],
        [[[10, 10], [10, 11], [11, 11], [10, 10]]],
      ],
    });
    const fences = parseGeoJsonFences(gj, 'zone');
    expect(fences).toHaveLength(2);
    expect(fences[0].vertices[0]).toEqual({ lat: 0, lon: 0 });
  });
  it('throws on GeoJSON without a usable polygon', () => {
    expect(() => parseGeoJsonFences('{"type":"Point","coordinates":[0,0]}')).toThrow();
    expect(() => parseGeoJsonFences('not json')).toThrow();
  });
  it('parses WKT POLYGON (lon lat order) and drops the closing vertex', () => {
    const fences = parseWktFences('POLYGON ((-122.33 47.6, -122.33 47.61, -122.32 47.61, -122.33 47.6))');
    expect(fences).toHaveLength(1);
    expect(fences[0].vertices).toEqual([
      { lat: 47.6, lon: -122.33 },
      { lat: 47.61, lon: -122.33 },
      { lat: 47.61, lon: -122.32 },
    ]);
  });
  it('parses WKT MULTIPOLYGON outer rings', () => {
    const fences = parseWktFences('MULTIPOLYGON (((0 0, 0 1, 1 1, 0 0)), ((10 10, 10 11, 11 11, 10 10)))');
    expect(fences).toHaveLength(2);
  });
  it('throws on unusable WKT', () => {
    expect(() => parseWktFences('LINESTRING (0 0, 1 1)')).toThrow();
  });
});
