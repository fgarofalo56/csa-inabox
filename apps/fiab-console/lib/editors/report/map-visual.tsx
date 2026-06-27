'use client';

/**
 * map-visual — the Power BI "Map" / "Filled map" visual for the Loom-native
 * Report Designer (report-designer wave 5, chunk C).
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 * Wave-0..4 rendered the map well-fold through `MapVisualBody`: an honest
 * Azure-Maps gate (a MessageBar + the aggregated rows as a table) and NOTHING
 * else — there was no real map, because no Azure Maps account is a default
 * deployment dependency. Wave 5 keeps that honest gate but, when Azure Maps IS
 * configured, draws a REAL interactive map over the SAME real `/query` aggregate
 * rows: bubbles for point/size data, a filled choropleth for a Location key. No
 * approximate-shape-with-a-caption, no dead control (no-vaporware.md).
 *
 * ── The two structured modes (no-freeform-config.md) ─────────────────────────
 * A Fluent ToggleButton "pill" picks the mode (structured, not free text):
 *   • Bubbles  — the canonical Power BI map. When numeric Latitude + Longitude
 *     wells are bound each row is a point at (long, lat); the bubble RADIUS is
 *     area-proportional to the Size aggregate (∝ √Size) and the color is a Size
 *     ramp (or, when a Legend well is bound, a categorical color per legend
 *     value — Power BI parity). When only a Location NAME column is bound (no
 *     lat/long) each distinct name is GEOCODED via the Azure Maps Search Fuzzy
 *     data-plane (a REAL call, cached per name) — never a mock coordinate.
 *   • Filled   — a choropleth. The Location key joins to an OSS TopoJSON admin-0
 *     feature set bundled as a static asset; each polygon is colored by the Size
 *     ramp. ArcGIS / Esri / the PBI "Shape map" stay OUT (3rd-party) — only an
 *     OSS Natural-Earth TopoJSON is used, decoded inline (dependency-free).
 *
 * ── Auth + the honest gate (no-vaporware.md / no-fabric-dependency.md) ───────
 * Auth comes from the wave-5 BFF route `GET /api/items/report/[id]/map-token`,
 * which returns `resolveMapsBackend()`:
 *   • 200 { ok:true, mode:'aad', token, clientId, expiresOn } — Entra token
 *     scoped to atlas only (gov-safe, preferred), OR
 *   • 200 { ok:true, mode:'key', key } — a subscription key (commercial), OR
 *   • 412 { ok:false, error, envVar:'LOOM_MAPS_BACKEND', bicep:'…/azure-maps.bicep' }
 *     when `LOOM_MAPS_BACKEND` is unset.
 * On 412 this renders the honest warning MessageBar (the exact env var + the
 * bicep module that provisions the account) WITH the real aggregate rows table
 * beneath — the FULL surface still renders, the data is never hidden. Nothing
 * here ever reaches api.fabric.microsoft.com / api.powerbi.com; the only host
 * touched is the Azure-native atlas.microsoft.com (Azure Maps).
 *
 * ── web3-ui.md ───────────────────────────────────────────────────────────────
 * Fluent v9 + Loom design tokens for the chrome (header, toggle pill, legend,
 * gate, rows table); raw px only inside the SVG/canvas geometry the Azure Maps
 * SDK owns. The map canvas is height-bounded so it never overflows the visual
 * frame, and every empty / loading / gate / error state is designed.
 *
 * The map is just another DVisual body the FreeFormCanvas positions like any
 * visual — waves 0..4, the free-form canvas, and the data E2E are extended, not
 * regressed. report-designer.tsx (the host) swaps its `MapVisualBody` call for
 * `<MapVisual … />`, passing the report id + the resolved well column aliases
 * (latitude / longitude / location / size / legend) it already computes via
 * `wellResultAlias`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, ToggleButton, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableHeaderCell, TableRow, TableBody, TableCell,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Map20Regular, Globe20Regular, Location16Regular, CircleSmall20Regular, Warning20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { formatValue, type NumberFormatPreset } from './format-pane';

// ── public props ─────────────────────────────────────────────────────────────

export type MapMode = 'bubble' | 'filled';

export interface MapVisualProps {
  /** The report's Loom item id — shared on the map-token BFF path. */
  reportId: string;
  /**
   * The REAL aggregated location rows the map well-fold produced (one row per
   * Location / lat×long × Legend, with the Size aggregate). Identical to the
   * rows `MapVisualBody` showed in its table — the map draws from these.
   */
  rows: Array<Record<string, unknown>>;
  /** Result column names in `rows` (header order) — for the fallback table. */
  cols: string[];
  /** Number-format preset for the fallback rows table (parity with the host). */
  numberFormat?: NumberFormatPreset;
  // ── Resolved well column aliases (optional). The host passes the SQL result
  //    alias for each bound well (via `wellResultAlias`); when omitted they are
  //    auto-detected from `cols` so the component is usable standalone. ──────────
  /** Latitude well's result column (numeric). */
  latitudeColumn?: string;
  /** Longitude well's result column (numeric). */
  longitudeColumn?: string;
  /** Location well's result column (the place NAME — geocoded / TopoJSON key). */
  locationColumn?: string;
  /** Size well's aggregate result column (bubble radius / choropleth ramp). */
  sizeColumn?: string;
  /** Legend well's result column (categorical bubble color). */
  legendColumn?: string;
  /** Canvas height in px (default 360). Height-bounded so it never overflows. */
  height?: number;
}

