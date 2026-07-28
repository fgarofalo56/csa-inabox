'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * KqlDashboardEditor — extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * Fabric Real-Time Dashboard parity on the Azure-native ADX cluster (no Fabric
 * required): a tile grid with per-tile KQL bound to a data source + visual type
 * rendering REAL Kusto results, a data-sources panel, dashboard parameters
 * substituted into tile KQL, auto/manual refresh, and Save persisting the model
 * to Cosmos via /api/items/kql-dashboard/[id].
 *
 * U8 depth (flag `u8-kql-dashboard-depth`): multi-page tile containers with a
 * page strip, markdown text tiles, and drill-through that navigates to a
 * target page after injecting the clicked value.
 *
 * Decomposition (per the extend-vs-decompose convention): the parameter/filter
 * bar lives in ./kql-dashboard-parameters (shared Dash* param types +
 * TIME_ORDER), the page strip in ./kql-dashboard-page-strip, and the
 * conditional-formatting editor (+ CfColumnField) in
 * ./kql-dashboard-conditional-format. The shared tile-render surface
 * (TileVisual + CSV/download helpers + KqlResult / TileViz models) is imported
 * from ./kql-results; the shared phase3 styles hook from ./styles.
 * phase3-editors.tsx re-exports KqlDashboardEditor from a barrel line so the
 * registry resolves it unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Caption1, Badge, Button, Input, Spinner, Field, Link,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Select, Textarea,
  Skeleton, SkeletonItem,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Play20Regular, Save20Regular,
  Add20Regular, Add24Regular, Delete20Regular, ArrowSync20Regular,
  MathFormula20Regular, Sparkle20Regular, ArrowDownload20Regular, Copy20Regular,
  Alert20Regular, Open20Regular, TextT20Regular,
  // ux-fabric-a W1 — tile drag-reorder grip (Fabric RTD tiles drag by a grab
  // handle in the tile header; the same glyph the report canvas cards use).
  ReOrderDotsVertical16Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import { NewItemCreateGate } from '../new-item-gate';
import { EmptyState } from '@/lib/components/empty-state';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { ToolbarCrossLinks } from '@/lib/components/shared/item-tab-strip';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import { renderMarkdown } from '@/lib/notebook/render-markdown';
import {
  resolveTilePageId,
  type ConditionalRule,
} from '@/lib/azure/kql-dashboard-model';
import { CfColumnField, ConditionalFormattingEditor } from './kql-dashboard-conditional-format';
import {
  TileVisual, kqlResultToCsv, downloadTextFile, slugifyForFile,
  type KqlResult, type TileViz,
} from './kql-results';
import {
  DashboardParameterBar, TIME_ORDER,
  type DashParam, type DashParamType, type DashParamDataType, type DashDataSource, type TimeRangeKey,
} from './kql-dashboard-parameters';
import { DashboardPageStrip, type DashPage } from './kql-dashboard-page-strip';
import { AnomalyForecastDialog } from './anomaly-forecast';
import { mapWithConcurrency } from '@/lib/util/concurrency';
import { useStyles } from './styles';
import { AskAffordance } from '@/lib/components/ask/AskAffordance';

/** PSR-7 — max tiles queried in parallel during a full-board refresh. Bounded so
 *  a large board fans out fast without tripping the ADX query rate-limiter. */
const DASHBOARD_TILE_CONCURRENCY = 4;

/**
 * Fabric Real-Time-Dashboard-grade tile chrome (UI-only): resting elevation
 * that lifts on hover, a header divider, a title that ellipsises, a per-tile
 * action toolbar that reveals on hover / keyboard focus (and stays pinned while
 * the tile is being edited), and a themed ghost "add tile". No handlers change
 * — the `.tile-actions` cluster is the same real actions, just chrome.
 */
