'use client';

/**
 * Data Agent editor (typed source picker + grounded test chat + eval + monitoring).
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
  type PlanScenario, type PlanScenarioKind,
  type PlanningSheet, type PlanSemanticModelRef, type PlanBackingDb,
  type PlanCellRow, type PlanRowSortKey, type PeriodPoint, type GanttBar,
  type PlanSourceMapping, type PlanLineItem,
  type PlanModel, type PlanDimension, type PlanMember, type PlanMeasure,
  type PlanAggKind, type PlanDimensionAxis, type PlanFormulaToken,
  type PlanFormulaFn, type PlanFormulaOp, type ModelIssue,
} from '../_plan-model';
import { arr, useItemState, SaveBar, useStyles } from './shared';

// ----- Data Agent — typed five-source picker + per-source grounding +
// real grounded test chat + publish to Foundry Agent Service + Copilot
// Studio handoff. Backed by:
//   PATCH /api/items/data-agent/[id]            (Cosmos persist)
//   POST  /api/items/data-agent/[id]/chat       (live AOAI grounded chat)
//   POST  /api/items/data-agent/[id]/publish    (Foundry Agent Service)
//   GET   /api/items/by-type?types=...          (typed source picker)
// ----- Evaluation (Fabric "Evaluate a data agent" parity) -----
interface DaEvalCase { question: string; expectedAnswer?: string; expectedQuery?: string }
interface DaEvalResult {
  question: string; expectedAnswer?: string; expectedQuery?: string;
  answer: string; query?: string; sourceUsed?: string;
  pass: boolean; score: number; queryMatch?: boolean; rationale: string; error?: string;
}
interface DaEvalRun {
  id: string; ranAt: string; ranBy?: string; model?: string;
  total: number; passed: number; accuracy: number; results: DaEvalResult[];
}

interface DataAgentState {
  instructions: string;
  sources: DaSource[];
  description?: string;
  /** Optional custom display name / alias for the agent (shown in chat + on publish). */
  alias?: string;
  /** Ground-truth set for evaluation (question + expected answer / query). */
  evalSet?: DaEvalCase[];
  /** Persisted evaluation runs (newest first), written by the /evaluate route. */
  evalRuns?: DaEvalRun[];
  /** Suggested prompts surfaced to consumers + in the test-pane empty state. */
  conversationStarters?: string[];
  // Back-compat with the legacy free-text bag (read-only on load).
  systemPrompt?: string; model?: string;
  foundryAgentId?: string; foundryProjectId?: string; publishedAt?: string;
  lastDeployedAt?: string;
  /** Receipt of the last publish to Microsoft 365 Copilot (Copilot Studio). */
  m365Copilot?: { envId: string; agentId: string; agentName: string; agentState?: string; channelId?: string; m365CopilotEnabled?: boolean; publishedAt: string };
  [k: string]: unknown;
}

const DA_SOURCE_TYPES: { value: DaSourceType; label: string; itemType: string }[] = [
  { value: 'warehouse', label: 'Warehouse', itemType: 'warehouse' },
  { value: 'lakehouse', label: 'Lakehouse', itemType: 'lakehouse' },
  { value: 'kql', label: 'KQL database', itemType: 'kql-database' },
  { value: 'semantic-model', label: 'Semantic model', itemType: 'semantic-model' },
  { value: 'ai-search', label: 'AI Search', itemType: 'ai-search-index' },
  { value: 'ontology', label: 'Ontology', itemType: 'ontology' },
  { value: 'graph', label: 'Graph model', itemType: 'graph-model' },
];
// Schema-selection label per type (Fabric exposes Tables/Views/Functions for
// SQL + Eventhouse, model name for semantic models, none for graph/ontology).
const DA_SCHEMA_LABEL: Record<DaSourceType, string> = {
  warehouse: 'Tables / views / functions in scope (comma-separated)',
  lakehouse: 'Tables in scope (comma-separated)',
  kql: 'Tables / materialized views / functions in scope (comma-separated)',
  'semantic-model': 'Tables / model in scope (comma-separated)',
  'ai-search': 'Index fields in scope (optional, comma-separated)',
  ontology: 'Ontology is queried whole — no table scoping',
  graph: 'Graph is queried whole — no node/edge scoping',
};
const DA_INSTRUCTION_TEMPLATE = '## General knowledge\n\n## Table descriptions\n\n## When asked about\n';

// `normalizeDaSources` / `guessDaSourceType` / DaSource(Type) are imported from
// `_family-utils` (vitest coverage at lib/editors/__tests__/family-utils.test.ts)
// so the legacy-string migration is unit-tested without the Fluent UI bundle.

interface DaTool {
  source: string; type?: string; action: string; query?: string;
  // Real-execution metadata (task-008): the query was run read-only on the
  // Azure-native backend; these are the actual results or an honest gate.
  executed?: boolean; rowCount?: number; columns?: string[]; rows?: unknown[][]; gate?: string;
}
interface DaChatMsg { role: 'user' | 'assistant'; content: string; query?: string; sourceUsed?: string; error?: boolean; usage?: { totalTokens?: number }; model?: string; tools?: DaTool[] }

