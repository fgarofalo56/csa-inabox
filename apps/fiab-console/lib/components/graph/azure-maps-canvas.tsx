'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * AzureMapsCanvas — the shared, REAL interactive Azure Maps Web SDK surface for
 * the Fabric-IQ `map` editor (and any future geospatial surface). It is the
 * parity unlock called out in `docs/fiab/parity/map.md`: the `map` editor used
 * to render a static SVG (`GeoJsonMap`); this lifts the proven interactive
 * harness out of `report/map-visual.tsx` into a reusable component that renders
 * the SAME bound GeoJSON as live `BubbleLayer` / `SymbolLayer` / `HeatMapLayer`
 * / `PolygonLayer` / clustered layers with pan / zoom / rotate / pitch,
 * basemap-style switching, built-in map controls, field-driven hover + click
 * popups, a legend, and persisted camera view.
 *
 * ── Azure-native, no Fabric (no-fabric-dependency.md) ────────────────────────
 * The interactive SDK is loaded once at runtime from the Azure-native CDN
 * (atlas.microsoft.com); auth is brokered by the `tokenUrl` BFF route
 * (`/api/items/map/[id]/map-token`) which mints an Entra (AAD) token scoped to
 * the atlas data-plane ALONE, or returns a subscription key. No host other than
 * atlas.microsoft.com is ever contacted — never api.fabric / api.powerbi.
 *
 * ── no-vaporware (honest gate + offline fallback) ────────────────────────────
 * When the token route gates (LOOM_MAPS_BACKEND unset / no credential) AND no
 * client-side `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` is present, this renders an
 * honest Fluent MessageBar naming the exact env var + bicep module, WITH the
 * offline SVG `GeoJsonMap` overlay still drawing the bound features beneath it —
 * the surface is never blank and the data is never hidden.
 *
 * ── web3-ui.md ───────────────────────────────────────────────────────────────
 * Fluent v9 + Loom design tokens for all chrome (legend card, overlays, gate);
 * raw px / concrete hex only inside the SDK geometry + data-viz marks the Azure
 * Maps SDK owns (it cannot resolve CSS variables). The canvas is height-bounded
 * so it never overflows its host.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Body1, Caption1, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Warning20Regular } from '@fluentui/react-icons';
import { GeoJsonMap, type MapLayer } from './geojson-map';

// ── Azure Maps Web SDK (atlas) — loaded from the Azure-native CDN ─────────────
// Loaded once at runtime (shared script/css ids with report/map-visual.tsx so a
// page mounting both shares a single SDK load). Typed loosely as `any` — the CDN
// build ships no types here; all atlas usage is client-only (inside effects), so
// SSR never touches `window`.

type Atlas = any;

const ATLAS_VERSION = '3';
const ATLAS_JS = `https://atlas.microsoft.com/sdk/javascript/mapcontrol/${ATLAS_VERSION}/atlas.min.js`;
const ATLAS_CSS = `https://atlas.microsoft.com/sdk/javascript/mapcontrol/${ATLAS_VERSION}/atlas.min.css`;

let atlasPromise: Promise<Atlas> | null = null;

/** Inject the atlas CSS + JS once and resolve with `window.atlas`. */
function loadAtlas(): Promise<Atlas> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Azure Maps SDK needs a browser'));
  const present = (window as any).atlas;
  if (present) return Promise.resolve(present);
  if (atlasPromise) return atlasPromise;
  atlasPromise = new Promise<Atlas>((resolve, reject) => {
    if (!document.getElementById('loom-atlas-css')) {
      const link = document.createElement('link');
      link.id = 'loom-atlas-css';
      link.rel = 'stylesheet';
      link.href = ATLAS_CSS;
      document.head.appendChild(link);
    }
    let script = document.getElementById('loom-atlas-js') as HTMLScriptElement | null;
    if (script) {
      if ((window as any).atlas) { resolve((window as any).atlas); return; }
      script.addEventListener('load', () => {
        const a = (window as any).atlas;
        a ? resolve(a) : reject(new Error('Azure Maps SDK loaded but window.atlas is missing'));
      });
      script.addEventListener('error', () => { atlasPromise = null; reject(new Error('Failed to load the Azure Maps Web SDK')); });
      return;
    }
    script = document.createElement('script');
    script.id = 'loom-atlas-js';
    script.src = ATLAS_JS;
    script.async = true;
    script.addEventListener('load', () => {
      const a = (window as any).atlas;
      a ? resolve(a) : reject(new Error('Azure Maps SDK loaded but window.atlas is missing'));
    });
    script.addEventListener('error', () => { atlasPromise = null; reject(new Error('Failed to load the Azure Maps Web SDK from the CDN')); });
    document.head.appendChild(script);
  });
  return atlasPromise;
}

