'use client';

/**
 * Geoanalytics editors — Geo map, Geo dataset, Geo query, Geo pipeline.
 *
 * Real wiring (v3):
 *   - GeoMapEditor       — lists Azure Maps accounts via ARM if available.
 *                          Falls back to "OSM tiles" MessageBar if not.
 *   - GeoDatasetEditor   — points at an ADLS path; geometry inspector is
 *                          surfaced via a sample T-SQL OPENROWSET to Synapse
 *                          Serverless and the existing /api/items/synapse-serverless-sql-pool/[id]/query route.
 *   - GeoQueryEditor     — KQL-or-TSQL toggle, pre-populated with H3 + ST
 *                          examples. Submits to Kusto or Synapse Serverless.
 *   - GeoPipelineEditor  — Cosmos-backed pointer to an ADF pipeline with a
 *                          "geo enrichment" flag. ADF integration deferred to
 *                          v3.x.
 *
 * Honest about runtime: Azure Maps account, H3 SQL UDFs, and reverse-geocode
 * pipelines are NOT deployed in this Loom instance — the MessageBars say so.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Label, Spinner,
  TabList, Tab, Checkbox, Dropdown, Option, Field, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Map20Regular, Folder20Regular, Play20Regular, Flow20Regular, Save20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { RibbonTab } from '@/lib/components/ribbon';
import { splitAdlsPath, joinAdlsPath, computeGeoBbox, bboxToZoom } from './_family-utils';
import { GeoJsonMap } from '@/lib/components/graph/geojson-map';

/**
 * v3.28 — Phase 4.5 fix: GeoMap / GeoDataset / GeoPipeline used to render
 * inputs whose state lived only in component memory. The MessageBars claimed
 * "saved into item state" / "the flags persist" but no Save button existed
 * and no PATCH ever ran. Per `no-vaporware.md` and the Phase 4.5 round-trip
 * standard, that's vaporware. This module now wires each editor to the
 * generic Cosmos item route:
 *   GET   /api/cosmos-items/<slug>/<id>           — load
 *   PATCH /api/cosmos-items/<slug>/<id>  { state } — save
 * with a dirty indicator + Ctrl+S handler.
 */