const useTileChrome = makeStyles({
  tile: {
    position: 'relative',
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, border-color',
    transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16, border: `1px solid ${tokens.colorNeutralStroke1}` },
    '& .tile-actions': {
      opacity: 0,
      transitionProperty: 'opacity',
      transitionDuration: tokens.durationFaster,
    },
    ':hover .tile-actions': { opacity: 1 },
    ':focus-within .tile-actions': { opacity: 1 },
    // The resize grip + drag grip reveal with the same hover/focus rhythm as
    // the action cluster (no persistent clutter — operator standard).
    '& .tile-grip': {
      opacity: 0,
      transitionProperty: 'opacity',
      transitionDuration: tokens.durationFaster,
    },
    ':hover .tile-grip': { opacity: 1 },
    ':focus-within .tile-grip': { opacity: 1 },
  },
  tileSelected: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    boxShadow: tokens.shadow16,
    '& .tile-actions': { opacity: 1 },
    '& .tile-grip': { opacity: 1 },
  },
  /** ux-fabric-a W1 — the tile being dragged (fades while in flight). */
  tileDragging: { opacity: 0.55 },
  /** Drop indicators — a brand inset edge on the side the tile will land. */
  tileDropBefore: { boxShadow: `inset 3px 0 0 0 ${tokens.colorBrandStroke1}, ${tokens.shadow16}` },
  tileDropAfter: { boxShadow: `inset -3px 0 0 0 ${tokens.colorBrandStroke1}, ${tokens.shadow16}` },
  /** Drag handle in the tile header — grab cursor, brightens on hover. */
  dragGrip: {
    display: 'inline-flex', alignItems: 'center', flexShrink: 0, cursor: 'grab',
    color: tokens.colorNeutralForeground4, borderRadius: tokens.borderRadiusSmall,
    ':hover': { color: tokens.colorBrandForeground1, backgroundColor: tokens.colorNeutralBackground1Hover },
    ':active': { cursor: 'grabbing' },
  },
  /** Corner resize grip — drag snaps the tile's real w/h grid spans. */
  resizeGrip: {
    position: 'absolute', right: '2px', bottom: '2px', width: '14px', height: '14px',
    cursor: 'nwse-resize', touchAction: 'none',
    borderRight: `2px solid ${tokens.colorNeutralStroke1}`,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`,
    borderBottomRightRadius: tokens.borderRadiusSmall,
    ':hover': {
      borderRight: `2px solid ${tokens.colorBrandStroke1}`,
      borderBottom: `2px solid ${tokens.colorBrandStroke1}`,
    },
  },
  /** Per-tile timing/status footer (rows · duration · updated-at). */
  tileFooter: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXS, paddingTop: tokens.spacingVerticalXXS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3, minWidth: 0, flexWrap: 'wrap',
  },
  tileFooterText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tileHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tileMeta: { minWidth: 0, flex: 1 },
  tileTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tileActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalXXS,
    flexShrink: 0,
  },
  ghostTile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    minHeight: '120px',
    padding: tokens.spacingVerticalL,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color, color',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      border: `1px dashed ${tokens.colorBrandStroke1}`,
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorBrandForeground1,
    },
    ':focus-visible': { border: `1px dashed ${tokens.colorBrandStroke1}`, outlineStyle: 'none' },
  },
  /** U8 — text (markdown) tile body: rendered GFM subset with token-driven
   *  typography so a text tile reads like the rest of the product. */
  mdBody: {
    marginTop: tokens.spacingVerticalS,
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    '& h1, & h2, & h3, & h4': {
      marginTop: tokens.spacingVerticalXS,
      marginBottom: tokens.spacingVerticalXS,
    },
    '& p': { marginTop: tokens.spacingVerticalXXS, marginBottom: tokens.spacingVerticalXXS },
    '& code': {
      fontFamily: tokens.fontFamilyMonospace,
      fontSize: tokens.fontSizeBase200,
      backgroundColor: tokens.colorNeutralBackground3,
      borderRadius: tokens.borderRadiusSmall,
      paddingLeft: tokens.spacingHorizontalXXS,
      paddingRight: tokens.spacingHorizontalXXS,
    },
    '& pre.md-code': {
      backgroundColor: tokens.colorNeutralBackground3,
      borderRadius: tokens.borderRadiusMedium,
      padding: tokens.spacingVerticalS,
      overflowX: 'auto',
    },
    '& table.md-table': { borderCollapse: 'collapse' },
    '& table.md-table th, & table.md-table td': {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: tokens.spacingVerticalXXS,
    },
    '& blockquote': {
      borderLeft: `3px solid ${tokens.colorNeutralStroke1}`,
      marginLeft: 0,
      paddingLeft: tokens.spacingHorizontalS,
      color: tokens.colorNeutralForeground3,
    },
    '& a': { color: tokens.colorBrandForeground1 },
  },
});

// ----- KQL Dashboard (Fabric Real-Time Dashboard parity) -----
// A real dashboard builder: tile grid (add/remove/resize) where each tile has
// a KQL query bound to a data source + a visual type, rendering its REAL Kusto
// result; a data-sources panel; dashboard parameters (free-text / fixed /
// query-based / time range) substituted into tile KQL; per-dashboard
// auto-refresh + manual refresh; Save persists the full model to Cosmos.
// Backed by /api/items/kql-dashboard/[id] (GET ?run=1 / PUT) + /run + /param-values.

interface DashTile {
  title: string;
  kql: string;
  viz: TileViz;
  /** Text-tile content (viz:'markdown' only) — rendered, never executed. */
  markdown?: string;
  /** Owning page id (U8 pages). Absent/unknown → the first page. */
  pageId?: string;
  dataSourceId?: string;
  database?: string;
  w?: number; // grid column span 1..12
  h?: number; // grid row units 1..8
  conditionalRules?: ConditionalRule[];
  /** Drill-through: clicking a result value sets a dashboard parameter and
   *  optionally navigates to a target page (U8). */
  drillthrough?: { column: string; paramName: string; targetPageId?: string };
  result?: KqlResult;
  error?: string;
  /** PSR-7 — this tile's query is in flight (drives the per-tile skeleton/SWR). */
  loading?: boolean;
  /** ux-fabric-a W1 — transient timing for the tile's status footer (never persisted). */
  lastRunAt?: number;
  durationMs?: number;
}

/** A shared KQL snippet referenced by tiles via `$baseQuery('name')`. */
interface DashBaseQuery { id: string; name: string; kql: string; }

interface DashboardState {
  ok: boolean;
  database?: string;
  defaultDatabase?: string;
  tiles?: DashTile[];
  dataSources?: DashDataSource[];
  parameters?: DashParam[];
  baseQueries?: DashBaseQuery[];
  pages?: DashPage[];
  timeRange?: string;
  autoRefreshMs?: number;
  error?: string;
}

const TILE_VIZ_OPTIONS: TileViz[] = ['table', 'timechart', 'line', 'column', 'bar', 'pie', 'stat', 'map'];

// Auto-refresh interval choices (Fabric "Manage > Auto refresh" exposes an
// explicit minimum interval + default rate). The ADX /v1/rest/query round-trip
// is 2–10s, so the tightest live cadences (5s/30s) are paired with an in-flight
// guard in the auto-refresh effect below: a tick is SKIPPED while the previous
// runAll() is still resolving, so a slow cluster can never pile up overlapping
// queries. Matches the Fabric Real-Time Dashboard continuous-refresh behavior.
const REFRESH_INTERVALS: { ms: number; label: string }[] = [
  { ms: 0,         label: 'Off' },
  { ms: 5_000,     label: '5 seconds' },
  { ms: 30_000,    label: '30 seconds' },
  { ms: 60_000,    label: '1 minute' },
  { ms: 300_000,   label: '5 minutes' },
  { ms: 1_800_000, label: '30 minutes' },
  { ms: 3_600_000, label: '1 hour' },
];

function refreshLabel(ms: number): string {
  const hit = REFRESH_INTERVALS.find((r) => r.ms === ms);
  if (!ms) return 'Auto-refresh: off';
  return `Auto-refresh: ${hit ? hit.label : `${ms / 1000}s`}`;
}

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* noop */ }
  return 'ds-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Base-queries panel — the editable list of shared KQL snippets (referenced
 * from tiles via $baseQuery('name')). Extracted as a pure component so its
 * render + Add/Remove/Update behaviour can be unit-tested directly, without
 * mounting the full editor and opening the Fluent Dialog portal (that heavy
 * async path chronically flaked under `vitest run --coverage`, so it was only
 * papered over by CI retry). The parent KqlDashboardEditor still owns the
 * baseQueries state — this is pure presentation + callbacks.
 */
export function BaseQueriesPanel({
  baseQueries,
  onAdd,
  onUpdate,
  onRemove,
}: {
  baseQueries: DashBaseQuery[];
  onAdd: () => void;
  onUpdate: (idx: number, patch: Partial<DashBaseQuery>) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <>
      <Caption1>
        Define shared KQL snippets once and reference them from any tile with
        <code> $baseQuery('name')</code>. At run time the snippet is inlined as a
        parenthesised sub-query, so a common filter or projection backs many tiles
        without copy-paste (Fabric Real-Time Dashboard base-query parity).
      </Caption1>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS}}>
        {baseQueries.map((q, idx) => (
          <div key={q.id} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
            <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <Caption1>Name (referenced as $baseQuery('…'))</Caption1>
                <Input value={q.name} onChange={(_: unknown, d: any) => onUpdate(idx, { name: d.value })} placeholder="Filtered" aria-label="Base query name" />
              </div>
              <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => onRemove(idx)} aria-label="Remove base query" />
            </div>
            <Caption1>KQL</Caption1>
            <MonacoTextarea
              value={q.kql}
              onChange={(v) => onUpdate(idx, { kql: v })}
              language="kql"
              height={120}
              minHeight={90}
              ariaLabel={`Base query ${idx + 1} KQL`}
            />
          </div>
        ))}
        {baseQueries.length === 0 && <Caption1>No base queries yet. Add one to share a KQL snippet across tiles.</Caption1>}
        <Button appearance="outline" icon={<Add20Regular />} onClick={onAdd}>Add base query</Button>
      </div>
    </>
  );
}

export function KqlDashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const tc = useTileChrome();
  // U8 runtime kill-switch (FLAG0): OFF reverts to the single-page canvas —
  // the page strip, text-tile authoring, and page-targeted drill-through hide;
  // saved pages/text tiles are preserved (all tiles render on one canvas).
  const depthEnabled = useRuntimeFlag('u8-kql-dashboard-depth', true);
  const [state, setState] = useState<DashboardState | null>(null);
  const [tiles, setTiles] = useState<DashTile[]>([]);
  const [dataSources, setDataSources] = useState<DashDataSource[]>([]);
  const [params, setParams] = useState<DashParam[]>([]);
  const [baseQueries, setBaseQueries] = useState<DashBaseQuery[]>([]);
  // U8 pages — named tile containers; [] = back-compat single-page canvas.
  const [pages, setPages] = useState<DashPage[]>([]);
  const [activePageId, setActivePageId] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  // True while a runAll() ADX requery is in flight. Read synchronously inside
  // the auto-refresh interval so a tight cadence (5s/30s) skips a tick rather
  // than stacking overlapping /run round-trips against a slow cluster.
  const runInFlightRef = useRef(false);
  // Wall-clock of the last successful auto/manual refresh — surfaced in the
  // toolbar so the user can see the live cadence is actually firing.
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // Index of the tile whose edit flyout (Dialog) is open, or null. Mirrors the
  // Fabric Real-Time Dashboard "tile editing window" — a single side panel that
  // edits one tile at a time, rather than expanding the card inline.
  const [tileFlyoutIdx, setTileFlyoutIdx] = useState<number | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [timeRange, setTimeRange] = useState<TimeRangeKey>('last-24h');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [baseQueriesOpen, setBaseQueriesOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // AI tile generator (NL → KQL) — Fabric RTI "Copilot add a tile" parity.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [aiDataSourceId, setAiDataSourceId] = useState('');
  // Anomaly/forecast tile builder — native-KQL time-series ML (series_decompose)
  // over the Azure-native ADX cluster. Composes the tile's KQL, no Fabric.
  const [anomalyOpen, setAnomalyOpen] = useState(false);
  // Set-alert-on-tile (Fabric RTD "Set alert" parity): the per-tile action
  // creates a REAL Activator rule (sourceKind:'adx') from the tile's KQL on the
  // ADX-native Activator runtime — lazily creating + linking a backing
  // Activator item (state.activatorId), same pattern as the Eventstream
  // "Add alert" quick-create. Azure-native default; no Fabric Reflex.
  const [alertTileIdx, setAlertTileIdx] = useState<number | null>(null);
  const [alertName, setAlertName] = useState('');
  const [alertFireOn, setAlertFireOn] = useState<'rows' | 'condition'>('rows');
  const [alertColumn, setAlertColumn] = useState('');
  const [alertOperator, setAlertOperator] = useState<'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'ne' | 'contains'>('gt');
  const [alertThreshold, setAlertThreshold] = useState('0');
  const [alertFrequency, setAlertFrequency] = useState<'PT1M' | 'PT5M' | 'PT15M' | 'PT1H'>('PT5M');
  const [alertEmail, setAlertEmail] = useState('');
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertErr, setAlertErr] = useState<string | null>(null);
  const [alertHint, setAlertHint] = useState<string | null>(null);
  const [alertResult, setAlertResult] = useState<{
    activatorId: string; activatorName?: string; ruleId: string; database?: string;
    scheduled?: boolean; note?: string;
    preview?: { count: number; fired: boolean }; previewError?: string;
  } | null>(null);
  // Query-based param value caches: variableName → string[]
  const [paramValueCache, setParamValueCache] = useState<Record<string, string[]>>({});
  // Real KQL databases on the shared Loom ADX cluster — populates the data
  // source database dropdown so binding a source defaults to a deployed DB
  // instead of a blank free-text box (operator no-freeform mandate).
  const [clusterDbs, setClusterDbs] = useState<string[]>([]);

  const defaultDb = state?.database || state?.defaultDatabase || 'loomdb-default';

  // Build the live model the /run + /param-values + PUT routes consume.
  const buildModel = useCallback(() => ({
    tiles: tiles.map(({ result, error, loading, lastRunAt, durationMs, ...t }) => t),
    dataSources,
    parameters: params,
    baseQueries,
    pages,
    timeRange,
    autoRefreshMs,
  }), [tiles, dataSources, params, baseQueries, pages, timeRange, autoRefreshMs]);

  // Load the saved model (GET). When runTiles, GET ?run=1 executes every tile.
  const load = useCallback(async (runTiles = false) => {
    if (!id || id === 'new') return;
    const sp = new URLSearchParams();
    if (runTiles) { sp.set('run', '1'); sp.set('time', timeRange); }
    for (const p of params) {
      if (!p.variableName) continue;
      if (Array.isArray(p.value)) p.value.forEach((v) => sp.append(`param.${p.variableName}`, v));
      else if (p.value !== undefined && p.value !== '') sp.set(`param.${p.variableName}`, String(p.value));
    }
    const qs = sp.toString();
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${id}${qs ? '?' + qs : ''}`);
      const ct = r.headers.get('content-type') || '';
      const j: DashboardState = ct.includes('application/json')
        ? await r.json()
        : { ok: false, error: `HTTP ${r.status}` };
      setState(j);
      if (j.ok) {
        setTiles(j.tiles || []);
        setDataSources(j.dataSources || []);
        setParams(j.parameters || []);
        setBaseQueries(j.baseQueries || []);
        const loadedPages = j.pages || [];
        setPages(loadedPages);
        setActivePageId((cur) => (loadedPages.some((p: DashPage) => p.id === cur) ? cur : (loadedPages[0]?.id || '')));
        if (typeof j.autoRefreshMs === 'number') setAutoRefreshMs(j.autoRefreshMs);
        if (j.timeRange && TIME_ORDER.includes(j.timeRange as TimeRangeKey)) setTimeRange(j.timeRange as TimeRangeKey);
        setDirty(false);
      }
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id, timeRange, params]);

  // PSR-7 — run ALL tiles by FANNING OUT one query per tile (bounded
  // concurrency) instead of one blocking whole-board POST. Fast tiles render the
  // instant they resolve (progressive render); each tile owns its skeleton +
  // spinner. SWR: a tile's PRIOR result stays on screen while it re-queries, so
  // an auto-refresh never flashes the whole board back to skeletons.
  const runAll = useCallback(async () => {
    const n = tiles.length;
    if (n === 0) return;
    runInFlightRef.current = true;
    setRunning(true); setSaveErr(null);
    // Snapshot the model + tile identity at click-time so mid-run edits can't
    // change what each index runs. buildModel() strips transient result/loading.
    const model = buildModel();
    // Mark every QUERY tile loading up front (keeps prior result → SWR, no
    // flash). Text (markdown) tiles never execute — they render their content.
    setTiles((prev) => prev.map((t) => (t.viz === 'markdown' ? t : { ...t, loading: true, error: undefined })));
    try {
      await mapWithConcurrency(model.tiles, DASHBOARD_TILE_CONCURRENCY, async (tile, i) => {
        // Text (markdown) tiles have nothing to run.
        if (tile.viz === 'markdown') return;
        // ux-fabric-a W1 — per-tile client-measured query timing for the status footer.
        const t0 = performance.now();
        try {
          const r = await clientFetch(`/api/items/kql-dashboard/${id}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...model, tiles: [tile] }),
          });
          const ct = r.headers.get('content-type') || '';
          const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
          if (!j.ok) {
            setTiles((prev) => prev.map((t, idx) => idx === i ? { ...t, loading: false, error: j.error || `run failed (HTTP ${r.status})` } : t));
            return;
          }
          // Progressive: commit THIS tile's result as soon as it lands.
          const durationMs = Math.round(performance.now() - t0);
          setTiles((prev) => prev.map((t, idx) => idx === i
            ? { ...t, loading: false, result: j.tiles?.[0]?.result, error: j.tiles?.[0]?.error, lastRunAt: Date.now(), durationMs }
            : t));
        } catch (e: any) {
          setTiles((prev) => prev.map((t, idx) => idx === i ? { ...t, loading: false, error: e?.message || String(e) } : t));
        }
      });
      setLastRefreshedAt(Date.now());
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally {
      runInFlightRef.current = false;
      setRunning(false);
    }
  }, [id, tiles.length, buildModel]);

  // Initial load: fetch the saved model, then run it live so tiles render real data.
  useEffect(() => { load(false); /* eslint-disable-next-line */ }, [id]);
  useEffect(() => { if (state?.ok && tiles.length > 0) runAll(); /* eslint-disable-next-line */ }, [state?.ok]);

  // Fetch the real KQL databases on the shared cluster once, so data-source
  // binding is a dropdown of deployed databases (not a blank text box). Best
  // effort: if the cluster is unreachable the dialog falls back to free text.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch('/api/items/eventhouse/cluster');
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false };
        if (!cancelled && j.ok && Array.isArray(j.databases)) {
          setClusterDbs(j.databases.map((d: { name: string }) => d.name).filter(Boolean));
        }
      } catch { /* dropdown falls back to free text */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const addTile = useCallback(() => {
    setTiles((prev) => {
      const next: DashTile[] = [...prev, {
        title: `Tile ${prev.length + 1}`,
        kql: `// KQL for this tile. Use parameters (_startTime, _endTime, or your own _vars).\nprint value = 1`,
        viz: 'table', w: 4, h: 2,
        pageId: pages.length > 0 ? activePageId : undefined,
      }];
      setTileFlyoutIdx(next.length - 1);
      return next;
    });
    setDirty(true);
  }, [pages.length, activePageId]);

  // U8 — text (markdown) tile: authored content rendered in place of a query
  // result (Fabric RTD text-tile parity). Never executed against ADX.
  const addTextTile = useCallback(() => {
    setTiles((prev) => {
      const next: DashTile[] = [...prev, {
        title: `Text ${prev.length + 1}`,
        kql: '',
        viz: 'markdown',
        markdown: '## Section heading\n\nDescribe this dashboard section. **Markdown** renders here — headings, lists, tables, links, and code.',
        w: 4, h: 2,
        pageId: pages.length > 0 ? activePageId : undefined,
      }];
      setTileFlyoutIdx(next.length - 1);
      return next;
    });
    setDirty(true);
  }, [pages.length, activePageId]);

  // ── U8 — page CRUD. Pages are named tile containers; deleting a page moves
  // its tiles to the first remaining page (nothing destroyed). The FIRST add
  // materializes "Page 1" for the existing single-page tiles + the new page. ──
  const addPage = useCallback(() => {
    setPages((prev) => {
      if (prev.length === 0) {
        const p1: DashPage = { id: genId(), name: 'Page 1' };
        const p2: DashPage = { id: genId(), name: 'Page 2' };
        setActivePageId(p2.id);
        return [p1, p2];
      }
      const p: DashPage = { id: genId(), name: `Page ${prev.length + 1}` };
      setActivePageId(p.id);
      return [...prev, p];
    });
    setDirty(true);
  }, []);

  const renamePage = useCallback((pageId: string, name: string) => {
    setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, name } : p)));
    setDirty(true);
  }, []);

  const deletePage = useCallback((pageId: string) => {
    setPages((prev) => {
      if (prev.length <= 1) return prev;
      const remaining = prev.filter((p) => p.id !== pageId);
      const fallback = remaining[0].id;
      // Move the deleted page's tiles to the first remaining page. Tiles with
      // no pageId already resolve to the first page — normalize deleted refs.
      setTiles((tprev) => tprev.map((t) => (resolveTilePageId(t, prev) === pageId ? { ...t, pageId: fallback } : t)));
      setActivePageId((cur) => (cur === pageId ? fallback : cur));
      return remaining;
    });
    setDirty(true);
  }, []);

  // ── ux-fabric-a W1 — tile DRAG-REORDER (Fabric RTD tiles drag by a header
  // grip). HTML5 dnd: the grip is the drag source; each tile is a drop target
  // showing a brand before/after edge; drop splices the real tiles array (the
  // grid reflows) and marks the model dirty so Save persists the new order. ────
  const [dragTileIdx, setDragTileIdx] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ idx: number; before: boolean } | null>(null);

  const moveTile = useCallback((from: number, to: number, before: boolean) => {
    setTiles((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
      let target = to + (before ? 0 : 1);
      if (from < target) target -= 1;
      if (target === from) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved);
      return next;
    });
    setDirty(true);
  }, []);

  // ── ux-fabric-a W1 — corner RESIZE GRIP: pointer-drag snaps the tile's REAL
  // w (1..12 grid columns) / h (1..8 row units) live — the same fields the edit
  // flyout sets (which stays the keyboard-accessible path). Pointer capture on
  // the grip keeps move/up events flowing during the drag. ────────────────────
  const tileGridRef = useRef<HTMLDivElement | null>(null);
  const tileResizeRef = useRef<{
    idx: number; startX: number; startY: number;
    startW: number; startH: number; lastW: number; lastH: number;
    colPx: number; rowPx: number;
  } | null>(null);

  const onTileResizeDown = useCallback((e: React.PointerEvent<HTMLElement>, idx: number) => {
    const grid = tileGridRef.current;
    const t = tiles[idx];
    if (!grid || !t) return;
    e.preventDefault(); e.stopPropagation();
    const rect = grid.getBoundingClientRect();
    // Grid math mirror: 12 columns with an M gap (≈12px), rows are
    // minmax(120px, auto) + gap — enough precision for snap-to-span.
    const GAP = 12;
    const colPx = Math.max(24, (rect.width - GAP * 11) / 12);
    const rowPx = 120 + GAP;
    const startW = Math.max(1, Math.min(12, t.w || 4));
    const startH = Math.max(1, Math.min(8, t.h || 2));
    tileResizeRef.current = { idx, startX: e.clientX, startY: e.clientY, startW, startH, lastW: startW, lastH: startH, colPx, rowPx };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [tiles]);

  const onTileResizeMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const r = tileResizeRef.current;
    if (!r) return;
    const w = Math.max(1, Math.min(12, r.startW + Math.round((e.clientX - r.startX) / r.colPx)));
    const h = Math.max(1, Math.min(8, r.startH + Math.round((e.clientY - r.startY) / r.rowPx)));
    if (w === r.lastW && h === r.lastH) return;
    r.lastW = w; r.lastH = h;
    setTiles((prev) => prev.map((t, i) => (i === r.idx ? { ...t, w, h } : t)));
    setDirty(true);
  }, []);

  const onTileResizeUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!tileResizeRef.current) return;
    tileResizeRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }, []);

  // AI tile generator: POST the NL prompt → server grounds on the live ADX
  // schema, asks AOAI for {title, kql, viz}, validates by executing the KQL,
  // and returns a ready tile (with its first-page result inlined). We append it
  // to the grid and open its editor so the operator can review/tweak. This is
  // the Fabric Real-Time Dashboard "Copilot — add a tile from a question" flow,
  // Azure-native (ADX + AOAI), no Fabric/Power BI on the path.
  const generateTile = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) { setAiErr('Describe the tile you want (e.g. "errors per service over time").'); return; }
    setAiBusy(true); setAiErr(null); setAiNote(null);
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${id}/generate-tile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, dataSourceId: aiDataSourceId || undefined, timeRange }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { setAiErr(j.error || `generation failed (HTTP ${r.status})`); return; }
      const g = j.tile || {};
      const newTile: DashTile = {
        title: g.title || prompt.slice(0, 60),
        kql: g.kql || '',
        viz: (g.viz || 'table') as TileViz,
        dataSourceId: g.dataSourceId || undefined,
        database: g.database || undefined,
        w: g.w || 4,
        h: g.h || 2,
        pageId: pages.length > 0 ? activePageId : undefined,
        result: g.result,
        error: j.validated ? undefined : (j.validationError || undefined),
      };
      let insertedIdx = 0;
      setTiles((prev) => { insertedIdx = prev.length; return [...prev, newTile]; });
      setDirty(true);
      setTileFlyoutIdx(insertedIdx);
      if (!j.schemaGrounded) {
        setAiNote('Generated without a live schema (the database returned no tables). Review the column names in the tile editor.');
      } else if (!j.validated) {
        setAiNote(`Tile added, but its KQL did not validate against ${j.resolvedDatabase}: ${j.validationError || 'unknown error'}. Edit it in the tile editor.`);
      }
      setAiOpen(false);
      setAiPrompt('');
    } catch (e: any) {
      setAiErr(e?.message || String(e));
    } finally {
      setAiBusy(false);
    }
  }, [aiPrompt, aiDataSourceId, id, timeRange, pages.length, activePageId]);

  const deleteTile = useCallback((idx: number) => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this tile? This cannot be undone until you reload without saving.')) return;
    setTiles((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
    setTileFlyoutIdx((cur) => (cur === idx ? null : cur !== null && cur > idx ? cur - 1 : cur));
  }, []);

  const updateTile = useCallback((idx: number, patch: Partial<DashTile>) => {
    setTiles((prev) => prev.map((t, i) => i === idx ? { ...t, ...patch } : t));
    setDirty(true);
  }, []);

  // Export a tile's REAL result (the same Kusto rows already rendered) to CSV.
  // Fabric Real-Time Dashboard tiles expose an "Export to CSV" / "Copy to
  // clipboard" tile action; this is the 1:1. Pure client-side — the result is
  // already in memory, so no backend round-trip is needed.
  const exportTileCsv = useCallback((idx: number) => {
    const t = tiles[idx];
    const res = t?.result;
    if (!res?.ok || !Array.isArray(res.columns) || !Array.isArray(res.rows)) {
      setSaveErr('Run the tile first — there is no result to export yet.');
      return;
    }
    const csv = kqlResultToCsv(res.columns, res.rows);
    downloadTextFile(`${slugifyForFile(t.title)}.csv`, csv);
    setSaveErr(null);
    setSaveMsg(`Exported ${res.rows.length} row${res.rows.length === 1 ? '' : 's'} from “${t.title}” to CSV.`);
  }, [tiles]);

  const copyTileCsv = useCallback(async (idx: number) => {
    const t = tiles[idx];
    const res = t?.result;
    if (!res?.ok || !Array.isArray(res.columns) || !Array.isArray(res.rows)) {
      setSaveErr('Run the tile first — there is no result to copy yet.');
      return;
    }
    const csv = kqlResultToCsv(res.columns, res.rows);
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard unavailable in this browser.');
      await navigator.clipboard.writeText(csv);
      setSaveErr(null);
      setSaveMsg(`Copied ${res.rows.length} row${res.rows.length === 1 ? '' : 's'} from “${t.title}” to the clipboard (CSV).`);
    } catch (e: any) {
      setSaveErr(`Could not copy to clipboard: ${e?.message || e}. Use Export CSV instead.`);
    }
  }, [tiles]);

  // Run a single tile live (the tile-editor "Run" button — Fabric parity).
  const runTile = useCallback(async (idx: number) => {
    const t = tiles[idx];
    if (!t || t.viz === 'markdown') return; // text tiles never execute
    // PSR-7 — SWR: keep the prior result on screen while re-querying (loading
    // flag drives the tile spinner/skeleton, never a whole-board block).
    updateTile(idx, { error: undefined, loading: true });
    // ux-fabric-a W1 — client-measured query timing for the tile status footer.
    const t0 = performance.now();
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...buildModel(), tiles: [{ title: t.title, kql: t.kql, viz: t.viz, dataSourceId: t.dataSourceId, database: t.database }] }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { updateTile(idx, { error: j.error || `run failed (HTTP ${r.status})`, result: undefined, loading: false }); return; }
      updateTile(idx, {
        result: j.tiles?.[0]?.result, error: j.tiles?.[0]?.error, loading: false,
        lastRunAt: Date.now(), durationMs: Math.round(performance.now() - t0),
      });
    } catch (e: any) {
      updateTile(idx, { error: e?.message || String(e), loading: false });
    }
  }, [id, tiles, buildModel, updateTile]);

  // Append an anomaly/forecast tile from the AnomalyForecastDialog. The dialog
  // hands back the fully-composed series_decompose KQL; we add it as a normal
  // time-chart tile (bound to the dashboard default DB) and run it live so the
  // decomposition renders immediately via the existing TimeSeriesChart.
  const addAnomalyTile = useCallback(({ kql, title }: { kql: string; title: string; mode: 'anomaly' | 'forecast' }) => {
    let insertedIdx = 0;
    setTiles((prev) => {
      insertedIdx = prev.length;
      return [...prev, { title, kql, viz: 'timechart' as TileViz, database: defaultDb, w: 6, h: 3, pageId: pages.length > 0 ? activePageId : undefined }];
    });
    setDirty(true);
    setAnomalyOpen(false);
    setTileFlyoutIdx(insertedIdx);
    setTimeout(() => runTile(insertedIdx), 0);
  }, [defaultDb, runTile, pages.length, activePageId]);

  // Resolve the database a tile targets (explicit override → bound data source
  // → dashboard default) — mirrors the server-side resolveTileDatabase.
  const tileDatabase = useCallback((t: DashTile): string => {
    if (t.database && t.database.trim()) return t.database.trim();
    if (t.dataSourceId) {
      const ds = dataSources.find((d) => d.id === t.dataSourceId);
      if (ds?.database) return ds.database;
    }
    return defaultDb;
  }, [dataSources, defaultDb]);

  // Open the per-tile Set-alert dialog pre-filled from the tile (name, first
  // result column, and — displayed read-only — its KQL + resolved database).
  const openSetAlert = useCallback((idx: number) => {
    const t = tiles[idx];
    if (!t) return;
    setAlertName(`${t.title}-alert`.slice(0, 60));
    setAlertFireOn('rows');
    setAlertColumn(t.result?.columns?.[0] || '');
    setAlertOperator('gt');
    setAlertThreshold('0');
    setAlertFrequency('PT5M');
    setAlertEmail('');
    setAlertErr(null); setAlertHint(null); setAlertResult(null);
    setAlertTileIdx(idx);
  }, [tiles]);

  // Create the alert: POST the tile's KQL + the dashboard context (data
  // sources, parameters, base queries, time range — substituted server-side)
  // to the dashboard activator route, which lazily creates + links a backing
  // Activator item and mints a REAL sourceKind:'adx' rule on the ADX-native
  // Activator runtime (kusto-client evaluation; ADX-scoped scheduledQueryRule
  // when LOOM_ADX_ALERT_SCOPE is provisioned). No Fabric.
  const doSetAlert = useCallback(async () => {
    if (alertTileIdx === null) return;
    const t = tiles[alertTileIdx];
    if (!t) return;
    setAlertBusy(true); setAlertErr(null); setAlertHint(null); setAlertResult(null);
    try {
      const action = alertEmail.trim() ? { target: alertEmail.trim() } : undefined;
      const r = await clientFetch(`/api/items/kql-dashboard/${id}/activator`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ruleName: alertName.trim() || undefined,
          tileTitle: t.title,
          tileKql: t.kql,
          dataSourceId: t.dataSourceId || undefined,
          database: t.database || undefined,
          fireOn: alertFireOn,
          ...(alertFireOn === 'condition' ? {
            property: alertColumn.trim() || 'value',
            operator: alertOperator,
            threshold: alertThreshold.trim(),
          } : {}),
          evaluationFrequency: alertFrequency,
          windowSize: alertFrequency,
          ...(action ? { action } : {}),
          dataSources,
          parameters: params,
          baseQueries,
          timeRange,
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) {
        setAlertErr(j.error || `HTTP ${r.status}`);
        setAlertHint(j.gate?.remediation || j.hint || null);
        return;
      }
      setAlertResult({
        activatorId: j.activatorId, activatorName: j.activatorName, ruleId: j.ruleId,
        database: j.database, scheduled: j.scheduled, note: j.note,
        preview: j.preview, previewError: j.previewError,
      });
    } catch (e: any) {
      setAlertErr(e?.message || String(e));
    } finally {
      setAlertBusy(false);
    }
  }, [alertTileIdx, tiles, id, alertName, alertFireOn, alertColumn, alertOperator, alertThreshold, alertFrequency, alertEmail, dataSources, params, baseQueries, timeRange]);

  // Re-run ONLY the tiles whose KQL body references the given parameter
  // variable name (selective dependent-tile re-run, like Fabric re-evaluating
  // just the tiles a changed filter feeds). `duration` params affect every
  // tile that uses the synthetic _startTime/_endTime tokens, so those re-run
  // the whole dashboard via runAll.
  const runDependentTiles = useCallback((varName: string) => {
    if (!varName) return;
    const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`);
    tiles.forEach((t, idx) => {
      if (re.test(t.kql)) runTile(idx);
    });
  }, [tiles, runTile]);

  const save = useCallback(async () => {
    setSaving(true); setSaveErr(null); setSaveMsg('Saving…');
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildModel()),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (j.ok) {
        setDirty(false);
        setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      } else {
        setSaveErr(j.error || 'save failed');
        setSaveMsg(`Save failed: ${j.error || 'unknown'}`);
      }
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
      setSaveMsg(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [id, buildModel]);

  // Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  // Auto-refresh — re-run the live model (real ADX requery via /run) every N ms.
  // A tick is SKIPPED when the previous requery is still resolving so a tight
  // cadence (5s/30s) against a slow cluster can never pile up overlapping
  // queries — the next tick simply picks up once the in-flight run completes.
  useEffect(() => {
    if (!autoRefreshMs || autoRefreshMs <= 0) return;
    const t = setInterval(() => {
      if (runInFlightRef.current) return;
      runAll();
    }, autoRefreshMs);
    return () => clearInterval(t);
  }, [autoRefreshMs, runAll]);

  // --- Data sources ---
  const addDataSource = useCallback(() => {
    // Default to a real deployed database (prefer the cluster default) rather
    // than a blank box — operator no-freeform mandate.
    const seedDb = clusterDbs.includes(defaultDb) ? defaultDb : (clusterDbs[0] || defaultDb);
    setDataSources((prev) => [...prev, { id: genId(), name: `Source ${prev.length + 1}`, database: seedDb }]);
    setDirty(true);
  }, [defaultDb, clusterDbs]);
  const updateDataSource = useCallback((idx: number, patch: Partial<DashDataSource>) => {
    setDataSources((prev) => prev.map((d, i) => i === idx ? { ...d, ...patch } : d));
    setDirty(true);
  }, []);
  const removeDataSource = useCallback((idx: number) => {
    setDataSources((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // --- Parameters ---
  const addParam = useCallback(() => {
    setParams((prev) => [...prev, { variableName: `_param${prev.length + 1}`, label: `Parameter ${prev.length + 1}`, type: 'freetext', dataType: 'string', value: '' }]);
    setDirty(true);
  }, []);
  const updateParam = useCallback((idx: number, patch: Partial<DashParam>) => {
    setParams((prev) => prev.map((p, i) => i === idx ? { ...p, ...patch } : p));
    setDirty(true);
  }, []);
  const removeParam = useCallback((idx: number) => {
    setParams((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // --- Base queries (shared KQL snippets referenced via $baseQuery('name')) ---
  const addBaseQuery = useCallback(() => {
    setBaseQueries((prev) => [...prev, { id: genId(), name: `Query${prev.length + 1}`, kql: '// Shared KQL — referenced from a tile as $baseQuery(\'Query1\')\nStormEvents | where StartTime > _startTime' }]);
    setDirty(true);
  }, []);
  const updateBaseQuery = useCallback((idx: number, patch: Partial<DashBaseQuery>) => {
    setBaseQueries((prev) => prev.map((q, i) => i === idx ? { ...q, ...patch } : q));
    setDirty(true);
  }, []);
  const removeBaseQuery = useCallback((idx: number) => {
    setBaseQueries((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // Resolve a query-based parameter's dropdown values from the real cluster.
  const loadParamValues = useCallback(async (p: DashParam) => {
    if (p.type !== 'query' || !p.query?.trim()) return;
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${id}/param-values`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: p.query, dataSourceId: p.dataSourceId, dataSources }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false };
      if (j.ok) setParamValueCache((prev) => ({ ...prev, [p.variableName]: j.values || [] }));
    } catch { /* surfaced lazily; dropdown just stays empty */ }
  }, [id, dataSources]);

  const openJson = useCallback(() => {
    setJsonText(JSON.stringify(buildModel(), null, 2));
    setJsonErr(null);
    setJsonOpen(true);
  }, [buildModel]);

  const applyJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      const model = Array.isArray(parsed) ? { tiles: parsed } : parsed;
      if (Array.isArray(model.tiles)) setTiles(model.tiles);
      if (Array.isArray(model.dataSources)) setDataSources(model.dataSources);
      if (Array.isArray(model.parameters)) setParams(model.parameters);
      if (Array.isArray(model.baseQueries)) setBaseQueries(model.baseQueries);
      if (Array.isArray(model.pages)) {
        setPages(model.pages);
        setActivePageId((cur) => (model.pages.some((p: DashPage) => p?.id === cur) ? cur : (model.pages[0]?.id || '')));
      }
      if (typeof model.timeRange === 'string' && TIME_ORDER.includes(model.timeRange)) setTimeRange(model.timeRange);
      setDirty(true); setJsonOpen(false); setJsonErr(null);
    } catch (e: any) {
      setJsonErr(e?.message || 'invalid JSON');
    }
  }, [jsonText]);

  const cycleTime = useCallback(() => {
    const i = TIME_ORDER.indexOf(timeRange);
    const next = TIME_ORDER[(i + 1) % TIME_ORDER.length];
    setTimeRange(next);
    setTimeout(() => runAll(), 0);
  }, [timeRange, runAll]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Edit', actions: [
        { label: 'Add tile', onClick: addTile },
        ...(depthEnabled ? [{ label: 'Add text tile', onClick: addTextTile }] : []),
        { label: 'Add tile with Copilot', onClick: () => { setAiErr(null); setAiNote(null); setAiOpen(true); } },
        { label: 'Add anomaly / forecast tile', onClick: () => setAnomalyOpen(true) },
        ...(depthEnabled ? [{ label: 'Add page', onClick: addPage }] : []),
        { label: 'Data sources', onClick: () => setSourcesOpen(true) },
        { label: 'Parameters', onClick: () => setParamsOpen(true) },
        { label: 'Base queries', onClick: () => setBaseQueriesOpen(true) },
        { label: 'Edit JSON', onClick: openJson },
      ]},
      { label: 'View', actions: [
        { label: running ? 'Refreshing…' : 'Refresh all', onClick: running ? undefined : runAll, disabled: running },
        // The auto-refresh interval is authored + displayed via the toolbar
        // <Select> (a status-only, click-undefined ribbon button was a dead
        // action — no-vaporware). Time stays a real cycle action.
        { label: `Time: ${timeRange}`, onClick: cycleTime },
      ]},
      { label: 'Manage', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: saving ? undefined : save, disabled: saving },
        { label: 'Share', onClick: () => setShareOpen(true) },
      ]},
    ]},
  ], [addTile, addTextTile, addPage, depthEnabled, openJson, running, runAll, autoRefreshMs, timeRange, cycleTime, saving, save]);

  const main = (
    <div className={s.pad}>
      <TeachingBanner
        surfaceKey="kql-dashboard-editor"
        title="Build a Real-Time Dashboard"
        message="Add tiles bound to KQL base queries, wire parameters to cross-filter every tile at once, and set an auto-refresh interval for a live operational view over your ADX-native eventhouse."
        learnMoreHref="https://learn.microsoft.com/azure/data-explorer/azure-data-explorer-dashboards"
      />
      <ToolbarCrossLinks
        ariaLabel="Related real-time surfaces"
        links={[
          { key: 'query', label: 'Query with code', href: '/items/kql-database/new' },
          { key: 'eventhouse', label: 'Eventhouse', href: '/items/eventhouse/new' },
          { key: 'eventstream', label: 'Eventstream', href: '/items/eventstream/new' },
          { key: 'activator', label: 'Activator', href: '/items/activator/new' },
          { key: 'agent', label: 'Data Agent', href: '/items/data-agent/new' },
        ]}
      />
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand">Real-Time Dashboard</Badge>
        <Caption1>db: <strong>{defaultDb}</strong> · {tiles.length} tiles{depthEnabled && pages.length > 0 ? ` · ${pages.length} pages` : ''} · {dataSources.length} sources · {params.length} params</Caption1>
        {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
        <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addTile}>Add tile</Button>
        {depthEnabled && (
          <Button size="small" appearance="outline" icon={<TextT20Regular />} onClick={addTextTile}
            title="Add a text (markdown) tile — rendered content, no query">Add text tile</Button>
        )}
        <Button size="small" appearance="primary" icon={<Sparkle20Regular />} onClick={() => { setAiErr(null); setAiNote(null); setAiOpen(true); }}>Add tile with Copilot</Button>
        <Button size="small" appearance="outline" icon={<MathFormula20Regular />} onClick={() => setAnomalyOpen(true)}>Anomaly / forecast</Button>
        <Button size="small" appearance="outline" icon={<Database20Regular />} onClick={() => setSourcesOpen(true)}>Data sources</Button>
        <Button size="small" appearance="outline" icon={<MathFormula20Regular />} onClick={() => setParamsOpen(true)}>Parameters</Button>
        <Button size="small" appearance="outline" onClick={() => setBaseQueriesOpen(true)}>Base queries</Button>
        <Button size="small" appearance="outline" onClick={openJson}>Edit JSON</Button>
        <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} onClick={runAll} disabled={running}>{running ? 'Refreshing…' : 'Refresh all'}</Button>
        <Select
          size="small"
          aria-label="Auto-refresh interval"
          value={String(autoRefreshMs)}
          onChange={(_: unknown, d: any) => { setAutoRefreshMs(Number(d.value) || 0); setDirty(true); }}
          style={{ minWidth: 150 }}
        >
          {REFRESH_INTERVALS.map(({ ms, label }) => (
            <option key={ms} value={String(ms)}>
              {ms === 0 ? 'Auto-refresh: off' : `Auto-refresh: every ${label}`}
            </option>
          ))}
        </Select>
        {autoRefreshMs > 0 && (
          <span
            className={s.livePill}
            role="status"
            aria-live="polite"
            title={`Auto-refreshing every ${refreshLabel(autoRefreshMs).replace(/^Auto-refresh:\s*/i, '')}`}
          >
            <span className={mergeClasses(s.liveDot, running && s.liveDotActive)} aria-hidden />
            <Caption1>
              {running
                ? 'Refreshing…'
                : lastRefreshedAt
                  ? `Live · updated ${new Date(lastRefreshedAt).toLocaleTimeString()}`
                  : 'Live · waiting for first refresh…'}
            </Caption1>
          </span>
        )}
        <Button size="small" appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving || !dirty} style={{ marginLeft: 'auto' }}>
          {saving ? 'Saving…' : 'Save (Ctrl+S)'}
        </Button>
      </div>

      {/* Parameter filter bar — Fabric renders selected dashboard params here.
          Extracted to kql-dashboard-parameters.tsx (U8 decomposition). */}
      <DashboardParameterBar
        params={params}
        dataSources={dataSources}
        timeRange={timeRange}
        paramValueCache={paramValueCache}
        running={running}
        onUpdateParam={updateParam}
        onRunDependents={runDependentTiles}
        onRunAll={runAll}
        onLoadParamValues={loadParamValues}
        onTimeRangeChange={setTimeRange}
      />

      {saveMsg && !saveErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
      {saveErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}
      {aiNote && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Copilot tile</MessageBarTitle>{aiNote}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => setAiNote(null)}>Dismiss</Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {state && !state.ok && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Dashboard data source not ready</MessageBarTitle>
            {state.error || 'unknown'} — the dashboard still renders; bind tiles to a KQL database
            (via Data sources) on the Loom shared ADX cluster. If no Eventhouse / KQL DB is provisioned,
            create one in the Eventhouse editor first (ARM Microsoft.Kusto/clusters/databases).
          </MessageBarBody>
        </MessageBar>
      )}

      {/* U8 — page strip: named tile-container pages (Fabric RTD Pages parity).
          Hidden when the u8-kql-dashboard-depth kill-switch is OFF (all tiles
          render on one canvas — the pre-U8 behavior; nothing is deleted). */}
      {depthEnabled && (
        <DashboardPageStrip
          pages={pages}
          activePageId={pages.length > 0 ? (pages.some((p) => p.id === activePageId) ? activePageId : pages[0].id) : ''}
          tileCounts={tiles.reduce<Record<string, number>>((acc, t) => {
            const pid = resolveTilePageId(t, pages);
            acc[pid] = (acc[pid] || 0) + 1;
            return acc;
          }, {})}
          onSelect={setActivePageId}
          onAdd={addPage}
          onRename={renamePage}
          onDelete={deletePage}
        />
      )}

      {/* Tile grid — 12-col CSS grid; each tile spans its w/h. Tiles drag-reorder
          by the header grip and resize by the corner grip (ux-fabric-a W1).
          The grid REGION height is user-resizable (G3, persisted under
          loom.canvasHeight.kql-dashboard-grid); tiles keep their Fabric-RTD
          per-tile corner resize and the grid scrolls inside the region. */}
      <ResizableCanvasRegion storageKey="kql-dashboard-grid" defaultPx={560} minPx={280} ariaLabel="Resize dashboard tile grid height">
        <div ref={tileGridRef} style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: tokens.spacingVerticalM, gridAutoRows: 'minmax(120px, auto)', alignContent: 'start', flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {tiles.map((t, i) => {
          // U8 pages — only the active page's tiles render. Mapping over the
          // FULL array keeps indices global, so every callback (run/edit/
          // delete/drag/resize) stays stable across pages.
          if (depthEnabled && pages.length > 0 && resolveTilePageId(t, pages) !== activePageId) return null;
          const isText = t.viz === 'markdown';
          const span = Math.max(1, Math.min(12, t.w || 4));
          const rowSpan = Math.max(1, Math.min(8, t.h || 2));
          const dsName = t.dataSourceId ? (dataSources.find((d) => d.id === t.dataSourceId)?.name || t.dataSourceId) : (t.database || defaultDb);
          return (
            <div key={i}
              className={mergeClasses(
                s.card, tc.tile,
                tileFlyoutIdx === i ? tc.tileSelected : undefined,
                dragTileIdx === i && tc.tileDragging,
                dropHint?.idx === i && dragTileIdx !== i && (dropHint.before ? tc.tileDropBefore : tc.tileDropAfter),
              )}
              style={{ gridColumn: `span ${span}`, gridRow: `span ${rowSpan}`, display: 'flex', flexDirection: 'column', minWidth: 0 }}
              onDragOver={(e) => {
                if (dragTileIdx === null || dragTileIdx === i) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const before = e.clientX - r.left < r.width / 2;
                setDropHint((h) => (h?.idx === i && h.before === before ? h : { idx: i, before }));
              }}
              onDragLeave={() => setDropHint((h) => (h?.idx === i ? null : h))}
              onDrop={(e) => {
                if (dragTileIdx === null || dragTileIdx === i) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                moveTile(dragTileIdx, i, e.clientX - r.left < r.width / 2);
                setDragTileIdx(null); setDropHint(null);
              }}>
              <div className={tc.tileHeader}>
                {/* Drag grip — the tile's reorder handle (hover/focus-revealed). */}
                <span
                  className={mergeClasses(tc.dragGrip, 'tile-grip')}
                  role="button" tabIndex={-1} aria-label={`Reorder tile ${t.title}`} title="Drag to reorder"
                  draggable
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); setDragTileIdx(i); }}
                  onDragEnd={() => { setDragTileIdx(null); setDropHint(null); }}
                >
                  <ReOrderDotsVertical16Regular />
                </span>
                <div className={tc.tileMeta}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{isText ? 'TEXT' : <>{t.viz.toUpperCase()} · {dsName}</>}</Caption1>
                  <div className={tc.tileTitle}>{t.title}</div>
                </div>
                <div className={mergeClasses(tc.tileActions, 'tile-actions')}>
                  {!isText && (
                    <>
                      <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => runTile(i)} aria-label="Run tile" title="Run this tile" />
                      <Button
                        size="small" appearance="subtle" icon={<Alert20Regular />}
                        onClick={() => openSetAlert(i)}
                        aria-label="Set alert on this tile"
                        title="Set alert — create an Activator rule from this tile's KQL (evaluated on the ADX cluster; Azure-native, no Fabric)" />
                      <Button
                        size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                        onClick={() => exportTileCsv(i)} disabled={!t.result?.ok}
                        aria-label="Export tile result to CSV"
                        title={t.result?.ok ? 'Export this tile’s result to CSV' : 'Run the tile first to enable export'} />
                      <Button
                        size="small" appearance="subtle" icon={<Copy20Regular />}
                        onClick={() => copyTileCsv(i)} disabled={!t.result?.ok}
                        aria-label="Copy tile result to clipboard"
                        title={t.result?.ok ? 'Copy this tile’s result (CSV) to the clipboard' : 'Run the tile first to enable copy'} />
                    </>
                  )}
                  <Button size="small" appearance="subtle" onClick={() => setTileFlyoutIdx(i)} aria-label="Edit tile">
                    Edit
                  </Button>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => deleteTile(i)} aria-label="Delete tile" />
                </div>
              </div>

              {/* U8 — text tile body: rendered markdown in place of a query
                  result. renderMarkdown HTML-escapes the source FIRST so no
                  author markup can inject elements (see render-markdown.ts). */}
              {isText && (
                <div className={tc.mdBody} dangerouslySetInnerHTML={{ __html: renderMarkdown(t.markdown || '') }} />
              )}

              {/* PSR-7 — per-tile SWR spinner: a small "refreshing" chip when a
                  tile is re-querying but its prior result is still on screen. */}
              {t.loading && t.result?.ok && (
                <Caption1 style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                  <Spinner size="extra-tiny" /> Refreshing…
                </Caption1>
              )}
              {t.error && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{t.error}</MessageBarBody></MessageBar>}
              {/* PSR-7 — first-load skeleton: only when loading AND there is no
                  prior result to keep on screen (SWR keeps the old one instead). */}
              {t.loading && !t.result && !t.error && (
                <div style={{ marginTop: tokens.spacingVerticalS, flex: 1, minHeight: 0 }}>
                  <Skeleton aria-label="Loading tile" animation="pulse">
                    <SkeletonItem style={{ height: 24, borderRadius: tokens.borderRadiusSmall, marginBottom: tokens.spacingVerticalS }} />
                    <SkeletonItem style={{ height: 96, borderRadius: tokens.borderRadiusMedium }} />
                  </Skeleton>
                </div>
              )}
              {t.result && t.result.ok && (
                <div style={{ marginTop: tokens.spacingVerticalS, flex: 1, minHeight: 0 }}>
                  <TileVisual
                    viz={t.viz}
                    result={t.result}
                    conditionalRules={t.conditionalRules}
                    drillthrough={t.drillthrough}
                    onDrillthrough={t.drillthrough ? (paramName, value) => {
                      // Inject the clicked value into the target parameter, then
                      // re-run every tile so the dashboard cross-filters. When a
                      // target page is wired (U8), also navigate to that page —
                      // the full documented Fabric drill-through behavior.
                      setParams((prev) => prev.map((p) => p.variableName === paramName ? { ...p, value } : p));
                      const target = t.drillthrough?.targetPageId;
                      if (depthEnabled && target && pages.some((p) => p.id === target)) setActivePageId(target);
                      setTimeout(() => runAll(), 0);
                    } : undefined}
                  />
                  {/* Stable, machine-readable first-row snapshot — the
                      before/after receipt target for the param-change E2E. */}
                  <span data-testid="tile-result-row" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                    {JSON.stringify(t.result.rows?.[0] ?? [])}
                  </span>
                </div>
              )}
              {!isText && !t.result && !t.error && !t.loading && <Caption1 style={{ marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>Run the tile to see results.</Caption1>}

              {/* ux-fabric-a W1 — timing/status footer: rows · query duration ·
                  updated-at, from the tile's REAL last run (client-measured). */}
              {t.result?.ok && (() => {
                const rowN = t.result.rowCount ?? t.result.rows?.length;
                // Prefer the REAL server-side Kusto execution time when the run
                // route returned one; the client round-trip is the fallback.
                const ms = typeof t.result.executionMs === 'number' ? t.result.executionMs : t.durationMs;
                return (
                  <div className={tc.tileFooter}>
                    <Caption1 className={tc.tileFooterText}>
                      {typeof rowN === 'number' ? `${rowN} row${rowN === 1 ? '' : 's'}` : 'OK'}
                      {typeof ms === 'number' ? ` · ${ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`}` : ''}
                      {t.result.truncated ? ' · truncated' : ''}
                      {t.lastRunAt ? ` · updated ${new Date(t.lastRunAt).toLocaleTimeString()}` : ''}
                    </Caption1>
                  </div>
                );
              })()}

              {/* Corner resize grip — drag snaps the tile's real w/h grid spans
                  (the edit flyout's Width/Height stay the keyboard path). */}
              <span
                className={mergeClasses(tc.resizeGrip, 'tile-grip')}
                aria-hidden
                title="Drag to resize"
                onPointerDown={(e) => onTileResizeDown(e, i)}
                onPointerMove={onTileResizeMove}
                onPointerUp={onTileResizeUp}
                onPointerCancel={onTileResizeUp}
              />
            </div>
          );
        })}
        {tiles.length > 0 && (
          <button
            type="button"
            className={tc.ghostTile}
            style={{ gridColumn: 'span 4', gridRow: 'span 2' }}
            onClick={addTile}
            aria-label="Add tile"
          >
            <Add24Regular />
            <Caption1>Add tile</Caption1>
          </button>
        )}
        {tiles.length === 0 && (
          <div style={{ gridColumn: 'span 12' }}>
            <EmptyState
              icon={<Database20Regular />}
              title="Build a Real-Time Dashboard"
              body="Add tiles bound to KQL queries over your ADX-native eventhouse. Wire parameters to cross-filter every tile at once, then set an auto-refresh interval for a live operational view."
              primaryAction={{ label: 'Add tile', onClick: addTile }}
              secondaryAction={{ label: 'Add tile with Copilot', onClick: () => { setAiErr(null); setAiNote(null); setAiOpen(true); } }}
            />
          </div>
        )}
      </div>
      </ResizableCanvasRegion>

      {/* WS-5.4 — NL "Ask" affordance: ask questions about the dashboard data.
          Backed by /api/ask → chatGrounded against the ADX-native kql source. */}
      {tiles.length > 0 && (
        <AskAffordance
          surfaceKind="kql-dashboard"
          itemId={id}
          itemType="kql-dashboard"
          context={{
            tables: [...new Set(tiles.map((t) => t.kql?.split('\n')[0]?.trim()).filter(Boolean) as string[])].slice(0, 5),
          }}
        />
      )}

      {/* Tile edit flyout — Fabric "tile editing window": one Dialog edits the
          tile at tileFlyoutIdx (title, visual, data source, geometry, KQL),
          runs it live, and renders the real result inline before Apply. */}
      <Dialog open={tileFlyoutIdx !== null} onOpenChange={(_: unknown, d: any) => { if (!d.open) setTileFlyoutIdx(null); }}>
        <DialogSurface style={{ maxWidth: 760 }}>
          <DialogBody>
            <DialogTitle>Edit tile</DialogTitle>
            <DialogContent>
              {tileFlyoutIdx !== null && tiles[tileFlyoutIdx] && (() => {
                const i = tileFlyoutIdx;
                const t = tiles[i];
                const isText = t.viz === 'markdown';
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div>
                      <Caption1>Title</Caption1>
                      <Input value={t.title} onChange={(_: unknown, d: any) => updateTile(i, { title: d.value })} placeholder="Title" aria-label="Tile title" />
                    </div>
                    {/* U8 — move the tile between pages. */}
                    {depthEnabled && pages.length > 0 && (
                      <div>
                        <Caption1>Page</Caption1>
                        <Select
                          value={resolveTilePageId(t, pages)}
                          aria-label="Tile page"
                          onChange={(_: unknown, d: any) => updateTile(i, { pageId: d.value })}
                        >
                          {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </Select>
                      </div>
                    )}
                    {!isText && (
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: 140 }}>
                        <Caption1>Visual</Caption1>
                        <Select value={t.viz} onChange={(_: unknown, d: any) => updateTile(i, { viz: d.value as TileViz })} aria-label="Tile visual type">
                          {TILE_VIZ_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                        </Select>
                      </div>
                      <div style={{ flex: 1, minWidth: 140 }}>
                        <Caption1>Data source</Caption1>
                        <Select value={t.dataSourceId || ''} onChange={(_: unknown, d: any) => updateTile(i, { dataSourceId: d.value || undefined })} aria-label="Tile data source">
                          <option value="">{`(dashboard default: ${defaultDb})`}</option>
                          {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name} → {ds.database}</option>)}
                        </Select>
                      </div>
                    </div>
                    )}
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Width (1–12)</Caption1>
                        <Input type="number" value={String(t.w || 4)} onChange={(_: unknown, d: any) => updateTile(i, { w: Math.max(1, Math.min(12, parseInt(d.value, 10) || 4)) })} aria-label="Tile width" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Height (1–8)</Caption1>
                        <Input type="number" value={String(t.h || 2)} onChange={(_: unknown, d: any) => updateTile(i, { h: Math.max(1, Math.min(8, parseInt(d.value, 10) || 2)) })} aria-label="Tile height" />
                      </div>
                    </div>
                    {isText ? (
                      <>
                        {/* U8 — text tile: markdown content + live preview.
                            No query, no data source — nothing executes. */}
                        <Caption1>Markdown content</Caption1>
                        <MonacoTextarea
                          value={t.markdown || ''}
                          onChange={(v) => updateTile(i, { markdown: v })}
                          language="markdown"
                          height={200}
                          minHeight={140}
                          ariaLabel={`Tile ${i + 1} markdown content`}
                        />
                        <Caption1>Preview</Caption1>
                        <div
                          className={tc.mdBody}
                          style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS }}
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(t.markdown || '') }}
                        />
                      </>
                    ) : (
                    <>
                    <Caption1>KQL query{baseQueries.length > 0 ? ' — reference a base query as $baseQuery(\'name\')' : ''}</Caption1>
                    <MonacoTextarea
                      value={t.kql}
                      onChange={(v) => updateTile(i, { kql: v })}
                      language="kql"
                      height={220}
                      minHeight={180}
                      ariaLabel={`Tile ${i + 1} KQL`}
                    />
                    <Button size="small" appearance="primary" icon={<Play20Regular />} onClick={() => runTile(i)}>Run tile</Button>
                    {t.error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{t.error}</MessageBarBody></MessageBar>}
                    {t.result && t.result.ok && (
                      <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS }}>
                        <TileVisual viz={t.viz} result={t.result} conditionalRules={t.conditionalRules} />
                      </div>
                    )}

                    {/* Drill-through (Fabric: visual Interactions > Drillthrough).
                        Clicking a result value sets a dashboard parameter, re-runs
                        every tile (cross-filter), and optionally navigates to a
                        target page (U8 pages). */}
                    <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalXS}}>
                      <Caption1 style={{ fontWeight: 600 }}>Drill-through</Caption1>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalXS}}>
                        Clicking a value in this tile injects it into a dashboard parameter and re-runs all tiles{depthEnabled && pages.length > 0 ? ' — optionally navigating to a target page' : ''}.
                      </Caption1>
                      {params.length === 0 ? (
                        <MessageBar intent="info">
                          <MessageBarBody>
                            Add at least one dashboard <strong>Parameter</strong> first — drill-through targets a parameter.
                          </MessageBarBody>
                        </MessageBar>
                      ) : (
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            <Caption1>Column (from query result)</Caption1>
                            {t.result?.ok && (t.result.columns?.length ?? 0) > 0 ? (
                              <Select
                                value={t.drillthrough?.column || ''}
                                aria-label="Drillthrough column"
                                onChange={(_: unknown, d: any) => {
                                  const column = d.value;
                                  const paramName = t.drillthrough?.paramName || '';
                                  updateTile(i, {
                                    drillthrough: column.trim() || paramName ? { column, paramName, targetPageId: t.drillthrough?.targetPageId } : undefined,
                                  });
                                }}
                              >
                                <option value="">(none)</option>
                                {(t.result.columns || []).map((c) => (
                                  <option key={c} value={c}>{c}</option>
                                ))}
                              </Select>
                            ) : (
                              <Input
                                value={t.drillthrough?.column || ''}
                                placeholder="Run the tile to pick a column"
                                aria-label="Drillthrough column"
                                onChange={(_: unknown, d: any) => {
                                  const column = d.value;
                                  const paramName = t.drillthrough?.paramName || '';
                                  updateTile(i, {
                                    drillthrough: column.trim() || paramName ? { column, paramName, targetPageId: t.drillthrough?.targetPageId } : undefined,
                                  });
                                }}
                              />
                            )}
                          </div>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            <Caption1>Target parameter</Caption1>
                            <Select
                              value={t.drillthrough?.paramName || ''}
                              aria-label="Drillthrough target parameter"
                              onChange={(_: unknown, d: any) => {
                                const paramName = d.value;
                                const column = t.drillthrough?.column || '';
                                updateTile(i, {
                                  drillthrough: column.trim() || paramName ? { column, paramName, targetPageId: t.drillthrough?.targetPageId } : undefined,
                                });
                              }}
                            >
                              <option value="">(none — disable drill-through)</option>
                              {params.map((p) => (
                                <option key={p.variableName} value={p.variableName}>{p.label || p.variableName}</option>
                              ))}
                            </Select>
                          </div>
                          {/* U8 — navigate to a page after injecting the value. */}
                          {depthEnabled && pages.length > 0 && (
                            <div style={{ flex: 1, minWidth: 140 }}>
                              <Caption1>Target page</Caption1>
                              <Select
                                value={t.drillthrough?.targetPageId || ''}
                                aria-label="Drillthrough target page"
                                disabled={!t.drillthrough?.paramName}
                                onChange={(_: unknown, d: any) => {
                                  if (!t.drillthrough) return;
                                  updateTile(i, {
                                    drillthrough: { ...t.drillthrough, targetPageId: d.value || undefined },
                                  });
                                }}
                              >
                                <option value="">(stay on this page)</option>
                                {pages.map((p) => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                              </Select>
                            </div>
                          )}
                        </div>
                      )}
                      {t.drillthrough?.column && t.drillthrough?.paramName && (
                        <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXS}}>
                          Click a value in this tile → sets <code>{t.drillthrough.paramName}</code> to the value in column <code>{t.drillthrough.column}</code>
                          {t.drillthrough.targetPageId && pages.some((p) => p.id === t.drillthrough?.targetPageId)
                            ? <>, navigates to <strong>{pages.find((p) => p.id === t.drillthrough?.targetPageId)?.name}</strong>,</>
                            : ''} and re-runs all tiles.
                        </Caption1>
                      )}
                    </div>

                    {/* Conditional formatting (Fabric RTD: color by condition / by value).
                        Applies to table + stat (card) visuals. */}
                    {(t.viz === 'table' || t.viz === 'stat') && (
                      <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalXS}}>
                        <ConditionalFormattingEditor
                          viz={t.viz}
                          rules={t.conditionalRules || []}
                          columns={t.result?.columns || []}
                          onChange={(rules) => updateTile(i, { conditionalRules: rules.length ? rules : undefined })}
                        />
                      </div>
                    )}
                    </>
                    )}
                  </div>
                );
              })()}
            </DialogContent>
            <DialogActions>
              {tileFlyoutIdx !== null && (
                <Button appearance="secondary" icon={<Delete20Regular />} onClick={() => deleteTile(tileFlyoutIdx)}>Delete tile</Button>
              )}
              <Button appearance="primary" onClick={() => setTileFlyoutIdx(null)}>Apply</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Set alert on tile — Fabric Real-Time Dashboard "Set alert" parity.
          Creates a REAL Activator rule (sourceKind:'adx') from the tile's KQL,
          routed through the ADX-native Activator runtime: the rule's KQL runs
          against the tile's resolved KQL database on the Azure Data Explorer
          cluster (kusto-client), with an ADX-scoped Azure Monitor
          scheduledQueryRule for hands-off evaluation when LOOM_ADX_ALERT_SCOPE
          is provisioned. A backing Activator item is lazily created + linked
          onto this dashboard (state.activatorId). Azure-native; no Fabric. */}
      <Dialog open={alertTileIdx !== null} onOpenChange={(_: unknown, d: any) => { if (!d.open && !alertBusy) setAlertTileIdx(null); }}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <Alert20Regular /> Set alert on tile
              </span>
            </DialogTitle>
            <DialogContent>
              {alertTileIdx !== null && tiles[alertTileIdx] && (() => {
                const t = tiles[alertTileIdx];
                const db = tileDatabase(t);
                const opGlyph = { gt: '>', lt: '<', gte: '≥', lte: '≤', eq: '=', ne: '≠', contains: 'contains' }[alertOperator];
                const freqLabel = { PT1M: '1 minute', PT5M: '5 minutes', PT15M: '15 minutes', PT1H: '1 hour' }[alertFrequency];
                return (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        gap: tokens.spacingHorizontalS,
                        padding: tokens.spacingVerticalS,
                        borderRadius: tokens.borderRadiusMedium,
                        border: `1px solid ${tokens.colorNeutralStroke2}`,
                        background: tokens.colorNeutralBackground2,
                      }}
                    >
                      <Alert20Regular style={{ flexShrink: 0, marginTop: tokens.spacingVerticalXXS, color: tokens.colorBrandForeground1 }} />
                      <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
                        Creates an <strong>Activator</strong> rule from this tile&apos;s KQL, linked to this
                        dashboard. The rule evaluates against <strong>{db}</strong> on the Azure Data
                        Explorer cluster (Azure-native default — no Microsoft Fabric Reflex required)
                        and fires when the condition below matches.
                      </Caption1>
                    </div>
                    <Field label={`Tile query — "${t.title}"`} style={{ marginTop: tokens.spacingVerticalM }}
                      hint="Base queries, parameters, and the dashboard time range are substituted when the rule is created.">
                      <div
                        style={{
                          fontFamily: tokens.fontFamilyMonospace,
                          fontSize: tokens.fontSizeBase200,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          maxHeight: 120,
                          overflowY: 'auto',
                          padding: tokens.spacingVerticalS,
                          borderRadius: tokens.borderRadiusMedium,
                          border: `1px solid ${tokens.colorNeutralStroke2}`,
                          background: tokens.colorNeutralBackground3,
                          color: tokens.colorNeutralForeground1,
                        }}
                      >
                        {t.kql}
                      </div>
                    </Field>
                    <Field label="Alert name" style={{ marginTop: tokens.spacingVerticalM }}>
                      <Input value={alertName} onChange={(_: unknown, d: any) => setAlertName(d.value)}
                        placeholder={`${t.title}-alert`} aria-label="Alert name" />
                    </Field>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM, flexWrap: 'wrap' }}>
                      <Field label="Fire when" style={{ flex: 2, minWidth: 200 }}>
                        <Select value={alertFireOn} aria-label="Fire when"
                          onChange={(_: unknown, d: any) => setAlertFireOn(d.value as 'rows' | 'condition')}>
                          <option value="rows">The query returns any rows</option>
                          <option value="condition">A result column crosses a threshold</option>
                        </Select>
                      </Field>
                      <Field label="Evaluate every" style={{ flex: 1, minWidth: 130 }}>
                        <Select value={alertFrequency} aria-label="Evaluation frequency"
                          onChange={(_: unknown, d: any) => setAlertFrequency(d.value)}>
                          <option value="PT1M">1 minute</option>
                          <option value="PT5M">5 minutes</option>
                          <option value="PT15M">15 minutes</option>
                          <option value="PT1H">1 hour</option>
                        </Select>
                      </Field>
                    </div>
                    {alertFireOn === 'condition' && (
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM, flexWrap: 'wrap' }}>
                        <div style={{ flex: 2, minWidth: 150 }}>
                          <Field label="Result column">
                            <CfColumnField label="Alert condition column" value={alertColumn}
                              columns={t.result?.columns || []} onChange={setAlertColumn} />
                          </Field>
                        </div>
                        <Field label="Operator" style={{ flex: 1, minWidth: 120 }}>
                          <Select value={alertOperator} aria-label="Alert operator"
                            onChange={(_: unknown, d: any) => setAlertOperator(d.value)}>
                            <option value="gt">greater than</option>
                            <option value="lt">less than</option>
                            <option value="gte">≥</option>
                            <option value="lte">≤</option>
                            <option value="eq">equals</option>
                            <option value="ne">not equals</option>
                            <option value="contains">contains</option>
                          </Select>
                        </Field>
                        <Field label="Threshold" style={{ flex: 1, minWidth: 90 }}>
                          <Input value={alertThreshold} onChange={(_: unknown, d: any) => setAlertThreshold(d.value)}
                            placeholder="0" aria-label="Alert threshold" />
                        </Field>
                      </div>
                    )}
                    <Field label="Notify email (optional)" style={{ marginTop: tokens.spacingVerticalM }}
                      hint="Creates a real Azure Monitor action group receiver for the rule.">
                      <Input value={alertEmail} onChange={(_: unknown, d: any) => setAlertEmail(d.value)}
                        placeholder="oncall@contoso.com" aria-label="Notify email" />
                    </Field>
                    {/* Live rule preview — mirrors the Azure portal's alert condition summary. */}
                    <div
                      aria-live="polite"
                      style={{
                        marginTop: tokens.spacingVerticalM,
                        padding: tokens.spacingVerticalS,
                        borderRadius: tokens.borderRadiusMedium,
                        background: tokens.colorNeutralBackground3,
                        border: `1px solid ${tokens.colorNeutralStroke2}`,
                      }}
                    >
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Rule preview</Caption1>
                      <div style={{ marginTop: tokens.spacingVerticalXS, fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground1 }}>
                        {alertFireOn === 'rows'
                          ? <>Fire when the tile query returns <strong>any rows</strong> on <strong>{db}</strong></>
                          : <>Fire when <strong>{alertColumn.trim() || 'value'}</strong> {opGlyph} <strong>{alertThreshold.trim() || '0'}</strong> on <strong>{db}</strong></>}
                        , evaluated every {freqLabel}
                        {alertEmail.trim() ? <> → email <strong>{alertEmail.trim()}</strong></> : null}.
                      </div>
                    </div>
                    {alertErr && (
                      <MessageBar intent={alertHint ? 'warning' : 'error'} style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>
                          <MessageBarTitle>{alertHint ? 'Azure backend not configured' : 'Set alert failed'}</MessageBarTitle>
                          {alertErr}{alertHint ? <><br /><Caption1>{alertHint}</Caption1></> : null}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {alertResult && !alertErr && (
                      <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>
                          <MessageBarTitle>Alert created and linked</MessageBarTitle>
                          Linked Activator <strong>{alertResult.activatorName || alertResult.activatorId}</strong> with
                          rule <code>{alertResult.ruleId}</code> on <strong>{alertResult.database || db}</strong>.
                          {alertResult.preview && (
                            <> Evaluated now against the live cluster: <strong>{alertResult.preview.fired ? 'would fire' : 'would not fire'}</strong> ({alertResult.preview.count} row{alertResult.preview.count === 1 ? '' : 's'}).</>
                          )}
                          {' '}
                          <Link href={`/items/activator/${alertResult.activatorId}`} target="_blank">
                            Open the Activator <Open20Regular style={{ verticalAlign: 'middle' }} />
                          </Link>
                          {alertResult.previewError && (
                            <><br /><Caption1>Live evaluation unavailable: {alertResult.previewError}</Caption1></>
                          )}
                          {!alertResult.scheduled && alertResult.note && (
                            <><br /><Caption1>{alertResult.note}</Caption1></>
                          )}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </>
                );
              })()}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAlertTileIdx(null)} disabled={alertBusy}>Close</Button>
              <Button appearance="primary" icon={alertBusy ? <Spinner size="tiny" /> : <Alert20Regular />}
                onClick={doSetAlert}
                disabled={alertBusy || (alertFireOn === 'condition' && !alertThreshold.trim())}>
                {alertBusy ? 'Creating…' : 'Create alert'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Base queries dialog — shared KQL snippets referenced via $baseQuery('name') */}
      <Dialog open={baseQueriesOpen} onOpenChange={(_: unknown, d: any) => setBaseQueriesOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>Base queries</DialogTitle>
            <DialogContent>
              <BaseQueriesPanel baseQueries={baseQueries} onAdd={addBaseQuery} onUpdate={updateBaseQuery} onRemove={removeBaseQuery} />
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setBaseQueriesOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* AI tile generator dialog (NL → KQL) — Fabric RTI "Copilot add a tile" parity. */}
      <Dialog open={aiOpen} onOpenChange={(_: unknown, d: any) => { if (!aiBusy) setAiOpen(d.open); }}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
                <Sparkle20Regular /> Add a tile with Copilot
              </span>
            </DialogTitle>
            <DialogContent>
              <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
                Describe the visualization you want in plain language. Copilot reads the live
                schema of <strong>{defaultDb}</strong>, writes the KQL, picks a chart type, and
                validates the query against Azure Data Explorer before adding the tile.
              </Caption1>
              <Field label="What should this tile show?">
                <Textarea
                  value={aiPrompt}
                  onChange={(_: unknown, d: any) => setAiPrompt(d.value)}
                  placeholder="e.g. Count of failed requests per service over time as a line chart"
                  rows={3}
                  disabled={aiBusy}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !aiBusy) { e.preventDefault(); generateTile(); }
                  }}
                />
              </Field>
              <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                Press <kbd style={{ fontFamily: tokens.fontFamilyMonospace }}>Ctrl</kbd>+<kbd style={{ fontFamily: tokens.fontFamilyMonospace }}>Enter</kbd> to generate.
              </Caption1>
              {dataSources.length > 0 && (
                <Field label="Data source (optional)" style={{ marginTop: tokens.spacingVerticalM}}>
                  <Select value={aiDataSourceId} onChange={(_: unknown, d: any) => setAiDataSourceId(d.value)} disabled={aiBusy}>
                    <option value="">Dashboard default ({defaultDb})</option>
                    {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name} · {ds.database}</option>)}
                  </Select>
                </Field>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalM}}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3, width: '100%' }}>Try:</Caption1>
                {[
                  'Total events in the last 24 hours',
                  'Top 10 error messages by count as a bar chart',
                  'Requests per minute over time',
                ].map((ex) => (
                  <Button
                    key={ex}
                    size="small"
                    appearance="outline"
                    shape="circular"
                    disabled={aiBusy}
                    onClick={() => setAiPrompt(ex)}
                  >
                    {ex}
                  </Button>
                ))}
              </div>
              {aiErr && (
                <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM}}>
                  <MessageBarBody><MessageBarTitle>Could not generate the tile</MessageBarTitle>{aiErr}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAiOpen(false)} disabled={aiBusy}>Cancel</Button>
              <Button appearance="primary" icon={aiBusy ? <Spinner size="tiny" /> : <Sparkle20Regular />} onClick={generateTile} disabled={aiBusy || !aiPrompt.trim()}>
                {aiBusy ? 'Generating…' : 'Generate tile'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Data sources dialog */}
      <Dialog open={sourcesOpen} onOpenChange={(_: unknown, d: any) => setSourcesOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 620 }}>
          <DialogBody>
            <DialogTitle>Data sources</DialogTitle>
            <DialogContent>
              <Caption1>Bind the dashboard to one or more KQL databases on the Loom shared ADX cluster. Tiles select a source; query-based parameters can run against a source.</Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS}}>
                {dataSources.map((ds, idx) => (
                  <div key={ds.id} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <Caption1>Name</Caption1>
                      <Input value={ds.name} onChange={(_: unknown, d: any) => updateDataSource(idx, { name: d.value })} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Caption1>KQL database</Caption1>
                      {clusterDbs.length > 0 ? (
                        <Select
                          value={clusterDbs.includes(ds.database) ? ds.database : '__custom__'}
                          onChange={(_: unknown, d: any) => { if (d.value !== '__custom__') updateDataSource(idx, { database: d.value }); }}
                          aria-label="KQL database"
                        >
                          {clusterDbs.map((db) => <option key={db} value={db}>{db}</option>)}
                          <option value="__custom__">Other (type below)…</option>
                        </Select>
                      ) : null}
                      {(clusterDbs.length === 0 || !clusterDbs.includes(ds.database)) && (
                        <Input value={ds.database} onChange={(_: unknown, d: any) => updateDataSource(idx, { database: d.value })} placeholder="loomdb-default" aria-label="KQL database (custom)" style={{ marginTop: clusterDbs.length > 0 ? 4 : 0 }} />
                      )}
                    </div>
                    <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeDataSource(idx)} aria-label="Remove data source" />
                  </div>
                ))}
                {dataSources.length === 0 && <Caption1>No explicit data sources — tiles use the dashboard default database <strong>{defaultDb}</strong>.</Caption1>}
                <Button appearance="outline" icon={<Add20Regular />} onClick={addDataSource}>Add data source</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setSourcesOpen(false)}>Done</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Parameters dialog — free-text / fixed / multi / query / datasource / duration */}
      <Dialog open={paramsOpen} onOpenChange={(_: unknown, d: any) => setParamsOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 720 }}>
          <DialogBody>
            <DialogTitle>Dashboard parameters</DialogTitle>
            <DialogContent>
              <Caption1>
                Parameters substitute into tile KQL by their variable name (Fabric convention, e.g. <code>_eventType</code>).
                Time range exposes <code>_startTime</code>/<code>_endTime</code>; <code>_loomTimeFrom</code> is also supported.
                <code> multi</code> renders as <code>dynamic([...])</code> for <code>x in (_var)</code> filters.
              </Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS}}>
                {params.map((p, idx) => (
                  <div key={idx} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Variable name</Caption1>
                        <Input value={p.variableName} onChange={(_: unknown, d: any) => updateParam(idx, { variableName: d.value })} placeholder="_eventType" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Label</Caption1>
                        <Input value={p.label || ''} onChange={(_: unknown, d: any) => updateParam(idx, { label: d.value })} />
                      </div>
                      <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeParam(idx)} aria-label="Remove parameter" />
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Type</Caption1>
                        <Select value={p.type} onChange={(_: unknown, d: any) => updateParam(idx, { type: d.value as DashParamType })}>
                          <option value="freetext">Free text</option>
                          <option value="fixed">Fixed values (single)</option>
                          <option value="multi">Multi-select</option>
                          <option value="query">Query-based</option>
                          <option value="datasource">Data source</option>
                          <option value="duration">Duration (time range)</option>
                        </Select>
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Data type</Caption1>
                        <Select value={p.dataType || 'string'} onChange={(_: unknown, d: any) => updateParam(idx, { dataType: d.value as DashParamDataType })}>
                          <option value="string">string</option>
                          <option value="long">long</option>
                          <option value="int">int</option>
                          <option value="real">real</option>
                          <option value="datetime">datetime</option>
                          <option value="bool">bool</option>
                        </Select>
                      </div>
                    </div>
                    {(p.type === 'fixed' || p.type === 'multi') && (
                      <div>
                        <Caption1>Allowed values (comma-separated)</Caption1>
                        <Input value={(p.values || []).join(',')} onChange={(_: unknown, d: any) => updateParam(idx, { values: d.value.split(',').map((x: string) => x.trim()).filter(Boolean) })} />
                      </div>
                    )}
                    {p.type === 'query' && (
                      <>
                        <Caption1>Values query (returns one column)</Caption1>
                        <Textarea value={p.query || ''} onChange={(_: unknown, d: any) => updateParam(idx, { query: d.value })} rows={2} style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200}} placeholder="StormEvents | distinct State" />
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
                          <div style={{ flex: 1 }}>
                            <Caption1>Run against source</Caption1>
                            <Select value={p.dataSourceId || ''} onChange={(_: unknown, d: any) => updateParam(idx, { dataSourceId: d.value || undefined })}>
                              <option value="">{`(default: ${defaultDb})`}</option>
                              {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name}</option>)}
                            </Select>
                          </div>
                          <Button size="small" appearance="outline" onClick={() => loadParamValues(p)}>Preview values</Button>
                        </div>
                        {paramValueCache[p.variableName] && <Caption1>{paramValueCache[p.variableName].length} values loaded.</Caption1>}
                      </>
                    )}
                  </div>
                ))}
                <Button appearance="outline" icon={<Add20Regular />} onClick={addParam}>Add parameter</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setParamsOpen(false)}>Close</Button>
              <Button appearance="primary" onClick={() => { setParamsOpen(false); runAll(); }}>Apply &amp; re-run</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Edit JSON model dialog */}
      <Dialog open={jsonOpen} onOpenChange={(_: unknown, d: any) => setJsonOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Edit dashboard model (JSON)</DialogTitle>
            <DialogContent>
              <Caption1>Full model: <code>{`{ tiles, dataSources, parameters, baseQueries, pages, timeRange }`}</code>. An array root is accepted as just the tiles.</Caption1>
              <Textarea
                value={jsonText}
                onChange={(_: unknown, d: any) => { setJsonText(d.value); setJsonErr(null); }}
                rows={20}
                style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, marginTop: tokens.spacingVerticalS}}
                aria-label="Dashboard JSON model"
              />
              {jsonErr && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody><MessageBarTitle>JSON parse error</MessageBarTitle>{jsonErr}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setJsonOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={applyJson}>Apply</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Share dialog */}
      <Dialog open={shareOpen} onOpenChange={(_: unknown, d: any) => setShareOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Share dashboard</DialogTitle>
            <DialogContent>
              <Caption1>Anyone with access to this Loom item can view it. Permissions are managed via the workspace item ACL.</Caption1>
              <div style={{ marginTop: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                <Caption1>Canonical URL</Caption1>
                <Input value={typeof window !== 'undefined' ? window.location.href : ''} readOnly />
                <Button appearance="outline" onClick={() => { if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(window.location.href).catch(() => {}); }}>Copy URL</Button>
                <Caption1>To grant another user access, add them to this item via the workspace permissions page (Loom RBAC). Tenant-wide sharing is not enabled in this deployment.</Caption1>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setShareOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Anomaly / forecast tile builder — native-KQL time-series ML over ADX.
          The dialog composes the series_decompose KQL and hands it back; we add
          it as a time-chart tile bound to the dashboard default database. */}
      <AnomalyForecastDialog
        open={anomalyOpen}
        onOpenChange={setAnomalyOpen}
        itemId={id}
        database={defaultDb}
        fetchSchema={false}
        defaultMode="anomaly"
        onAddTile={addAnomalyTile}
      />
    </div>
  );

  // On /new there is no Cosmos record yet, so Save (PUT) / Run (POST) would
  // 404/operate without persistence. Mirror the Eventstream/Activator pattern:
  // an ENABLED create surface mints a Cosmos kql-dashboard item, then routes to
  // this live editor where Add tile + Run + Save + parameters all work against
  // the real Kusto cluster + Cosmos.
  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="New Real-Time Dashboard"
        intro="A Real-Time (KQL) Dashboard is a collection of tiles — each a KQL query bound to a KQL database, rendered as a table, time chart, bar/column, pie, stat card, or map. Bind data sources, add dashboard parameters (free-text, fixed, query-based, time range) that substitute into tile KQL, set auto-refresh, and Save. Create it, then build tiles that run live against the Loom shared ADX cluster." />
    );
  }

  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={main} />;
}
