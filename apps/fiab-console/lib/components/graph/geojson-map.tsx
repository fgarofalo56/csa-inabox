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

/** A render layer over the same projected features. Layers compose: e.g. a
 * heatmap under a point layer. `weightProp` selects a numeric feature property
 * used to size/intensify heatmap + cluster + choropleth rendering. */
export type MapLayerType = 'point' | 'heatmap' | 'cluster' | 'choropleth';
export interface MapLayer {
  id: string;
  type: MapLayerType;
  /** Off layers are kept in state but not drawn. Defaults to on. */
  enabled?: boolean;
  /** Feature property holding a numeric weight/value (heatmap/cluster/choropleth). */
  weightProp?: string;
  /** Base radius (px) for point/heatmap/cluster glyphs. */
  radius?: number;
  /** Color ramp endpoints (CSS colors) for value-driven layers. */
  colorLow?: string;
  colorHigh?: string;
  // ── Interactive-canvas symbology (azure-maps-canvas.tsx). All optional and
  //    ignored by the offline SVG renderer above — additive, back-compat. ──────
  /** Solid color when no weightProp ramp is used (point/cluster fill). */
  color?: string;
  /** Layer opacity 0..1 (default ~0.85 for bubbles, ~0.8 for fills). */
  opacity?: number;
  /** Scale the bubble radius by `weightProp` between sizeMin..sizeMax px. */
  sizeByMetric?: boolean;
  sizeMin?: number;
  sizeMax?: number;
  /** Per-layer visibility band (Azure Maps zoom 0..22). */
  minZoom?: number;
  maxZoom?: number;
  /** Feature property names surfaced in the hover/click popup template. */
  tooltipFields?: string[];
}

export interface GeoJsonMapProps {
  /** Parsed GeoJSON object (FeatureCollection / Feature / Geometry). */
  geojson: unknown;
  width?: number;
  height?: number;
  /** Optional raster tile URL to draw behind the vector overlay. */
  rasterUrl?: string | null;
  /**
   * Render layers. When omitted, the legacy single vector overlay is drawn
   * (back-compat). When provided, each enabled layer is rendered in order over
   * the same projection — point / heatmap / cluster / choropleth.
   */
  layers?: MapLayer[];
}

