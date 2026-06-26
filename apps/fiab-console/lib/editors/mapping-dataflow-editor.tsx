'use client';

/**
 * MappingDataFlowEditor — the editor for the "Mapping data flow" item type
 * (slug `mapping-dataflow`). It hosts the visual ADF / Synapse SPARK-based
 * <MappingDataFlowDesigner/> (graph of Source / transformation / Sink nodes
 * compiling to the Data Flow Script Spark runs).
 *
 * This is DISTINCT from the `dataflow` item type, which is the Power Query /
 * Dataflow Gen2 (WranglingDataFlow) editor. Both coexist; this one owns the
 * MappingDataFlow (`Microsoft.DataFactory/factories/dataflows`,
 * `properties.type === 'MappingDataFlow'`) surface.
 *
 * Round-trips via the real REST already wired in:
 *   - GET  /api/adf/dataflows/{name}        → hydrate an existing flow
 *   - PUT  /api/adf/dataflows/{name}        → upsert (real ARM `upsertDataFlow`)
 *   - GET  /api/adf/datasets                → source/sink DatasetPicker list
 *   - GET  /api/adf/dataflows/{name}/debug  → is a data-flow debug session live?
 *   - POST /api/adf/dataflows/{name}/debug  → start/execute a real ADF data-flow
 *                                             debug preview (createDataFlowDebugSession
 *                                             → addDataFlowToDebugSession →
 *                                             executeDataFlowDebugCommand) and
 *                                             return the real preview rows.
 * The factory is the env-pinned deployment default; when it isn't configured
 * the routes return a 503 `not_configured` gate which we surface as an honest
 * Fluent MessageBar (per no-vaporware.md). Data preview rows ALWAYS come from
 * the live debug session — we never fabricate rows.
 *
 * The item `id` is the data flow name. `new` opens a fresh, unsaved flow; the
 * user names the first transformation and Saves, which PUTs the named flow.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Field, Input, Button,
  Badge, Caption1, Text, Select,
  Table, TableHeader, TableHeaderCell, TableRow, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Dismiss20Regular, Table20Regular, Eye20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { MappingDataFlowDesigner } from '@/lib/components/pipeline/dataflow/mapping-dataflow-designer';
import type { MappingDataFlowGraph } from '@/lib/components/pipeline/dataflow/mapping-dataflow-designer';
import { clientFetch } from '@/lib/client-fetch';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import type { AdfDataset, AdfDataFlow } from '@/lib/azure/adf-client';

const useStyles = makeStyles({
  pad: {
    padding: tokens.spacingVerticalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    flex: 1, minHeight: 0,
  },
  nameRow: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap',
  },
  nameField: { minWidth: '280px' },
  loading: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXXL, justifyContent: 'center',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    color: tokens.colorNeutralForeground3,
  },
  breakText: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, maxWidth: '100%' },
  // Honest infra-gate banner for the data-flow Spark debug cluster — sits with
  // the designer it applies to so the gated Debug/Preview affordance is never
  // ambiguous (per no-vaporware.md). Subtle elevation to match sibling cards.
  debugGate: { boxShadow: tokens.shadow2 },
  gateCode: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    paddingInline: tokens.spacingHorizontalXXS,
    borderRadius: tokens.borderRadiusSmall,
  },
  // 'Debug preview' results card — modern elevated card matching sibling
  // surfaces (web3-ui.md): token spacing/radii/shadow, dark-legible via
  // theme-aware neutral foreground tokens. Rows come only from the live ADF
  // debug session (no-vaporware.md).
  previewPanel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
  },
  previewHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
  },
  previewTitle: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0,
  },
  previewMeta: { color: tokens.colorNeutralForeground3 },
  tableWrap: {
    overflow: 'auto', maxHeight: '360px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  headCell: { whiteSpace: 'nowrap', fontWeight: tokens.fontWeightSemibold },
  cell: {
    fontFamily: tokens.fontFamilyMonospace,
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground1,
  },
  nullCell: { color: tokens.colorNeutralForeground4, fontStyle: 'italic' },
  previewLoad: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalL, justifyContent: 'center',
    color: tokens.colorNeutralForeground3,
  },
  // Per-transformation preview controls row (ui-parity.md: ADF Studio previews
  // the SELECTED transformation). Bottom-aligned so the Select + Run button sit
  // on one baseline; wraps cleanly at narrow widths.
  previewControls: {
    display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
  },
  streamField: { minWidth: '240px' },
});

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

// Larger timeout for the debug POST: starting / executing a data-flow debug
// command runs an ARM long-running operation server-side (the route polls it),
// which is far slower than the default 6s client budget.
const DEBUG_TIMEOUT_MS = 120_000;

/** Normalised, render-ready preview result — rows ALWAYS sourced from the route. */
interface DebugPreview {
  streamName: string;
  columns: string[];
  rows: unknown[][];
}

