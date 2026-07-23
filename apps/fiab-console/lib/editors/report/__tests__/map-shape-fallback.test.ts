/**
 * A8 — basemap-free shape-map fallback model (map-visual.buildShapeFallbackModel).
 *
 * The report Map visual uses Azure Maps, which is unavailable in GCC/Gov. A8 adds
 * an honest gate PLUS a basemap-free fallback so a REAL map still renders in Gov
 * with NO external tile call (no-vaporware / no-fabric-dependency parity-on-Azure).
 * This pins the offline model the self-contained GeoJsonMap SVG renderer consumes:
 * a choropleth (Location + Size over bundled OSS TopoJSON) or a lat/long point
 * plot, joined to real aggregate rows.
 */
import { describe, it, expect } from 'vitest';
import { buildShapeFallbackModel, type ResolvedMapBindings } from '../map-visual';

const bind = (over: Partial<ResolvedMapBindings> = {}): ResolvedMapBindings => ({
  hasLatLong: false, ...over,
});

// A tiny 2-country TopoJSON-decoded FeatureCollection (already GeoJSON).
const TOPO = {
  features: [
    { type: 'Feature', properties: { name: 'France' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    { type: 'Feature', properties: { name: 'Germany' }, geometry: { type: 'Polygon', coordinates: [[[2, 0], [3, 0], [3, 1], [2, 0]]] } },
  ],
};

describe('buildShapeFallbackModel — choropleth (Location + Size)', () => {
  const rows = [
    { Country: 'France', Sales: 500 },
    { Country: 'Germany', Sales: 800 },
  ];
  const resolved = bind({ locationCol: 'Country', sizeCol: 'Sales' });

  it('joins the aggregate to the bundled boundaries as a choropleth', () => {
    const m = buildShapeFallbackModel(rows, resolved, TOPO);
    expect(m.kind).toBe('choropleth');
    expect(m.layers[0]).toMatchObject({ type: 'choropleth', weightProp: 'size' });
    const feats = m.geojson.features as Array<{ properties: { label: string; size: number | null } }>;
    expect(feats).toHaveLength(2);
    expect(feats.find((f) => f.properties.label === 'France')!.properties.size).toBe(500);
    expect(feats.find((f) => f.properties.label === 'Germany')!.properties.size).toBe(800);
  });

  it('is case-insensitive on the location join (normKey)', () => {
    const m = buildShapeFallbackModel([{ Country: 'france', Sales: 42 }], resolved, TOPO);
    const feats = m.geojson.features as Array<{ properties: { label: string; size: number | null } }>;
    expect(feats.find((f) => f.properties.label === 'France')!.properties.size).toBe(42);
  });

  it('unmatched boundaries carry a null value (drawn as the ramp floor, not dropped)', () => {
    const m = buildShapeFallbackModel([{ Country: 'France', Sales: 500 }], resolved, TOPO);
    const feats = m.geojson.features as Array<{ properties: { label: string; size: number | null } }>;
    expect(feats.find((f) => f.properties.label === 'Germany')!.properties.size).toBeNull();
  });

  it('no topo loaded yet ⇒ kind:none (fall back to the config gate + rows)', () => {
    expect(buildShapeFallbackModel(rows, resolved, undefined).kind).toBe('none');
  });

  it('no numeric size in any row ⇒ kind:none (nothing to shade)', () => {
    const m = buildShapeFallbackModel([{ Country: 'France', Sales: 'n/a' }], resolved, TOPO);
    expect(m.kind).toBe('none');
  });
});

describe('buildShapeFallbackModel — offline point plot (lat/long)', () => {
  const rows = [
    { City: 'Paris', Lat: 48.85, Long: 2.35, Pop: 2 },
    { City: 'Berlin', Lat: 52.52, Long: 13.4, Pop: 3 },
    { City: 'Bad', Lat: 'x', Long: 5, Pop: 1 },
  ];
  const resolved = bind({ hasLatLong: true, latCol: 'Lat', longCol: 'Long', sizeCol: 'Pop', locationCol: 'City' });

  it('emits one point feature per valid lat/long row (no basemap, no geocoding)', () => {
    const m = buildShapeFallbackModel(rows, resolved, undefined);
    expect(m.kind).toBe('point');
    expect(m.layers[0]).toMatchObject({ type: 'point', sizeByMetric: true, weightProp: 'size' });
    const feats = m.geojson.features as Array<{ geometry: { coordinates: [number, number] }; properties: { label: string; size: number | null } }>;
    // the non-finite lat row is dropped
    expect(feats).toHaveLength(2);
    expect(feats[0].geometry.coordinates).toEqual([2.35, 48.85]);
    expect(feats[0].properties).toMatchObject({ label: 'Paris', size: 2 });
  });

  it('lat/long takes precedence over a choropleth even when a topo is present', () => {
    const m = buildShapeFallbackModel(rows, resolved, TOPO);
    expect(m.kind).toBe('point');
  });
});

describe('buildShapeFallbackModel — nothing bound', () => {
  it('no lat/long and no location ⇒ kind:none', () => {
    expect(buildShapeFallbackModel([{ X: 1 }], bind(), TOPO).kind).toBe('none');
  });
});
