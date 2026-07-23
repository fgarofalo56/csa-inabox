'use client';

/**
 * DataflowDebugPanel (U7) — the ADF-Studio-parity **Debug mode** dock for the
 * Mapping Data Flow designer. Sits below the canvas and drives the real ADF
 * data-flow debug session:
 *
 *   ┌ Debug ●active · expires 58m · [Managed IR] ────────── [Debug ▮] ┐
 *   │ [ Data preview ]                                                 │  ← tabs
 *   │  Transform ▾  Sample [100]  [Preview]                            │
 *   │  ┌ Abc name ┬ 123 qty ┬ time ts ─────────────────────────────┐  │
 *   │  │  sensor  │  30.1   │  2026-07-09T…                        │  │
 *   │  └ Succeeded (1s 20ms) · Columns 3 · Rows 100 ───────────────┘  │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Toggling Debug ON acquires a HELD debug session (POST ../debug/session
 * { action:'acquire' } → a short-lived Spark cluster on the deployment-default
 * factory's Managed IR); previews run against that same warm session
 * (POST ../debug/preview) so per-transform preview is cheap. Toggling OFF (or
 * unmounting) releases it. Rows are TYPE-BADGED via the shared PreviewTable
 * (timing status bar per ux-standards) and come ONLY from the live session —
 * never faked (no-vaporware.md). Azure-native ADF, no Fabric
 * (no-fabric-dependency.md).
 *
 * PR-1 ships the session lifecycle + Data preview tab. The Inspect (schema +
 * drift) and Statistics tabs land in U7 PR-2; the preview-grid quick-actions in
 * PR-3. Gated by the FLAG0 runtime flag `u7-dataflow-debug` at the editor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Caption1, Field, Input, MessageBar, MessageBarBody,
  MessageBarTitle, Select, Spinner, Switch, TabList, Tab, Tooltip, Text,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Bug20Regular, Eye20Regular } from '@fluentui/react-icons';
import { PreviewTable, type PreviewData } from '@/lib/components/shared/preview-table';
import { clientFetch } from '@/lib/client-fetch';
import {
  serializeDataFlow, type MappingDataFlowGraph,
} from './mapping-dataflow-designer';

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
  headTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
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
});

/** Debug tabs. PR-1 = Data preview only; PR-2 adds inspect + stats. */
type DebugTab = 'preview';

export interface DataflowDebugPanelProps {
  /** Data-flow resource name (the item id / ADF dataflow name). */
  name: string;
  /** Live authored graph (mirrored from the designer via onChange). */
  graph: MappingDataFlowGraph;
  /** True when a data-flow-capable factory is configured (probed by the editor). */
  debugAvailable: boolean;
  /** Editor's currently-selected transform, used as the default preview stream. */
  selectedTransform?: string | null;
  /** The item hasn't been saved yet — datasets can't resolve; preview is disabled. */
  isNew?: boolean;
}

interface SessionState {
  sessionId: string;
  expiresAt: number;
  integrationRuntime?: string;
}

/** Minutes-remaining label for the session chip. */
function remainingLabel(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  const min = Math.round(ms / 60_000);
  return min >= 1 ? `expires ${min}m` : 'expires <1m';
}

const SAMPLE_TIMEOUT_MS = 120_000;

