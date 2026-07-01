'use client';

/**
 * Graph Model editor (Cosmos config + real ADX materialize).
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

// ----- Graph Model (Cosmos config + real ADX materialize) -----
interface GraphProp { name: string; type: string; sourceColumn?: string }
interface GraphDecl {
  name: string;
  properties: GraphProp[];
  // P0 source-table binding — what /materialize uses to `.set-or-append` rows.
  sourceDatabase?: string;
  sourceTable?: string;
  keyColumns?: string[];        // node identity (compound keys allowed)
  originKeyColumns?: string[];  // edge src → origin node key
  targetKeyColumns?: string[];  // edge dst → target node key
}
interface GraphState { nodes: GraphDecl[]; edges: GraphDecl[]; database: string; lastMaterializedAt?: string; [k: string]: unknown }

// Derive a force-directed graph from the graph-model schema: one node per
// node type, one edge per edge type. Edges that recorded srcType/dstType
// connect the right node types; otherwise they fan from the first node type.
function GraphModelSchemaViz({ nodes, edges }: { nodes: GraphDecl[]; edges: GraphDecl[] }) {
  const g = useMemo(() => {
    const vizNodes = nodes.map((n) => ({ id: n.name, label: n.name }));
    const ids = new Set(vizNodes.map((n) => n.id));
    const vizEdges = edges.map((e) => {
      const src = e.properties?.find((p) => p.name === 'srcType')?.type;
      const dst = e.properties?.find((p) => p.name === 'dstType')?.type;
      // srcType/dstType were stored as property *types* in the add dialog when
      // a from/to node was chosen; fall back to first/last node type.
      const source = (src && ids.has(src) ? src : nodes[0]?.name) || e.name;
      const target = (dst && ids.has(dst) ? dst : nodes[nodes.length - 1]?.name) || e.name;
      return { source, target, label: e.name };
    });
    return { nodes: vizNodes, edges: vizEdges };
  }, [nodes, edges]);
  if (g.nodes.length === 0) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Add a node type to see the schema graph.</Caption1>;
  return <ForceDirectedGraph nodes={g.nodes} edges={g.edges} height={300} />;
}

export function GraphModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<GraphState>('graph-model', id, {
    nodes: [{ name: 'Customer', properties: [{ name: 'name', type: 'string' }] }],
    edges: [{ name: 'PLACED', properties: [{ name: 'at', type: 'datetime' }] }],
    database: 'loomdb-default',
  });
  const [materializing, setMaterializing] = useState(false);
  const [matResult, setMatResult] = useState<any>(null);

  // Query surface — run GQL/openCypher (translated to ADX `make-graph` +
  // `graph-match`) or raw KQL over the materialized Node_*/Edge_* tables.
  const [gql, setGql] = useState('MATCH (a)-[e]->(b)\nRETURN a.id, b.id');
  const [qRunning, setQRunning] = useState(false);
  const [qResult, setQResult] = useState<any>(null);
  const [qView, setQView] = useState<'table' | 'card' | 'diagram'>('table');

  const safeT = (prefix: string, n: string) => `${prefix}${String(n).replace(/[^A-Za-z0-9_]/g, '_')}`;

  // Patch a single node/edge type in place (used by the per-type source binding).
  const patchType = useCallback((kind: 'node' | 'edge', index: number, patch: Partial<GraphDecl>) => {
    setState((p) => {
      const key = kind === 'node' ? 'nodes' : 'edges';
      const list = arr<GraphDecl>(p[key]).map((t, i) => (i === index ? { ...t, ...patch } : t));
      return { ...p, [key]: list };
    });
  }, [setState]);

  const runQuery = useCallback(async () => {
    setQRunning(true); setQResult(null);
    try {
      const r = await fetch(`/api/items/graph-model/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          database: state.database, gql,
          nodeTables: arr<GraphDecl>(state.nodes).map((n) => safeT('Node_', n.name)),
          edgeTables: arr<GraphDecl>(state.edges).map((e) => safeT('Edge_', e.name)),
        }),
      });
      setQResult(await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` })));
    } catch (e: any) { setQResult({ ok: false, error: e?.message || String(e) }); }
    finally { setQRunning(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, state.database, state.nodes, state.edges, gql]);

  // Diagram view — when a graph-match projection returns ≥2 columns, draw the
  // first two as source → target vertices (a real, honest edge picture).
  const qDiagram = useMemo(() => {
    if (!qResult?.ok || !Array.isArray(qResult.rows) || (qResult.columns || []).length < 2) return null;
    const ids = new Set<string>();
    const edges = qResult.rows.slice(0, 200).map((row: any[]) => {
      const sN = String(row[0]); const tN = String(row[1]);
      ids.add(sN); ids.add(tN);
      return { source: sN, target: tN, label: (qResult.columns || []).length > 2 ? String(row[2]) : undefined };
    });
    return { nodes: Array.from(ids).map((nid) => ({ id: nid, label: nid })), edges };
  }, [qResult]);

  // Add entity / Add relationship dialogs — append a typed declaration to
  // state.nodes[] / state.edges[]. The edit flows the dirty flag so SaveBar
  // (and Ctrl+S) persist to Cosmos via useItemState.save().
  const [nodeDlgOpen, setNodeDlgOpen] = useState(false);
  const [edgeDlgOpen, setEdgeDlgOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [propsText, setPropsText] = useState('');
  const [edgeSrc, setEdgeSrc] = useState('');
  const [edgeDst, setEdgeDst] = useState('');
  const [dlgErr, setDlgErr] = useState<string | null>(null);

  // Parse "name:type, name2:type2" → [{name,type}]. Blank → [].
  const parseProps = (txt: string): { name: string; type: string }[] =>
    txt.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const [n, t] = p.split(':').map((x) => x.trim());
      return { name: n, type: (t || 'string') };
    });

  const openNodeDlg = () => { setNewName(''); setPropsText(''); setDlgErr(null); setNodeDlgOpen(true); };
  const openEdgeDlg = () => { setNewName(''); setPropsText(''); setEdgeSrc(''); setEdgeDst(''); setDlgErr(null); setEdgeDlgOpen(true); };

  // Add buttons mutate state + flip dirty; the user persists with Save / Ctrl+S
  // (or Materialize, which saves first). For an already-persisted item we also
  // fire save(next) so the addition lands immediately; for /new items save()
  // would 404 (no Cosmos row yet), so we skip the eager save there.
  const persistIfExisting = (next: GraphState) => {
    setState(() => next);
    if (id && id !== 'new') save(next);
  };

  const addEntity = useCallback(() => {
    const name = newName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setDlgErr('Entity name must start with a letter/underscore (letters, digits, _).'); return; }
    if (arr<{ name: string }>(state.nodes).some((n) => n.name === name)) { setDlgErr(`Entity "${name}" already exists.`); return; }
    persistIfExisting({ ...state, nodes: [...arr<GraphDecl>(state.nodes), { name, properties: parseProps(propsText) }] });
    setNodeDlgOpen(false);
  }, [newName, propsText, state, id, setState, save]);

  const addRelationship = useCallback(() => {
    const name = newName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setDlgErr('Relationship name must start with a letter/underscore (letters, digits, _).'); return; }
    if (arr<{ name: string }>(state.edges).some((e) => e.name === name)) { setDlgErr(`Relationship "${name}" already exists.`); return; }
    const props = parseProps(propsText);
    // src/dst node types captured as edge properties so the materialize step +
    // queries can reference the connected node types.
    if (edgeSrc.trim()) props.unshift({ name: 'srcType', type: 'string' });
    if (edgeDst.trim()) props.unshift({ name: 'dstType', type: 'string' });
    persistIfExisting({ ...state, edges: [...arr<GraphDecl>(state.edges), { name, properties: props }] });
    setEdgeDlgOpen(false);
  }, [newName, propsText, edgeSrc, edgeDst, state, id, setState, save]);

  const materialize = useCallback(async () => {
    setMaterializing(true); setMatResult(null);
    const ok = await save();
    if (!ok) { setMaterializing(false); return; }
    try {
      const r = await fetch(`/api/items/graph-model/${encodeURIComponent(id)}/materialize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ database: state.database, nodes: arr(state.nodes), edges: arr(state.edges) }),
      });
      const j = await r.json();
      setMatResult(j);
      if (r.ok && j.ok) {
        // v3.28 Phase 4.5: stale-closure fix. Previously `next = { ...state, ... }`
        // captured `state` at click-time and clobbered any typing that happened
        // during the in-flight POST. Use functional setState + capture the merged
        // result for the immediate save() call so what we PATCH matches what
        // the user sees.
        let merged: GraphState | null = null;
        setState((prev) => {
          merged = { ...prev, lastMaterializedAt: new Date().toISOString() };
          return merged;
        });
        if (merged) await save(merged);
      }
    } catch (e: any) { setMatResult({ ok: false, error: e?.message || String(e) }); }
    finally { setMaterializing(false); }
  }, [id, save, setState]);


  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Author', actions: [
        { label: 'Add entity', onClick: openNodeDlg, disabled: saving, title: 'Add a node type to the graph model' },
        { label: 'Add relationship', onClick: openEdgeDlg, disabled: saving, title: 'Add an edge type connecting node types' },
      ]},
      { label: 'Bind', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: materializing ? 'Building…' : 'Build graph', onClick: materialize, disabled: materializing || saving },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, materialize, materializing]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <Caption1>Target ADX database</Caption1>
        <Input value={state.database} onChange={(_, d) => setState((p) => ({ ...p, database: d.value }))} />
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM }}>
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            <div className={s.secHead}><BranchFork20Regular className={s.secHeadIcon} /><Subtitle2>Node types</Subtitle2></div>
            <GraphTypeEditor kind="node" types={arr(state.nodes)}
              onChange={(next) => setState((p) => ({ ...p, nodes: next }))} />
            {arr<GraphDecl>(state.nodes).map((n, i) => (
              <Card key={`ns-${i}`} style={{ padding: tokens.spacingVerticalS }}>
                <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>{n.name || `(node ${i + 1})`}</Caption1>
                <GraphSourceBinding itemId={id} kind="node" type={n as SourceBindable}
                  onChange={(patch) => patchType('node', i, patch as Partial<GraphDecl>)} />
              </Card>
            ))}
          </div>
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            <div className={s.secHead}><Link20Regular className={s.secHeadIcon} /><Subtitle2>Edge types</Subtitle2></div>
            <GraphTypeEditor kind="edge" types={arr(state.edges)}
              onChange={(next) => setState((p) => ({ ...p, edges: next }))} />
            {arr<GraphDecl>(state.edges).map((e, i) => (
              <Card key={`es-${i}`} style={{ padding: tokens.spacingVerticalS }}>
                <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>{e.name || `(edge ${i + 1})`}</Caption1>
                <GraphSourceBinding itemId={id} kind="edge" type={e as SourceBindable}
                  onChange={(patch) => patchType('edge', i, patch as Partial<GraphDecl>)} />
              </Card>
            ))}
          </div>
        </div>
        <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><ChartMultiple20Regular className={s.secHeadIcon} /><Subtitle2>Schema graph</Subtitle2></div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Node types are vertices; edge types whose properties carry <code>srcType</code> / <code>dstType</code> connect them, others link to a shared hub.
        </Caption1>
        <GraphModelSchemaViz nodes={arr(state.nodes)} edges={arr(state.edges)} />
        {state.lastMaterializedAt && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Last built {new Date(state.lastMaterializedAt).toLocaleString()}</Caption1>
        )}
        {matResult && matResult.gate && (
          <MessageBar intent="warning">
            <MessageBarBody><MessageBarTitle>Build graph unavailable</MessageBarTitle>{matResult.gate.remediation}</MessageBarBody>
          </MessageBar>
        )}
        {matResult && !matResult.gate && (
          <MessageBar intent={matResult.ok ? 'success' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>
                {matResult.ok
                  ? (Array.isArray(matResult.loaded) && matResult.loaded.some((l: any) => l.ok) ? 'Data load completed' : `Graph built in ${matResult.database}`)
                  : 'Build graph failed'}
              </MessageBarTitle>
              {Array.isArray(matResult.created) && matResult.created.length > 0 && (
                <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0 ${tokens.spacingHorizontalL}`, padding: 0 }}>
                  {matResult.created.map((c: any, i: number) => {
                    const tbl = `${c.kind === 'node' ? 'Node_' : 'Edge_'}${c.name}`;
                    const rows = matResult.counts && (tbl in matResult.counts) ? matResult.counts[tbl] : undefined;
                    return (
                      <li key={i} style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' }}>
                        {c.ok ? '[ok]' : '[err]'} {tbl}{rows !== undefined ? ` — ${rows} rows` : ''}{c.error ? ` — ${c.error}` : ''}
                      </li>
                    );
                  })}
                </ul>
              )}
              {Array.isArray(matResult.loaded) && matResult.loaded.some((l: any) => !l.ok) && (
                <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0 ${tokens.spacingHorizontalL}`, padding: 0 }}>
                  {matResult.loaded.filter((l: any) => !l.ok).map((l: any, i: number) => (
                    <li key={i} style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', color: tokens.colorPaletteRedForeground1 }}>
                      load {l.table} failed — {l.error}
                    </li>
                  ))}
                </ul>
              )}
              {matResult.graph && (
                <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS }}>
                  Verified with <code>make-graph</code>: {matResult.graph.relationships} relationship(s) traversable.
                </Caption1>
              )}
              {matResult.error && <span>{matResult.error}</span>}
            </MessageBarBody>
          </MessageBar>
        )}

        {/* ── Query (make-graph / graph-match) ── */}
        <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalM }}><Play20Regular className={s.secHeadIcon} /><Subtitle2>Query graph</Subtitle2></div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Write <strong>GQL / openCypher</strong> — translated to ADX <code>make-graph</code> + <code>graph-match</code> over the built tables and run live. Build the graph first so the tables have data.
        </Caption1>
        <MonacoTextarea value={gql} onChange={setGql} language="graphql" height={120} minHeight={90} ariaLabel="Graph query (GQL / openCypher)" />
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
          <Button appearance="primary" icon={<Play20Regular />} onClick={runQuery} disabled={qRunning || !gql.trim()}>{qRunning ? 'Running…' : 'Run query'}</Button>
          {qRunning && <Spinner size="extra-tiny" />}
        </div>
        {qResult && qResult.kql && (
          <Caption1 style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{qResult.kql}</Caption1>
        )}
        {qResult && !qResult.ok && (
          <MessageBar intent={qResult.gate ? 'warning' : 'error'}>
            <MessageBarBody><MessageBarTitle>{qResult.gate ? 'Query unavailable' : 'Query failed'}</MessageBarTitle>{qResult.gate ? qResult.gate.remediation : qResult.error}</MessageBarBody>
          </MessageBar>
        )}
        {qResult && qResult.ok && (
          <>
            <TabList selectedValue={qView} onTabSelect={(_, d) => setQView(d.value as 'table' | 'card' | 'diagram')} size="small">
              <Tab value="table" icon={<Table20Regular />}>Table</Tab>
              <Tab value="card" icon={<DataUsage20Regular />}>Card</Tab>
              <Tab value="diagram" icon={<ChartMultiple20Regular />}>Diagram</Tab>
            </TabList>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{qResult.rowCount} row(s){qResult.truncated ? ' (truncated)' : ''} in {qResult.executionMs} ms</Caption1>
            {(qResult.rows || []).length === 0 && <EmptyState title="No matches" body="The graph-match returned no rows. Build the graph (load data) or adjust the pattern." />}
            {qView === 'table' && (qResult.rows || []).length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHeader><TableRow>{(qResult.columns || []).map((c: string) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
                  <TableBody>
                    {(qResult.rows || []).map((row: any[], ri: number) => (
                      <TableRow key={ri}>{row.map((cell, ci) => <TableCell key={ci}>{typeof cell === 'object' && cell !== null ? JSON.stringify(cell) : String(cell ?? '')}</TableCell>)}</TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {qView === 'card' && (qResult.rows || []).length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacingHorizontalS }}>
                {(qResult.rows || []).slice(0, 60).map((row: any[], ri: number) => (
                  <Card key={ri} style={{ padding: tokens.spacingVerticalS }}>
                    {(qResult.columns || []).map((c: string, ci: number) => (
                      <div key={ci} style={{ display: 'flex', justifyContent: 'space-between', gap: tokens.spacingHorizontalS, minWidth: 0 }}>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{c}</Caption1>
                        <Caption1 style={{ overflowWrap: 'anywhere' }}>{typeof row[ci] === 'object' && row[ci] !== null ? JSON.stringify(row[ci]) : String(row[ci] ?? '')}</Caption1>
                      </div>
                    ))}
                  </Card>
                ))}
              </div>
            )}
            {qView === 'diagram' && (qResult.rows || []).length > 0 && (
              qDiagram ? <ForceDirectedGraph nodes={qDiagram.nodes} edges={qDiagram.edges} height={320} />
                : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Diagram needs a projection of at least two columns (source, target) — e.g. <code>RETURN a.id, b.id</code>.</Caption1>
            )}
          </>
        )}

        <SaveBar
          saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
          extraRight={<Button appearance="primary" onClick={materialize} disabled={materializing || saving}>{materializing ? 'Building…' : 'Build graph'}</Button>}
        />

        <Dialog open={nodeDlgOpen} onOpenChange={(_, d) => setNodeDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add entity (node type)</DialogTitle>
              <DialogContent>
                <Field label="Entity name" required>
                  <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="Customer" />
                </Field>
                <Field label="Properties (name:type, comma-separated)" hint="e.g. name:string, age:int, joined:datetime. An id:string column is always added at materialize.">
                  <Input value={propsText} onChange={(_, d) => setPropsText(d.value)} placeholder="name:string, region:string" />
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setNodeDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addEntity}>Add entity</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Dialog open={edgeDlgOpen} onOpenChange={(_, d) => setEdgeDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add relationship (edge type)</DialogTitle>
              <DialogContent>
                <Field label="Relationship name" required>
                  <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="PLACED" />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM }}>
                  <Field label="From entity">
                    <Dropdown value={edgeSrc} selectedOptions={edgeSrc ? [edgeSrc] : []} onOptionSelect={(_, d) => setEdgeSrc(d.optionValue || '')} placeholder="(optional)">
                      {arr<{ name: string }>(state.nodes).map((n) => <Option key={n.name} value={n.name}>{n.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="To entity">
                    <Dropdown value={edgeDst} selectedOptions={edgeDst ? [edgeDst] : []} onOptionSelect={(_, d) => setEdgeDst(d.optionValue || '')} placeholder="(optional)">
                      {arr<{ name: string }>(state.nodes).map((n) => <Option key={n.name} value={n.name}>{n.name}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                <Field label="Properties (name:type, comma-separated)" hint="src:string and dst:string columns are always added at materialize.">
                  <Input value={propsText} onChange={(_, d) => setPropsText(d.value)} placeholder="at:datetime, weight:real" />
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setEdgeDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addRelationship}>Add relationship</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    } />
  );
}

