/**
 * object-view (WS-4.1) — pure view-config resolution + panel-data shaping tests
 * (Foundry Object Views parity, row Foundry-1.1-A8). No PG I/O — every function
 * under test is dependency-free, so these run without a DOM or a graph store.
 */
import { describe, it, expect } from 'vitest';
import type { OntoObjectType, OntoLinkType } from '../../editors/ontology-model';
import {
  resolveObjectView, normalizeObjectViewConfig, shapeLinkedSections,
  toTimeseriesGrid, toGeoFeatureCollection, parseGeometry,
  timeProperties, numericProperties, geoProperties,
  type RawNeighbor, type ViewRecord,
} from '../object-view';

function ot(partial: Partial<OntoObjectType> & { apiName: string }): OntoObjectType {
  return { properties: [], ...partial } as OntoObjectType;
}

describe('property classifiers', () => {
  const t = ot({
    apiName: 'Reading',
    properties: [
      { apiName: 'ts', baseType: 'timestamp' },
      { apiName: 'day', baseType: 'date' },
      { apiName: 'value', baseType: 'double' },
      { apiName: 'count', baseType: 'integer' },
      { apiName: 'geo', baseType: 'geopoint' },
      { apiName: 'shape', baseType: 'geoshape' },
      { apiName: 'name', baseType: 'string' },
      { apiName: 'tags', baseType: 'double', arrayOf: true },
    ],
  });
  it('picks date/timestamp scalar props for time', () => {
    expect(timeProperties(t).map((p) => p.apiName)).toEqual(['ts', 'day']);
  });
  it('picks numeric scalar props (excludes arrays) for value', () => {
    expect(numericProperties(t).map((p) => p.apiName)).toEqual(['value', 'count']);
  });
  it('picks geopoint/geoshape props for map', () => {
    expect(geoProperties(t).map((p) => p.apiName)).toEqual(['geo', 'shape']);
  });
});

describe('resolveObjectView', () => {
  it('defaults to overview/properties/linkedObjects for a plain type', () => {
    const v = resolveObjectView(ot({ apiName: 'Customer', properties: [{ apiName: 'name', baseType: 'string' }] }));
    expect(v.panels).toEqual(['overview', 'properties', 'linkedObjects']);
    expect(v.timeProp).toBeUndefined();
    expect(v.geoProp).toBeUndefined();
  });

  it('adds timeseries when a time + numeric property exist', () => {
    const v = resolveObjectView(ot({
      apiName: 'Reading',
      properties: [{ apiName: 'ts', baseType: 'timestamp' }, { apiName: 'value', baseType: 'double' }],
    }));
    expect(v.panels).toContain('timeseries');
    expect(v.timeProp).toBe('ts');
    expect(v.valueProp).toBe('value');
  });

  it('adds map when a geo property exists', () => {
    const v = resolveObjectView(ot({ apiName: 'Site', properties: [{ apiName: 'loc', baseType: 'geopoint' }] }));
    expect(v.panels).toContain('map');
    expect(v.geoProp).toBe('loc');
  });

  it('honours an explicit config panel list + axes', () => {
    const t = ot({
      apiName: 'Reading',
      properties: [
        { apiName: 'ts', baseType: 'timestamp' }, { apiName: 'ts2', baseType: 'timestamp' },
        { apiName: 'value', baseType: 'double' }, { apiName: 'value2', baseType: 'double' },
      ],
    });
    const v = resolveObjectView(t, { panels: ['timeseries', 'overview'], timeseries: { timeProp: 'ts2', valueProp: 'value2' } });
    expect(v.panels).toEqual(['timeseries', 'overview']);
    expect(v.timeProp).toBe('ts2');
    expect(v.valueProp).toBe('value2');
  });

  it('ignores config axes that are not real properties (falls back to auto)', () => {
    const t = ot({ apiName: 'Reading', properties: [{ apiName: 'ts', baseType: 'timestamp' }, { apiName: 'value', baseType: 'double' }] });
    const v = resolveObjectView(t, { timeseries: { timeProp: 'nope' } });
    expect(v.timeProp).toBe('ts');
  });

  it('is safe on a null object type', () => {
    expect(resolveObjectView(null).panels).toEqual(['overview', 'properties', 'linkedObjects']);
  });
});

describe('normalizeObjectViewConfig', () => {
  it('drops invalid panel kinds + dedupes', () => {
    expect(normalizeObjectViewConfig({ panels: ['overview', 'bogus', 'overview', 'map'] }))
      .toEqual({ panels: ['overview', 'map'] });
  });
  it('returns null for non-objects / empty configs', () => {
    expect(normalizeObjectViewConfig(null)).toBeNull();
    expect(normalizeObjectViewConfig({})).toBeNull();
    expect(normalizeObjectViewConfig('x')).toBeNull();
  });
});