// ── Azure Maps Web SDK (atlas) — loaded from the Azure-native CDN ─────────────
// azure-maps-control is NOT a bundled dependency (it would bloat every page and
// pin a version); the interactive SDK is loaded once at runtime from the Azure
// Maps CDN (atlas.microsoft.com — Azure-native, never Fabric/Power BI). Typed
// loosely as `any` because the SDK ships no types here; all atlas usage is
// client-only (inside effects), so SSR never touches `window`.

/* eslint-disable @typescript-eslint/no-explicit-any */
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

// ── token contract (mirrors maps-client.resolveMapsBackend) ───────────────────

type MapAuth =
  | { ok: true; mode: 'aad'; token: string; clientId: string; expiresOn?: number }
  | { ok: true; mode: 'key'; key: string };

type TokenState =
  | { kind: 'loading' }
  | { kind: 'ok'; auth: MapAuth }
  | { kind: 'gate'; error?: string; envVar?: string; bicep?: string }
  | { kind: 'error'; message: string };

const MAPS_ENV = 'LOOM_MAPS_BACKEND';
const MAPS_BICEP = 'platform/fiab/bicep/modules/landing-zone/azure-maps.bicep';

/** Path of the bundled OSS TopoJSON used for filled/choropleth maps. */
const TOPOJSON_ASSET = '/maps/topojson/countries-110m.json';

// ── color helpers (concrete hex — the SDK can't resolve CSS variables) ────────
// A two-stop Size ramp + a categorical Legend palette. These are data-viz marks
// (not chrome), so concrete hex is correct; the chrome around the map uses Loom
// tokens. The ramp endpoints echo the Loom communication-blue brand.

const RAMP_LO = '#cfe4fa';
const RAMP_HI = '#0f6cbd';
const NEUTRAL_FILL = '#d9dde3';
const CATEGORICAL = [
  '#0f6cbd', '#107c10', '#5c2e91', '#c19c00',
  '#a4262c', '#038387', '#881798', '#605e5c',
];

