'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Variable Library editor (Cosmos, typed key/value with value sets).
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

// ----- Variable Library (Cosmos, typed key/value with value sets) -----
// v3.27: extended to Fabric's 7 variable types — String/Integer/Number/
// Boolean/DateTime/Guid/ItemReference/ConnectionReference. Plus the
// Loom-native `secret-ref` for KV / env-var lookups.
// `VarType` is imported from `_family-utils` (see the top-of-file
// import block — it matches the vitest contract).
interface VarDef { name: string; type: VarType; default: string; dev?: string; test?: string; prod?: string; description?: string; }
// `activeValueSet` mirrors Fabric's per-workspace active value set (settings.json).
interface VlState { variables: VarDef[]; activeValueSet?: string; [k: string]: unknown }
const VL_VALUE_SETS: Array<'default' | 'dev' | 'test' | 'prod'> = ['default', 'dev', 'test', 'prod'];

const VAR_TYPE_LABELS: Record<VarType, string> = {
  string: 'String',
  integer: 'Integer',
  number: 'Number',
  bool: 'Boolean',
  datetime: 'DateTime',
  guid: 'Guid',
  'item-ref': 'ItemReference',
  'connection-ref': 'ConnectionReference',
  'secret-ref': 'SecretReference',
};
const VAR_TYPE_PLACEHOLDERS: Record<VarType, string> = {
  string: '',
  integer: '0',
  number: '0.0',
  bool: 'true | false',
  datetime: 'YYYY-MM-DDThh:mm:ssZ',
  guid: '00000000-0000-0000-0000-000000000000',
  'item-ref': 'Loom item id (Cosmos)',
  'connection-ref': 'connection id (ADF Linked Service / Power Platform connection)',
  'secret-ref': 'kv-uri or env var name',
};

// `validateVarValue` is imported from `_family-utils` (see top-of-file
// imports — vitest coverage at `lib/editors/__tests__/family-utils.test.ts`).

