'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Plan editor (Cosmos-backed planning sheets, EPM cube model, formulas).
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
  Send20Regular, ArrowSplit20Regular, History20Regular, Camera20Regular,
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
  featurePropertyKeys, type AzureMapsView, type AzureMapsControls,
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
  // Spreading / breakback / driver-based topological recompute.
  spread, breakback, driverRows, topoOrderLineItems, type SpreadMode,
  // Versions / snapshots (immutable plan versions persisted in Cosmos state).
  captureSnapshot, takeSnapshot, diffSnapshots, restoreSnapshot, MAX_PLAN_SNAPSHOTS,
  type PlanSnapshot, type PlanSnapshotDiff,
  type PlanScenario, type PlanScenarioKind,
  type PlanningSheet, type PlanSemanticModelRef, type PlanBackingDb,
  type PlanCellRow, type PlanRowSortKey, type PeriodPoint, type GanttBar,
  type PlanSourceMapping, type PlanLineItem,
  type PlanModel, type PlanDimension, type PlanMember, type PlanMeasure,
  type PlanAggKind, type PlanDimensionAxis, type PlanFormulaToken,
  type PlanFormulaFn, type PlanFormulaOp, type ModelIssue,
} from '../_plan-model';
import { arr, useItemState, SaveBar, useStyles } from './shared';

// ----- Plan (Cosmos task list) -----
interface PlanTask { title: string; owner: string; due: string; status: 'todo' | 'doing' | 'done'; dependsOn?: string }
type PlanApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected';
interface PlanState {
  tasks: PlanTask[];
  // audit-T13 — approval workflow + semantic-model writeback link.
  approvalStatus?: PlanApprovalStatus;
  approvedBy?: string | null;
  approvedAt?: string | null;
  approvalReason?: string | null;
  approverEmail?: string;
  linkedSemanticModelId?: string;
  // audit-T64 — EPM/CPM planning surface (budgets / forecasts / scenarios).
  sheets?: PlanningSheet[];
  scenarios?: PlanScenario[];
  activeSheetId?: string;
  activeScenarioId?: string;
  semanticModelRef?: PlanSemanticModelRef;
  backingDb?: PlanBackingDb;
  // EPM core — the multidimensional cube model (dimensions + measures).
  model?: PlanModel;
  // audit-T64 finish — InfoBridge source-system → line-item mappings.
  infoBridge?: PlanSourceMapping[];
  // Intelligence forecast horizon (periods to project); persisted per plan.
  forecastHorizon?: number;
  // Versions — immutable snapshots (cells + lineItems + scenarios), persisted
  // via the ordinary item PATCH (Cosmos). See _plan-model takeSnapshot/restore.
  snapshots?: PlanSnapshot[];
  [k: string]: unknown;
}

/**
 * audit-T13 — Plan approval handoff + semantic-model writeback panel.
 *
 * Routes the plan through the Azure-native approval Logic App (Office 365
 * approval email; no Fabric / Power Automate) and, on approval, pushes the
 * plan's task status + approval state into a linked semantic model via XMLA.
 * Real backends only: POST /api/items/plan/[id]/approval and
 * POST /api/items/semantic-model/[linkedId]/model { planMetrics }. Honest
 * Fluent gates when the Logic App / XMLA endpoint isn't configured.
 */
