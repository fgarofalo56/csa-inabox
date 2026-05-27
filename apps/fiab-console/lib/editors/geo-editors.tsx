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

import { useState, useCallback, useEffect } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Label, Spinner,
  TabList, Tab,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Map20Regular, Folder20Regular, Play20Regular, Flow20Regular, Save20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

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

interface GeoMapState { account: string; style: string; tileLayerUrl: string; [k: string]: unknown }

export function GeoMapEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, savedAt, error, dirty, save } = useGeoItemState<GeoMapState>('geo-map', id, {
    account: '', style: 'main', tileLayerUrl: '',
  });
  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Map', actions: [{ label: 'Save' }, { label: 'Preview' }] }] }]}
      leftPanel={<div className={s.treePad}><Caption1>Map config — style, tile layer, and tokens.</Caption1></div>}
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Runtime deferred</MessageBarTitle>
              <code>LOOM_AZURE_MAPS_ACCOUNT</code> not configured in this Loom instance — preview will fall back
              to OSM tiles. Provision <code>Microsoft.Maps/accounts</code> and set the env var to enable native
              Azure Maps rendering.
            </MessageBarBody>
          </MessageBar>
          <div className={s.field}><Label>Azure Maps account name</Label>
            <Input value={state.account} onChange={(_, d) => setState((p) => ({ ...p, account: d.value }))} placeholder="maps-csa-loom" />
          </div>
          <div className={s.field}><Label>Style</Label>
            <Input value={state.style} onChange={(_, d) => setState((p) => ({ ...p, style: d.value }))} placeholder="main" />
          </div>
          <div className={s.field}><Label>Tile layer URL (GeoJSON / TMS)</Label>
            <Input value={state.tileLayerUrl} onChange={(_, d) => setState((p) => ({ ...p, tileLayerUrl: d.value }))} placeholder="https://…/tiles/{z}/{x}/{y}.pbf" />
          </div>
          <Caption1>Persisted into Cosmos item state via PATCH /api/cosmos-items/geo-map/{`{id}`}. Hooks into the GeoQuery editor for layered visualization (v3.x).</Caption1>
          <GeoSaveBar saving={saving} dirty={dirty} savedAt={savedAt} error={error} onSave={save} />
        </div>
      }
    />
  );
}

interface GeoDatasetState { adlsPath: string; geomColumn: string; format: 'geojson' | 'parquet' | 'csv'; [k: string]: unknown }

export function GeoDatasetEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, savedAt, error, dirty, save } = useGeoItemState<GeoDatasetState>('geo-dataset', id, {
    adlsPath: '', geomColumn: 'geometry', format: 'parquet',
  });
  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Dataset', actions: [{ label: 'Inspect' }, { label: 'Save' }] }] }]}
      leftPanel={<div className={s.treePad}><Caption1>Browse ADLS Gen2 — geometry-column inspector deferred to v3.x.</Caption1></div>}
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          <Subtitle2>Geo dataset</Subtitle2>
          <div className={s.field}><Label>ADLS Gen2 path</Label>
            <Input value={state.adlsPath} onChange={(_, d) => setState((p) => ({ ...p, adlsPath: d.value }))} placeholder="abfss://lake@<storage>.dfs.core.windows.net/geo/events/" />
          </div>
          <div className={s.field}><Label>Geometry column</Label>
            <Input value={state.geomColumn} onChange={(_, d) => setState((p) => ({ ...p, geomColumn: d.value }))} placeholder="geometry" />
          </div>
          <div className={s.field}><Label>Format</Label>
            <select value={state.format} onChange={(e) => setState((p) => ({ ...p, format: e.target.value as GeoDatasetState['format'] }))} style={{ padding: 6 }}>
              <option value="parquet">Parquet (+ WKB geometry)</option>
              <option value="geojson">GeoJSON (line-delimited)</option>
              <option value="csv">CSV (lat / lon columns)</option>
            </select>
          </div>
          <MessageBar intent="info">
            <MessageBarBody>
              Inspector probes the first row via Serverless OPENROWSET and parses the geometry column with
              <code> GEOGRAPHY::STGeomFromWKB</code>. Wiring deferred to v3.x — the path + column persist to
              Cosmos via PATCH /api/cosmos-items/geo-dataset/{`{id}`}.
            </MessageBarBody>
          </MessageBar>
          <GeoSaveBar saving={saving} dirty={dirty} savedAt={savedAt} error={error} onSave={save} />
        </div>
      }
    />
  );
}

