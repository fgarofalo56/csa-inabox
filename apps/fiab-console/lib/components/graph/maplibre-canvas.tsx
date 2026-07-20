'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * MapLibreCanvas — the OSS MapLibre GL (BSD-3) renderer for the GCC-High /
 * sovereign map path (LOOM_MAPS_BACKEND=maplibre). It is the drop-in twin of
 * `AzureMapsCanvas`: it renders the SAME bound GeoJSON (built from the real
 * `/query` aggregate rows) as circle / heatmap / clustered / fill layers, with
 * pan / zoom, field-driven hover popups, a legend, and camera auto-fit — but over
 * the self-hosted `tileserver-gl` basemap instead of atlas.microsoft.com.
 *
 * ── sovereign / no-fabric-dependency ─────────────────────────────────────────
 * The MapLibre GL JS + CSS and the vector-tile style are ALL loaded from the
 * Console-relative proxy (`/api/maps/tiles/*`, resolved server-side to the in-VNet
 * tile server) — NO external CDN, no atlas / Fabric / Power BI host. Fully Gov-safe.
 * The map footer carries the OSS OpenStreetMap (ODbL) attribution the style ships.
 *
 * ── web3-ui.md ───────────────────────────────────────────────────────────────
 * Fluent v9 + Loom tokens for all chrome (legend card, overlays); concrete hex
 * only inside the GL data-viz marks (GL cannot resolve CSS variables). The canvas
 * is height-bounded so it never overflows its host.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Body1, Caption1, Spinner, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Warning20Regular } from '@fluentui/react-icons';
import { GeoJsonMap, type MapLayer } from './geojson-map';

type MapLibre = any;

// ── one-time MapLibre GL JS + CSS load from the in-VNet proxy (no CDN) ─────────

let glPromise: Promise<MapLibre> | null = null;

/** Inject the proxied MapLibre GL CSS + JS once and resolve `window.maplibregl`. */
function loadMapLibre(jsUrl: string, cssUrl: string): Promise<MapLibre> {
  if (typeof window === 'undefined') return Promise.reject(new Error('MapLibre GL needs a browser'));
  const present = (window as any).maplibregl;
  if (present) return Promise.resolve(present);
  if (glPromise) return glPromise;
  glPromise = new Promise<MapLibre>((resolve, reject) => {
    if (!document.getElementById('loom-maplibre-css')) {
      const link = document.createElement('link');
      link.id = 'loom-maplibre-css';
      link.rel = 'stylesheet';
      link.href = cssUrl;
      document.head.appendChild(link);
    }
    let script = document.getElementById('loom-maplibre-js') as HTMLScriptElement | null;
    const done = () => {
      const gl = (window as any).maplibregl;
      gl ? resolve(gl) : reject(new Error('MapLibre GL loaded but window.maplibregl is missing'));
    };
    if (script) {
      if ((window as any).maplibregl) { done(); return; }
      script.addEventListener('load', done);
      script.addEventListener('error', () => { glPromise = null; reject(new Error('Failed to load MapLibre GL JS')); });
      return;
    }
    script = document.createElement('script');
    script.id = 'loom-maplibre-js';
    script.src = jsUrl;
    script.async = true;
    script.addEventListener('load', done);
    script.addEventListener('error', () => { glPromise = null; reject(new Error('Failed to load MapLibre GL JS from the tile server')); });
    document.head.appendChild(script);
  });
  return glPromise;
}

// ── color helpers (concrete hex — GL can't resolve CSS variables) ─────────────

const RAMP_LO = '#cfe4fa';
const RAMP_HI = '#0f6cbd';
const CLUSTER_STEPS = ['#0f6cbd', '#5c2e91', '#a4262c'];

// ── geojson helpers (mirror azure-maps-canvas) ────────────────────────────────

function collectFeatures(g: any): any[] {
  if (!g) return [];
  if (g.type === 'FeatureCollection' && Array.isArray(g.features)) return g.features;
  if (g.type === 'Feature') return [g];
  if (g.type && g.coordinates) return [{ type: 'Feature', geometry: g, properties: {} }];
  return [];
}
function isPointGeom(t?: string): boolean { return t === 'Point' || t === 'MultiPoint'; }
function isPolyGeom(t?: string): boolean { return t === 'Polygon' || t === 'MultiPolygon'; }

function weightExtent(features: any[], prop?: string): { min: number; max: number } {
  if (!prop) return { min: 0, max: 0 };
  let min = Infinity, max = -Infinity;
  for (const f of features) {
    const raw = f?.properties?.[prop];
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n)) { if (n < min) min = n; if (n > max) max = n; }
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0 };
  return { min, max };
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return String(Math.round(n * 100) / 100);
}

// ── styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, width: '100%', minWidth: 0 },
  canvasWrap: {
    position: 'relative', width: '100%', minWidth: 0,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground2,
    boxShadow: tokens.shadow4,
  },
  canvas: { width: '100%', height: '100%' },
  overlay: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground1,
    zIndex: 1,
  },
  overlayBox: {
    maxWidth: '460px', padding: tokens.spacingHorizontalL, textAlign: 'center',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
  },
  legend: {
    position: 'absolute',
    insetBlockEnd: tokens.spacingVerticalM,
    insetInlineEnd: tokens.spacingHorizontalM,
    zIndex: 2, maxWidth: '240px',
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow8,
  },
  legendRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  rampBar: { flex: 1, height: '10px', minWidth: '80px', borderRadius: tokens.borderRadiusSmall, border: `1px solid ${tokens.colorNeutralStroke3}` },
  swatch: { width: '12px', height: '12px', borderRadius: tokens.borderRadiusCircular, display: 'inline-block', flexShrink: 0 },
});

// ── public props ────────────────────────────────────────────────────────────

export interface MapLibreCanvasProps {
  /** The proxied MapLibre style.json URL (`/api/maps/tiles/style.json`). */
  styleUrl: string;
  /** The proxied MapLibre GL JS + CSS URLs (served by the tile server, in-VNet). */
  glJsUrl: string;
  glCssUrl: string;
  /** Parsed GeoJSON (FeatureCollection / Feature / Geometry). */
  geojson: unknown;
  /** Per-layer render config (point / heatmap / cluster / choropleth). */
  layers: MapLayer[];
  /** Canvas height in px (height-bounded so it never overflows). */
  height?: number;
}

// ── component ─────────────────────────────────────────────────────────────────