export function DataAgentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty, lastSaveError } = useItemState<DataAgentState>('data-agent', id, {
    instructions: 'Route financial / aggregated metrics to the semantic model; raw exploration to the lakehouse / warehouse; log analysis to the KQL database.',
    sources: [],
    description: '',
    alias: '',
  });
  // Initial tab honors a ?tab= deep-link (the /data-agent pane's "Configure"
  // and "Publish…" actions route here with ?tab=copilot / ?tab=publish).
  const [tab, setTab] = useState<'build' | 'copilot' | 'test' | 'evaluate' | 'consume' | 'publish' | 'inspect' | 'monitor'>(() => {
    if (typeof window === 'undefined') return 'build';
    const t = new URLSearchParams(window.location.search).get('tab');
    return (t === 'copilot' || t === 'test' || t === 'evaluate' || t === 'consume' || t === 'publish' || t === 'inspect' || t === 'monitor') ? t : 'build';
  });

  // ---- source picker data (real Loom items) ----
  const [pickerType, setPickerType] = useState<DaSourceType>('warehouse');
  const [available, setAvailable] = useState<Record<string, { id: string; name: string }[]>>({});
  const [pickerLoading, setPickerLoading] = useState(false);
  const loadAvailable = useCallback(async (t: DaSourceType) => {
    const cfg = DA_SOURCE_TYPES.find((x) => x.value === t)!;
    setPickerLoading(true);
    try {
      const r = await fetch(`/api/items/by-type?types=${encodeURIComponent(cfg.itemType)}`);
      const j = await r.json();
      const items = (j.items || []).map((it: any) => ({ id: it.id, name: it.displayName || it.id }));
      setAvailable((prev) => ({ ...prev, [t]: items }));
    } catch { /* leave empty; user can still pick another type */ }
    finally { setPickerLoading(false); }
  }, []);
  useEffect(() => { if (!available[pickerType]) loadAvailable(pickerType); }, [pickerType, available, loadAvailable]);

  const [pickSel, setPickSel] = useState('');
  const addSource = () => {
    if (!pickSel || arr<DaSource>(state.sources).length >= 5) return;
    const opts = available[pickerType] || [];
    const chosen = opts.find((o) => o.id === pickSel);
    setState((p) => ({
      ...p,
      sources: [...arr<DaSource>(p.sources), {
        id: `${pickerType}:${pickSel}:${Date.now()}`,
        type: pickerType,
        name: chosen?.name || pickSel,
        tables: '', description: '', instructions: DA_INSTRUCTION_TEMPLATE, examples: [],
      }],
    }));
    setPickSel('');
  };
  const updateSource = (sid: string, patch: Partial<DaSource>) => {
    setState((p) => ({ ...p, sources: arr<DaSource>(p.sources).map((x) => x.id === sid ? { ...x, ...patch } : x) }));
  };
  const removeSource = (sid: string) => setState((p) => ({ ...p, sources: arr<DaSource>(p.sources).filter((x) => x.id !== sid) }));
  const updateSourceExamples = (sid: string, fn: (ex: { question: string; query: string }[]) => { question: string; query: string }[]) => {
    setState((p) => ({ ...p, sources: arr<DaSource>(p.sources).map((x) => x.id === sid ? { ...x, examples: fn(arr(x.examples)) } : x) }));
  };
  const addExample = (sid: string) => updateSourceExamples(sid, (ex) => [...ex, { question: '', query: '' }]);

  // ---- test chat ----
  const [chat, setChat] = useState<DaChatMsg[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  // Conversation history (persisted to Cosmos via /conversations).
  const [convId, setConvId] = useState<string | null>(null);
  const [convos, setConvos] = useState<{ id: string; title: string; updatedAt: string; turns: number }[]>([]);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const loadConvos = useCallback(async () => {
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/conversations`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setConvos(j.conversations || []);
    } catch { /* non-fatal */ }
  }, [id]);
  useEffect(() => { if (id && id !== 'new') loadConvos(); }, [id, loadConvos]);

  const saveConvo = useCallback(async (thread: DaChatMsg[]) => {
    if (!thread.length || id === 'new') return;
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/conversations`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: convId || undefined, messages: thread }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.ok && j.conversation?.id) { setConvId(j.conversation.id); loadConvos(); }
    } catch { /* non-fatal */ }
  }, [id, convId, loadConvos]);

  const loadConvo = useCallback(async (cid: string) => {
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/conversations?conversationId=${encodeURIComponent(cid)}`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok && Array.isArray(j.conversation?.messages)) {
        setChat(j.conversation.messages as DaChatMsg[]);
        setConvId(cid);
      }
    } catch { /* non-fatal */ }
  }, [id]);

  const newChat = useCallback(() => { setChat([]); setConvId(null); }, []);
  // Keep the latest turn in view as the thread grows / a turn lands.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, asking]);
  const canSend = canSendDaQuestion(question, asking);
  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || asking) return;
    if (dirty) await save();
    // Build history from the thread BEFORE we append the new user turn.
    const history = shapeDaHistory(chat);
    const userTurn: DaChatMsg = { role: 'user', content: q };
    setChat((c) => [...c, userTurn]);
    setQuestion(''); setAsking(true);
    let assistantTurn: DaChatMsg;
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, history }),
      });
      // Content-type guard: a 404/500 returns an HTML page, not JSON — calling
      // r.json() on that throws "Unexpected token <" and the answer is lost.
      const res = await safeModelJson<{ answer?: string; query?: string; sourceUsed?: string; hint?: string; usage?: { totalTokens?: number }; model?: string; tools?: DaTool[] }>(r);
      const j = res.data;
      if (res.ok && j) {
        assistantTurn = { role: 'assistant', content: String(j.answer ?? ''), query: j.query, sourceUsed: j.sourceUsed, usage: j.usage, model: j.model, tools: j.tools };
      } else {
        const detail = res.error || j?.error || `HTTP ${res.status}`;
        const hint = j?.hint ? `\n\n${j.hint}` : '';
        assistantTurn = { role: 'assistant', content: `${detail}${hint}`, error: true };
      }
    } catch (e: any) {
      assistantTurn = { role: 'assistant', content: e?.message || String(e), error: true };
    } finally { setAsking(false); }
    setChat((c) => [...c, assistantTurn]);
    // Persist the conversation (only when the turn succeeded) so it survives
    // reload + can be resumed from History.
    if (!assistantTurn.error) void saveConvo([...chat, userTurn, assistantTurn]);
  }, [question, asking, chat, dirty, save, id, saveConvo]);

  // ---- publish ----
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<any>(null);
  const publish = useCallback(async () => {
    setPublishing(true); setPublishResult(null);
    try {
      // Only persist when there are unsaved edits — a redundant save that fails
      // (e.g. transient) shouldn't block publishing an already-saved agent.
      if (dirty) {
        const saved = await save();
        if (!saved) {
          setPublishResult({ ok: false, error: `Couldn't save before publishing: ${lastSaveError() || 'unknown save error'}` });
          return;
        }
      }
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: state.description, alias: state.alias || undefined }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (!r.ok && j && j.ok === undefined) j.ok = false;
      setPublishResult(j);
      if (j.ok) await reload();
    } catch (e: any) { setPublishResult({ ok: false, error: e?.message || String(e) }); }
    finally { setPublishing(false); }
  }, [id, save, reload, dirty, lastSaveError, state.description, state.alias]);

  // ---- publish to Microsoft 365 Copilot (Copilot Studio) ----
  const [m365Envs, setM365Envs] = useState<{ id: string; displayName: string }[]>([]);
  const [m365EnvId, setM365EnvId] = useState('');
  const [m365EnvLoaded, setM365EnvLoaded] = useState(false);
  const [m365EnvError, setM365EnvError] = useState<string | null>(null);
  const [m365Available, setM365Available] = useState(true);
  const [m365Publishing, setM365Publishing] = useState(false);
  const [m365Result, setM365Result] = useState<any>(null);
  const loadM365Envs = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/m365-copilot`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) {
        const envs = (j.environments || []) as { id: string; displayName: string }[];
        setM365Envs(envs);
        setM365EnvError(j.envError || null);
        // Prefer the persisted env, then the configured default, then the first.
        const persisted = state.m365Copilot?.envId;
        setM365EnvId((cur) => cur || persisted || j.defaultEnvId || envs[0]?.id || '');
      } else {
        setM365EnvError(j?.error || `HTTP ${r.status}`);
      }
    } catch (e: any) { setM365EnvError(e?.message || String(e)); }
    finally { setM365EnvLoaded(true); }
  }, [id, state.m365Copilot]);
  useEffect(() => { if (tab === 'publish' && !m365EnvLoaded) loadM365Envs(); }, [tab, m365EnvLoaded, loadM365Envs]);
  const publishM365 = useCallback(async () => {
    setM365Publishing(true); setM365Result(null);
    try {
      if (dirty) {
        const saved = await save();
        if (!saved) { setM365Result({ ok: false, error: `Couldn't save before publishing: ${lastSaveError() || 'unknown save error'}` }); return; }
      }
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/m365-copilot`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId: m365EnvId || undefined, description: state.description, availableInM365Copilot: m365Available }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (!r.ok && j && j.ok === undefined) j.ok = false;
      setM365Result(j);
      if (j.ok) await reload();
    } catch (e: any) { setM365Result({ ok: false, error: e?.message || String(e) }); }
    finally { setM365Publishing(false); }
  }, [id, m365EnvId, m365Available, dirty, save, reload, lastSaveError, state.description]);

  // ---- delete this agent (owner-scoped via the item DELETE route) ----
  const [deleting, setDeleting] = useState(false);
  const deleteAgent = useCallback(async () => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this data agent? This removes the agent and its configuration permanently. This cannot be undone.')) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setPublishResult({ ok: false, error: `Delete failed: ${j?.error || `HTTP ${r.status}`}` });
        return;
      }
      // Back to the workspace list after a successful delete.
      if (typeof window !== 'undefined') window.location.href = '/workspaces';
    } catch (e: any) {
      setPublishResult({ ok: false, error: `Delete failed: ${e?.message || String(e)}` });
    } finally { setDeleting(false); }
  }, [id]);

  // ---- run-steps inspector (debug a PUBLISHED agent via the Foundry Agent Service) ----
  const [inspectAgent, setInspectAgent] = useState('');
  const [inspectQuestion, setInspectQuestion] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectResult, setInspectResult] = useState<any>(null);
  const [inspectGate, setInspectGate] = useState<string | null>(null);
  // Prefill the agent name from the last publish (artifactId) when available.
  useEffect(() => {
    if (publishResult?.artifactId && !inspectAgent) setInspectAgent(String(publishResult.artifactId));
  }, [publishResult, inspectAgent]);
  const runInspect = useCallback(async () => {
    const agent = inspectAgent.trim(); const q = inspectQuestion.trim();
    // The agent name is OPTIONAL now — without a published Foundry agent the
    // inspector runs the Azure-native grounded backend over this item's sources
    // (no Microsoft Fabric / published asst_ required). Only the question + the
    // item id are needed.
    if (!q || inspecting) return;
    setInspecting(true); setInspectResult(null); setInspectGate(null);
    try {
      const r = await fetch('/api/data-agent/run-steps', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: agent || undefined, question: q, id }),
      });
      const j = await r.json();
      if (r.status === 501 || j?.code === 'not_configured') { setInspectGate(j?.hint || j?.error || 'No AOAI model deployed. Deploy one from the AI Foundry hub.'); return; }
      setInspectResult(j);
    } catch (e: any) { setInspectResult({ ok: false, error: e?.message || String(e) }); }
    finally { setInspecting(false); }
  }, [inspectAgent, inspectQuestion, inspecting, id]);

  // One-time migration: if a legacy record persisted `sources` as a string (or
  // any non-array shape), rewrite state to a clean DaSource[] so the agent both
  // renders AND can be re-saved in the new schema. Runs after load settles.
  useEffect(() => {
    if (loading) return;
    if (state.sources !== undefined && !Array.isArray(state.sources)) {
      const migrated = normalizeDaSources(state.sources);
      setState((p) => ({ ...p, sources: migrated }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, state.sources]);

  const sources = normalizeDaSources(state.sources);
  const instrLen = (typeof state.instructions === 'string' ? state.instructions : '').length;

  // ---- evaluation (ground-truth set + runs) ----
  const evalSet = arr<DaEvalCase>(state.evalSet);
  const evalRuns = arr<DaEvalRun>(state.evalRuns);
  const [evaluating, setEvaluating] = useState(false);
  const [evalGate, setEvalGate] = useState<string | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const addEvalCase = () => setState((p) => ({ ...p, evalSet: [...arr<DaEvalCase>(p.evalSet), { question: '', expectedAnswer: '', expectedQuery: '' }] }));
  const updateEvalCase = (i: number, patch: Partial<DaEvalCase>) =>
    setState((p) => ({ ...p, evalSet: arr<DaEvalCase>(p.evalSet).map((c, j) => j === i ? { ...c, ...patch } : c) }));
  const removeEvalCase = (i: number) => setState((p) => ({ ...p, evalSet: arr<DaEvalCase>(p.evalSet).filter((_, j) => j !== i) }));
  const runEval = useCallback(async () => {
    const questions = arr<DaEvalCase>(state.evalSet).filter((c) => (c.question || '').trim());
    if (!questions.length || evaluating) return;
    setEvaluating(true); setEvalGate(null); setEvalError(null);
    try {
      if (dirty) await save();
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/evaluate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questions }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (r.status === 503 || j?.notDeployed) { setEvalGate(j?.hint || j?.error || 'No AOAI model deployed.'); return; }
      if (!j?.ok) { setEvalError(j?.error || `HTTP ${r.status}`); return; }
      // The route persisted the run server-side; reload to pull evalRuns, then select it.
      await reload();
      if (j.run?.id) setSelectedRunId(j.run.id);
    } catch (e: any) { setEvalError(e?.message || String(e)); }
    finally { setEvaluating(false); }
  }, [id, state.evalSet, evaluating, dirty, save, reload]);

  // ---- conversation starters (suggested prompts) ----
  const starters = arr<string>(state.conversationStarters);
  const addStarter = () => setState((p) => ({ ...p, conversationStarters: [...arr<string>(p.conversationStarters), ''] }));
  const updateStarter = (i: number, v: string) => setState((p) => ({ ...p, conversationStarters: arr<string>(p.conversationStarters).map((x, j) => j === i ? v : x) }));
  const removeStarter = (i: number) => setState((p) => ({ ...p, conversationStarters: arr<string>(p.conversationStarters).filter((_, j) => j !== i) }));

  // ---- consume (programmatic REST endpoint) ----
  const [snippetLang, setSnippetLang] = useState<'curl' | 'python' | 'js'>('curl');
  const [copied, setCopied] = useState(false);
  const consumeOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://<your-loom-host>';
  const consumePath = `/api/items/data-agent/${id}/chat`;
  const consumeUrl = `${consumeOrigin}${consumePath}`;
  const consumeSnippets: Record<'curl' | 'python' | 'js', string> = {
    curl:
      `curl -X POST '${consumeUrl}' \\\n` +
      `  -H 'content-type: application/json' \\\n` +
      `  -H 'cookie: loom_session=<your-session-cookie>' \\\n` +
      `  -d '{ "question": "What was total revenue by region last quarter?" }'`,
    python:
      `import requests\n\n` +
      `resp = requests.post(\n` +
      `    "${consumeUrl}",\n` +
      `    headers={"content-type": "application/json", "cookie": "loom_session=<your-session-cookie>"},\n` +
      `    json={"question": "What was total revenue by region last quarter?"},\n` +
      `)\n` +
      `data = resp.json()\n` +
      `print(data["answer"])          # grounded answer\n` +
      `print(data.get("query"))       # generated SQL / KQL\n` +
      `print(data.get("tools"))       # per-source trace`,
    js:
      `const resp = await fetch("${consumeUrl}", {\n` +
      `  method: "POST",\n` +
      `  headers: { "content-type": "application/json" },\n` +
      `  credentials: "include", // sends the Loom session cookie\n` +
      `  body: JSON.stringify({ question: "What was total revenue by region last quarter?" }),\n` +
      `});\n` +
      `const data = await resp.json();\n` +
      `console.log(data.answer, data.query, data.tools);`,
  };
  const copySnippet = useCallback(() => {
    try { navigator.clipboard?.writeText(consumeSnippets[snippetLang]); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }, [snippetLang, consumeSnippets]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Agent', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: 'Build', onClick: () => setTab('build') },
        { label: 'Config Copilot', onClick: () => setTab('copilot') },
        { label: 'Test chat', onClick: () => setTab('test') },
        { label: 'Evaluate', onClick: () => setTab('evaluate') },
        { label: 'Publish', onClick: () => setTab('publish') },
        { label: 'Consume', onClick: () => setTab('consume') },
        { label: 'Run inspector', onClick: () => setTab('inspect') },
        { label: 'Monitoring', onClick: () => setTab('monitor') },
      ]},
    ]},
  ], [save, saving, dirty]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            <Tab value="build">Build ({sources.length}/5 sources)</Tab>
            <Tab value="copilot">Config Copilot</Tab>
            <Tab value="test">Test chat</Tab>
            <Tab value="evaluate">Evaluate</Tab>
            <Tab value="publish">Publish</Tab>
            <Tab value="consume">Consume</Tab>
            <Tab value="inspect">Run inspector</Tab>
            <Tab value="monitor">Monitoring</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}

          {tab === 'build' && (
            <>
              {/* Agent identity + routing instructions */}
              <div className={s.daSection}>
                <div className={s.daSectionHead}>
                  <span className={s.daSectionIcon}><Bot24Regular /></span>
                  <Subtitle2>Agent</Subtitle2>
                </div>
                <Field label="Agent name / alias" hint="A friendly name for this data agent — shown in chat and used when publishing. Leave blank to use the item's name.">
                  <Input
                    value={state.alias || ''}
                    maxLength={128}
                    onChange={(_, d) => setState((p) => ({ ...p, alias: d.value }))}
                    placeholder={item.displayName || 'e.g. Casino Revenue Analyst'}
                  />
                </Field>
                <Field label={`Instructions (${instrLen}/15000)`} hint="Declare which source handles which kind of question — the agent uses this to route.">
                  <Textarea
                    value={state.instructions} maxLength={15000} rows={5}
                    onChange={(_, d) => setState((p) => ({ ...p, instructions: d.value }))}
                    placeholder="Route financial metrics to the semantic model; raw exploration to the lakehouse; log analysis to KQL…"
                  />
                </Field>
              </div>

              {/* Grounded data sources */}
              <div className={s.daSection}>
                <div className={s.daSectionHead}>
                  <span className={s.daSectionIcon}><Database20Regular /></span>
                  <Subtitle2>Data sources</Subtitle2>
                  <Badge appearance="tint" color={sources.length >= 5 ? 'warning' : 'brand'}>{sources.length}/5</Badge>
                </div>
                <div className={s.daAddBar}>
                  <Field label="Type">
                    <Dropdown value={DA_SOURCE_TYPES.find((t) => t.value === pickerType)?.label} selectedOptions={[pickerType]}
                      onOptionSelect={(_, d) => { if (d.optionValue) { setPickerType(d.optionValue as DaSourceType); setPickSel(''); } }}>
                      {DA_SOURCE_TYPES.map((t) => <Option key={t.value} value={t.value}>{t.label}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Item" style={{ minWidth: 220 }}>
                    <Dropdown value={(available[pickerType] || []).find((o) => o.id === pickSel)?.name || ''} selectedOptions={pickSel ? [pickSel] : []}
                      placeholder={pickerLoading ? 'Loading…' : ((available[pickerType] || []).length ? 'Select…' : 'None found')}
                      onOptionSelect={(_, d) => d.optionValue && setPickSel(d.optionValue)}>
                      {(available[pickerType] || []).map((o) => <Option key={o.id} value={o.id}>{o.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Button appearance="primary" icon={<Add20Regular />} onClick={addSource} disabled={!pickSel || sources.length >= 5}>Add source</Button>
                </div>

                {sources.map((src) => (
                  <div key={src.id} className={s.daSrcCard}>
                    <div className={s.daSrcHead}>
                      <span className={s.daSrcIcon}><Database20Regular /></span>
                      <strong>{src.name}</strong>
                      <Badge appearance="tint" color="brand">{DA_SOURCE_TYPES.find((t) => t.value === src.type)?.label || src.type}</Badge>
                      <div style={{ flex: 1 }} />
                      <Button size="small" appearance="subtle" onClick={() => removeSource(src.id)} style={{ color: tokens.colorPaletteRedForeground1 }}>Remove</Button>
                    </div>
                    <Field label="Description" hint="Helps the agent route questions to this source.">
                      <Input value={src.description || ''} onChange={(_, d) => updateSource(src.id, { description: d.value })} placeholder="Finance facts: revenue, margin, bookings by region & quarter." />
                    </Field>
                    {src.type === 'ontology' || src.type === 'graph' ? (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        {src.type === 'graph' ? 'Graphs are queried whole — no node/edge scoping.' : 'Ontologies are queried whole — no subset scoping.'}
                      </Caption1>
                    ) : (
                      <Field label={DA_SCHEMA_LABEL[src.type]}>
                        <Input value={src.tables || ''} onChange={(_, d) => updateSource(src.id, { tables: d.value })} placeholder="dim_date, fact_sales" />
                      </Field>
                    )}
                    <Field label="Source instructions">
                      <Textarea value={src.instructions || ''} rows={4} onChange={(_, d) => updateSource(src.id, { instructions: d.value })} />
                    </Field>
                    {daSupportsExampleQueries(src.type) ? (
                      <Field label="Example question → query pairs (few-shot)">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalSNudge }}>
                          {arr<{ question: string; query: string }>(src.examples).map((ex, i) => (
                            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: tokens.spacingHorizontalSNudge }}>
                              <Input value={ex.question} placeholder="question" onChange={(_, d) => updateSourceExamples(src.id, (arr) => arr.map((e, j) => j === i ? { ...e, question: d.value } : e))} />
                              <Input value={ex.query} placeholder="SQL / KQL / GQL" onChange={(_, d) => updateSourceExamples(src.id, (arr) => arr.map((e, j) => j === i ? { ...e, query: d.value } : e))} />
                              <Button size="small" appearance="subtle" onClick={() => updateSourceExamples(src.id, (arr) => arr.filter((_, j) => j !== i))}>×</Button>
                            </div>
                          ))}
                          <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => addExample(src.id)} style={{ alignSelf: 'flex-start' }}>Example</Button>
                        </div>
                      </Field>
                    ) : (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        {src.type === 'semantic-model'
                          ? 'Semantic models use Power BI “Prep for AI” Verified Answers instead of example queries.'
                          : 'Example queries are not supported for this source.'}
                      </Caption1>
                    )}
                  </div>
                ))}
                {sources.length === 0 && (
                  <MessageBar intent="info"><MessageBarBody><Sparkle20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalSNudge }} />Attach up to five typed sources. Each becomes a grounded tool for the agent. Test chat and Publish both need at least one.</MessageBarBody></MessageBar>
                )}
              </div>
              <SaveBar
                saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
                extraRight={
                  <Button appearance="subtle" disabled={deleting} onClick={deleteAgent}
                    style={{ color: tokens.colorPaletteRedForeground1 }}>
                    {deleting ? 'Deleting…' : 'Delete agent'}
                  </Button>
                }
              />
            </>
          )}

          {tab === 'copilot' && (
            <DataAgentConfigCopilotPanel
              id={id}
              sources={sources}
              ensureSaved={async () => { if (dirty) await save(); }}
              onApply={async (sourceId, suggestion) => {
                // Server already persisted; mirror into local state so Build + Test
                // reflect the applied examples/descriptions immediately, then re-save
                // the exact merged snapshot (idempotent — keeps local + Cosmos identical
                // without a stale-state overwrite).
                const mergedSources = mergeSuggestionIntoSources(
                  arr<DaSource>(state.sources) as unknown as Record<string, unknown>[],
                  sourceId,
                  suggestion,
                ) as unknown as DaSource[];
                const nextState = { ...state, sources: mergedSources };
                setState(() => nextState);
                await save(nextState);
              }}
            />
          )}

          {tab === 'test' && (
            <div className={s.chatShell}>
              <div className={s.chatHead}>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                  <Subtitle2>Test chat</Subtitle2>
                  <Badge appearance="tint" color="brand">live · grounded</Badge>
                  <div style={{ flex: 1 }} />
                  {convos.length > 0 && (
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <Button size="small" appearance="subtle">History ({convos.length})</Button>
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          {convos.slice(0, 25).map((cv) => (
                            <MenuItem key={cv.id} onClick={() => loadConvo(cv.id)}>
                              {cv.title} · {cv.turns} msg · {new Date(cv.updatedAt).toLocaleDateString()}
                            </MenuItem>
                          ))}
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  )}
                  <Button size="small" appearance="subtle" onClick={() => { newChat(); setQuestion(''); }} disabled={asking || (chat.length === 0 && !question)}>+ New thread</Button>
                </div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Each turn runs against the live AOAI deployment on the Foundry hub, grounded on the {sources.length} source{sources.length === 1 ? '' : 's'} + instructions in Build.
                </Caption1>
                {sources.length === 0 && (
                  <MessageBar intent="warning"><MessageBarBody>No data sources attached yet — answers will be ungrounded. Add at least one source in the <strong>Build</strong> tab for real grounded responses.</MessageBarBody></MessageBar>
                )}
              </div>

              <div ref={threadRef} className={s.chatThread} aria-live="polite">
                {chat.length === 0 && !asking && (
                  <div style={{ margin: 'auto', textAlign: 'center', color: tokens.colorNeutralForeground3 }}>
                    <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>Ask the agent a question to start a thread.</Body1>
                    {starters.filter((p) => p.trim()).length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, justifyContent: 'center', marginTop: tokens.spacingVerticalS }}>
                        {starters.filter((p) => p.trim()).slice(0, 6).map((p, i) => (
                          <Button key={i} size="small" appearance="outline" icon={<Sparkle20Regular />}
                            onClick={() => setQuestion(p)}>{p}</Button>
                        ))}
                      </div>
                    ) : (
                      <Caption1>e.g. “What was total revenue by region last quarter?”</Caption1>
                    )}
                  </div>
                )}
                {chat.map((m, i) => {
                  const tools = m.tools && m.tools.length ? m.tools : (m.query || m.sourceUsed ? [{ source: m.sourceUsed || 'source', action: 'query', query: m.query } as DaTool] : []);
                  const srcLabel = !m.error
                    ? (tools.length > 1 ? ` · ${tools.length} sources` : m.sourceUsed ? ` · source: ${m.sourceUsed}` : '')
                    : '';
                  return (
                  <div key={i} className={m.role === 'user' ? s.chatRowUser : s.chatRowBot}>
                    <span className={s.chatMeta}>{m.role === 'user' ? 'You' : m.error ? 'Agent · error' : 'Agent'}{srcLabel}{m.model && !m.error ? ` · ${m.model}` : ''}{m.usage?.totalTokens && !m.error ? ` · ${m.usage.totalTokens} tokens` : ''}</span>
                    <div className={m.role === 'user' ? s.bubbleUser : m.error ? s.bubbleErr : s.bubbleBot}>
                      {m.content || (m.error ? 'Unknown error' : '')}
                    </div>
                    {m.role === 'assistant' && !m.error && tools.length > 0 && (
                      <details style={{ marginTop: tokens.spacingVerticalXXS }} open={tools.length > 1}>
                        <summary style={{ cursor: 'pointer', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 }}>
                          🛠 Tools used ({tools.length})
                        </summary>
                        {tools.map((t, ti) => (
                          <div key={ti} style={{ marginTop: tokens.spacingVerticalXS }}>
                            <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
                              <strong>{t.source}</strong>{t.type ? ` · ${t.type}` : ''} · {t.action}
                              {t.executed && (
                                <Badge appearance="tint" color="success" size="extra-small" style={{ marginLeft: tokens.spacingHorizontalSNudge }}>
                                  ✓ ran · {t.rowCount ?? 0} row{t.rowCount === 1 ? '' : 's'}
                                </Badge>
                              )}
                            </Caption1>
                            {t.query && <pre className={s.chatSource}>{t.query}</pre>}
                            {t.executed && t.columns && t.columns.length > 0 && t.rows && t.rows.length > 0 && (
                              <DataAgentResultViz tool={t} />
                            )}
                            {!t.executed && t.gate && (
                              <Caption1 style={{ color: tokens.colorPaletteYellowForeground1, display: 'block', marginTop: tokens.spacingVerticalXXS }}>
                                ⚠ {t.gate}
                              </Caption1>
                            )}
                          </div>
                        ))}
                      </details>
                    )}
                  </div>
                  );
                })}
                {asking && (
                  <div className={s.chatRowBot}>
                    <span className={s.chatMeta}>Agent</span>
                    <div className={s.bubbleBot} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                      <Spinner size="tiny" /> Thinking…
                    </div>
                  </div>
                )}
              </div>

              <div className={s.chatComposer}>
                <Textarea
                  value={question}
                  onChange={(_, d) => setQuestion(d.value)}
                  placeholder="Ask the agent…  (Enter to send · Shift+Enter for a new line)"
                  resize="none"
                  rows={2}
                  textarea={{ style: { maxHeight: 120, overflowY: 'auto' } }}
                  style={{ flex: 1 }}
                  disabled={asking}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (canSend) ask();
                    }
                  }}
                />
                <Button appearance="primary" onClick={ask} disabled={!canSend}>{asking ? 'Sending…' : 'Send'}</Button>
              </div>
            </div>
          )}

          {tab === 'publish' && (
            <>
              <Subtitle2>Publish to Foundry Agent Service</Subtitle2>
              <Caption1>Publishing upserts a prompt-agent (instructions + typed sources as tools) into the Foundry project. Consumers (Foundry agents, Copilot Studio) read the description to decide when to call this agent.</Caption1>
              <Caption1 style={{ marginTop: tokens.spacingVerticalSNudge }}>Description (orchestrators see this)</Caption1>
              <Textarea value={state.description || ''} rows={3} onChange={(_, d) => setState((p) => ({ ...p, description: d.value }))} placeholder="Answers finance questions grounded on the FY warehouse + revenue semantic model." />
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS }}>
                <Button appearance="primary" onClick={publish} disabled={publishing || saving || sources.length === 0}>{publishing ? 'Publishing…' : 'Publish'}</Button>
              </div>
              {state.publishedAt && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', marginTop: tokens.spacingVerticalSNudge }}>
                  <Badge appearance="filled" color="success">published</Badge>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{new Date(state.publishedAt).toLocaleString()}</Caption1>
                </div>
              )}
              {publishResult && (
                <MessageBar intent={publishResult.ok ? 'success' : publishResult.deferred ? 'warning' : 'error'}>
                  <MessageBarBody>
                    <MessageBarTitle>
                      {publishResult.ok ? 'Published' : publishResult.deferred ? 'Foundry Agent Service not configured' : 'Publish failed'}
                    </MessageBarTitle>
                    {publishResult.ok && (
                      <div style={{ marginTop: tokens.spacingVerticalXS }}>
                        Connect from Foundry / Copilot Studio with this GUID pair (mark both as secrets):
                        <div style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, marginTop: tokens.spacingVerticalXS }}>
                          workspace-id (project): <strong>{publishResult.workspaceId}</strong><br />
                          artifact-id (agent): <strong>{publishResult.artifactId}</strong>
                        </div>
                        <Caption1 style={{ marginTop: tokens.spacingVerticalSNudge, display: 'block' }}>
                          Copilot Studio: Agents → + Add → Microsoft Fabric → pick this published agent.
                          Foundry: Management Center → Connected resources → new Microsoft Fabric connection.
                        </Caption1>
                      </div>
                    )}
                    {publishResult.error && <div>{publishResult.error}</div>}
                    {publishResult.hint && <div style={{ marginTop: tokens.spacingVerticalXS }}><em>Hint:</em> {publishResult.hint}</div>}
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* ---- Publish to Microsoft 365 Copilot (Copilot Studio) ---- */}
              <div role="separator" aria-orientation="horizontal" style={{ height: 1, background: tokens.colorNeutralStroke2, margin: `${tokens.spacingVerticalXL} 0` }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <Subtitle2>Publish to Microsoft 365 Copilot</Subtitle2>
                <Badge appearance="tint" color="brand">Copilot Studio</Badge>
              </div>
              <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXXS, maxWidth: 720, color: tokens.colorNeutralForeground2 }}>
                Surfaces this data agent as a Copilot Studio agent and enables the Teams + Microsoft 365 Copilot channel,
                so users can discover and chat with it in M365 Copilot. After publishing, a tenant admin approves it in the
                Microsoft 365 admin center (Agents → All agents → Requests).
              </Caption1>
              {!m365EnvLoaded && <Spinner size="tiny" label="Loading Power Platform environments…" labelPosition="after" style={{ marginTop: tokens.spacingVerticalS }} />}
              {m365EnvLoaded && m365Envs.length === 0 && (
                <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS }}>
                  <MessageBarBody>
                    <MessageBarTitle>No Power Platform environment available</MessageBarTitle>
                    <div>
                      Microsoft 365 Copilot publishing requires a Dataverse-enabled Power Platform environment with Copilot Studio enabled.
                      Set <code>LOOM_COPILOT_STUDIO_ENVIRONMENT_ID</code> and the Dataverse app-user creds
                      (<code>LOOM_DATAVERSE_CLIENT_ID</code> / <code>LOOM_DATAVERSE_CLIENT_SECRET</code> / <code>LOOM_DATAVERSE_TENANT_ID</code>) on the console app.
                    </div>
                    {m365EnvError && <div style={{ marginTop: tokens.spacingVerticalXS }}><em>Detail:</em> {m365EnvError}</div>}
                  </MessageBarBody>
                </MessageBar>
              )}
              {m365EnvLoaded && m365Envs.length > 0 && (
                <>
                  <Field label="Power Platform environment" style={{ marginTop: tokens.spacingVerticalS, maxWidth: 480 }}>
                    <Dropdown
                      value={m365Envs.find((e) => e.id === m365EnvId)?.displayName || ''}
                      selectedOptions={m365EnvId ? [m365EnvId] : []}
                      onOptionSelect={(_, d) => d.optionValue && setM365EnvId(d.optionValue)}
                      placeholder="Select an environment"
                    >
                      {m365Envs.map((e) => <Option key={e.id} value={e.id}>{e.displayName}</Option>)}
                    </Dropdown>
                  </Field>
                  <Switch
                    checked={m365Available}
                    onChange={(_, d) => setM365Available(d.checked)}
                    label="Make agent available in Microsoft 365 Copilot (uncheck for Teams only)"
                    style={{ marginTop: tokens.spacingVerticalXS }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalM, flexWrap: 'wrap' }}>
                    <Button
                      appearance="primary"
                      onClick={publishM365}
                      disabled={m365Publishing || saving || !m365EnvId || sources.length === 0}
                      title={
                        sources.length === 0 ? 'Add at least one data source on the Build tab before publishing.'
                        : !m365EnvId ? 'Select a Power Platform environment first.'
                        : undefined
                      }
                    >
                      {m365Publishing ? 'Publishing to M365 Copilot…' : 'Publish to M365 Copilot'}
                    </Button>
                    {m365Publishing && <Spinner size="tiny" />}
                    {sources.length === 0 && (
                      <Caption1 style={{ color: tokens.colorPaletteYellowForeground1 }}>
                        Add at least one data source on the Build tab before publishing.
                      </Caption1>
                    )}
                  </div>
                </>
              )}
              {state.m365Copilot?.publishedAt && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', marginTop: tokens.spacingVerticalSNudge }}>
                  <Badge appearance="filled" color="success">M365 Copilot</Badge>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Published {new Date(state.m365Copilot.publishedAt).toLocaleString()} · agent <code>{state.m365Copilot.agentName}</code>
                  </Caption1>
                </div>
              )}
              {m365Result && (
                <MessageBar intent={m365Result.ok ? 'success' : m365Result.deferred ? 'warning' : 'error'} style={{ marginTop: tokens.spacingVerticalS }}>
                  <MessageBarBody>
                    <MessageBarTitle>
                      {m365Result.ok ? 'Published to Microsoft 365 Copilot' : m365Result.deferred ? 'Copilot Studio not configured' : 'M365 Copilot publish failed'}
                    </MessageBarTitle>
                    {m365Result.ok && (
                      <div style={{ marginTop: tokens.spacingVerticalXS }}>
                        Copilot Studio agent <strong>{m365Result.agentName}</strong> ({m365Result.agentState || 'published'}) is now on the
                        Teams + Microsoft 365 Copilot channel{m365Result.m365CopilotEnabled ? ' with M365 Copilot enabled' : ' (Teams only)'}.
                      </div>
                    )}
                    {m365Result.error && <div>{m365Result.error}</div>}
                    {m365Result.hint && <div style={{ marginTop: tokens.spacingVerticalXS }}><em>Next:</em> {m365Result.hint}</div>}
                  </MessageBarBody>
                </MessageBar>
              )}
            </>
          )}

          {tab === 'inspect' && (
            <>
              <Subtitle2>Run-steps inspector</Subtitle2>
              <Caption1>Run a question through a PUBLISHED Foundry agent and trace the run steps it executed (tool calls / queries / message creation). Requires the agent to be published and LOOM_FOUNDRY_PROJECT_ENDPOINT configured.</Caption1>
              {inspectGate && (
                <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS }}>
                  <MessageBarBody>
                    <MessageBarTitle>Foundry Agent Service not configured</MessageBarTitle>
                    <div>{inspectGate}</div>
                  </MessageBarBody>
                </MessageBar>
              )}
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: tokens.spacingVerticalS }}>
                <Field label="Published agent (name / artifact id)">
                  <Input value={inspectAgent} onChange={(_, d) => setInspectAgent(d.value)} placeholder="from Publish (artifact-id)" style={{ minWidth: 300 }} />
                </Field>
              </div>
              <Textarea value={inspectQuestion} rows={2} onChange={(_, d) => setInspectQuestion(d.value)} placeholder="Ask a question to trace through the agent…" style={{ marginTop: tokens.spacingVerticalS }} />
              <div style={{ marginTop: tokens.spacingVerticalS }}>
                <Button appearance="primary" onClick={runInspect} disabled={inspecting || !inspectAgent.trim() || !inspectQuestion.trim()}>{inspecting ? 'Running…' : 'Run + inspect'}</Button>
              </div>
              {inspectResult && inspectResult.ok && inspectResult.data && (
                <div style={{ marginTop: tokens.spacingVerticalM }}>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Badge appearance="filled" color={inspectResult.data.status === 'completed' ? 'success' : inspectResult.data.status === 'failed' ? 'danger' : 'warning'}>{inspectResult.data.status}</Badge>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>run {inspectResult.data.runId}</Caption1>
                  </div>
                  {inspectResult.data.lastError && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalSNudge }}><MessageBarBody>{inspectResult.data.lastError}</MessageBarBody></MessageBar>}
                  {inspectResult.data.answer && (
                    <div style={{ marginTop: tokens.spacingVerticalS }}><Subtitle2>Answer</Subtitle2><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{inspectResult.data.answer}</div></div>
                  )}
                  <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Run steps ({inspectResult.data.steps?.length || 0})</Subtitle2>
                  {(inspectResult.data.steps || []).map((st: any, i: number) => (
                    <div key={st.id || i} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalSNudge }}>
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
                        <Badge appearance="outline">{st.type}</Badge>
                        <Badge appearance="filled" color={st.status === 'completed' ? 'success' : st.status === 'failed' ? 'danger' : 'informative'}>{st.status}</Badge>
                      </div>
                      {(st.toolCalls || []).map((tc: any, j: number) => (
                        <div key={j} style={{ marginTop: tokens.spacingVerticalSNudge, fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, minWidth: 0, overflowWrap: 'anywhere' }}>
                          <div><strong>{tc.type}{tc.name ? ` · ${tc.name}` : ''}</strong></div>
                          {tc.input && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: tokens.colorNeutralForeground3 }}>{tc.input}</div>}
                          {tc.output && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{tc.output}</div>}
                        </div>
                      ))}
                      {st.error && <div style={{ color: tokens.colorPaletteRedForeground1, marginTop: tokens.spacingVerticalXS }}>{st.error}</div>}
                    </div>
                  ))}
                </div>
              )}
              {inspectResult && !inspectResult.ok && !inspectGate && (
                <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS }}><MessageBarBody>{inspectResult.error || 'Run failed'}</MessageBarBody></MessageBar>
              )}
            </>
          )}

          {tab === 'evaluate' && (() => {
            const selectedRun = evalRuns.find((r) => r.id === selectedRunId) || evalRuns[0] || null;
            const validCases = evalSet.filter((c) => (c.question || '').trim()).length;
            return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
              <div className={s.daSection}>
                <div className={s.daSectionHead}>
                  <span className={s.daSectionIcon}><CheckmarkCircle20Regular /></span>
                  <Subtitle2>Evaluation</Subtitle2>
                  <Badge appearance="tint" color="brand">live · grounded · AOAI judge</Badge>
                </div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Author a ground-truth set, then run every question through the live grounded agent and score each answer with an AOAI judge (correctness + query match). Runs persist to this agent.
                </Caption1>
                <Table aria-label="Ground-truth set" size="small">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Question</TableHeaderCell>
                    <TableHeaderCell>Expected answer (optional)</TableHeaderCell>
                    <TableHeaderCell>Expected query (optional)</TableHeaderCell>
                    <TableHeaderCell />
                  </TableRow></TableHeader>
                  <TableBody>
                    {evalSet.map((c, i) => (
                      <TableRow key={i}>
                        <TableCell><Textarea value={c.question} rows={2} onChange={(_, d) => updateEvalCase(i, { question: d.value })} placeholder="What was total revenue by region last quarter?" /></TableCell>
                        <TableCell><Textarea value={c.expectedAnswer || ''} rows={2} onChange={(_, d) => updateEvalCase(i, { expectedAnswer: d.value })} placeholder="(optional) gold answer" /></TableCell>
                        <TableCell><Textarea value={c.expectedQuery || ''} rows={2} onChange={(_, d) => updateEvalCase(i, { expectedQuery: d.value })} placeholder="(optional) gold SQL / KQL" /></TableCell>
                        <TableCell><Button size="small" appearance="subtle" onClick={() => removeEvalCase(i)}>×</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addEvalCase}>Add question</Button>
                  <div style={{ flex: 1 }} />
                  <Button appearance="primary" icon={<Play20Regular />} onClick={runEval}
                    disabled={evaluating || validCases === 0 || sources.length === 0}>
                    {evaluating ? `Evaluating ${validCases}…` : `Run evaluation (${validCases})`}
                  </Button>
                </div>
                {sources.length === 0 && (
                  <MessageBar intent="warning"><MessageBarBody>Attach at least one data source on the <strong>Build</strong> tab before evaluating.</MessageBarBody></MessageBar>
                )}
                {evalGate && (
                  <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>No AOAI model deployed</MessageBarTitle><div>{evalGate}</div></MessageBarBody></MessageBar>
                )}
                {evalError && (
                  <MessageBar intent="error"><MessageBarBody>{evalError}</MessageBarBody></MessageBar>
                )}
              </div>

              {selectedRun ? (
                <div className={s.daSection}>
                  <div className={s.daSectionHead}>
                    <span className={s.daSectionIcon}><DataTrending20Regular /></span>
                    <Subtitle2>Results</Subtitle2>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{new Date(selectedRun.ranAt).toLocaleString()}{selectedRun.model ? ` · ${selectedRun.model}` : ''}</Caption1>
                  </div>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalL, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ width: 96, height: 96, borderRadius: '50%', background: `conic-gradient(${tokens.colorBrandStroke1} ${selectedRun.accuracy * 3.6}deg, ${tokens.colorNeutralBackground3} 0deg)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <div style={{ width: 70, height: 70, borderRadius: '50%', background: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                        <Subtitle2>{selectedRun.accuracy}%</Subtitle2>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>accuracy</Caption1>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                      <Badge appearance="filled" color="success">{selectedRun.passed} passed</Badge>
                      <Badge appearance="filled" color="danger">{selectedRun.total - selectedRun.passed} failed</Badge>
                      <Badge appearance="outline">{selectedRun.total} total</Badge>
                    </div>
                  </div>
                  <Table aria-label="Evaluation results" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Question</TableHeaderCell>
                      <TableHeaderCell>Verdict</TableHeaderCell>
                      <TableHeaderCell>Agent answer</TableHeaderCell>
                      <TableHeaderCell>Generated query</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {selectedRun.results.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell><div style={{ maxWidth: 220, overflowWrap: 'anywhere' }}>{r.question}</div></TableCell>
                          <TableCell>
                            <Badge appearance="filled" color={r.pass ? 'success' : 'danger'}>{r.pass ? 'pass' : 'fail'} · {Math.round(r.score * 100)}%</Badge>
                            {r.rationale && <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXXS }}>{r.rationale}</Caption1>}
                          </TableCell>
                          <TableCell><div style={{ maxWidth: 280, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.error ? `⚠ ${r.error}` : r.answer}</div></TableCell>
                          <TableCell>{r.query ? <pre className={s.chatSource}>{r.query}</pre> : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {evalRuns.length > 1 && (
                    <>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Run history</Caption1>
                      <TileGrid minTileWidth={200}>
                        {evalRuns.map((run) => (
                          <Card key={run.id} onClick={() => setSelectedRunId(run.id)}
                            style={{ cursor: 'pointer', borderColor: run.id === selectedRun.id ? tokens.colorBrandStroke1 : undefined }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                                <Subtitle2>{run.accuracy}%</Subtitle2>
                                <Badge appearance="tint" color={run.accuracy >= 80 ? 'success' : run.accuracy >= 50 ? 'warning' : 'danger'}>{run.passed}/{run.total}</Badge>
                              </div>
                              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{new Date(run.ranAt).toLocaleString()}</Caption1>
                            </div>
                          </Card>
                        ))}
                      </TileGrid>
                    </>
                  )}
                </div>
              ) : (
                <EmptyState icon={<CheckmarkCircle20Regular />} title="No evaluation runs yet"
                  body="Add ground-truth questions above and run an evaluation to score the agent's grounded answers against the live backend."
                  primaryAction={{ label: evaluating ? 'Evaluating…' : 'Run evaluation', onClick: runEval }} />
              )}
              <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
            </div>
            );
          })()}

          {tab === 'consume' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
              <div className={s.daSection}>
                <div className={s.daSectionHead}>
                  <span className={s.daSectionIcon}><Link20Regular /></span>
                  <Subtitle2>Consume programmatically</Subtitle2>
                  <Badge appearance="tint" color="brand">grounded REST</Badge>
                </div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  This agent is reachable as a stable Loom REST endpoint. POST a question; get the grounded answer, the generated query, and the per-source trace — the same backend the Test chat uses. Calls run read-only under the caller&apos;s Entra identity (RBAC honored).
                </Caption1>
                <Field label="Endpoint">
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Badge appearance="filled" color="brand">POST</Badge>
                    <code style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all', color: tokens.colorNeutralForeground1 }}>{consumePath}</code>
                  </div>
                </Field>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Dropdown value={snippetLang === 'curl' ? 'cURL' : snippetLang === 'python' ? 'Python' : 'JavaScript'} selectedOptions={[snippetLang]}
                    onOptionSelect={(_, d) => d.optionValue && setSnippetLang(d.optionValue as 'curl' | 'python' | 'js')} style={{ minWidth: 160 }}>
                    <Option value="curl">cURL</Option>
                    <Option value="python">Python</Option>
                    <Option value="js">JavaScript</Option>
                  </Dropdown>
                  <div style={{ flex: 1 }} />
                  <Button size="small" appearance="outline" onClick={copySnippet}>{copied ? 'Copied ✓' : 'Copy'}</Button>
                </div>
                <pre className={s.chatSource} style={{ whiteSpace: 'pre', maxHeight: 280, overflow: 'auto' }}>{consumeSnippets[snippetLang]}</pre>
                <MessageBar intent="info"><MessageBarBody>
                  For cross-tenant / external consumers (AI Foundry, Copilot Studio, M365 Copilot), publish the agent on the <strong>Publish</strong> tab — that exposes a managed Foundry Agent Service / Copilot Studio endpoint with its own auth.
                </MessageBarBody></MessageBar>
              </div>

              <div className={s.daSection}>
                <div className={s.daSectionHead}>
                  <span className={s.daSectionIcon}><Sparkle20Regular /></span>
                  <Subtitle2>Conversation starters</Subtitle2>
                </div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Suggested prompts shown to consumers and in the Test chat empty state. Saved with the agent.</Caption1>
                {starters.map((p, i) => (
                  <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
                    <Input value={p} style={{ flex: 1 }} onChange={(_, d) => updateStarter(i, d.value)} placeholder="e.g. Which region grew fastest last quarter?" />
                    <Button size="small" appearance="subtle" onClick={() => removeStarter(i)}>×</Button>
                  </div>
                ))}
                <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addStarter} style={{ alignSelf: 'flex-start' }}>Add starter</Button>
              </div>

              <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
            </div>
          )}

          {tab === 'monitor' && <DataAgentMonitoringPanel id={id} />}
        </div>
      </>
    } />
  );
}

// ----- Data Agent → Monitoring (Wave-B merge #6) --------------------------------
// operations-agent's monitoring capability folds into data-agent here, OPTIONALLY:
// a Monitoring tab that creates + lists Azure-native scheduled-query alert rules
// (Microsoft.Insights/scheduledQueryRules + action group) for this agent's data.
// Backend is the EXISTING activator rules route — no new BFF route:
//   GET  /api/items/activator/[id]/rules?workspaceId=...   → MonitorRuleRecord[]
//   POST /api/items/activator/[id]/rules?workspaceId=...    → create one rule
//   POST .../rules?workspaceId=&trigger=<ruleId>            → run the rule's KQL now
// Per no-fabric-dependency.md the default backend is Azure Monitor (no Fabric).
// The route's honest Monitor infra-gate (set LOOM_LOG_ANALYTICS_RESOURCE_ID /
// LOOM_ALERT_RG, grant Monitoring Contributor) is surfaced VERBATIM. The
// workspaceId is read from the page-primed ['item','data-agent',id] React Query
// cache (useItemState doesn't expose it). OperationsAgentEditor is untouched and
// stays registered so already-created operations-agent instances open as before.
const DA_SEVERITY_OPTS: { value: number; label: string }[] = [
  { value: 0, label: '0 — Critical' },
  { value: 1, label: '1 — Error' },
  { value: 2, label: '2 — Warning' },
  { value: 3, label: '3 — Informational' },
  { value: 4, label: '4 — Verbose' },
];
const DA_FREQ_OPTS = ['PT5M', 'PT15M', 'PT30M', 'PT1H', 'PT6H', 'P1D'];
const DA_WINDOW_OPTS = ['PT5M', 'PT15M', 'PT30M', 'PT1H', 'PT6H', 'PT24H'];

function DataAgentMonitoringPanel({ id }: { id: string }) {
  const s = useStyles();
  // workspaceId comes from the page-primed item record (the page hydrates
  // ['item','data-agent',id]); read the SAME key so we reuse that cache and the
  // activator rules route gets the required ?workspaceId=.
  const itemQ = useQuery({
    queryKey: ['item', 'data-agent', id],
    queryFn: () => getItem('data-agent', id),
    enabled: !!id && id !== 'new',
  });
  const workspaceId = itemQ.data?.workspaceId || '';

  const [rules, setRules] = useState<MonitorRuleRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ reason?: string; remediation?: string } | null>(null);

  // New-rule form (no JSON — typed fields mirroring the activator rule wizard).
  const [ruleName, setRuleName] = useState('');
  const [query, setQuery] = useState('');
  const [sourceTable, setSourceTable] = useState('');
  const [severity, setSeverity] = useState(2);
  const [evalFreq, setEvalFreq] = useState('PT5M');
  const [winSize, setWinSize] = useState('PT5M');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // Trigger-now feedback per rule.
  const [triggerResult, setTriggerResult] = useState<{ ruleId: string; fired: boolean; count: number } | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true); setListErr(null); setGate(null);
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(id)}/rules?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        setRules([]);
        if (j?.gate) setGate(j.gate);
        setListErr(j?.error || `HTTP ${r.status}`);
        return;
      }
      setRules(Array.isArray(j.rules) ? j.rules : []);
    } catch (e: any) {
      setRules([]); setListErr(e?.message || String(e));
    } finally { setLoading(false); }
  }, [id, workspaceId]);

  useEffect(() => { if (workspaceId) loadRules(); }, [workspaceId, loadRules]);

  const createRule = useCallback(async () => {
    if (!ruleName.trim() || !workspaceId) return;
    setCreating(true); setCreateErr(null); setGate(null);
    const body: Record<string, unknown> = {
      name: ruleName.trim(),
      severity, evaluationFrequency: evalFreq, windowSize: winSize,
    };
    if (query.trim()) body.query = query.trim();
    if (sourceTable.trim()) body.sourceTable = sourceTable.trim();
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(id)}/rules?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        if (j?.gate) setGate(j.gate);
        setCreateErr(j?.error || j?.gate?.remediation || `HTTP ${r.status}`);
        return;
      }
      setRuleName(''); setQuery(''); setSourceTable('');
      await loadRules();
    } catch (e: any) {
      setCreateErr(e?.message || String(e));
    } finally { setCreating(false); }
  }, [ruleName, query, sourceTable, severity, evalFreq, winSize, id, workspaceId, loadRules]);

  const triggerNow = useCallback(async (ruleId: string) => {
    if (!workspaceId) return;
    setTriggering(ruleId); setTriggerResult(null); setListErr(null); setGate(null);
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(id)}/rules?workspaceId=${encodeURIComponent(workspaceId)}&trigger=${encodeURIComponent(ruleId)}`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        if (j?.gate) setGate(j.gate);
        setListErr(j?.error || j?.gate?.remediation || `HTTP ${r.status}`);
        return;
      }
      setTriggerResult({ ruleId, fired: !!j.fired, count: typeof j.count === 'number' ? j.count : (Array.isArray(j.rows) ? j.rows.length : 0) });
    } catch (e: any) {
      setListErr(e?.message || String(e));
    } finally { setTriggering(null); }
  }, [id, workspaceId]);

  if (id === 'new') {
    return (
      <MessageBar intent="info">
        <MessageBarBody>Save this data agent first — Monitoring creates Azure Monitor alert rules scoped to this agent, which needs a persisted item.</MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={s.daSection}>
      <div className={s.daSectionHead}>
        <span className={s.daSectionIcon}><Pulse20Regular /></span>
        <Subtitle2>Monitoring</Subtitle2>
        <Badge appearance="tint" color="brand">Azure Monitor</Badge>
        <div style={{ flex: 1 }} />
        <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadRules} disabled={loading || !workspaceId}>Refresh</Button>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Watch this agent&rsquo;s data with scheduled-query alert rules. Each rule is a real
        <strong> Microsoft.Insights/scheduledQueryRule</strong> (+ action group) that runs your KQL on the Log
        Analytics workspace on a cadence and fires when rows are returned — no Microsoft Fabric required.
      </Caption1>

      {itemQ.isLoading && <Spinner size="tiny" label="Loading agent…" labelPosition="after" />}
      {itemQ.data && !workspaceId && (
        <MessageBar intent="warning"><MessageBarBody>
          Couldn&rsquo;t resolve this agent&rsquo;s workspace. Open the agent from its workspace so Monitoring can scope alert rules to it.
        </MessageBarBody></MessageBar>
      )}

      {/* Honest Azure Monitor infra-gate (NOT a Fabric gate) — verbatim from the route. */}
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure Monitor not configured</MessageBarTitle>
            {gate.reason && <div>{gate.reason}</div>}
            {gate.remediation && <div style={{ marginTop: tokens.spacingVerticalXS }}><em>To enable:</em> {gate.remediation}</div>}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* New rule (typed wizard — no freeform JSON). */}
      <div className={s.daAddBar} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Rule name" style={{ minWidth: 200 }}>
            <Input value={ruleName} onChange={(_, d) => setRuleName(d.value)} placeholder="e.g. High error rate" />
          </Field>
          <Field label="Severity">
            <Dropdown
              value={DA_SEVERITY_OPTS.find((o) => o.value === severity)?.label}
              selectedOptions={[String(severity)]}
              onOptionSelect={(_, d) => d.optionValue != null && setSeverity(Number(d.optionValue))}
            >
              {DA_SEVERITY_OPTS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Evaluate every">
            <Dropdown value={evalFreq} selectedOptions={[evalFreq]} onOptionSelect={(_, d) => d.optionValue && setEvalFreq(d.optionValue)}>
              {DA_FREQ_OPTS.map((o) => <Option key={o} value={o}>{o}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Lookback window">
            <Dropdown value={winSize} selectedOptions={[winSize]} onOptionSelect={(_, d) => d.optionValue && setWinSize(d.optionValue)}>
              {DA_WINDOW_OPTS.map((o) => <Option key={o} value={o}>{o}</Option>)}
            </Dropdown>
          </Field>
        </div>
        <Field label="Alert KQL (Log Analytics)" hint="The rule fires when this query returns one or more rows. Leave blank to alert on any new row in the source table below.">
          <Textarea value={query} rows={3} onChange={(_, d) => setQuery(d.value)} placeholder={'AppEvents\n| where Level == "Error"\n| where TimeGenerated > ago(15m)'} />
        </Field>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Source table (optional)" hint="Used to compose the query when Alert KQL is blank." style={{ minWidth: 240 }}>
            <Input value={sourceTable} onChange={(_, d) => setSourceTable(d.value)} placeholder="AppEvents" />
          </Field>
          <Button appearance="primary" icon={<Add20Regular />} onClick={createRule} disabled={creating || !ruleName.trim() || !workspaceId}>
            {creating ? 'Creating…' : 'Create alert rule'}
          </Button>
        </div>
        {createErr && !gate && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{createErr}</Caption1>}
      </div>

      {/* Rule list. */}
      {loading && <Spinner size="tiny" label="Loading rules…" labelPosition="after" />}
      {!loading && rules.length === 0 && !gate && !listErr && (
        <MessageBar intent="info"><MessageBarBody>
          <Pulse20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalSNudge }} />
          No alert rules yet. Create one above to monitor this agent&rsquo;s data on Azure Monitor.
        </MessageBarBody></MessageBar>
      )}
      {!loading && listErr && !gate && (
        <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>
      )}
      {rules.map((r) => (
        <div key={r.id} className={s.daSrcCard}>
          <div className={s.daSrcHead}>
            <span className={s.daSrcIcon}><Pulse20Regular /></span>
            <strong>{r.name}</strong>
            <Badge appearance="tint" color={r.state === 'Active' ? 'success' : 'warning'}>{r.state}</Badge>
            <Badge appearance="outline">sev {r.severity}</Badge>
            <Badge appearance="outline">{r.evaluationFrequency} / {r.windowSize}</Badge>
            <div style={{ flex: 1 }} />
            <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => triggerNow(r.id)} disabled={triggering === r.id || !workspaceId}>
              {triggering === r.id ? 'Running…' : 'Trigger now'}
            </Button>
          </div>
          {r.query && <pre className={s.chatSource}>{r.query}</pre>}
          {r.note && <Caption1 style={{ color: tokens.colorPaletteYellowForeground1 }}>⚠ {r.note}</Caption1>}
          {triggerResult && triggerResult.ruleId === r.id && (
            <Caption1 style={{ color: triggerResult.fired ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground3 }}>
              {triggerResult.fired
                ? `Would fire — ${triggerResult.count} matching row${triggerResult.count === 1 ? '' : 's'} right now.`
                : 'No matching rows right now — the rule would not fire.'}
            </Caption1>
          )}
        </div>
      ))}
    </div>
  );
}