function useGeoItemState<T extends Record<string, unknown>>(slug: string, id: string, fallback: T) {
  const [state, setState] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Replace state via a wrapper that flips dirty=true so the Save button
  // surfaces unsaved edits.
  const update = useCallback((next: T | ((prev: T) => T)) => {
    setState((prev) => {
      const merged = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      return merged;
    });
    setDirty(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!id || id === 'new') { setLoading(false); return; }
    (async () => {
      setLoading(true); setError(null);
      try {
        const r = await fetch(`/api/cosmos-items/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`);
        if (cancelled) return;
        if (r.status === 404) { setLoading(false); return; }
        const j = await r.json();
        if (j?.ok && j.item?.state) {
          setState((prev) => ({ ...prev, ...(j.item.state as T) }));
          setSavedAt(j.item.updatedAt || null);
        }
      } catch (e: any) { if (!cancelled) setError(e?.message || String(e)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [id, slug]);

  const save = useCallback(async () => {
    if (!id || id === 'new') { setError('Save requires a real item id — open from the workspace list.'); return false; }
    setSaving(true); setError(null);
    try {
      const r = await fetch(`/api/cosmos-items/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state }),
      });
      const j = await r.json();
      if (!j?.ok) { setError(j?.error || `HTTP ${r.status}`); return false; }
      setSavedAt(j.item?.updatedAt || new Date().toISOString());
      setDirty(false);
      return true;
    } catch (e: any) { setError(e?.message || String(e)); return false; }
    finally { setSaving(false); }
  }, [slug, id, state]);

  // Ctrl+S handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  return { state, setState: update, loading, saving, savedAt, error, dirty, save };
}

function GeoSaveBar({ saving, dirty, savedAt, error, onSave }: {
  saving: boolean; dirty: boolean; savedAt: string | null; error: string | null; onSave: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
      <Button appearance="primary" icon={<Save20Regular />} onClick={onSave} disabled={saving || !dirty}>
        {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
      </Button>
      {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
      {savedAt && !saving && !dirty && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Saved {new Date(savedAt).toLocaleTimeString()}</Caption1>
      )}
      {error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Caption1>}
    </div>
  );
}

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  editor: {
    width: '100%', minHeight: 180,
    fontFamily: 'Consolas, monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  treePad: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  codeBlock: {
    fontFamily: 'Consolas, monospace', fontSize: '12px', lineHeight: '18px',
    margin: '0', padding: '12px', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground1,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '240px', overflow: 'auto',
  },
  enrichGroup: {
    display: 'flex', flexDirection: 'column', gap: '8px',
    padding: '12px', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  schemaRow: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, paddingBottom: '6px', paddingTop: '2px',
  },
});

const SAMPLE_GEO_KQL = `// Geoanalytics — KQL with built-in geo functions
// Find points within 10km of a center; resolve to H3 cell at resolution 7.
let center = dynamic({ "type": "Point", "coordinates": [-77.0369, 38.9072] });
events
| where geo_distance_2points(longitude, latitude, todouble(center.coordinates[0]), todouble(center.coordinates[1])) < 10000
| extend h3 = geo_point_to_h3cell(longitude, latitude, 7)
| summarize hits = count() by h3
| order by hits desc
| take 25
`;

const SAMPLE_GEO_TSQL = `-- Geoanalytics — Synapse Serverless OPENROWSET against ADLS Parquet.
-- H3 UDFs not in Serverless by default; install via CREATE FUNCTION dbo.H3_LATLON_TO_CELL
-- pointing at the H3 wheel in the lake. Deferred to v3.x.
SELECT TOP 25
  H3_LATLON_TO_CELL(lat, lon, 7) AS h3,
  COUNT(*) AS hits
FROM OPENROWSET(
    BULK 'https://<storage>.dfs.core.windows.net/geo/events/*.parquet',
    FORMAT = 'PARQUET'
) AS r
WHERE GEOGRAPHY::STGeomFromText(CONCAT('POINT(', lon, ' ', lat, ')'), 4326)
        .STDistance(GEOGRAPHY::Point(38.9072, -77.0369, 4326)) < 10000
GROUP BY H3_LATLON_TO_CELL(lat, lon, 7)
ORDER BY hits DESC;
`;

interface GeoMapState { account: string; style: string; tileLayerUrl: string; overlayGeoJson?: string; [k: string]: unknown }

const GEO_MAP_SAMPLE_OVERLAY = `{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "name": "Reagan National" }, "geometry": { "type": "Point", "coordinates": [-77.0377, 38.8512] } },
    { "type": "Feature", "properties": { "name": "Beltway" }, "geometry": { "type": "LineString", "coordinates": [[-77.04,38.90],[-77.10,38.95],[-77.15,38.88]] } }
  ]
}`;

export function GeoMapEditor({ item, id }: { item: FabricItemType; id: string }) {
  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create geo map"
        intro="A geo map renders spatial layers over Azure Maps (or OSM tiles when Maps is not provisioned). Create it, then configure the account, style, and tile layer and Save." />
    );
  }
  return <GeoMapEditorBody item={item} id={id} />;
}

function GeoMapEditorBody({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // Deployed Azure Maps account, surfaced from bicep as
  // NEXT_PUBLIC_LOOM_AZURE_MAPS_ACCOUNT (Next.js inlines NEXT_PUBLIC_* at build
  // time). Prefills the account field so the editor uses the *deployed*
  // account rather than a free-text placeholder.
  const configuredMapsAccount = process.env.NEXT_PUBLIC_LOOM_AZURE_MAPS_ACCOUNT || '';
  const { state, setState, loading, saving, savedAt, error, dirty, save } = useGeoItemState<GeoMapState>('geo-map', id, {
    account: configuredMapsAccount, style: 'main', tileLayerUrl: '', overlayGeoJson: GEO_MAP_SAMPLE_OVERLAY,
  });
  const [previewMsg, setPreviewMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const canSave = dirty && !saving;

  // Parse the overlay GeoJSON for live SVG rendering.
  const { parsed, parseErr, featureCount } = useMemo(() => {
    try {
      const j = JSON.parse(state.overlayGeoJson || '{}');
      return { parsed: j, parseErr: null as string | null, featureCount: Array.isArray(j?.features) ? j.features.length : 0 };
    } catch (e: any) { return { parsed: null, parseErr: e?.message || String(e), featureCount: 0 }; }
  }, [state.overlayGeoJson]);

  // Optional Azure Maps static raster basemap (client key). When unset the
  // vector overlay still renders on a neutral canvas.
  const mapsKey = process.env.NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY;
  const bbox = parsed ? computeGeoBbox(parsed) : null;
  const zoom = bboxToZoom(bbox);
  const centerLon = bbox ? (bbox.minLon + bbox.maxLon) / 2 : -77.0;
  const centerLat = bbox ? (bbox.minLat + bbox.maxLat) / 2 : 38.9;
  const rasterUrl = mapsKey
    ? `https://atlas.microsoft.com/map/static?api-version=2024-04-01&style=${encodeURIComponent(state.style || 'main')}&zoom=${zoom}&center=${centerLon},${centerLat}&width=640&height=360&subscription-key=${mapsKey}`
    : null;

  const validate = useCallback(() => {
    try {
      const j = JSON.parse(state.overlayGeoJson || '{}');
      const fc = Array.isArray(j?.features) ? j.features.length : 0;
      setPreviewMsg({ intent: 'success', text: `Valid GeoJSON overlay — ${fc} feature(s).` });
    } catch (e: any) { setPreviewMsg({ intent: 'error', text: `Invalid GeoJSON: ${e?.message || e}` }); }
  }, [state.overlayGeoJson]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Map', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: canSave ? save : undefined, disabled: !canSave },
        { label: 'Validate overlay', onClick: validate },
      ]},
    ]},
  ], [canSave, saving, save, validate]);
  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={<div className={s.treePad}><Caption1>Map config — style, raster basemap, and a GeoJSON data overlay rendered live below.</Caption1></div>}
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          {!mapsKey && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Vector overlay renders without Azure Maps</MessageBarTitle>
                The data overlay renders as a live SVG map below regardless of basemap. To layer an Azure Maps raster
                basemap behind it, provision <code>Microsoft.Maps/accounts</code> and set
                <code>NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY</code> on the Console Container App.
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.field}><Label>Azure Maps account name</Label>
            <Input value={state.account} onChange={(_: unknown, d: any) => setState((p) => ({ ...p, account: d.value }))} placeholder={configuredMapsAccount || 'maps-csa-loom'} />
            {configuredMapsAccount && (
              <Caption1>Deployed account <code>{configuredMapsAccount}</code> is bound from <code>NEXT_PUBLIC_LOOM_AZURE_MAPS_ACCOUNT</code>. Override above to point at a different Maps account.</Caption1>
            )}
          </div>
          <div className={s.field}><Label>Style</Label>
            <Input value={state.style} onChange={(_: unknown, d: any) => setState((p) => ({ ...p, style: d.value }))} placeholder="main" />
          </div>
          <div className={s.field}><Label>Tile layer URL (GeoJSON / TMS) — reference</Label>
            <Input value={state.tileLayerUrl} onChange={(_: unknown, d: any) => setState((p) => ({ ...p, tileLayerUrl: d.value }))} placeholder="https://…/tiles/{z}/{x}/{y}.pbf" />
          </div>
          <Subtitle2>Data overlay (GeoJSON)</Subtitle2>
          <MonacoTextarea value={state.overlayGeoJson || ''} onChange={(v) => setState((p) => ({ ...p, overlayGeoJson: v }))} language="json" height={200} minHeight={160} ariaLabel="Overlay GeoJSON" />
          {parseErr && <MessageBar intent="error"><MessageBarBody>Invalid GeoJSON: {parseErr}</MessageBarBody></MessageBar>}
          {previewMsg && <MessageBar intent={previewMsg.intent}><MessageBarBody>{previewMsg.text}</MessageBarBody></MessageBar>}
          {!parseErr && parsed && (
            <>
              <Subtitle2>Map render ({featureCount} feature{featureCount === 1 ? '' : 's'}{rasterUrl ? ` · Azure Maps basemap zoom ${zoom}` : ''})</Subtitle2>
              <GeoJsonMap geojson={parsed} rasterUrl={rasterUrl} />
            </>
          )}
          <Caption1>Persisted into Cosmos item state via PATCH /api/cosmos-items/geo-map/{`{id}`}.</Caption1>
          <GeoSaveBar saving={saving} dirty={dirty} savedAt={savedAt} error={error} onSave={save} />
        </div>
      }
    />
  );
}

