'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Map editor (Fabric IQ Map — dataset binding + layers over Lakehouse/KQL/Ontology).
 *
 * Extracted verbatim from phase4-editors.tsx (behavior-preserving split —
 * zero logic change). Only the sibling-import paths were re-rooted one level
 * deeper (./x -> ../x) and shared helpers now come from ./shared.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner,
  Card, Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Tree, TreeItem, TreeItemLayout,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Dropdown, Option, Switch,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Bot24Regular, Database20Regular, Add20Regular, Sparkle20Regular,
  Link20Regular, Flash20Regular, Dismiss16Regular,
  ShieldCheckmark20Regular, Mail16Regular, ArrowSync16Regular,
  DataUsage20Regular, ArrowUpload16Regular,
  Settings20Regular, Money20Regular, BranchFork20Regular,
  Table20Regular, ChartMultiple20Regular,
  ArrowDownload16Regular, ArrowSortUp16Regular, ArrowSortDown16Regular,
  Save16Regular, DataTrending20Regular, Play20Regular, Pulse20Regular,
  Cube20Regular, Calculator20Regular, Ruler20Regular, Layer20Regular,
  ChevronRight16Regular, ChevronDown16Regular, ChevronLeft16Regular,
  Add16Regular, Edit16Regular, CheckmarkCircle20Regular, ArrowUndo16Regular,
} from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { getItem } from '@/lib/api/workspaces';
import type { MonitorRuleRecord } from '@/lib/azure/activator-monitor';
import { ItemEditorChrome } from '../item-editor-chrome';
import { NewItemBrowseGate } from '../new-item-gate';
import { safeModelJson } from '../model-fetch';
import { DataAgentResultViz } from '../data-agent-result-viz';
import { DataAgentConfigCopilotPanel } from '../data-agent-config-copilot';
import { mergeSuggestionIntoSources } from '../_da-config-merge';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { ComputePicker } from '@/lib/components/compute-picker';
import { KeyValueRows } from '@/lib/components/ui/key-value-rows';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { ForceDirectedGraph } from '@/lib/components/graph/force-directed-graph';
import { type MapLayer, type MapLayerType } from '@/lib/components/graph/geojson-map';
import {
  AzureMapsCanvas, AZURE_MAPS_STYLES, DEFAULT_BASEMAP, DEFAULT_CONTROLS,
  featurePropertyKeys, type AzureMapsView, type AzureMapsControls, type MapMeasure,
} from '@/lib/components/graph/azure-maps-canvas';
import { GraphTypeEditor } from '@/lib/components/graph/graph-type-editor';
import { GraphSourceBinding, type SourceBindable } from '@/lib/components/graph/graph-source-binding';
// Ontology typed-model (Foundry object/link/action types) — pure logic + types
// shared with the BFF routes. The typed-modeling surface in OntologyEditor drives
// this model; deriveSourceFromObjectTypes() keeps state.source in sync so the AGE
// instance/link/action routes keep resolving the declared type names.
import {
  migrateOntologyState, deriveSourceFromObjectTypes, normalizeOntoActionTypes, isOntoIdent,
  ONTO_BASE_TYPES, ONTO_BASE_TYPE_LABELS, ONTO_KEY_ELIGIBLE_TYPES, ONTO_STATUSES, ONTO_COLORS,
  ONTO_CARDINALITIES, ONTO_CARDINALITY_LABELS, ONTO_PARAM_TYPES, ONTO_PARAM_TYPE_LABELS, ONTO_ACTION_KINDS,
  type OntoObjectType, type OntoProperty, type OntoLinkType, type OntoActionType, type OntoActionParam,
  type OntoBaseType, type OntoCardinality, type OntoParamType, type OntoStatus, type OntoColor, type OntoDatasource,
} from '../ontology-model';
// Pure-logic helpers extracted for vitest coverage. See
// `lib/editors/__tests__/family-utils.test.ts`.
import {
  validateVarValue,
  parseOntologyHierarchy,
  computeGeoBbox,
  bboxToZoom,
  parseUdfFunctions,
  normalizeDaSources,
  daSupportsExampleQueries,
  shapeDaHistory,
  canSendDaQuestion,
  type VarType,
  type UdfFunction,
  type DaSourceType,
  type OntologyEntityBinding,
  type DaSource,
} from '../_family-utils';
import {
  cellKey, getCell, rowTotal, periodTotal, grandTotal,
  cloneScenarioCells, dropScenarioCells, computeVariance, newId,
  defaultScenarios, defaultPlanningSheet,
  flattenPlanCells, filterPlanRows, sortPlanRows,
  periodSeries, forecastPeriods, linearFit, ganttLayout, planInsights,
  applyMappingsToActuals,
  // EPM core — cube model, member hierarchies, roll-ups, guided formulas.
  emptyPlanModel, defaultPlanModel, orderMembers,
  orderedLineItems, lineItemValueAt, lineItemRowTotal, leafInputItems,
  evalFormula, formulaToText, validateModel, validateFormulaRows,
  qfSum, qfAverage, qfDifference, qfRatioPct, qfGrowthPct,
  type PlanScenario, type PlanScenarioKind,
  type PlanningSheet, type PlanSemanticModelRef, type PlanBackingDb,
  type PlanCellRow, type PlanRowSortKey, type PeriodPoint, type GanttBar,
  type PlanSourceMapping, type PlanLineItem,
  type PlanModel, type PlanDimension, type PlanMember, type PlanMeasure,
  type PlanAggKind, type PlanDimensionAxis, type PlanFormulaToken,
  type PlanFormulaFn, type PlanFormulaOp, type ModelIssue,
} from '../_plan-model';
import { arr, useItemState, SaveBar, useStyles } from './shared';