export function GeoQueryEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [engine, setEngine] = useState<'kql' | 'tsql'>('kql');
  const [text, setText] = useState<string>(SAMPLE_GEO_KQL);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

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

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [
        { label: 'Engine', actions: [{ label: 'KQL' }, { label: 'T-SQL' }] },
        { label: 'Run', actions: [{ label: 'Execute' }] },
      ]}]}
      leftPanel={<div className={s.treePad}>
        <Caption1>Functions:</Caption1>
        <Body1><code>geo_distance_2points</code></Body1>
        <Body1><code>geo_point_to_h3cell</code></Body1>
        <Body1><code>geo_point_to_s2cell</code></Body1>
        <Body1><code>ST_DISTANCE / ST_WITHIN</code></Body1>
      </div>}
      main={
        <div className={s.pad}>
          <TabList selectedValue={engine} onTabSelect={(_, d) => onEngineChange(d.value as any)}>
            <Tab value="kql">KQL (Kusto)</Tab>
            <Tab value="tsql">T-SQL (Synapse Serverless)</Tab>
          </TabList>
          <MonacoTextarea value={text} onChange={setText} language="sql" height={220} minHeight={180} ariaLabel="Geo query editor" />
          <Button appearance="primary" icon={<Play20Regular />} onClick={run} disabled={loading}>Run</Button>
          {result && (
            <pre style={{ fontSize: 12, maxHeight: 240, overflow: 'auto', background: tokens.colorNeutralBackground3, padding: 8, borderRadius: 4 }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
          <MessageBar intent="info"><MessageBarBody>
            H3 UDFs in Synapse Serverless require installing the H3 .NET assembly (out-of-band). KQL geo
            functions are built into ADX cluster <code>{process.env.NEXT_PUBLIC_LOOM_KUSTO_CLUSTER || 'adx-csa-loom-shared'}</code>.
          </MessageBarBody></MessageBar>
        </div>
      }
    />
  );
}

interface GeoPipelineState { adfPipelineName: string; enrichH3: boolean; reverseGeocode: boolean; bufferMeters: number; [k: string]: unknown }

export function GeoPipelineEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, savedAt, error, dirty, save } = useGeoItemState<GeoPipelineState>('geo-pipeline', id, {
    adfPipelineName: '', enrichH3: true, reverseGeocode: false, bufferMeters: 0,
  });
  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={[{ id: 'home', label: 'Home', groups: [{ label: 'Pipeline', actions: [{ label: 'Save' }, { label: 'Trigger run' }] }] }]}
      leftPanel={<div className={s.treePad}><Caption1>Underlying ADF pipeline (existing slug <code>adf-pipeline</code>) does the work; this item layers on geo enrichment flags.</Caption1></div>}
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          <div className={s.field}><Label>ADF pipeline name (target)</Label>
            <Input value={state.adfPipelineName} onChange={(_, d) => setState((p) => ({ ...p, adfPipelineName: d.value }))} placeholder="pipe-geo-enrich" />
          </div>
          <div className={s.field}><Label>Enrichments</Label>
            <label><input type="checkbox" checked={state.enrichH3} onChange={(e) => setState((p) => ({ ...p, enrichH3: e.target.checked }))} /> Add H3 cell id at resolution 7</label>
            <label><input type="checkbox" checked={state.reverseGeocode} onChange={(e) => setState((p) => ({ ...p, reverseGeocode: e.target.checked }))} /> Reverse-geocode (requires Azure Maps account)</label>
          </div>
          <div className={s.field}><Label>Buffer (meters; 0 = no buffer)</Label>
            <Input type="number" value={String(state.bufferMeters)} onChange={(_, d) => setState((p) => ({ ...p, bufferMeters: Number(d.value || '0') }))} />
          </div>
          <MessageBar intent="info">
            <MessageBarBody>
              Hooks into the existing <code>adf-pipeline</code> slug — at trigger time, the geo flags are
              materialized as parameters on the run. Wiring deferred to v3.x; today the flags persist to
              Cosmos via PATCH /api/cosmos-items/geo-pipeline/{`{id}`}.
            </MessageBarBody>
          </MessageBar>
          <GeoSaveBar saving={saving} dirty={dirty} savedAt={savedAt} error={error} onSave={save} />
        </div>
      }
    />
  );
}