describe('shapeLinkedSections', () => {
  const linkTypes: OntoLinkType[] = [
    { apiName: 'placed', displayName: 'Placed orders', reverseDisplayName: 'Placed by', fromType: 'Customer', toType: 'Order', cardinality: 'one-to-many' },
  ];
  const neighbors: RawNeighbor[] = [
    { linkType: 'placed', direction: 'out', neighbor: { id: '10', objectType: 'Order', properties: { amount: 5 } } },
    { linkType: 'placed', direction: 'out', neighbor: { id: '11', objectType: 'Order', properties: { amount: 9 } } },
    { linkType: 'ownedBy', direction: 'in', neighbor: { id: '20', objectType: 'Account', properties: {} } },
  ];
  it('groups by (linkType × direction) with counts', () => {
    const secs = shapeLinkedSections(neighbors, linkTypes);
    const placed = secs.find((s) => s.key === 'placed:out')!;
    expect(placed.count).toBe(2);
    expect(placed.neighbors.map((n) => n.id)).toEqual(['10', '11']);
  });
  it('resolves the forward display name for out-edges', () => {
    const secs = shapeLinkedSections(neighbors, linkTypes);
    expect(secs.find((s) => s.key === 'placed:out')!.label).toBe('Placed orders');
  });
  it('falls back to the raw link type when the link is undeclared', () => {
    const secs = shapeLinkedSections(neighbors, linkTypes);
    expect(secs.find((s) => s.key === 'ownedBy:in')!.label).toBe('ownedBy');
  });
  it('uses reverseDisplayName for in-edges of a declared type', () => {
    const inNeighbors: RawNeighbor[] = [
      { linkType: 'placed', direction: 'in', neighbor: { id: '99', objectType: 'Customer', properties: {} } },
    ];
    expect(shapeLinkedSections(inNeighbors, linkTypes)[0].label).toBe('Placed by');
  });
});

describe('toTimeseriesGrid', () => {
  const recs: ViewRecord[] = [
    { properties: { orderDate: '2024-01-03', amount: 30 } },
    { properties: { orderDate: '2024-01-01', amount: 10 } },
    { properties: { orderDate: '2024-01-02', amount: 20 } },
  ];
  it('builds a sorted (time,value) grid from real properties', () => {
    const g = toTimeseriesGrid(recs)!;
    expect(g.timeProp).toBe('orderDate');
    expect(g.valueProp).toBe('amount');
    expect(g.columns).toEqual(['orderDate', 'amount']);
    expect(g.columnTypes).toEqual(['datetime', 'real']);
    expect(g.rows.map((r) => r[0])).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
  });
  it('returns null with fewer than two plottable points', () => {
    expect(toTimeseriesGrid([{ properties: { orderDate: '2024-01-01', amount: 10 } }])).toBeNull();
    expect(toTimeseriesGrid([{ properties: { name: 'a' } }, { properties: { name: 'b' } }])).toBeNull();
  });
  it('honours an explicit axis hint', () => {
    const withTwo: ViewRecord[] = [
      { properties: { t: '2024-01-01', a: 1, b: 100 } },
      { properties: { t: '2024-01-02', a: 2, b: 200 } },
    ];
    const g = toTimeseriesGrid(withTwo, { valueProp: 'b' })!;
    expect(g.valueProp).toBe('b');
  });
});

describe('parseGeometry + toGeoFeatureCollection', () => {
  it('parses a "lat,lon" pair into a Point [lon,lat]', () => {
    expect(parseGeometry('47.6,-122.3')).toEqual({ type: 'Point', coordinates: [-122.3, 47.6] });
  });
  it('disambiguates an out-of-lat-range pair as lon,lat', () => {
    expect(parseGeometry('-122.3,47.6')).toEqual({ type: 'Point', coordinates: [-122.3, 47.6] });
  });
  it('passes through a GeoJSON geometry object', () => {
    const geom = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    expect(parseGeometry(geom)).toEqual(geom);
  });
  it('parses a {lat,lon} object', () => {
    expect(parseGeometry({ lat: 10, lon: 20 })).toEqual({ type: 'Point', coordinates: [20, 10] });
  });
  it('returns null for a non-geo value', () => {
    expect(parseGeometry('hello')).toBeNull();
    expect(parseGeometry(42)).toBeNull();
  });
  it('builds a FeatureCollection from records with geo props, labelled', () => {
    const recs: ViewRecord[] = [
      { id: '1', objectType: 'Site', label: 'HQ', properties: { loc: '47.6,-122.3' } },
      { id: '2', objectType: 'Site', properties: { name: 'Depot', loc: '40.7,-74.0' } },
      { id: '3', objectType: 'Site', properties: { note: 'no geo' } },
    ];
    const fc = toGeoFeatureCollection(recs)!;
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].properties.name).toBe('HQ');
    expect(fc.features[1].properties.name).toBe('Depot');
  });
  it('returns null when no record carries a location', () => {
    expect(toGeoFeatureCollection([{ properties: { name: 'x' } }])).toBeNull();
  });
});