function PlanApprovalPanel({
  id, tasks, state, setState, save,
}: {
  id: string;
  tasks: PlanTask[];
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  save: (next?: PlanState) => Promise<boolean>;
}) {
  const status: PlanApprovalStatus = (state.approvalStatus as PlanApprovalStatus) || 'none';
  const [approver, setApprover] = useState(state.approverEmail || '');
  const [linkedModel, setLinkedModel] = useState(state.linkedSemanticModelId || '');
  const [busy, setBusy] = useState<'request' | 'push' | null>(null);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning' | 'info'; text: string } | null>(null);

  const statusColor: Record<PlanApprovalStatus, 'informative' | 'warning' | 'success' | 'danger'> = {
    none: 'informative', pending: 'warning', approved: 'success', rejected: 'danger',
  };
  const statusLabel: Record<PlanApprovalStatus, string> = {
    none: 'Not requested', pending: 'Pending', approved: 'Approved', rejected: 'Rejected',
  };

  const requestApproval = useCallback(async () => {
    if (!approver.trim()) { setMsg({ intent: 'error', text: 'Enter an approver email first.' }); return; }
    if (!id || id === 'new') { setMsg({ intent: 'error', text: 'Save the plan before requesting approval.' }); return; }
    setBusy('request'); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/plan/${encodeURIComponent(id)}/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approverEmail: approver.trim(), linkedSemanticModelId: linkedModel.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const gate = j?.gate;
        setMsg({ intent: gate ? 'warning' : 'error', text: gate ? `${gate.reason} ${gate.remediation}` : (j?.error || `HTTP ${r.status}`) });
        return;
      }
      setState((prev) => ({ ...prev, approvalStatus: 'pending', approverEmail: approver.trim(), linkedSemanticModelId: linkedModel.trim() || undefined }));
      setMsg({ intent: 'success', text: j?.message || 'Approval email sent.' });
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(null); }
  }, [approver, linkedModel, id, setState]);

  const refreshStatus = useCallback(async () => {
    if (!id || id === 'new') return;
    try {
      const r = await clientFetch(`/api/items/plan/${encodeURIComponent(id)}/approval?action=status`);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok) {
        setState((prev) => ({
          ...prev,
          approvalStatus: j.approvalStatus, approvedBy: j.approvedBy, approvedAt: j.approvedAt, approvalReason: j.approvalReason,
        }));
      }
    } catch { /* best-effort */ }
  }, [id, setState]);

  const pushMetrics = useCallback(async () => {
    const linkId = linkedModel.trim();
    if (!linkId) { setMsg({ intent: 'warning', text: 'Link a semantic model item id to push plan metrics into it.' }); return; }
    setBusy('push'); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(linkId)}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planMetrics: { tasks, approvalStatus: status } }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.xmlaUnavailable) {
        setMsg({ intent: 'warning', text: j?.detail || 'XMLA endpoint not configured; metrics saved to model content.' });
      } else if (!r.ok || j?.ok === false) {
        setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` });
      } else {
        setMsg({ intent: 'success', text: `Plan metrics pushed (${j?.backend || 'loom-native'}). ${(j?.steps || []).join(' ')}` });
      }
      // Persist the link on the plan so the callback writeback can find it.
      if (linkId !== (state.linkedSemanticModelId || '')) {
        setState((prev) => ({ ...prev, linkedSemanticModelId: linkId }));
        await save({ ...state, linkedSemanticModelId: linkId });
      }
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(null); }
  }, [linkedModel, tasks, status, state, setState, save]);

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
        padding: tokens.spacingVerticalL,
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusLarge,
        background: tokens.colorNeutralBackground2,
        boxShadow: tokens.shadow2,
      }}
    >
      {/* Section header — leading icon, title, status pill, inline timestamp/reason. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
        <ShieldCheckmark20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
        <Subtitle2>Approval workflow</Subtitle2>
        <Badge appearance="filled" color={statusColor[status]}>{statusLabel[status]}</Badge>
        {status === 'approved' && state.approvedBy && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            by {String(state.approvedBy)}{state.approvedAt ? ` · ${new Date(String(state.approvedAt)).toLocaleString()}` : ''}
          </Caption1>
        )}
        {status === 'rejected' && state.approvalReason && (
          <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{String(state.approvalReason)}</Caption1>
        )}
        {status === 'pending' && (
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowSync16Regular />}
            onClick={refreshStatus}
            style={{ marginLeft: 'auto' }}
          >
            Refresh status
          </Button>
        )}
      </div>

      <Caption1 style={{ color: tokens.colorNeutralForeground3, lineHeight: tokens.lineHeightBase200 }}>
        Routes this plan through the Azure-native approval Logic App (Office 365 approval email). On approval, plan
        metrics can be written into a linked semantic model via XMLA — no Microsoft Fabric / Power Automate required.
      </Caption1>

      <div style={{ height: 1, background: tokens.colorNeutralStroke2, alignSelf: 'stretch' }} />

      {/* Request approval row. */}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Approver email" style={{ flex: '1 1 260px', minWidth: 240 }}>
          <Input
            type="email"
            value={approver}
            placeholder="approver@contoso.com"
            contentBefore={<Mail16Regular />}
            onChange={(_, d) => setApprover(d.value)}
            disabled={status === 'pending'}
          />
        </Field>
        <Button
          appearance="primary"
          icon={busy === 'request' ? <Spinner size="tiny" /> : <Mail16Regular />}
          onClick={requestApproval}
          disabled={busy !== null || status === 'pending'}
        >
          {busy === 'request' ? 'Sending…' : status === 'pending' ? 'Awaiting response…' : status === 'approved' ? 'Re-request approval' : 'Request approval'}
        </Button>
      </div>

      {/* Semantic-model writeback row. */}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field
          label="Linked semantic model (item id)"
          hint="Plan metrics (_PlanTasks + _PlanMetrics measures) are written here on approval."
          style={{ flex: '1 1 300px', minWidth: 280 }}
        >
          <Input
            value={linkedModel}
            placeholder="semantic-model item id"
            contentBefore={<DataUsage20Regular />}
            onChange={(_, d) => setLinkedModel(d.value)}
          />
        </Field>
        <Button
          icon={busy === 'push' ? <Spinner size="tiny" /> : <ArrowUpload16Regular />}
          onClick={pushMetrics}
          disabled={busy !== null}
        >
          {busy === 'push' ? 'Pushing…' : 'Push plan metrics'}
        </Button>
      </div>

      {msg && (
        <MessageBar intent={msg.intent}>
          <MessageBarBody>
            <MessageBarTitle>
              {msg.intent === 'success' ? 'Done' : msg.intent === 'error' ? 'Could not complete' : msg.intent === 'warning' ? 'Action needed' : 'Status'}
            </MessageBarTitle>
            {msg.text}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

// ===================================================================
// audit-T64 — Plan (preview) EPM/CPM surface
//
// Azure-native parity of Microsoft Fabric's **Plan (preview)** Fabric IQ item:
// budgets, forecasts, scenario modeling, variance — over a bound semantic model
// (for actuals) and an opt-in Azure SQL backing store (for governed writeback).
// NO Microsoft Fabric dependency: planning cells persist to Cosmos by default
// and the entire surface works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
//   Backends: PATCH /api/items/plan/[id] (Cosmos),
//             GET/POST /api/items/plan/[id]/binding (semantic models + backing),
//             POST /api/items/plan/[id]/writeback (Azure SQL MERGE).
// ===================================================================

/** Seed planning collections so a legacy task-only plan still renders fully. */
function ensureSheets(prev: PlanState): PlanningSheet[] {
  const cur = arr<PlanningSheet>(prev.sheets);
  return cur.length ? cur : [defaultPlanningSheet()];
}
function ensureScenarios(prev: PlanState): PlanScenario[] {
  const cur = arr<PlanScenario>(prev.scenarios);
  return cur.length ? cur : defaultScenarios();
}
/** Seed the cube model so a legacy plan (no model) still renders the Model tab. */
function ensureModel(prev: PlanState): PlanModel {
  const m = prev.model;
  if (m && typeof m === 'object' && (Array.isArray(m.dimensions) || Array.isArray(m.measures))) {
    return { dimensions: arr<PlanDimension>(m.dimensions), measures: arr<PlanMeasure>(m.measures) };
  }
  return emptyPlanModel();
}
const fmtNum = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

/**
 * Settings flyout — semantic-model connection + Azure SQL backing store, the
 * Azure-native parity of Fabric Plan's "Settings → model + database connection".
 */
function PlanSettingsFlyout({
  id, state, setState, open, onClose,
}: {
  id: string;
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  open: boolean;
  onClose: () => void;
}) {
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [backing, setBacking] = useState<{ configured: boolean; server?: string; database?: string; gate?: { missing: string; reason: string; remediation: string } } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    if (!open || !id || id === 'new') return;
    setLoading(true); setMsg(null);
    clientFetch(`/api/items/plan/${encodeURIComponent(id)}/binding`)
      .then((r) => r.json().catch(() => ({})))
      .then((j) => {
        if (j?.ok) { setModels(arr(j.semanticModels)); setBacking(j.backing || null); }
        else setMsg({ intent: 'error', text: j?.error || 'Failed to load settings.' });
      })
      .catch((e) => setMsg({ intent: 'error', text: e?.message || String(e) }))
      .finally(() => setLoading(false));
  }, [open, id]);

  const ref = state.semanticModelRef;
  const selectModel = (modelId: string) => {
    const m = models.find((x) => x.id === modelId);
    setState((prev) => ({ ...prev, semanticModelRef: m ? { itemId: m.id, displayName: m.name } : undefined }));
  };
  const provision = async () => {
    if (!id || id === 'new') { setMsg({ intent: 'error', text: 'Save the plan first.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/plan/${encodeURIComponent(id)}/binding`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'provision' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: j?.gate ? `${j.gate.reason} ${j.gate.remediation}` : (j?.error || `HTTP ${r.status}`) });
        return;
      }
      setBacking({ configured: true, server: j.server, database: j.database });
      setState((prev) => ({ ...prev, backingDb: { kind: 'azure-sql', serverName: j.server, dbName: j.database, provisionedAt: new Date().toISOString() } }));
      setMsg({ intent: 'success', text: j.message || 'Backing store ready.' });
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Plan settings</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              {loading && <Spinner size="tiny" label="Loading settings…" labelPosition="after" />}
              <Field label="Semantic model (actuals source)" hint="Plan-vs-actual variance reads measures from this bound model. Azure-native: Loom semantic model / AAS — no Power BI workspace required.">
                <Dropdown
                  placeholder={models.length ? 'Select a semantic model…' : 'No semantic models found'}
                  value={ref?.displayName || ''}
                  selectedOptions={ref ? [ref.itemId] : []}
                  onOptionSelect={(_, d) => selectModel(d.optionValue || '')}
                  disabled={models.length === 0}
                >
                  {models.map((m) => <Option key={m.id} value={m.id}>{m.name}</Option>)}
                </Dropdown>
              </Field>

              <div style={{ height: 1, background: tokens.colorNeutralStroke2 }} />

              <Subtitle2 style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge }}><Database20Regular /> Backing store (writeback)</Subtitle2>
              {backing?.configured ? (
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>Azure SQL configured</MessageBarTitle>
                    Writeback target: <strong>{backing.database}</strong> on <strong>{backing.server}</strong>. Saved planning cells MERGE into <code>dbo.loom_plan_cells</code>.
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>No Azure SQL writeback store</MessageBarTitle>
                    {backing?.gate?.reason || 'Planning cells persist to Cosmos and the plan is fully functional.'}{' '}
                    {backing?.gate ? <>Set <code>{backing.gate.missing}</code>. {backing.gate.remediation}</> : null}
                  </MessageBarBody>
                </MessageBar>
              )}
              <Button
                icon={busy ? <Spinner size="tiny" /> : <Database20Regular />}
                onClick={provision}
                disabled={busy || (backing?.configured === false && !!backing?.gate)}
                appearance={backing?.configured ? 'secondary' : 'primary'}
                style={{ alignSelf: 'flex-start' }}
              >
                {backing?.configured ? 'Re-provision tables' : 'Provision backing store'}
              </Button>

              {msg && (
                <MessageBar intent={msg.intent}>
                  <MessageBarBody>{msg.text}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>Done</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** The planning-sheet grid: dimensions on rows, periods on columns, scenarios, variance. */
function PlanningSheetPanel({
  id, state, setState, save, saving,
}: {
  id: string;
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  save: (next?: PlanState) => Promise<boolean>;
  saving: boolean;
}) {
  const sheets = ensureSheets(state);
  const scenarios = ensureScenarios(state);
  const activeSheetId = sheets.some((s) => s.id === state.activeSheetId) ? (state.activeSheetId as string) : sheets[0].id;
  const activeScenarioId = scenarios.some((s) => s.id === state.activeScenarioId) ? (state.activeScenarioId as string) : scenarios[0].id;
  const sheet = sheets.find((s) => s.id === activeSheetId) || sheets[0];
  const scenario = scenarios.find((s) => s.id === activeScenarioId) || scenarios[0];

  const [showVariance, setShowVariance] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  // Hierarchy drill-down (collapsed parent ids) + Formula builder target row.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [formulaEdit, setFormulaEdit] = useState<string | null>(null);
  // Spreading (allocation) + breakback dialogs — parent+period → child cells.
  const [spreadCtx, setSpreadCtx] = useState<{ parentId: string; periodId: string; mode: SpreadMode } | null>(null);
  const [breakbackCtx, setBreakbackCtx] = useState<{ parentId: string; periodId: string } | null>(null);
  const toggleCollapse = (liId: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(liId)) next.delete(liId); else next.add(liId);
    return next;
  });

  // All sheet mutations funnel through here so the seeded defaults persist.
  const mutateSheet = (sheetId: string, mut: (s: PlanningSheet) => PlanningSheet) =>
    setState((prev) => ({
      ...prev,
      sheets: ensureSheets(prev).map((s) => (s.id === sheetId ? mut(s) : s)),
      scenarios: ensureScenarios(prev),
      activeSheetId, activeScenarioId,
    }));

  const setCell = (lineItemId: string, periodId: string, raw: string) => {
    const value = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(value)) return;
    mutateSheet(sheet.id, (s) => ({ ...s, cells: { ...s.cells, [cellKey(lineItemId, periodId, activeScenarioId)]: value } }));
  };
  const setActual = (lineItemId: string, raw: string) => {
    const value = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(value)) return;
    mutateSheet(sheet.id, (s) => ({ ...s, actuals: { ...(s.actuals || {}), [lineItemId]: value } }));
  };
  const addLineItem = () => mutateSheet(sheet.id, (s) => ({ ...s, lineItems: [...s.lineItems, { id: newId('li'), name: 'New line item', kind: 'input' }] }));
  const renameLineItem = (liId: string, name: string) => mutateSheet(sheet.id, (s) => ({ ...s, lineItems: s.lineItems.map((li) => (li.id === liId ? { ...li, name } : li)) }));
  const removeLineItem = (liId: string) => mutateSheet(sheet.id, (s) => ({ ...s, lineItems: s.lineItems.filter((li) => li.id !== liId) }));
  const addPeriod = () => mutateSheet(sheet.id, (s) => ({ ...s, periods: [...s.periods, { id: newId('p'), label: `P${s.periods.length + 1}` }] }));
  const renamePeriod = (pId: string, label: string) => mutateSheet(sheet.id, (s) => ({ ...s, periods: s.periods.map((p) => (p.id === pId ? { ...p, label } : p)) }));
  const removePeriod = (pId: string) => mutateSheet(sheet.id, (s) => ({ ...s, periods: s.periods.filter((p) => p.id !== pId) }));

  // ----- Formula rows + member hierarchy (roll-up / drill-down) -----
  const addFormulaRow = () => {
    const fid = newId('li');
    mutateSheet(sheet.id, (s) => ({ ...s, lineItems: [...s.lineItems, { id: fid, name: 'New formula', kind: 'formula', formula: [] }] }));
    setFormulaEdit(fid); // open the builder immediately
  };
  const setLineItemFormula = (liId: string, formula: PlanFormulaToken[]) =>
    mutateSheet(sheet.id, (s) => ({ ...s, lineItems: s.lineItems.map((li) => (li.id === liId ? { ...li, kind: 'formula', formula } : li)) }));
  // Indent a row under the nearest preceding sibling (same depth) → makes a hierarchy.
  const indentRow = (liId: string) => mutateSheet(sheet.id, (s) => {
    const ordered = orderedLineItems(s.lineItems);
    const idx = ordered.findIndex((o) => o.item.id === liId);
    if (idx <= 0) return s;
    const me = ordered[idx];
    for (let i = idx - 1; i >= 0; i--) {
      if (ordered[i].depth === me.depth) {
        return { ...s, lineItems: s.lineItems.map((li) => (li.id === liId ? { ...li, parentId: ordered[i].item.id } : li)) };
      }
      if (ordered[i].depth < me.depth) break;
    }
    return s;
  });
  const outdentRow = (liId: string) => mutateSheet(sheet.id, (s) => {
    const me = s.lineItems.find((li) => li.id === liId);
    if (!me?.parentId) return s;
    const grand = s.lineItems.find((li) => li.id === me.parentId)?.parentId ?? null;
    return { ...s, lineItems: s.lineItems.map((li) => (li.id === liId ? { ...li, parentId: grand } : li)) };
  });
  // Apply a quick formula directly to a row (no dialog) — converts it to formula.
  const applyQuickFormula = (liId: string, tokens: PlanFormulaToken[]) => {
    setLineItemFormula(liId, tokens);
    setMsg({ intent: 'success', text: 'Quick formula applied. Open the formula to refine it.' });
  };
  // Flag/unflag a row as a driver (planning assumption formulas reference).
  const toggleDriver = (liId: string) =>
    mutateSheet(sheet.id, (s) => ({ ...s, lineItems: s.lineItems.map((li) => (li.id === liId ? { ...li, driver: !li.driver } : li)) }));
  // Direct children of a parent row — the spread/breakback allocation targets.
  const directChildren = (parentId: string) => sheet.lineItems.filter((li) => li.parentId === parentId);
  // Write an allocation result (one value per direct child) into a period's cells.
  const writeChildCells = (parentId: string, periodId: string, values: number[]) => {
    const kids = sheet.lineItems.filter((li) => li.parentId === parentId);
    mutateSheet(sheet.id, (s) => {
      const next = { ...s.cells };
      kids.forEach((k, i) => { next[cellKey(k.id, periodId, activeScenarioId)] = values[i] ?? 0; });
      return { ...s, cells: next };
    });
    setMsg({ intent: 'success', text: `Distributed to ${kids.length} child row${kids.length === 1 ? '' : 's'}.` });
  };

  const addSheet = () => {
    const ns = { ...defaultPlanningSheet(), id: newId('sheet'), name: `Sheet ${sheets.length + 1}`, cells: {}, actuals: {} };
    setState((prev) => ({ ...prev, sheets: [...ensureSheets(prev), ns], scenarios: ensureScenarios(prev), activeSheetId: ns.id, activeScenarioId }));
  };
  const setActiveSheet = (sid: string) => setState((prev) => ({ ...prev, sheets: ensureSheets(prev), scenarios: ensureScenarios(prev), activeSheetId: sid, activeScenarioId }));
  const setActiveScenario = (scid: string) => setState((prev) => ({ ...prev, sheets: ensureSheets(prev), scenarios: ensureScenarios(prev), activeSheetId, activeScenarioId: scid }));

  // Branch the active scenario into a new custom scenario, cloning every sheet's
  // cells so the new branch starts from the source's assumptions.
  const branchScenario = () => {
    const nid = newId('sc');
    setState((prev) => {
      const sc = ensureScenarios(prev);
      const src = sc.find((x) => x.id === activeScenarioId) || sc[0];
      const nextScenarios = [...sc, { id: nid, name: `${src.name} (copy)`, kind: 'custom' as PlanScenarioKind }];
      const nextSheets = ensureSheets(prev).map((s) => ({ ...s, cells: cloneScenarioCells(s.cells, activeScenarioId, nid) }));
      return { ...prev, scenarios: nextScenarios, sheets: nextSheets, activeSheetId, activeScenarioId: nid };
    });
  };
  const removeScenario = (scid: string) => {
    if (scenarios.length <= 1) { setMsg({ intent: 'warning', text: 'A plan needs at least one scenario.' }); return; }
    setState((prev) => {
      const sc = ensureScenarios(prev).filter((x) => x.id !== scid);
      const nextSheets = ensureSheets(prev).map((s) => ({ ...s, cells: dropScenarioCells(s.cells, scid) }));
      return { ...prev, scenarios: sc, sheets: nextSheets, activeSheetId, activeScenarioId: sc[0].id };
    });
  };
  const renameScenario = (scid: string, name: string) =>
    setState((prev) => ({ ...prev, scenarios: ensureScenarios(prev).map((x) => (x.id === scid ? { ...x, name } : x)), sheets: ensureSheets(prev), activeSheetId, activeScenarioId }));

  // Writeback the active sheet's cells (all scenarios) into Azure SQL.
  const writeback = async () => {
    if (!id || id === 'new') { setMsg({ intent: 'warning', text: 'Save the plan first.' }); return; }
    // Only leaf-input cells are persisted — roll-up parents + formula rows are
    // computed, never stored (so a row converted to a parent/formula can't push
    // stale numbers). Mirrors flattenPlanCells / the SQL round-trip.
    const leafIds = new Set(leafInputItems(sheet.lineItems).map((li) => li.id));
    const cells = Object.entries(sheet.cells)
      .map(([k, value]) => {
        const [lineItemId, periodId, scenarioId] = k.split('|');
        return { lineItemId, periodId, scenarioId, value };
      })
      .filter((c) => leafIds.has(c.lineItemId));
    if (cells.length === 0) { setMsg({ intent: 'warning', text: 'No cells to write back yet.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await save(); // persist to Cosmos first (the always-works default)
      const r = await clientFetch(`/api/items/plan/${encodeURIComponent(id)}/writeback`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sheetId: sheet.id, cells }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: j?.gate ? `Saved to Cosmos. SQL writeback skipped: set ${j.gate.missing}. ${j.gate.remediation}` : (j?.error || `HTTP ${r.status}`) });
        return;
      }
      setMsg({ intent: 'success', text: j.message || `${j.written} cells written to Azure SQL.` });
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(false); }
  };

  const variance = computeVariance(sheet, activeScenarioId, sheet.actuals || {});
  // Hierarchy-ordered rows (parents before children). A row is hidden when any
  // ancestor is collapsed (drill-down). Roll-up parents + formula rows render
  // read-only computed values; only leaf inputs are editable.
  const ordered = orderedLineItems(sheet.lineItems);
  const byId = new Map(sheet.lineItems.map((li) => [li.id, li]));
  const isHidden = (li: PlanLineItem) => {
    let pid = li.parentId;
    while (pid) { if (collapsed.has(pid)) return true; pid = byId.get(pid)?.parentId ?? null; }
    return false;
  };
  const visibleRows = ordered.filter((o) => !isHidden(o.item));
  // Candidate rows a formula can reference (every row in the sheet except itself).
  // Drivers sort first and carry a "(driver)" hint so assumptions are easy to pick.
  const formulaCandidates = [...sheet.lineItems]
    .map((li) => ({ id: li.id, name: li.driver ? `${li.name} (driver)` : li.name, driver: !!li.driver }))
    .sort((a, b) => (a.driver === b.driver ? 0 : a.driver ? -1 : 1));
  const editingFormulaItem = formulaEdit ? byId.get(formulaEdit) : undefined;
  const varColspan = sheet.periods.length + (showVariance ? 6 : 3);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Planning sheet</MessageBarTitle>
          Build budgets / forecasts across periods, branch what-if scenarios, and compare plan vs actuals — the Azure-native
          parity of Microsoft Fabric Plan (preview). Cells persist to Cosmos; <strong>Write back</strong> MERGEs them into an
          Azure SQL store when one is configured (Settings). No Microsoft Fabric capacity required.
        </MessageBarBody>
      </MessageBar>

      {/* Toolbar: sheet · scenario · branch · variance · writeback · settings */}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Sheet">
          <Dropdown value={sheet.name} selectedOptions={[sheet.id]} onOptionSelect={(_, d) => setActiveSheet(d.optionValue || sheet.id)} style={{ minWidth: 180 }}>
            {sheets.map((s) => <Option key={s.id} value={s.id}>{s.name}</Option>)}
          </Dropdown>
        </Field>
        <Button icon={<Add20Regular />} onClick={addSheet}>New sheet</Button>
        <Field label="Scenario">
          <Dropdown value={scenario.name} selectedOptions={[scenario.id]} onOptionSelect={(_, d) => setActiveScenario(d.optionValue || scenario.id)} style={{ minWidth: 180 }}>
            {scenarios.map((sc) => <Option key={sc.id} value={sc.id} text={sc.name}>{sc.name} · {sc.kind}</Option>)}
          </Dropdown>
        </Field>
        <Button icon={<BranchFork20Regular />} onClick={branchScenario}>Branch scenario</Button>
        <Switch label="Variance vs actuals" checked={showVariance} onChange={(_, d) => setShowVariance(d.checked)} />
        <div style={{ flex: 1 }} />
        <Button icon={<Calculator20Regular />} onClick={addFormulaRow}>Add formula row</Button>
        <Button icon={busy ? <Spinner size="tiny" /> : <ArrowUpload16Regular />} onClick={writeback} disabled={busy}>Write back</Button>
        <Button icon={<Settings20Regular />} onClick={() => setSettingsOpen(true)}>Settings</Button>
      </div>

      {/* Scenario rename / delete row */}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge appearance="filled" color="brand">{scenario.kind}</Badge>
        <Input value={scenario.name} onChange={(_, d) => renameScenario(scenario.id, d.value)} style={{ maxWidth: 220 }} aria-label="Scenario name" />
        {scenarios.length > 1 && <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => removeScenario(scenario.id)}>Delete scenario</Button>}
        <Caption1 style={{ color: tokens.colorNeutralForeground3, marginLeft: 'auto' }}>
          Scenario total: <strong>{fmtNum(grandTotal(sheet, activeScenarioId))}</strong>
        </Caption1>
      </div>

      {/* Planning grid */}
      <Card style={{ padding: tokens.spacingVerticalNone, overflowX: 'auto' }}>
        <Table aria-label="Planning sheet grid" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ minWidth: 200 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}><Money20Regular /> Line item</span>
              </TableHeaderCell>
              {sheet.periods.map((p) => (
                <TableHeaderCell key={p.id} style={{ minWidth: 90 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS }}>
                    <Input size="small" value={p.label} onChange={(_, d) => renamePeriod(p.id, d.value)} style={{ maxWidth: 70 }} aria-label="Period label" />
                    {sheet.periods.length > 1 && <Button size="small" appearance="transparent" icon={<Dismiss16Regular />} onClick={() => removePeriod(p.id)} aria-label="Remove period" />}
                  </span>
                </TableHeaderCell>
              ))}
              <TableHeaderCell style={{ minWidth: 90 }}>Total</TableHeaderCell>
              {showVariance && <TableHeaderCell style={{ minWidth: 100 }}>Actual</TableHeaderCell>}
              {showVariance && <TableHeaderCell style={{ minWidth: 80 }}>Δ</TableHeaderCell>}
              {showVariance && <TableHeaderCell style={{ minWidth: 70 }}>Δ%</TableHeaderCell>}
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.length === 0 && (
              <TableRow>
                <TableCell colSpan={varColspan}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalL, color: tokens.colorNeutralForeground3 }}>
                    <Money20Regular />
                    <Body1>No line items yet</Body1>
                    <Caption1>Add a line item to start building this plan&apos;s budget across periods.</Caption1>
                    <Button size="small" icon={<Add20Regular />} onClick={addLineItem} style={{ marginTop: tokens.spacingVerticalXS }}>Add line item</Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {visibleRows.map(({ item: li, depth, hasChildren }) => {
              const v = variance.find((x) => x.lineItemId === li.id);
              const isFormula = li.kind === 'formula';
              const isRollup = hasChildren; // any row with children = read-only roll-up
              const computed = isFormula || isRollup;
              const formulaText = isFormula && Array.isArray(li.formula) && li.formula.length
                ? formulaToText(li.formula, (ref) => byId.get(ref)?.name || ref) : '';
              return (
                <TableRow key={li.id}>
                  <TableCell>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, minWidth: 0 }}>
                      {Array.from({ length: depth }).map((_, i) => <span key={i} style={{ width: tokens.spacingHorizontalL, flexShrink: 0 }} />)}
                      {hasChildren ? (
                        <Button size="small" appearance="transparent" aria-label={collapsed.has(li.id) ? 'Expand' : 'Collapse'}
                          icon={collapsed.has(li.id) ? <ChevronRight16Regular /> : <ChevronDown16Regular />} onClick={() => toggleCollapse(li.id)} />
                      ) : isFormula ? (
                        <Calculator20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
                      ) : li.driver ? (
                        <Flash20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
                      ) : <span style={{ width: tokens.spacingHorizontalL, flexShrink: 0 }} />}
                      <Input value={li.name} onChange={(_, d) => renameLineItem(li.id, d.value)} aria-label="Line item name" style={{ minWidth: 0, fontWeight: isRollup ? tokens.fontWeightSemibold : undefined } as any} />
                      {li.driver && <Badge appearance="tint" color="brand" style={{ flexShrink: 0 }}>Driver</Badge>}
                    </span>
                    {formulaText && <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, fontFamily: 'monospace', marginLeft: tokens.spacingHorizontalL }}>= {formulaText}</Caption1>}
                  </TableCell>
                  {sheet.periods.map((p, pIdx) => {
                    const canAllocate = isRollup && directChildren(li.id).length > 0;
                    return (
                    <TableCell key={p.id}>
                      {computed ? (
                        canAllocate ? (
                          <Menu openOnContext>
                            <MenuTrigger disableButtonEnhancement>
                              <span
                                role="button"
                                tabIndex={0}
                                title="Right-click to spread this total down to children"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, minWidth: 60, color: tokens.colorNeutralForeground2, cursor: 'context-menu' }}
                              >
                                {fmtNum(lineItemValueAt(sheet, activeScenarioId, li.id, pIdx))}
                                <Button
                                  size="small"
                                  appearance="transparent"
                                  icon={<Edit16Regular />}
                                  aria-label={`Breakback ${li.name} ${p.label}`}
                                  title="Edit total — push the change back to children (breakback)"
                                  onClick={(e) => { e.stopPropagation(); setBreakbackCtx({ parentId: li.id, periodId: p.id }); }}
                                />
                              </span>
                            </MenuTrigger>
                            <MenuPopover>
                              <MenuList>
                                <MenuItem icon={<ArrowSplit20Regular />} onClick={() => setSpreadCtx({ parentId: li.id, periodId: p.id, mode: 'evenly' })}>Spread evenly</MenuItem>
                                <MenuItem icon={<DataTrending20Regular />} onClick={() => setSpreadCtx({ parentId: li.id, periodId: p.id, mode: 'growth' })}>Spread by growth %</MenuItem>
                                <MenuItem icon={<Layer20Regular />} onClick={() => setSpreadCtx({ parentId: li.id, periodId: p.id, mode: 'weight' })}>Spread by weight</MenuItem>
                                <MenuDivider />
                                <MenuItem icon={<Edit16Regular />} onClick={() => setBreakbackCtx({ parentId: li.id, periodId: p.id })}>Breakback (edit total)…</MenuItem>
                              </MenuList>
                            </MenuPopover>
                          </Menu>
                        ) : (
                          <span style={{ display: 'inline-block', minWidth: 60, color: tokens.colorNeutralForeground2 }}>
                            {fmtNum(lineItemValueAt(sheet, activeScenarioId, li.id, pIdx))}
                          </span>
                        )
                      ) : (
                        <Input
                          type="number"
                          value={String(getCell(sheet.cells, li.id, p.id, activeScenarioId) || '')}
                          onChange={(_, d) => setCell(li.id, p.id, d.value)}
                          style={{ maxWidth: 80 }}
                          aria-label={`${li.name} ${p.label}`}
                        />
                      )}
                    </TableCell>
                    );
                  })}
                  <TableCell><strong>{fmtNum(computed ? lineItemRowTotal(sheet, activeScenarioId, li.id) : rowTotal(sheet, activeScenarioId, li.id))}</strong></TableCell>
                  {showVariance && (
                    <TableCell>
                      {computed ? <span style={{ color: tokens.colorNeutralForeground4 }}>—</span> : (
                        <Input type="number" value={String((sheet.actuals || {})[li.id] || '')} onChange={(_, d) => setActual(li.id, d.value)} style={{ maxWidth: 90 }} aria-label={`Actual ${li.name}`} />
                      )}
                    </TableCell>
                  )}
                  {showVariance && (
                    <TableCell style={{ color: computed ? undefined : ((v?.delta || 0) < 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1) }}>
                      {computed ? '—' : fmtNum(v?.delta || 0)}
                    </TableCell>
                  )}
                  {showVariance && (
                    <TableCell>{computed || v?.pct == null ? '—' : `${Math.round(v.pct * 100)}%`}</TableCell>
                  )}
                  <TableCell>
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <Button size="small" appearance="subtle" aria-label="Row actions" icon={<ChevronDown16Regular />} />
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          {isFormula && <MenuItem icon={<Edit16Regular />} onClick={() => setFormulaEdit(li.id)}>Edit formula…</MenuItem>}
                          {!isFormula && !isRollup && (
                            <Menu>
                              <MenuTrigger disableButtonEnhancement>
                                <MenuItem icon={<Calculator20Regular />}>Quick formula</MenuItem>
                              </MenuTrigger>
                              <MenuPopover>
                                <MenuList>
                                  <MenuItem onClick={() => setFormulaEdit(li.id)}>Open builder…</MenuItem>
                                  <MenuDivider />
                                  <MenuItem onClick={() => applyQuickFormula(li.id, qfGrowthPct(li.id, -1))}>Growth % vs previous</MenuItem>
                                  <MenuItem onClick={() => applyQuickFormula(li.id, qfGrowthPct(li.id, -4))}>Growth % vs year ago</MenuItem>
                                </MenuList>
                              </MenuPopover>
                            </Menu>
                          )}
                          <MenuItem icon={<ChevronRight16Regular />} onClick={() => indentRow(li.id)}>Indent (nest)</MenuItem>
                          <MenuItem icon={<ChevronLeft16Regular />} onClick={() => outdentRow(li.id)} disabled={!li.parentId}>Outdent</MenuItem>
                          {!isRollup && (
                            <MenuItem icon={<Flash20Regular />} onClick={() => toggleDriver(li.id)}>
                              {li.driver ? 'Unmark as driver' : 'Mark as driver'}
                            </MenuItem>
                          )}
                          <MenuDivider />
                          <MenuItem icon={<Dismiss16Regular />} onClick={() => removeLineItem(li.id)}>Delete row</MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  </TableCell>
                </TableRow>
              );
            })}
            {/* Period-total footer row */}
            <TableRow style={{ backgroundColor: tokens.colorNeutralBackground2 }}>
              <TableCell><strong>Total</strong></TableCell>
              {sheet.periods.map((p) => (
                <TableCell key={p.id}><strong>{fmtNum(periodTotal(sheet, activeScenarioId, p.id))}</strong></TableCell>
              ))}
              <TableCell><strong>{fmtNum(grandTotal(sheet, activeScenarioId))}</strong></TableCell>
              {showVariance && <TableCell><strong>{fmtNum(variance.reduce((a, x) => a + x.actual, 0))}</strong></TableCell>}
              {showVariance && <TableCell><strong>{fmtNum(variance.reduce((a, x) => a + x.delta, 0))}</strong></TableCell>}
              {showVariance && <TableCell />}
              <TableCell />
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
        <Button icon={<Add20Regular />} onClick={addLineItem}>Add line item</Button>
        <Button icon={<Calculator20Regular />} onClick={addFormulaRow}>Add formula row</Button>
        <Button icon={<Add20Regular />} onClick={addPeriod}>Add period</Button>
        <Button appearance="primary" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save plan'}</Button>
      </div>

      {(sheet.lineItems.some((li) => li.parentId) || sheet.lineItems.some((li) => li.kind === 'formula')) && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          <Layer20Regular style={{ verticalAlign: 'middle' }} /> Roll-up parents and formula rows are computed (read-only); only leaf inputs hold entered values. Right-click a roll-up cell to spread its total down to children.
        </Caption1>
      )}

      {driverRows(sheet.lineItems).length > 0 && (() => {
        const { order, cycle } = topoOrderLineItems(sheet);
        const formulaOrder = order.map((oid) => byId.get(oid)).filter((li) => li?.kind === 'formula');
        return (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            <Flash20Regular style={{ verticalAlign: 'middle', color: tokens.colorBrandForeground1 }} /> Drivers: <strong>{driverRows(sheet.lineItems).map((d) => d.name).join(', ')}</strong>
            {formulaOrder.length > 0 && <> — formulas recompute in dependency order: {formulaOrder.map((li) => li!.name).join(' → ')}.</>}
            {cycle && <span style={{ color: tokens.colorPaletteRedForeground1 }}> (reference cycle detected — fix a formula.)</span>}
          </Caption1>
        );
      })()}

      {state.semanticModelRef && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          <Link20Regular style={{ verticalAlign: 'middle' }} /> Actuals source: <strong>{state.semanticModelRef.displayName}</strong> (semantic model)
        </Caption1>
      )}

      {msg && (
        <MessageBar intent={msg.intent}>
          <MessageBarBody>{msg.text}</MessageBarBody>
        </MessageBar>
      )}

      <PlanSettingsFlyout id={id} state={state} setState={setState} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <FormulaBuilderDialog
        open={!!formulaEdit}
        onClose={() => setFormulaEdit(null)}
        initial={(editingFormulaItem?.formula as PlanFormulaToken[]) || []}
        rows={formulaCandidates.filter((r) => r.id !== formulaEdit)}
        onApply={(toks) => { if (formulaEdit) setLineItemFormula(formulaEdit, toks); }}
      />
      <SpreadDialog
        ctx={spreadCtx}
        sheet={sheet}
        scenarioId={activeScenarioId}
        childrenOf={directChildren}
        onClose={() => setSpreadCtx(null)}
        onApply={(vals) => { if (spreadCtx) writeChildCells(spreadCtx.parentId, spreadCtx.periodId, vals); }}
      />
      <BreakbackDialog
        ctx={breakbackCtx}
        sheet={sheet}
        scenarioId={activeScenarioId}
        childrenOf={directChildren}
        onClose={() => setBreakbackCtx(null)}
        onApply={(vals) => { if (breakbackCtx) writeChildCells(breakbackCtx.parentId, breakbackCtx.periodId, vals); }}
      />
    </div>
  );
}

