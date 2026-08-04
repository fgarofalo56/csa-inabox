'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * SemanticModelEditor — extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * Loom-native semantic model (Azure Analysis Services tabular layer over the
 * warehouse / lakehouse) — Azure-native by DEFAULT; no Fabric / Power BI
 * workspace is required (the Power BI WorkspacePicker is opt-in). The editor's
 * exclusive helpers (DatasetLite / TableLite / Sm* types, SM_* + INGEST_*
 * consts, AasSemanticModelPanel, SemanticModelSecurityTab, useCopilotPaneStyles,
 * SemanticModelCopilotPane, StructureOp / CopilotEditPlan) move with it. The
 * shared Power BI workspace-picker (usePowerBiWorkspaces / WorkspacePicker) is
 * imported from ./workspace-picker; the shared phase3 styles hook from ./styles.
 * phase3-editors.tsx re-exports SemanticModelEditor from a barrel line, so the
 * registry resolves it unchanged.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field,
  Card, Divider,
  Tab, TabList, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Label, Select, Textarea, Switch, SpinButton, InfoLabel, Tooltip,
  tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Play20Regular, Save20Regular, Add20Regular, Delete20Regular,
  ArrowSync20Regular, Table20Regular, DatabaseLink20Regular, DatabaseSearch20Regular,
  Sparkle16Regular, Wrench16Regular, Sparkle20Regular, Stethoscope20Regular,
  MathFormula20Regular,
} from '@fluentui/react-icons';
import { PbiModelViewPanel } from '../components/pbi-model-view-panel';
import { EntityDiagram } from '@/lib/components/shared/entity-diagram';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { loomDocUrl } from '@/lib/learn/content';
import { ModelTabsExtra } from '../components/model-tabs-extra';
import { PowerBiTree } from '@/lib/components/powerbi/powerbi-tree';
import { validateRlsDax } from '@/lib/azure/aas-dax-validate';
import { resolveEditorPbiBinding } from '@/lib/azure/powerbi-editor-binding';
import { ManageAccessPanel, EndorsementControl, GatewayDatasourcesPanel } from '@/lib/components/powerbi/powerbi-governance';
import { DqSourcePanel } from '@/lib/components/powerbi/dq-source-panel';
// WAVE 2 — "Pick a Loom item" ingest source: resolves a PBI_SOURCEABLE Loom item
// to its Azure-native backend and inserts a REAL Power Query M `Source =` step
// (replacing the placeholder-<server> connector templates for the loom-item case).
import { LoomItemSourcePicker } from '../report/loom-item-source-picker';
import { mExprFromBinding, mExprFromReportSource } from '../report/pbi-binding';
// WAVE 3 — the SAME rich connector gallery the report designer uses. A chosen
// connection / uploaded file yields a REAL Power Query M Source step (no
// <server> / <account> placeholder); unsupported picks show an honest gate.
import { GetDataGallery } from '../report/get-data-gallery';
import { BulkDescribeAction } from '@/lib/components/catalog/bulk-describe-action';
import { UpstreamSensitivityField } from '@/lib/components/governance/upstream-sensitivity-field';
import { ItemEditorChrome } from '../item-editor-chrome';
import { OpenInPbiDesktopButton } from '../components/open-in-pbi-desktop-button';
import { OpenInLoomReportBuilderButton } from '../components/open-in-loom-report-builder-button';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { DaxSnippet } from '@/lib/components/editor/dax-snippet';
import { DaxQueryView } from '../components/dax-query-view';
import { ModelHealthPane } from '../components/model-health-pane';
import { MetricViewBuilder } from '../components/metric-view-builder';
import { PowerQueryHost } from '@/lib/components/pipeline/dataflow/power-query-host';
import { parseSharedQueries, setQueryBody } from '@/lib/components/pipeline/dataflow/m-script';
import { usePowerBiWorkspaces, WorkspacePicker } from './workspace-picker';
import { getItem } from '@/lib/api/workspaces';
import { useBiBackend, useSemanticBackend } from '@/lib/components/platform-config';
import { useStyles } from './styles';
import { AskAffordance } from '@/lib/components/ask/AskAffordance';

// ── Decomposed sibling modules (WS-E1) ──────────────────────────────────────
// This editor was split into sibling modules under ./semantic-model-editor/*
// (mirroring the report-designer decomposition). The exported SemanticModelEditor
// (below) and SemanticModelPrepForAiPane (re-exported here) keep their original
// import paths so callers resolve unchanged (registry.ts, phase3-editors.tsx,
// and the prep-for-ai vitest smoke test).
import type { DatasetLite, TableLite, RefreshLite, SmTable, SmColumn, SemanticModelTab } from './semantic-model-editor/types';
import {
  SM_DATA_CATEGORIES, SM_SUMMARIZE, SM_DATA_TYPES, SM_FORMATS,
  INGEST_STARTER_M, INGEST_SOURCES,
} from './semantic-model-editor/constants';
import { ColumnTypeIcon, defaultDatasetId, isLoomDatasetId, livePbiDatasetId } from './semantic-model-editor/helpers';
import { useSmVisualStyles } from './semantic-model-editor/styles';
import { AasSemanticModelPanel } from './semantic-model-editor/aas-panel';
import { SemanticModelSecurityTab } from './semantic-model-editor/security-tab';
import { SemanticModelCopilotPane } from './semantic-model-editor/copilot-pane';
import { SemanticModelPrepForAiPane } from './semantic-model-editor/prep-for-ai-pane';
import { LoomNativeModelView } from './semantic-model-editor/loom-native-model-view';
// N9 — Verified Semantic Contract + VQR authoring tab (governed metric registry
// + approved question→query pairs; the data agent retrieves verified queries
// first and refuses out-of-contract questions).
import { VerifiedQueriesPane } from './semantic-model-editor/verified-queries-pane';
// R10 decomposition slice 1 — three self-contained tab clusters (state hook +
// presentational body) moved to sibling modules. Purely structural.
import { useSemanticModelAggregations, SemanticModelAggregationsTab } from './semantic-model-editor/aggregations-tab';
import { useSemanticModelDirectLake, SemanticModelDirectLakeTab } from './semantic-model-editor/direct-lake-tab';
import { useSemanticModelIncrementalRefreshState, useSemanticModelIncrementalRefreshActions, SemanticModelIncrementalRefreshTab } from './semantic-model-editor/incremental-refresh-tab';
import type { IncrementalRefreshApi } from './semantic-model-editor/incremental-refresh-tab';

// Re-export so `import { SemanticModelPrepForAiPane } from '.../semantic-model-editor'`
// keeps resolving unchanged (the prep-for-ai smoke test imports it from here).
export { SemanticModelPrepForAiPane };

/**
 * Dispatch on the RUNTIME semantic-model backend (LOOM_SEMANTIC_BACKEND, served
 * by /api/config/ui via useSemanticBackend) — NOT a build-baked NEXT_PUBLIC_* var.
 * When AAS is the active backend, render the AAS Storage-mode + Refresh surface;
 * otherwise the Loom-native / Power BI-opt-in editor below. Fail-closed to the
 * Loom-native editor while the config resolves (no-fabric-dependency.md). This
 * thin wrapper has its single hook before the conditional return, so the inner
 * editor's many hooks stay unconditional (Rules of Hooks).
 */
export function SemanticModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const { semanticBackend } = useSemanticBackend();
  if (semanticBackend === 'analysis-services') {
    return <AasSemanticModelPanel item={item} id={id} />;
  }
  return <SemanticModelEditorInner item={item} id={id} />;
}