// ── basemap styles (parity: the 10 atlas styles, live-switchable) ─────────────

export interface BasemapStyleOption { value: string; label: string }
export const AZURE_MAPS_STYLES: BasemapStyleOption[] = [
  { value: 'road', label: 'Road' },
  { value: 'road_shaded_relief', label: 'Road (shaded relief)' },
  { value: 'grayscale_light', label: 'Grayscale light' },
  { value: 'grayscale_dark', label: 'Grayscale dark' },
  { value: 'night', label: 'Night' },
  { value: 'high_contrast_light', label: 'High contrast light' },
  { value: 'high_contrast_dark', label: 'High contrast dark' },
  { value: 'satellite', label: 'Satellite (aerial)' },
  { value: 'satellite_road_labels', label: 'Satellite + roads' },
  { value: 'blank', label: 'Blank' },
];
export const DEFAULT_BASEMAP = 'road_shaded_relief';

// ── persisted camera view + controls ──────────────────────────────────────────

export interface AzureMapsView {
  /** [lon, lat] camera center. */
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  /** When true the camera auto-fits to the bound data (pans are not persisted). */
  autoZoom?: boolean;
}

export interface AzureMapsControls {
  zoom?: boolean;
  compass?: boolean;
  pitch?: boolean;
  scale?: boolean;
}
export const DEFAULT_CONTROLS: AzureMapsControls = { zoom: true, compass: true, pitch: true, scale: true };

// ── token contract (mirrors maps-client.resolveMapsBackend / the BFF route) ───

type MapAuth =
  | { mode: 'aad'; token: string; clientId: string; expiresOn?: number }
  | { mode: 'key'; key: string };

type TokenState =
  | { kind: 'loading' }
  | { kind: 'ok'; auth: MapAuth }
  | { kind: 'gate'; error?: string; envVar?: string; bicep?: string }
  | { kind: 'error'; message: string };

const MAPS_ENV = 'LOOM_MAPS_BACKEND';
const MAPS_BICEP = 'platform/fiab/bicep/modules/landing-zone/azure-maps.bicep';

// ── color helpers (concrete hex — the SDK can't resolve CSS variables) ────────

const RAMP_LO = '#cfe4fa';
const RAMP_HI = '#0f6cbd';
const CLUSTER_STEPS = ['#0f6cbd', '#5c2e91', '#a4262c'];