export function DataflowDebugPanel({
  name, graph, debugAvailable, selectedTransform, isNew,
}: DataflowDebugPanelProps) {
  const s = useStyles();

  const [tab] = useState<DebugTab>('preview');
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

  // The session id survives re-renders for the release-on-unmount cleanup.
  const sessionRef = useRef<SessionState | null>(null);
  sessionRef.current = session;

  const streamNames = useMemo(() => graph.transforms.map((t) => t.name), [graph.transforms]);

  // Keep the chosen preview stream valid; prefer the editor's selection.
  useEffect(() => {
    setPreviewStream((cur) => {
      if (cur && streamNames.includes(cur)) return cur;
      if (selectedTransform && streamNames.includes(selectedTransform)) return selectedTransform;
      return streamNames[0] || '';
    });
  }, [streamNames, selectedTransform]);

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
        SAMPLE_TIMEOUT_MS,
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

  // Toggle handler: acquire on ON, release on OFF.
  const onToggleDebug = useCallback(async (next: boolean) => {
    setDebugOn(next);
    if (next) {
      await acquireSession();
    } else {
      const sid = sessionRef.current?.sessionId;
      setSession(null);
      setPreview(null);
      setPreviewError(null);
      if (sid) await releaseSession(sid);
    }
  }, [acquireSession, releaseSession]);

  // Release the held cluster when the panel unmounts (leaving the editor).
  useEffect(() => () => {
    const sid = sessionRef.current?.sessionId;
    if (sid) void releaseSession(sid);
  }, [releaseSession]);

  // Re-render the TTL chip every 30s so "expires Nm" stays current.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [session]);

  const runPreview = useCallback(async (stream: string) => {
    if (!session) { setPreviewError('Turn Debug on to start a session first.'); return; }
    if (!stream) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const r = await clientFetch(
        `/api/items/mapping-dataflow/${encodeURIComponent(name)}/debug/preview`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.sessionId,
            transformId: stream,
            sampleSize,
            dataFlow: serializeDataFlow(graph),
          }),
        },
        SAMPLE_TIMEOUT_MS,
      );
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j?.code === 'session_gone') {
        // Held cluster expired — drop it so the toggle reflects reality.
        setSession(null);
        setDebugOn(false);
        setPreviewError('The debug session expired. Turn Debug on again to start a new one.');
        setPreview(null);
        return;
      }
      if (r.status === 503) {
        setPreviewError(String(j?.gate?.remediation || j?.error || 'Debug session not available.'));
        setPreview(null);
        return;
      }
      if (!r.ok || j?.ok === false) {
        setPreviewError(String(j?.error || `HTTP ${r.status}`));
        setPreview(null);
        return;
      }
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
  }, [session, name, sampleSize, graph]);

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

      {/* Honest gate when the factory / IR isn't configured. */}
      {sessionGate && (
        <MessageBar intent="warning">
          <MessageBarBody className={s.breakText}>
            <MessageBarTitle>Debug session not available</MessageBarTitle>
            {sessionGate} Authoring still writes the real ADF data-flow definition;
            preview lights up once a data-flow debug session can be started.
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

      {/* Tabs (PR-1: Data preview only). */}
      <TabList selectedValue={tab} size="small">
        <Tab value="preview" icon={<Eye20Regular />}>Data preview</Tab>
      </TabList>

      {/* Data preview controls + grid. */}
      <div className={s.controls} data-preview-controls>
        <Field label="Transform" className={s.streamField} hint="Preview the selected transform’s output stream.">
          <Select
            value={previewStream}
            disabled={previewLoading || streamNames.length === 0}
            onChange={(_, d) => setPreviewStream(d.value)}
          >
            {streamNames.length === 0 ? (
              <option value="">Add a transform to preview</option>
            ) : (
              streamNames.map((sn) => <option key={sn} value={sn}>{sn}</option>)
            )}
          </Select>
        </Field>
        <Field label="Sample rows" className={s.sampleField}>
          <Input
            type="number"
            value={String(sampleSize)}
            min={1}
            max={1000}
            disabled={previewLoading}
            onChange={(_, d) => {
              const n = Number(d.value);
              setSampleSize(Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : 100);
            }}
          />
        </Field>
        <Button
          appearance="primary"
          icon={previewLoading ? <Spinner size="tiny" /> : <Eye20Regular />}
          disabled={previewLoading || !debugOn || !session || !previewStream || isNew}
          onClick={() => void runPreview(previewStream)}
        >
          Preview
        </Button>
      </div>

      {isNew && (
        <Caption1 className={s.meta}>
          Save the data flow before previewing — a debug session needs a published flow with bound datasets.
        </Caption1>
      )}
      {!debugOn && !sessionGate && !isNew && (
        <Caption1 className={s.meta}>
          Turn <strong>Data flow debug</strong> on to start a session, then preview any transform’s output.
        </Caption1>
      )}

      {previewError && (
        <MessageBar intent="error">
          <MessageBarBody className={s.breakText}>
            <MessageBarTitle>Preview failed</MessageBarTitle>
            {previewError}
          </MessageBarBody>
        </MessageBar>
      )}

      {previewLoading && !preview && (
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
          <Spinner size="tiny" /> Running data-flow preview
          {previewStream ? <> for <code className={s.gateCode}>{previewStream}</code></> : null}…
        </div>
      )}

      {preview && (
        <PreviewTable
          sources={previewSources}
          showSearch
          showRefresh={false}
          typeOverridable
          ariaLabel={`Debug preview rows for ${previewLabel}`}
        />
      )}
    </div>
  );
}

export default DataflowDebugPanel;
