'use client';

/**
 * Ontology editor (text-stored OWL/RDF; typed object/link/action model).
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

// ----- Ontology (text-stored OWL/RDF; class tree parsed client-side) -----
const ONTO_SAMPLE = `# Turtle-ish — define entity types and a parent hierarchy.\n# Each line: "ClassName : ParentClass  -- description"\nThing :  -- root\nParty : Thing -- person or org\nCustomer : Party -- buying party\nVendor : Party -- selling party\nOrder : Thing -- transaction record\nFlight : Thing -- aviation event\n`;
interface OntoState {
  source: string;
  /** Most-recent lakehouse bound (also recorded per-binding in entityBindings). */
  boundLakehouseId?: string;
  /** Most-recent warehouse bound. */
  boundWarehouseId?: string;
  /** Entity-type → data-source bindings (see _family-utils OntologyEntityBinding). */
  entityBindings?: OntologyEntityBinding[];
  /** Backing Cosmos activator item id, created lazily on first trigger. */
  activatorId?: string;
  activatorWorkspaceId?: string;
  /**
   * Typed object types (Foundry "object types") — the structured model that
   * replaces the freeform DSL textarea as the source of truth. The typed-modeling
   * surface persists these; deriveSourceFromObjectTypes() keeps `source` in sync.
   */
  objectTypes?: OntoObjectType[];
  /** Typed link types between object types (Foundry "link types"). */
  linkTypes?: OntoLinkType[];
  /**
   * Weave (Semantic Ontology) Phase 1 — declared write-back action types. Each
   * runs create/update/delete cypher over the bound PG + Apache AGE graph store.
   * Typed (OntoActionType); normalizeOntoActionTypes() is backward-compatible
   * with the legacy { name, objectType, kind, params: string[] } shape.
   */
  actionTypes?: OntoActionType[];
  [k: string]: unknown;
}

/** A declared Weave action type (mirror of lib/azure/weave-ontology-store WeaveActionType). */
interface WeaveActionTypeDecl {
  name: string;
  objectType: string;
  kind: 'create' | 'update' | 'delete';
  params?: string[];
}

// `parseOntologyHierarchy` is imported from `_family-utils` (vitest coverage
// at `lib/editors/__tests__/family-utils.test.ts`).

// Render the parsed ontology class hierarchy as an IS_A force-directed graph.
function OntologyHierarchyViz({ classes }: { classes: { name: string; parent?: string; description?: string }[] }) {
  const g = useMemo(() => {
    const ids = new Set(classes.map((c) => c.name));
    const nodes = classes.map((c) => ({ id: c.name, label: c.name }));
    const edges = classes
      .filter((c) => c.parent && ids.has(c.parent))
      .map((c) => ({ source: c.name, target: c.parent as string, label: 'is_a' }));
    return { nodes, edges };
  }, [classes]);
  if (g.nodes.length === 0) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Add a class to see the hierarchy graph.</Caption1>;
  return <ForceDirectedGraph nodes={g.nodes} edges={g.edges} width={320} height={260} />;
}

/**
 * Weave (Semantic Ontology) Phase 1 — object instance write-back + write-back
 * action types over the bound PG + Apache AGE graph store.
 *
 *   • Objects: list instances of a declared object type, create a new instance
 *     (POST /api/items/ontology/[id]/objects → real AGE vertex).
 *   • Write-back actions: declare create/update/delete action types (persisted on
 *     state.actionTypes), then RUN them (POST /api/items/ontology/[id]/run-action
 *     → real AGE transaction). This is the Palantir-class write-back surface.
 *
 * All controls call the real BFF; when the AGE backend env (LOOM_WEAVE_PG_FQDN)
 * is unset the routes return a 503 with a gate that this panel surfaces in a
 * Fluent MessageBar (intent="warning") naming the env var + bicep module — per
 * no-vaporware.md (honest gate, full UI still renders). Azure-native; no Fabric.
 */