/** Render a single cell value as legible text (objects → compact JSON). */
function cellToText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/**
 * Best-effort column names from an ADF Data Flow Script (DFS) preview schema
 * string like `output(name as string, age as integer)`. Used ONLY to label
 * columns when the route returns the raw debug-command schema instead of a
 * pre-parsed `columns[]`; it never invents row VALUES.
 */
function parseDfsSchemaColumns(schema: string): string[] {
  const inner = schema.replace(/^[^(]*\(/, '').replace(/\)\s*$/, '');
  if (!inner) return [];
  return inner
    .split(',')
    .map((seg) => seg.trim().split(/\s+as\s+/i)[0].trim())
    .filter(Boolean);
}

/**
 * Normalise whatever the `/debug` route returns into `{ streamName, columns,
 * rows }`. We accept the clean `{ columns, rows }` contract first, and also
 * tolerate the raw ADF `executeDataFlowDebugCommand` shape where `data` is a
 * JSON string `{ schema, data: [[...]] }`. Column HEADERS may be backfilled,
 * but row VALUES are only ever taken from the route's payload.
 */
function normalizePreview(j: any, fallbackStream?: string): DebugPreview {
  const streamName = String(j?.streamName || j?.stream || j?.previewStream || fallbackStream || 'preview');
  let rows: unknown[][] = [];
  let columns: string[] = [];

  const toRow = (r: unknown): unknown[] =>
    Array.isArray(r) ? r : (r && typeof r === 'object' ? Object.values(r as object) : [r]);

  if (Array.isArray(j?.rows)) {
    rows = j.rows.map(toRow);
    if (Array.isArray(j.columns)) columns = j.columns.map(String);
    else if (j.rows[0] && typeof j.rows[0] === 'object' && !Array.isArray(j.rows[0])) {
      columns = Object.keys(j.rows[0] as object);
    }
  } else if (Array.isArray(j?.data)) {
    rows = j.data.map(toRow);
    if (Array.isArray(j.columns)) columns = j.columns.map(String);
    else if (typeof j.schema === 'string') columns = parseDfsSchemaColumns(j.schema);
  } else if (typeof j?.data === 'string') {
    // Raw ADF debug-command payload: `data` is a JSON string `{schema, data}`.
    try {
      const parsed = JSON.parse(j.data);
      if (Array.isArray(parsed?.data)) rows = parsed.data.map(toRow);
      if (Array.isArray(parsed?.columns)) columns = parsed.columns.map(String);
      else if (typeof parsed?.schema === 'string') columns = parseDfsSchemaColumns(parsed.schema);
    } catch { /* leave empty — honest "0 rows" rather than fabricated data */ }
  }

  if (!columns.length && rows.length) {
    const width = Math.max(...rows.map((r) => r.length), 0);
    columns = Array.from({ length: width }, (_, i) => `col${i + 1}`);
  }
  return { streamName, columns, rows };
}

interface EditorProps { item: FabricItemType; id: string; }

export function MappingDataFlowEditor({ item, id }: EditorProps) {
  const s = useStyles();
  const isNew = id === 'new';

  // For a new flow the user names it before saving; for an existing one the id
  // IS the data-flow name.
  const [name, setName] = useState(isNew ? '' : id);
  const [initial, setInitial] = useState<AdfDataFlow['properties'] | undefined>(undefined);
  const [datasets, setDatasets] = useState<AdfDataset[]>([]);
  const [datasetGate, setDatasetGate] = useState<string | null>(null);
  const [loadGate, setLoadGate] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [reloadKey, setReloadKey] = useState(0);

  // --- Real data-flow debug state (replaces the old hard-coded `false`). ------
  // `debugAvailable` is probed from GET /api/adf/dataflows/{name}/debug; the
  // designer uses it to light its Debug toggle + per-transform preview. The
  // preview rows come from POSTing that same route.
  const [debugAvailable, setDebugAvailable] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewGate, setPreviewGate] = useState<string | null>(null);
  const [preview, setPreview] = useState<DebugPreview | null>(null);

  // Live authored graph, mirrored from the designer via its onChange. The
  // designer stays the source of truth for authoring; this read-only mirror only
  // populates the per-transformation preview picker so the editor can preview the
  // SELECTED transformation's output stream (ADF Studio behaviour — ui-parity.md),
  // not just the flow's first stream.
  const [graph, setGraph] = useState<MappingDataFlowGraph>({ transforms: [], streams: [] });
  // Which transformation's output stream the data preview targets (threaded into
  // the debug command's `streamName`).
  const [previewStream, setPreviewStream] = useState('');

  // Every previewable output stream is a named transform (source / transformation
  // / sink). This drives the preview selector and stays in sync with the graph.
  const streamNames = useMemo(() => graph.transforms.map((t) => t.name), [graph.transforms]);

  // Keep the chosen preview stream valid as the graph changes: preserve the
  // user's pick while it still exists, else default to the first stream.
  useEffect(() => {
    setPreviewStream((cur) => (cur && streamNames.includes(cur) ? cur : (streamNames[0] || '')));
  }, [streamNames]);

  // Load source/sink datasets (real GET — honest gate when factory unconfigured).
  const loadDatasets = useCallback(async () => {
    setDatasetGate(null);
    try {
      const r = await clientFetch('/api/adf/datasets', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.code === 'not_configured') {
        setDatasetGate(String(j.error || 'Data Factory not configured.'));
        setDatasets([]);
        return;
      }
      if (!r.ok || !j?.ok) { setDatasetGate(String(j?.error || `HTTP ${r.status}`)); setDatasets([]); return; }
      setDatasets(Array.isArray(j.datasets) ? j.datasets : []);
    } catch (e: any) {
      setDatasetGate(e?.message || String(e));
      setDatasets([]);
    }
  }, []);

  // Hydrate an existing flow's definition (real GET /api/adf/dataflows/{name}).
  const loadFlow = useCallback(async () => {
    if (isNew) { setInitial(undefined); setLoading(false); return; }
    setLoading(true); setLoadGate(null); setLoadError(null);
    try {
      const r = await clientFetch(`/api/adf/dataflows/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.code === 'not_configured') {
        setLoadGate(String(j.error || 'Data Factory not configured.'));
        return;
      }
      if (!r.ok || !j?.ok) {
        // A brand-new (not-yet-saved) flow id 404s — treat as an empty canvas.
        if (r.status === 404 || /not\s*found/i.test(String(j?.error || ''))) {
          setInitial(undefined);
          return;
        }
        setLoadError(String(j?.error || `HTTP ${r.status}`));
        return;
      }
      setInitial((j.dataflow as AdfDataFlow)?.properties);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id, isNew]);

  // Probe whether a live data-flow debug session is available (real GET). A
  // missing route, a 503 gate, or `available:false` all leave the honest gate
  // up; only a real `available:true` lights the designer's debug surface.
  useEffect(() => {
    // Re-probing for a different flow / on refresh — drop any stale preview.
    setPreview(null); setPreviewError(null); setPreviewGate(null);
    if (isNew) { setDebugAvailable(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(
          `/api/adf/dataflows/${encodeURIComponent(id)}/debug`,
          { cache: 'no-store' },
        );
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        setDebugAvailable(r.ok && j?.ok !== false ? Boolean(j?.available) : false);
      } catch {
        if (!cancelled) setDebugAvailable(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, isNew, reloadKey]);

  useEffect(() => { loadDatasets(); }, [loadDatasets, reloadKey]);
  useEffect(() => { loadFlow(); }, [loadFlow, reloadKey]);

  // Start a REAL ADF data-flow debug preview (POST /api/adf/dataflows/{name}/debug).
  // The route drives createDataFlowDebugSession → addDataFlowToDebugSession →
  // executeDataFlowDebugCommand(executePreviewQuery) against the live factory.
  // 503 → honest infra-gate; success → render the rows the route returns.
  const startDebugPreview = useCallback(async (streamName?: string) => {
    if (isNew) {
      setPreviewError('Save the data flow before previewing — a debug session needs a published flow.');
      return;
    }
    // Preview the chosen transformation's output stream — ADF Studio previews the
    // SELECTED transformation (ui-parity.md). Falls back to the editor's current
    // selection; when neither is set the route previews the flow's first stream.
    const targetStream = (streamName || previewStream || '').trim();
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewGate(null);
    try {
      const r = await clientFetch(
        `/api/adf/dataflows/${encodeURIComponent(id)}/debug`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            command: 'executePreviewQuery',
            ...(targetStream ? { streamName: targetStream } : {}),
          }),
          cache: 'no-store',
        },
        DEBUG_TIMEOUT_MS,
      );
      const j = await r.json().catch(() => ({}));
      if (r.status === 503) {
        // Honest infra-gate: the route names the missing ADF / IR requirement.
        setDebugAvailable(false);
        setPreviewGate(String(j?.error || 'A data-flow debug session is not available in this deployment.'));
        setPreview(null);
        return;
      }
      if (!r.ok || j?.ok === false) {
        setPreviewError(String(j?.error || `HTTP ${r.status}`));
        setPreview(null);
        return;
      }
      // A live session returned real rows — light the designer's debug surface
      // and render them below, labelled with the previewed stream.
      setDebugAvailable(true);
      setPreview(normalizePreview(j, targetStream || undefined));
    } catch (e: any) {
      setPreviewError(e?.message || String(e));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [id, isNew, previewStream]);

  const nameValid = NAME_RE.test(name.trim());

  const ribbon: RibbonTab[] = useMemo(() => [
    {
      id: 'home',
      label: 'Home',
      groups: [
        {
          label: 'Data flow',
          actions: [
            {
              label: 'Refresh',
              icon: <ArrowSync20Regular />,
              onClick: () => setReloadKey((k) => k + 1),
            },
          ],
        },
      ],
    },
  ], []);

  const main = (
    <div className={s.pad} data-editor="mapping-dataflow">
      {/* New-flow name field — the data-flow resource name (ADF dataflows/{name}). */}
      {isNew && (
        <div className={s.nameRow}>
          <Field
            className={s.nameField}
            label="Data flow name"
            required
            validationState={name && !nameValid ? 'error' : 'none'}
            validationMessage={name && !nameValid ? '1–260 chars: letters, digits, underscore.' : undefined}
            hint="The MappingDataFlow resource name. Save publishes it to the deployment Data Factory."
          >
            <Input
              value={name}
              placeholder="dataflow1"
              onChange={(_, d) => setName(d.value.replace(/[^A-Za-z0-9_]/g, ''))}
            />
          </Field>
        </div>
      )}

      {loadGate && (
        <MessageBar intent="warning">
          <MessageBarBody className={s.breakText}>
            <MessageBarTitle>Data Factory not configured</MessageBarTitle>
            {loadGate} The designer still renders so you can author the graph;
            Save publishes once the factory is configured.
          </MessageBarBody>
        </MessageBar>
      )}
      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody className={s.breakText}>
            <MessageBarTitle>Couldn’t load the data flow</MessageBarTitle>
            {loadError}
            <div style={{ marginTop: tokens.spacingVerticalS }}>
              <Button size="small" icon={<ArrowSync20Regular />} onClick={() => setReloadKey((k) => k + 1)}>
                Retry
              </Button>
            </div>
          </MessageBarBody>
        </MessageBar>
      )}

      {loading ? (
        <div className={s.loading}>
          <Spinner size="small" /> Loading data flow…
        </div>
      ) : (
        // The designer owns the canvas + config panel + Save. For a NEW flow we
        // pass the (validated) name so its Save targets the right resource; the
        // designer disables nothing structurally — it just needs a stable name.
        <>
          {/* Honest infra-gate (per no-vaporware.md): authoring is fully
              functional — add transform / configure / Save write the REAL ADF
              data-flow definition now. The gate ONLY shows when no live
              data-flow debug session is available; once `debugAvailable` is
              true (probed from the route), the Debug toggle + Data preview run
              real queries and this banner is replaced by the results panel. */}
          {!debugAvailable && (
            <MessageBar intent="warning" className={s.debugGate}>
              <MessageBarBody className={s.breakText}>
                <MessageBarTitle>Data preview / debug is gated in this deployment</MessageBarTitle>
                {previewGate ? <>{previewGate}{' '}</> : null}
                Data preview / debug runs against a Spark data-flow debug session
                (<code className={s.gateCode}>createDataFlowDebugSession</code> +{' '}
                <code className={s.gateCode}>executeDataFlowDebugCommand</code> on{' '}
                <code className={s.gateCode}>Microsoft.DataFactory/factories</code>),
                which isn’t available here yet — authoring (add transform /
                configure / save) writes the real ADF data-flow definition now;
                preview lights up once a debug session can be started (an Azure
                Integration Runtime with data-flow compute).
              </MessageBarBody>
            </MessageBar>
          )}

          <MappingDataFlowDesigner
            key={`${reloadKey}:${isNew ? name || 'new' : id}`}
            name={isNew ? (nameValid ? name.trim() : 'dataflow1') : id}
            initial={initial}
            datasets={datasets}
            datasetGate={datasetGate}
            // Real, route-probed availability (replaces the old hard-coded
            // `false`). When true the designer's Debug toggle + per-transform
            // Data preview run real queries; `onStartDebugSession` POSTs the
            // debug route (for the editor's currently-selected stream) and the
            // returned rows render below — never faked.
            debugClusterAvailable={debugAvailable}
            onStartDebugSession={startDebugPreview}
            // Mirror the live graph so the editor can offer a per-transformation
            // preview selector (the designer doesn't expose its node selection).
            onChange={setGraph}
          />

          {/* Per-transformation data preview (ui-parity.md: ADF Studio previews
              the SELECTED transformation, not just the first stream). Pick the
              transformation whose output stream to preview, then run a REAL ADF
              data-flow debug command (executePreviewQuery) for THAT stream. Rows
              ALWAYS come from the live debug session rendered below — never faked. */}
          {!isNew && streamNames.length > 0 && (
            <div className={s.previewControls} data-preview-controls>
              <Field
                label="Preview transformation"
                className={s.streamField}
                hint="ADF Studio previews the selected transformation’s output stream."
              >
                <Select
                  value={previewStream}
                  disabled={previewLoading}
                  onChange={(_, d) => setPreviewStream(d.value)}
                >
                  {streamNames.map((sn) => (
                    <option key={sn} value={sn}>{sn}</option>
                  ))}
                </Select>
              </Field>
              <Button
                appearance="primary"
                icon={<Eye20Regular />}
                disabled={previewLoading || !previewStream}
                onClick={() => void startDebugPreview(previewStream)}
              >
                Preview data
              </Button>
            </div>
          )}

          {/* Real debug preview surface — only the route's rows ever appear. */}
          {previewLoading && (
            <div className={s.previewLoad}>
              <Spinner size="tiny" /> Starting data-flow debug preview
              {previewStream ? <> for <code className={s.gateCode}>{previewStream}</code></> : null}…
            </div>
          )}

          {previewError && (
            <MessageBar intent="error">
              <MessageBarBody className={s.breakText}>
                <MessageBarTitle>Debug preview failed</MessageBarTitle>
                {previewError}
              </MessageBarBody>
            </MessageBar>
          )}

          {preview && (
            <div className={s.previewPanel} data-debug-preview={preview.streamName}>
              <div className={s.previewHead}>
                <div className={s.previewTitle}>
                  <Table20Regular />
                  <Text weight="semibold">Debug preview</Text>
                  <Badge appearance="tint" color="brand">
                    {preview.rows.length} row{preview.rows.length === 1 ? '' : 's'}
                  </Badge>
                  <Caption1 className={s.previewMeta}>stream: {preview.streamName}</Caption1>
                </div>
                <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} onClick={() => setPreview(null)}>
                  Clear
                </Button>
              </div>

              {preview.rows.length === 0 ? (
                <Caption1 className={s.previewMeta}>
                  The debug session returned no rows for this stream.
                </Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label={`Debug preview rows for ${preview.streamName}`}>
                    <TableHeader>
                      <TableRow>
                        {preview.columns.map((c, i) => (
                          <TableHeaderCell key={`${c}-${i}`} className={s.headCell}>{c}</TableHeaderCell>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.rows.map((row, ri) => (
                        <TableRow key={ri}>
                          {preview.columns.map((_c, ci) => {
                            const v = Array.isArray(row) ? row[ci] : undefined;
                            return (
                              <TableCell key={ci} className={s.cell}>
                                {v == null
                                  ? <span className={s.nullCell}>null</span>
                                  : cellToText(v)}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={main} />;
}

export default MappingDataFlowEditor;