export function MapLibreCanvas(props: MapLibreCanvasProps): ReactElement {
  const { styleUrl, glJsUrl, glCssUrl, geojson, layers, height = 460 } = props;
  const s = useStyles();

  const [ready, setReady] = useState(false);
  const [mapErr, setMapErr] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const popupRef = useRef<MapLibre | null>(null);
  const addedSourcesRef = useRef<string[]>([]);
  const addedLayersRef = useRef<string[]>([]);

  const features = useMemo(() => collectFeatures(geojson), [geojson]);

  // ── 1. init the MapLibre map once ────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let disposed = false;
    setMapErr(null);
    setReady(false);
    loadMapLibre(glJsUrl, glCssUrl)
      .then((gl: MapLibre) => {
        if (disposed || !containerRef.current) return;
        const map = new gl.Map({
          container: containerRef.current,
          style: styleUrl,
          center: [-98, 39], // CONUS default; auto-fit replaces this once data draws
          zoom: 3,
          attributionControl: true,
        });
        mapRef.current = map;
        popupRef.current = new gl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
        map.on('load', () => { if (!disposed) setReady(true); });
        map.on('error', (e: any) => { if (!disposed && e?.error) setMapErr(e.error.message || 'MapLibre render error'); });
        try { map.addControl(new gl.NavigationControl({ showCompass: true }), 'top-right'); } catch { /* nicety */ }
      })
      .catch((e: any) => { if (!disposed) setMapErr(e?.message || String(e)); });
    return () => {
      disposed = true;
      if (mapRef.current) { try { mapRef.current.remove(); } catch { /* noop */ } mapRef.current = null; }
      addedSourcesRef.current = [];
      addedLayersRef.current = [];
      popupRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl, glJsUrl, glCssUrl]);

  // ── 2. (re)draw data layers whenever ready / data / layers change ─────────────
  const drawSig = useMemo(() => JSON.stringify({ f: features.length, g: features, l: layers }), [features, layers]);
  useEffect(() => {
    const map = mapRef.current;
    const gl: MapLibre = (typeof window !== 'undefined' ? (window as any).maplibregl : null);
    if (!ready || !map || !gl) return;

    // Clear prior layers + sources.
    for (const id of addedLayersRef.current) { try { if (map.getLayer(id)) map.removeLayer(id); } catch { /* noop */ } }
    for (const id of addedSourcesRef.current) { try { if (map.getSource(id)) map.removeSource(id); } catch { /* noop */ } }
    addedLayersRef.current = [];
    addedSourcesRef.current = [];

    const allPoints: any[] = [];
    const active = (layers || []).filter((l) => l.enabled !== false);
    for (const layer of active) {
      const ext = weightExtent(features, layer.weightProp);
      const hasRamp = !!layer.weightProp && ext.max > ext.min;
      const lo = layer.colorLow || RAMP_LO;
      const hi = layer.colorHigh || RAMP_HI;
      const opacity = layer.opacity != null ? layer.opacity : (layer.type === 'choropleth' ? 0.7 : 0.85);
      const minzoom = layer.minZoom != null ? { minzoom: layer.minZoom } : {};
      const maxzoom = layer.maxZoom != null ? { maxzoom: layer.maxZoom } : {};

      if (layer.type === 'choropleth') {
        const polys = features.filter((f) => isPolyGeom(f?.geometry?.type));
        if (polys.length === 0) continue;
        const srcId = `${layer.id}-src`;
        map.addSource(srcId, { type: 'geojson', data: { type: 'FeatureCollection', features: polys } });
        addedSourcesRef.current.push(srcId);
        const fillColor = hasRamp
          ? ['interpolate', ['linear'], ['to-number', ['get', layer.weightProp]], ext.min, lo, ext.max, hi]
          : (layer.color || hi);
        const fillId = `${layer.id}-fill`;
        const lineId = `${layer.id}-line`;
        map.addLayer({ id: fillId, type: 'fill', source: srcId, paint: { 'fill-color': fillColor as any, 'fill-opacity': opacity }, ...minzoom, ...maxzoom });
        map.addLayer({ id: lineId, type: 'line', source: srcId, paint: { 'line-color': layer.colorHigh || '#ffffff', 'line-width': 1 }, ...minzoom, ...maxzoom });
        addedLayersRef.current.push(fillId, lineId);
        attachPopup(map, fillId, popupRef, layer.tooltipFields);
        continue;
      }

      const pts = features.filter((f) => isPointGeom(f?.geometry?.type));
      if (pts.length === 0) continue;
      allPoints.push(...pts);

      if (layer.type === 'cluster') {
        const srcId = `${layer.id}-src`;
        map.addSource(srcId, { type: 'geojson', data: { type: 'FeatureCollection', features: pts }, cluster: true, clusterRadius: 45, clusterMaxZoom: 15 });
        addedSourcesRef.current.push(srcId);
        const clusterId = `${layer.id}-cluster`;
        const countId = `${layer.id}-count`;
        const ptId = `${layer.id}-pt`;
        map.addLayer({
          id: clusterId, type: 'circle', source: srcId, filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 16, 25, 22, 100, 30],
            'circle-color': ['step', ['get', 'point_count'], CLUSTER_STEPS[0], 25, CLUSTER_STEPS[1], 100, CLUSTER_STEPS[2]],
            'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-opacity': opacity,
          },
        });
        map.addLayer({
          id: countId, type: 'symbol', source: srcId, filter: ['has', 'point_count'],
          layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12 },
          paint: { 'text-color': '#ffffff' },
        });
        map.addLayer({
          id: ptId, type: 'circle', source: srcId, filter: ['!', ['has', 'point_count']],
          paint: { 'circle-radius': layer.radius || 8, 'circle-color': layer.color || hi, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1, 'circle-opacity': opacity },
        });
        addedLayersRef.current.push(clusterId, countId, ptId);
        attachPopup(map, ptId, popupRef, layer.tooltipFields);
        continue;
      }

      const srcId = `${layer.id}-src`;
      map.addSource(srcId, { type: 'geojson', data: { type: 'FeatureCollection', features: pts } });
      addedSourcesRef.current.push(srcId);

      if (layer.type === 'heatmap') {
        const heatId = `${layer.id}-heat`;
        map.addLayer({
          id: heatId, type: 'heatmap', source: srcId,
          paint: {
            'heatmap-weight': layer.weightProp ? ['to-number', ['get', layer.weightProp]] as any : 1,
            'heatmap-radius': layer.radius || 26,
            'heatmap-opacity': opacity,
            'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.2, lo, 1, hi],
          },
          ...minzoom, ...maxzoom,
        });
        addedLayersRef.current.push(heatId);
        continue;
      }

      // point — circle layer (+ value-driven radius/color ramp)
      const bubbleId = `${layer.id}-bubble`;
      const radius = (layer.sizeByMetric && hasRamp)
        ? ['interpolate', ['linear'], ['to-number', ['get', layer.weightProp]], ext.min, layer.sizeMin || 6, ext.max, layer.sizeMax || 28]
        : (layer.radius || 7);
      const color = hasRamp
        ? ['interpolate', ['linear'], ['to-number', ['get', layer.weightProp]], ext.min, lo, ext.max, hi]
        : (layer.color || hi);
      map.addLayer({
        id: bubbleId, type: 'circle', source: srcId,
        paint: { 'circle-radius': radius as any, 'circle-color': color as any, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1, 'circle-opacity': opacity },
        ...minzoom, ...maxzoom,
      });
      addedLayersRef.current.push(bubbleId);
      attachPopup(map, bubbleId, popupRef, layer.tooltipFields);
    }

    // Auto-fit to the data.
    fitToFeatures(map, allPoints.length ? allPoints : features);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, drawSig]);

  // ── derived legend model (mirrors azure-maps-canvas) ──────────────────────────
  const legend = useMemo(() => {
    const rows: Array<{ id: string; label: string; ramp?: [string, string]; range?: [number, number]; swatch?: string }> = [];
    for (const layer of (layers || []).filter((l) => l.enabled !== false)) {
      const ext = weightExtent(features, layer.weightProp);
      const lo = layer.colorLow || RAMP_LO;
      const hi = layer.colorHigh || RAMP_HI;
      const name = `${layer.type[0].toUpperCase()}${layer.type.slice(1)}${layer.weightProp ? ` · ${layer.weightProp}` : ''}`;
      if (layer.weightProp && ext.max > ext.min) rows.push({ id: layer.id, label: name, ramp: [lo, hi], range: [ext.min, ext.max] });
      else rows.push({ id: layer.id, label: name, swatch: layer.color || hi });
    }
    return rows;
  }, [layers, features]);

  return (
    <div className={s.root}>
      <div className={s.canvasWrap} style={{ height }}>
        <div ref={containerRef} className={s.canvas} />
        {!ready && !mapErr && (
          <div className={s.overlay}><Spinner size="tiny" /> <Body1>Loading map…</Body1></div>
        )}
        {mapErr && (
          <div className={s.overlay}>
            <div className={s.overlayBox}>
              <Warning20Regular />
              <Body1>Map failed to load</Body1>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{mapErr}</Caption1>
              {/* Honest fallback — the bound features still render on the offline SVG overlay. */}
              <GeoJsonMap geojson={geojson} layers={layers} height={Math.max(160, height - 120)} />
            </div>
          </div>
        )}
        {ready && legend.length > 0 && (
          <div className={s.legend}>
            <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Legend</Caption1>
            {legend.slice(0, 5).map((row) => (
              <div key={row.id} className={s.legendRow}>
                {row.ramp
                  ? <span className={s.rampBar} style={{ background: `linear-gradient(90deg, ${row.ramp[0]}, ${row.ramp[1]})` }} />
                  : <span className={s.swatch} style={{ backgroundColor: row.swatch }} />}
                <Caption1 style={{ color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row.label}{row.range ? ` (${fmtNum(row.range[0])}–${fmtNum(row.range[1])})` : ''}
                </Caption1>
              </div>
            ))}
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              <Badge appearance="tint" color="brand" size="extra-small">MapLibre · OSS</Badge>
            </Caption1>
          </div>
        )}
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Hover popup surfacing the chosen tooltip fields (or all props). */
function attachPopup(map: MapLibre, layerId: string, popupRef: { current: MapLibre | null }, fields?: string[]) {
  try {
    const show = (e: any) => {
      const f = e?.features?.[0];
      const props = f?.properties;
      if (!props || !popupRef.current) return;
      const keys = (fields && fields.length) ? fields : Object.keys(props).filter((k) => !k.startsWith('_') && props[k] != null).slice(0, 6);
      const title = props.name ?? props.title ?? props.label ?? '';
      const rows = keys
        .filter((k) => props[k] != null && k !== 'name' && k !== 'title' && k !== 'label')
        .map((k) => `<div style="opacity:.85"><span style="opacity:.7">${escapeHtml(k)}:</span> ${escapeHtml(String(props[k]))}</div>`).join('');
      const titleHtml = title ? `<strong>${escapeHtml(String(title))}</strong>` : '';
      popupRef.current
        .setLngLat(e.lngLat)
        .setHTML(`<div style="padding:8px 12px;font:13px/1.4 'Segoe UI',sans-serif;max-width:260px">${titleHtml}${rows}</div>`)
        .addTo(map);
    };
    map.on('mousemove', layerId, show);
    map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; try { popupRef.current?.remove(); } catch { /* noop */ } });
  } catch { /* popups are a nicety; never block the render */ }
}

/** Fit the camera to the bounding box of the supplied features. */
function fitToFeatures(map: MapLibre, features: any[]) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const visit = (coords: any) => {
    if (typeof coords[0] === 'number') {
      const [lon, lat] = coords;
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      }
    } else if (Array.isArray(coords)) { for (const c of coords) visit(c); }
  };
  for (const f of features) { if (f?.geometry?.coordinates) visit(f.geometry.coordinates); }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return;
  try {
    if (minLon === maxLon && minLat === maxLat) {
      map.easeTo({ center: [minLon, minLat], zoom: 6 });
    } else {
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 60, duration: 300 });
    }
  } catch { /* noop */ }
}

export default MapLibreCanvas;