export function VariableLibraryEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<VlState>('variable-library', id, {
    variables: [
      { name: 'ENV', type: 'string', default: 'dev' },
      { name: 'BatchSize', type: 'number', default: '5000' },
      { name: 'EnableCopilot', type: 'bool', default: 'true' },
    ],
  });
  const [tab, setTab] = useState<typeof VL_VALUE_SETS[number]>('default');
  // v3.28 Phase 4.5: functional setState so concurrent edits + the auto-reload
  // from useItemState's PATCH response don't clobber rapid typing.
  const update = (idx: number, patch: Partial<VarDef>) => {
    setState((prev) => {
      const next = [...arr<VarDef>(prev.variables)];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, variables: next };
    });
  };
  const addRow = () => setState((prev) => {
    const cur = arr<VarDef>(prev.variables);
    return { ...prev, variables: [...cur, { name: `var${cur.length + 1}`, type: 'string', default: '' }] };
  });
  const deleteRow = (idx: number) => setState((prev) => ({
    ...prev,
    variables: arr<VarDef>(prev.variables).filter((_, i) => i !== idx),
  }));
  const valueKey = tab === 'default' ? 'default' : tab;

  // Resolve panel — calls the real dereference layer (/resolve), which pulls
  // secret-ref variables out of Key Vault and expands @{variables.NAME}.
  const [resolved, setResolved] = useState<Array<{ name: string; type: string; value: string; secret: boolean; resolvedFromKv?: boolean; error?: string }> | null>(null);
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [expandText, setExpandText] = useState('@{variables.ENV}/batch?size=@{variables.BatchSize}');
  const [expandOut, setExpandOut] = useState<string | null>(null);
  const runResolve = useCallback(async () => {
    if (id === 'new') { setResolveErr('Save the library before resolving.'); return; }
    setResolveBusy(true); setResolveErr(null);
    try {
      const r = await clientFetch(`/api/items/variable-library/${encodeURIComponent(id)}/resolve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ valueSet: tab, text: expandText }),
      });
      const j = await r.json();
      if (!j.ok) { setResolveErr(j.error || 'resolve failed'); setResolved([]); return; }
      setResolved(j.resolved || []);
      setExpandOut(j.expanded ?? null);
    } catch (e: any) { setResolveErr(e?.message || String(e)); setResolved([]); }
    finally { setResolveBusy(false); }
  }, [id, tab, expandText]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Variables', actions: [
        { label: 'New variable', onClick: addRow },
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
      ]},
      { label: 'Value sets', actions: [
        { label: 'dev', onClick: () => setTab('dev'), appearance: tab === 'dev' ? 'primary' : 'subtle' },
        { label: 'test', onClick: () => setTab('test'), appearance: tab === 'test' ? 'primary' : 'subtle' },
        { label: 'prod', onClick: () => setTab('prod'), appearance: tab === 'prod' ? 'primary' : 'subtle' },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, tab, addRow]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            {VL_VALUE_SETS.map((v) => <Tab key={v} value={v}>{v}</Tab>)}
          </TabList>
        </div>
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          <MessageBar intent="info">
            <MessageBarBody>
              Reference variables in pipelines / notebooks as <code>@{'{'}variables.NAME{'}'}</code>. The active value set is resolved at runtime by the executor.
            </MessageBarBody>
          </MessageBar>
          {/* Active value set — mirrors Fabric's per-workspace active set. The
              runtime executor reads state.activeValueSet to resolve values. */}
          <Field label="Active value set (resolved at runtime)">
            <Dropdown
              value={state.activeValueSet || 'default'}
              selectedOptions={[state.activeValueSet || 'default']}
              onOptionSelect={(_, d) => d.optionValue && setState((p) => ({ ...p, activeValueSet: d.optionValue }))}
            >
              {VL_VALUE_SETS.map((v) => <Option key={v} value={v}>{`${v}${v === (state.activeValueSet || 'default') ? ' (active)' : ''}`}</Option>)}
            </Dropdown>
          </Field>
          <Table aria-label="Variables" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Value ({tab})</TableHeaderCell>
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell />
            </TableRow></TableHeader>
            <TableBody>
              {arr<VarDef>(state.variables).map((v, i) => {
                const val = (v as any)[valueKey] ?? '';
                const validationErr = validateVarValue(v.type, val);
                return (
                  <TableRow key={i}>
                    <TableCell><Input value={v.name} onChange={(_, d) => update(i, { name: d.value })} /></TableCell>
                    <TableCell>
                      <select value={v.type} onChange={(e) => update(i, { type: e.target.value as VarType })}
                        style={{ padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                        {Object.entries(VAR_TYPE_LABELS).map(([t, label]) => (
                          <option key={t} value={t}>{label}</option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
                        <Input value={val} onChange={(_, d) => update(i, { [valueKey]: d.value } as any)}
                          placeholder={VAR_TYPE_PLACEHOLDERS[v.type]} />
                        {validationErr && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{validationErr}</Caption1>}
                      </div>
                    </TableCell>
                    <TableCell><Input value={v.description ?? ''} onChange={(_, d) => update(i, { description: d.value })} placeholder="optional" /></TableCell>
                    <TableCell><Button size="small" onClick={() => deleteRow(i)}>Delete</Button></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Button onClick={addRow} style={{ alignSelf: 'flex-start' }}>+ New variable</Button>

          {/* Resolve / dereference — the real substitution layer. */}
          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalM }}><Play20Regular className={s.secHeadIcon} /><Subtitle2>Resolve values ({tab})</Subtitle2></div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Resolves every variable for the <strong>{tab}</strong> value set and expands <code>@{'{'}variables.NAME{'}'}</code> below.
            <code> secret-ref</code> variables are dereferenced from Key Vault (value masked).
          </Caption1>
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            <Textarea value={expandText} onChange={(_, d) => setExpandText(d.value)} rows={2} placeholder="@{variables.ENV}/path" />
            <Button appearance="primary" onClick={runResolve} disabled={resolveBusy || id === 'new'} style={{ alignSelf: 'flex-start' }}>
              {resolveBusy ? 'Resolving…' : 'Resolve'}
            </Button>
            {resolveErr && <MessageBar intent="error"><MessageBarBody>{resolveErr}</MessageBarBody></MessageBar>}
            {expandOut != null && (
              <>
                <Caption1>Expanded</Caption1>
                <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 120 }}>{expandOut || '(empty)'}</div>
              </>
            )}
            {resolved && resolved.length > 0 && (
              <Table size="small" aria-label="Resolved values">
                <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Resolved value</TableHeaderCell></TableRow></TableHeader>
                <TableBody>
                  {resolved.map((rv) => (
                    <TableRow key={rv.name}>
                      <TableCell><strong>{rv.name}</strong></TableCell>
                      <TableCell>{rv.type}{rv.secret && rv.resolvedFromKv ? <> <Badge appearance="tint" color="success">Key Vault</Badge></> : null}</TableCell>
                      <TableCell style={{ fontFamily: 'monospace' }}>
                        {rv.error ? <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{rv.error}</Caption1> : (rv.value || '(empty)')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>
      </>
    } />
  );
}

