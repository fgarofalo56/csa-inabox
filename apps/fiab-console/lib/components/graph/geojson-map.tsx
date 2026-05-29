'use client';

/**
 * GeoJsonMap — a self-contained SVG renderer for GeoJSON geometry.
 *
 * No external map library / no Azure Maps subscription required: it projects
 * lon/lat into an equirectangular SVG viewport sized to the data's bounding
 * box, draws Points / LineStrings / Polygons (and their Multi* variants),
 * and labels point features by their `name`/`title` property. This is a real
 * visualization of the features (per the UI-parity "viz must actually
 * render" bar), usable offline. An optional Azure Maps static raster can be
 * layered behind it when a key is configured — but the vector overlay always
 * renders regardless.
 *
 * It is intentionally generic so both the Fabric-IQ `map` editor and the
 * geospatial `geo-map` editor can share it.
 */

import { useMemo } from 'react';
import { Caption1, tokens } from '@fluentui/react-components';

export interface GeoJsonMapProps {
  /** Parsed GeoJSON object (FeatureCollection / Feature / Geometry). */
  geojson: unknown;
  width?: number;
  height?: number;
  /** Optional raster tile URL to draw behind the vector overlay. */
  rasterUrl?: string | null;
}

interface Bounds { minLon: number; maxLon: number; minLat: number; maxLat: number }

function collectFeatures(g: any): any[] {
  if (!g) return [];
  if (g.type === 'FeatureCollection' && Array.isArray(g.features)) return g.features;
  if (g.type === 'Feature') return [g];
  if (g.type && g.coordinates) return [{ type: 'Feature', geometry: g, properties: {} }];
  return [];
}

function walkCoords(geom: any, cb: (lon: number, lat: number) => void) {
  if (!geom) return;
  const c = geom.coordinates;
  const visit = (arr: any) => {
    if (!Array.isArray(arr)) return;
    if (typeof arr[0] === 'number' && typeof arr[1] === 'number') cb(arr[0], arr[1]);
    else arr.forEach(visit);
  };
  visit(c);
}

export function GeoJsonMap({ geojson, width = 640, height = 360, rasterUrl }: GeoJsonMapProps) {
  const features = useMemo(() => collectFeatures(geojson), [geojson]);

  const bounds = useMemo<Bounds | null>(() => {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const f of features) {
      walkCoords(f.geometry, (lon, lat) => {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      });
    }
    if (!Number.isFinite(minLon)) return null;
    // Pad a degenerate (single-point) bbox so we don't divide by zero.
    if (maxLon - minLon < 1e-6) { minLon -= 0.01; maxLon += 0.01; }
    if (maxLat - minLat < 1e-6) { minLat -= 0.01; maxLat += 0.01; }
    return { minLon, maxLon, minLat, maxLat };
  }, [features]);

  const pad = 16;
  const project = useMemo(() => {
    if (!bounds) return null;
    const spanLon = bounds.maxLon - bounds.minLon;
    const spanLat = bounds.maxLat - bounds.minLat;
    return (lon: number, lat: number): [number, number] => {
      const x = pad + ((lon - bounds.minLon) / spanLon) * (width - 2 * pad);
      // SVG y grows downward; invert latitude.
      const y = pad + (1 - (lat - bounds.minLat) / spanLat) * (height - 2 * pad);
      return [x, y];
    };
  }, [bounds, width, height]);

  if (!project) {
    return (
      <div style={{ width, maxWidth: '100%', height, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, background: tokens.colorNeutralBackground3 }}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No coordinates to plot.</Caption1>
      </div>
    );
  }

  const stroke = tokens.colorBrandStroke1;
  const fill = tokens.colorBrandBackground2;

  return (
    <div style={{ position: 'relative', width, maxWidth: '100%' }}>
      <svg
        width="100%" viewBox={`0 0 ${width} ${height}`}
        role="img" aria-label="GeoJSON map"
        style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, background: rasterUrl ? 'transparent' : tokens.colorNeutralBackground3, display: 'block' }}
      >
        {rasterUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <image href={rasterUrl} x={0} y={0} width={width} height={height} preserveAspectRatio="xMidYMid slice" />
        )}
        {/* graticule */}
        {[0.25, 0.5, 0.75].map((t) => (
          <g key={t}>
            <line x1={pad + t * (width - 2 * pad)} y1={pad} x2={pad + t * (width - 2 * pad)} y2={height - pad} stroke={tokens.colorNeutralStroke2} strokeDasharray="2 4" />
            <line x1={pad} y1={pad + t * (height - 2 * pad)} x2={width - pad} y2={pad + t * (height - 2 * pad)} stroke={tokens.colorNeutralStroke2} strokeDasharray="2 4" />
          </g>
        ))}
        {features.map((f, fi) => {
          const geom = f.geometry;
          if (!geom) return null;
          const name = f.properties?.name || f.properties?.title || f.properties?.id;
          const renderLine = (line: number[][], key: string, close = false) => {
            const pts = line.map(([lon, lat]) => project(lon, lat).join(',')).join(' ');
            return close
              ? <polygon key={key} points={pts} fill={fill} fillOpacity={0.35} stroke={stroke} strokeWidth={1.5} />
              : <polyline key={key} points={pts} fill="none" stroke={stroke} strokeWidth={1.5} />;
          };
          switch (geom.type) {
            case 'Point': {
              const [x, y] = project(geom.coordinates[0], geom.coordinates[1]);
              return (
                <g key={fi}>
                  <circle cx={x} cy={y} r={5} fill={stroke} stroke={tokens.colorNeutralBackground1} strokeWidth={1.5} />
                  {name && <text x={x + 8} y={y + 4} fontSize={11} fill={tokens.colorNeutralForeground1}>{String(name)}</text>}
                </g>
              );
            }
            case 'MultiPoint':
              return <g key={fi}>{geom.coordinates.map((c: number[], i: number) => { const [x, y] = project(c[0], c[1]); return <circle key={i} cx={x} cy={y} r={4} fill={stroke} />; })}</g>;
            case 'LineString':
              return renderLine(geom.coordinates, `${fi}`);
            case 'MultiLineString':
              return <g key={fi}>{geom.coordinates.map((l: number[][], i: number) => renderLine(l, `${fi}-${i}`))}</g>;
            case 'Polygon':
              return <g key={fi}>{geom.coordinates.map((ring: number[][], i: number) => renderLine(ring, `${fi}-${i}`, true))}</g>;
            case 'MultiPolygon':
              return <g key={fi}>{geom.coordinates.flatMap((poly: number[][][], pi: number) => poly.map((ring, ri) => renderLine(ring, `${fi}-${pi}-${ri}`, true)))}</g>;
            default:
              return null;
          }
        })}
      </svg>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        {features.length} feature{features.length === 1 ? '' : 's'}
        {bounds && ` · bbox [${bounds.minLon.toFixed(3)}, ${bounds.minLat.toFixed(3)}] → [${bounds.maxLon.toFixed(3)}, ${bounds.maxLat.toFixed(3)}]`}
      </Caption1>
    </div>
  );
}