/**
 * Spread (allocation) dialog — distribute a total for a roll-up parent cell down
 * to its direct child rows for one period, by mode (evenly / by growth % / by
 * weight). Pure math via spread(); live preview; writes leaf child cells on Apply.
 */
function SpreadDialog({
  ctx, sheet, scenarioId, childrenOf, onClose, onApply,
}: {
  ctx: { parentId: string; periodId: string; mode: SpreadMode } | null;
  sheet: PlanningSheet;
  scenarioId: string;
  childrenOf: (parentId: string) => PlanLineItem[];
  onClose: () => void;
  onApply: (values: number[]) => void;
}) {
  const open = !!ctx;
  const parent = ctx ? sheet.lineItems.find((li) => li.id === ctx.parentId) : undefined;
  const period = ctx ? sheet.periods.find((p) => p.id === ctx.periodId) : undefined;
  const periodIdx = ctx ? sheet.periods.findIndex((p) => p.id === ctx.periodId) : -1;
  const kids = ctx ? childrenOf(ctx.parentId) : [];
  const currentTotal = ctx ? lineItemValueAt(sheet, scenarioId, ctx.parentId, periodIdx) : 0;
  const curVals = ctx ? kids.map((k) => getCell(sheet.cells, k.id, ctx.periodId, scenarioId)) : [];

  const [target, setTarget] = useState('');
  const [growth, setGrowth] = useState('10');
  useEffect(() => {
    if (open) { setTarget(String(currentTotal || '')); setGrowth('10'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const targetNum = target === '' ? 0 : Number(target);
  const growthPct = Number(growth) / 100;
  const preview = ctx && Number.isFinite(targetNum)
    ? spread(targetNum, curVals, ctx.mode, { growthPct: Number.isFinite(growthPct) ? growthPct : 0 })
    : [];
  const modeLabel = { evenly: 'evenly', growth: 'by growth %', weight: 'by weight' }[ctx?.mode || 'evenly'];

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 540 }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <ArrowSplit20Regular style={{ color: tokens.colorBrandForeground1 }} /> Spread {modeLabel}
            </span>
          </DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Distribute a total for <strong>{parent?.name}</strong> · <strong>{period?.label}</strong> down to its {kids.length} child row{kids.length === 1 ? '' : 's'}. Only leaf children hold entered values.
              </Caption1>
              <Field label="Total to spread">
                <Input type="number" value={target} onChange={(_, d) => setTarget(d.value)} contentBefore={<Money20Regular />} />
              </Field>
              {ctx?.mode === 'growth' && (
                <Field label="Growth per period (%)" hint="Each successive child grows by this percentage.">
                  <Input type="number" value={growth} onChange={(_, d) => setGrowth(d.value)} contentAfter="%" />
                </Field>
              )}
              {kids.length === 0 ? (
                <MessageBar intent="warning"><MessageBarBody>This row has no child rows. Indent rows beneath it first (row menu → Indent).</MessageBarBody></MessageBar>
              ) : (
                <Table size="small" aria-label="Spread preview">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Child row</TableHeaderCell>
                    <TableHeaderCell>Current</TableHeaderCell>
                    <TableHeaderCell>After</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {kids.map((k, i) => (
                      <TableRow key={k.id}>
                        <TableCell>{k.name}</TableCell>
                        <TableCell>{fmtNum(curVals[i])}</TableCell>
                        <TableCell><strong>{fmtNum(preview[i] || 0)}</strong></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={kids.length === 0 || !Number.isFinite(targetNum)} onClick={() => { onApply(preview); onClose(); }}>Apply spread</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Breakback dialog — edit a roll-up parent's total for one period and push the
 * delta proportionally back to its children. Pure math via breakback(); live
 * preview shows the current → after per child; writes leaf child cells on Apply.
 */
function BreakbackDialog({
  ctx, sheet, scenarioId, childrenOf, onClose, onApply,
}: {
  ctx: { parentId: string; periodId: string } | null;
  sheet: PlanningSheet;
  scenarioId: string;
  childrenOf: (parentId: string) => PlanLineItem[];
  onClose: () => void;
  onApply: (values: number[]) => void;
}) {
  const open = !!ctx;
  const parent = ctx ? sheet.lineItems.find((li) => li.id === ctx.parentId) : undefined;
  const period = ctx ? sheet.periods.find((p) => p.id === ctx.periodId) : undefined;
  const periodIdx = ctx ? sheet.periods.findIndex((p) => p.id === ctx.periodId) : -1;
  const kids = ctx ? childrenOf(ctx.parentId) : [];
  const currentTotal = ctx ? lineItemValueAt(sheet, scenarioId, ctx.parentId, periodIdx) : 0;
  const curVals = ctx ? kids.map((k) => getCell(sheet.cells, k.id, ctx.periodId, scenarioId)) : [];

  const [target, setTarget] = useState('');
  useEffect(() => {
    if (open) setTarget(String(currentTotal || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const targetNum = target === '' ? 0 : Number(target);
  const preview = ctx && Number.isFinite(targetNum) ? breakback(curVals, targetNum) : [];
  const delta = targetNum - currentTotal;

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 540 }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Edit16Regular style={{ color: tokens.colorBrandForeground1 }} /> Breakback — edit total
            </span>
          </DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Set a new total for <strong>{parent?.name}</strong> · <strong>{period?.label}</strong>. The change ({fmtNum(delta)}) is pushed to its {kids.length} child row{kids.length === 1 ? '' : 's'} in proportion to their current share.
              </Caption1>
              <Field label="New total">
                <Input type="number" value={target} onChange={(_, d) => setTarget(d.value)} contentBefore={<Money20Regular />} />
              </Field>
              {kids.length === 0 ? (
                <MessageBar intent="warning"><MessageBarBody>This row has no child rows to break back into.</MessageBarBody></MessageBar>
              ) : (
                <Table size="small" aria-label="Breakback preview">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Child row</TableHeaderCell>
                    <TableHeaderCell>Current</TableHeaderCell>
                    <TableHeaderCell>After</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {kids.map((k, i) => (
                      <TableRow key={k.id}>
                        <TableCell>{k.name}</TableCell>
                        <TableCell>{fmtNum(curVals[i])}</TableCell>
                        <TableCell><strong>{fmtNum(preview[i] || 0)}</strong></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={kids.length === 0 || !Number.isFinite(targetNum)} onClick={() => { onApply(preview); onClose(); }}>Apply breakback</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Inline multi-point SVG line chart for the Intelligence trend/forecast visual.
 * Pure SVG (no chart dep) over the REAL period-subtotal series; forecast points
 * render dashed. Azure-native — computed from plan cells, no Fabric.
 */
function PlanTrendChart({ points, height = 200 }: { points: PeriodPoint[]; height?: number }) {
  const width = 560;
  const padL = 48, padR = 16, padT = 16, padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const vals = points.map((p) => p.value);
  const max = Math.max(1, ...vals);
  const min = Math.min(0, ...vals);
  const span = Math.max(1, max - min);
  const x = (i: number) => padL + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - ((v - min) / span) * innerH;
  const histPts = points.filter((p) => !p.forecast);
  const linePath = (subset: PeriodPoint[]) =>
    subset.map((p) => `${x(points.indexOf(p))},${y(p.value)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Plan trend chart" style={{ maxWidth: width }}>
      {/* gridlines + axis labels */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const gy = padT + innerH - f * innerH;
        return (
          <g key={f}>
            <line x1={padL} y1={gy} x2={width - padR} y2={gy} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
            <text x={padL - 6} y={gy + 3} textAnchor="end" fontSize={10} fill={tokens.colorNeutralForeground3}>
              {Math.round(min + f * span).toLocaleString()}
            </text>
          </g>
        );
      })}
      {/* historical line */}
      <polyline points={linePath(histPts)} fill="none" stroke={tokens.colorBrandStroke1} strokeWidth={2.5} />
      {/* forecast line (dashed) — joins last historical point onward */}
      {points.some((p) => p.forecast) && (
        <polyline
          points={linePath([histPts[histPts.length - 1], ...points.filter((p) => p.forecast)].filter(Boolean) as PeriodPoint[])}
          fill="none" stroke={tokens.colorPalettePurpleForeground2} strokeWidth={2.5} strokeDasharray="5 4"
        />
      )}
      {/* points + x labels */}
      {points.map((p, i) => (
        <g key={p.periodId}>
          <circle cx={x(i)} cy={y(p.value)} r={3.5} fill={p.forecast ? tokens.colorPalettePurpleForeground2 : tokens.colorBrandForeground1} />
          <text x={x(i)} y={height - 10} textAnchor="middle" fontSize={10} fill={tokens.colorNeutralForeground3}>{p.label}</text>
        </g>
      ))}
    </svg>
  );
}

/** Mutate a single planning cell in the correct sheet (PowerTable two-way edit). */
function setPlanCellByKey(
  setState: (updater: (prev: PlanState) => PlanState) => void,
  sheetId: string, key: string, value: number,
) {
  setState((prev) => ({
    ...prev,
    sheets: ensureSheets(prev).map((sh) => (sh.id === sheetId ? { ...sh, cells: { ...sh.cells, [key]: value } } : sh)),
    scenarios: ensureScenarios(prev),
  }));
}

/**
 * PowerTable — the Azure-native parity of Fabric Plan's no-code, SQL-bound grid
 * (/fabric/iq/plan/powertable-overview). Flattens every plan cell into one
 * editable, sortable, filterable grid bound 1:1 to the `dbo.loom_plan_cells`
 * columns. Two-way writeback: edits persist to Cosmos (always) and MERGE into
 * Azure SQL (when configured). "Load from SQL" reads the persisted rows back.
 */
function PlanPowerTablePanel({
  id, state, setState, save, saving,
}: {
  id: string;
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  save: (next?: PlanState) => Promise<boolean>;
  saving: boolean;
}) {
  const s = useStyles();
  const sheets = ensureSheets(state);
  const scenarios = ensureScenarios(state);
  const rows = useMemo(() => flattenPlanCells(sheets, scenarios), [sheets, scenarios]);

  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<PlanRowSortKey>('lineItem');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  // Persisted SQL rows (read-back) keyed by composite key for a "drift" badge.
  const [sqlByKey, setSqlByKey] = useState<Record<string, number> | null>(null);

  const view = useMemo(() => sortPlanRows(filterPlanRows(rows, query), sortKey, sortDir), [rows, query, sortKey, sortDir]);

  const toggleSort = (k: PlanRowSortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
  };
  const SortIcon = ({ k }: { k: PlanRowSortKey }) =>
    k !== sortKey ? null : sortDir === 'asc' ? <ArrowSortUp16Regular /> : <ArrowSortDown16Regular />;

  const editCell = (row: PlanCellRow, raw: string) => {
    const v = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(v)) return;
    setPlanCellByKey(setState, row.sheetId, row.key, v);
  };

  // Two-way writeback: persist to Cosmos, then MERGE the visible sheet's cells
  // into Azure SQL via the real writeback route.
  const writeBackAll = async () => {
    if (!id || id === 'new') { setMsg({ intent: 'warning', text: 'Save the plan first.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await save();
      // Group cells by sheet and POST each (the route is per-sheet).
      let total = 0; let gated: string | null = null;
      for (const sheet of sheets) {
        const cells = Object.entries(sheet.cells).map(([k, value]) => {
          const [lineItemId, periodId, scenarioId] = k.split('|');
          return { lineItemId, periodId, scenarioId, value };
        });
        if (cells.length === 0) continue;
        const r = await clientFetch(`/api/items/plan/${encodeURIComponent(id)}/writeback`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sheetId: sheet.id, cells }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 503 && j?.gate) { gated = `${j.gate.reason} Set ${j.gate.missing}.`; break; }
        if (!r.ok) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); setBusy(false); return; }
        total += Number(j.written || 0);
      }
      if (gated) setMsg({ intent: 'warning', text: `Saved to Cosmos. Azure SQL writeback skipped: ${gated}` });
      else setMsg({ intent: 'success', text: `${total} cell${total === 1 ? '' : 's'} written back to Azure SQL.` });
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(false); }
  };

  const loadFromSql = async () => {
    if (!id || id === 'new') { setMsg({ intent: 'warning', text: 'Save the plan first.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/plan/${encodeURIComponent(id)}/writeback`);
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.gate) { setMsg({ intent: 'warning', text: `${j.gate.reason} Set ${j.gate.missing}. PowerTable is bound to the in-editor (Cosmos) cells.` }); return; }
      if (!r.ok || !j?.ok) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      const map: Record<string, number> = {};
      for (const c of j.cells || []) map[cellKey(c.lineItemId, c.periodId, c.scenarioId)] = Number(c.value);
      setSqlByKey(map);
      setMsg({ intent: 'success', text: `Loaded ${j.count} persisted row${j.count === 1 ? '' : 's'} from ${j.database}. Cells differing from the editor are flagged.` });
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBusy(false); }
  };

  const colName: Record<PlanRowSortKey, string> = { sheetName: 'Sheet', lineItem: 'Line item', period: 'Period', scenario: 'Scenario', value: 'Value' };

  return (
    <div className={s.planSection}>
      <div className={s.planSectionHead}>
        <span className={s.planSectionIcon}><Table20Regular /></span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Subtitle2>PowerTable</Subtitle2>
          <Caption1 as="p" block style={{ color: tokens.colorNeutralForeground3 }}>
            No-code, SQL-bound grid over every plan cell with two-way writeback — the Azure-native parity of Fabric Plan&apos;s PowerTable. Edit any value inline; it persists to Cosmos and MERGEs into <code>dbo.loom_plan_cells</code> on write back.
          </Caption1>
        </div>
        <Badge appearance="tint" color="brand">{rows.length} cell{rows.length === 1 ? '' : 's'}</Badge>
      </div>

      <div className={s.planToolbar}>
        <Field label="Filter rows" style={{ minWidth: 220, flex: '1 1 220px' }}>
          <Input value={query} onChange={(_, d) => setQuery(d.value)} placeholder="line item, period, scenario, value…" contentBefore={<ArrowDownload16Regular style={{ visibility: 'hidden', width: 0 }} />} />
        </Field>
        <Button icon={busy ? <Spinner size="tiny" /> : <Save16Regular />} onClick={writeBackAll} disabled={busy || saving}>Write back to SQL</Button>
        <Button icon={busy ? <Spinner size="tiny" /> : <ArrowDownload16Regular />} onClick={loadFromSql} disabled={busy}>Load from SQL</Button>
        <Button appearance="primary" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>

      {rows.length === 0 ? (
        <div className={s.planEmpty}>
          <Table20Regular fontSize={28} />
          <Body1>No plan cells yet. Add line items and periods on the <strong>Planning</strong> sheet, then enter values — they appear here as an editable grid.</Body1>
        </div>
      ) : (
        <div className={s.planGridScroll}>
          <Table size="small" aria-label="PowerTable cell grid">
            <TableHeader>
              <TableRow>
                {(['sheetName', 'lineItem', 'period', 'scenario', 'value'] as PlanRowSortKey[]).map((k) => (
                  <TableHeaderCell key={k} className={s.planSortable} onClick={() => toggleSort(k)}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>{colName[k]}<SortIcon k={k} /></span>
                  </TableHeaderCell>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.map((row) => {
                const drift = sqlByKey && Object.prototype.hasOwnProperty.call(sqlByKey, row.key) && sqlByKey[row.key] !== row.value;
                return (
                  <TableRow key={row.key}>
                    <TableCell>{row.sheetName}</TableCell>
                    <TableCell>{row.lineItem}</TableCell>
                    <TableCell>{row.period}</TableCell>
                    <TableCell><Badge appearance="outline">{row.scenario}</Badge></TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge }}>
                        <Input type="number" value={String(row.value || '')} onChange={(_, d) => editCell(row, d.value)} style={{ maxWidth: 110 }} aria-label={`${row.lineItem} ${row.period} ${row.scenario}`} />
                        {drift && <Badge appearance="tint" color="warning" title={`Azure SQL has ${sqlByKey![row.key]}`}>SQL {fmtNum(sqlByKey![row.key])}</Badge>}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

/**
 * Intelligence — Fabric Plan's auto-insights surface (variance reports, trend +
 * forecast, Gantt). Azure-native parity: every visual is computed from the real
 * plan cells / tasks (no Fabric, no mock). Forecast is an OLS extrapolation of
 * the period-subtotal trend; Gantt lays out the Project tasks by due date.
 */
function PlanIntelligencePanel({
  state, setState, scenarioName, activeScenarioId, sheet, tasks,
}: {
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  scenarioName: string;
  activeScenarioId: string;
  sheet: PlanningSheet;
  tasks: PlanTask[];
}) {
  const s = useStyles();
  const horizon = typeof state.forecastHorizon === 'number' ? state.forecastHorizon : 2;
  const series = useMemo(() => forecastPeriods(sheet, activeScenarioId, horizon), [sheet, activeScenarioId, horizon]);
  const hist = useMemo(() => periodSeries(sheet, activeScenarioId), [sheet, activeScenarioId]);
  const fit = useMemo(() => linearFit(hist.map((p) => p.value)), [hist]);
  const variance = useMemo(() => computeVariance(sheet, activeScenarioId, sheet.actuals || {}), [sheet, activeScenarioId]);
  const insights = useMemo(() => planInsights(sheet, activeScenarioId, variance), [sheet, activeScenarioId, variance]);
  const bars: GanttBar[] = useMemo(() => ganttLayout(tasks), [tasks]);

  const total = grandTotal(sheet, activeScenarioId);
  const forecastTotal = series.filter((p) => p.forecast).reduce((a, p) => a + p.value, 0);
  const trendLabel = fit.slope > 0 ? 'Upward' : fit.slope < 0 ? 'Downward' : 'Flat';
  const varianceWithActuals = variance.filter((v) => v.actual !== 0);
  const totalDelta = varianceWithActuals.reduce((a, v) => a + v.delta, 0);

  const barColor = (st: PlanTask['status'], overdue: boolean) =>
    overdue ? tokens.colorPaletteRedBackground3
      : st === 'done' ? tokens.colorPaletteGreenBackground3
        : st === 'doing' ? tokens.colorBrandBackground
          : tokens.colorNeutralForeground3;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
      {/* KPI strip */}
      <div className={s.planKpiRow}>
        <div className={s.planKpi}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Scenario total ({scenarioName})</Caption1>
          <span className={s.planKpiValue}>{fmtNum(total)}</span>
        </div>
        <div className={s.planKpi}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Trend (R² {fit.r2.toFixed(2)})</Caption1>
          <span className={s.planKpiValue} style={{ color: fit.slope < 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1 }}>{trendLabel}</span>
        </div>
        <div className={s.planKpi}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Forecast +{horizon} period{horizon === 1 ? '' : 's'}</Caption1>
          <span className={s.planKpiValue}>{fmtNum(forecastTotal)}</span>
        </div>
        <div className={s.planKpi}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Variance vs actuals</Caption1>
          <span className={s.planKpiValue} style={{ color: totalDelta < 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1 }}>{varianceWithActuals.length ? fmtNum(totalDelta) : '—'}</span>
        </div>
      </div>

      {/* Trend + forecast chart */}
      <div className={s.planSection}>
        <div className={s.planSectionHead}>
          <span className={s.planSectionIcon}><DataTrending20Regular /></span>
          <div style={{ flex: 1 }}>
            <Subtitle2>Trend &amp; forecast</Subtitle2>
            <Caption1 as="p" block style={{ color: tokens.colorNeutralForeground3 }}>
              Period subtotals for <strong>{scenarioName}</strong>; dashed line is an ordinary-least-squares projection.
            </Caption1>
          </div>
          <Field label="Forecast periods" orientation="horizontal">
            <Dropdown
              value={String(horizon)} selectedOptions={[String(horizon)]} style={{ minWidth: 80 }}
              onOptionSelect={(_, d) => { const h = Number(d.optionValue); if (Number.isFinite(h)) setState((p) => ({ ...p, forecastHorizon: h })); }}
            >
              {[0, 1, 2, 3, 4, 6].map((h) => <Option key={h} value={String(h)}>{String(h)}</Option>)}
            </Dropdown>
          </Field>
        </div>
        {hist.length === 0 ? (
          <div className={s.planEmpty}><Body1>No periods to chart yet — add periods + values on the Planning sheet.</Body1></div>
        ) : (
          <PlanTrendChart points={series} />
        )}
      </div>

      {/* Computed insights */}
      <div className={s.planSection}>
        <div className={s.planSectionHead}>
          <span className={s.planSectionIcon}><Sparkle20Regular /></span>
          <Subtitle2>Insights</Subtitle2>
          <Badge appearance="tint" color="informative">computed</Badge>
        </div>
        {insights.map((line, i) => (
          <div key={i} className={s.planInsight}>
            <ChartMultiple20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
            <Body1>{line}</Body1>
          </div>
        ))}
      </div>

      {/* Variance report */}
      <div className={s.planSection}>
        <div className={s.planSectionHead}>
          <span className={s.planSectionIcon}><Money20Regular /></span>
          <Subtitle2>Variance report</Subtitle2>
        </div>
        <Table size="small" aria-label="Variance report">
          <TableHeader><TableRow>
            <TableHeaderCell>Line item</TableHeaderCell>
            <TableHeaderCell>Plan</TableHeaderCell>
            <TableHeaderCell>Actual</TableHeaderCell>
            <TableHeaderCell>Δ</TableHeaderCell>
            <TableHeaderCell>Δ%</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {variance.length === 0 && <TableRow><TableCell>No input line items.</TableCell><TableCell /><TableCell /><TableCell /><TableCell /></TableRow>}
            {variance.map((v) => (
              <TableRow key={v.lineItemId}>
                <TableCell>{v.name}</TableCell>
                <TableCell>{fmtNum(v.plan)}</TableCell>
                <TableCell>{fmtNum(v.actual)}</TableCell>
                <TableCell style={{ color: v.delta < 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1 }}>{fmtNum(v.delta)}</TableCell>
                <TableCell>{v.pct == null ? '—' : `${Math.round(v.pct * 100)}%`}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Actuals come from the Planning sheet / InfoBridge mappings (Azure-native — no Fabric).</Caption1>
      </div>

      {/* Gantt over project tasks */}
      <div className={s.planSection}>
        <div className={s.planSectionHead}>
          <span className={s.planSectionIcon}><BranchFork20Regular /></span>
          <Subtitle2>Delivery Gantt</Subtitle2>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{tasks.length} task{tasks.length === 1 ? '' : 's'} · bars span dependency → due date</Caption1>
        </div>
        {bars.length === 0 ? (
          <div className={s.planEmpty}><Body1>No project tasks yet — add tasks (with due dates) on the <strong>Project tasks</strong> tab to populate the Gantt.</Body1></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
            {bars.map((b, i) => (
              <div key={i} className={s.ganttRow}>
                <Caption1 className={s.ganttLabel} title={b.title}>{b.title}</Caption1>
                <div className={s.ganttTrack}>
                  <div
                    className={s.ganttBar}
                    style={{ left: `${b.startPct * 100}%`, width: `${b.widthPct * 100}%`, backgroundColor: barColor(b.status, b.overdue) }}
                    title={`${b.status}${b.due ? ` · due ${b.due}` : ''}${b.overdue ? ' · overdue' : ''}${b.hasDep ? ' · has dependency' : ''}`}
                  />
                </div>
                <Caption1 style={{ width: 92, flexShrink: 0, color: b.overdue ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground3 }}>{b.due || '—'}</Caption1>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * InfoBridge — Fabric Plan's source-system integration/mapping surface. The
 * Azure-native parity: map each plan line item to a source field (a Loom
 * semantic-model measure, warehouse/lakehouse column, or a manual value), persist
 * the mappings to Cosmos, and "Push to actuals" so mapped values flow into the
 * Planning variance overlay. Live automated pull from the bound model is an
 * honest XMLA-gated extension. No Microsoft Fabric dependency.
 */
function PlanInfoBridgePanel({
  id, state, setState, save, saving,
}: {
  id: string;
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  save: (next?: PlanState) => Promise<boolean>;
  saving: boolean;
}) {
  const st = useStyles();
  const sheets = ensureSheets(state);
  const scenarios = ensureScenarios(state);
  const activeSheetId = sheets.some((x) => x.id === state.activeSheetId) ? (state.activeSheetId as string) : sheets[0].id;
  const sheet = sheets.find((x) => x.id === activeSheetId) || sheets[0];
  const inputItems = sheet.lineItems.filter((li) => li.kind === 'input');
  const mappings = arr<PlanSourceMapping>(state.infoBridge);

  // Real owned source items for the picker (warehouse / lakehouse / semantic-model).
  const [sources, setSources] = useState<Record<string, { id: string; name: string }[]>>({});
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const loadSources = useCallback(async () => {
    for (const type of ['warehouse', 'lakehouse', 'semantic-model']) {
      try {
        const r = await clientFetch(`/api/items/by-type?types=${encodeURIComponent(type)}`);
        const j = await r.json().catch(() => ({}));
        const items = (j.items || []).map((it: any) => ({ id: it.id, name: it.displayName || it.id }));
        setSources((prev) => ({ ...prev, [type]: items }));
      } catch { /* honest empty picker */ }
    }
  }, []);
  useEffect(() => { void loadSources(); }, [loadSources]);

  const mappingFor = (liId: string) => mappings.find((m) => m.lineItemId === liId);
  const upsertMapping = (liId: string, patch: Partial<PlanSourceMapping>) => {
    setState((prev) => {
      const cur = arr<PlanSourceMapping>(prev.infoBridge);
      const existing = cur.find((m) => m.lineItemId === liId);
      const next: PlanSourceMapping = existing
        ? { ...existing, ...patch }
        : { lineItemId: liId, sourceKind: 'manual', ...patch };
      return { ...prev, infoBridge: [...cur.filter((m) => m.lineItemId !== liId), next] };
    });
  };
  const clearMapping = (liId: string) =>
    setState((prev) => ({ ...prev, infoBridge: arr<PlanSourceMapping>(prev.infoBridge).filter((m) => m.lineItemId !== liId) }));

  // Close the loop: write mapped current-actuals into the active sheet's actuals
  // map (feeds the Planning variance overlay), then persist.
  const pushToActuals = async () => {
    if (mappings.length === 0) { setMsg({ intent: 'warning', text: 'Add at least one mapping first.' }); return; }
    let nextState: PlanState | null = null;
    setState((prev) => {
      const nextActuals = applyMappingsToActuals(sheet.actuals, arr<PlanSourceMapping>(prev.infoBridge));
      nextState = {
        ...prev,
        sheets: ensureSheets(prev).map((x) => (x.id === sheet.id ? { ...x, actuals: nextActuals } : x)),
        scenarios: ensureScenarios(prev),
      };
      return nextState;
    });
    if (nextState && id !== 'new') await save(nextState);
    const applied = mappings.filter((m) => typeof m.currentActual === 'number').length;
    setMsg({ intent: 'success', text: `Pushed ${applied} mapped value${applied === 1 ? '' : 's'} into ${sheet.name} actuals. Open the Planning tab → "Variance vs actuals" to see them.` });
  };

  const sourceKinds: PlanSourceMapping['sourceKind'][] = ['semantic-model', 'warehouse', 'lakehouse', 'manual'];
  const kindLabel: Record<PlanSourceMapping['sourceKind'], string> = {
    'semantic-model': 'Semantic model', warehouse: 'Warehouse', lakehouse: 'Lakehouse', manual: 'Manual',
  };

  return (
    <div className={st.planSection}>
      <div className={st.planSectionHead}>
        <span className={st.planSectionIcon}><Link20Regular /></span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Subtitle2>InfoBridge</Subtitle2>
          <Caption1 as="p" block style={{ color: tokens.colorNeutralForeground3 }}>
            Map each line item to a source system so planning stays aligned with actuals — the Azure-native parity of Fabric Plan&apos;s InfoBridge. Mappings persist to the plan; <strong>Push to actuals</strong> flows mapped values into the Planning variance overlay.
          </Caption1>
        </div>
        <Button appearance="primary" icon={<ArrowSync16Regular />} onClick={pushToActuals} disabled={saving}>Push to actuals</Button>
      </div>

      {state.semanticModelRef ? (
        <MessageBar intent="info">
          <MessageBarBody>
            Bound actuals model: <strong>{state.semanticModelRef.displayName}</strong>. Map a line item to a <em>Semantic model</em> measure here; automated live pull requires the model&apos;s XMLA endpoint (set <code>LOOM_AAS_XMLA_ENDPOINT</code> or use the manual value below). Mapped values feed the Planning variance overlay either way.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <MessageBar intent="warning">
          <MessageBarBody>
            No semantic model bound. Bind one in <strong>Settings</strong> (Planning tab) to map measures as actuals, or use <em>Manual</em> mappings — both feed variance.
          </MessageBarBody>
        </MessageBar>
      )}

      {inputItems.length === 0 ? (
        <div className={st.planEmpty}><Body1>No line items to map. Add input line items on the Planning sheet first.</Body1></div>
      ) : (
        <Table size="small" aria-label="InfoBridge source mappings">
          <TableHeader><TableRow>
            <TableHeaderCell>Line item</TableHeaderCell>
            <TableHeaderCell>Source kind</TableHeaderCell>
            <TableHeaderCell>Source item</TableHeaderCell>
            <TableHeaderCell>Field / measure</TableHeaderCell>
            <TableHeaderCell>Current actual</TableHeaderCell>
            <TableHeaderCell />
          </TableRow></TableHeader>
          <TableBody>
            {inputItems.map((li) => {
              const m = mappingFor(li.id);
              const kind = m?.sourceKind || 'manual';
              const list = kind === 'manual' ? [] : (sources[kind] || []);
              return (
                <TableRow key={li.id}>
                  <TableCell><strong>{li.name}</strong></TableCell>
                  <TableCell>
                    <Dropdown
                      value={kindLabel[kind]} selectedOptions={[kind]} style={{ minWidth: 150 }}
                      onOptionSelect={(_, d) => upsertMapping(li.id, { sourceKind: (d.optionValue as PlanSourceMapping['sourceKind']) || 'manual', sourceItemId: undefined, sourceName: undefined })}
                    >
                      {sourceKinds.map((k) => <Option key={k} value={k}>{kindLabel[k]}</Option>)}
                    </Dropdown>
                  </TableCell>
                  <TableCell>
                    {kind === 'manual' ? (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>
                    ) : list.length === 0 ? (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No {kindLabel[kind]} items</Caption1>
                    ) : (
                      <Dropdown
                        value={m?.sourceName || ''} selectedOptions={m?.sourceItemId ? [m.sourceItemId] : []} placeholder={`Select ${kindLabel[kind]}`} style={{ minWidth: 160 }}
                        onOptionSelect={(_, d) => { const it = list.find((x) => x.id === d.optionValue); upsertMapping(li.id, { sourceItemId: it?.id, sourceName: it?.name }); }}
                      >
                        {list.map((it) => <Option key={it.id} value={it.id}>{it.name}</Option>)}
                      </Dropdown>
                    )}
                  </TableCell>
                  <TableCell>
                    <Input value={m?.field || ''} onChange={(_, d) => upsertMapping(li.id, { field: d.value })} placeholder={kind === 'semantic-model' ? 'measure name' : 'column'} style={{ maxWidth: 150 }} />
                  </TableCell>
                  <TableCell>
                    <Input type="number" value={m?.currentActual != null ? String(m.currentActual) : ''} onChange={(_, d) => upsertMapping(li.id, { currentActual: d.value === '' ? undefined : Number(d.value) })} placeholder="actual value" style={{ maxWidth: 120 }} />
                  </TableCell>
                  <TableCell>{m && <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Clear mapping for ${li.name}`} onClick={() => clearMapping(li.id)} />}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
        <Button appearance="secondary" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save mappings'}</Button>
      </div>

      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

// ===================================================================
// EPM core UI — guided Formula builder + Model (cube) tab.
//
// Parity with Microsoft Fabric IQ Plan's user formulas + multidimensional cube
// (Anaplan-style). The Formula builder is fully GUIDED (function palette + row
// picker + operator buttons + number field) — there is NO freeform expression
// box (.claude/rules loom_no_freeform_config). The Model tab defines dimensions
// (member hierarchies) + measures and validates them against a real backend
// (POST /api/items/plan/[id]/model). Azure-native; no Microsoft Fabric.
// ===================================================================

const FORMULA_OFFSETS: { value: string; label: string; offset: number }[] = [
  { value: '0', label: 'this period', offset: 0 },
  { value: '-1', label: 'previous period', offset: -1 },
  { value: '-4', label: 'year ago (−4)', offset: -4 },
];
const FORMULA_FNS: PlanFormulaFn[] = ['SUM', 'AVG', 'MIN', 'MAX', 'ABS'];
type FormulaPreset = 'custom' | 'sum' | 'avg' | 'diff' | 'ratio' | 'growthPrev' | 'growthYoY';

/**
 * Guided Formula builder — assemble a {@link PlanFormulaToken} AST from presets
 * + a function/operator/row palette. No freeform text; the only text inputs are
 * numeric. Live preview + structural validity gate before Apply.
 */
function FormulaBuilderDialog({
  open, onClose, initial, rows, onApply,
}: {
  open: boolean;
  onClose: () => void;
  initial: PlanFormulaToken[];
  rows: { id: string; name: string }[];
  onApply: (tokens: PlanFormulaToken[]) => void;
}) {
  const s = useStyles();
  // NB: named fxTokens (not `tokens`) so the Fluent design-token import isn't
  // shadowed — `tokens.spacing*` below must resolve to the design tokens.
  const [fxTokens, setFxTokens] = useState<PlanFormulaToken[]>(initial);
  const [preset, setPreset] = useState<FormulaPreset>('custom');
  const [presetRows, setPresetRows] = useState<string[]>([]);
  const [presetA, setPresetA] = useState('');
  const [presetB, setPresetB] = useState('');
  const [insRow, setInsRow] = useState(rows[0]?.id || '');
  const [insOffset, setInsOffset] = useState('0');
  const [insNum, setInsNum] = useState('');

  useEffect(() => {
    if (open) {
      setFxTokens(Array.isArray(initial) ? initial : []);
      setPreset('custom'); setPresetRows([]); setPresetA(''); setPresetB('');
      setInsRow(rows[0]?.id || ''); setInsOffset('0'); setInsNum('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const labelFor = useCallback((ref: string) => rows.find((r) => r.id === ref)?.name || ref, [rows]);
  const preview = formulaToText(fxTokens, labelFor);
  // Structural validity probe — resolve every ref to 1 so only the *shape* is checked.
  const check = evalFormula(fxTokens, () => 1);

  const push = (t: PlanFormulaToken) => setFxTokens((p) => [...p, t]);
  const undo = () => setFxTokens((p) => p.slice(0, -1));
  const clear = () => setFxTokens([]);

  const generatePreset = () => {
    if (preset === 'sum' && presetRows.length) setFxTokens(qfSum(presetRows));
    else if (preset === 'avg' && presetRows.length) setFxTokens(qfAverage(presetRows));
    else if (preset === 'diff' && presetA && presetB) setFxTokens(qfDifference(presetA, presetB));
    else if (preset === 'ratio' && presetA && presetB) setFxTokens(qfRatioPct(presetA, presetB));
    else if (preset === 'growthPrev' && presetA) setFxTokens(qfGrowthPct(presetA, -1));
    else if (preset === 'growthYoY' && presetA) setFxTokens(qfGrowthPct(presetA, -4));
  };

  const presetNeedsMulti = preset === 'sum' || preset === 'avg';
  const presetNeedsTwo = preset === 'diff' || preset === 'ratio';
  const presetNeedsOne = preset === 'growthPrev' || preset === 'growthYoY';

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 680 }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Calculator20Regular style={{ color: tokens.colorBrandForeground1 }} /> Formula builder
            </span>
          </DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Build a calculation from rows, operators, and functions — no typing of expressions. Row references resolve per
                period; pick &quot;previous period&quot; or &quot;year ago&quot; for growth calcs.
              </Caption1>

              {/* Quick presets */}
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap', padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2 }}>
                <Field label="Quick formula">
                  <Dropdown
                    value={{
                      custom: 'Custom', sum: 'Sum of rows', avg: 'Average of rows',
                      diff: 'Difference (a − b)', ratio: 'Ratio % (a ÷ b × 100)',
                      growthPrev: 'Growth % vs previous', growthYoY: 'Growth % vs year ago',
                    }[preset]}
                    selectedOptions={[preset]}
                    onOptionSelect={(_, d) => { setPreset((d.optionValue as FormulaPreset) || 'custom'); setPresetRows([]); setPresetA(''); setPresetB(''); }}
                    style={{ minWidth: 200 }}
                  >
                    <Option value="custom">Custom</Option>
                    <Option value="sum">Sum of rows</Option>
                    <Option value="avg">Average of rows</Option>
                    <Option value="diff">Difference (a − b)</Option>
                    <Option value="ratio">Ratio % (a ÷ b × 100)</Option>
                    <Option value="growthPrev">Growth % vs previous</Option>
                    <Option value="growthYoY">Growth % vs year ago</Option>
                  </Dropdown>
                </Field>
                {presetNeedsMulti && (
                  <Field label="Rows">
                    <Dropdown multiselect placeholder="Pick rows…" selectedOptions={presetRows}
                      value={presetRows.map(labelFor).join(', ')}
                      onOptionSelect={(_, d) => setPresetRows(d.selectedOptions)} style={{ minWidth: 220 }}>
                      {rows.map((r) => <Option key={r.id} value={r.id}>{r.name}</Option>)}
                    </Dropdown>
                  </Field>
                )}
                {(presetNeedsTwo || presetNeedsOne) && (
                  <Field label={presetNeedsTwo ? 'Row a' : 'Row'}>
                    <Dropdown placeholder="Pick a row…" value={labelFor(presetA)} selectedOptions={presetA ? [presetA] : []}
                      onOptionSelect={(_, d) => setPresetA(d.optionValue || '')} style={{ minWidth: 160 }}>
                      {rows.map((r) => <Option key={r.id} value={r.id}>{r.name}</Option>)}
                    </Dropdown>
                  </Field>
                )}
                {presetNeedsTwo && (
                  <Field label="Row b">
                    <Dropdown placeholder="Pick a row…" value={labelFor(presetB)} selectedOptions={presetB ? [presetB] : []}
                      onOptionSelect={(_, d) => setPresetB(d.optionValue || '')} style={{ minWidth: 160 }}>
                      {rows.map((r) => <Option key={r.id} value={r.id}>{r.name}</Option>)}
                    </Dropdown>
                  </Field>
                )}
                {preset !== 'custom' && (
                  <Button appearance="primary" icon={<Sparkle20Regular />} onClick={generatePreset}
                    disabled={(presetNeedsMulti && presetRows.length === 0) || (presetNeedsTwo && (!presetA || !presetB)) || (presetNeedsOne && !presetA)}>
                    Generate
                  </Button>
                )}
              </div>

              {/* Manual palette */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                <Subtitle2>Build / refine</Subtitle2>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Row">
                    <Dropdown value={labelFor(insRow)} selectedOptions={insRow ? [insRow] : []}
                      onOptionSelect={(_, d) => setInsRow(d.optionValue || '')} style={{ minWidth: 150 }} disabled={rows.length === 0}>
                      {rows.map((r) => <Option key={r.id} value={r.id}>{r.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Period">
                    <Dropdown value={FORMULA_OFFSETS.find((o) => o.value === insOffset)?.label || 'this period'}
                      selectedOptions={[insOffset]} onOptionSelect={(_, d) => setInsOffset(d.optionValue || '0')} style={{ minWidth: 140 }}>
                      {FORMULA_OFFSETS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                    </Dropdown>
                  </Field>
                  <Button icon={<Add16Regular />} onClick={() => insRow && push({ k: 'row', ref: insRow, offset: Number(insOffset) || 0 })} disabled={!insRow}>Add row</Button>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Number">
                    <Input type="number" value={insNum} onChange={(_, d) => setInsNum(d.value)} style={{ maxWidth: 120 }} placeholder="0" />
                  </Field>
                  <Button icon={<Add16Regular />} onClick={() => { const v = Number(insNum); if (Number.isFinite(v)) { push({ k: 'num', value: v }); setInsNum(''); } }} disabled={insNum === ''}>Add number</Button>
                  <div style={{ flex: 1 }} />
                  <Button appearance="subtle" icon={<ArrowUndo16Regular />} onClick={undo} disabled={fxTokens.length === 0}>Undo</Button>
                  <Button appearance="subtle" onClick={clear} disabled={fxTokens.length === 0}>Clear</Button>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
                  {(['+', '-', '*', '/'] as PlanFormulaOp[]).map((op) => (
                    <Button key={op} appearance="secondary" size="small" onClick={() => push({ k: 'op', op })}>
                      {op === '*' ? '×' : op === '/' ? '÷' : op}
                    </Button>
                  ))}
                  <Button appearance="secondary" size="small" onClick={() => push({ k: 'lp' })}>(</Button>
                  <Button appearance="secondary" size="small" onClick={() => push({ k: 'rp' })}>)</Button>
                  <Button appearance="secondary" size="small" onClick={() => push({ k: 'comma' })}>,</Button>
                  {FORMULA_FNS.map((fn) => (
                    <Button key={fn} appearance="secondary" size="small" onClick={() => { push({ k: 'fn', fn }); push({ k: 'lp' }); }}>{fn}()</Button>
                  ))}
                </div>
              </div>

              {/* Live preview + validity */}
              <Field label="Preview">
                <div className={s.planFormulaPreview} aria-live="polite">{preview}</div>
              </Field>
              {fxTokens.length > 0 && !check.ok && (
                <MessageBar intent="warning"><MessageBarBody>{check.error || 'Formula is incomplete.'}</MessageBarBody></MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={fxTokens.length === 0 || !check.ok} onClick={() => { onApply(fxTokens); onClose(); }}>
              Apply formula
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Member-hierarchy editor for one dimension — add/rename/indent/outdent/remove
 * members with parent/child nesting + roll-up semantics. Depth-first ordered.
 */
function DimensionMembersEditor({
  dimension, onChange,
}: {
  dimension: PlanDimension;
  onChange: (members: PlanMember[]) => void;
}) {
  const s = useStyles();
  const ordered = orderMembers(dimension.members);
  const byId = new Map(dimension.members.map((m) => [m.id, m]));

  const addMember = () => onChange([...dimension.members, { id: newId('mem'), label: 'New member' }]);
  const rename = (mid: string, label: string) => onChange(dimension.members.map((m) => (m.id === mid ? { ...m, label } : m)));
  const remove = (mid: string) => onChange(dimension.members
    .filter((m) => m.id !== mid)
    .map((m) => (m.parentId === mid ? { ...m, parentId: byId.get(mid)?.parentId ?? null } : m)));
  const indent = (mid: string) => {
    const idx = ordered.findIndex((o) => o.member.id === mid);
    if (idx <= 0) return;
    const me = ordered[idx];
    // Nearest preceding member at the SAME depth = a valid new parent (prev sibling).
    for (let i = idx - 1; i >= 0; i--) {
      if (ordered[i].depth === me.depth) { onChange(dimension.members.map((m) => (m.id === mid ? { ...m, parentId: ordered[i].member.id } : m))); return; }
      if (ordered[i].depth < me.depth) break;
    }
  };
  const outdent = (mid: string) => {
    const cur = byId.get(mid);
    if (!cur?.parentId) return;
    const grand = byId.get(cur.parentId)?.parentId ?? null;
    onChange(dimension.members.map((m) => (m.id === mid ? { ...m, parentId: grand } : m)));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
      {ordered.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No members yet.</Caption1>
      )}
      {ordered.map(({ member, depth, hasChildren }) => (
        <div key={member.id} className={s.planMemberRow}>
          {Array.from({ length: depth }).map((_, i) => <span key={i} className={s.planIndent} />)}
          {hasChildren ? <Layer20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
            : <span style={{ width: tokens.spacingHorizontalL, flexShrink: 0, color: tokens.colorNeutralForeground4, textAlign: 'center' }}>•</span>}
          <Input size="small" value={member.label} onChange={(_, d) => rename(member.id, d.value)} aria-label="Member label" style={{ flex: 1, minWidth: 100 }} />
          <Button size="small" appearance="subtle" icon={<ChevronRight16Regular />} onClick={() => indent(member.id)} aria-label="Indent member" title="Indent (nest under previous sibling)" />
          <Button size="small" appearance="subtle" icon={<ChevronLeft16Regular />} onClick={() => outdent(member.id)} aria-label="Outdent member" title="Outdent" disabled={!member.parentId} />
          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => remove(member.id)} aria-label="Remove member" />
        </div>
      ))}
      <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={addMember} style={{ alignSelf: 'flex-start', marginTop: tokens.spacingVerticalXS }}>Add member</Button>
    </div>
  );
}

const AGG_OPTIONS: { value: PlanAggKind; label: string }[] = [
  { value: 'sum', label: 'Sum' }, { value: 'avg', label: 'Average' }, { value: 'count', label: 'Count' },
  { value: 'min', label: 'Min' }, { value: 'max', label: 'Max' },
];

/**
 * Model (cube) tab — define dimensions (member hierarchies) + measures, then
 * validate against the real backend. The structural foundation the planning
 * grid + formulas build on. Azure-native (Cosmos state); no Microsoft Fabric.
 */
function PlanModelPanel({
  id, state, setState, save, saving,
}: {
  id: string;
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  save: (next?: PlanState) => Promise<boolean>;
  saving: boolean;
}) {
  const s = useStyles();
  const model = ensureModel(state);
  const sheets = ensureSheets(state);
  const lineItemIds = useMemo(() => sheets.flatMap((sh) => sh.lineItems.map((li) => li.id)), [sheets]);
  const allLineItems = useMemo(() => sheets.flatMap((sh) => sh.lineItems.map((li) => ({ id: li.id, name: `${sh.name} · ${li.name}` }))), [sheets]);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ valid: boolean; issues: ModelIssue[]; message: string } | null>(null);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const setModel = (mut: (m: PlanModel) => PlanModel) =>
    setState((prev) => ({ ...prev, model: mut(ensureModel(prev)) }));

  const addDimension = () => setModel((m) => ({ ...m, dimensions: [...m.dimensions, { id: newId('dim'), name: `Dimension ${m.dimensions.length + 1}`, axis: 'row', members: [] }] }));
  const seedStarter = () => setState((prev) => ({ ...prev, model: defaultPlanModel() }));
  const removeDimension = (did: string) => setModel((m) => ({ ...m, dimensions: m.dimensions.filter((d) => d.id !== did) }));
  const patchDimension = (did: string, patch: Partial<PlanDimension>) => setModel((m) => ({ ...m, dimensions: m.dimensions.map((d) => (d.id === did ? { ...d, ...patch } : d)) }));

  const addMeasure = () => setModel((m) => ({ ...m, measures: [...m.measures, { id: newId('meas'), name: `Measure ${m.measures.length + 1}`, agg: 'sum' }] }));
  const removeMeasure = (mid: string) => setModel((m) => ({ ...m, measures: m.measures.filter((x) => x.id !== mid) }));
  const patchMeasure = (mid: string, patch: Partial<PlanMeasure>) => setModel((m) => ({ ...m, measures: m.measures.map((x) => (x.id === mid ? { ...x, ...patch } : x)) }));

  // "Add members as rows" — push a dimension's members (with parent mapping) onto
  // the active sheet as hierarchical line items, connecting the model to the grid.
  const addMembersToSheet = (dim: PlanDimension) => {
    const activeId = sheets.some((sh) => sh.id === state.activeSheetId) ? state.activeSheetId : sheets[0].id;
    setState((prev) => {
      const cur = ensureSheets(prev);
      const idMap = new Map<string, string>();
      dim.members.forEach((mem) => idMap.set(mem.id, newId('li')));
      const newItems: PlanLineItem[] = orderMembers(dim.members).map(({ member }) => ({
        id: idMap.get(member.id)!,
        name: member.label,
        kind: 'input',
        parentId: member.parentId ? (idMap.get(member.parentId) || null) : null,
      }));
      return {
        ...prev,
        sheets: cur.map((sh) => (sh.id === activeId ? { ...sh, lineItems: [...sh.lineItems, ...newItems] } : sh)),
      };
    });
    setMsg({ intent: 'success', text: `Added ${dim.members.length} member row(s) from "${dim.name}" to the planning sheet.` });
  };

  const validate = async () => {
    setBusy(true); setMsg(null); setResult(null);
    // Always run the pure validation locally so the surface works even pre-save.
    const local = validateModel(model, lineItemIds);
    const formulaIssues: ModelIssue[] = [];
    for (const sh of sheets) formulaIssues.push(...validateFormulaRows(sh).issues.map((iss) => ({ ...iss, message: sheets.length > 1 ? `[${sh.name}] ${iss.message}` : iss.message })));
    const localIssues = [...local.issues, ...formulaIssues];
    const localValid = localIssues.every((x) => x.level !== 'error');

    if (!id || id === 'new') {
      setResult({ valid: localValid, issues: localIssues, message: localValid ? 'Model valid (save the plan to persist).' : `${localIssues.filter((x) => x.level === 'error').length} error(s) found.` });
      setBusy(false);
      return;
    }
    try {
      await save(); // persist what we're validating
      const r = await clientFetch(`/api/items/plan/${encodeURIComponent(id)}/model`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, sheets }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setResult({ valid: !!j.valid, issues: arr<ModelIssue>(j.issues), message: j.message || (j.valid ? 'Model valid.' : 'Model has errors.') });
    } catch (e: any) {
      // Backend unreachable → fall back to the local pure validation (still real).
      setResult({ valid: localValid, issues: localIssues, message: localValid ? 'Model valid (validated locally).' : `${localIssues.filter((x) => x.level === 'error').length} error(s) found.` });
    } finally { setBusy(false); }
  };

  const hasModel = model.dimensions.length > 0 || model.measures.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Model (cube)</MessageBarTitle>
          Define the plan&apos;s <strong>dimensions</strong> (member hierarchies — Region → Country → Store) and reusable
          <strong> measures</strong>. This is the structural foundation: members roll up on the planning grid, and formulas
          compute over these rows. Azure-native — the model persists to Cosmos; no Microsoft Fabric capacity required.
        </MessageBarBody>
      </MessageBar>

      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge appearance="filled" color="brand">{model.dimensions.length} dimension{model.dimensions.length === 1 ? '' : 's'}</Badge>
        <Badge appearance="outline">{model.measures.length} measure{model.measures.length === 1 ? '' : 's'}</Badge>
        <div style={{ flex: 1 }} />
        <Button icon={<Cube20Regular />} onClick={addDimension}>Add dimension</Button>
        <Button icon={<Ruler20Regular />} onClick={addMeasure}>Add measure</Button>
        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <CheckmarkCircle20Regular />} onClick={validate} disabled={busy}>
          {busy ? 'Validating…' : 'Validate model'}
        </Button>
      </div>

      {!hasModel && (
        <EmptyState
          icon={<Cube20Regular />}
          title="No cube defined yet"
          body="Add dimensions (member hierarchies) and measures to give this plan a multidimensional structure — or start from a sample Account hierarchy."
          primaryAction={{ label: 'Add dimension', onClick: addDimension }}
          secondaryAction={{ label: 'Start from sample', onClick: seedStarter }}
        />
      )}

      {hasModel && (
        <>
          {model.dimensions.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <div className={s.secHead}><Cube20Regular className={s.secHeadIcon} /><Subtitle2>Dimensions</Subtitle2></div>
              <TileGrid minTileWidth={320}>
                {model.dimensions.map((d) => (
                  <div key={d.id} className={s.planModelCard}>
                    <div className={s.planModelCardHead}>
                      <span className={s.planModelCardIcon}><Cube20Regular /></span>
                      <Input value={d.name} onChange={(_, v) => patchDimension(d.id, { name: v.value })} aria-label="Dimension name" style={{ flex: 1, minWidth: 0 }} />
                      <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => removeDimension(d.id)} aria-label="Remove dimension" />
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Field label="Axis" orientation="horizontal">
                        <Dropdown value={d.axis === 'row' ? 'Rows' : 'Columns'} selectedOptions={[d.axis]}
                          onOptionSelect={(_, v) => patchDimension(d.id, { axis: (v.optionValue as PlanDimensionAxis) || 'row' })} style={{ minWidth: 110 }}>
                          <Option value="row">Rows</Option>
                          <Option value="column">Columns</Option>
                        </Dropdown>
                      </Field>
                      <Badge appearance="outline">{d.members.length} member{d.members.length === 1 ? '' : 's'}</Badge>
                    </div>
                    <div style={{ height: 1, background: tokens.colorNeutralStroke2 }} />
                    <DimensionMembersEditor dimension={d} onChange={(members) => patchDimension(d.id, { members })} />
                    {d.axis === 'row' && d.members.length > 0 && (
                      <Button size="small" appearance="secondary" icon={<Layer20Regular />} onClick={() => addMembersToSheet(d)} style={{ alignSelf: 'flex-start' }}>
                        Add members as planning rows
                      </Button>
                    )}
                  </div>
                ))}
              </TileGrid>
            </div>
          )}

          {model.measures.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <div className={s.secHead}><Ruler20Regular className={s.secHeadIcon} /><Subtitle2>Measures</Subtitle2></div>
              <TileGrid minTileWidth={280}>
                {model.measures.map((ms) => (
                  <div key={ms.id} className={s.planModelCard}>
                    <div className={s.planModelCardHead}>
                      <span className={s.planModelCardIcon}><Ruler20Regular /></span>
                      <Input value={ms.name} onChange={(_, v) => patchMeasure(ms.id, { name: v.value })} aria-label="Measure name" style={{ flex: 1, minWidth: 0 }} />
                      <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => removeMeasure(ms.id)} aria-label="Remove measure" />
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <Field label="Aggregation">
                        <Dropdown value={AGG_OPTIONS.find((a) => a.value === ms.agg)?.label || 'Sum'} selectedOptions={[ms.agg]}
                          onOptionSelect={(_, v) => patchMeasure(ms.id, { agg: (v.optionValue as PlanAggKind) || 'sum' })} style={{ minWidth: 120 }}>
                          {AGG_OPTIONS.map((a) => <Option key={a.value} value={a.value}>{a.label}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Unit">
                        <Input value={ms.unit || ''} onChange={(_, v) => patchMeasure(ms.id, { unit: v.value })} placeholder="USD / % / FTE" style={{ maxWidth: 110 }} />
                      </Field>
                    </div>
                    <Field label="Scope (line item)" hint="Optional — restrict the measure to one line item.">
                      <Dropdown placeholder="Whole sheet" value={allLineItems.find((li) => li.id === ms.scopeLineItemId)?.name || ''}
                        selectedOptions={ms.scopeLineItemId ? [ms.scopeLineItemId] : []}
                        onOptionSelect={(_, v) => patchMeasure(ms.id, { scopeLineItemId: v.optionValue || undefined })} style={{ minWidth: 160 }}>
                        <Option value="">Whole sheet</Option>
                        {allLineItems.map((li) => <Option key={li.id} value={li.id}>{li.name}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                ))}
              </TileGrid>
            </div>
          )}
        </>
      )}

      {result && (
        <MessageBar intent={result.valid ? (result.issues.some((x) => x.level === 'warning') ? 'warning' : 'success') : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{result.valid ? 'Model valid' : 'Model has errors'}</MessageBarTitle>
            {result.message}
            {result.issues.length > 0 && (
              <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: tokens.spacingHorizontalL }}>
                {result.issues.map((iss, i) => (
                  <li key={i} style={{ color: iss.level === 'error' ? tokens.colorPaletteRedForeground1 : tokens.colorStatusWarningForeground1 }}>
                    {iss.level === 'error' ? '✕ ' : '⚠ '}{iss.message}
                  </li>
                ))}
              </ul>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
        <Button appearance="primary" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save model'}</Button>
      </div>
    </div>
  );
}

// ===================================================================
// Plan Copilot — the collapsible right-rail connected-planning assistant.
//
// Streams from POST /api/items/plan/[id]/copilot, which grounds a chat completion
// on THIS plan's real persisted cells / variance / model (the shared aoai-chat-
// client). Renders the normalized token/final/error SSE incrementally. Honest
// AOAI 503 gate in a Fluent MessageBar; the editor stays fully functional.
// Web5: Fluent v9 + Loom tokens, chat bubbles, quick prompts, an icon per action.
// ===================================================================

const usePlanCopilotStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minHeight: 0, height: '100%' },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  thread: {
    flex: 1, minHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalS, paddingRight: tokens.spacingHorizontalXXS,
  },
  bubble: { padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusLarge, maxWidth: '94%', whiteSpace: 'pre-wrap' },
  you: { alignSelf: 'flex-end', backgroundColor: tokens.colorBrandBackground2 },
  bot: { alignSelf: 'flex-start', backgroundColor: tokens.colorNeutralBackground2 },
  quick: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  composer: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  sendRow: { display: 'flex', justifyContent: 'flex-end' },
});

interface CopilotTurn { who: 'you' | 'copilot'; text: string; streaming?: boolean }

function PlanCopilotPane({ id, sheetName, scenarioName }: { id: string; sheetName: string; scenarioName: string }) {
  const s = usePlanCopilotStyles();
  const [turns, setTurns] = useState<CopilotTurn[]>([{
    who: 'copilot',
    text: "I'm your Plan Copilot. Ask me to explain a variance, draft a forecast, or sanity-check your budget — I read this plan's cells, variance, and model.",
  }]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [aoaiGate, setAoaiGate] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const isNew = !id || id === 'new';

  const scrollDown = () => requestAnimationFrame(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; });

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    if (isNew) { setAoaiGate('Save the plan first — Plan Copilot grounds on the saved plan.'); return; }
    setDraft(''); setAoaiGate(null); setBusy(true);
    // Compact prior history (last 6 non-streaming turns) for a conversational thread.
    const history = turns
      .filter((t) => t.text && !t.streaming)
      .slice(-6)
      .map((t) => ({ role: t.who === 'you' ? 'user' : 'assistant', content: t.text }));
    setTurns((prev) => [...prev, { who: 'you', text }, { who: 'copilot', text: '', streaming: true }]);
    scrollDown();
    try {
      const res = await fetch(`/api/items/plan/${encodeURIComponent(id)}/copilot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text, history }),
      });
      if (res.status === 503) {
        const j = await res.json().catch(() => ({}));
        setAoaiGate(j.error || 'Azure OpenAI is not configured for this deployment.');
        setTurns((prev) => prev.filter((t) => !t.streaming));
        return;
      }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, text: `Error: ${j.error || `HTTP ${res.status}`}`, streaming: false } : t)));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const appendToken = (tok: string) => setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, text: t.text + tok } : t)));
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          if (event === 'token') { try { const d = JSON.parse(data); if (d.text) appendToken(d.text); } catch { /* ignore */ } }
          else if (event === 'final') { try { const d = JSON.parse(data); setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, text: d.text || t.text, streaming: false } : t))); } catch { /* ignore */ } }
          else if (event === 'error') { try { const d = JSON.parse(data); setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, text: `Error: ${d.error || 'failed'}`, streaming: false } : t))); } catch { /* ignore */ } }
          scrollDown();
        }
      }
      setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, streaming: false } : t)));
    } catch (e: any) {
      setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, text: `Network error: ${e?.message || e}`, streaming: false } : t)));
    } finally {
      setBusy(false);
      scrollDown();
    }
  }, [busy, id, isNew, turns]);

  return (
    <div className={s.pane} aria-label="Plan Copilot">
      <div className={s.head}>
        <Sparkle20Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Plan Copilot</Subtitle2>
        {busy && <Spinner size="tiny" />}
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Grounded on <strong>{sheetName || 'this plan'}</strong> · scenario <strong>{scenarioName}</strong> — cells, variance &amp; model.
      </Caption1>

      {aoaiGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Copilot unavailable</MessageBarTitle>
            {aoaiGate}
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.thread} ref={threadRef} aria-live="polite">
        {turns.map((t, i) => (
          <div key={i} className={`${s.bubble} ${t.who === 'you' ? s.you : s.bot}`}>
            {t.text
              ? <Body1>{t.text}</Body1>
              : (t.streaming ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground3 }}><Spinner size="extra-tiny" /> Thinking…</span> : null)}
          </div>
        ))}
      </div>

      {turns.length <= 1 && (
        <div className={s.quick}>
          <Button size="small" appearance="outline" icon={<ChartMultiple20Regular />} disabled={busy || isNew}
            onClick={() => void send('Explain the biggest variance in this plan and what might be driving it.')}>
            Explain this variance
          </Button>
          <Button size="small" appearance="outline" icon={<DataTrending20Regular />} disabled={busy || isNew}
            onClick={() => void send('Draft a next-quarter forecast for each line item based on the current trend, and call out the assumptions.')}>
            Draft next-quarter forecast
          </Button>
        </div>
      )}

      <div className={s.composer}>
        <Textarea
          value={draft}
          onChange={(_e, d) => setDraft(d.value)}
          placeholder={isNew ? 'Save the plan to chat…' : 'Ask about this plan…'}
          disabled={busy || isNew}
          resize="vertical"
          rows={2}
          aria-label="Ask Plan Copilot"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !busy) { e.preventDefault(); void send(draft); } }}
        />
        <div className={s.sendRow}>
          <Button appearance="primary" icon={<Send20Regular />} disabled={busy || isNew || !draft.trim()} onClick={() => void send(draft)}>Send</Button>
        </div>
      </div>
    </div>
  );
}

// ----- Versions — immutable plan snapshots (take / diff / restore) ------------
// Pure helpers live in _plan-model.ts (takeSnapshot / diffSnapshots /
// restoreSnapshot — vitest-covered); this panel drives them and persists the
// returned state via the existing item PATCH (Cosmos). No Microsoft Fabric.
const fmtCell = (v: number | null) =>
  v === null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });

function PlanVersionsPanel({
  state, setState, save, saving,
}: {
  state: PlanState;
  setState: (updater: (prev: PlanState) => PlanState) => void;
  save: (next?: PlanState) => Promise<boolean>;
  saving: boolean;
}) {
  const s = useStyles();
  const snapshots = arr<PlanSnapshot>(state.snapshots);
  const newestFirst = useMemo(() => [...snapshots].reverse(), [snapshots]);

  const [label, setLabel] = useState('');
  const [author, setAuthor] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null); // 'take' | snapshot id being restored
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [diffFor, setDiffFor] = useState<PlanSnapshot | null>(null);

  // Best-effort author stamp from the signed-in session (same /api/me the shell uses).
  useEffect(() => {
    let alive = true;
    clientFetch('/api/me')
      .then((r) => r.json())
      .then((d: { user?: { name?: string; upn?: string } | null }) => {
        if (alive && (d?.user?.name || d?.user?.upn)) setAuthor(d.user!.name || d.user!.upn);
      })
      .catch(() => { /* author stays undefined — snapshot still works */ });
    return () => { alive = false; };
  }, []);

  const take = useCallback(async () => {
    setBusy('take'); setMsg(null);
    try {
      const next = takeSnapshot(state, label, author);
      const snap = next.snapshots![next.snapshots!.length - 1];
      setState(() => next);
      const ok = await save(next);
      setMsg(ok
        ? { intent: 'success', text: `Snapshot “${snap.label}” saved.` }
        : { intent: 'error', text: 'Snapshot captured but the save failed — retry Save to persist it.' });
      if (ok) setLabel('');
    } finally { setBusy(null); }
  }, [state, label, author, setState, save]);

  const restore = useCallback(async (snap: PlanSnapshot) => {
    if (typeof window !== 'undefined' &&
        !window.confirm(`Restore “${snap.label}” (${new Date(snap.takenAt).toLocaleString()})?\n\nThe current plan is snapshotted first, so this is reversible.`)) return;
    setBusy(snap.id); setMsg(null);
    try {
      const next = restoreSnapshot(state, snap.id, author);
      if (next === state) { setMsg({ intent: 'warning', text: 'Snapshot not found — refresh and try again.' }); return; }
      setState(() => next);
      const ok = await save(next);
      setMsg(ok
        ? { intent: 'success', text: `Restored “${snap.label}”. The pre-restore state was snapshotted as “Before restore of "${snap.label}"”.` }
        : { intent: 'error', text: 'Restore applied locally but the save failed — retry Save to persist it.' });
    } finally { setBusy(null); }
  }, [state, author, setState, save]);

  // Diff a snapshot against the CURRENT plan (ephemeral capture — not persisted).
  const diff: PlanSnapshotDiff | null = useMemo(
    () => (diffFor ? diffSnapshots(diffFor, captureSnapshot(state, 'Current plan')) : null),
    [diffFor, state],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, marginTop: tokens.spacingVerticalM }}>
      <div className={s.daSection}>
        <div className={s.daSectionHead}>
          <span className={s.daSectionIcon}><History20Regular /></span>
          <Subtitle2>Versions</Subtitle2>
          <Badge appearance="tint" color="brand">{snapshots.length}/{MAX_PLAN_SNAPSHOTS}</Badge>
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Take an immutable snapshot of the plan&rsquo;s cells, line items, and scenarios. Snapshots persist with
          the plan (Cosmos) and can be diffed against the current plan or restored — restoring auto-snapshots the
          current state first, so it&rsquo;s always reversible.
        </Caption1>

        {/* Take snapshot */}
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Snapshot label" style={{ flex: '1 1 280px', minWidth: 240 }}>
            <Input
              value={label}
              placeholder="e.g. Board submission FY26"
              maxLength={120}
              contentBefore={<Camera20Regular />}
              onChange={(_, d) => setLabel(d.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && busy === null) void take(); }}
            />
          </Field>
          <Button
            appearance="primary"
            icon={busy === 'take' ? <Spinner size="tiny" /> : <Camera20Regular />}
            onClick={() => void take()}
            disabled={busy !== null || saving}
          >
            {busy === 'take' ? 'Snapshotting…' : 'Take snapshot'}
          </Button>
        </div>
        {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      </div>

      {/* Snapshot list (newest first) */}
      {newestFirst.length === 0 ? (
        <EmptyState
          icon={<History20Regular />}
          title="No versions yet"
          body="Take a snapshot to freeze the plan's current cells, rows, and scenarios as an immutable, restorable version."
          primaryAction={{ label: 'Take snapshot', onClick: () => void take() }}
        />
      ) : (
        newestFirst.map((snap) => {
          const cellCount = (snap.sheets || []).reduce((acc, sh) => acc + Object.keys(sh.cells || {}).length, 0);
          const rowCount = (snap.sheets || []).reduce((acc, sh) => acc + (sh.lineItems || []).length, 0);
          return (
            <div key={snap.id} className={s.daSrcCard}>
              <div className={s.daSrcHead}>
                <span className={s.daSrcIcon}><History20Regular /></span>
                <strong>{snap.label}</strong>
                <Badge appearance="tint" color="brand">{(snap.sheets || []).length} sheet{(snap.sheets || []).length === 1 ? '' : 's'}</Badge>
                <Badge appearance="outline">{rowCount} row{rowCount === 1 ? '' : 's'}</Badge>
                <Badge appearance="outline">{cellCount} cell{cellCount === 1 ? '' : 's'}</Badge>
                <Badge appearance="outline">{(snap.scenarios || []).length} scenario{(snap.scenarios || []).length === 1 ? '' : 's'}</Badge>
                <div style={{ flex: 1 }} />
                <Button size="small" appearance="outline" icon={<BranchFork20Regular />} onClick={() => setDiffFor(snap)}>
                  Diff vs current
                </Button>
                <Button
                  size="small"
                  appearance="outline"
                  icon={busy === snap.id ? <Spinner size="tiny" /> : <ArrowUndo16Regular />}
                  onClick={() => void restore(snap)}
                  disabled={busy !== null || saving}
                >
                  {busy === snap.id ? 'Restoring…' : 'Restore'}
                </Button>
              </div>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                {new Date(snap.takenAt).toLocaleString()}{snap.author ? ` · by ${snap.author}` : ''}
              </Caption1>
            </div>
          );
        })
      )}

      {/* Diff dialog — changed cells + structural changes vs the current plan. */}
      <Dialog open={!!diffFor} onOpenChange={(_, d) => { if (!d.open) setDiffFor(null); }}>
        <DialogSurface style={{ maxWidth: 860 }}>
          <DialogBody>
            <DialogTitle>
              Diff: “{diffFor?.label}” → current plan
            </DialogTitle>
            <DialogContent>
              {diff && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    {diffFor && `Snapshot taken ${new Date(diffFor.takenAt).toLocaleString()}${diffFor.author ? ` by ${diffFor.author}` : ''}.`}
                  </Caption1>
                  {diff.identical ? (
                    <MessageBar intent="success"><MessageBarBody>No differences — the current plan matches this snapshot exactly.</MessageBarBody></MessageBar>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                        <Badge appearance="filled" color="brand">{diff.cells.length} changed cell{diff.cells.length === 1 ? '' : 's'}</Badge>
                        {diff.rows.filter((r) => r.change === 'added').length > 0 && (
                          <Badge appearance="filled" color="success">+{diff.rows.filter((r) => r.change === 'added').length} row{diff.rows.filter((r) => r.change === 'added').length === 1 ? '' : 's'}</Badge>
                        )}
                        {diff.rows.filter((r) => r.change === 'removed').length > 0 && (
                          <Badge appearance="filled" color="danger">−{diff.rows.filter((r) => r.change === 'removed').length} row{diff.rows.filter((r) => r.change === 'removed').length === 1 ? '' : 's'}</Badge>
                        )}
                        {diff.rows.filter((r) => r.change === 'renamed').length > 0 && (
                          <Badge appearance="filled" color="warning">{diff.rows.filter((r) => r.change === 'renamed').length} renamed</Badge>
                        )}
                        {diff.scenariosAdded.map((n) => <Badge key={`sa-${n}`} appearance="tint" color="success">+ scenario {n}</Badge>)}
                        {diff.scenariosRemoved.map((n) => <Badge key={`sr-${n}`} appearance="tint" color="danger">− scenario {n}</Badge>)}
                        {diff.sheetsAdded.map((n) => <Badge key={`ha-${n}`} appearance="tint" color="success">+ sheet {n}</Badge>)}
                        {diff.sheetsRemoved.map((n) => <Badge key={`hr-${n}`} appearance="tint" color="danger">− sheet {n}</Badge>)}
                      </div>
                      {diff.rows.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
                          {diff.rows.map((r, i) => (
                            <Caption1 key={i} style={{ color: tokens.colorNeutralForeground2 }}>
                              {r.change === 'added' && <>Row <strong>{r.name}</strong> added ({r.sheetName}).</>}
                              {r.change === 'removed' && <>Row <strong>{r.name}</strong> removed ({r.sheetName}).</>}
                              {r.change === 'renamed' && <>Row renamed <strong>{r.before}</strong> → <strong>{r.after}</strong> ({r.sheetName}).</>}
                            </Caption1>
                          ))}
                        </div>
                      )}
                      {diff.cells.length > 0 && (
                        <div style={{ maxHeight: 380, overflowY: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                          <Table aria-label="Changed cells" size="small">
                            <TableHeader><TableRow>
                              <TableHeaderCell>Row</TableHeaderCell>
                              <TableHeaderCell>Period</TableHeaderCell>
                              <TableHeaderCell>Scenario</TableHeaderCell>
                              <TableHeaderCell>Snapshot</TableHeaderCell>
                              <TableHeaderCell>Current</TableHeaderCell>
                            </TableRow></TableHeader>
                            <TableBody>
                              {diff.cells.slice(0, 200).map((c, i) => (
                                <TableRow key={i}>
                                  <TableCell>{c.lineItemName}</TableCell>
                                  <TableCell>{c.periodLabel}</TableCell>
                                  <TableCell>{c.scenarioName}</TableCell>
                                  <TableCell><span style={{ color: tokens.colorNeutralForeground3 }}>{fmtCell(c.before)}</span></TableCell>
                                  <TableCell>
                                    <strong style={{ color: (c.after ?? 0) >= (c.before ?? 0) ? tokens.colorPaletteGreenForeground1 : tokens.colorPaletteRedForeground1 }}>
                                      {fmtCell(c.after)}
                                    </strong>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                          {diff.cells.length > 200 && (
                            <Caption1 style={{ display: 'block', padding: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                              Showing the first 200 of {diff.cells.length} changed cells.
                            </Caption1>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              {diffFor && !diff?.identical && (
                <Button
                  appearance="primary"
                  icon={<ArrowUndo16Regular />}
                  disabled={busy !== null || saving}
                  onClick={() => { const target = diffFor; setDiffFor(null); if (target) void restore(target); }}
                >
                  Restore this version
                </Button>
              )}
              <Button appearance="secondary" onClick={() => setDiffFor(null)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

export function PlanEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<PlanState>('plan', id, {
    tasks: [{ title: 'Define semantic model', owner: '', due: '', status: 'todo' }],
  });
  const [tab, setTab] = useState<'planning' | 'model' | 'tasks' | 'powertable' | 'intelligence' | 'infobridge' | 'versions'>('planning');

  // ----- Project-tasks helpers (audit-T13 surface, preserved) -----
  const update = (idx: number, patch: Partial<PlanTask>) => {
    setState((prev) => {
      const next = [...arr<PlanTask>(prev.tasks)];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, tasks: next };
    });
  };
  const add = () => setState((prev) => ({
    ...prev,
    tasks: [...arr<PlanTask>(prev.tasks), { title: '', owner: '', due: '', status: 'todo' }],
  }));
  const remove = (idx: number) => setState((prev) => ({
    ...prev,
    tasks: arr<PlanTask>(prev.tasks).filter((_, i) => i !== idx),
  }));

  const taskList = arr<PlanTask>(state.tasks);
  // Active sheet/scenario for the Intelligence tab (mirrors PlanningSheetPanel's
  // resolution so both surfaces read the same scenario the user is editing).
  const intelSheets = ensureSheets(state);
  const intelScenarios = ensureScenarios(state);
  const intelSheet = intelSheets.find((x) => x.id === state.activeSheetId) || intelSheets[0];
  const intelScenario = intelScenarios.find((x) => x.id === state.activeScenarioId) || intelScenarios[0];
  const counts = taskList.reduce(
    (acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; },
    {} as Record<PlanTask['status'], number>,
  );
  const todo = counts.todo || 0;
  const doing = counts.doing || 0;
  const done = counts.done || 0;
  const total = taskList.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = taskList.filter(t => t.status !== 'done' && t.due && t.due < today).length;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Plan', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
      ]},
      { label: 'Tasks', actions: [
        { label: 'New task', onClick: add },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, add]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
          <Tab value="planning" icon={<Money20Regular />}>Planning</Tab>
          <Tab value="model" icon={<Cube20Regular />}>Model</Tab>
          <Tab value="tasks" icon={<ShieldCheckmark20Regular />}>Project tasks</Tab>
          <Tab value="powertable" icon={<Table20Regular />}>PowerTable</Tab>
          <Tab value="intelligence" icon={<ChartMultiple20Regular />}>Intelligence</Tab>
          <Tab value="infobridge" icon={<Link20Regular />}>InfoBridge</Tab>
          <Tab value="versions" icon={<History20Regular />}>Versions</Tab>
        </TabList>

        {tab === 'planning' && (
          <PlanningSheetPanel id={id} state={state} setState={setState} save={save} saving={saving} />
        )}

        {tab === 'model' && (
          <PlanModelPanel id={id} state={state} setState={setState} save={save} saving={saving} />
        )}

        {tab === 'tasks' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Project tasks</MessageBarTitle>
                Track the plan&apos;s delivery tasks and route the plan through the Azure-native approval Logic App. On approval,
                plan metrics write back to a linked semantic model via XMLA (no Fabric / Power Automate).
              </MessageBarBody>
            </MessageBar>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge appearance="filled" color="brand">{total} task{total === 1 ? '' : 's'}</Badge>
              <Badge appearance="outline">to-do: {todo}</Badge>
              <Badge appearance="filled" color="warning">doing: {doing}</Badge>
              <Badge appearance="filled" color="success">done: {done}</Badge>
              {overdue > 0 && <Badge appearance="filled" color="danger">overdue: {overdue}</Badge>}
              <Caption1 style={{ marginLeft: tokens.spacingHorizontalS }}>{pct}% complete</Caption1>
              <div style={{ flex: 1, height: 6, backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusSmall, overflow: 'hidden', minWidth: 120, maxWidth: 240 }}>
                <div style={{ width: `${pct}%`, height: '100%', backgroundColor: tokens.colorBrandStroke1, transition: 'width 0.2s' }} />
              </div>
            </div>
            <Table aria-label="Plan tasks" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Task</TableHeaderCell>
                <TableHeaderCell>Owner</TableHeaderCell>
                <TableHeaderCell>Due</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Depends on</TableHeaderCell>
                <TableHeaderCell />
              </TableRow></TableHeader>
              <TableBody>
                {taskList.map((t, i) => (
                  <TableRow key={i}>
                    <TableCell><Input value={t.title} onChange={(_, d) => update(i, { title: d.value })} /></TableCell>
                    <TableCell><Input value={t.owner} onChange={(_, d) => update(i, { owner: d.value })} /></TableCell>
                    <TableCell><Input type="date" value={t.due} onChange={(_, d) => update(i, { due: d.value })} /></TableCell>
                    <TableCell>
                      <select value={t.status} onChange={(e) => update(i, { status: e.target.value as PlanTask['status'] })}
                        style={{ padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                        <option value="todo">todo</option><option value="doing">doing</option><option value="done">done</option>
                      </select>
                    </TableCell>
                    <TableCell><Input value={t.dependsOn || ''} onChange={(_, d) => update(i, { dependsOn: d.value })} placeholder="task title" /></TableCell>
                    <TableCell><Button size="small" onClick={() => remove(i)}>Delete</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Button onClick={add} style={{ alignSelf: 'flex-start' }}>+ New task</Button>
            <PlanApprovalPanel id={id} tasks={taskList} state={state} setState={setState} save={save} />
          </div>
        )}

        {tab === 'powertable' && (
          <PlanPowerTablePanel id={id} state={state} setState={setState} save={save} saving={saving} />
        )}
        {tab === 'intelligence' && (
          <PlanIntelligencePanel
            state={state}
            setState={setState}
            scenarioName={intelScenario.name}
            activeScenarioId={intelScenario.id}
            sheet={intelSheet}
            tasks={taskList}
          />
        )}
        {tab === 'infobridge' && (
          <PlanInfoBridgePanel id={id} state={state} setState={setState} save={save} saving={saving} />
        )}
        {tab === 'versions' && (
          <PlanVersionsPanel state={state} setState={setState} save={save} saving={saving} />
        )}

        <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    }
      rightPanel={<PlanCopilotPane id={id} sheetName={intelSheet?.name || ''} scenarioName={intelScenario?.name || ''} />}
      rightPanelLabel="Plan Copilot"
    />
  );
}