/** Read a numeric weight from a feature's properties. */
function weightOf(f: any, prop?: string): number {
  if (!prop) return 1;
  const v = f?.properties?.[prop];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** First lon/lat coordinate of a feature (used to anchor point glyphs). */
function firstCoord(geom: any): [number, number] | null {
  let found: [number, number] | null = null;
  const visit = (arr: any) => {
    if (found || !Array.isArray(arr)) return;
    if (typeof arr[0] === 'number' && typeof arr[1] === 'number') { found = [arr[0], arr[1]]; return; }
    arr.forEach(visit);
  };
  visit(geom?.coordinates);
  return found;
}

/** Linear interpolate between two hex colors (#rrggbb) at t∈[0,1]. */
function lerpColor(a: string, b: string, t: number): string {
  const pa = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(a);
  const pb = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(b);
  if (!pa || !pb) return b;
  const c = (i: number) => Math.round(parseInt(pa[i], 16) + (parseInt(pb[i], 16) - parseInt(pa[i], 16)) * t);
  return `rgb(${c(1)}, ${c(2)}, ${c(3)})`;
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

export function GeoJsonMap({ geojson, width = 640, height = 360, rasterUrl, layers }: GeoJsonMapProps) {
  const features = useMemo(() => collectFeatures(geojson), [geojson]);
  const activeLayers = useMemo(() => (layers || []).filter((l) => l.enabled !== false), [layers]);

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
    // Fill a flexible-height host (e.g. a drag-resizable canvas region) while
    // never collapsing standalone: `minHeight` falls back to the surface's
    // intrinsic default (`height`, an inherent layout dim) when no definite
    // parent height is imposed.
    return (
      <div style={{ width: '100%', maxWidth: '100%', height: '100%', minHeight: height, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, background: tokens.colorNeutralBackground3 }}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No coordinates to plot.</Caption1>
      </div>
    );
  }

  const stroke = tokens.colorBrandStroke1;
  const fill = tokens.colorBrandBackground2;

  return (
    // Column flex so the SVG and caption share whatever height the host gives
    // us: `height:100%` lets a drag-resizable canvas region (geo-editors'
    // ResizableCanvasRegion) drive the height, while `minHeight` floors the
    // box at the surface's intrinsic default (`height`, an inherent layout
    // dim) so it never collapses when used standalone. The viewBox/projection
    // are unchanged — `preserveAspectRatio` just scales the same drawing into
    // the resized box (uniform, centered; no geometry change).
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', maxWidth: '100%', minWidth: 0, height: '100%', minHeight: height }}>
      <svg
        width="100%" height="100%" viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img" aria-label="GeoJSON map"
        style={{ flex: '1 1 0', minHeight: 0, width: '100%', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, background: rasterUrl ? 'transparent' : tokens.colorNeutralBackground3, display: 'block' }}
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
        {/* Layered rendering (point/heatmap/cluster/choropleth) — drawn when
            the caller supplies `layers`. Each enabled layer renders over the
            same projection. Falls through to the legacy vector overlay below
            when no layers are provided (back-compat). */}
        {activeLayers.map((layer) => {
          const radius = layer.radius ?? (layer.type === 'heatmap' ? 26 : layer.type === 'cluster' ? 10 : 5);
          const colorLow = layer.colorLow ?? '#2a6df4';
          const colorHigh = layer.colorHigh ?? '#e23c3c';
          // Value range across features for color/size scaling.
          let minW = Infinity, maxW = -Infinity;
          for (const f of features) { const w = weightOf(f, layer.weightProp); if (w < minW) minW = w; if (w > maxW) maxW = w; }
          const span = maxW - minW;
          const norm = (w: number) => (span > 1e-9 ? (w - minW) / span : 0.5);

          if (layer.type === 'heatmap') {
            const gid = `heat-${layer.id}`;
            return (
              <g key={layer.id}>
                <defs>
                  <radialGradient id={gid}>
                    <stop offset="0%" stopColor={colorHigh} stopOpacity={0.55} />
                    <stop offset="60%" stopColor={colorLow} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={colorLow} stopOpacity={0} />
                  </radialGradient>
                </defs>
                {features.map((f, fi) => {
                  const c = firstCoord(f.geometry); if (!c) return null;
                  const [x, y] = project(c[0], c[1]);
                  const r = radius * (0.6 + 0.8 * norm(weightOf(f, layer.weightProp)));
                  return <circle key={fi} cx={x} cy={y} r={r} fill={`url(#${gid})`} />;
                })}
              </g>
            );
          }

          if (layer.type === 'cluster') {
            return (
              <g key={layer.id}>
                {features.map((f, fi) => {
                  const c = firstCoord(f.geometry); if (!c) return null;
                  const [x, y] = project(c[0], c[1]);
                  const w = weightOf(f, layer.weightProp);
                  const r = radius * (0.7 + 1.1 * norm(w));
                  return (
                    <g key={fi}>
                      <circle cx={x} cy={y} r={r} fill={colorLow} fillOpacity={0.45} stroke={colorHigh} strokeWidth={1.25} />
                      <text x={x} y={y + 4} fontSize={11} textAnchor="middle" fill={tokens.colorNeutralForeground1}>{Math.round(w)}</text>
                    </g>
                  );
                })}
              </g>
            );
          }

          if (layer.type === 'choropleth') {
            return (
              <g key={layer.id}>
                {features.map((f, fi) => {
                  const geom = f.geometry; if (!geom) return null;
                  const t = norm(weightOf(f, layer.weightProp));
                  const col = lerpColor(colorLow, colorHigh, t);
                  const drawRing = (ring: number[][], key: string) => {
                    const pts = ring.map(([lon, lat]) => project(lon, lat).join(',')).join(' ');
                    return <polygon key={key} points={pts} fill={col} fillOpacity={0.55} stroke={stroke} strokeWidth={1} />;
                  };
                  if (geom.type === 'Polygon') return <g key={fi}>{geom.coordinates.map((r: number[][], i: number) => drawRing(r, `${fi}-${i}`))}</g>;
                  if (geom.type === 'MultiPolygon') return <g key={fi}>{geom.coordinates.flatMap((p: number[][][], pi: number) => p.map((r, ri) => drawRing(r, `${fi}-${pi}-${ri}`)))}</g>;
                  // Non-polygon features in a choropleth fall back to a colored dot.
                  const c = firstCoord(geom); if (!c) return null;
                  const [x, y] = project(c[0], c[1]);
                  return <circle key={fi} cx={x} cy={y} r={radius + 2} fill={col} fillOpacity={0.7} stroke={stroke} strokeWidth={1} />;
                })}
              </g>
            );
          }

          // point layer — value-colored markers.
          return (
            <g key={layer.id}>
              {features.map((f, fi) => {
                const c = firstCoord(f.geometry); if (!c) return null;
                const [x, y] = project(c[0], c[1]);
                const col = layer.weightProp ? lerpColor(colorLow, colorHigh, norm(weightOf(f, layer.weightProp))) : stroke;
                const name = f.properties?.name || f.properties?.title || f.properties?.label;
                return (
                  <g key={fi}>
                    <circle cx={x} cy={y} r={radius} fill={col} stroke={tokens.colorNeutralBackground1} strokeWidth={1.25} />
                    {name && <text x={x + radius + 3} y={y + 4} fontSize={11} fill={tokens.colorNeutralForeground1}>{String(name)}</text>}
                  </g>
                );
              })}
            </g>
          );
        })}
        {activeLayers.length === 0 && features.map((f, fi) => {
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