interface GeoDatasetState { adlsPath: string; geomColumn: string; format: 'geojson' | 'parquet' | 'csv'; srid: string; [k: string]: unknown }

interface ContainerInfoDTO { name: string; url: string }

/** Storage-format options for the dataset Inspect probe. */
const GEO_FORMAT_OPTIONS: Array<{ value: GeoDatasetState['format']; label: string }> = [
  { value: 'parquet', label: 'Parquet (+ WKB geometry)' },
  { value: 'geojson', label: 'GeoJSON (line-delimited)' },
  { value: 'csv', label: 'CSV (lat / lon columns)' },
];

/** SRID picker options — the spatial reference systems the dataset declares. */
const GEO_SRID_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '4326', label: '4326 (WGS84 — lat/lon)' },
  { value: '3857', label: '3857 (Web Mercator)' },
  { value: '2263', label: '2263 (NY State Plane, ft)' },
  { value: 'custom', label: '(custom EPSG)' },
];

/**
 * Detect the on-the-wire geometry encoding of a single cell value so the
 * schema panel can badge it. WKB columns come back from Synapse Serverless as
 * a hex blob (BINARY/BYTE_ARRAY → varbinary); GeoJSON is an object/array
 * literal; everything else that looks like `POINT(...)` / `POLYGON(...)` is WKT.
 */
function detectGeometryEncoding(value: unknown): 'GeoJSON' | 'WKB' | 'WKT' | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.startsWith('{') || s.startsWith('[')) return 'GeoJSON';
  if (/^(0x)?[0-9A-Fa-f]+$/.test(s) && s.replace(/^0x/, '').length >= 10) return 'WKB';
  if (/^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*[(Z]/i.test(s)) return 'WKT';
  return null;
}

/**
 * Schema tree for the geo-dataset left panel. Renders one row per column from
 * the Inspect OPENROWSET probe. The geometry column (state.geomColumn) is
 * badged with its detected encoding (WKB/WKT/GeoJSON) from the row-0 value.
 * Pure presentational — driven by the real {columns, rows} the Synapse
 * Serverless query route returns.
 */
function GeoSchemaPanel({ columns, rows, geomColumn }: { columns: string[]; rows: unknown[][]; geomColumn: string }) {
  const s = useStyles();
  const row0 = Array.isArray(rows) && rows.length > 0 ? rows[0] : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Caption1 style={{ fontWeight: 600 }}>Schema ({columns.length} column{columns.length === 1 ? '' : 's'})</Caption1>
      {columns.map((c, i) => {
        const cell = Array.isArray(row0) ? (row0 as unknown[])[i] : undefined;
        const isGeom = c.toLowerCase() === (geomColumn || '').toLowerCase();
        const enc = isGeom ? detectGeometryEncoding(cell) : null;
        const preview = cell == null ? '∅' : String(cell).slice(0, 64);
        return (
          <div key={c} className={s.schemaRow}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Caption1 style={{ fontWeight: isGeom ? 700 : 500, color: isGeom ? tokens.colorBrandForeground1 : tokens.colorNeutralForeground1 }}>{c}</Caption1>
              {isGeom && <Badge appearance="tint" color="brand" size="small">geometry</Badge>}
              {enc && <Badge appearance="outline" color="informative" size="small">{enc}</Badge>}
            </div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3, fontFamily: 'Consolas, monospace', fontSize: '11px' }}>{preview}{cell != null && String(cell).length > 64 ? '…' : ''}</Caption1>
          </div>
        );
      })}
    </div>
  );
}