function SemanticModelEditorInner({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const sm = useSmVisualStyles();
  // Power BI group listing is the OPT-IN leg (rel-T04/B12), enabled via the
  // RUNTIME admin setting (Admin → Runtime config → Power BI backend) read live
  // by useBiBackend() — NOT a build-baked NEXT_PUBLIC_* var. With the default
  // (Loom-native tabular metadata) the hook is disabled so the default render
  // makes ZERO Power BI network calls; powerBiConfigured stays false and the
  // editor keeps its Loom-native surface.
  const { powerBiEnabled: pbiOptIn } = useBiBackend();
  const ws = usePowerBiWorkspaces(pbiOptIn);
  // ── TWO workspace namespaces, never interchangeable (#2649) ────────────────
  // `pbiWorkspaceId` — a POWER BI groupId (usePowerBiWorkspaces →
  //   /api/powerbi/workspaces). Only Power BI-backed calls may receive it:
  //   list / detail / refresh / refresh-schedule / take-over / measures / build /
  //   direct-lake / app.powerbi.com deep links + the PBI governance panels.
  // `loomWorkspaceId` — THIS item's own Loom workspace GUID (its Cosmos
  //   partition key). The assertOwner-guarded Loom item routes (`[id]/model`,
  //   `[id]/datasource`) accept nothing else and answer 404 "semantic model not
  //   found" for a Power BI groupId — which is what 404'd them on EVERY open.
  //   Resolved from the item record exactly as the sibling Power BI-family
  //   editor in this folder already does (paginated-report-editor.tsx).
  const [pbiWorkspaceId, setPbiWorkspaceId] = useState('');
  const [loomWorkspaceId, setLoomWorkspaceId] = useState('');
  // The Power BI workspace this item's Loom workspace is MAPPED to
  // (`pbiWorkspaceMapping.pbiWorkspaceId`, set in Workspace settings). `''`
  // once resolution finishes with no mapping; `null` while still resolving so
  // the auto-pick below can WAIT rather than race ahead to an arbitrary group.
  const [mappedPbiWorkspaceId, setMappedPbiWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    if (!id || id === 'new') return;
    let cancelled = false;
    // Best-effort: the Loom routes treat an ABSENT workspaceId as "no owner
    // check", so degrading to '' still works — unlike sending a foreign id.
    getItem(item.slug, id)
      .then((it) => { if (!cancelled && it?.workspaceId) setLoomWorkspaceId(it.workspaceId); })
      .catch(() => { /* leave loomWorkspaceId unresolved */ });
    return () => { cancelled = true; };
  }, [item.slug, id]);
  // Resolve the workspace→Power BI mapping so the auto-pick below binds the
  // MAPPED group instead of an arbitrary one (see the auto-pick comment).
  //
  // NO-FABRIC-DEPENDENCY: gated on `pbiOptIn` exactly like `usePowerBiWorkspaces`
  // above, so the DEFAULT (Loom-native) render still makes ZERO extra requests
  // for a Power BI concern. When Power BI is off, `ws.workspaces` is empty and
  // the binding resolver returns undefined regardless, so leaving this state at
  // `null` blocks nothing.
  useEffect(() => {
    if (!pbiOptIn) return;
    if (!loomWorkspaceId) return;
    let cancelled = false;
    clientFetch(`/api/workspaces/${encodeURIComponent(loomWorkspaceId)}/powerbi-mapping`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setMappedPbiWorkspaceId(j?.ok ? (j.mapping?.pbiWorkspaceId || '') : '');
      })
      .catch(() => { if (!cancelled) setMappedPbiWorkspaceId(''); });
    return () => { cancelled = true; };
  }, [pbiOptIn, loomWorkspaceId]);
  const [datasets, setDatasets] = useState<DatasetLite[] | null>(null);
  const [datasetId, setDatasetId] = useState('');
  const [listErr, setListErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ dataset?: DatasetLite; tables?: TableLite[]; refreshSchedule?: any } | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState<RefreshLite[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  const [relationships, setRelationships] = useState<Array<{ name?: string; fromTable?: string; fromColumn?: string; toTable?: string; toColumn?: string; crossFilteringBehavior?: string }>>([]);
  const [tab, setTab] = useState<SemanticModelTab>('tables');
  // Loom-native Model-view sub-tab — the DEFAULT surface when no Power BI dataset
  // is selected (the Power BI dataset tab strip needs a datasetId; without one
  // the body was empty). Model / Tables / Measures over the item's own Cosmos
  // definition (no-fabric-dependency.md). Independent of `tab` (the PBI strip).
  const [nativeSub, setNativeSub] = useState<'model' | 'tables' | 'measures'>('model');
  // --- Calculation groups + field parameters (calc-group / field-param editor)
  // Loom-native by default: saved to the item's Cosmos content + emitted in TMSL
  // at provision time. AAS / Fabric backends persist to a live model (opt-in).
  type CgItem = { name: string; expression: string; formatStringDefinition?: string; ordinal?: number };
  type CgGroup = { name: string; precedence: number; items: CgItem[] };
  type FpField = { displayName: string; fieldRef: string; order: number };
  type FpParam = { name: string; fields: FpField[] };
  const [calcGroups, setCalcGroups] = useState<CgGroup[]>([]);
  const [cgBusy, setCgBusy] = useState(false);
  const [cgMsg, setCgMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [fieldParams, setFieldParams] = useState<FpParam[]>([]);
  const [fpBusy, setFpBusy] = useState(false);
  const [fpMsg, setFpMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Power BI is opt-in (no-fabric-dependency.md): the editor renders Loom-native
  // tabular metadata by default and only exposes Power BI actions/embed when the
  // Console identity actually has Power BI workspace access.
  const powerBiConfigured = !!(ws.workspaces && ws.workspaces.length > 0 && !ws.error);
  // #2649 (remaining legs) — the DATASET half of the same namespace split.
  // `datasetId` is a Loom identity for a persisted item (its own id, or the
  // `loom:` bundle-template form); only this narrowed value is a dataset that
  // lives INSIDE `pbiWorkspaceId`. Power BI-namespace reads key off it so a Loom
  // id is never paired with a groupId — that pairing 404'd `GET /[id]` and
  // `/[id]/refreshes` on every open and stamped the groupId into a Loom item URL.
  const pbiDatasetId = livePbiDatasetId(datasets, datasetId);

  // #2912 (no-fabric-dependency.md) — the identifier the Azure-native tabs
  // (Aggregations / Incremental-refresh policy / Direct Lake) address. On the
  // DEFAULT estate `datasetId` never binds (it only binds through the Power BI
  // opt-in), so fall back to THIS item's own id — the model / refresh-policy /
  // direct-lake routes resolve a raw or `loom:` id straight from Cosmos with no
  // Power BI dataset. When Power BI is actually working (`powerBiConfigured`)
  // the bound `datasetId` is used verbatim, so the Power-BI-ON path is
  // unchanged; `new` items have no persisted model, so they stay unbound.
  const effectiveDatasetId = datasetId || (!powerBiConfigured && id !== 'new' ? id : '');
  // The workspace the Azure-native tab actions use as their enablement guard.
  // The AAS refresh-policy route and the Direct-Lake config route resolve their
  // backend from env / Cosmos and don't require a Power BI workspace, so on the
  // default estate this is the item's own Loom workspace. On the Power-BI-ON
  // path `pbiWorkspaceId` is bound first, so this stays byte-identical to the
  // pre-#2912 wiring there.
  const nativeWorkspaceId = pbiWorkspaceId || loomWorkspaceId;

  // --- Model builder (real Power BI push-dataset authoring) ---------------
  // Builds a NEW semantic model with tables/typed-columns/measures/relationships
  // via POST /api/items/semantic-model/build → Power BI Push Datasets REST.
  const PBI_COL_TYPES = ['String', 'Int64', 'Double', 'Decimal', 'Boolean', 'DateTime'] as const;
  type BuilderColumn = { name: string; dataType: typeof PBI_COL_TYPES[number] };
  type BuilderMeasure = { name: string; expression: string };
  type BuilderTable = { name: string; columns: BuilderColumn[]; measures: BuilderMeasure[] };
  type BuilderRel = { name: string; fromTable: string; fromColumn: string; toTable: string; toColumn: string; crossFilteringBehavior: 'OneDirection' | 'BothDirections' };
  const [bModelName, setBModelName] = useState('');
  const [bTables, setBTables] = useState<BuilderTable[]>([
    { name: 'Sales', columns: [{ name: 'OrderId', dataType: 'Int64' }, { name: 'Amount', dataType: 'Double' }, { name: 'OrderDate', dataType: 'DateTime' }], measures: [{ name: 'TotalSales', expression: 'SUM(Sales[Amount])' }] },
  ]);
  const [bRels, setBRels] = useState<BuilderRel[]>([]);
  const [bBusy, setBBusy] = useState(false);
  const [bMsg, setBMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // DAX measure validator — name + table dropdown + Monaco DAX editor + Test
  // button. Persistence is XMLA-only (Premium / Fabric capacity feature) so
  // we honestly surface that via MessageBar instead of pretending to Save.
  const [measureName, setMeasureName] = useState('');
  const [measureTable, setMeasureTable] = useState('');
  const [daxExpr, setDaxExpr] = useState('SUM(\'Sales\'[Amount])');
  const [daxBusy, setDaxBusy] = useState(false);
  const [daxResult, setDaxResult] = useState<{ ok: boolean; value?: unknown; error?: string } | null>(null);
  // Format string + display folder + XMLA persistence (analysis-services backend).
  const [formatString, setFormatString] = useState('');
  const [displayFolder, setDisplayFolder] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; text: string; remediation?: string; link?: string } | null>(null);
  const [xmlaPersistence, setXmlaPersistence] = useState<boolean | null>(null);

  // DAX Copilot (Loom-native NL2DAX / explain / optimize / auto-describe). Posts
  // to /api/copilot/dax (Synapse-backed; zero Power BI on this path) and streams
  // SSE steps. A generated measure auto-inserts into the DAX editor above.
  const [daxCopilotPrompt, setDaxCopilotPrompt] = useState('');
  const [daxCopilotBusy, setDaxCopilotBusy] = useState(false);
  const [daxCopilotResult, setDaxCopilotResult] = useState<string | null>(null);
  const [daxCopilotErr, setDaxCopilotErr] = useState<string | null>(null);

  const askDaxCopilot = useCallback(async () => {
    const q = daxCopilotPrompt.trim();
    if (!q) return;
    setDaxCopilotBusy(true); setDaxCopilotResult(null); setDaxCopilotErr(null);
    try {
      const res = await clientFetch('/api/copilot/dax', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: q, itemId: id, itemType: item.slug || 'semantic-model' }),
      });
      if (!res.ok && !res.body) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep status */ }
        setDaxCopilotErr(msg); return;
      }
      const reader = res.body?.getReader();
      if (!reader) { setDaxCopilotErr('No response stream.'); return; }
      const decoder = new TextDecoder();
      let buf = '';
      let finalText: string | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          let step: any;
          try { step = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          if (step.kind === 'final') finalText = step.content || '';
          if (step.kind === 'error') setDaxCopilotErr(step.error || 'DAX Copilot error');
          if (step.kind === 'tool_result' && step.name === 'dax_nl2measure' && step.result?.daxExpression) {
            setDaxExpr(step.result.daxExpression); // auto-insert generated DAX
          }
          if (step.kind === 'tool_result' && step.name === 'dax_optimize' && step.result?.optimizedExpression) {
            setDaxExpr(step.result.optimizedExpression);
          }
        }
      }
      if (finalText) setDaxCopilotResult(finalText);
    } catch (e: any) {
      setDaxCopilotErr(e?.message || String(e));
    } finally {
      setDaxCopilotBusy(false);
    }
  }, [daxCopilotPrompt, id, item.slug]);

  // Scheduled-refresh editor (config tab) — mirrors the Power BI service
  // "Scheduled refresh" pane. Writes via PATCH /datasets/{id}/refreshSchedule.
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const [schedEnabled, setSchedEnabled] = useState(false);
  const [schedDays, setSchedDays] = useState<string[]>([]);
  const [schedTimes, setSchedTimes] = useState<string>('07:00');
  const [schedTz, setSchedTz] = useState('UTC');
  const [schedNotify, setSchedNotify] = useState<'MailOnFailure' | 'NoNotification'>('NoNotification');
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedMsg, setSchedMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [takeoverBusy, setTakeoverBusy] = useState(false);

  // --- XMLA column-metadata editor (Tables tab) -------------------------
  // Reads + writes the tabular model via the Azure-native XMLA backend
  // (Azure Analysis Services by default, or Power BI Premium XMLA opt-in)
  // through GET/PATCH /api/items/semantic-model/[id]/model. No Fabric / PBI
  // workspace required (no-fabric-dependency.md). When no XMLA endpoint is
  // configured the route returns an honest gate which we surface below.
  const [modelTables, setModelTables] = useState<SmTable[] | null>(null);
  const [modelBackend, setModelBackend] = useState<string>('');
  const [modelGate, setModelGate] = useState<{ missing: string; detail: string } | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [selectedTableName, setSelectedTableName] = useState('');
  const [editCol, setEditCol] = useState<{ tableName: string; col: SmColumn } | null>(null);
  const [colPatch, setColPatch] = useState<Partial<SmColumn>>({});
  const [patchBusy, setPatchBusy] = useState(false);
  const [patchMsg, setPatchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [calcColDlgOpen, setCalcColDlgOpen] = useState(false);
  const [calcColName, setCalcColName] = useState('');
  const [calcColExpr, setCalcColExpr] = useState('[Revenue] - [Cost]');
  const [calcColType, setCalcColType] = useState('double');
  const [calcColCat, setCalcColCat] = useState('');
  const [calcColFolder, setCalcColFolder] = useState('');
  const [calcTableDlgOpen, setCalcTableDlgOpen] = useState(false);
  const [calcTableName, setCalcTableName] = useState('');
  const [calcTableExpr, setCalcTableExpr] = useState('CALENDAR(DATE(2020,1,1), DATE(2025,12,31))');
  const [calcBusy, setCalcBusy] = useState(false);
  const [calcMsg, setCalcMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadModel = useCallback(async () => {
    if (!datasetId) return;
    setModelLoading(true); setModelGate(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model?workspaceId=${encodeURIComponent(loomWorkspaceId)}`);
      const j = await r.json();
      if (!j.ok && j.gate) { setModelGate(j.gate); setModelTables(null); return; }
      if (!j.ok) { setModelGate({ missing: 'error', detail: j.error || `HTTP ${r.status}` }); setModelTables(null); return; }
      setModelTables(j.tables || []);
      setModelBackend(j.backend || '');
      setSelectedTableName((prev) => prev || (j.tables?.[0]?.name ?? ''));
    } catch (e: any) {
      setModelGate({ missing: 'error', detail: e?.message || String(e) });
    } finally { setModelLoading(false); }
  }, [datasetId, loomWorkspaceId]);

  // Lazy-load the XMLA model the first time the Tables tab is opened for a
  // dataset. Re-fetches when the dataset changes.
  useEffect(() => { setModelTables(null); setSelectedTableName(''); setEditCol(null); }, [datasetId]);
  useEffect(() => {
    if (tab === 'tables' && datasetId && modelTables === null && !modelGate && !modelLoading) loadModel();
  }, [tab, datasetId, modelTables, modelGate, modelLoading, loadModel]);

  // --- Wave-3 "Modeling" tab seed (ModelTabsExtra) ----------------------------
  // The what-if / calculated-table dialogs seed their lists with a one-shot
  // `useState(() => seed(item.state.model))` initializer and never self-GET, so
  // ModelTabsExtra MUST be mounted with the item's REAL persisted `state.model`
  // (the same slot the dialogs POST to at `/items/semantic-model/<id>/model`).
  // Mounting with `state:{}` left every list empty after reload and pinned the
  // count badges at 0. We GET that route by `id` (matching the dialogs' POST
  // target — works Azure-native with no PBI dataset selected) and only render
  // the surface once the slice has loaded, so the seed initializers see real
  // data. `null` = not loaded yet (spinner); an object = loaded (may be empty).
  const [modelingSlice, setModelingSlice] = useState<{
    whatIfParameters: unknown[]; calculatedTables: unknown[]; dateTables: unknown[];
  } | null>(null);
  const loadModelingSlice = useCallback(async () => {
    if (!id) { setModelingSlice({ whatIfParameters: [], calculatedTables: [], dateTables: [] }); return; }
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/model`);
      const j = await r.json().catch(() => ({}));
      setModelingSlice({
        whatIfParameters: Array.isArray(j?.whatIfParameters) ? j.whatIfParameters : [],
        calculatedTables: Array.isArray(j?.calculatedTables) ? j.calculatedTables : [],
        dateTables: Array.isArray(j?.dateTables) ? j.dateTables : [],
      });
    } catch {
      // Degrade to an empty (but non-null) slice so the surface still renders.
      setModelingSlice({ whatIfParameters: [], calculatedTables: [], dateTables: [] });
    }
  }, [id]);
  useEffect(() => {
    if (tab === 'modeling' && modelingSlice === null) void loadModelingSlice();
  }, [tab, modelingSlice, loadModelingSlice]);

  const patchColumn = useCallback(async () => {
    if (!editCol || !datasetId) return;
    setPatchBusy(true); setPatchMsg(null);
    // Merge current column with the user's edits → COMPLETE column object
    // (TMSL Alter requires every read-write property, not a partial patch).
    const full: SmColumn = { ...editCol.col, ...colPatch };
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model?workspaceId=${encodeURIComponent(loomWorkspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'alter-column', tableName: editCol.tableName, columnName: editCol.col.name, column: full }),
      });
      const j = await r.json();
      if (!j.ok) { setPatchMsg({ ok: false, text: j.error || (j.gate?.detail) || `HTTP ${r.status}` }); return; }
      setPatchMsg({ ok: true, text: `Column "${full.name}" updated.` });
      setEditCol(null); setColPatch({});
      setModelTables(null); await loadModel();
    } catch (e: any) { setPatchMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setPatchBusy(false); }
  }, [editCol, colPatch, datasetId, loomWorkspaceId, loadModel]);

  const addCalcColumn = useCallback(async () => {
    if (!datasetId || !selectedTableName || !calcColName.trim() || !calcColExpr.trim()) return;
    setCalcBusy(true); setCalcMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model?workspaceId=${encodeURIComponent(loomWorkspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'add-calculated-column', tableName: selectedTableName,
          column: { name: calcColName.trim(), dataType: calcColType, expression: calcColExpr.trim(), dataCategory: calcColCat || undefined, displayFolder: calcColFolder || undefined },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setCalcMsg({ ok: false, text: j.error || (j.gate?.detail) || `HTTP ${r.status}` }); return; }
      setCalcMsg({ ok: true, text: `Calculated column "${calcColName}" added to ${selectedTableName}.` });
      setModelTables(null); await loadModel();
      setTimeout(() => { setCalcColDlgOpen(false); setCalcMsg(null); }, 1200);
    } catch (e: any) { setCalcMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setCalcBusy(false); }
  }, [datasetId, loomWorkspaceId, selectedTableName, calcColName, calcColExpr, calcColType, calcColCat, calcColFolder, loadModel]);

  const addCalcTable = useCallback(async () => {
    if (!datasetId || !calcTableName.trim() || !calcTableExpr.trim()) return;
    setCalcBusy(true); setCalcMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model?workspaceId=${encodeURIComponent(loomWorkspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'add-calculated-table', tableName: calcTableName.trim(), expression: calcTableExpr.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setCalcMsg({ ok: false, text: j.error || (j.gate?.detail) || `HTTP ${r.status}` }); return; }
      setCalcMsg({ ok: true, text: `Calculated table "${calcTableName}" created.` });
      setSelectedTableName(calcTableName.trim());
      setModelTables(null); await loadModel();
      setTimeout(() => { setCalcTableDlgOpen(false); setCalcMsg(null); }, 1200);
    } catch (e: any) { setCalcMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setCalcBusy(false); }
  }, [datasetId, loomWorkspaceId, calcTableName, calcTableExpr, loadModel]);

  // --- Incremental refresh policy + hybrid table (current-period DirectQuery) ---
  // Extracted to ./semantic-model-editor/incremental-refresh-tab (R10). The
  // cluster's `useState` block lived HERE in the monolith and its `useCallback`s
  // lived ~360 lines further down (after `loadRefreshes`), so it is exported as
  // two hooks called at those two exact positions — this component's hook
  // sequence is therefore byte-identical to the pre-refactor one.
  const irState = useSemanticModelIncrementalRefreshState();

  // --- Security tab (RLS row filters + OLS object permissions) -------------
  // Authors model roles through the Analysis-Services XMLA endpoint (Azure
  // Analysis Services by default, or an opt-in Power BI Premium / Fabric
  // capacity). GET/PUT /api/items/semantic-model/[id]/roles; POST ?action=test
  // runs a test-as-role DAX probe (the receipt). See aas-client.ts.
  type SecColPerm = { name: string; metadataPermission: 'read' | 'none' };
  type SecTablePerm = {
    name: string;
    filterExpression?: string;
    metadataPermission?: 'read' | 'none';
    columnPermissions?: SecColPerm[];
  };
  type SecRole = {
    name: string;
    modelPermission: 'read';
    tablePermissions: SecTablePerm[];
    members?: Array<{ memberName: string }>;
  };
  const [secRoles, setSecRoles] = useState<SecRole[] | null>(null);
  const [secErr, setSecErr] = useState<string | null>(null);
  const [secGate, setSecGate] = useState<{ missing: string; detail: string } | null>(null);
  const [secBusy, setSecBusy] = useState(false);
  const [secSaving, setSecSaving] = useState(false);
  const [secSaveMsg, setSecSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [secSelectedRole, setSecSelectedRole] = useState<string>('');
  const [secOlsTable, setSecOlsTable] = useState<string>('');
  const [testRoleUpn, setTestRoleUpn] = useState('');
  const [testQuery, setTestQuery] = useState('EVALUATE TOPN(10, Sales)');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ rows: Array<Record<string, unknown>>; rowCount: number } | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);

  const loadRoles = useCallback(async (dsId: string, wsId: string) => {
    setSecBusy(true); setSecErr(null); setSecGate(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}/roles?workspaceId=${encodeURIComponent(wsId)}&catalog=${encodeURIComponent(dsId)}`);
      const j = await r.json();
      if (r.status === 501 && j.gate) { setSecGate(j.gate); setSecRoles([]); return; }
      if (!j.ok) { setSecErr(j.error || `HTTP ${r.status}`); setSecRoles([]); return; }
      setSecRoles(Array.isArray(j.roles) ? j.roles : []);
    } catch (e: any) { setSecErr(e?.message || String(e)); setSecRoles([]); }
    finally { setSecBusy(false); }
  }, []);

  const saveRoles = useCallback(async () => {
    if (!datasetId || !secRoles) return;
    // Client-side DAX validation before the round-trip.
    for (const role of secRoles) {
      for (const tp of role.tablePermissions) {
        if (tp.filterExpression && tp.filterExpression.trim()) {
          const v = validateRlsDax(tp.filterExpression);
          if (!v.ok) { setSecSaveMsg({ ok: false, text: `Role "${role.name}" / ${tp.name}: ${v.error}` }); return; }
        }
      }
    }
    setSecSaving(true); setSecSaveMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/roles?workspaceId=${encodeURIComponent(loomWorkspaceId)}&catalog=${encodeURIComponent(datasetId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roles: secRoles }),
      });
      const j = await r.json();
      if (!j.ok) { setSecSaveMsg({ ok: false, text: j.error || j.gate?.detail || `HTTP ${r.status}` }); return; }
      setSecSaveMsg({ ok: true, text: `Saved ${j.roleCount} role(s) to the model via XMLA TMSL.` });
    } catch (e: any) { setSecSaveMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSecSaving(false); }
  }, [datasetId, loomWorkspaceId, secRoles]);

  const runTestRole = useCallback(async () => {
    if (!datasetId || !secSelectedRole || !testRoleUpn.trim() || !testQuery.trim()) return;
    setTestBusy(true); setTestErr(null); setTestResult(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/roles?action=test&workspaceId=${encodeURIComponent(loomWorkspaceId)}&catalog=${encodeURIComponent(datasetId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roleName: secSelectedRole, effectiveUserName: testRoleUpn.trim(), daxQuery: testQuery }),
      });
      const j = await r.json();
      if (!j.ok) { setTestErr(j.error || j.gate?.detail || `HTTP ${r.status}`); return; }
      setTestResult({ rows: j.rows || [], rowCount: j.rowCount ?? (j.rows?.length || 0) });
    } catch (e: any) { setTestErr(e?.message || String(e)); }
    finally { setTestBusy(false); }
  }, [datasetId, loomWorkspaceId, secSelectedRole, testRoleUpn, testQuery]);

  // Mutate a single role in place (immutable update for setSecRoles).
  const updateRole = useCallback((roleName: string, mut: (r: SecRole) => SecRole) => {
    setSecRoles((prev) => (prev || []).map((r) => (r.name === roleName ? mut(r) : r)));
  }, []);

  // Automatic aggregations builder (XMLA TMSL alternateOf) — extracted to
  // ./semantic-model-editor/aggregations-tab (R10).
  const agg = useSemanticModelAggregations({ workspaceId: loomWorkspaceId, datasetId: effectiveDatasetId, tables: detail?.tables });
  // Direct Lake query with transparent Serverless fallback (direct-lake-query tab).
  // When the warm AAS cache (last model refresh) is within LOOM_DL_CACHE_TTL_SECONDS
  // the row is served from the Power BI in-memory VertiPaq cache; otherwise the
  // same Gold Delta files are queried via Synapse Serverless OPENROWSET — the
  // Azure-native analog of Fabric "Direct Lake on SQL" DirectQuery fallback.
  interface DlQueryResult {
    ok: boolean;
    servingFrom?: 'warm-cache' | 'serverless-fallback' | 'columnar-cache' | 'serverless-direct';
    columns?: string[];
    rows?: unknown[][];
    rowCount?: number;
    executionMs?: number;
    truncated?: boolean;
    endpoint?: string;
    deltaPath?: string;
    lastRefreshedAt?: string | null;
    cacheTtlSeconds?: number;
    error?: string;
    /** WS-3.3 Direct Lake substitute (loom-columnar-cache backend): */
    cached?: boolean;
    deltaVersion?: number | null;
    framedAt?: string;
    frameVia?: 'directlake-service' | 'hint' | 'time-bucket';
  }
  const [dlTable, setDlTable] = useState('');
  const [dlMaxRows, setDlMaxRows] = useState(1000);
  const [dlqLoading, setDlqLoading] = useState(false);
  const [dlResult, setDlResult] = useState<DlQueryResult | null>(null);

  // Direct Lake (shim) — extracted to ./semantic-model-editor/direct-lake-tab
  // (R10). Called at the exact position the raw state block occupied so the
  // hook + effect order of this component is unchanged.
  const dl = useSemanticModelDirectLake({ tab, datasetId: effectiveDatasetId, workspaceId: nativeWorkspaceId, tables: detail?.tables });

  // Composite + Dual per-table storage mode (Tables tab). Each table gets an
  // Import / DirectQuery / Dual picker so a single model can MIX modes; the
  // selection is pushed to the BFF datasource route which builds a model.bim
  // TMSL with a per-partition `mode` and applies it (Fabric updateDefinition)
  // or returns it as an Invoke-ASCmd receipt. Dual requires Premium/Fabric.
  const TABLE_STORAGE_MODES = ['import', 'directQuery', 'dual'] as const;
  type TableStorageMode = typeof TABLE_STORAGE_MODES[number];
  const [tableModes, setTableModes] = useState<Record<string, TableStorageMode>>({});
  const [tableSourceQ, setTableSourceQ] = useState<Record<string, string>>({});
  const [modesBusy, setModesBusy] = useState(false);
  const [modesMsg, setModesMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tmslReceipt, setTmslReceipt] = useState<string | null>(null);

  // --- Get data (Power Query / M → Delta → semantic layer) ----------------
  // Source picker → Power Query (M) authoring (PowerQueryHost) → materialise to
  // Delta in ADLS via ADF/Synapse data flows → refresh the AAS tabular model.
  // POSTs to /api/items/semantic-model/{id}/ingest (real backends; honest gate).
  const [getDataOpen, setGetDataOpen] = useState(false);
  const [ingestTab, setIngestTab] = useState<'source' | 'transform' | 'run'>('source');
  const [ingestMScript, setIngestMScript] = useState(INGEST_STARTER_M);
  // WAVE 3 — the shared connector gallery + its honest gate for a pick Loom
  // can't yet turn into a real Power Query ingest Source step.
  const [connectorGalleryOpen, setConnectorGalleryOpen] = useState(false);
  const [sourceGate, setSourceGate] = useState<string | null>(null);
  const [ingestContainer, setIngestContainer] = useState<'bronze' | 'silver' | 'gold'>('silver');
  const [ingestAasTable, setIngestAasTable] = useState('');
  const [ingestRunning, setIngestRunning] = useState(false);
  const [ingestResult, setIngestResult] = useState<{
    ok: boolean; deltaPath?: string; adfRunId?: string; deltaRunId?: string; deltaBackend?: string;
    aasRefreshId?: string; warnings?: string[]; error?: string;
  } | null>(null);

  const insertSource = useCallback((mExpr: string) => {
    // Append/replace the active query's Source step with the connector's M.
    setIngestMScript((prev) => {
      const qs = parseSharedQueries(prev);
      const target = qs[qs.length - 1];
      const body = `let\n    Source = ${mExpr}\nin\n    Source`;
      if (!target) {
        return `section Section1;\n\nshared IngestQuery = ${body};\n`;
      }
      return setQueryBody(prev, target.name, body);
    });
    setIngestTab('transform');
  }, []);

  const runIngest = useCallback(async () => {
    setIngestRunning(true); setIngestResult(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/ingest`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mScript: typeof window === 'undefined' ? '' : window.btoa(unescape(encodeURIComponent(ingestMScript))),
          container: ingestContainer,
          aasTable: ingestAasTable.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setIngestResult({ ok: false, error: j.error || j.hint || `HTTP ${r.status}`, warnings: j.warnings }); return; }
      setIngestResult({ ok: true, deltaPath: j.deltaPath, adfRunId: j.adfRunId, deltaRunId: j.deltaRunId, deltaBackend: j.deltaBackend, aasRefreshId: j.aasRefreshId, warnings: j.warnings });
    } catch (e: any) {
      setIngestResult({ ok: false, error: e?.message || String(e) });
    } finally { setIngestRunning(false); }
  }, [id, ingestMScript, ingestContainer, ingestAasTable]);

  const loadList = useCallback(async (wsId: string) => {
    setListErr(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDatasets([]); setListErr(j.error); return; }
      const list: DatasetLite[] = j.datasets || [];
      setDatasets(list);
      setDatasetId((prev) => prev || defaultDatasetId(list, id));
    } catch (e: any) {
      setDatasets([]); setListErr(e?.message || String(e));
    }
  }, [id]);

  const loadDetail = useCallback(async (wsId: string, dsId: string) => {
    setDetailErr(null); setDetail(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDetailErr(j.error); return; }
      setDetail({ dataset: j.dataset, tables: j.tables || [], refreshSchedule: j.refreshSchedule });
      setRelationships(Array.isArray(j.relationships) ? j.relationships : []);
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
  }, []);

  const loadRefreshes = useCallback(async (wsId: string, dsId: string) => {
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}/refreshes?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setRefreshes(j.refreshes || []);
    } catch { /* silently keep last */ }
  }, []);

  // Load existing calc groups + field parameters from the model route (Cosmos
  // content on loom-native, or a live model's TMSL on the fabric backend).
  const loadModelObjects = useCallback(async (wsId: string, dsId: string) => {
    try {
      const q = wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : '';
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}/model${q}`);
      const j = await r.json();
      if (j.ok) {
        if (Array.isArray(j.calculationGroups)) setCalcGroups(j.calculationGroups);
        if (Array.isArray(j.fieldParameters)) setFieldParams(j.fieldParameters);
      }
    } catch { /* keep current in-editor state */ }
  }, []);

  const saveCalcGroups = useCallback(async () => {
    if (!datasetId) return;
    setCgBusy(true); setCgMsg(null);
    try {
      const q = loomWorkspaceId ? `?workspaceId=${encodeURIComponent(loomWorkspaceId)}` : '';
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model${q}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ calculationGroups: calcGroups }),
      });
      const j = await r.json();
      if (!j.ok) { setCgMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setCgMsg({ ok: true, text: `Saved via ${j.backend}. ${(j.steps || []).join(' ')}` });
    } catch (e: any) { setCgMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setCgBusy(false); }
  }, [datasetId, loomWorkspaceId, calcGroups]);

  const saveFieldParams = useCallback(async () => {
    if (!datasetId) return;
    setFpBusy(true); setFpMsg(null);
    try {
      const q = loomWorkspaceId ? `?workspaceId=${encodeURIComponent(loomWorkspaceId)}` : '';
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model${q}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fieldParameters: fieldParams }),
      });
      const j = await r.json();
      if (!j.ok) { setFpMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setFpMsg({ ok: true, text: `Saved via ${j.backend}. ${(j.steps || []).join(' ')}` });
    } catch (e: any) { setFpMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setFpBusy(false); }
  }, [datasetId, loomWorkspaceId, fieldParams]);

  // Bind the Power BI workspace once loaded so the list fetch fires and a
  // dataset binds — enabling New measure / Refresh / Open immediately instead
  // of leaving them disabled behind a manual pick. Users can still switch.
  //
  // #2649: this auto-pick is POWER BI-ONLY. It must never reach a Loom item
  // route — `loomWorkspaceId` (resolved from the item record above) is the only
  // value those accept, and the auto-picked groupId 404'd all of them.
  //
  // BINDING PRECEDENCE (auto-bind-by-default.md — the platform owns the
  // binding, and it must be the RIGHT one). Previously this unconditionally
  // took `ws.workspaces[0].id` — the first group the tenant listing happened to
  // return. That is an ARBITRARY third workspace: not the item's workspace and
  // not the one an operator mapped in Workspace settings. Every
  // /api/powerbi/{datasets,reports,dashboards,dataflows} call then addressed a
  // group the signed-in user may have no role on, which Power BI answers 401
  // (learn.microsoft.com/power-bi/developer/embedded/troubleshoot-rest-api
  // #troubleshoot-401-errors-in-power-bi-rest-api-calls). Now we follow the
  // documented precedence in lib/azure/powerbi-workspace-mapping.ts:
  //   1. the workspace→Power BI MAPPING (pbiWorkspaceMapping.pbiWorkspaceId)
  //   2. only if unmapped, the first listed group (previous behavior)
  // and we WAIT for mapping resolution (`null`) so the arbitrary fallback can
  // never win a race against the mapped value.
  //
  // The rule itself lives in lib/azure/powerbi-editor-binding.ts as a PURE
  // function so its unit test executes the real thing instead of a copy (a test
  // that re-implements its subject cannot fail).
  useEffect(() => {
    if (pbiWorkspaceId) return;
    const next = resolveEditorPbiBinding({
      mapped: mappedPbiWorkspaceId,
      listed: ws.workspaces ?? [],
      loomWorkspaceId,
    });
    if (next) setPbiWorkspaceId(next);
  }, [pbiWorkspaceId, ws.workspaces, mappedPbiWorkspaceId, loomWorkspaceId]);
  useEffect(() => { if (pbiWorkspaceId) loadList(pbiWorkspaceId); }, [pbiWorkspaceId, loadList]);
  useEffect(() => {
    // #2649: BOTH of these forward straight to Power BI REST — `getDataset` and
    // `listRefreshHistory` — so their `workspaceId` is genuinely a groupId, and
    // the dataset paired with it must genuinely live in that group. A `loom:`
    // bundle template is served by the SAME detail route from Cosmos, which
    // never reads the workspace beyond echoing it, so that leg gets the item's
    // OWN Loom workspace. A persisted item that is neither (no live dataset, no
    // bundle content) has nothing on either backend — the Loom-native model
    // surface already covers it, and calling out was a guaranteed 404.
    if (pbiWorkspaceId && pbiDatasetId) {
      loadDetail(pbiWorkspaceId, pbiDatasetId);
      loadRefreshes(pbiWorkspaceId, pbiDatasetId);
    } else if (loomWorkspaceId && isLoomDatasetId(datasetId)) {
      loadDetail(loomWorkspaceId, datasetId);
    }
  }, [pbiWorkspaceId, pbiDatasetId, loomWorkspaceId, datasetId, loadDetail, loadRefreshes]);
  useEffect(() => { if (datasetId) loadModelObjects(loomWorkspaceId, datasetId); }, [loomWorkspaceId, datasetId, loadModelObjects]);

  // Lazy-load roles the first time the Security tab is opened for a dataset.
  useEffect(() => {
    if (tab === 'security' && datasetId && secRoles === null && !secBusy) {
      loadRoles(datasetId, loomWorkspaceId);
    }
  }, [tab, datasetId, loomWorkspaceId, secRoles, secBusy, loadRoles]);
  // Reset role state when the selected dataset changes.
  useEffect(() => { setSecRoles(null); setSecSelectedRole(''); setSecSaveMsg(null); setTestResult(null); }, [datasetId]);
  // Default the test query / OLS table to the first model table once known.
  useEffect(() => {
    const first = detail?.tables?.[0]?.name;
    if (first) {
      setTestQuery((q) => (q.includes('Sales') && !((detail?.tables || []).some((t) => t.name === 'Sales')) ? `EVALUATE TOPN(10, '${first}')` : q));
      setSecOlsTable((t) => t || first);
    }
  }, [detail?.tables]);

  const refreshNow = useCallback(async () => {
    // #2649: `/refresh` is Power BI's own refresh trigger — the dataset must be
    // one that lives in `pbiWorkspaceId`, not the opened Loom item's id.
    if (!pbiWorkspaceId || !pbiDatasetId) return;
    setRefreshing(true); setRefreshErr(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(pbiDatasetId)}/refresh?workspaceId=${encodeURIComponent(pbiWorkspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setRefreshErr(j.error || 'refresh failed');
      else { setTimeout(() => loadRefreshes(pbiWorkspaceId, pbiDatasetId), 1500); }
    } finally { setRefreshing(false); }
  }, [pbiWorkspaceId, pbiDatasetId, loadRefreshes]);

  // Hydrate the scheduled-refresh form from the live schedule whenever the
  // selected dataset's detail loads.
  useEffect(() => {
    const sch = detail?.refreshSchedule;
    setSchedMsg(null);
    if (sch && typeof sch === 'object') {
      setSchedEnabled(!!sch.enabled);
      setSchedDays(Array.isArray(sch.days) ? sch.days : []);
      setSchedTimes(Array.isArray(sch.times) && sch.times.length ? sch.times.join(', ') : '07:00');
      setSchedTz(sch.localTimeZoneId || 'UTC');
      setSchedNotify(sch.notifyOption === 'MailOnFailure' ? 'MailOnFailure' : 'NoNotification');
    } else {
      setSchedEnabled(false); setSchedDays([]); setSchedTimes('07:00'); setSchedTz('UTC'); setSchedNotify('NoNotification');
    }
  }, [detail?.refreshSchedule, datasetId]);

  const toggleSchedDay = useCallback((day: string) => {
    setSchedDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]);
  }, []);

  const saveSchedule = useCallback(async () => {
    if (!pbiWorkspaceId || !datasetId) return;
    setSchedBusy(true); setSchedMsg(null);
    const times = schedTimes.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/refresh-schedule?workspaceId=${encodeURIComponent(pbiWorkspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: schedEnabled, days: schedDays, times, localTimeZoneId: schedTz, notifyOption: schedNotify }),
      });
      const j = await r.json();
      if (!j.ok) { setSchedMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setSchedMsg({ ok: true, text: 'Scheduled refresh updated.' });
      setDetail((prev) => prev ? { ...prev, refreshSchedule: j.schedule } : prev);
    } catch (e: any) { setSchedMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSchedBusy(false); }
  }, [pbiWorkspaceId, datasetId, schedEnabled, schedDays, schedTimes, schedTz, schedNotify]);

  const takeOver = useCallback(async () => {
    if (!pbiWorkspaceId || !datasetId) return;
    setTakeoverBusy(true); setSchedMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/take-over?workspaceId=${encodeURIComponent(pbiWorkspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { setSchedMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setSchedMsg({ ok: true, text: 'Dataset taken over by the Console identity. You can now edit the schedule.' });
      loadDetail(pbiWorkspaceId, datasetId);
    } catch (e: any) { setSchedMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setTakeoverBusy(false); }
  }, [pbiWorkspaceId, datasetId, loadDetail]);

  // Incremental-refresh callbacks — extracted to
  // ./semantic-model-editor/incremental-refresh-tab (R10). Called here, at the
  // position the raw `loadIrPolicy` / `saveIrPolicy` / `triggerEnhancedRefresh`
  // declarations occupied, i.e. after `loadRefreshes` which the last of them
  // closes over. The state half was registered further up (see `irState`), so
  // the cluster's draft survives tab switches exactly as before.
  const irActions = useSemanticModelIncrementalRefreshActions(irState, { workspaceId: nativeWorkspaceId, pbiWorkspaceId, datasetId: effectiveDatasetId, loadRefreshes });
  const ir: IncrementalRefreshApi = { ...irState, ...irActions };

  // Apply the per-table storage modes: builds a composite model.bim TMSL with a
  // per-partition `mode` (import/directQuery/dual) and applies it via the
  // datasource BFF route, then surfaces the live DAX probe + TMSL receipt.
  const applyModes = useCallback(async () => {
    if (!pbiWorkspaceId || !datasetId) return;
    setModesBusy(true); setModesMsg(null); setTmslReceipt(null);
    try {
      const tables = (detail?.tables || []).map((t) => {
        const mode: TableStorageMode = tableModes[t.name] ?? 'import';
        return {
          name: t.name,
          mode,
          ...(mode !== 'import'
            ? { sourceQuery: (tableSourceQ[t.name] || `SELECT * FROM [${t.name}]`).trim(), dataSourceName: 'sqlSource' }
            : {}),
          columns: (t.columns || []).map((c) => ({ name: c.name, dataType: c.dataType })),
        };
      });
      const rels = relationships
        .filter((r) => r.fromTable && r.fromColumn && r.toTable && r.toColumn)
        .map((r) => ({
          name: r.name,
          fromTable: r.fromTable!, fromColumn: r.fromColumn!,
          toTable: r.toTable!, toColumn: r.toColumn!,
          crossFilteringBehavior: (r.crossFilteringBehavior === 'bothDirections' ? 'bothDirections' : 'oneDirection') as 'oneDirection' | 'bothDirections',
        }));
      const r = await clientFetch(
        `/api/items/semantic-model/${encodeURIComponent(datasetId)}/datasource?workspaceId=${encodeURIComponent(loomWorkspaceId)}`,
        {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ displayName: detail?.dataset?.name || 'CompositeModel', tables, relationships: rels }),
        },
      );
      const j = await r.json();
      if (!j.ok) { setTmslReceipt(typeof j.tmsl === 'string' ? j.tmsl : null); setModesMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setTmslReceipt(typeof j.tmsl === 'string' ? j.tmsl : null);
      const probe = j.probe ? ` Query probe (first rows): ${j.probe}` : '';
      setModesMsg({
        ok: true,
        text: j.applied
          ? `Composite TMSL applied in-place via Fabric.${probe}`
          : `Composite TMSL built (apply offline via Invoke-ASCmd, or opt into a Fabric/Premium backend). See receipt below.${probe}`,
      });
    } catch (e: any) { setModesMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setModesBusy(false); }
  }, [pbiWorkspaceId, loomWorkspaceId, datasetId, detail?.tables, detail?.dataset?.name, tableModes, tableSourceQ, relationships]);

  // Validate a candidate DAX measure expression server-side via the Power
  // BI executeQueries REST endpoint. The route compiles via DEFINE MEASURE
  // and evaluates a probe row — invalid DAX returns the engine's real
  // error message (not a mocked "looks good"). Persistence requires XMLA.
  const validateDax = useCallback(async () => {
    if (!pbiWorkspaceId || !datasetId || !measureName.trim() || !measureTable.trim() || !daxExpr.trim()) return;
    setDaxBusy(true); setDaxResult(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/measures?workspaceId=${encodeURIComponent(pbiWorkspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ measureName: measureName.trim(), tableName: measureTable.trim(), daxExpression: daxExpr }),
      });
      const j = await r.json();
      if (!j.ok) { setDaxResult({ ok: false, error: j.error || `HTTP ${r.status}` }); return; }
      const row = j?.probe?.rows?.[0] || {};
      const v = Object.values(row)[0];
      setDaxResult({ ok: true, value: v });
    } catch (e: any) { setDaxResult({ ok: false, error: e?.message || String(e) }); }
    finally { setDaxBusy(false); }
  }, [pbiWorkspaceId, datasetId, measureName, measureTable, daxExpr]);

  // Probe the model route once a dataset is selected so the Measures tab can
  // show the Save-to-model button when LOOM_SEMANTIC_BACKEND=analysis-services
  // + LOOM_AAS_SERVER are wired (vs an honest infra-gate otherwise).
  useEffect(() => {
    if (!datasetId) { setXmlaPersistence(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model`);
        const j = await r.json();
        if (!cancelled) setXmlaPersistence(!!j?.xmlaPersistence);
      } catch { if (!cancelled) setXmlaPersistence(false); }
    })();
    return () => { cancelled = true; };
  }, [datasetId]);

  // Persist the measure (DAX + format string + display folder) into the model
  // via TMSL createOrReplace over the AAS XMLA endpoint. The route evaluates
  // the saved measure server-side so success reflects a real computed value —
  // not a fake toast (no-vaporware.md). When AAS isn't wired the route returns
  // an honest 501 gate we surface verbatim.
  const saveMeasure = useCallback(async () => {
    if (!datasetId || !measureName.trim() || !measureTable.trim() || !daxExpr.trim()) return;
    setSaveBusy(true); setSaveResult(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model${loomWorkspaceId ? `?workspaceId=${encodeURIComponent(loomWorkspaceId)}` : ''}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tableName: measureTable.trim(),
          measureName: measureName.trim(),
          expression: daxExpr,
          formatString: formatString.trim() || undefined,
          displayFolder: displayFolder.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setSaveResult({ ok: false, text: j.error || `HTTP ${r.status}`, remediation: j.remediation, link: j.link });
        return;
      }
      const evalNote = j?.evaluate ? ` Evaluated value: ${j.evaluate.value === null || j.evaluate.value === undefined ? 'NULL' : String(j.evaluate.value)}.` : '';
      setSaveResult({ ok: true, text: `Measure "${measureName.trim()}" saved to the model via TMSL createOrReplace.${evalNote}` });
      if (pbiWorkspaceId && datasetId) loadDetail(pbiWorkspaceId, datasetId);
    } catch (e: any) { setSaveResult({ ok: false, text: e?.message || String(e) }); }
    finally { setSaveBusy(false); }
  }, [datasetId, pbiWorkspaceId, loomWorkspaceId, measureName, measureTable, daxExpr, formatString, displayFolder, loadDetail]);

  const focusNewMeasure = useCallback(() => {
    setTab('measures');
    if (!measureTable && detail?.tables?.[0]?.name) setMeasureTable(detail.tables[0].name);
    if (!measureName) setMeasureName('MyMeasure');
  }, [measureTable, measureName, detail?.tables]);

  // Direct Lake query: POST to the BFF, which serves from the warm Power BI
  // cache when fresh and transparently falls back to Synapse Serverless
  // OPENROWSET over the Gold Delta files when the cache is stale/unbuilt.
  // datasetId is optional here — the Serverless fallback only needs the table
  // name and LOOM_GOLD_URL, so the query works with no Power BI workspace bound.
  const executeDlQuery = useCallback(async () => {
    if (!dlTable) return;
    setDlqLoading(true); setDlResult(null);
    try {
      const dsPath = datasetId ? encodeURIComponent(datasetId) : '_';
      const r = await clientFetch(`/api/items/semantic-model/${dsPath}/direct-lake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: pbiWorkspaceId, table: dlTable, maxRows: dlMaxRows }),
      });
      const j: DlQueryResult = await r.json();
      setDlResult(j);
    } catch (e: any) {
      setDlResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setDlqLoading(false);
    }
  }, [pbiWorkspaceId, datasetId, dlTable, dlMaxRows]);

  // Build a REAL new semantic model (push dataset) via the Power BI Push
  // Datasets REST API. After a successful build we refresh the dataset list
  // and select the new model so the user lands in its detail view.
  const buildModel = useCallback(async () => {
    if (!pbiWorkspaceId || !bModelName.trim() || bTables.length === 0) return;
    setBBusy(true); setBMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/build?workspaceId=${encodeURIComponent(pbiWorkspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: bModelName.trim(),
          tables: bTables.map((t) => ({
            name: t.name.trim(),
            columns: t.columns.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), dataType: c.dataType })),
            measures: t.measures.filter((m) => m.name.trim() && m.expression.trim()).map((m) => ({ name: m.name.trim(), expression: m.expression.trim() })),
          })),
          relationships: bRels.filter((rl) => rl.fromTable && rl.fromColumn && rl.toTable && rl.toColumn),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setBMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setBMsg({ ok: true, text: `Created semantic model "${j.name}" (id ${String(j.datasetId).slice(0, 8)}…). Reloading workspace…` });
      await loadList(pbiWorkspaceId);
      if (j.datasetId) { setDatasetId(j.datasetId); setTab('tables'); }
    } catch (e: any) { setBMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBBusy(false); }
  }, [pbiWorkspaceId, bModelName, bTables, bRels, loadList]);

  const focusBuild = useCallback(() => {
    setTab('build');
    if (!bModelName) setBModelName('My semantic model');
  }, [bModelName]);

  // Model view: with a Power BI dataset selected, open the live PBI Model-view
  // tab; otherwise focus the Loom-native Model sub-view (reset `tab` to a
  // non-standalone value so the native surface renders).
  const focusModel = useCallback(() => {
    if (datasetId) { setTab('model'); return; }
    setTab('tables');
    setNativeSub('model');
  }, [datasetId]);

  // #2649: Refresh is a Power BI dataset operation — enabled only for a dataset
  // that actually lives in the bound Power BI workspace. Keyed off `datasetId`
  // it stayed enabled for a Loom-only model and POSTed a certain 404.
  const canRefresh = !!pbiDatasetId && !refreshing && detail?.dataset?.isRefreshable !== false;
  // DirectQuery models are live against the source — never refreshable (the
  // Power BI REST `isRefreshable` already returns false for DQ datasets). When
  // the model is in DirectQuery storage mode we surface the Source binder tab
  // and disable Refresh with an honest "no data to import" reason.
  const isDqMode = (detail?.dataset?.targetStorageMode || '').toLowerCase() === 'directquery';
  const openInPbi = useCallback(() => {
    if (pbiWorkspaceId && datasetId) {
      window.open(`https://app.powerbi.com/groups/${encodeURIComponent(pbiWorkspaceId)}/datasets/${encodeURIComponent(datasetId)}/details`, '_blank', 'noreferrer');
    }
  }, [pbiWorkspaceId, datasetId]);
  // Only real, working actions. Authoring that genuinely requires the XMLA
  // endpoint / Power BI Desktop (RLS roles, perspectives, Direct Lake toggle,
  // TMSL import) is NOT shown as a dead button — it's documented in the
  // Measures-tab MessageBar instead. See no-vaporware.md.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Data', actions: [
        { label: 'Get data', onClick: () => { setGetDataOpen(true); setIngestTab('source'); }, title: 'Ingest data with Power Query (M) → Delta in ADLS → refresh the semantic layer (Azure-native, no Fabric required)' },
      ]},
      { label: 'Model', actions: [
        { label: 'Build model', onClick: pbiWorkspaceId ? focusBuild : undefined, disabled: !pbiWorkspaceId, title: !pbiWorkspaceId ? 'select a workspace first' : 'Create a new semantic model with tables, columns, measures & relationships via Power BI REST (push dataset)' },
        { label: 'Model view', onClick: focusModel, title: datasetId ? 'Interactive relationship diagram (cardinality, cross-filter, active/inactive) + drill-hierarchy editor; writes TMSL' : 'Loom-native relationship diagram — table cards + cardinality-marked join lines over this model’s definition (no Power BI required)' },
      ]},
      { label: 'Measures', actions: [
        { label: 'New measure (DAX)', onClick: datasetId ? focusNewMeasure : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'Open the Measures tab to author + validate DAX against the live model' },
        { label: saveBusy ? 'Saving…' : 'Save to model (XMLA)', onClick: datasetId ? () => { setTab('measures'); saveMeasure(); } : undefined, disabled: !datasetId || saveBusy, title: !datasetId ? 'select a dataset first' : 'Persist the measure (DAX + format string + display folder) via TMSL createOrReplace (requires LOOM_SEMANTIC_BACKEND=analysis-services + LOOM_AAS_SERVER)' },
      ]},
      { label: 'Aggregations', actions: [
        { label: 'Manage aggregations', onClick: effectiveDatasetId ? () => setTab('aggregations') : undefined, disabled: !effectiveDatasetId, title: !effectiveDatasetId ? 'save the model first' : 'Define an automatic-aggregation table (alternateOf) so the engine routes matching queries to a small pre-aggregated cache — Azure Analysis Services XMLA, no Power BI required' },
      ]},
      { label: 'Storage', actions: [
        { label: 'Incremental refresh', onClick: effectiveDatasetId ? () => setTab('incremental') : undefined, disabled: !effectiveDatasetId, title: !effectiveDatasetId ? 'save the model first' : 'Set an incremental-refresh policy (archive window + incremental window + optional real-time DirectQuery partition) via the Azure Analysis Services XMLA endpoint — no Power BI workspace required' },
        { label: 'Direct Lake', onClick: effectiveDatasetId ? () => setTab('direct-lake') : undefined, disabled: !effectiveDatasetId, title: !effectiveDatasetId ? 'save the model first' : 'Keep a warm cache fresh from an ADLS Gen2 Delta source (Azure-native Direct Lake shim) — no Fabric capacity required' },
      ]},
      { label: 'Advanced', actions: [
        { label: 'Calc groups', onClick: datasetId ? () => setTab('calcGroups') : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'Author calculation groups (SELECTEDMEASURE patterns) — switch a visual’s aggregation via a slicer' },
        { label: 'Field parameters', onClick: datasetId ? () => setTab('fieldParams') : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'Build field-parameter calculated tables (NAMEOF) — swap a visual’s measure via a slicer' },
      ]},
      { label: 'Columns', actions: [
        { label: 'Edit columns', onClick: datasetId ? () => setTab('tables') : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'Open the Tables tab to edit column metadata (data category, format, summarize-by, display folder, sort-by, hidden) via XMLA' },
        { label: 'Add calc. column', onClick: (datasetId && modelTables && selectedTableName) ? () => { setCalcMsg(null); setCalcColDlgOpen(true); } : undefined, disabled: !datasetId || !modelTables || !selectedTableName, title: !modelTables ? 'configure LOOM_AAS_SERVER_URL (Tables tab) to enable calculated columns' : 'Add a calculated column (DAX)' },
        { label: 'Add calc. table', onClick: (datasetId && modelTables) ? () => { setCalcMsg(null); setCalcTableDlgOpen(true); } : undefined, disabled: !datasetId || !modelTables, title: !modelTables ? 'configure LOOM_AAS_SERVER_URL (Tables tab) to enable calculated tables' : 'Create a calculated table (DAX)' },
      ]},
      { label: 'Source', actions: [
        { label: refreshing ? 'Queuing…' : 'Refresh', onClick: (canRefresh && !isDqMode) ? refreshNow : undefined, disabled: !canRefresh || isDqMode, title: isDqMode ? 'DirectQuery model is live — no data to import. Use the DirectQuery source tab to rebind.' : (detail?.dataset?.isRefreshable === false ? 'dataset is not refreshable (push or DirectQuery without gateway)' : (!pbiDatasetId ? 'Power BI refresh needs a dataset in the bound Power BI workspace — use Build model to push this one' : undefined)) },
        { label: 'DirectQuery source', onClick: isDqMode ? () => setTab('datasource') : undefined, disabled: !isDqMode, title: isDqMode ? 'Bind a live Azure source for this DirectQuery model' : 'available for DirectQuery storage-mode models' },
      ]},
      { label: 'Open', actions: [
        { label: 'Open in Power BI', onClick: datasetId ? openInPbi : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'opens the dataset in Power BI — author RLS roles, perspectives & Direct Lake there' },
      ]},
    ]},
  ], [refreshing, canRefresh, refreshNow, datasetId, effectiveDatasetId, pbiDatasetId, detail?.dataset?.isRefreshable, isDqMode, focusNewMeasure, openInPbi, pbiWorkspaceId, focusBuild, focusModel, saveBusy, saveMeasure, modelTables, selectedTableName]);

  // Tabs whose bodies are Azure-native and mount WITHOUT a bound Power BI
  // dataset. The first seven never needed one; #2912 adds the three the rule
  // requires — Aggregations (XMLA `alternateOf`), Incremental refresh (AAS
  // refresh-policy) and Direct Lake (ADLS Delta shim) — so on the default estate
  // selecting one mounts the item-tab strip + its body instead of leaving
  // `LoomNativeModelView` as the only reachable surface (no-fabric-dependency.md).
  const datasetIndependentTab =
    tab === 'build' || tab === 'copilot' || tab === 'prep-for-ai' ||
    tab === 'daxquery' || tab === 'health' || tab === 'metrics' || tab === 'verified-queries' ||
    tab === 'aggregations' || tab === 'incremental' || tab === 'direct-lake';

  return (
    <>
    <ItemEditorChrome splitKeyPrefix={item.slug} item={item} id={id} ribbon={ribbon} collabPresence
      leftPanel={
        <PowerBiTree
          workspaceId={pbiWorkspaceId}
          selectedDatasetId={datasetId}
          onOpenDataset={(dsId) => { setDatasetId(dsId); setTab('tables'); }}
          onNewDataset={focusBuild}
          onOpenReport={(r) => { if (r.webUrl) { try { window.open(r.webUrl, '_blank', 'noreferrer'); } catch { /* popup blocked */ } } }}
          onOpenDashboard={(d) => { if (d.webUrl) { try { window.open(d.webUrl, '_blank', 'noreferrer'); } catch { /* popup blocked */ } } }}
        />
      }
      main={
        <>
          <div className={s.pad}>
            <div className={s.toolbar}>
              <Badge appearance="filled" color="brand">Semantic model</Badge>
              <Button appearance="outline" icon={<DatabaseLink20Regular />} onClick={() => { setGetDataOpen(true); setIngestTab('source'); }} title="Power Query (M) → Delta in ADLS → semantic layer (Azure-native, no Fabric required)">Get data</Button>
              <OpenInPbiDesktopButton type="semantic-model" id={id} name={detail?.dataset?.name} mode="directQuery" />
              <OpenInLoomReportBuilderButton type="semantic-model" id={id} name={detail?.dataset?.name} />
              {powerBiConfigured && (
                <>
                  <WorkspacePicker value={pbiWorkspaceId} onChange={setPbiWorkspaceId} {...ws} />
                  <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => pbiWorkspaceId && loadList(pbiWorkspaceId)} disabled={!pbiWorkspaceId}>Refresh</Button>
                </>
              )}
              <Button appearance="outline" icon={<Add20Regular />} onClick={focusBuild} disabled={!powerBiConfigured || !pbiWorkspaceId} title={!powerBiConfigured ? 'Power BI embed is opt-in; workspace not configured' : 'Build a new semantic model (push dataset) via Power BI REST'} style={{ marginLeft: 'auto' }}>Build model</Button>
              <Button
                appearance="primary"
                icon={<Play20Regular />}
                disabled={!datasetId || refreshing || detail?.dataset?.isRefreshable === false || !powerBiConfigured}
                onClick={refreshNow}
                title={!powerBiConfigured ? 'Power BI embed is opt-in; workspace not configured' : (detail?.dataset?.isRefreshable === false ? 'Dataset is not refreshable (e.g. push dataset or DirectQuery without gateway).' : undefined)}
              >
                {refreshing ? 'Queuing…' : 'Refresh dataset'}
              </Button>
            </div>

            {/* Get data — Power Query (M) → Delta → semantic layer ingest wizard */}
            <Dialog open={getDataOpen} onOpenChange={(_, d) => setGetDataOpen(d.open)}>
              <DialogSurface style={{ maxWidth: '1080px', width: '94vw' }}>
                <DialogBody>
                  <DialogTitle>Get data — Power Query (M) ingest</DialogTitle>
                  <DialogContent>
                    <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM}}>
                      <MessageBarBody>
                        <MessageBarTitle>Azure-native, no Fabric required</MessageBarTitle>
                        Author a Power Query (M) mashup, then <strong>Run ingest</strong>: Loom compiles it into an ADF
                        WranglingDataFlow (M → Parquet), a Mapping Data Flow lands the result as <strong>Delta</strong> in
                        ADLS Gen2, and the Azure Analysis Services tabular model is refreshed so the table is queryable.
                        Set <code>LOOM_SYNAPSE_WORKSPACE</code> to run the Delta step on Synapse instead. In Government
                        clouds (no AAS) the Delta is queryable via Synapse Serverless <code>OPENROWSET</code>.
                      </MessageBarBody>
                    </MessageBar>
                    <div className={s.tabBar}>
                      <TabList selectedValue={ingestTab} onTabSelect={(_: unknown, d: any) => setIngestTab(d.value)}>
                        <Tab value="source">1 · Source</Tab>
                        <Tab value="transform">2 · Transform (M)</Tab>
                        <Tab value="run">3 · Run</Tab>
                      </TabList>
                    </div>

                    {ingestTab === 'source' && (
                      <div style={{ marginTop: tokens.spacingVerticalM}}>
                        {/* WAVE 2 — pick a Loom item; Loom inserts a REAL M source step
                            (no <server> placeholder). Falls through to the connector
                            cards for file/OData sources. */}
                        <LoomItemSourcePicker
                          purpose="semantic-model"
                          workspaceId={loomWorkspaceId}
                          onResolved={(res) => {
                            setSourceGate(null);
                            const m = mExprFromBinding(res.binding);
                            if (m) insertSource(m);
                          }}
                        />
                        <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalM, display: 'block' }}>
                          Or browse the connector gallery to bind a saved connection or upload a file — Loom inserts a
                          REAL Power Query <code>Source =</code> step from its actual coordinates (no <code>&lt;server&gt;</code> /
                          <code>&lt;account&gt;</code> to hand-edit). The inline sample below runs with no connection at all.
                        </Caption1>
                        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalM}}>
                          <Button appearance="secondary" icon={<DatabaseSearch20Regular />} onClick={() => { setSourceGate(null); setConnectorGalleryOpen(true); }}>
                            Get data — browse connectors
                          </Button>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                            Azure SQL / Synapse / PostgreSQL connection, or an uploaded CSV / Parquet / JSON file.
                          </Caption1>
                        </div>
                        {sourceGate && (
                          <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalM}}>
                            <MessageBarBody>
                              <MessageBarTitle>Not a Power Query ingest source yet</MessageBarTitle>
                              {sourceGate}
                            </MessageBarBody>
                          </MessageBar>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM}}>
                          {INGEST_SOURCES.map((src) => (
                            <div key={src.key} className={s.card} style={{ cursor: 'pointer' }} role="button" tabIndex={0}
                              onClick={() => { setSourceGate(null); insertSource(src.m); }}
                              onKeyDown={(e) => { if (e.key === 'Enter') { setSourceGate(null); insertSource(src.m); } }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
                                <Database20Regular />
                                <span style={{ fontWeight: 600 }}>{src.label}</span>
                              </div>
                              <Caption1 style={{ marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>{src.hint}</Caption1>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {ingestTab === 'transform' && (
                      <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', minHeight: 420 }}>
                        <PowerQueryHost mScript={ingestMScript} onChange={setIngestMScript} />
                      </div>
                    )}

                    {ingestTab === 'run' && (
                      <div style={{ marginTop: tokens.spacingVerticalM}}>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalL, flexWrap: 'wrap' }}>
                          <Field label="Delta destination (ADLS zone)" style={{ minWidth: 220 }}>
                            <Select value={ingestContainer} onChange={(_, d) => setIngestContainer(d.value as 'bronze' | 'silver' | 'gold')}>
                              <option value="bronze">bronze</option>
                              <option value="silver">silver</option>
                              <option value="gold">gold</option>
                            </Select>
                          </Field>
                          <Field label="AAS table to refresh (optional)" style={{ minWidth: 260 }} hint="Defaults to the output query name. The AAS model's partition source must point at the Delta path.">
                            <Input value={ingestAasTable} onChange={(_, d) => setIngestAasTable(d.value)} placeholder="(output query name)" />
                          </Field>
                        </div>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalL}}>
                          <Button appearance="primary" icon={<Play20Regular />} disabled={ingestRunning} onClick={runIngest}>
                            {ingestRunning ? 'Running ingest…' : 'Run ingest'}
                          </Button>
                          {ingestRunning && <Spinner size="tiny" />}
                        </div>
                        {ingestResult?.ok && (
                          <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM}}>
                            <MessageBarBody>
                              <MessageBarTitle>Ingest dispatched</MessageBarTitle>
                              Delta landing at <code>{ingestResult.deltaPath}</code> — ADF run <code>{ingestResult.adfRunId}</code>
                              {ingestResult.deltaRunId ? <> → Delta run <code>{ingestResult.deltaRunId}</code> ({ingestResult.deltaBackend})</> : null}
                              {ingestResult.aasRefreshId ? <>. AAS refresh <code>{ingestResult.aasRefreshId}</code> queued.</> : '.'}
                            </MessageBarBody>
                          </MessageBar>
                        )}
                        {ingestResult && !ingestResult.ok && (
                          <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM}}>
                            <MessageBarBody>
                              <MessageBarTitle>Ingest failed</MessageBarTitle>
                              {ingestResult.error}
                            </MessageBarBody>
                          </MessageBar>
                        )}
                        {(ingestResult?.warnings || []).map((w, i) => (
                          <MessageBar key={i} intent="warning" style={{ marginTop: tokens.spacingVerticalS}}>
                            <MessageBarBody>{w}</MessageBarBody>
                          </MessageBar>
                        ))}
                      </div>
                    )}
                  </DialogContent>
                  <DialogActions>
                    {ingestTab !== 'run' && (
                      <Button appearance="primary" onClick={() => setIngestTab(ingestTab === 'source' ? 'transform' : 'run')}>Next</Button>
                    )}
                    <DialogTrigger disableButtonEnhancement>
                      <Button appearance="secondary">Close</Button>
                    </DialogTrigger>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* WAVE 3 — the shared connector gallery. A connection-backed / uploaded
                pick yields a REAL Power Query M Source step from its actual
                coordinates (mExprFromReportSource); a connector Loom can't turn
                into ingest M shows an honest gate. No reportId → the gallery's
                upload/preview scope stays generic (this is a semantic-model). */}
            <GetDataGallery
              open={connectorGalleryOpen}
              onChosen={(ds, meta) => {
                setConnectorGalleryOpen(false);
                const res = mExprFromReportSource(ds, {
                  host: meta?.connection?.host,
                  database: meta?.connection?.database,
                  name: meta?.connection?.name,
                });
                if (res.ok) { setSourceGate(null); insertSource(res.m); }
                else setSourceGate(res.gate);
              }}
              onDismiss={() => setConnectorGalleryOpen(false)}
            />

            {listErr && <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>}
            {refreshErr && <MessageBar intent="error"><MessageBarBody>{refreshErr}</MessageBarBody></MessageBar>}
            {detailErr && <MessageBar intent="error"><MessageBarBody>{detailErr}</MessageBarBody></MessageBar>}
            {!powerBiConfigured && (
              <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM}}>
                <MessageBarBody>
                  <MessageBarTitle>Power BI embed is opt-in</MessageBarTitle>
                  The Console identity isn&rsquo;t registered in Power BI / not in any workspace. This editor shows Loom-native table, relationship, and measure (DAX) metadata. To enable Build model / Refresh / the Power BI Embed tab, register the Console UAMI in your Power BI tenant and add it to a workspace. <a href="https://learn.microsoft.com/power-bi/admin/service-principal-api-considerations" target="_blank" rel="noreferrer">Power BI service principal setup</a>.
                </MessageBarBody>
              </MessageBar>
            )}
            {detail?.dataset && (
              <div style={{ display: 'flex', gap: tokens.spacingVerticalM, alignItems: 'center', flexWrap: 'wrap' }}>
                <Caption1>Owner: <strong>{detail.dataset.configuredBy || '—'}</strong></Caption1>
                <Caption1>Mode: <strong>{detail.dataset.targetStorageMode || '—'}</strong></Caption1>
                {detail.dataset.isRefreshable === false && <Badge appearance="outline" color="warning">not refreshable</Badge>}
              </div>
            )}
          </div>
          {/* Loom-native Model view — the DEFAULT body when no Power BI dataset is
              selected (the tab strip below needs a datasetId). Renders the item's
              own tables / typed columns / relationships / DAX measures from the
              Azure-native model route so the editor is never an empty banner
              without a Fabric / Power BI workspace (no-fabric-dependency.md). */}
          {!datasetId && !datasetIndependentTab && (
            <LoomNativeModelView
              id={id}
              sub={nativeSub}
              onSub={setNativeSub}
              onGetData={() => { setGetDataOpen(true); setIngestTab('source'); }}
              onBuild={focusBuild}
            />
          )}
          {(datasetId || datasetIndependentTab) && (
            <>
              {/* ux-fabric-a W1 — tab-strip density: Fabric's item-tab strips are
                  compact (size=small) and scroll horizontally instead of wrapping
                  or clipping; this strip carries 20+ real surfaces.

                  `flexShrink: 0` is LOAD-BEARING (#2648) and must stay next to
                  the `overflowX` that makes this a scroll container. Making the
                  strip a scroller drops its CSS automatic minimum size from
                  min-content to 0, so as a direct flex child of the chrome's
                  height-constrained column it collapsed to its own scrollbar
                  (measured 9px) while the 32px TabList painted outside it and
                  stopped receiving pointer events — all 26 tabs became
                  keyboard-only. Keep the scroll (26 tabs need it) AND the pin. */}
              <div className={s.tabBar} style={{ overflowX: 'auto', overflowY: 'hidden', flexShrink: 0 }}>
                <TabList selectedValue={tab} size="small" onTabSelect={(_: unknown, d: any) => setTab(d.value as any)}>
                  <Tab value="tables">Tables ({detail?.tables?.length ?? 0})</Tab>
                  <Tab value="relationships">Relationships ({relationships.length})</Tab>
                  <Tab value="model">Model view</Tab>
                  <Tab value="entity" icon={<Table20Regular />}>Entity diagram</Tab>
                  <Tab value="modeling" icon={<Table20Regular />}>Modeling</Tab>
                  <Tab value="measures">Measures (DAX)</Tab>
                  <Tab value="metrics" icon={<MathFormula20Regular />}>Metrics</Tab>
                  <Tab value="daxquery" icon={<Play20Regular />}>DAX query</Tab>
                  <Tab value="health" icon={<Stethoscope20Regular />}>Model health</Tab>
                  <Tab value="copilot" icon={<Sparkle20Regular />}>Copilot (structure)</Tab>
                  <Tab value="prep-for-ai" icon={<Sparkle20Regular />}>Prep for AI</Tab>
                  {/* N9 — Verified Semantic Contract + VQR (refuse-not-guess). */}
                  <Tab value="verified-queries" icon={<Stethoscope20Regular />}>Verified Queries</Tab>
                  {/* WS-5.4 — NL "Ask" tab backed by /api/ask → chatGrounded */}
                  <Tab value="ask" icon={<Sparkle20Regular />}>Ask</Tab>                  <Tab value="calcGroups">Calc groups ({calcGroups.length})</Tab>
                  <Tab value="fieldParams">Field parameters ({fieldParams.length})</Tab>
                  <Tab value="build">Build model</Tab>
                  <Tab value="aggregations">Aggregations ({agg.aggAltMaps.length})</Tab>
                  <Tab value="refresh">Refresh history ({refreshes.length})</Tab>
                  {isDqMode && <Tab value="datasource">DirectQuery source</Tab>}
                  <Tab value="incremental">Incremental refresh</Tab>
                  <Tab value="config">Configuration</Tab>
                  <Tab value="security">Security (RLS/OLS)</Tab>
                  <Tab value="direct-lake">Direct Lake (shim)</Tab>
                  <Tab value="governance">Gateway &amp; endorsement</Tab>
                  <Tab value="access">Manage access</Tab>
                  <Tab value="direct-lake-query">Direct Lake query</Tab>
                  {powerBiConfigured && <Tab value="embed">Power BI Embed</Tab>}
                </TabList>
              </div>
              <div className={s.pad}>
                {tab === 'tables' && (
                  <>
                    {modelLoading && <Spinner size="tiny" label="Loading column metadata via XMLA…" style={{ justifyContent: 'flex-start', marginBottom: tokens.spacingVerticalS}} />}
                    {modelGate && (
                      <MessageBar intent={modelGate.missing === 'error' ? 'error' : 'warning'} style={{ marginBottom: tokens.spacingVerticalS}}>
                        <MessageBarBody>
                          <MessageBarTitle>{modelGate.missing === 'error' ? 'Column metadata load failed' : 'Column editor not configured'}</MessageBarTitle>
                          {modelGate.detail}
                          {modelGate.missing !== 'error' && (
                            <> Showing read-only table structure below. Deploy <code>analysis-services.bicep</code> (<code>loomSemanticBackend=analysis-services</code>) and set <code>LOOM_AAS_SERVER_URL</code> to enable data category, format string, summarize-by, display folder, sort-by, hidden, and calculated columns/tables.</>
                          )}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {modelBackend && (
                      <div style={{ marginBottom: tokens.spacingVerticalS}}>
                        <Badge appearance="tint" color="brand">XMLA backend: {modelBackend === 'analysis-services' ? 'Azure Analysis Services' : 'Power BI Premium XMLA'}</Badge>
                      </div>
                    )}
                    {/* Table selector + add actions */}
                    {(modelTables || detail?.tables) && (
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap', alignItems: 'center', marginBottom: tokens.spacingVerticalM}}>
                        <Field label="Table" style={{ minWidth: 220 }}>
                          <Select value={selectedTableName} onChange={(_, d) => { setSelectedTableName(d.value); setEditCol(null); setColPatch({}); }}>
                            {(modelTables ?? (detail?.tables as any[]) ?? []).map((t: { name: string; isCalculatedTable?: boolean }) => (
                              <option key={t.name} value={t.name}>{t.name}{t.isCalculatedTable ? ' (calc)' : ''}</option>
                            ))}
                          </Select>
                        </Field>
                        <Tooltip relationship="description" content={!modelTables ? 'Configure an Analysis Services XMLA backend (set LOOM_AAS_SERVER_URL) to add calculated columns.' : 'Add a calculated column defined by a DAX expression to the selected table.'}>
                          <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalXXL }}
                            onClick={() => { setCalcMsg(null); setCalcColDlgOpen(true); }}
                            disabled={!selectedTableName || !modelTables}>
                            Add calculated column
                          </Button>
                        </Tooltip>
                        <Tooltip relationship="description" content={!modelTables ? 'Configure an Analysis Services XMLA backend (set LOOM_AAS_SERVER_URL) to create calculated tables.' : 'Create a calculated table from a DAX expression (e.g. CALENDAR(...)) and add it to the model.'}>
                          <Button size="small" appearance="outline" icon={<Table20Regular />} style={{ marginTop: tokens.spacingVerticalXXL }}
                            onClick={() => { setCalcMsg(null); setCalcTableDlgOpen(true); }}
                            disabled={!modelTables}>
                            Add calculated table
                          </Button>
                        </Tooltip>
                        <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} style={{ marginTop: tokens.spacingVerticalXXL }}
                          onClick={() => { setModelTables(null); setModelGate(null); loadModel(); }}
                          disabled={!datasetId || modelLoading}>
                          Reload
                        </Button>
                      </div>
                    )}
                    {/* Column grid for the selected table */}
                    {(() => {
                      const tbl: SmTable | undefined =
                        (modelTables?.find((t) => t.name === selectedTableName)) ??
                        (detail?.tables?.find((t) => t.name === selectedTableName) as any);
                      if (!tbl) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No table selected.</Caption1>;
                      const cols: SmColumn[] = (tbl.columns as SmColumn[]) ?? [];
                      return (
                        <div className={s.tableWrap}>
                          <Table aria-label={`Columns of ${tbl.name}`} size="small">
                            <TableHeader><TableRow>
                              <TableHeaderCell>Column</TableHeaderCell>
                              <TableHeaderCell>Type</TableHeaderCell>
                              <TableHeaderCell>Data type</TableHeaderCell>
                              <TableHeaderCell>Category</TableHeaderCell>
                              <TableHeaderCell>Format</TableHeaderCell>
                              <TableHeaderCell>Summarize</TableHeaderCell>
                              <TableHeaderCell>Display folder</TableHeaderCell>
                              <TableHeaderCell>Hidden</TableHeaderCell>
                              {modelTables && <TableHeaderCell>Edit</TableHeaderCell>}
                            </TableRow></TableHeader>
                            <TableBody>
                              {cols.length === 0 && (
                                <TableRow><TableCell>—</TableCell><TableCell /><TableCell /><TableCell /><TableCell /><TableCell /><TableCell /><TableCell />{modelTables && <TableCell />}</TableRow>
                              )}
                              {cols.map((c) => (
                                <TableRow key={c.name} aria-label={c.name} className={sm.gridRow}>
                                  <TableCell>
                                    <span className={sm.fieldName}>
                                      <ColumnTypeIcon dataType={c.dataType} className={sm.typeIcon} />
                                      {c.name}
                                    </span>
                                    {c.type === 'calculated' && <Badge appearance="outline" size="small" color="brand" style={{ marginLeft: tokens.spacingHorizontalXS}}>calc</Badge>}
                                  </TableCell>
                                  <TableCell>{c.type ?? 'data'}</TableCell>
                                  <TableCell>{c.dataType ?? '—'}</TableCell>
                                  <TableCell>{c.dataCategory || '—'}</TableCell>
                                  <TableCell className={s.cell}>{c.formatString || '—'}</TableCell>
                                  <TableCell>{c.summarizeBy || '—'}</TableCell>
                                  <TableCell>{c.displayFolder || '—'}</TableCell>
                                  <TableCell>{c.isHidden ? 'hidden' : '—'}</TableCell>
                                  {modelTables && (
                                    <TableCell>
                                      <span className="sm-row-actions">
                                        <Button size="small" appearance="subtle" icon={<Wrench16Regular />} aria-label={`Edit ${c.name}`}
                                          onClick={() => { setEditCol({ tableName: tbl.name, col: c }); setColPatch({}); setPatchMsg(null); }}>
                                          Edit
                                        </Button>
                                      </span>
                                    </TableCell>
                                  )}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      );
                    })()}
                    {/* Column edit panel — full metadata surface */}
                    {editCol && (
                      <div className={s.card} style={{ marginTop: tokens.spacingVerticalM}}>
                        <Subtitle2>Edit column: {editCol.tableName}[{editCol.col.name}]</Subtitle2>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalM, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS}}>
                          <Field label="Data category" style={{ minWidth: 180 }}>
                            <Select value={colPatch.dataCategory ?? editCol.col.dataCategory ?? ''}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, dataCategory: d.value || undefined }))}>
                              <option value="">— none —</option>
                              {SM_DATA_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                            </Select>
                          </Field>
                          <Field label="Summarize by" style={{ minWidth: 160 }}>
                            <Select value={colPatch.summarizeBy ?? editCol.col.summarizeBy ?? 'default'}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, summarizeBy: d.value }))}>
                              {SM_SUMMARIZE.map((v) => <option key={v} value={v}>{v}</option>)}
                            </Select>
                          </Field>
                          <Field label={<InfoLabel info="The display format applied to this column's values (TMSL formatString) — e.g. #,0 for integers, 0.00% for percent, or a currency mask. It changes how values render in reports, not the stored data.">Format string</InfoLabel>} style={{ minWidth: 200 }}>
                            <Select value={colPatch.formatString ?? editCol.col.formatString ?? ''}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, formatString: d.value }))}>
                              {SM_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                            </Select>
                          </Field>
                          <Field label="Display folder" style={{ minWidth: 200 }}>
                            <Input value={colPatch.displayFolder ?? editCol.col.displayFolder ?? ''}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, displayFolder: d.value }))}
                              placeholder={'e.g. Geography or Finance\\KPIs'} />
                          </Field>
                          <Field label="Sort by column" style={{ minWidth: 180 }}>
                            <Select value={colPatch.sortByColumn ?? editCol.col.sortByColumn ?? ''}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, sortByColumn: d.value || undefined }))}>
                              <option value="">— self (default) —</option>
                              {(modelTables?.find((t) => t.name === editCol.tableName)?.columns ?? [])
                                .filter((c) => c.name !== editCol.col.name)
                                .map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                            </Select>
                          </Field>
                          <Field label="Hidden">
                            <Switch checked={colPatch.isHidden ?? editCol.col.isHidden ?? false}
                              onChange={(_, d) => setColPatch((p) => ({ ...p, isHidden: d.checked }))} />
                          </Field>
                        </div>
                        {editCol.col.type === 'calculated' && (
                          <div style={{ marginTop: tokens.spacingVerticalM}}>
                            <Caption1>DAX expression</Caption1>
                            <MonacoTextarea
                              value={colPatch.expression ?? editCol.col.expression ?? ''}
                              onChange={(v) => setColPatch((p) => ({ ...p, expression: v }))}
                              language="sql" height={120} minHeight={80}
                              ariaLabel="Calculated column DAX expression" />
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalM}}>
                          <Button appearance="primary" icon={<Save20Regular />}
                            disabled={patchBusy || Object.keys(colPatch).length === 0}
                            onClick={patchColumn}>
                            {patchBusy ? 'Saving…' : 'Apply'}
                          </Button>
                          <Button appearance="subtle" onClick={() => { setEditCol(null); setColPatch({}); setPatchMsg(null); }}>Cancel</Button>
                        </div>
                        {patchMsg && <MessageBar intent={patchMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{patchMsg.text}</MessageBarBody></MessageBar>}
                      </div>
                    )}
                    {patchMsg && !editCol && <MessageBar intent={patchMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{patchMsg.text}</MessageBarBody></MessageBar>}
                    {/* Read-only measures for the selected table */}
                    {(() => {
                      const tbl: SmTable | undefined =
                        (modelTables?.find((t) => t.name === selectedTableName)) ??
                        (detail?.tables?.find((t) => t.name === selectedTableName) as any);
                      if (!tbl?.measures?.length) return null;
                      return (
                        <div style={{ marginTop: tokens.spacingVerticalM}}>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Measures in {tbl.name} (read-only — edit via the Measures tab)</Caption1>
                          <div className={s.cell}>{tbl.measures.map((m) => m.name).join(', ')}</div>
                        </div>
                      );
                    })()}
                    {/* Composite (per-table storage mode) controls — origin/main integration */}
                    <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalL, marginBottom: tokens.spacingVerticalS}}>
                      Set a per-table <strong>storage mode</strong> to build a composite model that mixes
                      Import, DirectQuery, and Dual tables. Apply pushes a <code>model.bim</code> TMSL with a
                      per-partition mode (Fabric updateDefinition), or returns it as an <code>Invoke-ASCmd</code>
                      receipt. <strong>Dual</strong> requires Power BI Premium / Fabric capacity.
                    </Caption1>
                    <div className={s.tableWrap}>
                      <Table aria-label="Tables" size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Table</TableHeaderCell>
                          <TableHeaderCell>Columns</TableHeaderCell>
                          <TableHeaderCell>Measures</TableHeaderCell>
                          <TableHeaderCell>Storage mode</TableHeaderCell>
                          <TableHeaderCell>Source query (DQ / Dual)</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {(detail?.tables || []).map((t) => {
                            const mode = tableModes[t.name] ?? 'import';
                            return (
                              <TableRow key={t.name} className={sm.gridRow}>
                                <TableCell><span className={sm.fieldName}><Table20Regular className={sm.typeIcon} />{t.name}</span></TableCell>
                                <TableCell className={s.cell}>{(t.columns || []).map((c) => `${c.name}:${c.dataType || '?'}`).join(', ') || '—'}</TableCell>
                                <TableCell className={s.cell}>{(t.measures || []).map((m) => m.name).join(', ') || '—'}</TableCell>
                                <TableCell>
                                  <Select
                                    size="small"
                                    value={mode}
                                    onChange={(_, d) => setTableModes((prev) => ({ ...prev, [t.name]: d.value as TableStorageMode }))}
                                    aria-label={`Storage mode for ${t.name}`}
                                    title={`Storage mode for ${t.name}. 'dual' requires Power BI Premium / Fabric capacity.`}
                                  >
                                    {TABLE_STORAGE_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                                  </Select>
                                </TableCell>
                                <TableCell>
                                  {mode === 'import' ? (
                                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>
                                  ) : (
                                    <Input
                                      size="small"
                                      value={tableSourceQ[t.name] ?? `SELECT * FROM [${t.name}]`}
                                      onChange={(_, d) => setTableSourceQ((prev) => ({ ...prev, [t.name]: d.value }))}
                                      aria-label={`Source query for ${t.name}`}
                                      style={{ minWidth: 220 }}
                                    />
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalM}}>
                      <Button
                        appearance="primary"
                        icon={<ArrowSync20Regular />}
                        disabled={modesBusy || !datasetId || !powerBiConfigured || (detail?.tables || []).length === 0}
                        onClick={applyModes}
                        title={!powerBiConfigured ? 'Power BI / Fabric not configured' : 'Build the composite TMSL with the selected per-table modes and apply via Fabric updateDefinition (or generate the Invoke-ASCmd receipt), then probe the live model'}
                      >
                        {modesBusy ? 'Applying…' : 'Apply storage modes'}
                      </Button>
                      {!powerBiConfigured && (
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          Power BI / Fabric not configured — storage modes build TMSL only (no live apply).
                        </Caption1>
                      )}
                    </div>
                    {modesMsg && (
                      <MessageBar intent={modesMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}>
                        <MessageBarBody>{modesMsg.text}</MessageBarBody>
                      </MessageBar>
                    )}
                    {tmslReceipt && (
                      <details style={{ marginTop: tokens.spacingVerticalS}}>
                        <summary style={{ cursor: 'pointer' }}>
                          <Caption1>TMSL receipt (apply offline: <code>Invoke-ASCmd -Server &quot;asazure://…&quot; -Query &lt;tmsl&gt;</code>)</Caption1>
                        </summary>
                        <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: tokens.fontSizeBase100, fontFamily: 'Consolas, monospace', background: tokens.colorNeutralBackground2, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, marginTop: tokens.spacingVerticalXS, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%'}}>
                          {tmslReceipt.slice(0, 4000)}
                        </pre>
                      </details>
                    )}
                  </>
                )}
                {tab === 'relationships' && (
                  <>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Table relationships from <code>GET /datasets/{'{'}id{'}'}/relationships</code> (Power BI REST). Editing relationships
                      on an imported model requires XMLA / Desktop; push datasets accept relationships at create time via the <strong>Build model</strong> tab.
                    </Caption1>
                    {relationships.length === 0 ? (
                      <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>No relationships returned for this model.</Caption1>
                    ) : (
                      <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
                        <Table aria-label="Relationships" size="small">
                          <TableHeader><TableRow>
                            <TableHeaderCell>Name</TableHeaderCell>
                            <TableHeaderCell>From</TableHeaderCell>
                            <TableHeaderCell>To</TableHeaderCell>
                            <TableHeaderCell>Cross-filter</TableHeaderCell>
                          </TableRow></TableHeader>
                          <TableBody>
                            {relationships.map((r, i) => (
                              <TableRow key={r.name || i} className={sm.gridRow}>
                                <TableCell>{r.name || '—'}</TableCell>
                                <TableCell className={s.cell}>{r.fromTable}[{r.fromColumn}]</TableCell>
                                <TableCell className={s.cell}>{r.toTable}[{r.toColumn}]</TableCell>
                                <TableCell>{r.crossFilteringBehavior || '—'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </>
                )}
                {tab === 'model' && (
                  <PbiModelViewPanel
                    workspaceId={loomWorkspaceId || undefined}
                    datasetId={datasetId}
                  />
                )}
                {/* SC-10 shared <EntityDiagram> — the signature relationship canvas
                    over the Azure-native model route (TMSL tables + relationships;
                    renders with NO Power BI / Fabric workspace bound). Table cards
                    with type-badged columns + typed relationship lines carrying
                    1/* cardinality markers, Overview ⇄ Entity-diagram toggle. */}
                {tab === 'entity' && (
                  <EntityDiagram
                    source={{ kind: 'semantic-model', itemId: datasetId, workspaceId: loomWorkspaceId || undefined }}
                    height={600}
                    resizeStorageKey="semantic-model-entity-tables"
                  />
                )}
                {tab === 'modeling' && (
                  modelingSlice === null ? (
                    <Spinner size="small" label="Loading modeling…" labelPosition="after" style={{ marginTop: tokens.spacingVerticalL }} />
                  ) : (
                    <ModelTabsExtra
                      item={{
                        id,
                        workspaceId: loomWorkspaceId,
                        itemType: 'semantic-model',
                        displayName: item.displayName,
                        createdBy: '',
                        createdAt: '',
                        updatedAt: '',
                        state: { model: modelingSlice },
                      }}
                      id={id}
                      datasetId={datasetId}
                      tables={modelTables ?? detail?.tables}
                      measures={detail?.tables?.flatMap((t) => t.measures ?? [])}
                      onModelChanged={() => { void loadModelingSlice(); }}
                    />
                  )
                )}
                {tab === 'build' && (
                  <>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>Build a semantic model (push dataset)</MessageBarTitle>
                        Define tables, typed columns, DAX measures, and relationships, then <strong>Create model</strong> —
                        this calls the Power BI <code>POST /groups/{'{'}ws{'}'}/datasets</code> push-dataset REST API to author a
                        real semantic model. Imported / Direct Lake model edits still require the XMLA endpoint
                        (<code>LOOM_POWERBI_XMLA_ENDPOINT</code>) or Power BI Desktop.
                      </MessageBarBody>
                    </MessageBar>
                    <Field label="Model name" required style={{ maxWidth: 420, marginTop: tokens.spacingVerticalS}}>
                      <Input value={bModelName} onChange={(_, d) => setBModelName(d.value)} placeholder="My semantic model" />
                    </Field>
                    {bTables.map((t, ti) => (
                      <div key={ti} className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
                          <Field label="Table" style={{ minWidth: 220 }}>
                            <Input value={t.name} onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, name: d.value } : x))} />
                          </Field>
                          <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove table"
                            onClick={() => setBTables((p) => p.filter((_, i) => i !== ti))} style={{ marginTop: tokens.spacingVerticalXXL }} />
                        </div>
                        <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>Columns</Caption1>
                        {t.columns.map((c, ci) => (
                          <div key={ci} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalXS}}>
                            <Input value={c.name} placeholder="column" onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: x.columns.map((y, j) => j === ci ? { ...y, name: d.value } : y) } : x))} />
                            <Select value={c.dataType} onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: x.columns.map((y, j) => j === ci ? { ...y, dataType: d.value as BuilderColumn['dataType'] } : y) } : x))}>
                              {PBI_COL_TYPES.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
                            </Select>
                            <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove column"
                              onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: x.columns.filter((_, j) => j !== ci) } : x))} />
                          </div>
                        ))}
                        <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalXS}}
                          onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: [...x.columns, { name: '', dataType: 'String' }] } : x))}>Add column</Button>
                        <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>Measures (DAX)</Caption1>
                        {t.measures.map((m, mi) => (
                          <div key={mi} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalXS}}>
                            <Input value={m.name} placeholder="MeasureName" onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: x.measures.map((y, j) => j === mi ? { ...y, name: d.value } : y) } : x))} />
                            <Input value={m.expression} placeholder="SUM(Sales[Amount])" style={{ flex: 1, fontFamily: 'Consolas, monospace' }} onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: x.measures.map((y, j) => j === mi ? { ...y, expression: d.value } : y) } : x))} />
                            <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove measure"
                              onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: x.measures.filter((_, j) => j !== mi) } : x))} />
                          </div>
                        ))}
                        <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalXS}}
                          onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: [...x.measures, { name: '', expression: '' }] } : x))}>Add measure</Button>
                      </div>
                    ))}
                    <Button appearance="outline" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalS}}
                      onClick={() => setBTables((p) => [...p, { name: `Table${p.length + 1}`, columns: [{ name: 'Id', dataType: 'Int64' }], measures: [] }])}>Add table</Button>

                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalL}}>Relationships</Subtitle2>
                    {bRels.map((rl, ri) => (
                      <div key={ri} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap' }}>
                        <Input value={rl.fromTable} placeholder="fromTable" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, fromTable: d.value } : x))} style={{ width: 140 }} />
                        <Input value={rl.fromColumn} placeholder="fromColumn" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, fromColumn: d.value } : x))} style={{ width: 140 }} />
                        <ArrowSync20Regular />
                        <Input value={rl.toTable} placeholder="toTable" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, toTable: d.value } : x))} style={{ width: 140 }} />
                        <Input value={rl.toColumn} placeholder="toColumn" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, toColumn: d.value } : x))} style={{ width: 140 }} />
                        <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove relationship" onClick={() => setBRels((p) => p.filter((_, i) => i !== ri))} />
                      </div>
                    ))}
                    <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalXS}}
                      onClick={() => setBRels((p) => [...p, { name: `rel-${p.length + 1}`, fromTable: '', fromColumn: '', toTable: '', toColumn: '', crossFilteringBehavior: 'OneDirection' }])}>Add relationship</Button>

                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalL}}>
                      <Button appearance="primary" icon={<Save20Regular />} disabled={bBusy || !pbiWorkspaceId || !bModelName.trim()} onClick={buildModel}>
                        {bBusy ? 'Creating…' : 'Create model'}
                      </Button>
                      {!pbiWorkspaceId && <Caption1>Select a workspace first.</Caption1>}
                    </div>
                    {bMsg && <MessageBar intent={bMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{bMsg.text}</MessageBarBody></MessageBar>}
                  </>
                )}
                {tab === 'measures' && (
                  <>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>DAX measure editor</MessageBarTitle>
                        <strong>Validate</strong> runs the expression server-side via Power BI <code>executeQueries</code> — the engine returns its real syntax + semantic errors, not a mock.{' '}
                        <strong>Save to model</strong> persists the measure (with its format string + display folder) via TMSL <code>createOrReplace</code> over the XMLA endpoint, then evaluates it so the result reflects a real computed value.{' '}
                        Save requires <code>LOOM_SEMANTIC_BACKEND=analysis-services</code> plus <code>LOOM_AAS_SERVER</code> / <code>LOOM_AAS_DATABASE</code>.{' '}
                        For Power BI Premium XMLA, use Power BI Desktop or Tabular Editor — that endpoint speaks the analysis-services protocol over <code>powerbi://</code>, not plain HTTP.
                        {xmlaPersistence === false && <> {' '}<Badge appearance="tint" color="warning">XMLA persistence not wired</Badge></>}
                        {xmlaPersistence === true && <> {' '}<Badge appearance="tint" color="success">XMLA persistence ready</Badge></>}
                      </MessageBarBody>
                    </MessageBar>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalM, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS}}>
                      <Field label="Table" style={{ minWidth: 200 }}>
                        <Select value={measureTable} onChange={(_, d) => setMeasureTable(d.value)}>
                          <option value="">(select a table)</option>
                          {(detail?.tables || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                        </Select>
                      </Field>
                      <Field label="Measure name" style={{ minWidth: 200 }}>
                        <Input value={measureName} onChange={(_, d) => setMeasureName(d.value)} placeholder="TotalSales" />
                      </Field>
                      <Field label={<InfoLabel info="The display format for this measure's result (TMSL formatString). Controls how the number renders in reports — currency, percent, thousands separators — without changing the underlying value.">Format string</InfoLabel>} hint="TMSL formatString — e.g. $#,0.00 currency, 0.00% percent, #,0 integer" style={{ minWidth: 200 }}>
                        <Input value={formatString} onChange={(_, d) => setFormatString(d.value)} placeholder="$#,0.00;($#,0.00);$#,0.00" />
                      </Field>
                      <Field label="Display folder" hint="Organizes the measure in reporting tools (backslash-separated)" style={{ minWidth: 200 }}>
                        <Input value={displayFolder} onChange={(_, d) => setDisplayFolder(d.value)} placeholder={'Finance\\KPIs'} />
                      </Field>
                    </div>
                    <Field
                      label="DAX expression"
                      hint="e.g. CALCULATE(SUM('Sales'[Amount]), ALL('Date')). Validate before saving."
                      style={{ marginTop: tokens.spacingVerticalS}}
                    >
                      <MonacoTextarea
                        value={daxExpr}
                        onChange={setDaxExpr}
                        language="dax"
                        height={140}
                        minHeight={100}
                        ariaLabel="DAX expression editor"
                      />
                    </Field>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalS}}>
                      <Button
                        appearance="primary"
                        icon={<Play20Regular />}
                        disabled={daxBusy || !pbiWorkspaceId || !datasetId || !measureName.trim() || !measureTable.trim() || !daxExpr.trim()}
                        onClick={validateDax}
                        title={!pbiWorkspaceId ? 'Validate uses the Power BI executeQueries REST endpoint — select a Power BI workspace first' : undefined}
                      >
                        {daxBusy ? 'Validating…' : 'Validate DAX'}
                      </Button>
                      <Button
                        appearance="outline"
                        icon={<Save20Regular />}
                        disabled={saveBusy || !datasetId || !measureName.trim() || !measureTable.trim() || !daxExpr.trim()}
                        onClick={saveMeasure}
                        title="Persist this measure (DAX + format string + display folder) via TMSL createOrReplace to Azure Analysis Services (requires LOOM_SEMANTIC_BACKEND=analysis-services + LOOM_AAS_SERVER)"
                      >
                        {saveBusy ? 'Saving…' : 'Save to model (XMLA)'}
                      </Button>
                      {daxResult?.ok && (
                        <Badge appearance="filled" color="success">valid · probe value: <code style={{ marginLeft: tokens.spacingHorizontalXS}}>{daxResult.value === null || daxResult.value === undefined ? 'NULL' : String(daxResult.value)}</code></Badge>
                      )}
                    </div>
                    {daxResult && !daxResult.ok && (
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}>
                        <MessageBarBody>
                          <MessageBarTitle>DAX validation failed</MessageBarTitle>
                          {daxResult.error}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {saveResult && (
                      <MessageBar intent={saveResult.ok ? 'success' : 'warning'} style={{ marginTop: tokens.spacingVerticalS}}>
                        <MessageBarBody>
                          <MessageBarTitle>{saveResult.ok ? 'Saved to model' : 'Not persisted'}</MessageBarTitle>
                          {saveResult.text}
                          {saveResult.remediation && <> {saveResult.remediation}</>}
                          {saveResult.link && <> <a href={saveResult.link} target="_blank" rel="noreferrer">Learn more</a>.</>}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {/* DAX Copilot — Loom-native NL2DAX / explain / optimize / describe.
                        Synapse-backed; no Power BI on this path. */}
                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalXL }}>DAX Copilot</Subtitle2>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Generate, explain, or optimize DAX against this Loom-native model. Grounded on the model
                      schema and evaluated via Synapse — no Power BI workspace required. A generated measure
                      auto-inserts into the editor above.
                    </Caption1>
                    <div className={s.assistBar} style={{ marginTop: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` }}>
                      <Sparkle16Regular />
                      <Input
                        value={daxCopilotPrompt}
                        onChange={(_, d) => setDaxCopilotPrompt(d.value)}
                        placeholder="Ask DAX Copilot (e.g. 'create a YoY revenue measure', 'explain this', 'make it faster')"
                        style={{ flex: 1 }}
                        disabled={daxCopilotBusy}
                        onKeyDown={(e) => { if (e.key === 'Enter') askDaxCopilot(); }}
                      />
                      <Button
                        size="small"
                        appearance="primary"
                        icon={daxCopilotBusy ? <Spinner size="tiny" /> : <Sparkle16Regular />}
                        disabled={daxCopilotBusy || !daxCopilotPrompt.trim()}
                        onClick={askDaxCopilot}
                      >
                        {daxCopilotBusy ? 'Working…' : 'Ask'}
                      </Button>
                    </div>
                    {daxCopilotErr && (
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}>
                        <MessageBarBody><MessageBarTitle>DAX Copilot</MessageBarTitle>{daxCopilotErr}</MessageBarBody>
                      </MessageBar>
                    )}
                    {daxCopilotResult && (
                      <div className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
                        <pre className={s.assistResult}>{daxCopilotResult}</pre>
                      </div>
                    )}

                    {/* Bulk AI auto-description — generate descriptions for ALL
                        tables/columns/measures in one pass (Fabric Build 2026 #36).
                        Azure-native (AOAI); persists to the Loom-native model. */}
                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalXL }}>AI auto-description (bulk)</Subtitle2>
                    <div style={{ marginTop: tokens.spacingVerticalS}}>
                      <BulkDescribeAction modelId={id} />
                    </div>

                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalL}}>Existing measures</Subtitle2>
                    {(detail?.tables || []).flatMap((t) => (t.measures || []).map((m) => (
                      <div key={`${t.name}-${m.name}`} className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
                        <Caption1>{t.name}</Caption1>
                        <div style={{ fontWeight: 600 }}>{m.name}</div>
                        <pre style={{ margin: tokens.spacingVerticalNone, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%' }}>{m.expression || '—'}</pre>
                      </div>
                    )))}
                    {((detail?.tables || []).flatMap((t) => t.measures || []).length === 0) && (
                      <Caption1>No DAX measures returned (or the dataset hasn't exposed its model definition).</Caption1>
                    )}
                  </>
                )}
                {tab === 'aggregations' && (
                  <SemanticModelAggregationsTab
                    s={s} agg={agg} tables={detail?.tables}
                    targetStorageMode={detail?.dataset?.targetStorageMode} datasetId={effectiveDatasetId}
                  />
                )}
                {tab === 'refresh' && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Refreshes" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Request ID</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Start</TableHeaderCell>
                        <TableHeaderCell>End</TableHeaderCell>
                        <TableHeaderCell>Error</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {refreshes.length === 0 && <TableRow><TableCell colSpan={6}>No refresh history.</TableCell></TableRow>}
                        {refreshes.map((r, i) => (
                          <TableRow key={r.requestId || i}>
                            <TableCell className={s.cell}>{r.requestId?.slice(0, 8) || '—'}</TableCell>
                            <TableCell>{r.refreshType || '—'}</TableCell>
                            <TableCell>{r.status || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.startTime || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.endTime || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.serviceExceptionJson || ''}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {tab === 'incremental' && (
                  <SemanticModelIncrementalRefreshTab
                    s={s} ir={ir} tables={detail?.tables} workspaceId={nativeWorkspaceId} pbiWorkspaceId={pbiWorkspaceId} datasetId={effectiveDatasetId}
                  />
                )}
                {tab === 'config' && (
                  <>
                    <Subtitle2>Scheduled refresh</Subtitle2>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Mirrors the Power BI service Scheduled refresh pane. Writes via PATCH /datasets/{'{'}id{'}'}/refreshSchedule.
                    </Caption1>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM, maxWidth: 560 }}>
                      <Switch label="Keep your data up to date (enable scheduled refresh)" checked={schedEnabled} onChange={(_, d) => setSchedEnabled(d.checked)} />
                      <div>
                        <Caption1>Refresh days</Caption1>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS}}>
                          {DAYS.map((day) => (
                            <Button key={day} size="small" appearance={schedDays.includes(day) ? 'primary' : 'outline'} onClick={() => toggleSchedDay(day)}>{day.slice(0, 3)}</Button>
                          ))}
                        </div>
                      </div>
                      <Field label={<InfoLabel info="Clock times when Power BI runs the scheduled dataset refresh, in the time zone below. Power BI only accepts times on the hour or half-hour (minutes :00 or :30). Separate multiple times with commas.">Time(s) — HH:MM on :00 or :30, comma-separated</InfoLabel>}>
                        <Input value={schedTimes} onChange={(_, d) => setSchedTimes(d.value)} placeholder="07:00, 12:30" />
                      </Field>
                      <Field label="Time zone (PBI id)">
                        <Input value={schedTz} onChange={(_, d) => setSchedTz(d.value)} placeholder="UTC" />
                      </Field>
                      <Field label="On failure">
                        <Select value={schedNotify} onChange={(_, d) => setSchedNotify(d.value as 'MailOnFailure' | 'NoNotification')}>
                          <option value="NoNotification">No notification</option>
                          <option value="MailOnFailure">Email the dataset owner on failure</option>
                        </Select>
                      </Field>
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
                        <Button appearance="primary" icon={<Save20Regular />} disabled={schedBusy} onClick={saveSchedule}>{schedBusy ? 'Saving…' : 'Apply'}</Button>
                        <Button appearance="outline" disabled={takeoverBusy} onClick={takeOver} title="Take ownership of the dataset (needed if you are not the owner) before editing the schedule">{takeoverBusy ? 'Taking over…' : 'Take over dataset'}</Button>
                      </div>
                      {schedMsg && <MessageBar intent={schedMsg.ok ? 'success' : 'error'}><MessageBarBody>{schedMsg.text}</MessageBarBody></MessageBar>}
                    </div>

                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalXL }}>Row-level &amp; object-level security</Subtitle2>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      RLS role filters and OLS table/column permissions are authored on the dedicated <strong>Security (RLS/OLS)</strong> tab, which deploys real TMSL roles through the Analysis-Services XMLA endpoint and includes a Test-as-role probe.
                    </Caption1>
                  </>
                )}
                {tab === 'security' && datasetId && (
                  <SemanticModelSecurityTab
                    s={s}
                    tables={detail?.tables || []}
                    roles={secRoles}
                    busy={secBusy}
                    saving={secSaving}
                    err={secErr}
                    gate={secGate}
                    saveMsg={secSaveMsg}
                    selectedRole={secSelectedRole}
                    olsTable={secOlsTable}
                    testUpn={testRoleUpn}
                    testQuery={testQuery}
                    testBusy={testBusy}
                    testResult={testResult}
                    testErr={testErr}
                    onReload={() => loadRoles(datasetId, loomWorkspaceId)}
                    onAddRole={() => {
                      const base = 'NewRole';
                      const existing = new Set((secRoles || []).map((r) => r.name));
                      let name = base; let i = 1;
                      while (existing.has(name)) { name = `${base}${i++}`; }
                      setSecRoles([...(secRoles || []), { name, modelPermission: 'read', tablePermissions: [], members: [] }]);
                      setSecSelectedRole(name);
                    }}
                    onDeleteRole={(name) => {
                      setSecRoles((secRoles || []).filter((r) => r.name !== name));
                      if (secSelectedRole === name) setSecSelectedRole('');
                    }}
                    onRenameRole={(oldName, newName) => updateRole(oldName, (r) => ({ ...r, name: newName }))}
                    onSelectRole={setSecSelectedRole}
                    onSetFilter={(roleName, table, expr) => updateRole(roleName, (r) => {
                      const tps = [...r.tablePermissions];
                      const idx = tps.findIndex((tp) => tp.name === table);
                      if (idx >= 0) tps[idx] = { ...tps[idx], filterExpression: expr };
                      else tps.push({ name: table, filterExpression: expr, metadataPermission: 'read' });
                      return { ...r, tablePermissions: tps };
                    })}
                    onSetTableOls={(roleName, table, perm) => updateRole(roleName, (r) => {
                      const tps = [...r.tablePermissions];
                      const idx = tps.findIndex((tp) => tp.name === table);
                      if (idx >= 0) tps[idx] = { ...tps[idx], metadataPermission: perm };
                      else tps.push({ name: table, metadataPermission: perm });
                      return { ...r, tablePermissions: tps };
                    })}
                    onSetColumnOls={(roleName, table, column, perm) => updateRole(roleName, (r) => {
                      const tps = [...r.tablePermissions];
                      let idx = tps.findIndex((tp) => tp.name === table);
                      if (idx < 0) { tps.push({ name: table, metadataPermission: 'read', columnPermissions: [] }); idx = tps.length - 1; }
                      const cols = [...(tps[idx].columnPermissions || [])];
                      const cidx = cols.findIndex((c) => c.name === column);
                      if (cidx >= 0) cols[cidx] = { name: column, metadataPermission: perm };
                      else cols.push({ name: column, metadataPermission: perm });
                      tps[idx] = { ...tps[idx], columnPermissions: cols };
                      return { ...r, tablePermissions: tps };
                    })}
                    onSetMembers={(roleName, members) => updateRole(roleName, (r) => ({ ...r, members: members.map((m) => ({ memberName: m })) }))}
                    onChangeOlsTable={setSecOlsTable}
                    onSave={saveRoles}
                    onTestUpn={setTestRoleUpn}
                    onTestQuery={setTestQuery}
                    onRunTest={runTestRole}
                  />
                )}
                {tab === 'direct-lake' && (
                  <SemanticModelDirectLakeTab s={s} dl={dl} datasetId={effectiveDatasetId} />
                )}
                {tab === 'datasource' && isDqMode && datasetId && (
                  <DqSourcePanel datasetId={datasetId} itemId={id} workspaceId={loomWorkspaceId} />
                )}
                {tab === 'governance' && datasetId && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXL }}>
                    {/* F17 — read-only sensitivity label inherited from the model's
                        upstream lineage source (warehouse / lakehouse it's built on). */}
                    <UpstreamSensitivityField itemId={id} />
                    <EndorsementControl workspaceId={pbiWorkspaceId} itemId={datasetId} itemType="datasets" />
                    <GatewayDatasourcesPanel workspaceId={pbiWorkspaceId} datasetId={datasetId} />
                  </div>
                )}
                {tab === 'access' && (
                  <ManageAccessPanel workspaceId={pbiWorkspaceId} />
                )}
                {tab === 'embed' && powerBiConfigured && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Power BI embedding for semantic models</MessageBarTitle>
                      Browse the model metadata and author DAX in the Tables, Relationships, and Measures tabs above. Power BI live-query / external-tool embedding is configured here when a workspace is bound.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {tab === 'metrics' && <MetricViewBuilder defaultSource="" tableRef={selectedTableName || undefined} />}
                {tab === 'daxquery' && <DaxQueryView id={id} tables={(detail?.tables || []).map((t) => ({ name: t.name, columns: (t.columns || []).map((c) => ({ name: c.name, dataType: c.dataType })) }))} />}
                {tab === 'health' && <ModelHealthPane id={id} />}
                {tab === 'copilot' && <SemanticModelCopilotPane id={id} />}
                {/* WS-5.4 — NL "Ask" tab: ask questions about the semantic model.
                    Backed by /api/ask → chatGrounded against the semantic-model source.
                    Tables from the model schema are passed as grounding context. */}
                {tab === 'ask' && (
                  <div style={{ padding: tokens.spacingHorizontalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                    <AskAffordance
                      surfaceKind="semantic-model"
                      itemId={id}
                      itemType="semantic-model"
                      context={{ tables: (detail?.tables || []).map((t: { name: string }) => t.name) }}
                      alwaysOpen
                    />
                  </div>
                )}
                {tab === 'prep-for-ai' && <SemanticModelPrepForAiPane id={id} datasetId={datasetId} workspaceId={loomWorkspaceId} />}
                {tab === 'verified-queries' && <VerifiedQueriesPane id={id} modelName={detail?.dataset?.name || ''} />}
                {tab === 'calcGroups' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>Calculation groups</MessageBarTitle>
                        Author calculation items with <code>SELECTEDMEASURE()</code>. Each group becomes a slicer; selecting an item changes how the visual&rsquo;s measure is aggregated (YTD, MTD, prior year, % of total&hellip;). Saved to this model and emitted in TMSL at provision time on the Loom-native default; set <code>LOOM_SEMANTIC_BACKEND=aas</code> or <code>=fabric</code> to push to a live model.{' '}
                        <a href="https://learn.microsoft.com/analysis-services/tabular-models/calculation-groups" target="_blank" rel="noreferrer">Docs</a>
                      </MessageBarBody>
                    </MessageBar>
                    {calcGroups.map((cg, gi) => (
                      <div key={gi} className={s.card}>
                        <div className={s.toolbar}>
                          <Field label="Group name" style={{ minWidth: 220 }}>
                            <Input value={cg.name} placeholder="Time Intelligence"
                              onChange={(_, d) => setCalcGroups((prev) => prev.map((g, i) => i === gi ? { ...g, name: d.value } : g))} />
                          </Field>
                          <Field label="Precedence">
                            <SpinButton value={cg.precedence} min={0} max={9999}
                              onChange={(_, d) => setCalcGroups((prev) => prev.map((g, i) => i === gi ? { ...g, precedence: Number(d.value ?? d.displayValue ?? 0) || 0 } : g))} />
                          </Field>
                          <Button appearance="subtle" icon={<Delete20Regular />} title="Remove group"
                            onClick={() => setCalcGroups((prev) => prev.filter((_, i) => i !== gi))} />
                        </div>
                        {cg.items.map((ci, ii) => (
                          <div key={ii} className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
                            <div className={s.toolbar}>
                              <Field label="Item name" style={{ minWidth: 180 }}>
                                <Input value={ci.name} placeholder="YTD"
                                  onChange={(_, d) => setCalcGroups((prev) => prev.map((g, gi2) => gi2 !== gi ? g : { ...g, items: g.items.map((it, j) => j === ii ? { ...it, name: d.value } : it) }))} />
                              </Field>
                              <Field label="Ordinal">
                                <SpinButton value={ci.ordinal ?? -1} min={-1} max={999}
                                  onChange={(_, d) => setCalcGroups((prev) => prev.map((g, gi2) => gi2 !== gi ? g : { ...g, items: g.items.map((it, j) => j === ii ? { ...it, ordinal: Number(d.value ?? d.displayValue ?? -1) } : it) }))} />
                              </Field>
                              <Button appearance="subtle" icon={<Delete20Regular />} title="Remove item"
                                onClick={() => setCalcGroups((prev) => prev.map((g, gi2) => gi2 !== gi ? g : { ...g, items: g.items.filter((_, j) => j !== ii) }))} />
                            </div>
                            <Caption1>DAX expression — use <code>SELECTEDMEASURE()</code></Caption1>
                            <MonacoTextarea value={ci.expression} language="sql" height={80} minHeight={60} ariaLabel="Calculation item DAX"
                              onChange={(v) => setCalcGroups((prev) => prev.map((g, gi2) => gi2 !== gi ? g : { ...g, items: g.items.map((it, j) => j === ii ? { ...it, expression: v } : it) }))} />
                            <Caption1 style={{ marginTop: tokens.spacingVerticalXS}}>Dynamic format string (optional DAX — e.g. <code>SELECTEDMEASUREFORMATSTRING()</code>)</Caption1>
                            <MonacoTextarea value={ci.formatStringDefinition || ''} language="sql" height={50} minHeight={40} ariaLabel="Format string DAX"
                              onChange={(v) => setCalcGroups((prev) => prev.map((g, gi2) => gi2 !== gi ? g : { ...g, items: g.items.map((it, j) => j === ii ? { ...it, formatStringDefinition: v || undefined } : it) }))} />
                          </div>
                        ))}
                        <Button size="small" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalS, alignSelf: 'flex-start' }}
                          onClick={() => setCalcGroups((prev) => prev.map((g, i) => i !== gi ? g : { ...g, items: [...g.items, { name: 'New item', expression: 'SELECTEDMEASURE()' }] }))}>Add item</Button>
                      </div>
                    ))}
                    <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalM}}>
                      <Button icon={<Add20Regular />}
                        onClick={() => setCalcGroups((prev) => [...prev, { name: 'New group', precedence: 10, items: [{ name: 'Current', expression: 'SELECTEDMEASURE()' }] }])}>Add group</Button>
                      <Button appearance="primary" icon={<Save20Regular />} disabled={cgBusy || calcGroups.length === 0 || !datasetId}
                        onClick={saveCalcGroups}>{cgBusy ? 'Saving…' : 'Save calc groups'}</Button>
                    </div>
                    {cgMsg && <MessageBar intent={cgMsg.ok ? 'success' : 'error'}><MessageBarBody>{cgMsg.text}</MessageBarBody></MessageBar>}
                  </div>
                )}
                {tab === 'fieldParams' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>Field parameters</MessageBarTitle>
                        Build a <code>NAMEOF()</code> calculated table that lets report readers swap the measure or dimension a visual shows via a slicer. Pick the fields below; the generated DAX is shown live. Saved to this model and emitted in TMSL at provision time on the Loom-native default.{' '}
                        <a href="https://learn.microsoft.com/power-bi/create-reports/power-bi-field-parameters" target="_blank" rel="noreferrer">Docs</a>
                      </MessageBarBody>
                    </MessageBar>
                    {fieldParams.map((fp, fi) => (
                      <div key={fi} className={s.card}>
                        <div className={s.toolbar}>
                          <Field label="Parameter name" style={{ minWidth: 220 }}>
                            <Input value={fp.name} placeholder="Metric Selector"
                              onChange={(_, d) => setFieldParams((prev) => prev.map((p, i) => i === fi ? { ...p, name: d.value } : p))} />
                          </Field>
                          <Button appearance="subtle" icon={<Delete20Regular />} title="Remove parameter"
                            onClick={() => setFieldParams((prev) => prev.filter((_, i) => i !== fi))} />
                        </div>
                        {fp.fields.map((f, fj) => (
                          <div key={fj} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end', marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                            <Field label="Display name" style={{ minWidth: 160 }}>
                              <Input value={f.displayName} placeholder="Total Sales"
                                onChange={(_, d) => setFieldParams((prev) => prev.map((p, pi) => pi !== fi ? p : { ...p, fields: p.fields.map((ff, j) => j === fj ? { ...ff, displayName: d.value } : ff) }))} />
                            </Field>
                            <Field label="NAMEOF reference" style={{ flex: 1, minWidth: 200 }}>
                              <Input value={f.fieldRef} placeholder="'Sales'[Amount]"
                                onChange={(_, d) => setFieldParams((prev) => prev.map((p, pi) => pi !== fi ? p : { ...p, fields: p.fields.map((ff, j) => j === fj ? { ...ff, fieldRef: d.value } : ff) }))} />
                            </Field>
                            <Field label="Order">
                              <SpinButton value={f.order} min={0} max={999}
                                onChange={(_, d) => setFieldParams((prev) => prev.map((p, pi) => pi !== fi ? p : { ...p, fields: p.fields.map((ff, j) => j === fj ? { ...ff, order: Number(d.value ?? d.displayValue ?? 0) || 0 } : ff) }))} />
                            </Field>
                            <Button appearance="subtle" icon={<Delete20Regular />} title="Remove field"
                              onClick={() => setFieldParams((prev) => prev.map((p, pi) => pi !== fi ? p : { ...p, fields: p.fields.filter((_, j) => j !== fj) }))} />
                          </div>
                        ))}
                        <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>Generated DAX</Caption1>
                        <pre className={s.assistResult} style={{ marginTop: tokens.spacingVerticalXS, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, whiteSpace: 'pre-wrap' }}>
{`${fp.name} = {\n${fp.fields.map((f, i) => `\t("${f.displayName}", NAMEOF(${f.fieldRef}), ${typeof f.order === 'number' ? f.order : i})`).join(',\n')}\n}`}
                        </pre>
                        <Button size="small" icon={<Add20Regular />} style={{ marginTop: tokens.spacingVerticalS, alignSelf: 'flex-start' }}
                          onClick={() => setFieldParams((prev) => prev.map((p, i) => i !== fi ? p : { ...p, fields: [...p.fields, { displayName: 'New field', fieldRef: "'Table'[Column]", order: p.fields.length }] }))}>Add field</Button>
                      </div>
                    ))}
                    <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalM}}>
                      <Button icon={<Add20Regular />}
                        onClick={() => setFieldParams((prev) => [...prev, { name: 'New Parameter', fields: [{ displayName: 'Field 1', fieldRef: "'Table'[Column]", order: 0 }] }])}>Add parameter</Button>
                      <Button appearance="primary" icon={<Save20Regular />} disabled={fpBusy || fieldParams.length === 0 || !datasetId}
                        onClick={saveFieldParams}>{fpBusy ? 'Saving…' : 'Save field parameters'}</Button>
                    </div>
                    {fpMsg && <MessageBar intent={fpMsg.ok ? 'success' : 'error'}><MessageBarBody>{fpMsg.text}</MessageBarBody></MessageBar>}
                  </div>
                )}

                {tab === 'direct-lake-query' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>Direct Lake query with transparent Serverless fallback</MessageBarTitle>
                        When the warm cache (last model refresh) is within{' '}
                        <code>LOOM_DL_CACHE_TTL_SECONDS</code>, rows are served from the Power BI
                        in-memory VertiPaq cache. When stale or unbuilt, the same Gold Delta files
                        are queried transparently via Synapse Serverless <code>OPENROWSET</code> —
                        the Azure-native analog of Fabric Direct Lake on SQL DirectQuery fallback.
                        No Fabric capacity required. With <code>LOOM_SEMANTIC_BACKEND=loom-columnar-cache</code>,
                        the Serverless DirectQuery is <strong>framed + result-cached</strong>: a repeat query
                        answers from cache at import-like latency, and when the Delta version advances the frame
                        rotates so the next query re-reads live — no manual refresh.
                      </MessageBarBody>
                    </MessageBar>

                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS}}>
                        <Label htmlFor="dl-table-picker">Table</Label>
                        {(detail?.tables && detail.tables.length > 0) ? (
                          <Dropdown
                            id="dl-table-picker"
                            placeholder="Select table"
                            value={dlTable}
                            selectedOptions={dlTable ? [dlTable] : []}
                            onOptionSelect={(_, d) => setDlTable((d.optionValue as string) || '')}
                            style={{ minWidth: 200 }}
                          >
                            {detail.tables.map((t) => (
                              <Option key={t.name} value={t.name}>{t.name}</Option>
                            ))}
                          </Dropdown>
                        ) : (
                          <Input
                            id="dl-table-picker"
                            placeholder="Gold Delta table name (e.g. fact_sales)"
                            value={dlTable}
                            onChange={(_, d) => setDlTable(d.value)}
                            style={{ minWidth: 240 }}
                          />
                        )}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS}}>
                        <Label htmlFor="dl-max-rows">Max rows</Label>
                        <Input
                          id="dl-max-rows"
                          type="number"
                          value={String(dlMaxRows)}
                          onChange={(_, d) => setDlMaxRows(Math.min(5000, Math.max(1, parseInt(d.value, 10) || 1000)))}
                          style={{ width: 100 }}
                        />
                      </div>
                      <Button
                        appearance="primary"
                        icon={<Play20Regular />}
                        disabled={!dlTable || dlqLoading}
                        onClick={executeDlQuery}
                      >
                        Run
                      </Button>
                    </div>

                    {dlqLoading && <Spinner size="small" label="Querying…" labelPosition="after" />}

                    {dlResult && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                          {dlResult.servingFrom === 'warm-cache' && (
                            <Badge appearance="filled" color="success">Serving from: warm cache</Badge>
                          )}
                          {dlResult.servingFrom === 'serverless-fallback' && (
                            <Badge appearance="filled" color="warning">Serving from: fallback (Serverless)</Badge>
                          )}
                          {dlResult.servingFrom === 'columnar-cache' && (
                            <Badge appearance="filled" color="success">Serving from: columnar cache (import-like)</Badge>
                          )}
                          {dlResult.servingFrom === 'serverless-direct' && (
                            <Badge appearance="filled" color="brand">Serving from: Serverless DirectQuery (framed)</Badge>
                          )}
                          {dlResult.executionMs !== undefined && (
                            <Caption1>{dlResult.executionMs} ms</Caption1>
                          )}
                          {dlResult.rowCount !== undefined && (
                            <Badge appearance="outline">{dlResult.rowCount} rows</Badge>
                          )}
                          {dlResult.truncated && <Badge color="warning">Truncated</Badge>}
                        </div>

                        {(dlResult.servingFrom === 'columnar-cache' || dlResult.servingFrom === 'serverless-direct') && (
                          <Caption1>
                            Storage mode: <strong>Direct Lake (Azure-native)</strong> — Serverless DirectQuery over
                            external Delta with framed result caching. No VertiPaq import, no manual refresh.
                            {dlResult.deltaVersion != null && <> · Frame: <code>Delta v{dlResult.deltaVersion}</code></>}
                            {dlResult.deltaVersion == null && dlResult.frameVia && <> · Frame via <code>{dlResult.frameVia}</code></>}
                            {dlResult.framedAt && <> · framed {new Date(dlResult.framedAt).toLocaleTimeString()}</>}
                            {dlResult.cached ? ' · cache hit' : ' · live read (re-cached)'}
                          </Caption1>
                        )}

                        {(dlResult.servingFrom === 'serverless-fallback' || dlResult.servingFrom === 'serverless-direct' || dlResult.servingFrom === 'columnar-cache') && dlResult.endpoint && (
                          <Caption1>
                            Serverless endpoint: <code>{dlResult.endpoint}</code>
                            {dlResult.deltaPath && <> · Delta path: <code>{dlResult.deltaPath}</code></>}
                          </Caption1>
                        )}
                        {dlResult.lastRefreshedAt && (
                          <Caption1>
                            Last successful model refresh: {new Date(dlResult.lastRefreshedAt).toLocaleString()}
                            {dlResult.cacheTtlSeconds !== undefined && <> (TTL {dlResult.cacheTtlSeconds}s)</>}
                          </Caption1>
                        )}

                        {!dlResult.ok && (
                          <MessageBar intent="error">
                            <MessageBarBody>
                              <MessageBarTitle>Query failed</MessageBarTitle>
                              {dlResult.error}
                            </MessageBarBody>
                          </MessageBar>
                        )}

                        {dlResult.ok && dlResult.columns && dlResult.rows && (
                          <div style={{ overflowX: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: tokens.fontSizeBase200}}>
                              <thead>
                                <tr>
                                  {dlResult.columns.map((c) => (
                                    <th key={c} style={{ padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, background: tokens.colorNeutralBackground2, textAlign: 'left', fontWeight: 600, position: 'sticky', top: 0 }}>{c}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {dlResult.rows.slice(0, 200).map((row, ri) => (
                                  <tr key={ri}>
                                    {(row as unknown[]).map((cell, ci) => (
                                      <td key={ci} style={{ padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`, borderBottom: `1px solid ${tokens.colorNeutralStroke3}` }}>
                                        {cell === null || cell === undefined ? <em style={{ opacity: 0.5 }}>null</em> : String(cell)}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      }
    />
    {/* Add calculated column (DAX) dialog */}
    <Dialog open={calcColDlgOpen} onOpenChange={(_, d) => { setCalcColDlgOpen(d.open); if (!d.open) setCalcMsg(null); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add calculated column — {selectedTableName}</DialogTitle>
          <DialogContent>
            <Field label="Column name" required>
              <Input value={calcColName} onChange={(_, d) => setCalcColName(d.value)} placeholder="Margin" />
            </Field>
            <Field label="Data type" style={{ marginTop: tokens.spacingVerticalS}}>
              <Select value={calcColType} onChange={(_, d) => setCalcColType(d.value)}>
                {SM_DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Data category" style={{ marginTop: tokens.spacingVerticalS}}>
              <Select value={calcColCat} onChange={(_, d) => setCalcColCat(d.value)}>
                <option value="">— none —</option>
                {SM_DATA_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Display folder" style={{ marginTop: tokens.spacingVerticalS}}>
              <Input value={calcColFolder} onChange={(_, d) => setCalcColFolder(d.value)} placeholder="e.g. Finance" />
            </Field>
            <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>DAX expression</Caption1>
            <MonacoTextarea value={calcColExpr} onChange={setCalcColExpr} language="sql" height={120} minHeight={80} ariaLabel="Calculated column DAX" />
            {calcMsg && <MessageBar intent={calcMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{calcMsg.text}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={calcBusy || !calcColName.trim() || !calcColExpr.trim()} onClick={addCalcColumn}>
              {calcBusy ? 'Creating…' : 'Create'}
            </Button>
            <DialogTrigger disableButtonEnhancement><Button appearance="subtle">Cancel</Button></DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
    {/* Add calculated table (DAX) dialog */}
    <Dialog open={calcTableDlgOpen} onOpenChange={(_, d) => { setCalcTableDlgOpen(d.open); if (!d.open) setCalcMsg(null); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add calculated table</DialogTitle>
          <DialogContent>
            <Field label="Table name" required>
              <Input value={calcTableName} onChange={(_, d) => setCalcTableName(d.value)} placeholder="DimDate" />
            </Field>
            <Caption1 style={{ marginTop: tokens.spacingVerticalS}}>DAX table expression</Caption1>
            <MonacoTextarea value={calcTableExpr} onChange={setCalcTableExpr} language="sql" height={120} minHeight={80} ariaLabel="Calculated table DAX" />
            {calcMsg && <MessageBar intent={calcMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{calcMsg.text}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={calcBusy || !calcTableName.trim() || !calcTableExpr.trim()} onClick={addCalcTable}>
              {calcBusy ? 'Creating…' : 'Create'}
            </Button>
            <DialogTrigger disableButtonEnhancement><Button appearance="subtle">Cancel</Button></DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
    </>
  );
}

// ============================================================
// Report (Power BI)
// ============================================================
// Power BI authoring (visuals, bookmarks, page editor) is out-of-scope for
// the Loom Console — Power BI Desktop / Power BI Web are the supported
// authoring surfaces. The Loom editor is a metadata + embed-viewer + open-
// in-Desktop launcher. Each editor (Report, Dashboard, Scorecard) builds
// an honest inline ribbon (no decorative disabled buttons) below.

/**
 * Built-in Power BI report themes (parity with the Power BI service
 * "View → Themes" gallery). Each entry is a valid Power BI report-theme JSON
 * object — applied at runtime via `report.applyTheme({ themeJson })` and at
 * load time via the embed config `theme`. Kept as TypeScript constants (not a
 * freeform JSON config file) per loom-no-freeform-config: the user picks a
 * named preset from a dropdown, or pastes a custom theme into the editor.
 * Format reference: https://learn.microsoft.com/power-bi/create-reports/desktop-report-themes#report-theme-json-file-format
 */