function parseHex(h: string): [number, number, number] {
  const s = h.replace('#', '');
  if (s.length === 3) {
    return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
  }
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function lerpHex(a: string, b: string, t: number): string {
  const pa = parseHex(a), pb = parseHex(b);
  const ch = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * Math.max(0, Math.min(1, t)));
  return `#${[ch(0), ch(1), ch(2)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

// ── geojson helpers ───────────────────────────────────────────────────────────

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

/** Field names a feature exposes (for the default tooltip + the field picker). */
export function featurePropertyKeys(geojson: unknown): string[] {
  const keys = new Set<string>();
  for (const f of collectFeatures(geojson)) {
    const p = f?.properties || {};
    for (const k of Object.keys(p)) keys.add(k);
  }
  return Array.from(keys);
}

// ── styles ─────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    width: '100%', minWidth: 0,
  },
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
    zIndex: 2,
    maxWidth: '240px',
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow8,
  },
  legendRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  rampBar: {
    flex: 1, height: '10px', minWidth: '80px',
    borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  swatch: {
    width: '12px', height: '12px', borderRadius: tokens.borderRadiusCircular,
    display: 'inline-block', flexShrink: 0,
  },
  gate: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
});

// ── public props ─────────────────────────────────────────────────────────────

export interface AzureMapsCanvasProps {
  /** BFF token route, e.g. `/api/items/map/<id>/map-token`. */
  tokenUrl: string;
  /** Client-side subscription key fallback (NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY). */
  fallbackSubscriptionKey?: string;
  /** Parsed GeoJSON (FeatureCollection / Feature / Geometry). */
  geojson: unknown;
  /** Per-layer render config (point / heatmap / cluster / choropleth). */
  layers: MapLayer[];
  /** Basemap style id (one of AZURE_MAPS_STYLES). */
  style?: string;
  /** Built-in map controls to show. */
  controls?: AzureMapsControls;
  /** Persisted camera view. */
  view?: AzureMapsView;
  /** Emitted when the user moves the camera (only when autoZoom is off). */
  onViewChange?: (v: AzureMapsView) => void;
  /** Canvas height in px (height-bounded so it never overflows). */
  height?: number;
}

// ── component ─────────────────────────────────────────────────────────────────

export function AzureMapsCanvas(props: AzureMapsCanvasProps): ReactElement {
  const {
    tokenUrl, fallbackSubscriptionKey, geojson, layers,
    style = DEFAULT_BASEMAP, controls = DEFAULT_CONTROLS,
    view, onViewChange, height = 460,
  } = props;
  const s = useStyles();

  const [token, setToken] = useState<TokenState>({ kind: 'loading' });
  const [ready, setReady] = useState(false);
  const [mapErr, setMapErr] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Atlas | null>(null);
  const sourcesRef = useRef<Atlas[]>([]);
  const layerIdsRef = useRef<string[]>([]);
  const popupRef = useRef<Atlas | null>(null);
  const controlsRef = useRef<Atlas[]>([]);

  // Mirror the latest view in a ref so the init effect can apply the persisted
  // camera that's known at init time (which lands after item-state load),
  // without our own onViewChange emits re-applying it and fighting the user.
  const viewRef = useRef<AzureMapsView | undefined>(view);
  viewRef.current = view;
  const autoZoomRef = useRef<boolean>(view?.autoZoom !== false);
  autoZoomRef.current = view?.autoZoom !== false;
  const suppressEmitUntil = useRef(0);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  const features = useMemo(() => collectFeatures(geojson), [geojson]);

  // ── 1. fetch the map token / honest gate ─────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setToken({ kind: 'loading' });
    (async () => {
      try {
        const r = await fetch(tokenUrl);
        let j: any = {};
        try { j = await r.json(); } catch { j = {}; }
        if (!alive) return;
        if (r.ok && j?.ok && (j.mode === 'aad' || j.mode === 'key')) {
          setToken({ kind: 'ok', auth: j as MapAuth });
          return;
        }
        // Gate / error — fall back to a client-side subscription key if present,
        // else the honest gate (the offline SVG still renders beneath it).
        if (fallbackSubscriptionKey) {
          setToken({ kind: 'ok', auth: { mode: 'key', key: fallbackSubscriptionKey } });
          return;
        }
        if (r.status === 412 || (j && j.ok === false)) {
          setToken({ kind: 'gate', error: j?.error, envVar: j?.envVar || MAPS_ENV, bicep: j?.bicep || MAPS_BICEP });
          return;
        }
        setToken({ kind: 'error', message: (j && (j.error || j.message)) || `HTTP ${r.status}` });
      } catch (e: any) {
        if (!alive) return;
        if (fallbackSubscriptionKey) { setToken({ kind: 'ok', auth: { mode: 'key', key: fallbackSubscriptionKey } }); return; }
        setToken({ kind: 'error', message: e?.message || String(e) });
      }
    })();
    return () => { alive = false; };
  }, [tokenUrl, fallbackSubscriptionKey]);

  // ── 2. init the atlas map once auth is OK ────────────────────────────────────
  useEffect(() => {
    if (token.kind !== 'ok' || !containerRef.current || mapRef.current) return;
    const auth = token.auth;
    let disposed = false;
    setMapErr(null);
    setReady(false);
    loadAtlas()
      .then((atlas: Atlas) => {
        if (disposed || !containerRef.current) return;
        const authOptions = auth.mode === 'key'
          ? { authType: 'subscriptionKey', subscriptionKey: auth.key }
          : {
              authType: 'anonymous',
              clientId: auth.clientId,
              getToken: (resolve: (t: string) => void, reject: (e?: any) => void) => {
                fetch(tokenUrl)
                  .then((r) => r.json())
                  .then((j) => (j?.ok && j.token ? resolve(String(j.token)) : reject(new Error('no token'))))
                  .catch(reject);
              },
            };
        const iv = viewRef.current;
        const mapOptions: any = {
          view: 'Auto',
          style,
          showLogo: true,
          showFeedbackLink: false,
          authOptions,
        };
        if (iv && iv.autoZoom === false && iv.center) {
          mapOptions.center = iv.center;
          if (iv.zoom != null) mapOptions.zoom = iv.zoom;
          if (iv.bearing != null) mapOptions.bearing = iv.bearing;
          if (iv.pitch != null) mapOptions.pitch = iv.pitch;
        }
        const map = new atlas.Map(containerRef.current, mapOptions);
        mapRef.current = map;
        map.events.add('ready', () => {
          if (disposed) return;
          // Built-in controls.
          try {
            const ctl: Atlas[] = [];
            if (controls.zoom) ctl.push(new atlas.control.ZoomControl());
            if (controls.compass) ctl.push(new atlas.control.CompassControl());
            if (controls.pitch) ctl.push(new atlas.control.PitchControl());
            if (controls.scale) ctl.push(new atlas.control.ScaleControl());
            if (ctl.length) { map.controls.add(ctl, { position: 'top-right' }); controlsRef.current = ctl; }
          } catch { /* controls are a nicety */ }
          // Persist camera moves (only when not auto-zooming).
          map.events.add('moveend', () => {
            if (disposed || autoZoomRef.current) return;
            if (Date.now() < suppressEmitUntil.current) return;
            try {
              const cam = map.getCamera();
              const c = cam?.center;
              onViewChangeRef.current?.({
                center: Array.isArray(c) ? [Number(c[0]), Number(c[1])] : undefined,
                zoom: cam?.zoom, bearing: cam?.bearing, pitch: cam?.pitch,
                autoZoom: false,
              });
            } catch { /* noop */ }
          });
          setReady(true);
        });
        map.events.add('error', (e: any) => { if (!disposed) setMapErr(e?.error?.message || 'Azure Maps render error'); });
      })
      .catch((e: any) => { if (!disposed) setMapErr(e?.message || String(e)); });
    return () => {
      disposed = true;
      if (mapRef.current) { try { mapRef.current.dispose(); } catch { /* noop */ } mapRef.current = null; }
      sourcesRef.current = [];
      layerIdsRef.current = [];
      controlsRef.current = [];
      popupRef.current = null;
      setReady(false);
    };
    // style/controls intentionally excluded — applied via dedicated effects below
    // so a style/control toggle never tears down + re-inits the whole map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, tokenUrl]);

  // ── 3. live basemap-style switch (no reload) ─────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    try { map.setStyle({ style }); } catch { /* noop */ }
  }, [ready, style]);

  // ── 4. (re)draw the data layers whenever ready / data / layers / style change ─
  const drawSig = useMemo(
    () => JSON.stringify({ f: features.length, g: features, l: layers }),
    [features, layers],
  );
  useEffect(() => {
    const map = mapRef.current;
    const atlas: Atlas = (typeof window !== 'undefined' ? (window as any).atlas : null);
    if (!ready || !map || !atlas) return;

    // Clear prior layers + sources.
    for (const id of layerIdsRef.current) { try { map.layers.remove(id); } catch { /* noop */ } }
    for (const src of sourcesRef.current) { try { map.sources.remove(src); } catch { /* noop */ } }
    layerIdsRef.current = [];
    sourcesRef.current = [];

    const addedLayerIds: string[] = [];
    const allPointFeatures: any[] = [];

    const active = (layers || []).filter((l) => l.enabled !== false);
    for (const layer of active) {
      const ext = weightExtent(features, layer.weightProp);
      const hasRamp = !!layer.weightProp && ext.max > ext.min;
      const lo = layer.colorLow || RAMP_LO;
      const hi = layer.colorHigh || RAMP_HI;
      const opacity = layer.opacity != null ? layer.opacity : (layer.type === 'choropleth' ? 0.7 : 0.85);
      const zoomBand: any = {};
      if (layer.minZoom != null) zoomBand.minZoom = layer.minZoom;
      if (layer.maxZoom != null) zoomBand.maxZoom = layer.maxZoom;

      if (layer.type === 'choropleth') {
        const polys = features.filter((f) => isPolyGeom(f?.geometry?.type));
        if (polys.length === 0) continue;
        const ds = new atlas.source.DataSource();
        map.sources.add(ds);
        sourcesRef.current.push(ds);
        ds.add({ type: 'FeatureCollection', features: polys });
        const fillColor = hasRamp
          ? ['interpolate', ['linear'], ['to-number', ['get', layer.weightProp]], ext.min, lo, ext.max, hi]
          : (layer.color || hi);
        const fillId = `${layer.id}-fill`;
        const lineId = `${layer.id}-line`;
        map.layers.add(new atlas.layer.PolygonLayer(ds, fillId, { fillColor, fillOpacity: opacity, ...zoomBand }));
        map.layers.add(new atlas.layer.LineLayer(ds, lineId, { strokeColor: layer.colorHigh || '#ffffff', strokeWidth: 1, ...zoomBand }));
        addedLayerIds.push(fillId, lineId);
        attachPopup(map, atlas, fillId, popupRef, layer.tooltipFields);
        continue;
      }

      // point geometry layers: point / heatmap / cluster
      const pts = features.filter((f) => isPointGeom(f?.geometry?.type));
      if (pts.length === 0) continue;
      allPointFeatures.push(...pts);

      if (layer.type === 'cluster') {
        const ds = new atlas.source.DataSource(undefined, { cluster: true, clusterRadius: 45, clusterMaxZoom: 15 });
        map.sources.add(ds);
        sourcesRef.current.push(ds);
        ds.add({ type: 'FeatureCollection', features: pts });
        const clusterBubbleId = `${layer.id}-cluster`;
        const clusterCountId = `${layer.id}-count`;
        const unclusteredId = `${layer.id}-pt`;
        const clusterBubble = new atlas.layer.BubbleLayer(ds, clusterBubbleId, {
          radius: ['step', ['get', 'point_count'], 16, 25, 22, 100, 30],
          color: ['step', ['get', 'point_count'], CLUSTER_STEPS[0], 25, CLUSTER_STEPS[1], 100, CLUSTER_STEPS[2]],
          strokeColor: '#ffffff', strokeWidth: 2, opacity, filter: ['has', 'point_count'], ...zoomBand,
        });
        map.layers.add(clusterBubble);
        map.layers.add(new atlas.layer.SymbolLayer(ds, clusterCountId, {
          iconOptions: { image: 'none' },
          textOptions: { textField: ['get', 'point_count_abbreviated'], offset: [0, 0.4], color: '#ffffff', font: ['StandardFont-Bold'], size: 12 },
          filter: ['has', 'point_count'], ...zoomBand,
        }));
        map.layers.add(new atlas.layer.BubbleLayer(ds, unclusteredId, {
          radius: layer.radius || 8, color: layer.color || hi, strokeColor: '#ffffff', strokeWidth: 1, opacity,
          filter: ['!', ['has', 'point_count']], ...zoomBand,
        }));
        addedLayerIds.push(clusterBubbleId, clusterCountId, unclusteredId);
        attachPopup(map, atlas, unclusteredId, popupRef, layer.tooltipFields);
        // Click a cluster → expand it.
        try {
          map.events.add('click', clusterBubble, (e: any) => {
            const shp = e?.shapes?.[0];
            if (!shp?.getProperties || !shp.getProperties().cluster) return;
            ds.getClusterExpansionZoom(shp.getProperties().cluster_id).then((z: number) => {
              map.setCamera({ center: shp.getCoordinates(), zoom: z, type: 'ease', duration: 300 });
            }).catch(() => { /* noop */ });
          });
        } catch { /* noop */ }
        continue;
      }

      const ds = new atlas.source.DataSource();
      map.sources.add(ds);
      sourcesRef.current.push(ds);
      ds.add({ type: 'FeatureCollection', features: pts });

      if (layer.type === 'heatmap') {
        const heatId = `${layer.id}-heat`;
        map.layers.add(new atlas.layer.HeatMapLayer(ds, heatId, {
          weight: layer.weightProp ? ['to-number', ['get', layer.weightProp]] : 1,
          radius: layer.radius || 26,
          intensity: 1,
          opacity,
          color: ['interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(0,0,0,0)', 0.2, lo, 0.6, lerpHex(lo, hi, 0.6), 1, hi],
          ...zoomBand,
        }));
        addedLayerIds.push(heatId);
        continue;
      }

      // point — BubbleLayer (+ optional name labels)
      const bubbleId = `${layer.id}-bubble`;
      const radius = (layer.sizeByMetric && hasRamp)
        ? ['interpolate', ['linear'], ['to-number', ['get', layer.weightProp]], ext.min, layer.sizeMin || 6, ext.max, layer.sizeMax || 28]
        : (layer.radius || 7);
      const color = hasRamp
        ? ['interpolate', ['linear'], ['to-number', ['get', layer.weightProp]], ext.min, lo, ext.max, hi]
        : (layer.color || hi);
      map.layers.add(new atlas.layer.BubbleLayer(ds, bubbleId, {
        radius, color, strokeColor: '#ffffff', strokeWidth: 1, opacity, ...zoomBand,
      }));
      addedLayerIds.push(bubbleId);
      attachPopup(map, atlas, bubbleId, popupRef, layer.tooltipFields);
      // Labels (only if features carry a name/title/label).
      const hasName = pts.some((f) => f?.properties && (f.properties.name ?? f.properties.title ?? f.properties.label) != null);
      if (hasName) {
        const labelId = `${layer.id}-label`;
        map.layers.add(new atlas.layer.SymbolLayer(ds, labelId, {
          iconOptions: { image: 'none' },
          textOptions: {
            textField: ['coalesce', ['get', 'name'], ['get', 'title'], ['get', 'label'], ''],
            offset: [0, 1.4], size: 11,
            color: tokenColor('textOnMap'), haloColor: '#ffffff', haloWidth: 1.5,
          },
          minZoom: layer.minZoom != null ? layer.minZoom : 5,
          ...(layer.maxZoom != null ? { maxZoom: layer.maxZoom } : {}),
        }));
        addedLayerIds.push(labelId);
      }
    }

    layerIdsRef.current = addedLayerIds;

    // Auto-fit the camera to the data (auto-zoom mode, or when no persisted view).
    if (autoZoomRef.current) {
      suppressEmitUntil.current = Date.now() + 800;
      fitToFeatures(map, allPointFeatures.length ? allPointFeatures : features);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, drawSig]);

  // ── derived legend model ─────────────────────────────────────────────────────
  const legend = useMemo(() => {
    const rows: Array<{ id: string; label: string; ramp?: [string, string]; range?: [number, number]; swatch?: string }> = [];
    for (const layer of (layers || []).filter((l) => l.enabled !== false)) {
      const ext = weightExtent(features, layer.weightProp);
      const lo = layer.colorLow || RAMP_LO;
      const hi = layer.colorHigh || RAMP_HI;
      const name = `${layer.type[0].toUpperCase()}${layer.type.slice(1)}${layer.weightProp ? ` · ${layer.weightProp}` : ''}`;
      if (layer.weightProp && ext.max > ext.min) {
        rows.push({ id: layer.id, label: name, ramp: [lo, hi], range: [ext.min, ext.max] });
      } else {
        rows.push({ id: layer.id, label: name, swatch: layer.color || hi });
      }
    }
    return rows;
  }, [layers, features]);

  // ── render ───────────────────────────────────────────────────────────────────
  const showGate = token.kind === 'gate';
  const showInteractive = token.kind === 'loading' || token.kind === 'ok';

  return (
    <div className={s.root}>
      {showGate && (
        <div className={s.gate}>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Interactive Azure Maps not configured</MessageBarTitle>
              The live map uses an Azure-native <strong>Azure Maps</strong> account. Set{' '}
              <code>{token.kind === 'gate' ? token.envVar : MAPS_ENV}=azure-maps</code> with{' '}
              <code>LOOM_AZURE_MAPS_CLIENT_ID</code> (Entra, preferred) or <code>LOOM_AZURE_MAPS_KEY</code>{' '}
              (or a client-side <code>NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY</code>) and deploy{' '}
              <code>{token.kind === 'gate' ? token.bicep : MAPS_BICEP}</code>. No Power BI / Fabric required.
              {token.kind === 'gate' && token.error ? ` (${token.error})` : ''} The bound features render on the
              offline vector overlay below.
            </MessageBarBody>
          </MessageBar>
          <GeoJsonMap geojson={geojson} layers={layers} height={height} />
        </div>
      )}

      {token.kind === 'error' && (
        <div className={s.gate}>
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Map authorization failed</MessageBarTitle>
              {token.message}. The bound features render on the offline vector overlay below.
            </MessageBarBody>
          </MessageBar>
          <GeoJsonMap geojson={geojson} layers={layers} height={height} />
        </div>
      )}

      {showInteractive && (
        <div className={s.canvasWrap} style={{ height }}>
          <div ref={containerRef} className={s.canvas} />
          {token.kind === 'loading' && (
            <div className={s.overlay}><Spinner size="tiny" /> <Body1>Authorizing Azure Maps…</Body1></div>
          )}
          {token.kind === 'ok' && !ready && !mapErr && (
            <div className={s.overlay}><Spinner size="tiny" /> <Body1>Loading map…</Body1></div>
          )}
          {mapErr && (
            <div className={s.overlay}>
              <div className={s.overlayBox}>
                <Warning20Regular />
                <Body1>Map failed to load</Body1>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{mapErr}</Caption1>
              </div>
            </div>
          )}
          {token.kind === 'ok' && ready && legend.length > 0 && (
            <div className={s.legend}>
              <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Legend</Caption1>
              {legend.slice(0, 5).map((row) => (
                <div key={row.id} className={s.legendRow}>
                  {row.ramp ? (
                    <>
                      <span className={s.rampBar} style={{ background: `linear-gradient(90deg, ${row.ramp[0]}, ${row.ramp[1]})` }} />
                    </>
                  ) : (
                    <span className={s.swatch} style={{ backgroundColor: row.swatch }} />
                  )}
                  <Caption1 style={{ color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.label}{row.range ? ` (${fmtNum(row.range[0])}–${fmtNum(row.range[1])})` : ''}
                  </Caption1>
                </div>
              ))}
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                <Badge appearance="tint" color="brand" size="extra-small">Azure Maps</Badge>
              </Caption1>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return String(Math.round(n * 100) / 100);
}

/** Concrete text color for on-map labels (the SDK can't read CSS vars). */
function tokenColor(_role: 'textOnMap'): string { return '#242424'; }

/** Hover + click popup surfacing the chosen tooltip fields (or all props). */
function attachPopup(
  map: Atlas, atlas: Atlas, layerId: string,
  popupRef: { current: Atlas | null }, fields?: string[],
) {
  try {
    if (!popupRef.current) popupRef.current = new atlas.Popup({ closeButton: false, pixelOffset: [0, -10] });
    const popup = popupRef.current;
    const show = (e: any) => {
      const f = e?.shapes?.[0];
      const props = f?.getProperties ? f.getProperties() : f?.properties;
      if (!props) return;
      const keys = (fields && fields.length)
        ? fields
        : Object.keys(props).filter((k) => !k.startsWith('_') && props[k] != null).slice(0, 6);
      const title = props.name ?? props.title ?? props.label ?? '';
      const rows = keys
        .filter((k) => props[k] != null && k !== 'name' && k !== 'title' && k !== 'label')
        .map((k) => `<div style="opacity:.85"><span style="opacity:.7">${escapeHtml(k)}:</span> ${escapeHtml(String(props[k]))}</div>`)
        .join('');
      const titleHtml = title ? `<strong>${escapeHtml(String(title))}</strong>` : '';
      popup.setOptions({
        content: `<div style="padding:8px 12px;font:13px/1.4 'Segoe UI',sans-serif;max-width:260px">${titleHtml}${rows}</div>`,
        position: e.position,
      });
      popup.open(map);
    };
    map.events.add('mousemove', layerId, show);
    map.events.add('click', layerId, show);
    map.events.add('mouseleave', layerId, () => { try { popup.close(); } catch { /* noop */ } });
  } catch { /* popups are a nicety; never block the render */ }
}

/** Fit the camera to the bounding box of the supplied features. */
function fitToFeatures(map: Atlas, features: any[]) {
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
      map.setCamera({ center: [minLon, minLat], zoom: 6 });
    } else {
      map.setCamera({ bounds: [minLon, minLat, maxLon, maxLat], padding: 60 });
    }
  } catch { /* noop */ }
}

export default AzureMapsCanvas;
