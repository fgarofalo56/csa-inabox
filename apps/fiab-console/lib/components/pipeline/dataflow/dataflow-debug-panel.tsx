'use client';

/**
 * DataflowDebugPanel (U7) — the ADF-Studio-parity **Debug mode** dock for the
 * Mapping Data Flow designer. Sits below the canvas and drives the real ADF
 * data-flow debug session:
 *
 *   ┌ Debug ●active · expires 58m · [Managed IR] ────────── [Debug ▮] ┐
 *   │ [ Data preview | Inspect | Statistics ]                          │  ← tabs
 *   │  Transform ▾  Sample [100]  [Run]                                │
 *   │  … grid / schema-drift table / per-column profile cards …        │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Toggling Debug ON acquires a HELD debug session (POST ../debug/session
 * { action:'acquire' } → a short-lived Spark cluster on the deployment-default
 * factory's Managed IR); every tab runs against that same warm session so
 * per-transform preview / inspect / stats is cheap. Toggling OFF (or unmounting)
 * releases it. Data rows are TYPE-BADGED via the shared PreviewTable (timing
 * status bar per ux-standards) and come ONLY from the live session — never faked
 * (no-vaporware.md). Azure-native ADF, no Fabric (no-fabric-dependency.md).
 *
 *   PR-1: session lifecycle + Data preview tab.
 *   PR-2 (this): Inspect (in/out schema + drift) + Statistics (per-column profile
 *                + top-value mini-histograms via loom-chart).
 *   PR-3: preview-grid quick-actions.
 *
 * Gated by the FLAG0 runtime flag `u7-dataflow-debug` at the editor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Caption1, Field, Input, MessageBar, MessageBarBody,
  MessageBarTitle, Select, Spinner, Switch, TabList, Tab, Tooltip, Text,
  Subtitle2,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuGroup, MenuGroupHeader,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Bug20Regular, Eye20Regular, TableSearch20Regular, DataHistogram20Regular,
  MoreHorizontal16Regular, ArrowSwap16Regular, Edit16Regular, Delete16Regular,
} from '@fluentui/react-icons';
import { PreviewTable, type PreviewData } from '@/lib/components/shared/preview-table';
import { LoomChart } from '@/lib/components/charts/loom-chart';
import { clientFetch } from '@/lib/client-fetch';
import {
  serializeDataFlow, type MappingDataFlowGraph, type DataflowQuickAction,
} from './mapping-dataflow-designer';
import type { DfsColumn, SchemaDriftEntry, ColumnStat } from '@/lib/azure/dataflow-debug';

/** DFS types offered by the Typecast quick-action submenu. */
const CAST_TYPES = ['string', 'integer', 'long', 'double', 'boolean', 'date', 'timestamp'] as const;

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  head: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  headTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  controls: {
    display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
  },
  streamField: { minWidth: '220px' },
  sampleField: { width: '96px' },
  meta: { color: tokens.colorNeutralForeground3 },
  gateCode: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    paddingInline: tokens.spacingHorizontalXXS,
    borderRadius: tokens.borderRadiusSmall,
  },
  breakText: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, maxWidth: '100%' },
  // Inspect — two schema columns (in | out) with a drift table.
  inspectGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  schemaCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    minWidth: 0,
  },
  schemaRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS, minWidth: 0,
  },
  colName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  colType: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3, flexShrink: 0 },
  driftWrap: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXS,
  },
  // Statistics — per-column profile cards.
  statsGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  statCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    minWidth: 0,
  },
  statHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  statMetrics: {
    display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
  },
  metric: { display: 'flex', justifyContent: 'space-between', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  metricLabel: { color: tokens.colorNeutralForeground3 },
  metricVal: { fontFamily: tokens.fontFamilyMonospace, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

/** Debug tabs. */
type DebugTab = 'preview' | 'inspect' | 'stats';

export interface DataflowDebugPanelProps {
  /** Data-flow resource name (the item id / ADF dataflow name). */
  name: string;
  /** Live authored graph (mirrored from the designer via onChange). */
  graph: MappingDataFlowGraph;
  /** True when a data-flow-capable factory is configured (probed by the editor). */
  debugAvailable: boolean;
  /** Editor's currently-selected transform, used as the default stream. */
  selectedTransform?: string | null;
  /** The item hasn't been saved yet — datasets can't resolve; runs are disabled. */
  isNew?: boolean;
  /**
   * U7 PR-3 — apply a debug-grid column quick-action (Typecast / Modify /
   * Remove) by inserting the generated transform into the designer's graph
   * (draft). Omit to hide the preview-grid column menu. `fromStream` is filled
   * by the panel (the previewed transform).
   */
  onQuickAction?: (spec: DataflowQuickAction) => void;
}

interface SessionState {
  sessionId: string;
  expiresAt: number;
  integrationRuntime?: string;
}

interface SchemaResult {
  in: DfsColumn[];
  out: DfsColumn[];
  drift: SchemaDriftEntry[];
}

interface StatsResult {
  sampleSize: number;
  rowCount: number;
  stats: ColumnStat[];
}

/** Minutes-remaining label for the session chip. */
function remainingLabel(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  const min = Math.round(ms / 60_000);
  return min >= 1 ? `expires ${min}m` : 'expires <1m';
}

const RUN_TIMEOUT_MS = 120_000;

/** Round a number for display without noisy floats. */
function fmtNum(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(Math.abs(n) < 1 ? 4 : 2);
}

export function DataflowDebugPanel({
  name, graph, debugAvailable, selectedTransform, isNew, onQuickAction,
}: DataflowDebugPanelProps) {
  const s = useStyles();

  const [tab, setTab] = useState<DebugTab>('preview');
  const [debugOn, setDebugOn] = useState(false);
  const [session, setSession] = useState<SessionState | null>(null);
  const [acquiring, setAcquiring] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionGate, setSessionGate] = useState<string | null>(null);

  const [previewStream, setPreviewStream] = useState('');
  const [sampleSize, setSampleSize] = useState(100);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLabel, setPreviewLabel] = useState('');

  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schema, setSchema] = useState<SchemaResult | null>(null);

  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [stats, setStats] = useState<StatsResult | null>(null);

  const sessionRef = useRef<SessionState | null>(null);
  sessionRef.current = session;

  const streamNames = useMemo(() => graph.transforms.map((t) => t.name), [graph.transforms]);

  // The primary upstream stream for the selected transform (min toSlot), so the
  // Inspect pane can diff its IN schema against its OUT schema. A Source has none.
  const primaryInput = useMemo(() => {
    const ins = graph.streams
      .filter((st) => st.to === previewStream)
      .sort((a, b) => (a.toSlot ?? 0) - (b.toSlot ?? 0));
    return ins[0]?.from;
  }, [graph.streams, previewStream]);

  useEffect(() => {
    setPreviewStream((cur) => {
      if (cur && streamNames.includes(cur)) return cur;
      if (selectedTransform && streamNames.includes(selectedTransform)) return selectedTransform;
      return streamNames[0] || '';
    });
  }, [streamNames, selectedTransform]);

  // Changing the target stream invalidates any prior inspect/stats result.
  useEffect(() => { setSchema(null); setStats(null); setSchemaError(null); setStatsError(null); }, [previewStream]);

  const releaseSession = useCallback(async (sid: string) => {
    await clientFetch(
      `/api/items/mapping-dataflow/${encodeURIComponent(name)}/debug/session`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'release', sessionId: sid }),
        keepalive: true,
      },
    ).catch(() => {});
  }, [name]);

  const acquireSession = useCallback(async () => {
    setAcquiring(true);
    setSessionError(null);
    setSessionGate(null);
    try {
      const r = await clientFetch(
        `/api/items/mapping-dataflow/${encodeURIComponent(name)}/debug/session`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'acquire' }),
        },
        RUN_TIMEOUT_MS,
      );
      const j = await r.json().catch(() => ({}));
      if (r.status === 503) {
        setSessionGate(String(j?.gate?.remediation || j?.error || 'A data-flow debug session is not available in this deployment.'));
        setDebugOn(false);
        return false;
      }
      if (!r.ok || j?.ok === false || !j?.sessionId) {
        setSessionError(String(j?.error || `HTTP ${r.status}`));
        setDebugOn(false);
        return false;
      }
      setSession({
        sessionId: String(j.sessionId),
        expiresAt: j.expiresAt ? Date.parse(j.expiresAt) : Date.now() + 60 * 60_000,
        integrationRuntime: j.integrationRuntime,
      });
      return true;
    } catch (e: unknown) {
      setSessionError(e instanceof Error ? e.message : String(e));
      setDebugOn(false);
      return false;
    } finally {
      setAcquiring(false);
    }
  }, [name]);

  const onToggleDebug = useCallback(async (next: boolean) => {
    setDebugOn(next);
    if (next) {
      await acquireSession();
    } else {
      const sid = sessionRef.current?.sessionId;
      setSession(null);
      setPreview(null); setSchema(null); setStats(null);
      setPreviewError(null); setSchemaError(null); setStatsError(null);
      if (sid) await releaseSession(sid);
    }
  }, [acquireSession, releaseSession]);

  useEffect(() => () => {
    const sid = sessionRef.current?.sessionId;
    if (sid) void releaseSession(sid);
  }, [releaseSession]);

  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [session]);

  /** Shared "session gone" handler — drops the session so the toggle reflects reality. */
  const handleSessionGone = useCallback((setErr: (m: string) => void) => {
    setSession(null);
    setDebugOn(false);
    setErr('The debug session expired. Turn Debug on again to start a new one.');
  }, []);

  const runPreview = useCallback(async (stream: string) => {
    if (!session || !stream) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const r = await clientFetch(
        `/api/items/mapping-dataflow/${encodeURIComponent(name)}/debug/preview`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: session.sessionId, transformId: stream, sampleSize, dataFlow: serializeDataFlow(graph) }),
        },
        RUN_TIMEOUT_MS,
      );
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j?.code === 'session_gone') { handleSessionGone(setPreviewError); setPreview(null); return; }
      if (r.status === 503) { setPreviewError(String(j?.gate?.remediation || j?.error || 'Debug session not available.')); setPreview(null); return; }
      if (!r.ok || j?.ok === false) { setPreviewError(String(j?.error || `HTTP ${r.status}`)); setPreview(null); return; }
      setPreview({
        columns: Array.isArray(j.columns) ? j.columns.map(String) : [],
        rows: Array.isArray(j.rows) ? j.rows : [],
        rowCount: typeof j.rowCount === 'number' ? j.rowCount : undefined,
        elapsedMs: typeof j.elapsedMs === 'number' ? j.elapsedMs : undefined,
        truncated: typeof j.rowCount === 'number' && j.rowCount >= sampleSize,
      });
      setPreviewLabel(String(j.streamName || stream));
    } catch (e: unknown) {
      setPreviewError(e instanceof Error ? e.message : String(e));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [session, name, sampleSize, graph, handleSessionGone]);

  const runInspect = useCallback(async (stream: string) => {
    if (!session || !stream) return;
    setSchemaLoading(true);
    setSchemaError(null);
    try {
      const r = await clientFetch(
        `/api/items/mapping-dataflow/${encodeURIComponent(name)}/debug/schema`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: session.sessionId, transformId: stream, inputId: primaryInput, dataFlow: serializeDataFlow(graph) }),
        },
        RUN_TIMEOUT_MS,
      );
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j?.code === 'session_gone') { handleSessionGone(setSchemaError); setSchema(null); return; }
      if (r.status === 503) { setSchemaError(String(j?.gate?.remediation || j?.error || 'Debug session not available.')); setSchema(null); return; }
      if (!r.ok || j?.ok === false) { setSchemaError(String(j?.error || `HTTP ${r.status}`)); setSchema(null); return; }
      setSchema({
        in: Array.isArray(j.in) ? j.in : [],
        out: Array.isArray(j.out) ? j.out : [],
        drift: Array.isArray(j.drift) ? j.drift : [],
      });
    } catch (e: unknown) {
      setSchemaError(e instanceof Error ? e.message : String(e));
      setSchema(null);
    } finally {
      setSchemaLoading(false);
    }
  }, [session, name, primaryInput, graph, handleSessionGone]);

  const runStats = useCallback(async (stream: string) => {
    if (!session || !stream) return;
    setStatsLoading(true);
    setStatsError(null);
    try {
      const r = await clientFetch(
        `/api/items/mapping-dataflow/${encodeURIComponent(name)}/debug/stats`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: session.sessionId, transformId: stream, dataFlow: serializeDataFlow(graph) }),
        },
        RUN_TIMEOUT_MS,
      );
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j?.code === 'session_gone') { handleSessionGone(setStatsError); setStats(null); return; }
      if (r.status === 503) { setStatsError(String(j?.gate?.remediation || j?.error || 'Debug session not available.')); setStats(null); return; }
      if (!r.ok || j?.ok === false) { setStatsError(String(j?.error || `HTTP ${r.status}`)); setStats(null); return; }
      setStats({
        sampleSize: typeof j.sampleSize === 'number' ? j.sampleSize : 0,
        rowCount: typeof j.rowCount === 'number' ? j.rowCount : 0,
        stats: Array.isArray(j.stats) ? j.stats : [],
      });
    } catch (e: unknown) {
      setStatsError(e instanceof Error ? e.message : String(e));
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  }, [session, name, graph, handleSessionGone]);

  // The active tab's run action.
  const runActive = useCallback((stream: string) => {
    if (tab === 'preview') return runPreview(stream);
    if (tab === 'inspect') return runInspect(stream);
    return runStats(stream);
  }, [tab, runPreview, runInspect, runStats]);

  const sessionChip = session ? (
    <Badge appearance="tint" color="success" icon={<Bug20Regular />}>
      {`active · ${remainingLabel(session.expiresAt)}`}
    </Badge>
  ) : acquiring ? (
    <Badge appearance="tint" color="informative"><Spinner size="tiny" /> starting…</Badge>
  ) : (
    <Badge appearance="tint" color="subtle">off</Badge>
  );

  const previewSources = useMemo(
    () => (preview ? [{ id: 'preview', label: previewLabel || 'Data preview', data: preview }] : []),
    [preview, previewLabel],
  );

  // U7 PR-3 — the preview-grid column context menu (Typecast / Modify / Remove).
  // Each inserts a real transform wired off the previewed stream (draft; the
  // published flow is untouched until Save). Rendered only when the host wired
  // `onQuickAction` and the flow isn't read-only-new.
  const columnMenu = useCallback((columnName: string) => {
    if (!onQuickAction || isNew) return null;
    const from = previewLabel || previewStream;
    if (!from) return null;
    const emit = (spec: DataflowQuickAction) => onQuickAction(spec);
    return (
      <Menu positioning="below-end">
        <MenuTrigger disableButtonEnhancement>
          <Button
            size="small"
            appearance="subtle"
            icon={<MoreHorizontal16Regular />}
            aria-label={`Quick actions for column ${columnName}`}
          />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuGroup>
              <MenuGroupHeader>{columnName}</MenuGroupHeader>
              <Menu positioning="after-top">
                <MenuTrigger disableButtonEnhancement>
                  <MenuItem icon={<ArrowSwap16Regular />}>Typecast to…</MenuItem>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {CAST_TYPES.map((ty) => (
                      <MenuItem key={ty} onClick={() => emit({ action: 'typecast', fromStream: from, column: columnName, toType: ty })}>
                        {ty}
                      </MenuItem>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
              <MenuItem icon={<Edit16Regular />} onClick={() => emit({ action: 'modify', fromStream: from, column: columnName })}>
                Modify (Derived Column)
              </MenuItem>
              <MenuItem icon={<Delete16Regular />} onClick={() => emit({ action: 'remove', fromStream: from, column: columnName })}>
                Remove column
              </MenuItem>
            </MenuGroup>
          </MenuList>
        </MenuPopover>
      </Menu>
    );
  }, [onQuickAction, isNew, previewLabel, previewStream]);

  const runDisabled = previewLoading || schemaLoading || statsLoading || !debugOn || !session || !previewStream || isNew;
  const anyLoading = previewLoading || schemaLoading || statsLoading;
  const runLabel = tab === 'preview' ? 'Preview' : tab === 'inspect' ? 'Inspect' : 'Profile';

  return (
    <div className={s.root} data-component="dataflow-debug-panel">
      {/* Header: title · session chip · IR · Debug toggle */}
      <div className={s.head}>
        <div className={s.headTitle}>
          <Bug20Regular style={{ color: debugOn ? 'var(--loom-accent-emerald)' : tokens.colorNeutralForeground3 }} />
          <Text weight="semibold">Debug</Text>
          {sessionChip}
          {session?.integrationRuntime && (
            <Caption1 className={s.meta}>IR: {session.integrationRuntime}</Caption1>
          )}
        </div>
        <div className={s.spacer} />
        <Tooltip
          content={debugAvailable
            ? (debugOn ? 'Stop the data-flow debug session' : 'Start a held data-flow debug session')
            : 'A data-flow-capable Azure Integration Runtime is required'}
          relationship="label"
        >
          <Switch
            label="Data flow debug"
            checked={debugOn}
            disabled={acquiring}
            onChange={(_, d) => void onToggleDebug(d.checked)}
          />
        </Tooltip>
      </div>

      {sessionGate && (
        <MessageBar intent="warning">
          <MessageBarBody className={s.breakText}>
            <MessageBarTitle>Debug session not available</MessageBarTitle>
            {sessionGate} Authoring still writes the real ADF data-flow definition;
            preview / inspect / stats light up once a debug session can be started.
          </MessageBarBody>
        </MessageBar>
      )}
      {sessionError && (
        <MessageBar intent="error">
          <MessageBarBody className={s.breakText}>
            <MessageBarTitle>Couldn’t start the debug session</MessageBarTitle>
            {sessionError}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Tabs. */}
      <TabList selectedValue={tab} size="small" onTabSelect={(_, d) => setTab(d.value as DebugTab)}>
        <Tab value="preview" icon={<Eye20Regular />}>Data preview</Tab>
        <Tab value="inspect" icon={<TableSearch20Regular />}>Inspect</Tab>
        <Tab value="stats" icon={<DataHistogram20Regular />}>Statistics</Tab>
      </TabList>

      {/* Shared run controls: transform picker (+ sample size for preview/stats). */}
      <div className={s.controls} data-preview-controls>
        <Field label="Transform" className={s.streamField} hint={tab === 'inspect' ? 'Inspect the selected transform’s in/out schema.' : 'Run against the selected transform’s output stream.'}>
          <Select
            value={previewStream}
            disabled={anyLoading || streamNames.length === 0}
            onChange={(_, d) => setPreviewStream(d.value)}
          >
            {streamNames.length === 0 ? (
              <option value="">Add a transform to run</option>
            ) : (
              streamNames.map((sn) => <option key={sn} value={sn}>{sn}</option>)
            )}
          </Select>
        </Field>
        {tab !== 'inspect' && (
          <Field label="Sample rows" className={s.sampleField}>
            <Input
              type="number"
              value={String(sampleSize)}
              min={1}
              max={1000}
              disabled={anyLoading}
              onChange={(_, d) => {
                const n = Number(d.value);
                setSampleSize(Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : 100);
              }}
            />
          </Field>
        )}
        <Button
          appearance="primary"
          icon={anyLoading ? <Spinner size="tiny" /> : <Eye20Regular />}
          disabled={runDisabled}
          onClick={() => void runActive(previewStream)}
        >
          {runLabel}
        </Button>
      </div>

      {isNew && (
        <Caption1 className={s.meta}>
          Save the data flow before running — a debug session needs a published flow with bound datasets.
        </Caption1>
      )}
      {!debugOn && !sessionGate && !isNew && (
        <Caption1 className={s.meta}>
          Turn <strong>Data flow debug</strong> on to start a session, then preview, inspect, or profile any transform.
        </Caption1>
      )}

      {/* ── Data preview tab ─────────────────────────────────────────────── */}
      {tab === 'preview' && (
        <>
          {previewError && (
            <MessageBar intent="error">
              <MessageBarBody className={s.breakText}><MessageBarTitle>Preview failed</MessageBarTitle>{previewError}</MessageBarBody>
            </MessageBar>
          )}
          {previewLoading && !preview && (
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
              <Spinner size="tiny" /> Running data-flow preview
              {previewStream ? <> for <code className={s.gateCode}>{previewStream}</code></> : null}…
            </div>
          )}
          {preview && (
            <>
              {onQuickAction && !isNew && (
                <Caption1 className={s.meta}>
                  Tip: use a column’s <strong>⋯</strong> menu to Typecast / Modify / Remove — it inserts a transform after <code className={s.gateCode}>{previewLabel}</code> (draft; Save to publish).
                </Caption1>
              )}
              <PreviewTable
                sources={previewSources}
                showSearch
                showRefresh={false}
                typeOverridable
                headerActions={onQuickAction ? columnMenu : undefined}
                ariaLabel={`Debug preview rows for ${previewLabel}`}
              />
            </>
          )}
        </>
      )}

      {/* ── Inspect tab ──────────────────────────────────────────────────── */}
      {tab === 'inspect' && (
        <>
          {schemaError && (
            <MessageBar intent="error">
              <MessageBarBody className={s.breakText}><MessageBarTitle>Inspect failed</MessageBarTitle>{schemaError}</MessageBarBody>
            </MessageBar>
          )}
          {schemaLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
              <Spinner size="tiny" /> Reading in/out schema…
            </div>
          )}
          {schema && !schemaLoading && (
            <div data-inspect-result={previewStream}>
              <div className={s.inspectGrid}>
                <SchemaColumn title={`Input${primaryInput ? ` (${primaryInput})` : ''}`} cols={schema.in} emptyNote={primaryInput ? 'No columns' : 'Source — no input stream'} styles={s} />
                <SchemaColumn title={`Output (${previewStream})`} cols={schema.out} emptyNote="Schema unavailable" styles={s} />
              </div>
              <div className={s.driftWrap} aria-label="Schema drift">
                {schema.drift.filter((d) => d.change !== 'unchanged').length === 0 ? (
                  <Caption1 className={s.meta}>No schema drift — output columns match the input.</Caption1>
                ) : (
                  schema.drift
                    .filter((d) => d.change !== 'unchanged')
                    .map((d) => <DriftBadge key={`${d.name}-${d.change}`} entry={d} />)
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Statistics tab ───────────────────────────────────────────────── */}
      {tab === 'stats' && (
        <>
          {statsError && (
            <MessageBar intent="error">
              <MessageBarBody className={s.breakText}><MessageBarTitle>Statistics failed</MessageBarTitle>{statsError}</MessageBarBody>
            </MessageBar>
          )}
          {statsLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
              <Spinner size="tiny" /> Profiling columns…
            </div>
          )}
          {stats && !statsLoading && (
            <div data-stats-result={previewStream}>
              <Caption1 className={s.meta} style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>
                Profile over the {stats.rowCount}-row debug sample (requested {stats.sampleSize}).
              </Caption1>
              <div className={s.statsGrid}>
                {stats.stats.map((c) => <StatCard key={c.name} stat={c} styles={s} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One schema list (input or output). */
function SchemaColumn({
  title, cols, emptyNote, styles,
}: { title: string; cols: DfsColumn[]; emptyNote: string; styles: ReturnType<typeof useStyles> }) {
  return (
    <div className={styles.schemaCard}>
      <Subtitle2 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</Subtitle2>
      {cols.length === 0 ? (
        <Caption1 className={styles.meta}>{emptyNote}</Caption1>
      ) : (
        cols.map((c) => (
          <div key={c.name} className={styles.schemaRow}>
            <Caption1 className={styles.colName} title={c.name}>{c.name}</Caption1>
            <Caption1 className={styles.colType}>{c.type}</Caption1>
          </div>
        ))
      )}
    </div>
  );
}

function DriftBadge({ entry }: { entry: SchemaDriftEntry }) {
  const color = entry.change === 'added' ? 'success' : entry.change === 'removed' ? 'danger' : 'warning';
  const label =
    entry.change === 'added' ? `+ ${entry.name} (${entry.outType})`
      : entry.change === 'removed' ? `− ${entry.name} (${entry.inType})`
        : `${entry.name}: ${entry.inType} → ${entry.outType}`;
  return (
    <Tooltip content={`Schema drift: ${entry.change}`} relationship="label">
      <Badge appearance="tint" color={color} size="small">{label}</Badge>
    </Tooltip>
  );
}

/** One column's statistics card. */
function StatCard({ stat, styles }: { stat: ColumnStat; styles: ReturnType<typeof useStyles> }) {
  const nullPct = stat.count ? Math.round((stat.nulls / stat.count) * 100) : 0;
  const histRows = stat.topValues.map((t) => ({ Value: t.value.length > 24 ? `${t.value.slice(0, 24)}…` : t.value, Count: t.count }));
  return (
    <div className={styles.statCard} data-stat-col={stat.name}>
      <div className={styles.statHead}>
        <Text weight="semibold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={stat.name}>{stat.name}</Text>
        <Badge appearance="outline" size="small" color={stat.numeric ? 'brand' : 'informative'}>{stat.numeric ? '123' : 'Abc'}</Badge>
      </div>
      <div className={styles.statMetrics}>
        <div className={styles.metric}><Caption1 className={styles.metricLabel}>Nulls</Caption1><Caption1 className={styles.metricVal}>{stat.nulls} ({nullPct}%)</Caption1></div>
        <div className={styles.metric}><Caption1 className={styles.metricLabel}>Distinct</Caption1><Caption1 className={styles.metricVal}>{stat.distinct}</Caption1></div>
        {stat.numeric && (
          <>
            <div className={styles.metric}><Caption1 className={styles.metricLabel}>Min</Caption1><Caption1 className={styles.metricVal}>{fmtNum(stat.min)}</Caption1></div>
            <div className={styles.metric}><Caption1 className={styles.metricLabel}>Max</Caption1><Caption1 className={styles.metricVal}>{fmtNum(stat.max)}</Caption1></div>
            <div className={styles.metric}><Caption1 className={styles.metricLabel}>Mean</Caption1><Caption1 className={styles.metricVal}>{fmtNum(stat.mean)}</Caption1></div>
            <div className={styles.metric}><Caption1 className={styles.metricLabel}>Std dev</Caption1><Caption1 className={styles.metricVal}>{fmtNum(stat.stddev)}</Caption1></div>
          </>
        )}
      </div>
      {histRows.length > 0 && (
        <LoomChart type="bar" rows={histRows} height={Math.min(180, 40 + histRows.length * 22)} />
      )}
    </div>
  );
}

export default DataflowDebugPanel;