function parseHex(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function lerpHex(a: string, b: string, t: number): string {
  const pa = parseHex(a), pb = parseHex(b);
  const ch = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * Math.max(0, Math.min(1, t)));
  return `#${[ch(0), ch(1), ch(2)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}
/** Area-proportional bubble radius (∝ √Size) into a bounded px range. */
function radiusFor(size: number | undefined, min: number, max: number): number {
  if (size == null || !Number.isFinite(size) || max <= min) return 11;
  const t = Math.max(0, Math.min(1, (size - min) / (max - min)));
  return 6 + Math.sqrt(t) * 24; // 6..30 px
}

// ── numeric detection ─────────────────────────────────────────────────────────

function isNum(v: unknown): boolean {
  return v != null && v !== '' && !Number.isNaN(Number(v));
}

// ── dependency-free TopoJSON → GeoJSON decoder (quantized + delta arcs) ───────
// Handles the standard world-atlas / Natural-Earth Topology: a `transform`
// (scale/translate) with delta-encoded arcs, negative arc indices (~i ⇒ the
// reverse of arc i), and Polygon / MultiPolygon geometries. Enough to fill an
// admin-0 choropleth — no topojson-client dependency, no new package.

function topoToGeoJSON(topo: any, objectName?: string): any {
  const transform = topo?.transform;
  const arcsRaw: number[][][] = topo?.arcs || [];
  const sx = transform ? transform.scale[0] : 1;
  const sy = transform ? transform.scale[1] : 1;
  const tx = transform ? transform.translate[0] : 0;
  const ty = transform ? transform.translate[1] : 0;

  const decodeArc = (index: number): number[][] => {
    const reverse = index < 0;
    const arc = arcsRaw[reverse ? ~index : index] || [];
    const out: number[][] = [];
    let x = 0, y = 0;
    for (const p of arc) {
      if (transform) { x += p[0]; y += p[1]; out.push([x * sx + tx, y * sy + ty]); }
      else out.push([p[0], p[1]]);
    }
    return reverse ? out.reverse() : out;
  };
  const ringFor = (arcIdx: number[]): number[][] => {
    const ring: number[][] = [];
    for (const idx of arcIdx) {
      const seg = decodeArc(idx);
      const start = ring.length > 0 ? 1 : 0; // stitch: drop the shared join point
      for (let k = start; k < seg.length; k++) ring.push(seg[k]);
    }
    return ring;
  };
  const geom = (g: any): any => {
    if (g.type === 'Polygon') return { type: 'Polygon', coordinates: (g.arcs || []).map(ringFor) };
    if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: (g.arcs || []).map((poly: number[][]) => poly.map(ringFor)) };
    return null;
  };
  const objName = objectName || Object.keys(topo?.objects || {})[0];
  const geometries: any[] = topo?.objects?.[objName]?.geometries || [];
  const features = geometries
    .map((g) => ({ type: 'Feature', properties: g.properties || {}, geometry: geom(g) }))
    .filter((f) => f.geometry);
  return { type: 'FeatureCollection', features };
}

/** First populated string-ish name property on a TopoJSON/GeoJSON feature. */
function featureName(props: any): string {
  for (const k of ['name', 'NAME', 'admin', 'ADMIN', 'sovereignt', 'country', 'NAME_LONG']) {
    if (props && props[k] != null && String(props[k]).trim() !== '') return String(props[k]);
  }
  return '';
}
function normKey(s: string): string { return s.trim().toLowerCase(); }

// ── styles ─────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    padding: tokens.spacingHorizontalS,
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  headerIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex' },
  grow: { flexGrow: 1, minWidth: 0 },
  // Grouped ToggleButton "pill" — Fluent 9.54 has no SegmentedControl; matches
  // the shared ViewToggle / script-visual language pill (raised = active).
  seg: {
    display: 'inline-flex',
    alignItems: 'stretch',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: '2px',
    gap: '2px',
  },
  segBtn: {
    border: 'none',
    borderRadius: tokens.borderRadiusSmall,
    minWidth: '84px',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightRegular,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3Hover,
      color: tokens.colorNeutralForeground1,
    },
  },
  segBtnChecked: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
    boxShadow: tokens.shadow2,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1,
      color: tokens.colorNeutralForeground1,
    },
  },
  // The map canvas — height-bounded so it never overflows the visual frame.
  canvasWrap: {
    position: 'relative',
    width: '100%',
    minWidth: 0,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  canvas: { width: '100%', height: '100%' },
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground1,
    zIndex: 1,
  },
  overlayBox: {
    maxWidth: '460px',
    padding: tokens.spacingHorizontalL,
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
  },
  legend: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    color: tokens.colorNeutralForeground3,
  },
  rampBar: {
    width: '120px',
    height: '10px',
    borderRadius: tokens.borderRadiusSmall,
    background: `linear-gradient(90deg, ${RAMP_LO}, ${RAMP_HI})`,
    border: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  swatch: {
    width: '12px',
    height: '12px',
    borderRadius: tokens.borderRadiusCircular,
    display: 'inline-block',
    marginInlineEnd: '4px',
    verticalAlign: 'middle',
  },
  legChips: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  notes: { color: tokens.colorNeutralForeground3 },
  tableWrap: { maxHeight: '240px', overflow: 'auto', borderRadius: tokens.borderRadiusMedium },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
});

type Styles = ReturnType<typeof useStyles>;

// ── gallery glyph (exported for the host VISUALS gallery, parity w/ siblings) ──
export const mapGalleryGlyph: ReactElement = <Map20Regular />;

// ── geocode (Azure Maps Search Fuzzy — REAL data-plane, cached per name) ──────

interface LatLon { lat: number; lon: number }

async function geocodeName(name: string, auth: MapAuth, reportId: string): Promise<LatLon | null> {
  const base = 'https://atlas.microsoft.com/search/fuzzy/json?api-version=1.0&typeahead=false&limit=1&query=';
  const headers: Record<string, string> = {};
  let url = base + encodeURIComponent(name);
  if (auth.mode === 'aad') {
    // The token can roll between distinct names; mint a fresh one per call from
    // the BFF route so a long geocode pass never uses an expired token.
    let tok = auth.token, cid = auth.clientId;
    try {
      const t = await fetch(`/api/items/report/${encodeURIComponent(reportId)}/map-token`).then((r) => r.json());
      if (t?.ok && t.token) { tok = String(t.token); cid = String(t.clientId || cid); }
    } catch { /* fall back to the init token */ }
    headers['Authorization'] = `Bearer ${tok}`;
    if (cid) headers['x-ms-client-id'] = cid;
  } else {
    url += `&subscription-key=${encodeURIComponent(auth.key)}`;
  }
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`geocode HTTP ${r.status}`);
  const j = await r.json();
  const p = j?.results?.[0]?.position;
  if (p && isNum(p.lat) && isNum(p.lon)) return { lat: Number(p.lat), lon: Number(p.lon) };
  return null;
}

// ── component ─────────────────────────────────────────────────────────────────

export function MapVisual(props: MapVisualProps): ReactElement {
  const { reportId, rows, cols, numberFormat, height = 360 } = props;
  const styles = useStyles();

  // ── resolve the well columns (explicit hints win; else auto-detect) ──────────
  const resolved = useMemo(() => {
    const numericCols = cols.filter((c) => rows.some((r) => isNum(r[c])));
    const has = (c?: string) => !!c && cols.includes(c);
    let latCol = has(props.latitudeColumn) ? props.latitudeColumn : numericCols.find((c) => /lat/i.test(c));
    let longCol = has(props.longitudeColumn) ? props.longitudeColumn : numericCols.find((c) => /lon|lng|long/i.test(c));
    if (latCol && latCol === longCol) longCol = undefined;
    const sizeCol = has(props.sizeColumn)
      ? props.sizeColumn
      : numericCols.filter((c) => c !== latCol && c !== longCol).slice(-1)[0];
    const locationCol = has(props.locationColumn)
      ? props.locationColumn
      : cols.find((c) => !numericCols.includes(c)) ?? cols[0];
    const legendCol = has(props.legendColumn) && props.legendColumn !== locationCol ? props.legendColumn : undefined;
    return {
      latCol, longCol, sizeCol, locationCol, legendCol,
      hasLatLong: !!(latCol && longCol),
    };
  }, [cols, rows, props.latitudeColumn, props.longitudeColumn, props.sizeColumn, props.locationColumn, props.legendColumn]);

  const [mode, setMode] = useState<MapMode>('bubble');
  const [token, setToken] = useState<TokenState>({ kind: 'loading' });
  const [ready, setReady] = useState(false);
  const [mapErr, setMapErr] = useState<string | null>(null);
  const [geo, setGeo] = useState<Record<string, LatLon | null>>({});
  const [geocoding, setGeocoding] = useState(false);
  const [topo, setTopo] = useState<{ status: 'idle' | 'loading' | 'ready' | 'missing' | 'error'; geo?: any; message?: string }>({ status: 'idle' });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Atlas | null>(null);
  const dsRef = useRef<Atlas | null>(null);
  const layerIdsRef = useRef<string[]>([]);
  const popupRef = useRef<Atlas | null>(null);

  // ── 1. fetch the map token / honest gate ─────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setToken({ kind: 'loading' });
    (async () => {
      try {
        const r = await fetch(`/api/items/report/${encodeURIComponent(reportId)}/map-token`);
        let j: any = {};
        try { j = await r.json(); } catch { j = {}; }
        if (!alive) return;
        if (r.status === 412 || (j && j.ok === false)) {
          setToken({ kind: 'gate', error: j?.error, envVar: j?.envVar || MAPS_ENV, bicep: j?.bicep || MAPS_BICEP });
          return;
        }
        if (r.ok && j?.ok && (j.mode === 'aad' || j.mode === 'key')) {
          setToken({ kind: 'ok', auth: j as MapAuth });
          return;
        }
        setToken({ kind: 'error', message: (j && (j.error || j.message)) || `HTTP ${r.status}` });
      } catch (e: any) {
        if (alive) setToken({ kind: 'error', message: e?.message || String(e) });
      }
    })();
    return () => { alive = false; };
  }, [reportId]);

  // ── 2. init the atlas map once auth is OK ────────────────────────────────────
  useEffect(() => {
    if (token.kind !== 'ok' || !containerRef.current || mapRef.current) return;
    const auth = token.auth; // capture the narrowed auth for nested closures
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
                fetch(`/api/items/report/${encodeURIComponent(reportId)}/map-token`)
                  .then((r) => r.json())
                  .then((j) => (j?.ok && j.token ? resolve(String(j.token)) : reject(new Error('no token'))))
                  .catch(reject);
              },
            };
        const map = new atlas.Map(containerRef.current, {
          view: 'Auto',
          style: 'road_shaded_relief',
          showLogo: true,
          showFeedbackLink: false,
          authOptions,
        });
        mapRef.current = map;
        map.events.add('ready', () => { if (!disposed) setReady(true); });
        map.events.add('error', (e: any) => { if (!disposed) setMapErr(e?.error?.message || 'Azure Maps render error'); });
      })
      .catch((e: any) => { if (!disposed) setMapErr(e?.message || String(e)); });
    return () => {
      disposed = true;
      if (mapRef.current) { try { mapRef.current.dispose(); } catch { /* noop */ } mapRef.current = null; }
      dsRef.current = null;
      layerIdsRef.current = [];
      popupRef.current = null;
      setReady(false);
    };
  }, [token, reportId]);

  // ── 3. geocode distinct Location names (bubble, no lat/long) ──────────────────
  const needGeocode = mode === 'bubble' && !resolved.hasLatLong && !!resolved.locationCol && token.kind === 'ok';
  useEffect(() => {
    if (!needGeocode || token.kind !== 'ok') return;
    const auth = token.auth; // capture the narrowed auth for the async pass
    const locCol = resolved.locationCol!;
    const names = Array.from(new Set(rows.map((r) => String(r[locCol] ?? '')).filter((s) => s.trim() !== '')));
    const missing = names.filter((n) => !(normKey(n) in geo));
    if (missing.length === 0) return;
    let alive = true;
    setGeocoding(true);
    (async () => {
      const next: Record<string, LatLon | null> = {};
      // Sequential keeps us well under Azure Maps' burst limits for the small
      // distinct-name counts a grouped aggregate produces.
      for (const n of missing) {
        if (!alive) return;
        try { next[normKey(n)] = await geocodeName(n, auth, reportId); }
        catch { next[normKey(n)] = null; }
      }
      if (alive) { setGeo((prev) => ({ ...prev, ...next })); setGeocoding(false); }
    })();
    return () => { alive = false; setGeocoding(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needGeocode, rows, resolved.locationCol, token, reportId]);

  // ── 4. load the OSS TopoJSON basemap for filled/choropleth ────────────────────
  useEffect(() => {
    if (mode !== 'filled' || topo.status !== 'idle') return;
    let alive = true;
    setTopo({ status: 'loading' });
    (async () => {
      try {
        const r = await fetch(TOPOJSON_ASSET);
        if (!alive) return;
        if (r.status === 404) { setTopo({ status: 'missing' }); return; }
        if (!r.ok) { setTopo({ status: 'error', message: `HTTP ${r.status}` }); return; }
        const j = await r.json();
        const gj = (j?.type === 'Topology') ? topoToGeoJSON(j) : j;
        if (alive) setTopo({ status: 'ready', geo: gj });
      } catch (e: any) {
        if (alive) setTopo({ status: 'error', message: e?.message || String(e) });
      }
    })();
    return () => { alive = false; };
  }, [mode, topo.status]);

  // ── build the bubble points from the real rows (+ geocode cache) ──────────────
  const bubblePoints = useMemo(() => {
    const { latCol, longCol, sizeCol, locationCol, legendCol, hasLatLong } = resolved;
    const sizeOf = (r: Record<string, unknown>) => (sizeCol && isNum(r[sizeCol]) ? Number(r[sizeCol]) : undefined);
    const out: Array<{ lon: number; lat: number; size?: number; legend?: string; label: string }> = [];
    if (hasLatLong) {
      for (const r of rows) {
        const lon = Number(r[longCol!]), lat = Number(r[latCol!]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        out.push({
          lon, lat, size: sizeOf(r),
          legend: legendCol ? String(r[legendCol] ?? '') : undefined,
          label: locationCol ? String(r[locationCol] ?? `${lat.toFixed(2)}, ${lon.toFixed(2)}`) : `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
        });
      }
    } else if (locationCol) {
      for (const r of rows) {
        const name = String(r[locationCol] ?? '');
        if (name.trim() === '') continue;
        const pt = geo[normKey(name)];
        if (!pt) continue; // not yet geocoded / not found
        out.push({
          lon: pt.lon, lat: pt.lat, size: sizeOf(r),
          legend: legendCol ? String(r[legendCol] ?? '') : undefined,
          label: name,
        });
      }
    }
    return out;
  }, [rows, resolved, geo]);

  const sizeExtent = useMemo(() => {
    const vals = bubblePoints.map((p) => p.size).filter((v): v is number => v != null && Number.isFinite(v));
    return { min: vals.length ? Math.min(...vals) : 0, max: vals.length ? Math.max(...vals) : 0 };
  }, [bubblePoints]);

  const legendValues = useMemo(() => {
    if (!resolved.legendCol) return [];
    return Array.from(new Set(bubblePoints.map((p) => p.legend ?? '').filter((s) => s !== '')));
  }, [bubblePoints, resolved.legendCol]);

  const legendColorFor = useCallback((legend?: string): string => {
    if (!resolved.legendCol || !legend) return RAMP_HI;
    const i = legendValues.indexOf(legend);
    return CATEGORICAL[(i < 0 ? 0 : i) % CATEGORICAL.length];
  }, [resolved.legendCol, legendValues]);

  // ── 5. (re)draw the data layer whenever ready / mode / data change ────────────
  // Signatures keep the heavy effect from re-running on unrelated renders.
  const bubbleSig = useMemo(() => JSON.stringify(bubblePoints), [bubblePoints]);
  const fillSig = useMemo(() => {
    const { locationCol, sizeCol } = resolved;
    if (mode !== 'filled' || !locationCol) return '';
    return JSON.stringify(rows.map((r) => [String(r[locationCol] ?? ''), sizeCol ? r[sizeCol] : null]));
  }, [mode, rows, resolved]);

  useEffect(() => {
    const map = mapRef.current;
    const atlas: Atlas = (typeof window !== 'undefined' ? (window as any).atlas : null);
    if (!ready || !map || !atlas) return;

    // Clear prior layers + source.
    for (const id of layerIdsRef.current) { try { map.layers.remove(id); } catch { /* noop */ } }
    layerIdsRef.current = [];
    if (dsRef.current) { try { map.sources.remove(dsRef.current); } catch { /* noop */ } dsRef.current = null; }

    const ds = new atlas.source.DataSource();
    map.sources.add(ds);
    dsRef.current = ds;

    if (mode === 'bubble') {
      const features = bubblePoints.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {
          _r: radiusFor(p.size, sizeExtent.min, sizeExtent.max),
          _c: resolved.legendCol
            ? legendColorFor(p.legend)
            : lerpHex(RAMP_LO, RAMP_HI, sizeExtent.max > sizeExtent.min && p.size != null ? (p.size - sizeExtent.min) / (sizeExtent.max - sizeExtent.min) : 0.5),
          label: p.label,
          size: p.size ?? null,
          legend: p.legend ?? null,
        },
      }));
      ds.add({ type: 'FeatureCollection', features });
      const layer = new atlas.layer.BubbleLayer(ds, 'loom-bubbles', {
        radius: ['get', '_r'],
        color: ['get', '_c'],
        strokeColor: '#ffffff',
        strokeWidth: 1,
        opacity: 0.85,
      });
      map.layers.add(layer);
      layerIdsRef.current = ['loom-bubbles'];
      attachHoverPopup(map, atlas, 'loom-bubbles', popupRef, resolved.sizeCol);
      fitToFeatures(map, features);
    } else {
      // filled / choropleth — join the TopoJSON polygons to the Size aggregate.
      if (topo.status !== 'ready' || !topo.geo) return;
      const { locationCol, sizeCol } = resolved;
      const byName = new Map<string, number>();
      if (locationCol) {
        for (const r of rows) {
          const k = normKey(String(r[locationCol] ?? ''));
          if (k && sizeCol && isNum(r[sizeCol])) byName.set(k, Number(r[sizeCol]));
        }
      }
      const vals = Array.from(byName.values());
      const lo = vals.length ? Math.min(...vals) : 0;
      const hi = vals.length ? Math.max(...vals) : 0;
      const features = (topo.geo.features || []).map((f: any) => {
        const nm = normKey(featureName(f.properties));
        const v = byName.has(nm) ? byName.get(nm)! : undefined;
        const color = v == null ? NEUTRAL_FILL : lerpHex(RAMP_LO, RAMP_HI, hi > lo ? (v - lo) / (hi - lo) : 0.5);
        return { ...f, properties: { ...f.properties, _c: color, label: featureName(f.properties), size: v ?? null } };
      });
      ds.add({ type: 'FeatureCollection', features });
      const fill = new atlas.layer.PolygonLayer(ds, 'loom-fill', { fillColor: ['get', '_c'], fillOpacity: 0.8 });
      const line = new atlas.layer.LineLayer(ds, 'loom-fill-line', { strokeColor: '#ffffff', strokeWidth: 0.6 });
      map.layers.add(fill);
      map.layers.add(line);
      layerIdsRef.current = ['loom-fill', 'loom-fill-line'];
      attachHoverPopup(map, atlas, 'loom-fill', popupRef, sizeCol);
      // Fit to the joined polygons (those with data); else the whole basemap.
      const withData = features.filter((f: any) => f.properties.size != null);
      fitToFeatures(map, withData.length ? withData : features);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mode, bubbleSig, fillSig, topo.status]);

  // ── render ───────────────────────────────────────────────────────────────────

  const hasAnyBinding = resolved.hasLatLong || !!resolved.locationCol;

  return (
    <div className={styles.root} data-ff-nodrag>
      {/* Header + mode toggle */}
      <div className={styles.header}>
        <span className={styles.headerIcon}><Map20Regular /></span>
        <Subtitle2 className={styles.grow}>Map</Subtitle2>
        <div className={styles.seg} role="group" aria-label="Map mode">
          <ToggleButton
            className={mergeClasses(styles.segBtn, mode === 'bubble' && styles.segBtnChecked)}
            appearance="subtle" checked={mode === 'bubble'} aria-pressed={mode === 'bubble'}
            icon={<CircleSmall20Regular />} onClick={() => setMode('bubble')}
          >
            Bubbles
          </ToggleButton>
          <ToggleButton
            className={mergeClasses(styles.segBtn, mode === 'filled' && styles.segBtnChecked)}
            appearance="subtle" checked={mode === 'filled'} aria-pressed={mode === 'filled'}
            icon={<Globe20Regular />} onClick={() => setMode('filled')}
          >
            Filled
          </ToggleButton>
        </div>
        <Badge appearance="tint" color="brand" size="small">Azure Maps</Badge>
      </div>

      {/* Honest Azure-Maps gate (LOOM_MAPS_BACKEND unset) — full surface + rows */}
      {token.kind === 'gate' && (
        <GateBody styles={styles} rows={rows} cols={cols} nf={numberFormat}
          envVar={token.envVar} bicep={token.bicep} extra={token.error} />
      )}

      {/* Token / route error — honest, with the rows still shown beneath */}
      {token.kind === 'error' && (
        <div className={styles.section}>
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Map authorization failed</MessageBarTitle>
              {token.message}. The aggregated location rows are shown below.
            </MessageBarBody>
          </MessageBar>
          <RowsTable styles={styles} rows={rows} cols={cols} nf={numberFormat} />
        </div>
      )}

      {/* Configured: the real interactive map (or its loading / no-binding states) */}
      {(token.kind === 'loading' || token.kind === 'ok') && (
        <>
          {!hasAnyBinding ? (
            <EmptyState
              icon={<Location16Regular />}
              title="Add a location"
              body="Bind Latitude + Longitude for bubbles, or a Location name (Country / City) for geocoded bubbles or a filled choropleth. The Size well sets the bubble radius and the color ramp."
            />
          ) : (
            <>
              <div className={styles.canvasWrap} style={{ height }}>
                <div ref={containerRef} className={styles.canvas} />
                {/* Loading / map-error / geocoding / empty-data overlays */}
                {token.kind === 'loading' && (
                  <div className={styles.overlay}><Spinner size="tiny" /> <Body1>Authorizing Azure Maps…</Body1></div>
                )}
                {token.kind === 'ok' && !ready && !mapErr && (
                  <div className={styles.overlay}><Spinner size="tiny" /> <Body1>Loading map…</Body1></div>
                )}
                {mapErr && (
                  <div className={styles.overlay}>
                    <div className={styles.overlayBox}>
                      <Warning20Regular />
                      <Body1>Map failed to load</Body1>
                      <Caption1 className={styles.notes}>{mapErr}</Caption1>
                    </div>
                  </div>
                )}
                {token.kind === 'ok' && ready && mode === 'bubble' && geocoding && (
                  <div className={styles.overlay} style={{ backgroundColor: 'transparent', justifyContent: 'flex-start', alignItems: 'flex-start', padding: tokens.spacingHorizontalS, pointerEvents: 'none' }}>
                    <Badge appearance="tint" color="informative" icon={<Spinner size="extra-tiny" />}>Geocoding locations…</Badge>
                  </div>
                )}
                {token.kind === 'ok' && ready && mode === 'filled' && (topo.status === 'missing' || topo.status === 'error') && (
                  <div className={styles.overlay}>
                    <div className={styles.overlayBox}>
                      <Globe20Regular />
                      <Body1>Filled-map basemap not bundled</Body1>
                      <Caption1 className={styles.notes}>
                        Add the OSS Natural-Earth admin-0 TopoJSON at <code>public{TOPOJSON_ASSET}</code>{' '}
                        (e.g. topojson/world-atlas <code>countries-110m.json</code>). Switch to{' '}
                        <strong>Bubbles</strong> to map this data now.
                      </Caption1>
                    </div>
                  </div>
                )}
              </div>

              {/* Legend (Size ramp or categorical Legend) + row count */}
              <div className={styles.legend}>
                {resolved.legendCol && legendValues.length > 0 ? (
                  <div className={styles.legChips}>
                    <Caption1>{resolved.legendCol}:</Caption1>
                    {legendValues.slice(0, 8).map((lv) => (
                      <Caption1 key={lv}>
                        <span className={styles.swatch} style={{ backgroundColor: legendColorFor(lv) }} />{lv}
                      </Caption1>
                    ))}
                  </div>
                ) : resolved.sizeCol ? (
                  <>
                    <Caption1>{resolved.sizeCol}</Caption1>
                    <span className={styles.rampBar} aria-hidden />
                    <Caption1>{formatValue(sizeExtent.min, numberFormat)} – {formatValue(sizeExtent.max, numberFormat)}</Caption1>
                  </>
                ) : (
                  <Caption1>Bubble per location</Caption1>
                )}
                <span className={styles.grow} />
                <Caption1 className={styles.notes}>
                  {mode === 'bubble'
                    ? `${bubblePoints.length} of ${rows.length} location${rows.length === 1 ? '' : 's'} plotted`
                    : `${rows.length} location${rows.length === 1 ? '' : 's'}`}
                </Caption1>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── hover popup (atlas) — surfaces label + Size on mouseover ──────────────────

function attachHoverPopup(map: Atlas, atlas: Atlas, layerId: string, popupRef: { current: Atlas | null }, sizeCol?: string) {
  try {
    if (!popupRef.current) popupRef.current = new atlas.Popup({ closeButton: false, pixelOffset: [0, -8] });
    const popup = popupRef.current;
    map.events.add('mousemove', layerId, (e: any) => {
      const f = e?.shapes?.[0];
      const props = f?.getProperties ? f.getProperties() : f?.properties;
      if (!props) return;
      const label = props.label ?? '';
      const sizeTxt = props.size != null ? `<div style="opacity:.8">${sizeCol ? `${escapeHtml(sizeCol)}: ` : ''}${escapeHtml(String(props.size))}</div>` : '';
      popup.setOptions({
        content: `<div style="padding:6px 10px;font:13px/1.3 'Segoe UI',sans-serif"><strong>${escapeHtml(String(label))}</strong>${sizeTxt}</div>`,
        position: e.position,
      });
      popup.open(map);
    });
    map.events.add('mouseleave', layerId, () => { try { popup.close(); } catch { /* noop */ } });
  } catch { /* popups are a nicety; never block the render */ }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// ── camera fit ────────────────────────────────────────────────────────────────

function fitToFeatures(map: Atlas, features: any[]) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const visit = (coords: any) => {
    if (typeof coords[0] === 'number') {
      const [lon, lat] = coords;
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      }
    } else { for (const c of coords) visit(c); }
  };
  for (const f of features) { if (f?.geometry?.coordinates) visit(f.geometry.coordinates); }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return;
  try {
    if (minLon === maxLon && minLat === maxLat) {
      map.setCamera({ center: [minLon, minLat], zoom: 4 });
    } else {
      map.setCamera({ bounds: [minLon, minLat, maxLon, maxLat], padding: 48 });
    }
  } catch { /* noop */ }
}

// ── honest gate body (mirrors the old MapVisualBody, naming the exact fix) ─────

function GateBody({ styles, rows, cols, nf, envVar, bicep, extra }: {
  styles: Styles; rows: Array<Record<string, unknown>>; cols: string[];
  nf?: NumberFormatPreset; envVar?: string; bicep?: string; extra?: string;
}) {
  return (
    <div className={styles.section}>
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Azure Maps not configured</MessageBarTitle>
          Map rendering uses an Azure-native <strong>Azure Maps</strong> account. Set{' '}
          <code>{envVar || MAPS_ENV}=azure-maps</code> (with the account&apos;s data-plane AAD client id{' '}
          <code>LOOM_AZURE_MAPS_CLIENT_ID</code>, or a subscription key <code>LOOM_AZURE_MAPS_KEY</code> in
          commercial) and deploy <code>{bicep || MAPS_BICEP}</code>. No Power BI / Fabric map is required.
          {extra ? ` (${extra})` : ''} The aggregated location rows your wells produce are shown below.
        </MessageBarBody>
      </MessageBar>
      <RowsTable styles={styles} rows={rows} cols={cols} nf={nf} />
    </div>
  );
}

function RowsTable({ styles, rows, cols, nf }: {
  styles: Styles; rows: Array<Record<string, unknown>>; cols: string[]; nf?: NumberFormatPreset;
}) {
  if (rows.length === 0) {
    return <Caption1 className={styles.notes}>No aggregated location rows for the current bindings.</Caption1>;
  }
  return (
    <div className={styles.tableWrap}>
      <Table size="small">
        <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>
          {rows.slice(0, 60).map((row, ri) => (
            <TableRow key={ri}>
              {cols.map((c) => <TableCell key={c}>{formatValue(row[c], nf)}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default MapVisual;