// ----- Map (Fabric IQ Map — dataset binding + layers over Lakehouse/KQL/Ontology) -----
const GEO_SAMPLE = `{\n  "type": "FeatureCollection",\n  "features": [\n    { "type": "Feature", "properties": { "name": "Seattle" }, "geometry": { "type": "Point", "coordinates": [-122.33, 47.61] } }\n  ]\n}`;

/** Persisted data-source binding for the map (audit H7). */
interface MapBinding {
  source: '' | 'lakehouse' | 'kql' | 'ontology';
  // lakehouse (Synapse Serverless)
  database?: string; table?: string; sql?: string;
  // kql (ADX)
  kqlItemId?: string; db?: string; kql?: string;
  // ontology (Weave/AGE)
  ontologyItemId?: string; objectType?: string;
  latProp?: string; lonProp?: string; valueProp?: string; labelProp?: string;
  // shared column mapping (lakehouse/kql)
  latCol?: string; lonCol?: string; valueCol?: string; labelCol?: string;
  top?: number;
}
interface MapState {
  geojson: string;
  binding?: MapBinding;
  layers?: MapLayer[];
  /** Persisted interactive-canvas basemap style (one of AZURE_MAPS_STYLES). */
  basemap?: string;
  /** Persisted built-in map controls. */
  controls?: AzureMapsControls;
  /** Persisted camera view (center/zoom/bearing/pitch + auto-zoom). */
  view?: AzureMapsView;
  /** Persisted drawn annotations (GeoJSON FeatureCollection from the drawing tools). */
  annotations?: unknown;
  /** Persisted geocoding address list (one per line) for the address→lat/lon tool. */
  geocodeAddresses?: string;
  [k: string]: unknown;
}

const DEFAULT_LAYERS: MapLayer[] = [
  { id: 'pt', type: 'point', enabled: true, radius: 5 },
  { id: 'heat', type: 'heatmap', enabled: false, weightProp: 'value', radius: 26 },
];

/** Build a GeoJSON FeatureCollection from {lat,lon,value?,label?} geo rows. */
function geoRowsToGeoJSON(rows: Array<{ lat: number; lon: number; value?: number; label?: string }>): string {
  const features = rows.map((r) => ({
    type: 'Feature',
    properties: {
      ...(r.label != null ? { name: r.label } : {}),
      ...(r.value != null ? { value: r.value } : {}),
    },
    geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
  }));
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
}

interface ItemLite { id: string; displayName: string }

