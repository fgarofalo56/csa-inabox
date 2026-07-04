'use client';

/**
 * User Data Function editor (Fabric UDF — code, test/invoke, connections, libraries).
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
import { clientFetch } from '@/lib/client-fetch';

// ----- User Data Function (Fabric UDF — code, test/invoke, connections, libraries) -----
const UDF_SAMPLE = `import datetime\nimport fabric.functions as fn\nimport logging\n\nudf = fn.UserDataFunctions()\n\n@udf.function()\ndef compute_score(user_id: str, weight: float = 1.0) -> dict:\n    logging.info('Python UDF trigger function processed a request.')\n    return {"user": user_id, "score": weight * 42}`;
interface UdfLibrary { name: string; version?: string; kind: 'pypi' | 'wheel' }
/** A reference to a reusable, Key Vault-backed Loom Connection (GET /api/connections). */
interface UdfConnectionRef { id: string; name: string; type?: string }
interface UdfState {
  runtime: 'python';
  entrypoint: string;
  source: string;
  /** @deprecated freeform comma list — superseded by structured `connectionRefs`. */
  connections: string;
  /** Declared data-source bindings selected from the shared Connections catalog. */
  connectionRefs?: UdfConnectionRef[];
  libraries: UdfLibrary[];
  // Azure-native execution endpoint (BYO Azure Functions) — read by the invoke
  // route (app/api/items/user-data-function/[id]/invoke): azureFunctionUrl
  // overrides LOOM_UDF_FUNCTION_BASE; functionKeySecret names the KV secret
  // holding the function key sent as x-functions-key.
  azureFunctionUrl?: string;
  functionKeySecret?: string;
  // Set once the item is published to a Fabric workspace (opt-in only).
  fabricEndpoint?: string;
  fabricWorkspaceId?: string;
  fabricItemId?: string;
  [k: string]: unknown;
}
/** Public (no-secret) connection shape returned by GET /api/connections. */
interface ConnectionView { id: string; name: string; type: string }