function WeaveInstancePanel({
  id,
  classes,
  actionTypes,
  onActionTypesChange,
}: {
  id: string;
  classes: { name: string }[];
  actionTypes: WeaveActionTypeDecl[];
  onActionTypesChange: (next: WeaveActionTypeDecl[]) => void;
}) {
  const s = useStyles();
  const classNames = useMemo(() => classes.map((c) => c.name), [classes]);

  // ── Objects (instances) ──
  const [objType, setObjType] = useState('');
  const [objects, setObjects] = useState<Array<{ id: string; objectType: string; properties: Record<string, unknown> }>>([]);
  const [objLoading, setObjLoading] = useState(false);
  const [objMsg, setObjMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [newProps, setNewProps] = useState('{}');
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: 'id', dir: 'asc' });

  useEffect(() => { if (!objType && classNames.length) setObjType(classNames[0]); }, [classNames, objType]);

  const loadObjects = useCallback(async (t: string) => {
    if (!id || id === 'new' || !t) return;
    setObjLoading(true); setObjMsg(null);
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/objects?objectType=${encodeURIComponent(t)}&top=100`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || j.gate.reason || ''}` : '';
        setObjMsg({ intent: r.status === 503 ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        setObjects([]);
        return;
      }
      setObjects(Array.isArray(j.objects) ? j.objects : []);
    } catch (e: any) {
      setObjMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setObjLoading(false); }
  }, [id]);

  useEffect(() => { if (objType) void loadObjects(objType); }, [objType, loadObjects]);

  const createObject = useCallback(async () => {
    if (!objType) { setObjMsg({ intent: 'error', text: 'Pick an object type.' }); return; }
    let properties: Record<string, unknown> = {};
    if (newProps.trim()) {
      try { properties = JSON.parse(newProps); } catch { setObjMsg({ intent: 'error', text: 'Properties must be valid JSON (an object of scalar values).' }); return; }
      if (typeof properties !== 'object' || Array.isArray(properties)) { setObjMsg({ intent: 'error', text: 'Properties must be a JSON object.' }); return; }
    }
    setCreating(true); setObjMsg(null);
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/objects`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objectType: objType, properties }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || j.gate.reason || ''}` : '';
        setObjMsg({ intent: r.status === 503 ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setObjMsg({ intent: 'success', text: `Created ${objType} instance (AGE vertex id ${j.object?.id}).` });
      setNewProps('{}');
      await loadObjects(objType);
    } catch (e: any) {
      setObjMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setCreating(false); }
  }, [id, objType, newProps, loadObjects]);

  // ── Write-back action types ──
  const [actDlgOpen, setActDlgOpen] = useState(false);
  const [actName, setActName] = useState('');
  const [actObjType, setActObjType] = useState('');
  const [actKind, setActKind] = useState<'create' | 'update' | 'delete'>('create');
  const [actDlgErr, setActDlgErr] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [runParams, setRunParams] = useState<Record<string, string>>({});

  const openActDlg = useCallback(() => {
    setActName(''); setActObjType(classNames[0] || ''); setActKind('create'); setActDlgErr(null); setActDlgOpen(true);
  }, [classNames]);

  const addActionType = useCallback(() => {
    const name = actName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setActDlgErr('Action name must start with a letter/underscore (letters, digits, _).'); return; }
    if (actionTypes.some((a) => a.name === name)) { setActDlgErr(`Action "${name}" already exists.`); return; }
    if (!actObjType) { setActDlgErr('Pick an object type.'); return; }
    onActionTypesChange([...actionTypes, { name, objectType: actObjType, kind: actKind }]);
    setActDlgOpen(false);
  }, [actName, actObjType, actKind, actionTypes, onActionTypesChange]);

  const removeActionType = useCallback((name: string) => {
    onActionTypesChange(actionTypes.filter((a) => a.name !== name));
  }, [actionTypes, onActionTypesChange]);

  const runAction = useCallback(async (action: WeaveActionTypeDecl) => {
    setRunningAction(action.name); setRunMsg(null);
    const params: Record<string, unknown> = {};
    if (action.kind === 'update' || action.kind === 'delete') {
      const idVal = (runParams[`${action.name}.id`] || '').trim();
      if (!idVal) { setRunMsg({ intent: 'error', text: `"${action.name}" needs the target object id.` }); setRunningAction(null); return; }
      params.id = idVal;
    }
    if (action.kind === 'create' || action.kind === 'update') {
      const raw = (runParams[`${action.name}.props`] || '').trim();
      if (raw) {
        try { Object.assign(params, JSON.parse(raw)); } catch { setRunMsg({ intent: 'error', text: 'Properties must be valid JSON.' }); setRunningAction(null); return; }
      }
    }
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/run-action`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: action.name, params }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || j.gate.reason || ''}` : '';
        setRunMsg({ intent: r.status === 503 ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      const detail = j.kind === 'delete' ? `deleted ${j.deleted ?? 0}` : `vertex id ${j.object?.id}`;
      setRunMsg({ intent: 'success', text: `Action "${action.name}" (${j.kind}) ran on ${j.objectType} — ${detail}.` });
      if (objType === action.objectType) await loadObjects(objType);
    } catch (e: any) {
      setRunMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setRunningAction(null); }
  }, [id, runParams, objType, loadObjects]);

  const toggleSort = useCallback((col: string) => {
    setSort((prev) => (prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));
  }, []);

  const objColumns = objects.length ? Object.keys(objects[0].properties || {}) : [];

  const sortedObjects = useMemo(() => {
    const get = (o: { id: string; properties: Record<string, unknown> }) =>
      sort.col === 'id' ? o.id : o.properties?.[sort.col];
    const arr = [...objects].sort((a, b) => {
      const av = get(a); const bv = get(b);
      const an = typeof av === 'number' ? av : Number(av);
      const bn = typeof bv === 'number' ? bv : Number(bv);
      let cmp: number;
      if (!Number.isNaN(an) && !Number.isNaN(bn) && av !== '' && bv !== '') cmp = an - bn;
      else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [objects, sort]);

  if (id === 'new') {
    return (
      <div className={s.ontoSection}>
        <Subtitle2>Objects & write-back actions</Subtitle2>
        <MessageBar intent="info"><MessageBarBody>Save the ontology to enable object instances + write-back actions over the graph store.</MessageBarBody></MessageBar>
      </div>
    );
  }

  const SortIcon = ({ col }: { col: string }) =>
    sort.col !== col ? null : sort.dir === 'asc' ? <ArrowSortUp16Regular /> : <ArrowSortDown16Regular />;

  return (
    <div className={s.ontoBindGrid}>
      {/* ── Object instances ── */}
      <div className={s.ontoSection}>
        <div className={s.ontoSectionHead}>
          <span className={s.ontoSectionIcon}><Database20Regular /></span>
          <div>
            <Subtitle2>Objects <Badge appearance="tint" color="warning">Preview</Badge></Subtitle2>
            <Caption1 as="p" block className={s.ontoSectionHint}>
              Object instances of a declared type, persisted as Apache AGE vertices on the bound PostgreSQL graph store. Real write-back — Azure-native, no Fabric.
            </Caption1>
          </div>
        </div>
        {classNames.length === 0 ? (
          <MessageBar intent="info"><MessageBarBody>Add an entity (object type) first.</MessageBarBody></MessageBar>
        ) : (
          <>
            <Field label="Object type">
              <Dropdown value={objType} selectedOptions={objType ? [objType] : []} onOptionSelect={(_, d) => setObjType(d.optionValue || '')} placeholder="Select an object type">
                {classNames.map((c) => <Option key={c} value={c}>{c}</Option>)}
              </Dropdown>
            </Field>
            <Field label="New instance properties (JSON object of scalars)" hint='e.g. {"name": "Acme", "tier": 1}'>
              <Textarea value={newProps} onChange={(_, d) => setNewProps(d.value)} resize="vertical" />
            </Field>
            <Button appearance="primary" icon={creating ? <Spinner size="tiny" /> : <Add20Regular />} onClick={createObject} disabled={creating || !objType} className={s.ontoStartBtn}>
              {creating ? 'Creating…' : `Create ${objType || 'object'}`}
            </Button>
            {objMsg && <MessageBar intent={objMsg.intent}><MessageBarBody>{objMsg.text}</MessageBarBody></MessageBar>}
            {objLoading ? (
              <div className={s.ontoLoading}><Spinner size="tiny" /><Caption1>Loading instances…</Caption1></div>
            ) : objects.length === 0 ? (
              <div className={s.ontoEmpty}><Caption1>No {objType} instances yet. Create one above to materialize an AGE vertex.</Caption1></div>
            ) : (
              <>
                <div className={s.ontoTableMeta}>
                  <Caption1>{objects.length} {objects.length === 1 ? 'instance' : 'instances'}</Caption1>
                  <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={() => void loadObjects(objType)} disabled={objLoading}>Refresh</Button>
                </div>
                <div className={s.ontoTableWrap}>
                  <Table size="small" aria-label={`${objType} instances`} sortable>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell aria-sort={sort.col === 'id' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          <button type="button" className={s.ontoSortHeader} onClick={() => toggleSort('id')}>id<SortIcon col="id" /></button>
                        </TableHeaderCell>
                        {objColumns.map((c) => (
                          <TableHeaderCell key={c} aria-sort={sort.col === c ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button type="button" className={s.ontoSortHeader} onClick={() => toggleSort(c)}>{c}<SortIcon col={c} /></button>
                          </TableHeaderCell>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedObjects.map((o) => (
                        <TableRow key={o.id}>
                          <TableCell><span className={s.ontoCellId}>{o.id}</span></TableCell>
                          {objColumns.map((c) => <TableCell key={c}>{String(o.properties?.[c] ?? '')}</TableCell>)}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* ── Write-back actions ── */}
      <div className={s.ontoSection}>
        <div className={s.ontoSectionHead}>
          <span className={s.ontoSectionIcon}><Flash20Regular /></span>
          <div>
            <Subtitle2>Write-back actions <Badge appearance="tint" color="warning">Preview</Badge></Subtitle2>
            <Caption1 as="p" block className={s.ontoSectionHint}>
              Declare create / update / delete actions over the object types, then run them. Each runs a real AGE transaction against the graph store (Palantir-class write-back).
            </Caption1>
          </div>
        </div>
        <Button appearance="primary" icon={<Add20Regular />} onClick={openActDlg} disabled={classNames.length === 0} className={s.ontoStartBtn}>
          Declare action type
        </Button>
        {actionTypes.length === 0 ? (
          <div className={s.ontoEmpty}><Caption1>No actions declared. Use <strong>Declare action type</strong> to add a create / update / delete action.</Caption1></div>
        ) : (
          actionTypes.map((a) => (
            <div key={a.name} className={s.ontoActionCard}>
              <div className={s.ontoActionHead}>
                <Badge appearance="tint" color={a.kind === 'create' ? 'success' : a.kind === 'delete' ? 'danger' : 'brand'}>{a.kind}</Badge>
                <Body1><strong>{a.name}</strong></Body1>
                <Caption1 className={s.ontoSectionHint}>→ {a.objectType}</Caption1>
                <span className={s.ontoBindRowSpacer} />
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove action ${a.name}`} onClick={() => removeActionType(a.name)}>Remove</Button>
              </div>
              {(a.kind === 'update' || a.kind === 'delete') && (
                <Field label="Target object id (AGE vertex id)">
                  <Input value={runParams[`${a.name}.id`] || ''} onChange={(_, d) => setRunParams((p) => ({ ...p, [`${a.name}.id`]: d.value }))} placeholder="844424930131969" />
                </Field>
              )}
              {(a.kind === 'create' || a.kind === 'update') && (
                <Field label="Properties">
                  <KeyValueRows key={`${a.name}.props`} value={runParams[`${a.name}.props`] || ''}
                    onChange={(json) => setRunParams((p) => ({ ...p, [`${a.name}.props`]: json }))}
                    keyPlaceholder="name" valuePlaceholder="Acme" />
                </Field>
              )}
              <Button appearance="secondary" icon={runningAction === a.name ? <Spinner size="tiny" /> : <Play20Regular />} onClick={() => runAction(a)} disabled={runningAction === a.name} className={s.ontoStartBtn}>
                {runningAction === a.name ? 'Running…' : `Run ${a.name}`}
              </Button>
            </div>
          ))
        )}
        {runMsg && <MessageBar intent={runMsg.intent}><MessageBarBody>{runMsg.text}</MessageBarBody></MessageBar>}
      </div>

      {/* Declare action type dialog */}
      <Dialog open={actDlgOpen} onOpenChange={(_, d) => setActDlgOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Declare write-back action type</DialogTitle>
            <DialogContent>
              <Field label="Action name" required>
                <Input value={actName} onChange={(_, d) => setActName(d.value)} placeholder="createCustomer" />
              </Field>
              <Field label="Object type" required>
                <Dropdown value={actObjType} selectedOptions={actObjType ? [actObjType] : []} onOptionSelect={(_, d) => setActObjType(d.optionValue || '')} placeholder="Select an object type">
                  {classNames.map((c) => <Option key={c} value={c}>{c}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Kind" required>
                <Dropdown value={actKind} selectedOptions={[actKind]} onOptionSelect={(_, d) => setActKind((d.optionValue as 'create' | 'update' | 'delete') || 'create')}>
                  <Option value="create">create</Option>
                  <Option value="update">update</Option>
                  <Option value="delete">delete</Option>
                </Dropdown>
              </Field>
              {actDlgErr && <MessageBar intent="error"><MessageBarBody>{actDlgErr}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setActDlgOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={addActionType}>Declare action</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

/**
 * Typed modeling surface (Foundry-class object / link / action types) layered over
 * the structured ontology model (`lib/editors/ontology-model.ts`). It reads the
 * typed model via migrateOntologyState(state) (migrating the legacy DSL on first
 * load), lets the user author object types + their typed properties, primary/title
 * keys, an Azure-native datasource backing (ADLS Delta lakehouse / Synapse SQL
 * warehouse — never Fabric), link types between object types, and write-back action
 * types with typed parameters. Every change persists to Cosmos via persistOnto and
 * re-derives state.source so the AGE instance/link/action routes keep resolving the
 * declared type names. No vaporware: real Cosmos persistence; honest gates where a
 * datasource list is empty.
 */
function OntologyTypedModelPanel({
  id, state, persistOnto, lakehouses, warehouses, saving,
}: {
  id: string;
  state: OntoState;
  persistOnto: (next: OntoState) => void;
  lakehouses: { id: string; displayName: string }[];
  warehouses: { id: string; displayName: string }[];
  saving: boolean;
}) {
  const s = useStyles();
  const model = useMemo(() => migrateOntologyState(state), [state]);
  const { objectTypes, linkTypes, actionTypes } = model;
  const objNames = useMemo(() => objectTypes.map((o) => o.apiName), [objectTypes]);
  const [tab, setTab] = useState<'objects' | 'links' | 'actions'>('objects');

  const commit = useCallback((patch: { objectTypes?: OntoObjectType[]; linkTypes?: OntoLinkType[]; actionTypes?: OntoActionType[] }) => {
    const nextObj = patch.objectTypes ?? objectTypes;
    const nextLink = patch.linkTypes ?? linkTypes;
    const nextAct = patch.actionTypes ?? actionTypes;
    persistOnto({ ...state, objectTypes: nextObj, linkTypes: nextLink, actionTypes: nextAct, source: deriveSourceFromObjectTypes(nextObj) });
  }, [state, persistOnto, objectTypes, linkTypes, actionTypes]);

  // ───────────────────────── Object-type dialog ─────────────────────────
  interface OtDraft {
    index: number | null;
    apiName: string; displayName: string; pluralDisplayName: string; description: string;
    status: OntoStatus; color: '' | OntoColor;
    properties: OntoProperty[];
    primaryKey: string; titleKey: string;
    dsKind: '' | 'lakehouse' | 'warehouse'; dsSourceId: string; dsTable: string; dsPkColumn: string;
  }
  const blankOt = (): OtDraft => ({
    index: null, apiName: '', displayName: '', pluralDisplayName: '', description: '',
    status: 'active', color: '', properties: [], primaryKey: '', titleKey: '',
    dsKind: '', dsSourceId: '', dsTable: '', dsPkColumn: '',
  });
  const [otOpen, setOtOpen] = useState(false);
  const [ot, setOt] = useState<OtDraft>(blankOt);
  const [otErr, setOtErr] = useState<string | null>(null);
  const patchOt = (p: Partial<OtDraft>) => setOt((d) => ({ ...d, ...p }));

  const openNewOt = () => { setOt(blankOt()); setOtErr(null); setOtOpen(true); };
  const openEditOt = (i: number) => {
    const o = objectTypes[i];
    const ds = o.datasource;
    setOt({
      index: i, apiName: o.apiName, displayName: o.displayName || '', pluralDisplayName: o.pluralDisplayName || '',
      description: o.description || '', status: o.status || 'active', color: o.color || '',
      properties: o.properties.map((p) => ({ ...p })),
      primaryKey: o.primaryKey || '', titleKey: o.titleKey || '',
      dsKind: ds?.kind || '', dsSourceId: ds?.sourceItemId || '', dsTable: ds?.table || '', dsPkColumn: ds?.primaryKeyColumn || '',
    });
    setOtErr(null); setOtOpen(true);
  };

  const otKeyEligible = useMemo(() => ot.properties.filter((p) => isOntoIdent(p.apiName) && ONTO_KEY_ELIGIBLE_TYPES.has(p.baseType)), [ot.properties]);
  const otAllNamed = useMemo(() => ot.properties.filter((p) => isOntoIdent(p.apiName)), [ot.properties]);

  const saveOt = () => {
    const apiName = ot.apiName.trim();
    if (!isOntoIdent(apiName)) { setOtErr('API name must start with a letter/underscore (≤63 letters, digits, _).'); return; }
    if (objectTypes.some((o, i) => o.apiName === apiName && i !== ot.index)) { setOtErr(`Object type "${apiName}" already exists.`); return; }
    const seen = new Set<string>();
    for (const p of ot.properties) {
      if (!isOntoIdent(p.apiName.trim())) { setOtErr('Every property needs a valid API name (letter/underscore start).'); return; }
      if (seen.has(p.apiName.trim())) { setOtErr(`Duplicate property "${p.apiName.trim()}".`); return; }
      seen.add(p.apiName.trim());
    }
    if (ot.dsKind && !ot.dsSourceId) { setOtErr('Pick a source item for the datasource, or clear the datasource kind.'); return; }
    const properties: OntoProperty[] = ot.properties.map((p) => ({
      apiName: p.apiName.trim(),
      ...(p.displayName ? { displayName: p.displayName } : {}),
      baseType: p.baseType,
      ...(p.arrayOf ? { arrayOf: true } : {}),
      ...(p.required ? { required: true } : {}),
      ...(p.description ? { description: p.description } : {}),
    }));
    let datasource: OntoDatasource | undefined;
    if (ot.dsKind && ot.dsSourceId) {
      const list = ot.dsKind === 'lakehouse' ? lakehouses : warehouses;
      const disp = list.find((x) => x.id === ot.dsSourceId)?.displayName;
      datasource = {
        kind: ot.dsKind, sourceItemId: ot.dsSourceId,
        ...(disp ? { sourceDisplayName: disp } : {}),
        ...(ot.dsTable.trim() ? { table: ot.dsTable.trim() } : {}),
        ...(ot.dsPkColumn.trim() ? { primaryKeyColumn: ot.dsPkColumn.trim() } : {}),
        boundAt: new Date().toISOString(),
      };
    }
    const base = ot.index === null ? ({} as Partial<OntoObjectType>) : objectTypes[ot.index];
    const pk = seen.has(ot.primaryKey) && ONTO_KEY_ELIGIBLE_TYPES.has(properties.find((p) => p.apiName === ot.primaryKey)!.baseType) ? ot.primaryKey : undefined;
    const title = seen.has(ot.titleKey) ? ot.titleKey : undefined;
    const next: OntoObjectType = {
      ...(base.parent ? { parent: base.parent } : {}),
      ...(base.groups ? { groups: base.groups } : {}),
      ...(base.icon ? { icon: base.icon } : {}),
      ...(base.visibility ? { visibility: base.visibility } : {}),
      apiName,
      ...(ot.displayName.trim() ? { displayName: ot.displayName.trim() } : {}),
      ...(ot.pluralDisplayName.trim() ? { pluralDisplayName: ot.pluralDisplayName.trim() } : {}),
      ...(ot.description.trim() ? { description: ot.description.trim() } : {}),
      ...(ot.color ? { color: ot.color } : {}),
      status: ot.status,
      properties,
      ...(pk ? { primaryKey: pk } : {}),
      ...(title ? { titleKey: title } : {}),
      ...(datasource ? { datasource } : {}),
    };
    const arr2 = [...objectTypes];
    if (ot.index === null) arr2.push(next); else arr2[ot.index] = next;
    commit({ objectTypes: arr2 });
    setOtOpen(false);
  };

  const removeOt = (i: number) => {
    const removed = objectTypes[i].apiName;
    commit({
      objectTypes: objectTypes.filter((_, idx) => idx !== i),
      linkTypes: linkTypes.filter((l) => l.fromType !== removed && l.toType !== removed),
      actionTypes: actionTypes.filter((a) => a.objectType !== removed),
    });
  };

  // ───────────────────────── Link-type dialog ─────────────────────────
  interface LtDraft { index: number | null; apiName: string; displayName: string; fromType: string; toType: string; cardinality: OntoCardinality; foreignKeyProperty: string; description: string; }
  const blankLt = (): LtDraft => ({ index: null, apiName: '', displayName: '', fromType: objNames[0] || '', toType: objNames[0] || '', cardinality: 'one-to-many', foreignKeyProperty: '', description: '' });
  const [ltOpen, setLtOpen] = useState(false);
  const [lt, setLt] = useState<LtDraft>(blankLt);
  const [ltErr, setLtErr] = useState<string | null>(null);
  const patchLt = (p: Partial<LtDraft>) => setLt((d) => ({ ...d, ...p }));
  const openNewLt = () => { setLt(blankLt()); setLtErr(null); setLtOpen(true); };
  const openEditLt = (i: number) => {
    const l = linkTypes[i];
    setLt({ index: i, apiName: l.apiName, displayName: l.displayName || '', fromType: l.fromType, toType: l.toType, cardinality: l.cardinality, foreignKeyProperty: l.foreignKeyProperty || '', description: l.description || '' });
    setLtErr(null); setLtOpen(true);
  };
  const saveLt = () => {
    const apiName = lt.apiName.trim();
    if (!isOntoIdent(apiName)) { setLtErr('API name must start with a letter/underscore (≤63 letters, digits, _).'); return; }
    if (linkTypes.some((l, i) => l.apiName === apiName && i !== lt.index)) { setLtErr(`Link type "${apiName}" already exists.`); return; }
    if (!objNames.includes(lt.fromType) || !objNames.includes(lt.toType)) { setLtErr('Pick a from and to object type.'); return; }
    if (lt.foreignKeyProperty.trim() && !isOntoIdent(lt.foreignKeyProperty.trim())) { setLtErr('Foreign-key property must be a valid API name.'); return; }
    const next: OntoLinkType = {
      apiName,
      ...(lt.displayName.trim() ? { displayName: lt.displayName.trim() } : {}),
      fromType: lt.fromType, toType: lt.toType, cardinality: lt.cardinality,
      ...(lt.foreignKeyProperty.trim() ? { foreignKeyProperty: lt.foreignKeyProperty.trim() } : {}),
      ...(lt.description.trim() ? { description: lt.description.trim() } : {}),
    };
    const arr2 = [...linkTypes];
    if (lt.index === null) arr2.push(next); else arr2[lt.index] = next;
    commit({ linkTypes: arr2 });
    setLtOpen(false);
  };
  const removeLt = (i: number) => commit({ linkTypes: linkTypes.filter((_, idx) => idx !== i) });

  // ───────────────────────── Action-type dialog ─────────────────────────
  interface AtDraft { index: number | null; name: string; objectType: string; kind: OntoActionType['kind']; description: string; parameters: OntoActionParam[]; }
  const blankAt = (): AtDraft => ({ index: null, name: '', objectType: objNames[0] || '', kind: 'create', description: '', parameters: [] });
  const [atOpen, setAtOpen] = useState(false);
  const [at, setAt] = useState<AtDraft>(blankAt);
  const [atErr, setAtErr] = useState<string | null>(null);
  const patchAt = (p: Partial<AtDraft>) => setAt((d) => ({ ...d, ...p }));
  const openNewAt = () => { setAt(blankAt()); setAtErr(null); setAtOpen(true); };
  const openEditAt = (i: number) => {
    const a = actionTypes[i];
    setAt({ index: i, name: a.name, objectType: a.objectType, kind: a.kind, description: a.description || '', parameters: a.parameters.map((p) => ({ ...p })) });
    setAtErr(null); setAtOpen(true);
  };
  const saveAt = () => {
    const name = at.name.trim();
    if (!isOntoIdent(name)) { setAtErr('Action name must start with a letter/underscore (≤63 letters, digits, _).'); return; }
    if (actionTypes.some((a, i) => a.name === name && i !== at.index)) { setAtErr(`Action "${name}" already exists.`); return; }
    if (!objNames.includes(at.objectType)) { setAtErr('Pick a target object type.'); return; }
    const seen = new Set<string>();
    for (const p of at.parameters) {
      if (!isOntoIdent(p.apiName.trim())) { setAtErr('Every parameter needs a valid API name (letter/underscore start).'); return; }
      if (seen.has(p.apiName.trim())) { setAtErr(`Duplicate parameter "${p.apiName.trim()}".`); return; }
      seen.add(p.apiName.trim());
    }
    const parameters: OntoActionParam[] = at.parameters.map((p) => ({
      apiName: p.apiName.trim(), type: p.type, ...(p.required ? { required: true } : {}),
      ...(p.prompt ? { prompt: p.prompt } : {}),
    }));
    const next: OntoActionType = { name, objectType: at.objectType, kind: at.kind, ...(at.description.trim() ? { description: at.description.trim() } : {}), parameters };
    const arr2 = [...actionTypes];
    if (at.index === null) arr2.push(next); else arr2[at.index] = next;
    commit({ actionTypes: arr2 });
    setAtOpen(false);
  };
  const removeAt = (i: number) => commit({ actionTypes: actionTypes.filter((_, idx) => idx !== i) });

  const dsList = ot.dsKind === 'warehouse' ? warehouses : lakehouses;
  const colorBadge: Record<OntoColor, 'brand' | 'success' | 'warning' | 'danger' | 'informative' | 'subtle'> = {
    brand: 'brand', success: 'success', warning: 'warning', danger: 'danger', informative: 'informative', subtle: 'subtle',
  };

  return (
    <div className={s.ontoSection}>
      <div className={s.ontoSectionHead}>
        <span className={s.ontoSectionIcon}><Cube20Regular /></span>
        <div>
          <Subtitle2>Typed model</Subtitle2>
          <Caption1 as="p" block className={s.ontoSectionHint}>
            Author object types, typed properties, primary / title keys, an Azure-native datasource backing
            (ADLS Delta lakehouse / Synapse SQL warehouse — no Fabric), link types, and write-back action types.
            Saved to Cosmos; the class DSL stays in sync automatically.
          </Caption1>
        </div>
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="objects" icon={<Cube20Regular />}>Object types ({objectTypes.length})</Tab>
        <Tab value="links" icon={<Link20Regular />}>Link types ({linkTypes.length})</Tab>
        <Tab value="actions" icon={<Play20Regular />}>Actions ({actionTypes.length})</Tab>
      </TabList>

      {/* ── Object types ── */}
      {tab === 'objects' && (
        <div className={s.tmTabPanel}>
          <Button appearance="primary" icon={<Add16Regular />} onClick={openNewOt} disabled={saving} className={s.ontoStartBtn}>Add object type</Button>
          {objectTypes.length === 0 ? (
            <EmptyState icon={<Cube20Regular />} title="No object types yet" body="Add an object type to model your domain — each becomes a node type backed by an Azure-native datasource." />
          ) : (
            <div className={s.tmCardGrid}>
              {objectTypes.map((o, i) => (
                <div key={o.apiName} className={s.ontoActionCard}>
                  <div className={s.ontoActionHead}>
                    <Cube20Regular />
                    <Body1><strong>{o.displayName || o.apiName}</strong></Body1>
                    {o.color && <Badge appearance="tint" color={colorBadge[o.color]}>{o.color}</Badge>}
                    {o.status && <Badge appearance="outline" color={o.status === 'active' ? 'success' : o.status === 'deprecated' ? 'danger' : 'warning'}>{o.status}</Badge>}
                    <span className={s.ontoBindRowSpacer} />
                    <Button size="small" appearance="subtle" icon={<Edit16Regular />} aria-label={`Edit ${o.apiName}`} onClick={() => openEditOt(i)} />
                    <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${o.apiName}`} onClick={() => removeOt(i)} />
                  </div>
                  <Caption1 className={s.ontoSectionHint}><code>{o.apiName}</code>{o.parent ? <> · is_a <code>{o.parent}</code></> : null}</Caption1>
                  {o.description && <Caption1>{o.description}</Caption1>}
                  <div className={s.tmCardMeta}>
                    <Badge appearance="ghost" icon={<Table20Regular />}>{o.properties.length} prop{o.properties.length === 1 ? '' : 's'}</Badge>
                    {o.primaryKey && <Badge appearance="ghost" color="brand">PK: {o.primaryKey}</Badge>}
                    {o.titleKey && <Badge appearance="ghost">title: {o.titleKey}</Badge>}
                    {o.datasource && <Badge appearance="tint" color={o.datasource.kind === 'lakehouse' ? 'brand' : 'success'} icon={<Database20Regular />}>{o.datasource.sourceDisplayName || o.datasource.kind}{o.datasource.table ? ` · ${o.datasource.table}` : ''}</Badge>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Link types ── */}
      {tab === 'links' && (
        <div className={s.tmTabPanel}>
          <Button appearance="primary" icon={<Add16Regular />} onClick={openNewLt} disabled={saving || objNames.length === 0} title={objNames.length === 0 ? 'Add an object type first' : undefined} className={s.ontoStartBtn}>Add link type</Button>
          {objNames.length === 0 ? (
            <MessageBar intent="info"><MessageBarBody>Add at least one object type before declaring link types.</MessageBarBody></MessageBar>
          ) : linkTypes.length === 0 ? (
            <EmptyState icon={<Link20Regular />} title="No link types yet" body="Declare a relationship between two object types (one-to-one, one-to-many, or many-to-many)." />
          ) : (
            <div className={s.tmCardGrid}>
              {linkTypes.map((l, i) => (
                <div key={l.apiName} className={s.ontoActionCard}>
                  <div className={s.ontoActionHead}>
                    <Link20Regular />
                    <Body1><strong>{l.displayName || l.apiName}</strong></Body1>
                    <Badge appearance="tint" color="informative">{ONTO_CARDINALITY_LABELS[l.cardinality]}</Badge>
                    <span className={s.ontoBindRowSpacer} />
                    <Button size="small" appearance="subtle" icon={<Edit16Regular />} aria-label={`Edit ${l.apiName}`} onClick={() => openEditLt(i)} />
                    <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${l.apiName}`} onClick={() => removeLt(i)} />
                  </div>
                  <Caption1 className={s.ontoSectionHint}><code>{l.fromType}</code> → <code>{l.toType}</code>{l.foreignKeyProperty ? <> · FK <code>{l.foreignKeyProperty}</code></> : null}</Caption1>
                  {l.description && <Caption1>{l.description}</Caption1>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Action types ── */}
      {tab === 'actions' && (
        <div className={s.tmTabPanel}>
          <Button appearance="primary" icon={<Add16Regular />} onClick={openNewAt} disabled={saving || objNames.length === 0} title={objNames.length === 0 ? 'Add an object type first' : undefined} className={s.ontoStartBtn}>Add action type</Button>
          {objNames.length === 0 ? (
            <MessageBar intent="info"><MessageBarBody>Add at least one object type before declaring actions.</MessageBarBody></MessageBar>
          ) : actionTypes.length === 0 ? (
            <EmptyState icon={<Play20Regular />} title="No action types yet" body="Declare a typed create / update / delete write-back action with parameters that run on the AGE graph store." />
          ) : (
            <div className={s.tmCardGrid}>
              {actionTypes.map((a, i) => (
                <div key={a.name} className={s.ontoActionCard}>
                  <div className={s.ontoActionHead}>
                    <Play20Regular />
                    <Body1><strong>{a.name}</strong></Body1>
                    <Badge appearance="tint" color={a.kind === 'create' ? 'success' : a.kind === 'delete' ? 'danger' : 'brand'}>{a.kind}</Badge>
                    <span className={s.ontoBindRowSpacer} />
                    <Button size="small" appearance="subtle" icon={<Edit16Regular />} aria-label={`Edit ${a.name}`} onClick={() => openEditAt(i)} />
                    <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${a.name}`} onClick={() => removeAt(i)} />
                  </div>
                  <Caption1 className={s.ontoSectionHint}>on <code>{a.objectType}</code> · {a.parameters.length} param{a.parameters.length === 1 ? '' : 's'}</Caption1>
                  {a.parameters.length > 0 && (
                    <div className={s.tmCardMeta}>
                      {a.parameters.map((p) => <Badge key={p.apiName} appearance="ghost">{p.apiName}: {ONTO_PARAM_TYPE_LABELS[p.type]}{p.required ? '*' : ''}</Badge>)}
                    </div>
                  )}
                  {a.description && <Caption1>{a.description}</Caption1>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Object-type dialog ── */}
      <Dialog open={otOpen} onOpenChange={(_, d) => setOtOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{ot.index === null ? 'Add object type' : `Edit ${ot.apiName}`}</DialogTitle>
            <DialogContent>
              <div className={s.tmDialogScroll}>
                <Field label="API name" required hint={ot.index === null ? 'Stable identifier (letter/underscore start). Cannot be changed after creation.' : 'Locked after creation to keep links/actions resolving.'}>
                  <Input value={ot.apiName} disabled={ot.index !== null} onChange={(_, d) => patchOt({ apiName: d.value })} placeholder="Customer" />
                </Field>
                <Field label="Display name"><Input value={ot.displayName} onChange={(_, d) => patchOt({ displayName: d.value })} placeholder="Customer" /></Field>
                <Field label="Plural display name"><Input value={ot.pluralDisplayName} onChange={(_, d) => patchOt({ pluralDisplayName: d.value })} placeholder="Customers" /></Field>
                <Field label="Description"><Textarea value={ot.description} onChange={(_, d) => patchOt({ description: d.value })} placeholder="A buying party." /></Field>
                <Field label="Status">
                  <Dropdown value={ot.status} selectedOptions={[ot.status]} onOptionSelect={(_, d) => patchOt({ status: (d.optionValue as OntoStatus) || 'active' })}>
                    {ONTO_STATUSES.map((st) => <Option key={st} value={st}>{st}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Accent color">
                  <Dropdown value={ot.color || '(none)'} selectedOptions={ot.color ? [ot.color] : ['']} onOptionSelect={(_, d) => patchOt({ color: (d.optionValue as OntoColor) || '' })}>
                    <Option value="">(none)</Option>
                    {ONTO_COLORS.map((c) => <Option key={c} value={c}>{c}</Option>)}
                  </Dropdown>
                </Field>

                <div className={s.tmSubBlock}>
                  <div className={s.ontoActionHead}>
                    <Table20Regular />
                    <Subtitle2>Properties</Subtitle2>
                    <span className={s.ontoBindRowSpacer} />
                    <Button size="small" icon={<Add16Regular />} onClick={() => patchOt({ properties: [...ot.properties, { apiName: '', baseType: 'string' }] })}>Add property</Button>
                  </div>
                  {ot.properties.length === 0 ? (
                    <Caption1 className={s.ontoSectionHint}>No properties yet. Add typed properties (string, integer, date, geopoint, …).</Caption1>
                  ) : ot.properties.map((p, pi) => (
                    <div key={pi} className={s.tmPropRow}>
                      <Field label={pi === 0 ? 'API name' : undefined}>
                        <Input value={p.apiName} onChange={(_, d) => patchOt({ properties: ot.properties.map((x, xi) => xi === pi ? { ...x, apiName: d.value } : x) })} placeholder="email" />
                      </Field>
                      <Field label={pi === 0 ? 'Base type' : undefined}>
                        <Dropdown value={ONTO_BASE_TYPE_LABELS[p.baseType]} selectedOptions={[p.baseType]} onOptionSelect={(_, d) => patchOt({ properties: ot.properties.map((x, xi) => xi === pi ? { ...x, baseType: (d.optionValue as OntoBaseType) || 'string' } : x) })}>
                          {ONTO_BASE_TYPES.map((bt) => <Option key={bt} value={bt}>{ONTO_BASE_TYPE_LABELS[bt]}</Option>)}
                        </Dropdown>
                      </Field>
                      <Switch checked={!!p.arrayOf} label="Array" onChange={(_, d) => patchOt({ properties: ot.properties.map((x, xi) => xi === pi ? { ...x, arrayOf: d.checked } : x) })} />
                      <Switch checked={!!p.required} label="Required" onChange={(_, d) => patchOt({ properties: ot.properties.map((x, xi) => xi === pi ? { ...x, required: d.checked } : x) })} />
                      <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove property ${p.apiName || pi + 1}`} onClick={() => patchOt({ properties: ot.properties.filter((_, xi) => xi !== pi) })} />
                    </div>
                  ))}
                </div>

                <Field label="Primary key" hint="Key-eligible scalar property uniquely identifying an instance.">
                  <Dropdown value={ot.primaryKey || '(none)'} selectedOptions={ot.primaryKey ? [ot.primaryKey] : ['']} onOptionSelect={(_, d) => patchOt({ primaryKey: d.optionValue || '' })} disabled={otKeyEligible.length === 0} placeholder={otKeyEligible.length === 0 ? 'Add a key-eligible property first' : 'Select a property'}>
                    <Option value="">(none)</Option>
                    {otKeyEligible.map((p) => <Option key={p.apiName} value={p.apiName}>{p.apiName}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Title property" hint="The property used as the instance label.">
                  <Dropdown value={ot.titleKey || '(none)'} selectedOptions={ot.titleKey ? [ot.titleKey] : ['']} onOptionSelect={(_, d) => patchOt({ titleKey: d.optionValue || '' })} disabled={otAllNamed.length === 0} placeholder={otAllNamed.length === 0 ? 'Add a property first' : 'Select a property'}>
                    <Option value="">(none)</Option>
                    {otAllNamed.map((p) => <Option key={p.apiName} value={p.apiName}>{p.apiName}</Option>)}
                  </Dropdown>
                </Field>

                <div className={s.tmSubBlock}>
                  <div className={s.ontoActionHead}>
                    <Database20Regular />
                    <Subtitle2>Datasource backing</Subtitle2>
                    <Caption1 className={s.ontoSectionHint}>Azure-native — ADLS Delta lakehouse or Synapse SQL warehouse. No Fabric.</Caption1>
                  </div>
                  <Field label="Kind">
                    <Dropdown value={ot.dsKind ? (ot.dsKind === 'lakehouse' ? 'Lakehouse' : 'Warehouse') : '(none)'} selectedOptions={ot.dsKind ? [ot.dsKind] : ['']} onOptionSelect={(_, d) => patchOt({ dsKind: (d.optionValue as 'lakehouse' | 'warehouse') || '', dsSourceId: '' })}>
                      <Option value="">(none)</Option>
                      <Option value="lakehouse">Lakehouse (ADLS Delta)</Option>
                      <Option value="warehouse">Warehouse (Synapse SQL)</Option>
                    </Dropdown>
                  </Field>
                  {ot.dsKind && (dsList.length === 0 ? (
                    <MessageBar intent="warning"><MessageBarBody>No {ot.dsKind}s available in this workspace{id === 'new' ? ' — save the ontology first' : ''}. Create a {ot.dsKind} to bind instances.</MessageBarBody></MessageBar>
                  ) : (
                    <>
                      <Field label="Source item" required>
                        <Dropdown value={dsList.find((x) => x.id === ot.dsSourceId)?.displayName || ''} selectedOptions={ot.dsSourceId ? [ot.dsSourceId] : []} onOptionSelect={(_, d) => patchOt({ dsSourceId: d.optionValue || '' })} placeholder={`Select a ${ot.dsKind}`}>
                          {dsList.map((x) => <Option key={x.id} value={x.id}>{x.displayName}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Table" hint="Backing table (e.g. dbo.Customer or a Delta table name).">
                        <Input value={ot.dsTable} onChange={(_, d) => patchOt({ dsTable: d.value })} placeholder="dbo.Customer" />
                      </Field>
                      <Field label="Primary-key column" hint="Source column that is the object's primary key.">
                        <Input value={ot.dsPkColumn} onChange={(_, d) => patchOt({ dsPkColumn: d.value })} placeholder="CustomerID" />
                      </Field>
                    </>
                  ))}
                </div>
                {otErr && <MessageBar intent="error"><MessageBarBody>{otErr}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOtOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={saveOt}>{ot.index === null ? 'Add object type' : 'Save'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* ── Link-type dialog ── */}
      <Dialog open={ltOpen} onOpenChange={(_, d) => setLtOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{lt.index === null ? 'Add link type' : `Edit ${lt.apiName}`}</DialogTitle>
            <DialogContent>
              <div className={s.tmDialogScroll}>
                <Field label="API name" required>
                  <Input value={lt.apiName} onChange={(_, d) => patchLt({ apiName: d.value })} placeholder="placedBy" />
                </Field>
                <Field label="Display name"><Input value={lt.displayName} onChange={(_, d) => patchLt({ displayName: d.value })} placeholder="Placed by" /></Field>
                <Field label="From object type" required>
                  <Dropdown value={lt.fromType} selectedOptions={[lt.fromType]} onOptionSelect={(_, d) => patchLt({ fromType: d.optionValue || '' })}>
                    {objNames.map((n) => <Option key={n} value={n}>{n}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="To object type" required>
                  <Dropdown value={lt.toType} selectedOptions={[lt.toType]} onOptionSelect={(_, d) => patchLt({ toType: d.optionValue || '' })}>
                    {objNames.map((n) => <Option key={n} value={n}>{n}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Cardinality" required>
                  <Dropdown value={ONTO_CARDINALITY_LABELS[lt.cardinality]} selectedOptions={[lt.cardinality]} onOptionSelect={(_, d) => patchLt({ cardinality: (d.optionValue as OntoCardinality) || 'one-to-many' })}>
                    {ONTO_CARDINALITIES.map((c) => <Option key={c} value={c}>{ONTO_CARDINALITY_LABELS[c]}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Foreign-key property" hint="Property on the FK-holding side that materializes the link (one-to-one / one-to-many).">
                  <Input value={lt.foreignKeyProperty} onChange={(_, d) => patchLt({ foreignKeyProperty: d.value })} placeholder="customerId" />
                </Field>
                <Field label="Description"><Textarea value={lt.description} onChange={(_, d) => patchLt({ description: d.value })} /></Field>
                {ltErr && <MessageBar intent="error"><MessageBarBody>{ltErr}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setLtOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={saveLt}>{lt.index === null ? 'Add link type' : 'Save'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* ── Action-type dialog ── */}
      <Dialog open={atOpen} onOpenChange={(_, d) => setAtOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{at.index === null ? 'Add action type' : `Edit ${at.name}`}</DialogTitle>
            <DialogContent>
              <div className={s.tmDialogScroll}>
                <Field label="Action name" required>
                  <Input value={at.name} onChange={(_, d) => patchAt({ name: d.value })} placeholder="createOrder" />
                </Field>
                <Field label="Target object type" required>
                  <Dropdown value={at.objectType} selectedOptions={[at.objectType]} onOptionSelect={(_, d) => patchAt({ objectType: d.optionValue || '' })}>
                    {objNames.map((n) => <Option key={n} value={n}>{n}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Kind" required>
                  <Dropdown value={at.kind} selectedOptions={[at.kind]} onOptionSelect={(_, d) => patchAt({ kind: (d.optionValue as OntoActionType['kind']) || 'create' })}>
                    {ONTO_ACTION_KINDS.map((k) => <Option key={k} value={k}>{k}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Description"><Textarea value={at.description} onChange={(_, d) => patchAt({ description: d.value })} /></Field>
                <div className={s.tmSubBlock}>
                  <div className={s.ontoActionHead}>
                    <Settings20Regular />
                    <Subtitle2>Parameters</Subtitle2>
                    <span className={s.ontoBindRowSpacer} />
                    <Button size="small" icon={<Add16Regular />} onClick={() => patchAt({ parameters: [...at.parameters, { apiName: '', type: 'string' }] })}>Add parameter</Button>
                  </div>
                  {at.parameters.length === 0 ? (
                    <Caption1 className={s.ontoSectionHint}>No parameters yet. Add typed parameters the action accepts at run time.</Caption1>
                  ) : at.parameters.map((p, pi) => (
                    <div key={pi} className={s.tmParamRow}>
                      <Field label={pi === 0 ? 'API name' : undefined}>
                        <Input value={p.apiName} onChange={(_, d) => patchAt({ parameters: at.parameters.map((x, xi) => xi === pi ? { ...x, apiName: d.value } : x) })} placeholder="amount" />
                      </Field>
                      <Field label={pi === 0 ? 'Type' : undefined}>
                        <Dropdown value={ONTO_PARAM_TYPE_LABELS[p.type]} selectedOptions={[p.type]} onOptionSelect={(_, d) => patchAt({ parameters: at.parameters.map((x, xi) => xi === pi ? { ...x, type: (d.optionValue as OntoParamType) || 'string' } : x) })}>
                          {ONTO_PARAM_TYPES.map((pt) => <Option key={pt} value={pt}>{ONTO_PARAM_TYPE_LABELS[pt]}</Option>)}
                        </Dropdown>
                      </Field>
                      <Switch checked={!!p.required} label="Required" onChange={(_, d) => patchAt({ parameters: at.parameters.map((x, xi) => xi === pi ? { ...x, required: d.checked } : x) })} />
                      <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove parameter ${p.apiName || pi + 1}`} onClick={() => patchAt({ parameters: at.parameters.filter((_, xi) => xi !== pi) })} />
                    </div>
                  ))}
                </div>
                {atErr && <MessageBar intent="error"><MessageBarBody>{atErr}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAtOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={saveAt}>{at.index === null ? 'Add action type' : 'Save'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

export function OntologyEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<OntoState>('ontology', id, { source: ONTO_SAMPLE });
  const classes = parseOntologyHierarchy(state.source || '');
  const [materializing, setMaterializing] = useState(false);
  const [matMsg, setMatMsg] = useState<string | null>(null);

  // ── Lakehouse/Warehouse entity binding + Activator triggers (v3.28) ──
  // The deferred gate is lifted: bindings are persisted on the ontology item
  // (state.entityBindings) via /api/items/ontology/[id]/bind, and triggers are
  // real Azure Monitor scheduledQueryRules created via
  // /api/items/ontology/[id]/activator. Both default Azure-native (no Fabric).
  const [lakehouses, setLakehouses] = useState<{ id: string; displayName: string }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; displayName: string }[]>([]);
  const [entityBindings, setEntityBindings] = useState<OntologyEntityBinding[]>([]);
  const [bindingsLoaded, setBindingsLoaded] = useState(false);
  const [bindDlgOpen, setBindDlgOpen] = useState(false);
  const [bindBusy, setBindBusy] = useState(false);
  const [bindMsg, setBindMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [bindSourceKind, setBindSourceKind] = useState<'lakehouse' | 'warehouse'>('lakehouse');
  const [bindSourceId, setBindSourceId] = useState('');
  const [bindEntityTypes, setBindEntityTypes] = useState<string[]>([]);
  // Activator trigger creation.
  const [activatorBusy, setActivatorBusy] = useState(false);
  const [activatorMsg, setActivatorMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [actEntityType, setActEntityType] = useState('');
  const [actEmail, setActEmail] = useState('');
  const [actTable, setActTable] = useState('');

  // Load existing bindings + the lakehouse/warehouse candidate lists for this
  // ontology's workspace (resolved server-side from the item).
  const loadBindings = useCallback(async () => {
    if (!id || id === 'new') { setBindingsLoaded(true); return; }
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/bind`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { setBindingsLoaded(true); return; }
      const j = await r.json();
      if (j?.ok) {
        setLakehouses(Array.isArray(j.lakehouses) ? j.lakehouses : []);
        setWarehouses(Array.isArray(j.warehouses) ? j.warehouses : []);
        setEntityBindings(Array.isArray(j.entityBindings) ? j.entityBindings : []);
      }
    } catch { /* surfaced via the bind MessageBar on action */ }
    finally { setBindingsLoaded(true); }
  }, [id]);
  useEffect(() => { void loadBindings(); }, [loadBindings]);

  // Entity types that have a data-source binding (eligible for triggers).
  const boundEntityTypes = useMemo(() => {
    const set = new Set<string>();
    for (const b of entityBindings) for (const et of b.entityTypes || []) set.add(et);
    return Array.from(set);
  }, [entityBindings]);

  const openBindDlg = useCallback(() => {
    setBindMsg(null);
    setBindSourceKind('lakehouse');
    setBindSourceId('');
    setBindEntityTypes([]);
    setBindDlgOpen(true);
  }, []);

  const submitBinding = useCallback(async () => {
    if (!bindSourceId) { setBindMsg({ intent: 'error', text: 'Pick a source item.' }); return; }
    if (bindEntityTypes.length === 0) { setBindMsg({ intent: 'error', text: 'Select at least one entity type.' }); return; }
    const sourceList = bindSourceKind === 'lakehouse' ? lakehouses : warehouses;
    const sourceDisplayName = sourceList.find((s) => s.id === bindSourceId)?.displayName || bindSourceId;
    setBindBusy(true); setBindMsg(null);
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/bind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceKind: bindSourceKind, sourceItemId: bindSourceId, sourceDisplayName, entityTypes: bindEntityTypes }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setBindMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setEntityBindings(Array.isArray(j.entityBindings) ? j.entityBindings : []);
      setBindMsg({ intent: 'success', text: `Bound ${sourceDisplayName} → ${bindEntityTypes.join(', ')}.` });
      setBindDlgOpen(false);
    } catch (e: any) {
      setBindMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setBindBusy(false); }
  }, [id, bindSourceKind, bindSourceId, bindEntityTypes, lakehouses, warehouses]);

  const removeBinding = useCallback(async (b: OntologyEntityBinding) => {
    // Durably remove the binding via the bind route's DELETE handler, which
    // strips it from state.entityBindings and reconciles the bound* pointers.
    // Optimistically drop it locally, then reconcile from the server's
    // authoritative list (or roll back on failure).
    const prev = entityBindings;
    setEntityBindings((cur) => cur.filter((x) => x.sourceItemId !== b.sourceItemId));
    setBindMsg(null);
    try {
      const r = await fetch(
        `/api/items/ontology/${encodeURIComponent(id)}/bind?sourceItemId=${encodeURIComponent(b.sourceItemId)}`,
        { method: 'DELETE' },
      );
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        setEntityBindings(prev); // roll back
        setBindMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` });
        return;
      }
      setEntityBindings(Array.isArray(j.entityBindings) ? j.entityBindings : []);
      setBindMsg({ intent: 'success', text: `Removed binding ${b.sourceDisplayName}.` });
    } catch (e: any) {
      setEntityBindings(prev); // roll back
      setBindMsg({ intent: 'error', text: e?.message || String(e) });
    }
  }, [id, entityBindings]);

  const createTrigger = useCallback(async () => {
    if (!actEntityType) { setActivatorMsg({ intent: 'error', text: 'Pick an entity type.' }); return; }
    const binding = entityBindings.find((b) => (b.entityTypes || []).includes(actEntityType));
    setActivatorBusy(true); setActivatorMsg(null);
    try {
      const r = await fetch(`/api/items/ontology/${encodeURIComponent(id)}/activator`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entityType: actEntityType,
          sourceKind: binding?.sourceKind,
          sourceItemId: binding?.sourceItemId,
          sourceTable: actTable.trim() || undefined,
          action: actEmail.trim() ? { target: actEmail.trim() } : undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setActivatorMsg({ intent: 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setActivatorMsg({ intent: 'success', text: `Trigger '${j.rule?.name || actEntityType}-change' created on Azure Monitor (fires on INSERT/UPDATE/DELETE of ${actEntityType}).` });
    } catch (e: any) {
      setActivatorMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setActivatorBusy(false); }
  }, [id, actEntityType, actEmail, actTable, entityBindings]);

  // Add entity / Add relationship dialogs. Both append a line to the ontology
  // DSL (`Name : Parent -- description`) and persist via useItemState.save().
  const [entityDlgOpen, setEntityDlgOpen] = useState(false);
  const [relDlgOpen, setRelDlgOpen] = useState(false);
  const [entName, setEntName] = useState('');
  const [entParent, setEntParent] = useState('');
  const [entDesc, setEntDesc] = useState('');
  const [relChild, setRelChild] = useState('');
  const [relParent, setRelParent] = useState('');
  const [dlgErr, setDlgErr] = useState<string | null>(null);

  const openEntityDlg = () => { setEntName(''); setEntParent(''); setEntDesc(''); setDlgErr(null); setEntityDlgOpen(true); };
  const openRelDlg = () => { setRelChild(''); setRelParent(''); setDlgErr(null); setRelDlgOpen(true); };

  // Persist eagerly for existing items; for /new the Cosmos row doesn't exist
  // yet so save() would 404 — the user persists with the Save button instead.
  const persistOnto = useCallback((next: OntoState) => {
    setState(() => next);
    if (id && id !== 'new') save(next);
  }, [id, setState, save]);

  const appendSource = useCallback((line: string) => {
    persistOnto({ ...state, source: `${(state.source || '').replace(/\s*$/, '')}\n${line}\n` });
  }, [state, persistOnto]);

  const addEntity = useCallback(() => {
    const name = entName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setDlgErr('Entity name must start with a letter/underscore (letters, digits, _).'); return; }
    if (classes.some((c) => c.name === name)) { setDlgErr(`Entity "${name}" already exists.`); return; }
    const parent = entParent.trim();
    const desc = entDesc.trim();
    appendSource(`${name} : ${parent} ${desc ? `-- ${desc}` : ''}`.trimEnd());
    setEntityDlgOpen(false);
  }, [entName, entParent, entDesc, classes, appendSource]);

  const addRelationship = useCallback(() => {
    const child = relChild.trim();
    const parent = relParent.trim();
    if (!child || !parent) { setDlgErr('Pick both a child and a parent entity.'); return; }
    if (child === parent) { setDlgErr('Child and parent must differ.'); return; }
    // IS_A is the `Child : Parent` edge in the DSL. Rewrite the child's
    // existing line (keeping any description) so we set the parent in place
    // rather than appending a duplicate class definition.
    const lineRe = new RegExp(`^(\\s*)${child}(\\s*:)[^\\n]*$`, 'm');
    let nextSource: string;
    if (lineRe.test(state.source || '')) {
      nextSource = (state.source || '').replace(lineRe, (_m, indent: string) => {
        const existing = classes.find((c) => c.name === child);
        const desc = existing?.description ? ` -- ${existing.description}` : '';
        return `${indent}${child} : ${parent}${desc}`;
      });
    } else {
      nextSource = `${(state.source || '').replace(/\s*$/, '')}\n${child} : ${parent} -- is_a\n`;
    }
    persistOnto({ ...state, source: nextSource });
    setRelDlgOpen(false);
  }, [relChild, relParent, classes, state, persistOnto]);

  // v3.27: D-upgrade — materialize the ontology hierarchy as a graph-model.
  // Each class becomes a node type; parent → child edges become an `is_a`
  // relationship type. The new graph-model can then be ADX-materialized
  // via its own /materialize endpoint to create real KQL tables.
  const materializeToGraphModel = useCallback(async () => {
    if (classes.length === 0) {
      setMatMsg('No classes parsed — nothing to materialize.');
      return;
    }
    setMaterializing(true); setMatMsg(null);
    try {
      const nodes = classes.map(c => ({
        name: c.name,
        properties: [
          { name: 'id', type: 'string' },
          ...(c.description ? [{ name: 'description', type: 'string' }] : []),
        ],
      }));
      const hasParents = classes.some(c => c.parent);
      const edges = hasParents
        ? [{ name: 'IS_A', properties: [{ name: 'inheritedAt', type: 'datetime' }] }]
        : [];
      const r = await fetch('/api/items/graph-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'default',
          displayName: `${item.displayName || 'Ontology'} graph (from ontology ${id})`,
          state: {
            nodes,
            edges,
            database: 'loomdb-default',
            sourceOntologyId: id,
            sourceOntologyClasses: classes.length,
          },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setMatMsg(`Failed: ${j.error || `HTTP ${r.status}`}`); return; }
      setMatMsg(`Materialized as graph-model id=${j.item?.id || j.id} with ${nodes.length} node type(s) + ${edges.length} edge type(s). Open the graph-model editor and click Materialize to push to ADX.`);
    } catch (e: any) {
      setMatMsg(`Failed: ${e?.message || String(e)}`);
    } finally { setMaterializing(false); }
  }, [classes, id, item.displayName]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Author', actions: [
        { label: 'Add entity', onClick: openEntityDlg, disabled: saving, title: 'Add an ontology class' },
        { label: 'Add relationship', onClick: openRelDlg, disabled: saving || classes.length < 1, title: classes.length < 1 ? 'Add at least one entity first' : 'Add an IS_A relationship between two classes' },
      ]},
      { label: 'Bind', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: materializing ? 'Materializing…' : 'Materialize', onClick: materializeToGraphModel, disabled: materializing || classes.length === 0 },
        { label: 'Bind to data source', onClick: openBindDlg, disabled: id === 'new' || classes.length === 0, title: id === 'new' ? 'Save the ontology first' : classes.length === 0 ? 'Add an entity first' : 'Bind a Lakehouse / Warehouse to entity types' },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, materializeToGraphModel, materializing, classes.length, openBindDlg, id]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Ontology runtime</MessageBarTitle>
            <strong>Materialize as graph-model</strong> converts the parsed class hierarchy into a graph-model item (one node type per class, IS_A edge type for parent relationships) that can then be ADX-materialized to real KQL tables. Use <strong>Bind to data source</strong> (Home ribbon) to map Lakehouse / Warehouse tables onto entity types, then create <strong>Activator triggers</strong> below that fire on entity changes (real Azure Monitor alert rules — no Microsoft Fabric required).
          </MessageBarBody>
        </MessageBar>

        {/* ── Typed modeling surface (object / link / action types) ── */}
        <OntologyTypedModelPanel id={id} state={state} persistOnto={persistOnto} lakehouses={lakehouses} warehouses={warehouses} saving={saving} />

        <div className={s.ontoSourceGrid}>
          <div>
            <Subtitle2>Source ({classes.length} classes)</Subtitle2>
            <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalSNudge, color: tokens.colorNeutralForeground3 }}>
              One class per line — DSL: <code>ClassName : ParentClass -- description</code> (parent and
              description optional). Example: <code>Account : Party -- a customer account</code>. Indentation is
              ignored; <code>Child : Parent</code> defines the IS_A hierarchy.
            </Caption1>
            {/* Warn when nothing parses, so the editor doesn't silently produce a
                0-class ontology that materialize/bind/run-action can't act on. */}
            {classes.length === 0 && (state.source || '').trim().length > 0 && (
              <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalSNudge }}>
                <MessageBarBody>
                  The source has content but parsed to <strong>0 classes</strong>. Each class needs its own line
                  in the form <code>ClassName : ParentClass -- description</code>. Fix the grammar above and the
                  class hierarchy will populate.
                </MessageBarBody>
              </MessageBar>
            )}
            {/* v3.28 Phase 4.5: functional setState — materializeToGraphModel
                does NOT write back to state, so this is defensive but cheap. */}
            <MonacoTextarea value={state.source} onChange={(v) => setState((p) => ({ ...p, source: v }))} language="json" height={400} minHeight={320} ariaLabel="Ontology source" />
          </div>
          <div>
            <Subtitle2>Class hierarchy</Subtitle2>
            <Tree aria-label="Class hierarchy">
              {classes.map((c) => (
                <TreeItem itemType="leaf" key={c.name}>
                  <TreeItemLayout>
                    <strong>{c.name}</strong>
                    {c.parent && <Caption1 style={{ marginLeft: tokens.spacingHorizontalSNudge, color: tokens.colorNeutralForeground3 }}>: {c.parent}</Caption1>}
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
            <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Hierarchy graph</Subtitle2>
            <OntologyHierarchyViz classes={classes} />
            <Button appearance="primary" disabled={materializing || classes.length === 0} onClick={materializeToGraphModel} style={{ marginTop: tokens.spacingVerticalS, alignSelf: 'flex-start' }}>
              {materializing ? 'Materializing…' : `Materialize as graph-model (${classes.length} class${classes.length === 1 ? '' : 'es'})`}
            </Button>
            {matMsg && (
              <MessageBar intent={matMsg.startsWith('Failed') ? 'error' : 'success'} style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>{matMsg}</MessageBarBody>
              </MessageBar>
            )}
          </div>
        </div>

        {/* ── Data bindings + Activator triggers (deferred gate lifted v3.28) ── */}
        <div className={s.ontoBindGrid}>
          <div className={s.ontoSection}>
            <div className={s.ontoSectionHead}>
              <span className={s.ontoSectionIcon}><Link20Regular /></span>
              <div>
                <Subtitle2>Data bindings{entityBindings.length > 0 ? <Badge appearance="tint" color="informative" style={{ marginLeft: tokens.spacingHorizontalS }}>{entityBindings.length}</Badge> : null}</Subtitle2>
                <Caption1 as="p" block className={s.ontoSectionHint}>
                  Map Lakehouse / Warehouse tables onto ontology entity types. Rows of the bound source become instances of the entity. Azure-native (no Fabric).
                </Caption1>
              </div>
            </div>
            <Button appearance="primary" icon={<Database20Regular />} onClick={openBindDlg} disabled={id === 'new' || classes.length === 0} className={s.ontoStartBtn}>
              Bind to data source
            </Button>
            {!bindingsLoaded && id !== 'new' ? (
              <div className={s.ontoLoading}><Spinner size="tiny" /><Caption1>Loading data bindings…</Caption1></div>
            ) : id === 'new' ? (
              <div className={s.ontoEmpty}><Caption1>Save the ontology to enable binding.</Caption1></div>
            ) : entityBindings.length === 0 ? (
              <div className={s.ontoEmpty}><Caption1>No data sources bound yet. Use <strong>Bind to data source</strong> to connect a Lakehouse or Warehouse.</Caption1></div>
            ) : (
              entityBindings.map((b) => (
                <div key={b.sourceItemId} className={s.ontoBindRow}>
                  <Badge appearance="tint" color={b.sourceKind === 'lakehouse' ? 'brand' : 'success'}>{b.sourceKind}</Badge>
                  <Body1><strong>{b.sourceDisplayName}</strong></Body1>
                  <Caption1 className={s.ontoSectionHint}>→ {(b.entityTypes || []).join(', ')}</Caption1>
                  <span className={s.ontoBindRowSpacer} />
                  <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove binding ${b.sourceDisplayName}`} onClick={() => removeBinding(b)}>Remove</Button>
                </div>
              ))
            )}
            {bindMsg && !bindDlgOpen && (
              <MessageBar intent={bindMsg.intent}><MessageBarBody>{bindMsg.text}</MessageBarBody></MessageBar>
            )}
          </div>

          <div className={s.ontoSection}>
            <div className={s.ontoSectionHead}>
              <span className={s.ontoSectionIcon}><Flash20Regular /></span>
              <div>
                <Subtitle2>Activator triggers</Subtitle2>
                <Caption1 as="p" block className={s.ontoSectionHint}>
                  Fire a real Azure Monitor alert when a bound entity changes (INSERT / UPDATE / DELETE). The first trigger creates a backing Activator item.
                </Caption1>
              </div>
            </div>
            {boundEntityTypes.length === 0 ? (
              <MessageBar intent="info"><MessageBarBody>Bind a data source first — triggers run on bound entity types.</MessageBarBody></MessageBar>
            ) : (
              <>
                <Field label="Entity type" required>
                  <Dropdown value={actEntityType} selectedOptions={actEntityType ? [actEntityType] : []} onOptionSelect={(_, d) => setActEntityType(d.optionValue || '')} placeholder="Select a bound entity type">
                    {boundEntityTypes.map((et) => <Option key={et} value={et}>{et}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Source table (optional override)" hint="Defaults to the entity-change event table (LOOM_ACTIVATOR_DEFAULT_TABLE).">
                  <Input value={actTable} onChange={(_, d) => setActTable(d.value)} placeholder="dbo.Customer" />
                </Field>
                <Field label="Notify email (optional)">
                  <Input value={actEmail} onChange={(_, d) => setActEmail(d.value)} placeholder="oncall@contoso.com" />
                </Field>
                <Button appearance="primary" icon={activatorBusy ? <Spinner size="tiny" /> : <Sparkle20Regular />} onClick={createTrigger} disabled={activatorBusy || !actEntityType} className={s.ontoStartBtn}>
                  {activatorBusy ? 'Creating…' : 'Create trigger'}
                </Button>
              </>
            )}
            {activatorMsg && (
              <MessageBar intent={activatorMsg.intent}><MessageBarBody>{activatorMsg.text}</MessageBarBody></MessageBar>
            )}
          </div>
        </div>

        {/* ── Weave Phase 1: object instances + write-back actions (PG + AGE) ── */}
        <WeaveInstancePanel
          id={id}
          classes={classes}
          actionTypes={Array.isArray(state.actionTypes) ? state.actionTypes : []}
          onActionTypesChange={(next) => persistOnto({ ...state, actionTypes: normalizeOntoActionTypes(next) })}
        />

        <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />

        {/* Bind-to-data-source dialog: source kind → source item → entity types. */}
        <Dialog open={bindDlgOpen} onOpenChange={(_, d) => setBindDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Bind data source to entity types</DialogTitle>
              <DialogContent>
                <Field label="Source kind" required>
                  <Dropdown
                    value={bindSourceKind === 'lakehouse' ? 'Lakehouse' : 'Warehouse'}
                    selectedOptions={[bindSourceKind]}
                    onOptionSelect={(_, d) => { setBindSourceKind((d.optionValue as 'lakehouse' | 'warehouse') || 'lakehouse'); setBindSourceId(''); }}
                  >
                    <Option value="lakehouse">Lakehouse</Option>
                    <Option value="warehouse">Warehouse</Option>
                  </Dropdown>
                </Field>
                <Field label="Source item" required>
                  {(bindSourceKind === 'lakehouse' ? lakehouses : warehouses).length === 0 ? (
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No {bindSourceKind}s in this workspace. Create one first.</Caption1>
                  ) : (
                    <Dropdown
                      value={(bindSourceKind === 'lakehouse' ? lakehouses : warehouses).find((s) => s.id === bindSourceId)?.displayName || ''}
                      selectedOptions={bindSourceId ? [bindSourceId] : []}
                      onOptionSelect={(_, d) => setBindSourceId(d.optionValue || '')}
                      placeholder={`Select a ${bindSourceKind}`}
                    >
                      {(bindSourceKind === 'lakehouse' ? lakehouses : warehouses).map((s) => <Option key={s.id} value={s.id}>{s.displayName}</Option>)}
                    </Dropdown>
                  )}
                </Field>
                <Field label="Entity types" required hint="Classes whose instances live in this source. Suggested matches (same name as a table) are pre-selected.">
                  <Dropdown
                    multiselect
                    value={bindEntityTypes.join(', ')}
                    selectedOptions={bindEntityTypes}
                    onOptionSelect={(_, d) => setBindEntityTypes(d.selectedOptions)}
                    placeholder="Select one or more entity types"
                  >
                    {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                  </Dropdown>
                </Field>
                {bindMsg && bindDlgOpen && <MessageBar intent={bindMsg.intent}><MessageBarBody>{bindMsg.text}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setBindDlgOpen(false)} disabled={bindBusy}>Cancel</Button>
                <Button appearance="primary" onClick={submitBinding} disabled={bindBusy} icon={bindBusy ? <Spinner size="tiny" /> : undefined}>{bindBusy ? 'Binding…' : 'Bind'}</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Dialog open={entityDlgOpen} onOpenChange={(_, d) => setEntityDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add entity (ontology class)</DialogTitle>
              <DialogContent>
                <Field label="Class name" required>
                  <Input value={entName} onChange={(_, d) => setEntName(d.value)} placeholder="Invoice" />
                </Field>
                <Field label="Parent class (optional)">
                  <Dropdown value={entParent} selectedOptions={entParent ? [entParent] : []} onOptionSelect={(_, d) => setEntParent(d.optionValue || '')} placeholder="(none — root)">
                    <Option value="">(none — root)</Option>
                    {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Description (optional)">
                  <Input value={entDesc} onChange={(_, d) => setEntDesc(d.value)} placeholder="billing document" />
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setEntityDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addEntity}>Add entity</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Dialog open={relDlgOpen} onOpenChange={(_, d) => setRelDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add relationship (IS_A)</DialogTitle>
              <DialogContent>
                <Caption1>Sets the parent of one class to another (the IS_A hierarchy this ontology models).</Caption1>
                <Field label="Child class" required>
                  <Dropdown value={relChild} selectedOptions={relChild ? [relChild] : []} onOptionSelect={(_, d) => setRelChild(d.optionValue || '')} placeholder="Select a class">
                    {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Parent class" required>
                  <Dropdown value={relParent} selectedOptions={relParent ? [relParent] : []} onOptionSelect={(_, d) => setRelParent(d.optionValue || '')} placeholder="Select a class">
                    {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                  </Dropdown>
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setRelDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addRelationship}>Add relationship</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    } />
  );
}