export function MapEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<MapState>('map', id, {
    geojson: GEO_SAMPLE, binding: { source: '' }, layers: DEFAULT_LAYERS,
  });
  const [validateMsg, setValidateMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [tab, setTab] = useState<'data' | 'json'>('data');

  // Source-item pickers (KQL databases / ontologies in the tenant).
  const [kqlItems, setKqlItems] = useState<ItemLite[] | null>(null);
  const [ontologyItems, setOntologyItems] = useState<ItemLite[] | null>(null);

  // Binding run state.
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const binding: MapBinding = state.binding || { source: '' };
  const layers: MapLayer[] = state.layers && state.layers.length ? state.layers : DEFAULT_LAYERS;

  const setBinding = useCallback((patch: Partial<MapBinding>) => {
    setState((p) => ({ ...p, binding: { ...(p.binding || { source: '' }), ...patch } }));
  }, [setState]);

  // Lazy-load pickers when the relevant source is chosen.
  useEffect(() => {
    if (binding.source === 'kql' && kqlItems === null) {
      clientFetch('/api/items?type=kql-database').then((r) => r.json()).then((j) => setKqlItems((j?.items || []).map((it: any) => ({ id: it.id, displayName: it.displayName })))).catch(() => setKqlItems([]));
    }
    if (binding.source === 'ontology' && ontologyItems === null) {
      clientFetch('/api/items?type=ontology').then((r) => r.json()).then((j) => setOntologyItems((j?.items || []).map((it: any) => ({ id: it.id, displayName: it.displayName })))).catch(() => setOntologyItems([]));
    }
  }, [binding.source, kqlItems, ontologyItems]);

  let parseErr: string | null = null;
  let featureCount = 0;
  let parsedGeo: unknown = null;
  let bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number } | null = null;
  try {
    const j = JSON.parse(state.geojson);
    parsedGeo = j;
    featureCount = Array.isArray(j?.features) ? j.features.length : 0;
    bbox = computeGeoBbox(j);
  } catch (e: any) { parseErr = e?.message || String(e); }

  // Client-side subscription-key fallback: when the BFF token route gates but a
  // public key is present, the interactive canvas still lights up the basemap.
  const mapsKey = process.env.NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY || undefined;

  // ── Interactive Azure Maps canvas config (persisted in item state) ───────────
  const basemap = state.basemap || DEFAULT_BASEMAP;
  const mapControls: AzureMapsControls = state.controls || DEFAULT_CONTROLS;
  const view: AzureMapsView = state.view || { autoZoom: true };
  const tooltipFieldKeys = useMemo(() => featurePropertyKeys(parsedGeo), [parsedGeo]);

  const setView = useCallback((v: AzureMapsView) => {
    setState((p) => ({ ...p, view: { ...(p.view || { autoZoom: true }), ...v } }));
  }, [setState]);
  const setBasemap = useCallback((style: string) => {
    setState((p) => ({ ...p, basemap: style }));
  }, [setState]);
  const setControl = useCallback((patch: Partial<AzureMapsControls>) => {
    setState((p) => ({ ...p, controls: { ...DEFAULT_CONTROLS, ...(p.controls || {}), ...patch } }));
  }, [setState]);
  const setAutoZoom = useCallback((on: boolean) => {
    setState((p) => ({ ...p, view: { ...(p.view || {}), autoZoom: on } }));
  }, [setState]);

  // Fullscreen the live map (Fullscreen API on the wrapper; the canvas fills it).
  const mapWrapRef = useRef<HTMLDivElement | null>(null);
  const [isFs, setIsFs] = useState(false);
  useEffect(() => {
    const h = () => setIsFs(typeof document !== 'undefined' && !!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = mapWrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
    else { el.requestFullscreen?.().catch(() => {}); }
  }, []);
  const mapHeight = isFs ? Math.max(480, (typeof window !== 'undefined' ? window.innerHeight : 900) - 8) : 460;

  const runValidate = useCallback(() => {
    try {
      const j = JSON.parse(state.geojson);
      const fc = Array.isArray(j?.features) ? j.features.length : 0;
      setValidateMsg({ intent: 'success', text: `Valid GeoJSON — ${fc} feature(s) parsed.` });
    } catch (e: any) {
      setValidateMsg({ intent: 'error', text: `Invalid JSON: ${e?.message || String(e)}` });
    }
  }, [state.geojson]);

  // Run the binding against the real backend and fold the geo rows into the
  // map's GeoJSON so every layer renders live data (audit H7).
  const runBinding = useCallback(async () => {
    if (!binding.source) { setRunMsg({ intent: 'error', text: 'Pick a data source first.' }); return; }
    if (!id || id === 'new') { setRunMsg({ intent: 'error', text: 'Save the map once so it has an id, then bind data.' }); return; }
    setRunning(true); setRunMsg(null);
    try {
      const r = await clientFetch(`/api/items/map/${encodeURIComponent(id)}/data`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ binding }),
      });
      const j = await r.json();
      if (!j.ok) {
        setRunMsg({ intent: j.code && /not_configured|503/.test(String(j.code)) ? 'warning' : 'error', text: j.error || `HTTP ${r.status}` });
        return;
      }
      const rows = j.rows || [];
      setState((p) => ({ ...p, geojson: geoRowsToGeoJSON(rows) }));
      setRunMsg({ intent: rows.length ? 'success' : 'warning', text: `Bound ${rows.length} geo row(s) from ${binding.source}${j.total != null ? ` (${j.total} total)` : ''}. They render in the layers below — Save to persist.` });
    } catch (e: any) {
      setRunMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setRunning(false); }
  }, [binding, id, setState]);

  // ── Drawing annotations (persist drawn shapes to state.annotations) ──────────
  const [drawing, setDrawing] = useState(false);
  const [measure, setMeasure] = useState<MapMeasure | null>(null);
  const onAnnotationsChange = useCallback((fc: { type: 'FeatureCollection'; features: unknown[] }) => {
    setState((p) => ({ ...p, annotations: fc }));
  }, [setState]);
  const annotationCount = Array.isArray((state.annotations as any)?.features) ? (state.annotations as any).features.length : 0;

  // ── Geocoding (address → lat/lon via Azure Maps Search REST; honest 503 gate) ─
  const [geocoding, setGeocoding] = useState(false);
  const [geoMsg, setGeoMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const geocodeAddresses = String(state.geocodeAddresses || '');
  const setGeocodeAddresses = useCallback((v: string) => setState((p) => ({ ...p, geocodeAddresses: v })), [setState]);

  const runGeocode = useCallback(async () => {
    if (!id || id === 'new') { setGeoMsg({ intent: 'error', text: 'Save the map once so it has an id, then geocode.' }); return; }
    const addresses = geocodeAddresses.split(/\r?\n/).map((a) => a.trim()).filter(Boolean);
    if (!addresses.length) { setGeoMsg({ intent: 'error', text: 'Enter one or more addresses (one per line).' }); return; }
    setGeocoding(true); setGeoMsg(null);
    try {
      const r = await clientFetch(`/api/items/map/${encodeURIComponent(id)}/geocode`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ addresses }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (!j.ok) {
        setGeoMsg({ intent: j.code === 'maps_not_configured' ? 'warning' : 'error', text: j.error || `HTTP ${r.status}` });
        return;
      }
      const rows = (j.rows || []) as Array<{ lat: number; lon: number; value?: number; label?: string }>;
      setState((p) => ({ ...p, geojson: geoRowsToGeoJSON(rows) }));
      setGeoMsg({
        intent: rows.length ? 'success' : 'warning',
        text: `Geocoded ${j.geocoded}/${j.total} address(es)${j.failed ? `, ${j.failed} unresolved` : ''}. Plotted on the map — Save to persist.`,
      });
    } catch (e: any) {
      setGeoMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setGeocoding(false); }
  }, [id, geocodeAddresses, setState]);

  // Pull the currently-bound features' labels into the geocode box — the
  // "address column" flow: bind rows whose label is a street address, then
  // geocode those labels to precise lat/lon.
  const useBoundLabelsAsAddresses = useCallback(() => {
    try {
      const j = JSON.parse(state.geojson);
      const feats = Array.isArray(j?.features) ? j.features : [];
      const labels = feats
        .map((f: any) => f?.properties?.name ?? f?.properties?.label ?? f?.properties?.title)
        .filter((x: any) => x != null)
        .map((x: any) => String(x));
      if (!labels.length) { setGeoMsg({ intent: 'warning', text: 'No label/name values in the current features to use as addresses.' }); return; }
      setGeocodeAddresses(Array.from(new Set(labels)).join('\n'));
    } catch { setGeoMsg({ intent: 'error', text: 'Current GeoJSON is invalid; cannot extract labels.' }); }
  }, [state.geojson, setGeocodeAddresses]);

  const setLayer = useCallback((lid: string, patch: Partial<MapLayer>) => {
    setState((p) => {
      const cur = (p.layers && p.layers.length ? p.layers : DEFAULT_LAYERS);
      return { ...p, layers: cur.map((l) => (l.id === lid ? { ...l, ...patch } : l)) };
    });
  }, [setState]);

  const addLayer = useCallback((type: MapLayerType) => {
    setState((p) => {
      const cur = (p.layers && p.layers.length ? p.layers : DEFAULT_LAYERS);
      const nl: MapLayer = { id: `${type}-${Date.now().toString(36)}`, type, enabled: true, weightProp: 'value', radius: type === 'heatmap' ? 26 : type === 'cluster' ? 10 : 5 };
      return { ...p, layers: [...cur, nl] };
    });
  }, [setState]);

  const removeLayer = useCallback((lid: string) => {
    setState((p) => ({ ...p, layers: (p.layers || DEFAULT_LAYERS).filter((l) => l.id !== lid) }));
  }, [setState]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Layer', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: running ? 'Binding…' : 'Run binding', onClick: runBinding, disabled: running || !binding.source },
        { label: 'Validate', onClick: runValidate },
      ]},
      { label: 'Add layer', actions: [
        { label: '+ Point', onClick: () => addLayer('point') },
        { label: '+ Heatmap', onClick: () => addLayer('heatmap') },
        { label: '+ Cluster', onClick: () => addLayer('cluster') },
        { label: '+ Choropleth', onClick: () => addLayer('choropleth') },
      ]},
      { label: 'Tools', actions: [
        { label: drawing ? 'Drawing on' : 'Draw / measure', onClick: () => setDrawing((v) => !v), title: 'Toggle the drawing + spherical measure toolbar on the map' },
        { label: geocoding ? 'Geocoding…' : 'Geocode', onClick: runGeocode, disabled: geocoding, title: 'Geocode the addresses entered in the Data binding tab' },
      ]},
    ]},
  ], [save, saving, dirty, running, runBinding, binding.source, runValidate, addLayer, drawing, geocoding, runGeocode]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'data' | 'json')}>
          <Tab value="data">Data binding</Tab>
          <Tab value="json">GeoJSON (manual)</Tab>
        </TabList>

        {tab === 'data' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            <Subtitle2>Data source</Subtitle2>
            <Caption1>Bind this map to a Lakehouse table, a KQL query, or an Ontology entity. Loom runs it against the real Azure backend (Synapse Serverless / ADX / Weave) — no Power BI or Fabric required.</Caption1>
            <Field label="Source">
              <Dropdown
                placeholder="Pick a data source"
                value={binding.source ? ({ lakehouse: 'Lakehouse (Synapse SQL)', kql: 'KQL (Azure Data Explorer)', ontology: 'Ontology (Weave)' } as any)[binding.source] : ''}
                selectedOptions={binding.source ? [binding.source] : []}
                onOptionSelect={(_, d) => setBinding({ source: (d.optionValue as MapBinding['source']) || '' })}
              >
                <Option value="lakehouse" text="Lakehouse (Synapse SQL)">Lakehouse (Synapse SQL)</Option>
                <Option value="kql" text="KQL (Azure Data Explorer)">KQL (Azure Data Explorer)</Option>
                <Option value="ontology" text="Ontology (Weave)">Ontology (Weave)</Option>
              </Dropdown>
            </Field>

            {binding.source === 'lakehouse' && (
              <>
                <Field label="Database (Synapse Serverless DB)" hint="e.g. loom_lakehouse, or a paired mirror DB">
                  <Input value={binding.database || ''} onChange={(_, d) => setBinding({ database: d.value })} placeholder="loom_lakehouse" />
                </Field>
                <Field label="Table / view (or use a SQL query below)">
                  <Input value={binding.table || ''} onChange={(_, d) => setBinding({ table: d.value })} placeholder="[dbo].[stores]" />
                </Field>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                  <Field label="Latitude column"><Input value={binding.latCol || ''} onChange={(_, d) => setBinding({ latCol: d.value })} placeholder="lat" /></Field>
                  <Field label="Longitude column"><Input value={binding.lonCol || ''} onChange={(_, d) => setBinding({ lonCol: d.value })} placeholder="lon" /></Field>
                  <Field label="Value column (optional)"><Input value={binding.valueCol || ''} onChange={(_, d) => setBinding({ valueCol: d.value })} placeholder="revenue" /></Field>
                  <Field label="Label column (optional)"><Input value={binding.labelCol || ''} onChange={(_, d) => setBinding({ labelCol: d.value })} placeholder="name" /></Field>
                </div>
                <Field label="SQL override (optional — alias columns lat, lon, value, label)">
                  <Textarea value={binding.sql || ''} onChange={(_, d) => setBinding({ sql: d.value })} placeholder="SELECT TOP 500 latitude AS lat, longitude AS lon, sales AS value, store AS label FROM [dbo].[stores]" />
                </Field>
              </>
            )}

            {binding.source === 'kql' && (
              <>
                <Field label="KQL database item">
                  <Dropdown
                    placeholder={kqlItems === null ? 'Loading…' : 'Pick a KQL database'}
                    value={kqlItems?.find((k) => k.id === binding.kqlItemId)?.displayName || ''}
                    selectedOptions={binding.kqlItemId ? [binding.kqlItemId] : []}
                    onOptionSelect={(_, d) => setBinding({ kqlItemId: d.optionValue })}
                  >
                    {(kqlItems || []).map((k) => <Option key={k.id} value={k.id} text={k.displayName}>{k.displayName}</Option>)}
                  </Dropdown>
                </Field>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                  <Field label="Table"><Input value={binding.table || ''} onChange={(_, d) => setBinding({ table: d.value })} placeholder="Sightings" /></Field>
                  <Field label="Latitude column"><Input value={binding.latCol || ''} onChange={(_, d) => setBinding({ latCol: d.value })} placeholder="lat" /></Field>
                  <Field label="Longitude column"><Input value={binding.lonCol || ''} onChange={(_, d) => setBinding({ lonCol: d.value })} placeholder="lon" /></Field>
                  <Field label="Value column (optional)"><Input value={binding.valueCol || ''} onChange={(_, d) => setBinding({ valueCol: d.value })} placeholder="magnitude" /></Field>
                </div>
                <Field label="KQL override (optional — project lat, lon, value, label)">
                  <Textarea value={binding.kql || ''} onChange={(_, d) => setBinding({ kql: d.value })} placeholder={'Sightings\n| project lat=Latitude, lon=Longitude, value=Magnitude\n| take 500'} />
                </Field>
              </>
            )}

            {binding.source === 'ontology' && (
              <>
                <Field label="Ontology item">
                  <Dropdown
                    placeholder={ontologyItems === null ? 'Loading…' : 'Pick an ontology'}
                    value={ontologyItems?.find((o) => o.id === binding.ontologyItemId)?.displayName || ''}
                    selectedOptions={binding.ontologyItemId ? [binding.ontologyItemId] : []}
                    onOptionSelect={(_, d) => setBinding({ ontologyItemId: d.optionValue })}
                  >
                    {(ontologyItems || []).map((o) => <Option key={o.id} value={o.id} text={o.displayName}>{o.displayName}</Option>)}
                  </Dropdown>
                </Field>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                  <Field label="Object type (declared class)"><Input value={binding.objectType || ''} onChange={(_, d) => setBinding({ objectType: d.value })} placeholder="Store" /></Field>
                  <Field label="Latitude property"><Input value={binding.latProp || ''} onChange={(_, d) => setBinding({ latProp: d.value })} placeholder="lat" /></Field>
                  <Field label="Longitude property"><Input value={binding.lonProp || ''} onChange={(_, d) => setBinding({ lonProp: d.value })} placeholder="lon" /></Field>
                  <Field label="Value property (optional)"><Input value={binding.valueProp || ''} onChange={(_, d) => setBinding({ valueProp: d.value })} placeholder="footfall" /></Field>
                  <Field label="Label property (optional)"><Input value={binding.labelProp || ''} onChange={(_, d) => setBinding({ labelProp: d.value })} placeholder="name" /></Field>
                </div>
              </>
            )}

            {binding.source && (
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
                <Button appearance="primary" disabled={running} onClick={runBinding}>{running ? 'Binding…' : 'Run binding'}</Button>
                <Caption1>Runs the source live, then renders the rows in the layers below.</Caption1>
              </div>
            )}
            {runMsg && <MessageBar intent={runMsg.intent}><MessageBarBody>{runMsg.text}</MessageBarBody></MessageBar>}

            <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Layers &amp; symbology</Subtitle2>
            {layers.map((l) => (
              <div key={l.id} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, boxShadow: tokens.shadow2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                  <Switch checked={l.enabled !== false} onChange={(_, d) => setLayer(l.id, { enabled: d.checked })} />
                  <Badge appearance="tint" color="brand">{l.type}</Badge>
                  <div style={{ flex: 1 }} />
                  <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => removeLayer(l.id)}>Remove</Button>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <Field label="Weight / value property" style={{ minWidth: 160 }}>
                    <Input value={l.weightProp || ''} onChange={(_, d) => setLayer(l.id, { weightProp: d.value || undefined })} placeholder="value" />
                  </Field>
                  {l.type === 'point' && (
                    <Field label="Size by metric">
                      <Switch checked={!!l.sizeByMetric} onChange={(_, d) => setLayer(l.id, { sizeByMetric: d.checked })} label={l.sizeByMetric ? 'On' : 'Off'} />
                    </Field>
                  )}
                  {l.type === 'point' && l.sizeByMetric ? (
                    <>
                      <Field label="Min px" style={{ minWidth: 80 }}>
                        <Input type="number" value={String(l.sizeMin ?? '')} onChange={(_, d) => setLayer(l.id, { sizeMin: Number(d.value) || undefined })} placeholder="6" />
                      </Field>
                      <Field label="Max px" style={{ minWidth: 80 }}>
                        <Input type="number" value={String(l.sizeMax ?? '')} onChange={(_, d) => setLayer(l.id, { sizeMax: Number(d.value) || undefined })} placeholder="28" />
                      </Field>
                    </>
                  ) : (l.type !== 'choropleth' && (
                    <Field label="Radius (px)" style={{ minWidth: 90 }}>
                      <Input type="number" value={String(l.radius ?? '')} onChange={(_, d) => setLayer(l.id, { radius: Number(d.value) || undefined })} placeholder={l.type === 'heatmap' ? '26' : '7'} />
                    </Field>
                  ))}
                  <Field label="Opacity" style={{ minWidth: 90 }}>
                    <Input type="number" min={0} max={1} step={0.05} value={String(l.opacity ?? '')} onChange={(_, d) => setLayer(l.id, { opacity: d.value === '' ? undefined : Math.max(0, Math.min(1, Number(d.value))) })} placeholder="0.85" />
                  </Field>
                  <Field label="Min zoom" style={{ minWidth: 80 }}>
                    <Input type="number" value={String(l.minZoom ?? '')} onChange={(_, d) => setLayer(l.id, { minZoom: d.value === '' ? undefined : Number(d.value) })} placeholder="0" />
                  </Field>
                  <Field label="Max zoom" style={{ minWidth: 80 }}>
                    <Input type="number" value={String(l.maxZoom ?? '')} onChange={(_, d) => setLayer(l.id, { maxZoom: d.value === '' ? undefined : Number(d.value) })} placeholder="22" />
                  </Field>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  {l.weightProp ? (
                    <>
                      <Field label="Color low" style={{ minWidth: 130 }}>
                        <Input value={l.colorLow || ''} onChange={(_, d) => setLayer(l.id, { colorLow: d.value || undefined })} placeholder="#cfe4fa"
                          contentBefore={<span style={{ width: 12, height: 12, borderRadius: 3, display: 'inline-block', backgroundColor: l.colorLow || '#cfe4fa' }} />} />
                      </Field>
                      <Field label="Color high" style={{ minWidth: 130 }}>
                        <Input value={l.colorHigh || ''} onChange={(_, d) => setLayer(l.id, { colorHigh: d.value || undefined })} placeholder="#0f6cbd"
                          contentBefore={<span style={{ width: 12, height: 12, borderRadius: 3, display: 'inline-block', backgroundColor: l.colorHigh || '#0f6cbd' }} />} />
                      </Field>
                    </>
                  ) : (
                    <Field label="Color" style={{ minWidth: 130 }}>
                      <Input value={l.color || ''} onChange={(_, d) => setLayer(l.id, { color: d.value || undefined })} placeholder="#0f6cbd"
                        contentBefore={<span style={{ width: 12, height: 12, borderRadius: 3, display: 'inline-block', backgroundColor: l.color || '#0f6cbd' }} />} />
                    </Field>
                  )}
                  {l.type !== 'heatmap' && (
                    <Field label="Tooltip fields" style={{ minWidth: 220 }}>
                      <Dropdown
                        multiselect
                        placeholder={tooltipFieldKeys.length ? 'All fields' : 'Run binding to populate'}
                        selectedOptions={l.tooltipFields || []}
                        value={(l.tooltipFields || []).join(', ')}
                        onOptionSelect={(_, d) => setLayer(l.id, { tooltipFields: d.selectedOptions })}
                      >
                        {tooltipFieldKeys.map((k) => <Option key={k} value={k} text={k}>{k}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                </div>
              </div>
            ))}
            <Caption1>Add more from the ribbon (Point / Heatmap / Cluster / Choropleth). Choropleth shades Polygon features by weight; the others place glyphs at point geometry. Symbology persists with the map.</Caption1>

            {/* ── Address geocoding (Azure Maps Search REST) ─────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, boxShadow: tokens.shadow2, marginTop: tokens.spacingVerticalS }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                <Layer20Regular style={{ color: tokens.colorBrandForeground1 }} />
                <Subtitle2>Geocode addresses</Subtitle2>
                <Badge appearance="tint" color="brand">Azure Maps Search</Badge>
              </div>
              <Caption1>
                Resolve street addresses to lat/lon through the Azure-native Azure Maps <strong>Search</strong> REST API (no Power BI / Fabric). Paste one address per line, or pull the labels from features you already bound above, then plot them. Without an Azure Maps account you get an honest gate naming the env var to set.
              </Caption1>
              <Field label="Addresses (one per line)">
                <Textarea
                  value={geocodeAddresses}
                  onChange={(_, d) => setGeocodeAddresses(d.value)}
                  placeholder={'1 Microsoft Way, Redmond, WA\n350 5th Ave, New York, NY\nEiffel Tower, Paris'}
                  resize="vertical"
                  style={{ minHeight: 96 }}
                />
              </Field>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button appearance="primary" disabled={geocoding} onClick={runGeocode}>{geocoding ? 'Geocoding…' : 'Geocode & plot'}</Button>
                <Button appearance="secondary" disabled={geocoding} onClick={useBoundLabelsAsAddresses}>Use bound labels</Button>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Replaces the map features with the geocoded points.</Caption1>
              </div>
              {geoMsg && <MessageBar intent={geoMsg.intent}><MessageBarBody>{geoMsg.text}</MessageBarBody></MessageBar>}
            </div>
          </div>
        )}

        {tab === 'json' && (
          <>
            <Subtitle2>GeoJSON ({featureCount} feature{featureCount === 1 ? '' : 's'})</Subtitle2>
            <Caption1>Edited directly, or populated by Run binding. The map below renders it through the configured layers.</Caption1>
            <MonacoTextarea value={state.geojson} onChange={(v) => setState((p) => ({ ...p, geojson: v }))} language="json" height={280} minHeight={200} ariaLabel="GeoJSON" />
            {parseErr && <MessageBar intent="error"><MessageBarBody>Invalid JSON: {parseErr}</MessageBarBody></MessageBar>}
            {validateMsg && <MessageBar intent={validateMsg.intent}><MessageBarBody>{validateMsg.text}</MessageBarBody></MessageBar>}
          </>
        )}

        {parseErr ? (
          <MessageBar intent="error"><MessageBarBody>Cannot render the map — invalid GeoJSON: {parseErr}</MessageBarBody></MessageBar>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
              <Subtitle2 style={{ marginRight: tokens.spacingHorizontalS }}>Map</Subtitle2>
              <Field label="Basemap" orientation="horizontal">
                <Dropdown
                  value={AZURE_MAPS_STYLES.find((o) => o.value === basemap)?.label || basemap}
                  selectedOptions={[basemap]}
                  onOptionSelect={(_, d) => d.optionValue && setBasemap(d.optionValue)}
                  style={{ minWidth: 180 }}
                >
                  {AZURE_MAPS_STYLES.map((o) => <Option key={o.value} value={o.value} text={o.label}>{o.label}</Option>)}
                </Dropdown>
              </Field>
              <Switch checked={view.autoZoom !== false} onChange={(_, d) => setAutoZoom(d.checked)} label="Auto-zoom to data" />
              <Switch checked={drawing} onChange={(_, d) => setDrawing(d.checked)} label="Draw / measure" />
              <div style={{ flex: 1 }} />
              {measure && (
                <Badge
                  appearance="tint"
                  color={measure.mode === 'error' ? 'danger' : 'brand'}
                  icon={<Ruler20Regular />}
                >
                  {measure.text}
                </Badge>
              )}
              <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Controls:</Caption1>
                <Switch checked={mapControls.zoom !== false} onChange={(_, d) => setControl({ zoom: d.checked })} label="Zoom" />
                <Switch checked={mapControls.compass !== false} onChange={(_, d) => setControl({ compass: d.checked })} label="Compass" />
                <Switch checked={mapControls.pitch !== false} onChange={(_, d) => setControl({ pitch: d.checked })} label="Pitch" />
                <Switch checked={mapControls.scale !== false} onChange={(_, d) => setControl({ scale: d.checked })} label="Scale" />
                <Button size="small" appearance="subtle" onClick={toggleFullscreen}>{isFs ? 'Exit full screen' : 'Full screen'}</Button>
              </span>
            </div>
            <div ref={mapWrapRef} style={{ width: '100%', backgroundColor: tokens.colorNeutralBackground1 }}>
              <AzureMapsCanvas
                tokenUrl={`/api/items/map/${encodeURIComponent(id)}/map-token`}
                fallbackSubscriptionKey={mapsKey}
                geojson={parsedGeo}
                layers={layers}
                style={basemap}
                controls={mapControls}
                view={view}
                onViewChange={setView}
                height={mapHeight}
                drawingEnabled={drawing}
                annotations={state.annotations}
                onAnnotationsChange={onAnnotationsChange}
                onMeasure={setMeasure}
              />
            </div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Pan, scroll to zoom, right-drag to rotate/tilt. Turn off Auto-zoom to pin a custom center/zoom (saved with the map). Hover or click a feature for its tooltip. Toggle <strong>Draw / measure</strong> for the drawing toolbar (point, line, polygon, rectangle, circle + edit/erase) with a live spherical distance/area readout; drawn shapes{annotationCount ? ` (${annotationCount})` : ''} save with the map. The basemap uses Azure Maps (no Power BI / Fabric); without an account a vector overlay still renders.
            </Caption1>
          </>
        )}
        <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}