function useLakehouseContainers() {
  const [containers, setContainers] = useState<ContainerInfoDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/lakehouse/containers');
        const j = await r.json();
        if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setContainers([]); }
        else { setContainers(j.containers || []); }
      } catch (e: any) {
        setError(e?.message || String(e));
        setContainers([]);
      } finally { setLoading(false); }
    })();
  }, []);
  return { containers, error, loading };
}

// `splitAdlsPath` / `joinAdlsPath` live in `_family-utils.ts` so vitest
// can exercise them. See `lib/editors/__tests__/family-utils.test.ts` for
// round-trip coverage.

export function GeoDatasetEditor({ item, id }: { item: FabricItemType; id: string }) {
  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create geo dataset"
        intro="A geo dataset points at an ADLS path holding spatial data (Parquet/GeoJSON/CSV). Create it, then select a container, geometry column, and format and Save." />
    );
  }
  return <GeoDatasetEditorBody item={item} id={id} />;
}

function GeoDatasetEditorBody({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, savedAt, error, dirty, save } = useGeoItemState<GeoDatasetState>('geo-dataset', id, {
    adlsPath: '', geomColumn: 'geometry', format: 'parquet', srid: '4326',
  });
  const lh = useLakehouseContainers();
  const split = splitAdlsPath(state.adlsPath || '');
  const containerAccountUrl = (lh.containers || []).find((c) => c.name === split.container)?.url;
  const canSave = dirty && !saving;

  // Inspect: probe the first row of the dataset via Synapse Serverless
  // OPENROWSET. Real backend (synapse-serverless-sql-pool query route) — the
  // route returns an honest gate (LOOM_SYNAPSE_WORKSPACE) when not provisioned.
  const [inspecting, setInspecting] = useState(false);
  const [inspectResult, setInspectResult] = useState<any>(null);
  const inspect = useCallback(async () => {
    if (!state.adlsPath) { setInspectResult({ error: 'Select a container and path first.' }); return; }
    setInspecting(true); setInspectResult(null);
    // Build the OPENROWSET clause per format. Parquet infers a typed schema by
    // column name (BINARY/BYTE_ARRAY WKB → varbinary, shown as a hex blob); CSV
    // pulls header columns; GeoJSON is not columnar, so we read it as a single
    // raw line per row (FIELDQUOTE 0x0b ensures the JSON commas/braces don't
    // split fields) and the panel inspects the structure of line 0.
    let fmt: string;
    let geojsonNote = false;
    if (state.format === 'csv') {
      fmt = "FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE";
    } else if (state.format === 'geojson') {
      fmt = "FORMAT = 'CSV', PARSER_VERSION = '1.0', FIELDTERMINATOR = '0x0b', FIELDQUOTE = '0x0b', ROWTERMINATOR = '0x0a'";
      geojsonNote = true;
    } else {
      fmt = "FORMAT = 'PARQUET'";
    }
    const sql = `SELECT TOP 1 * FROM OPENROWSET(BULK '${state.adlsPath.replace(/'/g, "''")}', ${fmt}) AS r;`;
    try {
      const r = await fetch(`/api/items/synapse-serverless-sql-pool/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql }),
      });
      setInspectResult({ ...(await r.json()), sql, status: r.status, geojsonNote });
    } catch (e: any) { setInspectResult({ error: e?.message || String(e) }); }
    finally { setInspecting(false); }
  }, [state.adlsPath, state.format, id]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Dataset', actions: [
        { label: inspecting ? 'Inspecting…' : 'Inspect', onClick: inspecting ? undefined : inspect, disabled: inspecting || !state.adlsPath },
        { label: saving ? 'Saving…' : 'Save', onClick: canSave ? save : undefined, disabled: !canSave },
      ]},
    ]},
  ], [canSave, saving, save, inspecting, inspect, state.adlsPath]);
  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          {inspectResult?.ok && Array.isArray(inspectResult.columns) && inspectResult.columns.length > 0 ? (
            <GeoSchemaPanel columns={inspectResult.columns} rows={inspectResult.rows || []} geomColumn={state.geomColumn} />
          ) : (
            <Caption1>
              Geometry inspector — click <strong>Inspect</strong> to probe the dataset&rsquo;s first row via
              Synapse Serverless <code>OPENROWSET</code>. The inferred columns appear here, with the geometry
              column badged by its encoding (WKB / WKT / GeoJSON).
            </Caption1>
          )}
        </div>
      }
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          <Subtitle2>Geo dataset</Subtitle2>
          <Field label="ADLS container">
            <Dropdown
              value={split.container || ''}
              selectedOptions={split.container ? [split.container] : []}
              placeholder={
                lh.loading ? 'Loading containers…'
                  : (lh.containers?.length ?? 0) === 0 ? (lh.error ? 'Container discovery failed' : 'No ADLS containers found')
                  : 'Select a container'
              }
              disabled={lh.loading || (lh.containers?.length ?? 0) === 0}
              onOptionSelect={(_, d) => {
                const newContainer = d.optionValue || '';
                const url = (lh.containers || []).find((c) => c.name === newContainer)?.url;
                setState((p) => ({ ...p, adlsPath: joinAdlsPath(newContainer, split.suffix, url) }));
              }}
            >
              {(lh.containers || []).map((c) => (
                <Option key={c.name} value={c.name}>{c.name}</Option>
              ))}
            </Dropdown>
          </Field>
          {lh.error && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>ADLS containers not reachable</MessageBarTitle>
                {lh.error}
                <br />
                <Caption1>
                  Set <code>LOOM_&#123;BRONZE,SILVER,GOLD,LANDING&#125;_URL</code> on the Console Container App
                  and grant the UAMI Storage Blob Data Reader on the storage account.
                </Caption1>
              </MessageBarBody>
            </MessageBar>
          )}
          <Field label="Path suffix (under selected container)" hint={`Effective path: ${state.adlsPath || '(select a container)'}`}>
            <Input
              value={split.suffix}
              onChange={(_: unknown, d: any) => setState((p) => ({ ...p, adlsPath: joinAdlsPath(split.container, d.value, containerAccountUrl) }))}
              placeholder="geo/events/"
              disabled={!split.container}
            />
          </Field>
          <Field label="Geometry column">
            <Input value={state.geomColumn} onChange={(_: unknown, d: any) => setState((p) => ({ ...p, geomColumn: d.value }))} placeholder="geometry" />
          </Field>
          <Field label="Format">
            <Dropdown
              value={GEO_FORMAT_OPTIONS.find((o) => o.value === state.format)?.label || ''}
              selectedOptions={[state.format]}
              onOptionSelect={(_, d) => setState((p) => ({ ...p, format: (d.optionValue as GeoDatasetState['format']) || 'parquet' }))}
            >
              {GEO_FORMAT_OPTIONS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Spatial reference (SRID / EPSG)">
            {(() => {
              const sridSelection = GEO_SRID_OPTIONS.some((o) => o.value === state.srid) ? state.srid : 'custom';
              return (
                <Dropdown
                  value={GEO_SRID_OPTIONS.find((o) => o.value === sridSelection)?.label || ''}
                  selectedOptions={[sridSelection]}
                  onOptionSelect={(_, d) => setState((p) => ({ ...p, srid: d.optionValue === 'custom' ? '' : (d.optionValue || '') }))}
                >
                  {GEO_SRID_OPTIONS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                </Dropdown>
              );
            })()}
            {!GEO_SRID_OPTIONS.some((o) => o.value === state.srid) && (
              <Input value={state.srid} onChange={(_: unknown, d: any) => setState((p) => ({ ...p, srid: d.value }))} placeholder="EPSG code, e.g. 27700" />
            )}
          </Field>
          <Divider />
          <Subtitle2>Geometry inspector</Subtitle2>
          <MessageBar intent="info">
            <MessageBarBody>
              <strong>Inspect</strong> probes the first row via Synapse Serverless <code>OPENROWSET</code> over the
              selected path. The path + column persist to Cosmos via PATCH /api/cosmos-items/geo-dataset/{`{id}`}.
            </MessageBarBody>
          </MessageBar>
          <Button appearance="primary" icon={<Play20Regular />} onClick={inspect} disabled={inspecting || !state.adlsPath}>
            {inspecting ? 'Inspecting…' : 'Inspect first row (OPENROWSET)'}
          </Button>
          {inspecting && <Spinner size="tiny" label="Probing dataset…" labelPosition="after" />}
          {inspectResult && (
            inspectResult.error || inspectResult.status >= 400 ? (
              <MessageBar intent={inspectResult.status === 503 || inspectResult.notDeployed ? 'warning' : 'error'}>
                <MessageBarBody>
                  <MessageBarTitle>{inspectResult.status === 503 ? 'Synapse Serverless not provisioned' : 'Inspect failed'}</MessageBarTitle>
                  {inspectResult.error}{inspectResult.hint && <><br />{inspectResult.hint}</>}
                </MessageBarBody>
              </MessageBar>
            ) : (
              <>
                {inspectResult.geojsonNote && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>GeoJSON is not columnar</MessageBarTitle>
                      Synapse Serverless reads GeoJSON as raw lines (one feature per row) rather than a typed schema.
                      The first feature&rsquo;s structure is shown below; for a typed geometry schema, store the dataset
                      as Parquet (with a WKB geometry column) and re-inspect.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {Array.isArray(inspectResult.columns) && inspectResult.columns.length > 0 && (
                  <>
                    <Subtitle2>Inferred schema</Subtitle2>
                    <GeoSchemaPanel columns={inspectResult.columns} rows={inspectResult.rows || []} geomColumn={state.geomColumn} />
                  </>
                )}
                <Caption1>Probe query:</Caption1>
                <pre className={s.codeBlock}>{inspectResult.sql}</pre>
                <Caption1>First row:</Caption1>
                <pre className={s.codeBlock}>{JSON.stringify(inspectResult.rows || inspectResult.result || inspectResult, null, 2)}</pre>
              </>
            )
          )}
          <GeoSaveBar saving={saving} dirty={dirty} savedAt={savedAt} error={error} onSave={save} />
        </div>
      }
    />
  );
}

// H3 ADX install bundle — defines h3_* convenience functions wrapping the
// built-in `geo_point_to_h3cell` family so users can drop straight into the
// h3_ namespace they get from Spark / DuckDB / Synapse. All are pure KQL,
// no external assembly; the .create function commands are idempotent
// (`.create-or-alter`).
const H3_ADX_INSTALL = `.create-or-alter function with (folder="loom/h3", docstring="H3 cell from lat/lon at resolution r") h3_latlon_to_cell(lat:real, lon:real, r:int=7) { geo_point_to_h3cell(lon, lat, r) }
.create-or-alter function with (folder="loom/h3", docstring="Parent H3 cell at resolution r") h3_cell_to_parent(cell:string, r:int) { geo_h3cell_parent(cell, r) }
.create-or-alter function with (folder="loom/h3", docstring="H3 cell neighbors (k-ring)") h3_cell_kring(cell:string, k:int=1) { geo_h3cell_neighbors(cell) }
.create-or-alter function with (folder="loom/h3", docstring="Center lat/lon of an H3 cell as {lat,lon}") h3_cell_to_latlon(cell:string) { geo_h3cell_to_central_point(cell) }
.create-or-alter function with (folder="loom/h3", docstring="Hex polygon (GeoJSON) of an H3 cell") h3_cell_to_polygon(cell:string) { geo_h3cell_to_polygon(cell) }`;

/**
 * Turn a query result into a GeoJSON FeatureCollection of points, detecting
 * common lat/lon column names across the KQL ({columns, rows}) and Synapse
 * ({rows: [{...}]}) result shapes. Returns a FeatureCollection (possibly
 * empty) so the GeoQuery editor can render spatial results on the map.
 */
function geoFromResult(result: any): { type: 'FeatureCollection'; features: any[] } {
  const fc = { type: 'FeatureCollection' as const, features: [] as any[] };
  if (!result || !result.ok) return fc;
  const LON = ['lon', 'lng', 'longitude', 'x'];
  const LAT = ['lat', 'latitude', 'y'];
  const find = (keys: string[], names: string[]) => keys.find((k) => names.includes(k.toLowerCase()));

  // KQL shape: { columns: string[], rows: any[][] }
  if (Array.isArray(result.columns) && Array.isArray(result.rows)) {
    const cols: string[] = result.columns;
    const lonI = cols.findIndex((c) => LON.includes(c.toLowerCase()));
    const latI = cols.findIndex((c) => LAT.includes(c.toLowerCase()));
    if (lonI >= 0 && latI >= 0) {
      for (const row of result.rows.slice(0, 2000)) {
        const lon = Number(row[lonI]); const lat = Number(row[latI]);
        if (!Number.isNaN(lon) && !Number.isNaN(lat)) {
          const props: Record<string, unknown> = {};
          cols.forEach((c, i) => { if (i !== lonI && i !== latI) props[c] = row[i]; });
          fc.features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
        }
      }
    }
    return fc;
  }
  // Object-row shape: { rows: [{...}] } or { result: [{...}] }
  const rows: any[] = Array.isArray(result.rows) ? result.rows : Array.isArray(result.result) ? result.result : [];
  for (const row of rows.slice(0, 2000)) {
    if (!row || typeof row !== 'object') continue;
    const keys = Object.keys(row);
    const lonK = find(keys, LON); const latK = find(keys, LAT);
    if (lonK && latK) {
      const lon = Number(row[lonK]); const lat = Number(row[latK]);
      if (!Number.isNaN(lon) && !Number.isNaN(lat)) {
        const props = { ...row }; delete props[lonK]; delete props[latK];
        fc.features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
      }
    }
  }
  return fc;
}

export function GeoQueryEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [engine, setEngine] = useState<'kql' | 'tsql'>('kql');
  const [text, setText] = useState<string>(SAMPLE_GEO_KQL);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  // H3 install state — runs the .create-or-alter bundle against the
  // resolved KQL database. Idempotent.
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const installH3 = useCallback(async () => {
    setInstalling(true); setInstallMsg('Installing H3 functions…');
    try {
      const r = await fetch(`/api/items/kql-database/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql: H3_ADX_INSTALL }),
      });
      const j = await r.json();
      if (!j.ok) { setInstallMsg(`Install failed: ${j.error || 'unknown'}`); return; }
      setInstallMsg(`Installed h3_* functions (${j.rowCount ?? 5} commands executed).`);
    } catch (e: any) {
      setInstallMsg(`Install failed: ${e?.message || String(e)}`);
    } finally { setInstalling(false); }
  }, [id]);

  const onEngineChange = (e: 'kql' | 'tsql') => {
    setEngine(e);
    setText(e === 'kql' ? SAMPLE_GEO_KQL : SAMPLE_GEO_TSQL);
  };

  const run = useCallback(async () => {
    setLoading(true); setResult(null);
    try {
      // Engine-specific routing — KQL → kql-database query route; T-SQL → synapse-serverless.
      // Both routes already exist in this Loom build, so the editor doesn't add new BFF endpoints.
      const url = engine === 'kql'
        ? `/api/items/kql-database/${id}/query`
        : `/api/items/synapse-serverless-sql-pool/${id}/query`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(engine === 'kql' ? { kql: text } : { sql: text }),
      });
      setResult(await r.json());
    } catch (e: any) { setResult({ ok: false, error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [id, engine, text]);

  // Build a GeoJSON FeatureCollection from result rows that carry lat/lon
  // (or latitude/longitude) columns, so spatial results render on the map.
  const resultGeo = useMemo(() => geoFromResult(result), [result]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Engine', actions: [
        { label: 'KQL', onClick: () => onEngineChange('kql'), disabled: engine === 'kql' },
        { label: 'T-SQL', onClick: () => onEngineChange('tsql'), disabled: engine === 'tsql' },
      ]},
      { label: 'Run', actions: [
        { label: loading ? 'Running…' : 'Execute', onClick: loading ? undefined : run, disabled: loading },
      ]},
      { label: 'H3 UDFs', actions: [
        { label: installing ? 'Installing…' : 'Install H3 to KQL DB', onClick: installing ? undefined : installH3, disabled: installing || engine !== 'kql', title: engine !== 'kql' ? 'Switch to KQL engine first — H3 ADX install is KQL-only.' : 'Idempotent .create-or-alter for h3_* functions on the resolved KQL database.' },
      ]},
    ]},
  ], [engine, loading, run, installing, installH3]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={<div className={s.treePad}>
        <Caption1>Functions:</Caption1>
        <Body1><code>geo_distance_2points</code></Body1>
        <Body1><code>geo_point_to_h3cell</code></Body1>
        <Body1><code>geo_point_to_s2cell</code></Body1>
        <Body1><code>ST_DISTANCE / ST_WITHIN</code></Body1>
      </div>}
      main={
        <div className={s.pad}>
          <TabList selectedValue={engine} onTabSelect={(_: unknown, d: any) => onEngineChange(d.value as any)}>
            <Tab value="kql">KQL (Kusto)</Tab>
            <Tab value="tsql">T-SQL (Synapse Serverless)</Tab>
          </TabList>
          <MonacoTextarea value={text} onChange={setText} language="sql" height={220} minHeight={180} ariaLabel="Geo query editor" />
          <Button appearance="primary" icon={<Play20Regular />} onClick={run} disabled={loading}>Run</Button>
          {resultGeo && resultGeo.features.length > 0 && (
            <>
              <Subtitle2>Result map ({resultGeo.features.length} point{resultGeo.features.length === 1 ? '' : 's'})</Subtitle2>
              <GeoJsonMap geojson={resultGeo} />
            </>
          )}
          {loading && <Spinner size="small" label="Running query…" labelPosition="after" />}
          {result && (
            <pre className={s.codeBlock}>
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
          {installMsg && (
            <MessageBar intent={installMsg.includes('failed') ? 'error' : 'success'}>
              <MessageBarBody>{installMsg}</MessageBarBody>
            </MessageBar>
          )}
          <MessageBar intent="info"><MessageBarBody>
            <MessageBarTitle>H3 UDFs</MessageBarTitle>
            Click <strong>Install H3 to KQL DB</strong> in the ribbon to provision <code>h3_latlon_to_cell</code>,{' '}
            <code>h3_cell_to_parent</code>, <code>h3_cell_kring</code>, <code>h3_cell_to_latlon</code>, and{' '}
            <code>h3_cell_to_polygon</code> in the resolved KQL database (idempotent <code>.create-or-alter</code>).{' '}
            For Synapse Serverless, the H3 .NET assembly must be uploaded out-of-band — run{' '}
            <code>scripts/csa-loom/install-synapse-h3.sh</code> against your workspace.
          </MessageBarBody></MessageBar>
        </div>
      }
    />
  );
}

