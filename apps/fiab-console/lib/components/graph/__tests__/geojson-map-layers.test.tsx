/**
 * GeoJsonMap layer-rendering tests (audit H7).
 *
 * Verifies the renderer draws the new point/heatmap/cluster/choropleth layers
 * over bound geo features — the dataset-binding + layer model the Fabric Map
 * promises, rendered offline in SVG (no Azure Maps key required).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { GeoJsonMap, type MapLayer } from '../geojson-map';

const FC = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'A', value: 10 }, geometry: { type: 'Point', coordinates: [-122.3, 47.6] } },
    { type: 'Feature', properties: { name: 'B', value: 90 }, geometry: { type: 'Point', coordinates: [-121.9, 47.4] } },
  ],
};

const POLY = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { value: 5 }, geometry: { type: 'Polygon', coordinates: [[[-122, 47], [-122, 48], [-121, 48], [-121, 47], [-122, 47]]] } },
  ],
};

describe('GeoJsonMap layers', () => {
  afterEach(() => cleanup());

  it('renders a heatmap layer with a radial gradient + circles', () => {
    const layers: MapLayer[] = [{ id: 'h', type: 'heatmap', enabled: true, weightProp: 'value' }];
    const { container } = render(<GeoJsonMap geojson={FC} layers={layers} />);
    expect(container.querySelector('radialGradient')).toBeTruthy();
    expect(container.querySelectorAll('circle').length).toBeGreaterThanOrEqual(2);
  });

  it('renders a cluster layer with sized circles + count labels', () => {
    const layers: MapLayer[] = [{ id: 'c', type: 'cluster', enabled: true, weightProp: 'value' }];
    const { container } = render(<GeoJsonMap geojson={FC} layers={layers} />);
    expect(container.querySelectorAll('circle').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll('text').length).toBeGreaterThanOrEqual(2);
  });

  it('renders a choropleth layer as shaded polygons', () => {
    const layers: MapLayer[] = [{ id: 'ch', type: 'choropleth', enabled: true, weightProp: 'value' }];
    const { container } = render(<GeoJsonMap geojson={POLY} layers={layers} />);
    expect(container.querySelectorAll('polygon').length).toBeGreaterThanOrEqual(1);
  });

  it('skips disabled layers', () => {
    const layers: MapLayer[] = [{ id: 'h', type: 'heatmap', enabled: false, weightProp: 'value' }];
    const { container } = render(<GeoJsonMap geojson={FC} layers={layers} />);
    expect(container.querySelector('radialGradient')).toBeFalsy();
  });

  it('falls back to the legacy vector overlay when no layers are given', () => {
    const { container } = render(<GeoJsonMap geojson={FC} />);
    // Legacy path still renders the point circles.
    expect(container.querySelectorAll('circle').length).toBeGreaterThanOrEqual(2);
  });
});