export function UserDataFunctionEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<UdfState>('user-data-function', id, {
    runtime: 'python', entrypoint: 'compute_score', source: UDF_SAMPLE, connections: '', libraries: [],
  });

  // Functions parsed from the source — drives the explorer + Test panel.
  const functions = useMemo<UdfFunction[]>(() => parseUdfFunctions(state.source || ''), [state.source]);

  // Test / Run panel.
  const [testFn, setTestFn] = useState('');
  const [testParams, setTestParams] = useState<Record<string, string>>({});
  const [testBusy, setTestBusy] = useState(false);
  const [testOut, setTestOut] = useState<{ ok: boolean; status?: number; body?: string; note?: string } | null>(null);
  const [testGate, setTestGate] = useState<string | null>(null);
  const selectedFn = functions.find((f) => f.name === testFn) || functions[0];

  // Generate invocation code dialog. Azure Functions (Azure-native) is the
  // DEFAULT target; the Fabric/mssparkutils variant is offered only when this
  // item opts into a Fabric backend (per .claude/rules/no-fabric-dependency.md).
  const [genOpen, setGenOpen] = useState(false);
  const fabricOptIn = !!(state.fabricEndpoint || state.fabricWorkspaceId);
  const [genTarget, setGenTarget] = useState<'functions' | 'notebook' | 'openapi' | 'fabric'>('functions');
  // If the item is not Fabric-opted-in but the tab somehow lands on 'fabric',
  // fall back to the Azure-native default so no Fabric-only surface is shown.
  const effectiveGenTarget = (genTarget === 'fabric' && !fabricOptIn) ? 'functions' : genTarget;

  // Reusable, Key Vault-backed Loom Connections (shared Connections catalog).
  const connQuery = useQuery({
    queryKey: ['udf-connections'],
    queryFn: async (): Promise<ConnectionView[]> => {
      const r = await clientFetch('/api/connections', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      return (Array.isArray(j.connections) ? j.connections : []) as ConnectionView[];
    },
  });
  const availableConns = connQuery.data || [];
  const connectionRefs = arr<UdfConnectionRef>(state.connectionRefs);
  const selectedConnIds = connectionRefs.map((c) => c.id);

  // Library form.
  const [libName, setLibName] = useState('');
  const [libVer, setLibVer] = useState('');
  const [libKind, setLibKind] = useState<'pypi' | 'wheel'>('pypi');

  const addLibrary = () => {
    if (!libName.trim()) return;
    setState((p) => ({ ...p, libraries: [...arr<UdfLibrary>(p.libraries), { name: libName.trim(), version: libVer.trim() || undefined, kind: libKind }] }));
    setLibName(''); setLibVer('');
  };
  const removeLibrary = (name: string) => setState((p) => ({ ...p, libraries: arr<UdfLibrary>(p.libraries).filter((l) => l.name !== name) }));

  const runTest = useCallback(async () => {
    if (!selectedFn) return;
    setTestBusy(true); setTestOut(null); setTestGate(null);
    // Coerce typed params: numbers/bools parsed, everything else string.
    const parameters: Record<string, unknown> = {};
    for (const p of selectedFn.params) {
      const raw = testParams[p.name] ?? '';
      if (p.type && /int|float|number/i.test(p.type)) parameters[p.name] = raw === '' ? null : Number(raw);
      else if (p.type && /bool/i.test(p.type)) parameters[p.name] = raw === 'true';
      else parameters[p.name] = raw;
    }
    try {
      const r = await clientFetch(`/api/items/user-data-function/${encodeURIComponent(id)}/invoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ functionName: selectedFn.name, parameters }),
      });
      const j = await r.json();
      if (r.status === 409 && j.gated) { setTestGate(j.hint || j.error); return; }
      setTestOut({ ok: j.ok, status: j.status, body: j.body || j.error, note: j.note });
    } catch (e: any) { setTestOut({ ok: false, body: e?.message || String(e) }); }
    finally { setTestBusy(false); }
  }, [id, selectedFn, testParams]);

  const invocationCode = useMemo(() => {
    const fn = selectedFn;
    if (!fn) return '# Add a function to generate invocation code';
    const jsonArgs = fn.params.map((p) => `"${p.name}": ${p.type && /int|float|number/i.test(p.type) ? '0' : p.type && /bool/i.test(p.type) ? 'True' : '"value"'}`).join(', ');
    const fnBase = (state.azureFunctionUrl || '').trim() || 'https://<fnapp>.azurewebsites.net';
    const keySecret = (state.functionKeySecret || '').trim() || 'udf-fnapp-key';

    if (effectiveGenTarget === 'functions') {
      // Azure-native DEFAULT: POST {fnBase}/api/<fn> with x-functions-key (or Entra).
      return `# Azure Functions (HTTP) — Azure-native default\n`
        + `import requests\n`
        + `# Function key from your secret store (Key Vault secret: ${keySecret}).\n`
        + `resp = requests.post(\n`
        + `    "${fnBase}/api/${fn.name}",\n`
        + `    headers={"x-functions-key": "<FUNCTION_KEY>"},\n`
        + `    json={ ${jsonArgs} },\n`
        + `)\n`
        + `print(resp.status_code, resp.json())\n\n`
        + `# Entra-protected function App instead of a key:\n`
        + `#   from azure.identity import DefaultAzureCredential\n`
        + `#   token = DefaultAzureCredential().get_token("<APP_ID_URI>/.default").token\n`
        + `#   headers={"Authorization": f"Bearer {token}"}`;
    }
    if (effectiveGenTarget === 'notebook') {
      // Synapse / Databricks notebook — call the same Azure-native HTTP endpoint.
      return `# Synapse / Databricks notebook (PySpark) — call the Loom UDF over HTTP\n`
        + `import requests\n`
        + `# Databricks: key = dbutils.secrets.get(scope="loom", key="${keySecret}")\n`
        + `# Synapse:    key = mssparkutils.credentials.getSecret("<key-vault>", "${keySecret}")\n`
        + `resp = requests.post(\n`
        + `    "${fnBase}/api/${fn.name}",\n`
        + `    headers={"x-functions-key": key},\n`
        + `    json={ ${jsonArgs} },\n`
        + `)\n`
        + `display(resp.json())`;
    }
    if (effectiveGenTarget === 'fabric') {
      // OPT-IN ONLY — shown when the item binds a Fabric backend.
      return `# Fabric Notebook (notebookutils) — Fabric backend (opt-in)\n`
        + `import notebookutils\n`
        + `result = notebookutils.udf.run("${item.displayName || id}", "${fn.name}", { ${fn.params.map((p) => `"${p.name}": "value"`).join(', ')} })\n`
        + `display(result)`;
    }
    // OpenAPI fragment for the function (Azure Functions HTTP route).
    const props = fn.params.map((p) => `        "${p.name}": { "type": "${p.type && /int|float|number/i.test(p.type) ? 'number' : p.type && /bool/i.test(p.type) ? 'boolean' : 'string'}" }`).join(',\n');
    return `{\n  "openapi": "3.0.1",\n  "info": { "title": "${item.displayName || id}", "version": "1.0" },\n  "paths": {\n    "/api/${fn.name}": {\n      "post": {\n        "operationId": "${fn.name}",\n        "requestBody": { "content": { "application/json": { "schema": {\n          "type": "object",\n          "properties": {\n${props}\n          }\n        } } } },\n        "responses": { "200": { "description": "OK" } }\n      }\n    }\n  }\n}`;
  }, [selectedFn, effectiveGenTarget, id, item.displayName, state.azureFunctionUrl, state.functionKeySecret]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Function', actions: [
        { label: 'Reload', onClick: reload },
        { label: saving ? 'Publishing…' : 'Publish', onClick: () => save(), disabled: saving || dirty === false, title: 'Saves source + definition to Cosmos (publish)' },
      ]},
      { label: 'Tools', actions: [
        { label: 'Generate invocation code', onClick: () => setGenOpen(true), disabled: functions.length === 0 },
      ]},
    ]},
  ], [reload, save, saving, dirty, functions.length]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div style={{ padding: tokens.spacingVerticalS }}>
          <Caption1 style={{ padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, color: tokens.colorNeutralForeground3 }}>Functions ({functions.length})</Caption1>
          {functions.length === 0 && <Body1 style={{ padding: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>No <code>@udf.function()</code> definitions found.</Body1>}
          <Tree aria-label="Functions">
            {functions.map((f) => (
              <TreeItem key={f.name} itemType="leaf" onClick={() => setTestFn(f.name)} style={{ background: f.name === (testFn || functions[0]?.name) ? tokens.colorNeutralBackground2 : undefined }}>
                <TreeItemLayout>
                  <span style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 }}>{f.name}({f.params.map((p) => p.name).join(', ')})</span>
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM }}>
            <Field label="Runtime"><Input value="python (fabric-user-data-functions)" disabled /></Field>
            <Field label="Default entrypoint"><Input value={state.entrypoint} onChange={(_, d) => setState((p) => ({ ...p, entrypoint: d.value }))} /></Field>
          </div>

          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><Flash20Regular className={s.secHeadIcon} /><Subtitle2>function_app.py</Subtitle2></div>
          <MonacoTextarea value={state.source} onChange={(v) => setState((p) => ({ ...p, source: v }))} language="python" height={280} minHeight={200} ariaLabel="Function source" />

          {/* Test / Run panel */}
          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><Play20Regular className={s.secHeadIcon} /><Subtitle2>Test / Run</Subtitle2></div>
          <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            <Field label="Function">
              <Dropdown
                placeholder={functions.length ? 'Select a function' : 'No functions to run'}
                value={selectedFn?.name || ''}
                selectedOptions={selectedFn ? [selectedFn.name] : []}
                onOptionSelect={(_, d) => { setTestFn(d.optionValue || ''); setTestParams({}); }}
              >
                {functions.map((f) => <Option key={f.name} value={f.name}>{f.name}</Option>)}
              </Dropdown>
            </Field>
            {selectedFn?.params.map((p) => (
              <Field key={p.name} label={`${p.name}${p.type ? ` : ${p.type}` : ''}${p.default ? ` (default ${p.default})` : ''}`}>
                <Input value={testParams[p.name] ?? ''} onChange={(_, d) => setTestParams((cur) => ({ ...cur, [p.name]: d.value }))} placeholder={p.default || ''} />
              </Field>
            ))}
            <Button appearance="primary" onClick={runTest} disabled={testBusy || !selectedFn} style={{ alignSelf: 'flex-start' }}>{testBusy ? 'Running…' : 'Run'}</Button>
            {testGate && (
              <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Function not published yet</MessageBarTitle>{testGate}</MessageBarBody></MessageBar>
            )}
            {testOut && (
              <>
                <Caption1>Output {testOut.status != null ? `(HTTP ${testOut.status})` : ''}</Caption1>
                <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 200 }}>{testOut.body || '(empty)'}</div>
                {testOut.note && (
                  <MessageBar intent="info"><MessageBarBody>{testOut.note}</MessageBarBody></MessageBar>
                )}
              </>
            )}
          </div>

          {/* Execution endpoint — Azure-native BYO Azure Functions target */}
          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><Settings20Regular className={s.secHeadIcon} /><Subtitle2>Execution endpoint</Subtitle2></div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Azure-native run target. Leave blank to use the shared runtime (<code>LOOM_UDF_FUNCTION_BASE</code>), which executes this item&apos;s authored source. Set a Function App to run your own deployed code.
          </Caption1>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalXS }}>
            <Field label="Function App base URL" hint="e.g. https://my-udf.azurewebsites.net — overrides LOOM_UDF_FUNCTION_BASE for this item.">
              <Input value={state.azureFunctionUrl || ''} onChange={(_, d) => setState((p) => ({ ...p, azureFunctionUrl: d.value }))} placeholder="https://<fnapp>.azurewebsites.net" />
            </Field>
            <Field label="Function key — Key Vault secret name" hint="Optional. KV secret holding the function key (sent as x-functions-key). Blank = anonymous / Entra-protected.">
              <Input value={state.functionKeySecret || ''} onChange={(_, d) => setState((p) => ({ ...p, functionKeySecret: d.value }))} placeholder="udf-fnapp-key" />
            </Field>
          </div>

          {/* Manage connections — reusable, Key Vault-backed Loom Connections */}
          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><Link20Regular className={s.secHeadIcon} /><Subtitle2>Manage connections (data-source bindings)</Subtitle2></div>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Connections" style={{ minWidth: 320, flex: 1 }} hint={connQuery.isError ? undefined : 'Select reusable Loom Connections to declare as this function’s data sources.'} validationState={connQuery.isError ? 'error' : 'none'} validationMessage={connQuery.isError ? String((connQuery.error as any)?.message || 'Failed to load connections') : undefined}>
              <Dropdown
                multiselect
                placeholder={connQuery.isLoading ? 'Loading connections…' : availableConns.length ? 'Select connections' : 'No connections yet'}
                disabled={connQuery.isLoading || availableConns.length === 0}
                selectedOptions={selectedConnIds}
                value={connectionRefs.map((c) => c.name).join(', ')}
                onOptionSelect={(_, d) => {
                  const ids = d.selectedOptions;
                  const refs: UdfConnectionRef[] = availableConns
                    .filter((c) => ids.includes(c.id))
                    .map((c) => ({ id: c.id, name: c.name, type: c.type }));
                  setState((p) => ({ ...p, connectionRefs: refs }));
                }}
              >
                {availableConns.map((c) => <Option key={c.id} value={c.id} text={c.name}>{c.name} · {c.type}</Option>)}
              </Dropdown>
            </Field>
            <Button icon={<Add16Regular />} onClick={() => window.open('/connections', '_blank', 'noopener')}>New connection</Button>
          </div>
          <MessageBar intent="info" style={{ marginTop: tokens.spacingVerticalXS }}>
            <MessageBarBody>
              <MessageBarTitle>How bindings resolve</MessageBarTitle>
              Selected connections are saved as this function&apos;s declared data-source bindings. The shared Loom runtime executes your function&apos;s compute logic; when a function actually calls a data-source binding it returns an honest HTTP 409 until that connection is wired into the runtime. On a BYO Azure Functions endpoint (above), bindings resolve through your Function App&apos;s own configuration.
            </MessageBarBody>
          </MessageBar>

          {/* Library management */}
          <div className={s.secHead} style={{ marginTop: tokens.spacingVerticalS }}><DataUsage20Regular className={s.secHeadIcon} /><Subtitle2>Library management</Subtitle2></div>
          <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalXS }}>
            <MessageBarBody>
              <MessageBarTitle>Standard library only on the shared runtime</MessageBarTitle>
              The shared Loom UDF runtime runs the Python standard library only — packages added here are not pip-installed by it, so standard-library imports run today while third-party imports would fail there. Packages are recorded as this function&apos;s requirements and take effect when you deploy to your own Azure Function App (the Execution endpoint above), which installs them from <code>requirements.txt</code>.
            </MessageBarBody>
          </MessageBar>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Package"><Input value={libName} onChange={(_, d) => setLibName(d.value)} placeholder="numpy" /></Field>
            <Field label="Version"><Input value={libVer} onChange={(_, d) => setLibVer(d.value)} placeholder="2.0.0" style={{ width: 120 }} /></Field>
            <Field label="Type">
              <Dropdown value={libKind} selectedOptions={[libKind]} onOptionSelect={(_, d) => d.optionValue && setLibKind(d.optionValue as 'pypi' | 'wheel')}>
                <Option value="pypi">PyPI</Option>
                <Option value="wheel">Private wheel</Option>
              </Dropdown>
            </Field>
            <Button onClick={addLibrary} disabled={!libName.trim()}>Add library</Button>
          </div>
          <Table size="small" aria-label="Libraries">
            <TableHeader><TableRow><TableHeaderCell>Package</TableHeaderCell><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
            <TableBody>
              {arr<{ name: string; version?: string; kind: string }>(state.libraries).length === 0 && <TableRow><TableCell>No libraries added.</TableCell><TableCell /><TableCell /><TableCell /></TableRow>}
              {arr<{ name: string; version?: string; kind: string }>(state.libraries).map((l) => (
                <TableRow key={l.name}>
                  <TableCell><strong>{l.name}</strong></TableCell>
                  <TableCell>{l.version || 'latest'}</TableCell>
                  <TableCell>{l.kind}</TableCell>
                  <TableCell><Button size="small" onClick={() => removeLibrary(l.name)}>Remove</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />

          {/* Generate invocation code dialog */}
          <Dialog open={genOpen} onOpenChange={(_, d) => { if (!d.open) setGenOpen(false); }}>
            <DialogSurface style={{ maxWidth: '90vw', width: 760 }}>
              <DialogBody>
                <DialogTitle>Generate invocation code — {selectedFn?.name}</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                    <TabList selectedValue={effectiveGenTarget} onTabSelect={(_, d) => setGenTarget(d.value as typeof genTarget)}>
                      <Tab value="functions">Azure Functions</Tab>
                      <Tab value="notebook">Notebook</Tab>
                      <Tab value="openapi">OpenAPI</Tab>
                      {fabricOptIn && <Tab value="fabric">Fabric</Tab>}
                    </TabList>
                    <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 320 }}>{invocationCode}</div>
                    <Button onClick={() => navigator.clipboard?.writeText(invocationCode).catch(() => {})}>Copy</Button>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setGenOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