interface GeoPipelineState { adfPipelineName: string; enrichH3: boolean; reverseGeocode: boolean; bufferMeters: number; [k: string]: unknown }

interface AdfPipelineLite { name: string; id?: string; properties?: { description?: string } }

function useAdfPipelines() {
  const [pipelines, setPipelines] = useState<AdfPipelineLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/items/adf-pipeline');
        const j = await r.json();
        if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setPipelines([]); }
        else { setPipelines(j.pipelines || []); }
      } catch (e: any) {
        setError(e?.message || String(e));
        setPipelines([]);
      } finally { setLoading(false); }
    })();
  }, []);
  return { pipelines, error, loading };
}

export function GeoPipelineEditor({ item, id }: { item: FabricItemType; id: string }) {
  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create geo pipeline"
        intro="A geo pipeline layers geo-enrichment flags (H3, reverse-geocode, buffer) onto an existing ADF pipeline. Create it, then pick the target pipeline and Trigger run." />
    );
  }
  return <GeoPipelineEditorBody item={item} id={id} />;
}

function GeoPipelineEditorBody({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, savedAt, error, dirty, save } = useGeoItemState<GeoPipelineState>('geo-pipeline', id, {
    adfPipelineName: '', enrichH3: true, reverseGeocode: false, bufferMeters: 0,
  });
  const adf = useAdfPipelines();
  // Azure Maps gate — reverse-geocode requires Azure Maps, which is not
  // provisioned in GCC-High / IL5 (bicep never sets the key there). Same gate
  // pattern as the GeoMap raster basemap.
  const mapsKey = process.env.NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY;
  const [triggering, setTriggering] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const triggerRun = useCallback(async () => {
    if (!state.adfPipelineName) { setTriggerMsg({ intent: 'error', text: 'Pick a target ADF pipeline first.' }); return; }
    setTriggering(true); setTriggerMsg(null);
    try {
      // The geo flags persist to Cosmos item state; the run route reads them
      // back and maps them to real ADF pipeline parameters. Persist first so an
      // unsaved flag change is honored on the run (no stale state on the server).
      if (dirty) await save();
      const r = await fetch(`/api/items/geo-pipeline/${encodeURIComponent(id)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
      });
      const j = await r.json();
      if (j?.ok) {
        const used = Array.isArray(j.parametersUsed) ? j.parametersUsed : [];
        const skipped = Array.isArray(j.parametersSkipped) ? j.parametersSkipped : [];
        setTriggerMsg({
          intent: 'success',
          text: `Triggered run ${j.runId || ''} on "${j.pipelineName}".` +
            (used.length ? ` Parameters passed: ${used.join(', ')}.` : '') +
            (skipped.length ? ` Not declared by pipeline (skipped): ${skipped.join(', ')}.` : ''),
        });
      } else {
        setTriggerMsg({ intent: j?.notDeployed || r.status === 412 ? 'warning' : 'error', text: j?.error || `HTTP ${r.status}` });
      }
    } catch (e: any) { setTriggerMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setTriggering(false); }
  }, [id, state.adfPipelineName, dirty, save]);
  const canSave = dirty && !saving;
  const canTrigger = !!state.adfPipelineName && !triggering;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Pipeline', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: canSave ? save : undefined, disabled: !canSave },
        { label: triggering ? 'Triggering…' : 'Trigger run', onClick: canTrigger ? triggerRun : undefined, disabled: !canTrigger },
      ]},
    ]},
  ], [canSave, saving, save, canTrigger, triggering, triggerRun]);
  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={<div className={s.treePad}><Caption1>This item layers geo-enrichment flags onto a real ADF pipeline. At Trigger run the flags are posted as ADF pipeline parameters (<code>enrichH3</code>, <code>reverseGeocode</code>, <code>bufferMeters</code>).</Caption1></div>}
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          <Field label="ADF pipeline (target)">
            <Dropdown
              value={state.adfPipelineName || ''}
              selectedOptions={state.adfPipelineName ? [state.adfPipelineName] : []}
              placeholder={
                adf.loading ? 'Loading pipelines…'
                  : (adf.pipelines?.length ?? 0) === 0 ? (adf.error ? 'Discovery failed' : 'No ADF pipelines in factory')
                  : 'Select a pipeline'
              }
              disabled={adf.loading || (adf.pipelines?.length ?? 0) === 0}
              onOptionSelect={(_, d) => setState((p) => ({ ...p, adfPipelineName: d.optionValue || '' }))}
            >
              {(adf.pipelines || []).map((p) => (
                <Option key={p.name} value={p.name} text={p.name}>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <Body1>{p.name}</Body1>
                    {p.properties?.description && (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{p.properties.description}</Caption1>
                    )}
                  </div>
                </Option>
              ))}
            </Dropdown>
          </Field>
          {adf.error && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>ADF pipelines not reachable</MessageBarTitle>
                {adf.error}
                <br />
                <Caption1>
                  Ensure the ADF factory is provisioned and the Console UAMI has Data Factory Contributor on it.
                </Caption1>
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.field}>
            <Label>Enrichments</Label>
            <div className={s.enrichGroup}>
              <Checkbox
                checked={state.enrichH3}
                onChange={(_, d) => setState((p) => ({ ...p, enrichH3: !!d.checked }))}
                label={<span>Add H3 cell id at resolution 7 (<code>enrichH3: Bool</code>)</span>}
              />
              <Checkbox
                checked={state.reverseGeocode && !!mapsKey}
                disabled={!mapsKey}
                onChange={(_, d) => setState((p) => ({ ...p, reverseGeocode: !!d.checked }))}
                label={<span>Reverse-geocode (<code>reverseGeocode: Bool</code>)</span>}
              />
            </div>
          </div>
          {!mapsKey && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Reverse-geocode requires Azure Maps</MessageBarTitle>
                Azure Maps is not provisioned in this deployment (and is unavailable in GCC-High / IL5). Set
                <code>NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY</code> on the Console Container App after provisioning
                <code>Microsoft.Maps/accounts</code> to enable this flag. H3 and buffer enrichments work without it.
              </MessageBarBody>
            </MessageBar>
          )}
          <Field label="Buffer (meters; 0 = no buffer)" hint="ADF parameter bufferMeters: Int">
            <Input type="number" min={0} value={String(state.bufferMeters)} onChange={(_: unknown, d: any) => setState((p) => ({ ...p, bufferMeters: Number(d.value || '0') }))} />
          </Field>
          {adf.error && /Missing env var|not configured/i.test(adf.error) && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>ADF not configured</MessageBarTitle>
                Set <code>LOOM_ADF_NAME</code>, <code>LOOM_DLZ_RG</code>, and <code>LOOM_SUBSCRIPTION_ID</code> on the
                Console Container App and grant the UAMI Data Factory Contributor.
              </MessageBarBody>
            </MessageBar>
          )}
          <MessageBar intent="info">
            <MessageBarBody>
              At <strong>Trigger run</strong>, the geo-enrichment flags are posted to ADF as pipeline parameters
              (<code>enrichH3</code>, <code>reverseGeocode</code>, <code>bufferMeters</code>) on a real{' '}
              <code>createRun</code> against the selected pipeline. The target pipeline must declare these
              parameter names (use the <code>loom-geo-enrich</code> starter pipeline, which pre-declares them).
              The flags also persist to Cosmos via PATCH /api/cosmos-items/geo-pipeline/{`{id}`}.
            </MessageBarBody>
          </MessageBar>
          {triggerMsg && (
            <MessageBar intent={triggerMsg.intent}>
              <MessageBarBody>{triggerMsg.text}</MessageBarBody>
            </MessageBar>
          )}
          <GeoSaveBar saving={saving} dirty={dirty} savedAt={savedAt} error={error} onSave={save} />
        </div>
      }
    />
  );
}
